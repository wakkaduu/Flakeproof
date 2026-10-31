import { z } from 'zod';
import { verifyJudge, type JudgeVerdict } from '../ai/judge.js';
import { AiError } from '../ai/types.js';
import type { Ctx } from '../context.js';
import { AppError, conflict } from '../errors.js';
import { loadHostEvent } from './events.js';
import { localNow } from './rsvp.js';
import { attendanceOf, depositStatusOf, type EventFull } from './shared.js';

export const JudgeInputSchema = z.object({
  chat: z.string().trim().min(1, 'Paste the group chat from after the event first.'),
  timeZone: z.string().min(1).max(64),
});

/**
 * Asks the AI for a RECOMMENDATION for each no-show, verifies it against the pasted chat, and stores
 * only the short verified result next to the guest. It never sets a decision, never touches PayPal, and
 * the pasted chat itself is not kept. Only the host's later explicit decision and approval move money.
 */
export async function runJudge(ctx: Ctx, hostToken: string, raw: unknown): Promise<EventFull> {
  const input = JudgeInputSchema.parse(raw);
  if (input.chat.length > ctx.config.rsvpMaxChars) {
    throw new AppError(413, 'chat_too_long', `That chat is too long. Paste at most ${ctx.config.rsvpMaxChars} characters (the part after the event).`);
  }
  const ev0 = await loadHostEvent(ctx, hostToken);
  return ctx.mutex.run(`event:${ev0.id}`, async () => {
    const ev = await loadHostEvent(ctx, hostToken);
    if (ev.settlementStartedAt) throw conflict('locked', 'The host already approved settlement.');
    if (ev.status !== 'ended') throw conflict('not_ended', 'End the event before asking the AI about no-shows.');
    const noShows = ev.guests.filter((g) => attendanceOf(g) === 'no_show' && g.deposit && depositStatusOf(g.deposit) === 'authorized');
    if (noShows.length === 0) throw conflict('nothing_to_judge', 'There are no no-shows with a held deposit to look at.');
    if (!ctx.judge) throw new AiError('not_configured', 'no model configured');

    const jin = {
      chat: input.chat,
      eventTitle: ev.title,
      startedAtLocal: localNow(ev.startsAt, input.timeZone).localIso.replace('T', ' '),
      timeZone: input.timeZone,
      noShows: noShows.map((g) => ({ id: g.id, name: g.name })),
    };
    const draft = await ctx.judge.assess(jin);
    const verdicts = verifyJudge(draft, jin);
    await ctx.db.$transaction(verdicts.map((v: JudgeVerdict) =>
      ctx.db.guest.update({
        where: { id: v.guestId },
        data: { aiRecommendation: v.recommendation, aiReason: v.reason, aiEvidence: v.evidence, aiFlag: v.flag, aiMinutesBeforeStart: v.minutesBeforeStart },
      })));
    return loadHostEvent(ctx, hostToken);
  });
}
