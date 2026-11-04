import type { Ctx } from '../context.js';
import { holdWindow } from '../domain/schedule.js';
import { assertDepositTransition, deriveGuestStage, releaseDeadline } from '../domain/stateMachine.js';
import { AppError, conflict, notFound } from '../errors.js';
import { attendanceOf, depositStatusOf, releasedEarly } from './shared.js';

async function loadGuest(ctx: Ctx, inviteToken: string) {
  const g = await ctx.db.guest.findUnique({
    where: { inviteToken },
    include: { event: true, deposit: true, payoutItem: true },
  });
  if (!g) throw notFound('This invite link is not valid.');
  return g;
}
type GuestWithEvent = Awaited<ReturnType<typeof loadGuest>>;

export function guestView(g: GuestWithEvent, ctx: Ctx) {
  const dep = g.deposit;
  const depStatus = dep ? depositStatusOf(dep) : null;
  let outcome: { kind: 'none' | 'held' | 'nothing_charged' | 'charged' | 'received'; amountCents?: number } = { kind: 'none' };
  if (g.payoutItem?.status === 'SUCCESS') outcome = { kind: 'received', amountCents: g.payoutItem.amountCents };
  else if (depStatus === 'captured' || depStatus === 'capture_pending') outcome = { kind: 'charged', amountCents: dep!.amountCents };
  else if (depStatus === 'voided') outcome = { kind: 'nothing_charged' };
  else if (depStatus === 'authorized') outcome = { kind: 'held', amountCents: dep!.amountCents };
  return {
    guestName: g.name,
    event: {
      title: g.event.title, startsAt: g.event.startsAt.toISOString(),
      depositCents: g.event.depositCents, currency: g.event.currency, status: g.event.status,
      potMode: g.event.potMode as 'share' | 'keep',
    },
    /** When holds open and close. Before `opensAt` the friend can already be in the group, but PayPal cannot be asked yet. */
    holds: (() => { const w = holdWindow(g.event.startsAt, ctx.config.honorPeriodDays, ctx.now()); return { state: w.state, opensAt: w.opensAt.toISOString() }; })(),
    stage: deriveGuestStage({ attendance: attendanceOf(g), depositStatus: depStatus, payoutItemStatus: g.payoutItem?.status ?? null, releasedEarly: releasedEarly(g) }),
    depositStatus: depStatus,
    outcome,
    // The guest's own share of the pot, if they are a recipient. Their own data only.
    share: g.payoutItem ? { amountCents: g.payoutItem.amountCents, status: g.payoutItem.status } : null,
    canApprove: g.event.status === 'open' && !g.cancelKind && holdWindow(g.event.startsAt, ctx.config.honorPeriodDays, ctx.now()).state === 'open' && (depStatus === null || depStatus === 'pending'),
    cancel: cancelView(g, ctx),
  };
}

/**
 * "Can't make it". Before the cutoff the friend can release their own hold (nothing is charged and the
 * host is told in time to rebook). After it they can only warn the host, who still decides.
 */
function cancelView(g: GuestWithEvent, ctx: Ctx) {
  const releaseUntil = releaseDeadline(g.event.startsAt, g.event.graceHours);
  const open = g.event.status === 'open' && attendanceOf(g) === 'unknown' && !g.cancelKind;
  return {
    /** Last moment a friend can release their hold themselves. */
    releaseUntil: releaseUntil.toISOString(),
    state: g.cancelKind === 'released' ? 'released' as const : g.cancelKind === 'late_notice' ? 'late_notice' as const : null,
    cancelledAt: g.cancelledAt?.toISOString() ?? null,
    /** Can still tell us they cannot come, and whether that frees the hold. */
    can: open ? (ctx.now() <= releaseUntil ? 'release' as const : 'warn' as const) : null,
  };
}

/**
 * The friend says they cannot come. In time: the hold is released right now (a PayPal void) and the
 * friend is out of the event. Too late: we only record it, the hold stays, and the host decides as usual.
 * Either way the host sees it, with the time, as a plain fact.
 */
export async function cancelGuest(ctx: Ctx, inviteToken: string) {
  const g0 = await loadGuest(ctx, inviteToken);
  return ctx.mutex.run(`event:${g0.eventId}`, () => ctx.mutex.run(`guest:${g0.id}`, async () => {
    const g = await loadGuest(ctx, inviteToken);
    if (g.cancelKind) return guestView(g, ctx); // idempotent
    if (g.event.status !== 'open') throw conflict('event_closed', 'This event has ended.');
    if (attendanceOf(g) !== 'unknown') throw conflict('already_marked', 'The host has already marked your attendance.');

    const now = ctx.now();
    const inTime = now <= releaseDeadline(g.event.startsAt, g.event.graceHours);
    const dep = g.deposit;
    if (!inTime) {
      await ctx.db.guest.update({ where: { id: g.id }, data: { cancelledAt: now, cancelKind: 'late_notice' } });
      return guestView(await loadGuest(ctx, inviteToken), ctx);
    }
    if (dep && depositStatusOf(dep) === 'authorized') {
      // The request id is derived from our record, so a crash after this call is healed by a retry.
      await ctx.paypal.voidAuthorization({ requestId: `flakeproof-void-${dep.id}`, authorizationId: dep.authorizationId! });
      assertDepositTransition('authorized', 'voided');
      await ctx.db.$transaction([
        ctx.db.deposit.update({ where: { id: dep.id }, data: { status: 'voided' } }),
        ctx.db.guest.update({ where: { id: g.id }, data: { cancelledAt: now, cancelKind: 'released' } }),
      ]);
    } else {
      // No hold yet (invited, or opened PayPal but never approved): nothing to void. The unapproved
      // order is never authorized because start and finalize refuse a released guest.
      await ctx.db.guest.update({ where: { id: g.id }, data: { cancelledAt: now, cancelKind: 'released' } });
    }
    return guestView(await loadGuest(ctx, inviteToken), ctx);
  }));
}

