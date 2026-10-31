import type { Ctx } from '../context.js';
import { assertDepositTransition, deriveGuestStage } from '../domain/stateMachine.js';
import { AppError, conflict, notFound } from '../errors.js';
import { attendanceOf, depositStatusOf } from './shared.js';

async function loadGuest(ctx: Ctx, inviteToken: string) {
  const g = await ctx.db.guest.findUnique({
    where: { inviteToken },
    include: { event: true, deposit: true, payoutItem: true },
  });
  if (!g) throw notFound('This invite link is not valid.');
  return g;
}
type GuestWithEvent = Awaited<ReturnType<typeof loadGuest>>;

export function guestView(g: GuestWithEvent) {
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
    },
    stage: deriveGuestStage({ attendance: attendanceOf(g), depositStatus: depStatus, payoutItemStatus: g.payoutItem?.status ?? null }),
    depositStatus: depStatus,
    outcome,
    // The guest's own share of the pot, if they are a recipient. Their own data only.
    share: g.payoutItem ? { amountCents: g.payoutItem.amountCents, status: g.payoutItem.status } : null,
    canApprove: g.event.status === 'open' && (depStatus === null || depStatus === 'pending'),
  };
}

export async function getGuestView(ctx: Ctx, inviteToken: string) {
  return guestView(await loadGuest(ctx, inviteToken));
}

/** Creates (or returns the existing) PayPal order for this guest and gives back the approval link. */
export async function startDeposit(ctx: Ctx, inviteToken: string): Promise<{ approveUrl: string }> {
  const g0 = await loadGuest(ctx, inviteToken);
  return ctx.mutex.run(`guest:${g0.id}`, async () => {
    const g = await loadGuest(ctx, inviteToken);
    if (g.event.status !== 'open') throw conflict('event_closed', 'This event has ended, so deposits are closed.');
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
    if (depositStatusOf(dep) !== 'pending') return guestView(g); // idempotent
    if (g.event.status !== 'open') throw conflict('event_closed', 'This event has ended, so deposits are closed.');

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
    return guestView(await loadGuest(ctx, inviteToken));
  });
}
