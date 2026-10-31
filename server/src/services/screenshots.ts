import { z } from 'zod';
import { assembleTranscript, cleanShot, MAX_SHOTS, ShotMessageSchema, type Assembled, type ShotMessage } from '../ai/transcribe.js';
import { AiError } from '../ai/types.js';
import type { Ctx } from '../context.js';
import { AppError } from '../errors.js';

/** Largest image we accept, decoded. The web app shrinks screenshots to a few hundred KB first. */
export const MAX_IMAGE_BYTES = 2_000_000;
/** The JSON body limit for the image route: base64 inflates by 4/3, plus the envelope. */
export const SCREENSHOT_BODY_LIMIT = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4096;

export const ScreenshotInput = z.object({
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  data: z.string().min(64).max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Not base64'),
});

/** The first bytes must really be the image type claimed, so arbitrary data is never forwarded to the model. */
function magicMatches(mimeType: string, data: string): boolean {
  const b = Buffer.from(data.slice(0, 24), 'base64');
  if (mimeType === 'image/png') return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (mimeType === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  return b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
}

/** Reads ONE screenshot into cleaned messages. Nothing is stored; the image lives only in this request. */
export async function transcribeScreenshot(ctx: Ctx, raw: unknown): Promise<{ messages: ShotMessage[] }> {
  const input = ScreenshotInput.parse(raw);
  if (!magicMatches(input.mimeType, input.data)) throw new AppError(400, 'invalid_image', 'That file is not a valid image. Use a PNG or JPG screenshot.');
  if (!ctx.screens) throw new AiError('not_configured', 'no screenshot model configured');
  return { messages: cleanShot(await ctx.screens.transcribe(input)) };
}

export const AssembleInput = z.object({
  shots: z.array(z.array(ShotMessageSchema).max(120)).min(1).max(MAX_SHOTS),
  hostName: z.string().trim().max(60).optional(),
});

/** Stitches already-read screenshots into one transcript. No AI, no network: reordering or removing a screenshot is free. */
export function assembleChat(ctx: Ctx, raw: unknown): Assembled {
  const input = AssembleInput.parse(raw);
  const hasHostBubbles = input.shots.some((s) => s.some((m) => m.fromHost && m.kind !== 'date'));
  if (hasHostBubbles && !input.hostName) {
    throw new AppError(400, 'host_name_required', 'Type your name as your friends see it, so your own messages (on the right) can be labelled.');
  }
  const out = assembleTranscript(input.shots, { hostName: input.hostName ?? null });
  if (out.chat.length > ctx.config.rsvpMaxChars) {
    out.warnings.push(`This is ${out.chat.length} characters; at most ${ctx.config.rsvpMaxChars} can be read. Remove the oldest screenshots or shorten the text.`);
  }
  return out;
}
