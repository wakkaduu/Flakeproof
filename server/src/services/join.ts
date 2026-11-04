import { z } from 'zod';
import type { Ctx } from '../context.js';
import { holdWindow } from '../domain/schedule.js';
import { conflict, notFound } from '../errors.js';
import { newToken } from '../util.js';
import { eventInclude, type EventFull } from './shared.js';

/**
 * The one link a host pastes into the group chat. Everyone opens the same link, taps their name (or types it)
 * and gets their own personal link back. Nothing here moves money. The join link only lets someone *add or claim
 * a name*; the host sees every name and can remove one before it has a hold.
 */

async function loadByJoinToken(ctx: Ctx, code: string): Promise<EventFull> {
  const ev = await ctx.db.event.findUnique({ where: { joinToken: code }, include: eventInclude });
  if (!ev) throw notFound('This link is not valid. Ask your host for the link again.');
  return ev;
}

const taken = (g: EventFull['guests'][number]) => g.claimedAt !== null || g.deposit !== null || g.cancelKind !== null;

export function joinView(ctx: Ctx, ev: EventFull) {
  const w = holdWindow(ev.startsAt, ctx.config.honorPeriodDays, ctx.now());
  const joinable = ev.status === 'open' && ctx.now() < ev.startsAt;
  return {
    event: { title: ev.title, startsAt: ev.startsAt.toISOString(), depositCents: ev.depositCents, currency: ev.currency, status: ev.status as 'open' | 'ended' | 'settled', potMode: ev.potMode as 'share' | 'keep', graceHours: ev.graceHours },
    holds: { state: w.state, opensAt: w.opensAt.toISOString() },
    /** Names the host already listed. `taken` ones are greyed out; only the id of a free name is useful. */
    names: ev.guests.map((g) => ({ id: g.id, name: g.name, taken: taken(g) })),
    joinable,
    /** Others can type their own name while there is room. */
    canAddName: joinable && ev.guests.length < ctx.config.maxGuests,
    /** How many have joined so far, so the page feels alive without exposing everyone's name. */
    joinedCount: ev.guests.filter(taken).length,
  };
}

export async function getJoinView(ctx: Ctx, code: string) {
  return joinView(ctx, await loadByJoinToken(ctx, code));
}

export const JoinBody = z.union([
  z.object({ guestId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/) }),
  z.object({ name: z.string().trim().min(1, 'Type your name.').max(60) }),
]);

/** Claims a listed name, or adds a new one. Returns the person's own link. Each name can be claimed once. */
export async function joinEvent(ctx: Ctx, code: string, raw: unknown): Promise<{ inviteToken: string; inviteUrl: string; name: string }> {
  const body = JoinBody.parse(raw);
  const ev0 = await loadByJoinToken(ctx, code);
  return ctx.mutex.run(`event:${ev0.id}`, async () => {
    const ev = await loadByJoinToken(ctx, code);
    if (ev.status !== 'open' || ctx.now() >= ev.startsAt) throw conflict('closed', 'This event has started, so nobody can join any more.');
    const now = ctx.now();
    let guest: EventFull['guests'][number];

    if ('guestId' in body) {
      const g = ev.guests.find((x) => x.id === body.guestId);
      if (!g) throw notFound('That name is not on the list.');
      if (taken(g)) throw conflict('already_claimed', `${g.name} is already taken. If that is you, open the link you were given before. If not, add your name below.`);
      guest = await ctx.db.guest.update({ where: { id: g.id }, data: { claimedAt: now }, include: { deposit: true, payoutItem: true } });
    } else {
      if (ev.guests.length >= ctx.config.maxGuests) throw conflict('full', `This event is full (${ctx.config.maxGuests} people). Ask your host.`);
      const same = ev.guests.find((g) => g.name.trim().toLowerCase() === body.name.toLowerCase());
      if (same) throw conflict('name_taken', `Someone already joined as ${same.name}. Add an initial, like “${body.name} K.”`);
      guest = await ctx.db.guest.create({ data: { eventId: ev.id, name: body.name, inviteToken: newToken(), claimedAt: now }, include: { deposit: true, payoutItem: true } });
    }
    return { inviteToken: guest.inviteToken, inviteUrl: `${ctx.config.appBaseUrl}/g/${guest.inviteToken}`, name: guest.name };
  });
}

