import { z } from 'zod';
import { AiError } from './types.js';
import { findAuthor, norm, parseChat } from './verify.js';

/** What the model returns for each no-show. Every field is a CLAIM that code verifies against the chat. */
export const JudgeDraftSchema = z.object({
  verdicts: z.array(z.object({
    guestId: z.string().max(64),
    recommendation: z.enum(['capture', 'forgive', 'unclear']),
    reason: z.string().max(400),
    evidence: z.string().max(500).nullable(),
  })).max(60),
});
export type JudgeDraft = z.infer<typeof JudgeDraftSchema>;

export interface JudgeInput {
  chat: string;
  eventTitle: string;
  /** Event start as the host sees it, "YYYY-MM-DDTHH:mm". Reference only. */
  startedAtLocal: string;
  timeZone: string;
  /** Only people we already know are no-shows with a held deposit. The model cannot add or remove anyone. */
  noShows: { id: string; name: string }[];
}

/** Provider-neutral, like RsvpModel. */
export interface JudgeModel {
  assess(input: JudgeInput): Promise<JudgeDraft>;
}

export interface JudgeVerdict {
  guestId: string;
  name: string;
  recommendation: 'capture' | 'forgive' | 'unclear';
  /** One sentence from the model, labelled as AI wherever it is shown. */
  reason: string;
  /** Exact quote from the no-show's OWN message, verified against the chat; null if none. */
  evidence: string | null;
  /** When the quoted message was written, relative to the event start. Computed in code from the chat's timestamps; null if there is none. Negative = after the start. */
  minutesBeforeStart: number | null;
  /** The message is addressed to the AI or tries to steer it. */
  flag: 'addresses_the_ai' | null;
  /** What the checks changed, in plain words. */
  note: string | null;
}

// Messages that talk to the AI instead of the group. A flag, not a verdict: the host decides.
const ADDRESSES_AI = /\b(ai|a\.i\.|assistant|judge|model|chatbot|instructions?|prompt|ignore (the |all |previous )?(rules|instructions?)|recommend(ation)?|system)\b/i;

export function verifyJudge(draft: JudgeDraft, input: JudgeInput): JudgeVerdict[] {
  const startLocal = input.startedAtLocal.replace(' ', 'T');
  const messages = parseChat(input.chat, { reference: startLocal });
  const startMs = Date.parse(`${startLocal}:00Z`);
  const byId = new Map<string, JudgeDraft['verdicts'][number]>();
  for (const v of draft.verdicts) if (!byId.has(v.guestId)) byId.set(v.guestId, v);

  return input.noShows.map((n): JudgeVerdict => {
    const v = byId.get(n.id);
    const author = findAuthor(messages, n.name);
    const own = author ? messages.filter((m) => m.author !== null && norm(m.author) === norm(author)) : [];
    const flag = own.some((m) => ADDRESSES_AI.test(m.text)) ? 'addresses_the_ai' : null;
    // The message that holds the quote, and how long before the start it was written (code, not the model).
    const evMsg = (q: string | null) => {
      if (!q || !author) return null;
      let e = norm(q);
      const prefix = `${norm(author)}:`;
      if (e.startsWith(prefix)) e = e.slice(prefix.length).trim();
      return own.find((m) => e.length > 0 && norm(m.text).includes(e)) ?? null;
    };
    const clean = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 200);

    if (!v) {
      return { guestId: n.id, name: n.name, recommendation: 'unclear', reason: 'The AI had nothing to say about this person. You decide.', evidence: null, minutesBeforeStart: null, flag, note: 'No verdict returned.' };
    }
    // The quote must exist in a message this person wrote. Anything else is not evidence.
    const evidenceMsg = evMsg(v.evidence);
    const evidenceOk = evidenceMsg !== null;
    const evidence = evidenceOk ? v.evidence!.replace(/\s+/g, ' ').trim().slice(0, 300) : null;
    const minutesBeforeStart = evidenceOk && evidenceMsg.at && Number.isFinite(startMs) ? Math.round((startMs - Date.parse(`${evidenceMsg.at}:00Z`)) / 60000) : null;
    let note: string | null = null;
    if (v.evidence && !evidenceOk) note = `Dropped a quote the AI gave: it is not in a message written by ${n.name}.`;

    // Forgiving needs the person's own words. Without them it is only a guess.
    if (v.recommendation === 'forgive' && !evidence) {
      return {
        guestId: n.id, name: n.name, recommendation: 'unclear', flag,
        reason: `The AI leaned towards forgiving ${n.name} but found no matching message from them. You decide.`,
        evidence: null, minutesBeforeStart: null, note: note ?? 'Downgraded from forgive: no verified quote from their own message.',
      };
    }
    // A person who is steering the AI does not get a forgive on the strength of that.
    if (v.recommendation === 'forgive' && flag) {
      return {
        guestId: n.id, name: n.name, recommendation: 'unclear', flag,
        reason: `${n.name}'s message is addressed to the AI. Treat it with care and decide yourself.`,
        evidence, minutesBeforeStart, note: 'Downgraded from forgive: the message tries to steer the AI.',
      };
    }
    return { guestId: n.id, name: n.name, recommendation: v.recommendation, reason: clean(v.reason), evidence, minutesBeforeStart, flag, note };
  });
}

export { AiError };
