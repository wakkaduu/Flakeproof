import { z } from 'zod';
import type { Ctx } from '../context.js';
import {
  deriveGuestStage, assertEventTransition, type EventStatus,
} from '../domain/stateMachine.js';
import { AppError, conflict, notFound } from '../errors.js';
import { hashToken, maskEmail, newToken } from '../util.js';
import {
  attendanceOf, BAD_PAYOUT_STATUSES, decisionOf, depositStatusOf, eventInclude,
  type EventFull,
} from './shared.js';

export const CreateEventInput = z.object({
  title: z.string().trim().min(1).max(120),
  startsAt: z.iso.datetime({ offset: true }),
  depositCents: z.number().int(),
  guests: z.array(z.object({ name: z.string().trim().min(1).max(60) })).min(1),
});
export type CreateEventInput = z.infer<typeof CreateEventInput>;

export async function createEvent(ctx: Ctx, input: CreateEventInput) {
  const { config } = ctx;
  const startsAt = new Date(input.startsAt);
  const now = ctx.now();
  const horizon = new Date(now.getTime() + config.maxEventLeadHours * 3_600_000);
  if (startsAt <= now) throw new AppError(400, 'event_in_past', 'The event must be in the future.');
  if (startsAt > horizon) {
    throw new AppError(400, 'event_too_far', `Deposits are holds that PayPal honors for ${config.honorPeriodDays} days, so events must start within ${config.maxEventLeadHours} hours.`);
  }
  if (input.depositCents < config.minDepositCents || input.depositCents > config.maxDepositCents) {
    throw new AppError(400, 'deposit_out_of_range', `Deposit must be between ${config.minDepositCents} and ${config.maxDepositCents} cents.`);
  }
  if (input.guests.length > config.maxGuests) throw new AppError(400, 'too_many_guests', `At most ${config.maxGuests} guests.`);
  const names = input.guests.map((g) => g.name.toLowerCase());
  if (new Set(names).size !== names.length) throw new AppError(400, 'duplicate_guest', 'Guest names must be different so people can tell each other apart.');

  const hostToken = newToken();
  const event = await ctx.db.event.create({
    data: {
      title: input.title,
      startsAt,
      depositCents: input.depositCents,
      currency: config.currency,
      hostTokenHash: hashToken(hostToken),
      guests: { create: input.guests.map((g) => ({ name: g.name, inviteToken: newToken() })) },
    },
    include: eventInclude,
  });
  return { hostToken, event };
}

export async function loadHostEvent(ctx: Ctx, hostToken: string): Promise<EventFull> {
  const ev = await ctx.db.event.findUnique({ where: { hostTokenHash: hashToken(hostToken) }, include: eventInclude });
  if (!ev) throw notFound('Event not found');
  return ev;
}

function assertEditable(ev: EventFull) {
  if (ev.settlementStartedAt) throw conflict('locked', 'The host already approved settlement; check-ins and decisions are locked.');
}

export async function endEvent(ctx: Ctx, hostToken: string): Promise<EventFull> {
  const ev = await loadHostEvent(ctx, hostToken);
  return ctx.mutex.run(`event:${ev.id}`, async () => {
    const fresh = await loadHostEvent(ctx, hostToken);
    if (fresh.status !== 'open') return fresh; // idempotent
    assertEventTransition('open', 'ended');
    await ctx.db.event.update({ where: { id: fresh.id }, data: { status: 'ended', endedAt: ctx.now() } });
    return loadHostEvent(ctx, hostToken);
  });
}

export async function markAttendance(ctx: Ctx, hostToken: string, guestId: string, attendance: 'showed' | 'no_show'): Promise<EventFull> {
  const ev = await loadHostEvent(ctx, hostToken);
  return ctx.mutex.run(`event:${ev.id}`, async () => {
    const fresh = await loadHostEvent(ctx, hostToken);
    assertEditable(fresh);
    const guest = fresh.guests.find((g) => g.id === guestId);
    if (!guest) throw notFound('Guest not found');
    await ctx.db.guest.update({
      where: { id: guest.id },
      // A decision only makes sense for no-shows.
      data: { attendance, ...(attendance === 'showed' ? { decision: null } : {}) },
    });
    return loadHostEvent(ctx, hostToken);
  });
}

