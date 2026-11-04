import { z } from 'zod';
import type { Ctx } from '../context.js';
import {
  deriveGuestStage, assertEventTransition, type EventStatus,
} from '../domain/stateMachine.js';
import { AppError, conflict, notFound } from '../errors.js';
import { hashToken, maskEmail, newToken } from '../util.js';
import { formatCents } from '../domain/money.js';
import type { AppConfig } from '../config.js';
import { holdWindow } from '../domain/schedule.js';
import { payoutPreview } from './preview.js';
import {
  attendanceOf, BAD_PAYOUT_STATUSES, decisionOf, depositStatusOf, eventInclude, releasedEarly,
  type EventFull,
} from './shared.js';

export const CreateEventInput = z.object({
  title: z.string().trim().min(1).max(120),
  startsAt: z.iso.datetime({ offset: true }),
  // No product limits on the amount. The ceiling only keeps the value inside what we can
  // format and parse safely as PayPal money ($999,999.99).
  depositCents: z.number().int().min(1).max(99_999_999),
  // Names are optional: the host can paste one join link into the chat and let people add themselves.
  guests: z.array(z.object({ name: z.string().trim().min(1).max(60) })).default([]),
  /** Free cancellation: hours before the start until a friend may release their own hold. */
  graceHours: z.number().int().min(0).max(72).optional(),
  /** Where a no-show's charged deposit goes. */
  potMode: z.enum(['share', 'keep']).default('share'),
});
export type CreateEventInput = z.infer<typeof CreateEventInput>;

export async function createEvent(ctx: Ctx, input: CreateEventInput) {
  const { config } = ctx;
  const startsAt = new Date(input.startsAt);
  const now = ctx.now();
  if (startsAt <= now) throw new AppError(400, 'event_in_past', 'The event must start in the future.');
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
      joinToken: newToken(),
      graceHours: input.graceHours ?? config.graceHours,
      potMode: input.potMode,
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
    if (releasedEarly(guest)) throw conflict('released', `${guest.name} released their own hold, so they are not part of this event.`);
    await ctx.db.guest.update({
      where: { id: guest.id },
      // A decision only makes sense for no-shows.
      data: { attendance, ...(attendance === 'showed' ? { decision: null } : {}) },
    });
    return loadHostEvent(ctx, hostToken);
  });
}

/** "Everyone came": marks everyone who has a hold and is not marked yet, so the host only taps the exceptions. */
export async function markAllCame(ctx: Ctx, hostToken: string): Promise<EventFull> {
  const ev = await loadHostEvent(ctx, hostToken);
  return ctx.mutex.run(`event:${ev.id}`, async () => {
    const fresh = await loadHostEvent(ctx, hostToken);
    assertEditable(fresh);
    const ids = fresh.guests
      .filter((g) => !releasedEarly(g) && attendanceOf(g) === 'unknown' && g.deposit && depositStatusOf(g.deposit) === 'authorized')
      .map((g) => g.id);
    if (ids.length) await ctx.db.guest.updateMany({ where: { id: { in: ids } }, data: { attendance: 'showed', decision: null } });
    return loadHostEvent(ctx, hostToken);
  });
}