export async function getGuestView(ctx: Ctx, inviteToken: string) {
  return guestView(await loadGuest(ctx, inviteToken), ctx);
}

/** Creates (or returns the existing) PayPal order for this guest and gives back the approval link. */
export async function startDeposit(ctx: Ctx, inviteToken: string): Promise<{ approveUrl: string }> {
  const g0 = await loadGuest(ctx, inviteToken);
  return ctx.mutex.run(`guest:${g0.id}`, async () => {
    const g = await loadGuest(ctx, inviteToken);
    if (g.event.status !== 'open') throw conflict('event_closed', 'This event has ended, so deposits are closed.');
    if (releasedEarly(g)) throw conflict('released', "You told us you can't make it, so there is no hold to place.");
    const w = holdWindow(g.event.startsAt, ctx.config.honorPeriodDays, ctx.now());
    if (w.state === 'closed') throw conflict('started', 'The event has started, so holds are closed.');
    if (w.state === 'not_yet' && !g.deposit) {
      throw conflict('holds_not_open', `Holds open ${ctx.config.honorPeriodDays} days before the start, because PayPal only guarantees a hold for that long. Come back to this link then.`);
    }
    if (g.deposit) {
      if (depositStatusOf(g.deposit) !== 'pending') throw conflict('already_authorized', 'Your deposit is already in place.');
      return { approveUrl: g.deposit.approveUrl };
    }
    // The server decides the amount. Nothing about it comes from the browser.
    const order = await ctx.paypal.createAuthorizeOrder({
      requestId: `flakeproof-order-${g.id}`, // one order per guest, safely retryable
      referenceId: g.id,
      description: `Deposit for ${g.event.title}`.slice(0, 120),
      amountCents: g.event.depositCents,
      currency: g.event.currency,
      returnUrl: `${ctx.config.appBaseUrl}/g/${g.inviteToken}?paypal=return`,
      cancelUrl: `${ctx.config.appBaseUrl}/g/${g.inviteToken}?paypal=cancel`,
    });
    await ctx.db.deposit.create({
      data: {
        guestId: g.id, amountCents: g.event.depositCents, currency: g.event.currency,
        orderId: order.orderId, approveUrl: order.approveUrl,
      },
    });
    return { approveUrl: order.approveUrl };
  });
}

/** Called after the browser returns from PayPal. We trust PayPal's records, not the browser. */
export async function finalizeDeposit(ctx: Ctx, inviteToken: string) {
  const g0 = await loadGuest(ctx, inviteToken);
  return ctx.mutex.run(`guest:${g0.id}`, async () => {
    const g = await loadGuest(ctx, inviteToken);
    const dep = g.deposit;
    if (!dep) throw conflict('no_deposit_started', 'Start your deposit first.');
    if (depositStatusOf(dep) !== 'pending') return guestView(g, ctx); // idempotent
    if (g.event.status !== 'open') throw conflict('event_closed', 'This event has ended, so deposits are closed.');
    if (releasedEarly(g)) throw conflict('released', "You told us you can't make it, so there is no hold to place.");

    const order = await ctx.paypal.getOrder(dep.orderId);
    // COMPLETED means a previous attempt authorized it but we crashed before saving; the
    // authorize call below replays safely by request id.
    if (order.status !== 'APPROVED' && order.status !== 'COMPLETED') {
      throw conflict('not_approved', "You haven't approved the payment on PayPal yet.");
    }
    const auth = await ctx.paypal.authorizeOrder({ requestId: `flakeproof-authorize-${dep.id}`, orderId: dep.orderId });

    const exact = auth.status === 'CREATED' && auth.amountCents === dep.amountCents && auth.currency === dep.currency;
    if (!exact) {
      // Never trust a hold that is not exactly what we asked for. Release it and stop.
      await ctx.paypal.voidAuthorization({ requestId: `flakeproof-void-mismatch-${dep.id}`, authorizationId: auth.authorizationId }).catch((e) => {
        console.error('[deposit] could not void a mismatched authorization', auth.authorizationId, e instanceof Error ? e.message : e);
      });
      console.error(`[deposit] authorization mismatch deposit=${dep.id} status=${auth.status} amount=${auth.amountCents} ${auth.currency}`);
      throw new AppError(502, 'verification_failed', 'PayPal returned a hold that did not match the deposit, so we released it. Please try again.');
    }

    assertDepositTransition('pending', 'authorized');
    await ctx.db.deposit.update({
      where: { id: dep.id },
      data: {
        status: 'authorized',
        authorizationId: auth.authorizationId,
        authorizedAt: ctx.now(),
        payerEmail: order.payerEmail ?? auth.payerEmail,
      },
    });
    return guestView(await loadGuest(ctx, inviteToken), ctx);
  });
}
