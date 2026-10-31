import { z } from 'zod';

/** What the model is asked to produce. Everything in it is a CLAIM that code verifies against the chat. */
export const RsvpDraftSchema = z.object({
  organizer: z.string().max(80).nullable(),
  title: z.string().max(200).nullable(),
  /** Local wall-clock time, "YYYY-MM-DDTHH:mm", in the host's time zone. Null when unsure. */
  startsAtLocal: z.string().max(40).nullable(),
  depositCents: z.number().int().min(0).max(99_999_999).nullable(),
  /** Exact quote of the line that states the deposit. */
  depositEvidence: z.string().max(500).nullable(),
  guests: z.array(z.object({
    name: z.string().min(1).max(80),
    rsvp: z.enum(['in', 'maybe', 'out']),
    /** Exact quote of the line that shows this person's reply. */
    evidence: z.string().max(500),
  })).max(60),
  questions: z.array(z.string().max(300)).max(12),
});
export type RsvpDraft = z.infer<typeof RsvpDraftSchema>;

export interface RsvpInput {
  chat: string;
  now: { localIso: string; weekday: string; timeZone: string };
}

/** Provider-neutral. The Gemini adapter and the test fake both implement this. */
export interface RsvpModel {
  extract(input: RsvpInput): Promise<RsvpDraft>;
}

export type AiErrorKind = 'not_configured' | 'misconfigured' | 'unavailable' | 'invalid_output' | 'blocked';

const SAFE: Record<AiErrorKind, string> = {
  not_configured: 'The AI helper is not set up on this server. You can add guests by hand.',
  misconfigured: 'The AI helper is misconfigured (check the API key and model name). You can add guests by hand.',
  unavailable: 'The AI helper is busy or unreachable right now. Try again in a moment, or add guests by hand.',
  invalid_output: "The AI helper's answer could not be used. Try again, or add guests by hand.",
  blocked: 'The AI helper declined to read that text. You can add guests by hand.',
};

export class AiError extends Error {
  readonly userMessage: string;
  constructor(public readonly kind: AiErrorKind, message: string, public readonly httpStatus?: number) {
    super(message);
    this.name = 'AiError';
    this.userMessage = SAFE[kind];
  }
}
