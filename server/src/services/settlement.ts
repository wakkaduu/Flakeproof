import type { Ctx } from '../context.js';
import { planPayout } from '../domain/money.js';
import {
  assertDepositTransition, assertEventTransition, settlementAction,
} from '../domain/stateMachine.js';
import { AppError, conflict } from '../errors.js';
import { PayPalError } from '../paypal/errors.js';
import type { CaptureResult } from '../paypal/types.js';
import { attendanceOf, BAD_PAYOUT_STATUSES, decisionOf, depositStatusOf, releasedEarly, type EventFull, type GuestFull } from './shared.js';
import { loadHostEvent, settlementBlockers } from './events.js';

/**
 * The host's explicit approval AND the engine. Idempotent: call it again to resume or to
 * refresh payout status. Order of operations is deliberate:
 *   1. void (people who showed, and no-shows the host forgave): the promise "you pay nothing"
 *   2. capture (no-shows the host chose to charge)
 *   3. payout of the captured pot to the people who came
 * Every PayPal mutation uses a request id derived from our own record id, so a crash at any
 * point is recovered by simply calling settle again.
 */
export async function settle(ctx: Ctx, hostToken: string): Promise<EventFull> {
  const ev0 = await loadHostEvent(ctx, hostToken);
  return ctx.mutex.run(`event:${ev0.id}`, async () => {
    let ev = await loadHostEvent(ctx, hostToken);
    if (ev.status === 'settled') return ev;

    if (!ev.settlementStartedAt) {
      const blockers = settlementBlockers(ev, ctx.config);
      if (ev.status !== 'ended' || blockers.length) {
        throw conflict('not_ready', blockers.join(' ') || 'End the event first.');
      }
      // This is the approval: from here on, check-ins and decisions are locked.
      await ctx.db.event.update({ where: { id: ev.id }, data: { settlementStartedAt: ctx.now() } });
      ev = await loadHostEvent(ctx, hostToken);
    }

    // 1. voids
    for (const g of ev.guests) {
      const dep = g.deposit;
      if (!dep || depositStatusOf(dep) !== 'authorized') continue;
      if (settlementAction(attendanceOf(g), decisionOf(g)) === 'void') await voidDeposit(ctx, g);
    }
    // 2. captures (and resolving any that were left pending)
    for (const g of ev.guests) {
      const dep = g.deposit;
      if (!dep) continue;
      const status = depositStatusOf(dep);
      if (status === 'authorized' && settlementAction(attendanceOf(g), decisionOf(g)) === 'capture') {
        await captureDeposit(ctx, g);
      } else if (status === 'capture_pending') {
        await resolvePendingCapture(ctx, g);
      } else if (status === 'authorized' && settlementAction(attendanceOf(g), decisionOf(g)) === 'undecided') {
        throw conflict('undecided', `${g.name} has no decision; settlement cannot continue.`);
      }
    }

    ev = await loadHostEvent(ctx, hostToken);
    const stillOpen = ev.guests.some((g) => g.deposit && ['authorized', 'capture_pending'].includes(g.deposit.status));
    if (stillOpen) return ev; // something is pending at PayPal; run settle again later

    // 3. payout
    await ensurePayout(ctx, ev);
    ev = await loadHostEvent(ctx, hostToken);
    await syncPayout(ctx, ev);
    ev = await loadHostEvent(ctx, hostToken);

    const p = ev.payout;
    const done = p && (p.batchStatus === 'SKIPPED' || (p.items.length > 0 && p.items.every((i) => i.status === 'SUCCESS')));
    if (done) {
      assertEventTransition('ended', 'settled');
      await ctx.db.event.update({ where: { id: ev.id }, data: { status: 'settled', settledAt: ctx.now() } });
      ev = await loadHostEvent(ctx, hostToken);
    }
    return ev;
  });
}

async function voidDeposit(ctx: Ctx, g: GuestFull) {
  const dep = g.deposit!;
  await ctx.paypal.voidAuthorization({ requestId: `flakeproof-void-${dep.id}`, authorizationId: dep.authorizationId! });
  assertDepositTransition('authorized', 'voided');
  await ctx.db.deposit.update({ where: { id: dep.id }, data: { status: 'voided' } });
}

async function captureDeposit(ctx: Ctx, g: GuestFull) {
  const dep = g.deposit!;
  // The amount is our own record, never anything from a request.
  const cap = await ctx.paypal.captureAuthorization({
    requestId: `flakeproof-capture-${dep.id}`,
    authorizationId: dep.authorizationId!,
    amountCents: dep.amountCents,
    currency: dep.currency,
    invoiceId: dep.id,
  });
  await recordCapture(ctx, g, cap);
}

async function resolvePendingCapture(ctx: Ctx, g: GuestFull) {
  const dep = g.deposit!;
  if (!dep.captureId) throw new AppError(500, 'inconsistent', 'Pending capture has no capture id.');
  await recordCapture(ctx, g, await ctx.paypal.getCapture(dep.captureId));
}