/** Takes a name off the list (a typo, or someone who is not invited). Only before they have put money down. */
export async function removeGuest(ctx: Ctx, hostToken: string, guestId: string): Promise<EventFull> {
  const ev = await loadHostEvent(ctx, hostToken);
  return ctx.mutex.run(`event:${ev.id}`, async () => {
    const fresh = await loadHostEvent(ctx, hostToken);
    if (fresh.status !== 'open' || fresh.settlementStartedAt) throw conflict('not_open', 'People can only be removed while the event is open.');
    const guest = fresh.guests.find((g) => g.id === guestId);
    if (!guest) throw notFound('Guest not found');
    if (guest.deposit && depositStatusOf(guest.deposit) !== 'pending') throw conflict('has_hold', `${guest.name} already has a hold in place. Release it from the guest's own link, or mark them as not coming.`);
    await ctx.db.guest.delete({ where: { id: guest.id } });
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
export function settlementBlockers(ev: EventFull, cfg: AppConfig): string[] {
  const out: string[] = [];
  if (ev.status === 'open') out.push('End the event first.');
  const held = ev.guests.filter((g) => g.deposit && depositStatusOf(g.deposit) === 'authorized');
  const unmarked = held.filter((g) => attendanceOf(g) === 'unknown');
  if (unmarked.length) out.push(`Mark attendance for: ${unmarked.map((g) => g.name).join(', ')}.`);
  const undecided = held.filter((g) => attendanceOf(g) === 'no_show' && !g.decision);
  if (undecided.length) out.push(`Decide capture or forgive for: ${undecided.map((g) => g.name).join(', ')}.`);

  // Never capture money that nobody could receive: there is no refund path, so the cash would
  // sit in the merchant account. Only judged once attendance is complete.
  if (!out.length) {
    const prev = payoutPreview(ev, cfg);
    const names = ev.guests.filter((g) => attendanceOf(g) === 'no_show' && decisionOf(g) === 'capture').map((g) => g.name).join(', ');
    if (prev.problem === 'no_recipients') {
      out.push(`Capturing ${names} would leave nobody to give the money to (no one who came has a deposit and a PayPal email on file). Forgive instead, or fix who showed up.`);
    } else if (prev.problem === 'pot_too_small') {
      out.push(`After PayPal's fees, capturing ${names} would leave under ${cfg.minPayoutPerPersonCents / 100 >= 1 ? '$' + formatCents(cfg.minPayoutPerPersonCents) : 'the minimum'} for each person who came, so nothing could be paid out. Forgive instead.`);
    }
  }
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
      /** Picked their name from the shared link, or put a hold down. A name nobody has claimed can be given a personal link by the host. */
      joined: g.claimedAt !== null || !!dep || g.cancelKind !== null,
      inviteUrl: `${ctx.config.appBaseUrl}/g/${g.inviteToken}`,
      attendance: attendanceOf(g),
      decision: decisionOf(g),
      /** The AI's verified recommendation, or null. Never pre-selects the decision. */
      ai: g.aiRecommendation ? { recommendation: g.aiRecommendation as 'capture' | 'forgive' | 'unclear', reason: g.aiReason ?? '', evidence: g.aiEvidence, flag: g.aiFlag as 'addresses_the_ai' | null, minutesBeforeStart: g.aiMinutesBeforeStart } : null,
      stage: deriveGuestStage({ attendance: attendanceOf(g), depositStatus: dep ? depositStatusOf(dep) : null, payoutItemStatus: item?.status ?? null, releasedEarly: releasedEarly(g) }),
      /** The friend's own "I can't make it", if any: a plain fact with its timing, never a decision. */
      cancel: g.cancelKind ? {
        kind: g.cancelKind as 'released' | 'late_notice',
        at: g.cancelledAt?.toISOString() ?? null,
        minutesBeforeStart: g.cancelledAt ? Math.round((ev.startsAt.getTime() - g.cancelledAt.getTime()) / 60_000) : null,
      } : null,
      deposit: dep && {
        status: depositStatusOf(dep), amountCents: dep.amountCents, feeCents: dep.feeCents, netCents: dep.netCents,
        payerEmail: maskEmail(dep.payerEmail),
      },
      payout: item && { amountCents: item.amountCents, status: item.status, feeCents: item.feeCents },
    };
  });
  const blockers = ev.settlementStartedAt ? [] : settlementBlockers(ev, ctx.config);
  const preview = ev.payout ? null : payoutPreview(ev, ctx.config);
  if (preview?.unpayableNames.length) {
    problems.push(`${preview.unpayableNames.join(', ')}: PayPal gave no email address for the payment, so they cannot be paid their share.`);
  }
  if (ev.payout?.batchStatus === 'SKIPPED' && ev.payout.potCents > 0 && ev.payout.skippedReason !== 'kept_by_host') {
    problems.push(`${formatCents(ev.payout.potCents)} was captured but could not be paid out (${ev.payout.skippedReason}). It is in your PayPal account; pay it out or refund it by hand.`);
  }
  // Not limits, just honesty: the host may pick any start time, but PayPal only guarantees a
  // hold for its honor period. Reauthorization is not built.
  const warnings: string[] = [];
  const daysAway = (ev.startsAt.getTime() - now) / 86_400_000;
  if (ev.status === 'open' && daysAway > ctx.config.honorPeriodDays) {
    warnings.push(`About ${Math.ceil(daysAway)} days away. Friends can join now; deposits open ${ctx.config.honorPeriodDays} days before the start.`);
  }
  return {
    id: ev.id,
    title: ev.title,
    startsAt: ev.startsAt.toISOString(),
    depositCents: ev.depositCents,
    currency: ev.currency,
    status: ev.status as EventStatus,
    /** Free-cancellation cutoff, and the line for a timely excuse (a fact shown to the host, not a rule that decides). */
    graceMinutes: ev.graceHours * 60,
    potMode: ev.potMode as 'share' | 'keep',
    /** The one link for the group chat. Null only for events made before join links existed. */
    joinUrl: ev.joinToken ? `${ctx.config.appBaseUrl}/e/${ev.joinToken}` : null,
    holdsOpenAt: holdWindow(ev.startsAt, ctx.config.honorPeriodDays, ctx.now()).opensAt.toISOString(),
    settlementApproved: ev.settlementStartedAt !== null,
    canSettle: ev.status === 'ended' && blockers.length === 0,
    blockers,
    warnings,
    problems,
    guests,
    /** Estimate of the payout if settled now; null once a payout plan exists. */
    payoutPreview: preview,
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