export async function setDecision(ctx: Ctx, hostToken: string, guestId: string, decision: 'capture' | 'forgive'): Promise<EventFull> {
  const ev = await loadHostEvent(ctx, hostToken);
  return ctx.mutex.run(`event:${ev.id}`, async () => {
    const fresh = await loadHostEvent(ctx, hostToken);
    assertEditable(fresh);
    if (fresh.status !== 'ended') throw conflict('not_ended', 'End the event before deciding on no-shows.');
    const guest = fresh.guests.find((g) => g.id === guestId);
    if (!guest) throw notFound('Guest not found');
    if (attendanceOf(guest) !== 'no_show') throw conflict('not_no_show', 'Only no-shows need a decision.');
    if (!guest.deposit || depositStatusOf(guest.deposit) !== 'authorized') {
      throw conflict('no_deposit', 'This guest has no held deposit, so there is nothing to capture or forgive.');
    }
    await ctx.db.guest.update({ where: { id: guest.id }, data: { decision } });
    return loadHostEvent(ctx, hostToken);
  });
}

// ---- views ------------------------------------------------------------------

/** What still stops the host from approving settlement. Empty means ready. */
export function settlementBlockers(ev: EventFull): string[] {
  const out: string[] = [];
  if (ev.status === 'open') out.push('End the event first.');
  const held = ev.guests.filter((g) => g.deposit && depositStatusOf(g.deposit) === 'authorized');
  const unmarked = held.filter((g) => attendanceOf(g) === 'unknown');
  if (unmarked.length) out.push(`Mark attendance for: ${unmarked.map((g) => g.name).join(', ')}.`);
  const undecided = held.filter((g) => attendanceOf(g) === 'no_show' && !g.decision);
  if (undecided.length) out.push(`Decide capture or forgive for: ${undecided.map((g) => g.name).join(', ')}.`);
  return out;
}

export function hostView(ctx: Ctx, ev: EventFull) {
  const now = ctx.now().getTime();
  const honorMs = ctx.config.honorPeriodDays * 86_400_000;
  const problems: string[] = [];
  const guests = ev.guests.map((g) => {
    const dep = g.deposit;
    const item = g.payoutItem;
    if (dep && depositStatusOf(dep) === 'authorized' && dep.authorizedAt && now - dep.authorizedAt.getTime() > honorMs) {
      problems.push(`${g.name}: PayPal's ${ctx.config.honorPeriodDays}-day honor period has passed; capture may be refused.`);
    }
    if (dep && depositStatusOf(dep) === 'capture_pending') problems.push(`${g.name}: capture is still pending at PayPal.`);
    if (dep && depositStatusOf(dep) === 'captured' && dep.netCents === null) problems.push(`${g.name}: could not verify the amount PayPal received, so the payout is on hold.`);
    if (item && BAD_PAYOUT_STATUSES.has(item.status)) problems.push(`${g.name}: payout is ${item.status}${item.errorName ? ` (${item.errorName})` : ''}.`);
    return {
      id: g.id,
      name: g.name,
      inviteUrl: `${ctx.config.appBaseUrl}/g/${g.inviteToken}`,
      attendance: attendanceOf(g),
      decision: decisionOf(g),
      stage: deriveGuestStage({ attendance: attendanceOf(g), depositStatus: dep ? depositStatusOf(dep) : null, payoutItemStatus: item?.status ?? null }),
      deposit: dep && {
        status: depositStatusOf(dep), amountCents: dep.amountCents, feeCents: dep.feeCents, netCents: dep.netCents,
        payerEmail: maskEmail(dep.payerEmail),
      },
      payout: item && { amountCents: item.amountCents, status: item.status, feeCents: item.feeCents },
    };
  });
  const blockers = ev.settlementStartedAt ? [] : settlementBlockers(ev);
  return {
    id: ev.id,
    title: ev.title,
    startsAt: ev.startsAt.toISOString(),
    depositCents: ev.depositCents,
    currency: ev.currency,
    status: ev.status as EventStatus,
    settlementApproved: ev.settlementStartedAt !== null,
    canSettle: ev.status === 'ended' && blockers.length === 0,
    blockers,
    problems,
    guests,
    payout: ev.payout && {
      status: ev.payout.batchStatus,
      skippedReason: ev.payout.skippedReason,
      potCents: ev.payout.potCents,
      feeReserveCents: ev.payout.feeReserveCents,
      distributableCents: ev.payout.distributableCents,
      actualFeesCents: ev.payout.items.every((i) => i.feeCents !== null) && ev.payout.items.length
        ? ev.payout.items.reduce((s, i) => s + (i.feeCents ?? 0), 0) : null,
    },
  };
}