async function recordCapture(ctx: Ctx, g: GuestFull, cap: CaptureResult) {
  const dep = g.deposit!;
  if (cap.amountCents !== dep.amountCents || cap.currency !== dep.currency) {
    console.error(`[capture] MISMATCH deposit=${dep.id} captured=${cap.amountCents} ${cap.currency} expected=${dep.amountCents} ${dep.currency}`);
    throw new PayPalError('unexpected_response', 'Captured amount/currency differ from the deposit');
  }
  const from = depositStatusOf(dep);
  if (cap.status === 'PENDING') {
    if (from === 'authorized') assertDepositTransition('authorized', 'capture_pending');
    await ctx.db.deposit.update({ where: { id: dep.id }, data: { status: 'capture_pending', captureId: cap.captureId } });
    return;
  }
  if (cap.status !== 'COMPLETED') {
    console.error(`[capture] unexpected capture status ${cap.status} deposit=${dep.id}`);
    throw new PayPalError('unexpected_response', `Capture status ${cap.status}`);
  }
  // The net is only trustworthy if PayPal reports it in the deposit's own currency.
  // (A merchant account in another currency reports a converted net; we refuse to pay out on that.)
  const netOk = cap.netCents !== null && cap.netCurrency === dep.currency;
  assertDepositTransition(from, 'captured');
  await ctx.db.deposit.update({
    where: { id: dep.id },
    data: { status: 'captured', captureId: cap.captureId, feeCents: cap.feeCents, netCents: netOk ? cap.netCents : null },
  });
}

/** Persists the payout plan (amounts fixed) BEFORE sending anything, then sends it once. */
async function ensurePayout(ctx: Ctx, ev: EventFull) {
  const { config } = ctx;
  if (!ev.payout) {
    const captured = ev.guests.filter((g) => g.deposit && depositStatusOf(g.deposit) === 'captured');
    if (ev.potMode === 'keep') {
      // The host chose to keep what a no-show paid (it covers the booking). It simply stays in their PayPal
      // account; nothing is sent, so there is no payout fee and nobody needs a PayPal email.
      await ctx.db.payout.create({
        data: {
          eventId: ev.id, senderBatchId: `flakeproof-${ev.id}`,
          potCents: captured.reduce((s, g) => s + (g.deposit!.netCents ?? 0), 0), feeReserveCents: 0, distributableCents: 0,
          batchStatus: 'SKIPPED', skippedReason: captured.length ? 'kept_by_host' : 'no_capture',
        },
      });
      return;
    }
    if (captured.some((g) => g.deposit!.netCents === null)) {
      throw conflict('net_unknown', 'PayPal did not report a usable net amount for a capture, so the payout is on hold for a human to check.');
    }
    const recipients = ev.guests.filter(
      (g) => attendanceOf(g) === 'showed' && !releasedEarly(g) && g.deposit && depositStatusOf(g.deposit) === 'voided' && g.deposit.payerEmail,
    );
    const plan = planPayout({
      capturedNetCents: captured.map((g) => g.deposit!.netCents!),
      recipientIds: recipients.map((g) => g.id),
      feePerItemCents: config.payoutFeePerItemCents,
      minPerPersonCents: config.minPayoutPerPersonCents,
    });
    const email = new Map(recipients.map((g) => [g.id, g.deposit!.payerEmail!]));
    await ctx.db.payout.create({
      data: {
        eventId: ev.id,
        senderBatchId: `flakeproof-${ev.id}`,
        potCents: plan.potCents,
        feeReserveCents: plan.feeReserveCents,
        distributableCents: plan.distributableCents,
        batchStatus: plan.viable ? 'NOT_SENT' : 'SKIPPED',
        skippedReason: plan.viable ? null : plan.reason,
        items: plan.viable
          ? { create: plan.items.map((i) => ({ guestId: i.recipientId, receiverEmail: email.get(i.recipientId)!, amountCents: i.amountCents })) }
          : undefined,
      },
    });
  }
  const payout = await ctx.db.payout.findUniqueOrThrow({ where: { eventId: ev.id }, include: { items: true } });
  if (payout.batchStatus !== 'NOT_SENT') return;

  const sent = await ctx.paypal.createPayout({
    requestId: `flakeproof-payout-${ev.id}`,
    senderBatchId: payout.senderBatchId,
    currency: ev.currency,
    emailSubject: `Your share from "${ev.title}"`.slice(0, 120),
    items: payout.items.map((it) => ({
      senderItemId: it.id,
      receiverEmail: it.receiverEmail,
      amountCents: it.amountCents,
      note: `Flakeproof: your share of the no-show pot for ${ev.title}`.slice(0, 200),
    })),
  });
  await ctx.db.$transaction([
    ctx.db.payout.update({ where: { id: payout.id }, data: { paypalBatchId: sent.batchId, batchStatus: sent.batchStatus } }),
    ctx.db.payoutItem.updateMany({ where: { payoutId: payout.id }, data: { status: 'PENDING' } }),
  ]);
}

/** Copies PayPal's item statuses into our records. Only item SUCCESS counts as paid. */
async function syncPayout(ctx: Ctx, ev: EventFull) {
  const payout = await ctx.db.payout.findUnique({ where: { eventId: ev.id }, include: { items: true } });
  if (!payout?.paypalBatchId) return;
  const info = await ctx.paypal.getPayout(payout.paypalBatchId);
  const bySenderId = new Map(info.items.map((i) => [i.senderItemId, i]));
  for (const it of payout.items) {
    const remote = bySenderId.get(it.id);
    if (!remote) continue;
    if (BAD_PAYOUT_STATUSES.has(remote.status)) console.error(`[payout] item ${it.id} is ${remote.status} ${remote.errorName ?? ''}`);
    await ctx.db.payoutItem.update({
      where: { id: it.id },
      data: { status: remote.status, paypalItemId: remote.payoutItemId, feeCents: remote.feeCents, errorName: remote.errorName },
    });
  }
  await ctx.db.payout.update({ where: { id: payout.id }, data: { batchStatus: info.batchStatus } });
}
