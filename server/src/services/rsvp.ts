import { z } from 'zod';
import { verifyRsvp, type RsvpProposal } from '../ai/verify.js';
import { AiError, type RsvpInput } from '../ai/types.js';
import type { Ctx } from '../context.js';
import { AppError } from '../errors.js';

export const ParseRsvpInput = z.object({
  chat: z.string().trim().min(1, 'Paste the group chat first.'),
  timeZone: z.string().min(1).max(64),
});

/** "now" as the host sees it: naive local "YYYY-MM-DDTHH:mm", weekday name, zone. */
export function localNow(date: Date, timeZone: string): RsvpInput['now'] {
  let dtf: Intl.DateTimeFormat;
  try {
    dtf = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch {
    throw new AppError(400, 'invalid_time_zone', 'Unknown time zone.');
  }
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(date);
  return { localIso: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`, weekday, timeZone };
}

export async function parseRsvp(ctx: Ctx, raw: unknown): Promise<RsvpProposal> {
  const input = ParseRsvpInput.parse(raw);
  if (input.chat.length > ctx.config.rsvpMaxChars) {
    throw new AppError(413, 'chat_too_long', `That chat is too long. Paste at most ${ctx.config.rsvpMaxChars} characters (the part where people reply).`);
  }
  if (!ctx.rsvp) throw new AiError('not_configured', 'no model configured');
  const now = localNow(ctx.now(), input.timeZone);
  const draft = await ctx.rsvp.extract({ chat: input.chat, now });
  return verifyRsvp(draft, { chat: input.chat, now }, { maxGuests: ctx.config.maxGuests });
}
