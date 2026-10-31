import { z } from 'zod';

/**
 * Screenshots of a chat -> the plain text the rest of the pipeline already understands.
 *
 * The vision model only READS pixels into messages. Everything else here is plain code: cleaning
 * what it returned, stitching overlapping screenshots together, and writing the transcript. The
 * host then reads and can edit that transcript before anything is extracted from it, because a
 * misread amount cannot be caught by code (there is no ground truth to compare to).
 *
 * Measured in a spike on a 52-message fabricated chat in 7 phone screenshots: reading each image on
 * its own and merging in code beat sending all images in one call (the one-call version kept a
 * cut-off copy of the deposit message and mangled emoji).
 */

/** Used in the transcript when a sender's name was out of view. The RSVP verifier never accepts it as a guest. */
export const UNKNOWN_SENDER = 'Unknown';
export const MAX_SHOTS = 8;

export interface ScreenshotImage {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  /** base64, no "data:" prefix */
  data: string;
}

/** Provider-neutral: the Gemini adapter and the test fake both implement this. */
export interface ScreenshotModel {
  /** Reads ONE screenshot. */
  transcribe(image: ScreenshotImage): Promise<ShotDraft>;
}

/** What the model returns for one screenshot. Everything in it is a claim that cleanShot() tidies. */
export const ShotDraftSchema = z.object({
  messages: z.array(z.object({
    author: z.string().max(120).nullable(),
    fromHost: z.boolean(),
    kind: z.enum(['text', 'photo', 'date']),
    text: z.string().max(4000),
    time: z.string().max(20).nullable(),
    partial: z.boolean(),
  })).max(120),
});
export type ShotDraft = z.infer<typeof ShotDraftSchema>;

/** A cleaned message: what the API returns per screenshot and accepts back for assembly. */
export const ShotMessageSchema = z.object({
  author: z.string().max(80).nullable(),
  fromHost: z.boolean(),
  kind: z.enum(['text', 'photo', 'date']),
  text: z.string().max(2000),
  time: z.string().max(20).nullable(),
});
export type ShotMessage = z.infer<typeof ShotMessageSchema>;

// ---- cleaning ------------------------------------------------------------------------------

const TIME = /^\d{1,2}:\d{2}(?:\s?[ap]\.?m\.?)?$/i;
const TRAILING_TIME = /\n\s*(\d{1,2}:\d{2}(?:\s?[ap]\.?m\.?)?)\s*$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function codePoint(n: number, fallback: string): string {
  return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : fallback;
}
/** The model sometimes writes emoji as "&#128514;". */
const decodeEntities = (t: string) => t
  .replace(/&#x([0-9a-f]{1,6});/gi, (m, h: string) => codePoint(parseInt(h, 16), m))
  .replace(/&#(\d{1,7});/g, (m, d: string) => codePoint(Number(d), m))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const cleanTime = (t: string | null) => { const s = t?.trim() ?? ''; return TIME.test(s) ? s : null; };
/** A sender name that is safe inside a "Name: text" line. */
export const cleanName = (s: string) => s.replace(CONTROL, '').replace(/[:[\]\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
const oneLine = (s: string) => s.replace(CONTROL, '').replace(/\s+/g, ' ').trim();

/** Tidies one screenshot's model output. Cut-off bubbles and empty ghosts are dropped. */
export function cleanShot(draft: ShotDraft): ShotMessage[] {
  const out: ShotMessage[] = [];
  for (const m of draft.messages) {
    if (m.partial) continue; // the neighbouring screenshot shows it whole
    let text = decodeEntities(m.text).replace(CONTROL, '');
    let time = cleanTime(m.time);
    // The model sometimes glues the clock time onto a short message ("in!\n10:20").
    const glued = TRAILING_TIME.exec(text);
    if (glued) { time = time ?? cleanTime(glued[1]!); text = text.slice(0, glued.index); }
    text = oneLine(text);
    if (m.kind === 'date') {
      text = text.replace(/[[\]]/g, '').slice(0, 40);
      if (text) out.push({ author: null, fromHost: false, kind: 'date', text, time: null });
      continue;
    }
    if (m.kind === 'text' && text === '') continue;
    let author = m.author ? cleanName(m.author) : '';
    let fromHost = m.fromHost;
    if (/^me$/i.test(author)) fromHost = true;
    if (fromHost) author = '';
    out.push({ author: author || null, fromHost, kind: m.kind, text: m.kind === 'photo' ? '' : text.slice(0, 2000), time });
  }
  return out;
}

// ---- stitching -----------------------------------------------------------------------------

const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

function lev(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** Longest text we compare by edit distance. Longer ones must match exactly or by containment (bounds the work on untrusted input). */
const LEV_MAX = 200;

/**
 * Is `b` (from the next screenshot) the same message as `a`? Tolerates cut-off and slightly misread
 * text, and a missing time (a bubble cut off at the edge shows no time strip).
 */
export function sameMessage(a: ShotMessage, b: ShotMessage): boolean {
  if (a.kind !== b.kind || a.fromHost !== b.fromHost) return false;
  if (a.time !== null && b.time !== null && a.time !== b.time) return false;
  if (!a.fromHost && a.author && b.author && norm(a.author) !== norm(b.author)) return false;
  if (a.kind === 'photo') return true;
  const x = norm(a.text), y = norm(b.text);
  if (x === y) return true;
  if (a.kind === 'date') return false; // "Mon, 2 Nov" and "Mon, 3 Nov" are one character apart but different days
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 6 && long.includes(short)) return true; // one is a cut-off piece of the other
  const longest = Math.max(x.length, y.length);
  if (longest < 4 || longest > LEV_MAX || long.length - short.length > longest * 0.3) return false;
  return lev(x, y) / longest <= 0.3;
}

/** How many of the newest messages we have so far are searched for the overlap with the next screenshot. */
const OVERLAP_WINDOW = 30;
/** The overlap must reach the very end of what we have, give or take a few cut-off or misread items. */
const OVERLAP_SLACK = 6;

/**
 * Aligns the end of what we have with the start of the next screenshot (longest common subsequence under
 * sameMessage). Unlike matching a whole prefix, one garbled item at the top of a screenshot (seen in real
 * runs: a clipped bubble given the next bubble's text or the wrong sender) cannot break the alignment.
 */
function alignOverlap(tail: ShotMessage[], list: ShotMessage[]): [number, number][] {
  const n = tail.length, m = list.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const eq = (i: number, j: number) => sameMessage(tail[i]!, list[j]!);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = eq(i, j) ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (eq(i, j) && dp[i]![j] === dp[i + 1]![j + 1]! + 1) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

export interface Assembled {
  /** One "[Day time] Name: text" line per message, the form parseChat() reads. */
  chat: string;
  messageCount: number;
  /** Things the host should look at, in plain language. */
  warnings: string[];
  unknownCount: number;
}

/** Merges the screenshots (oldest first) into one transcript. Pure and deterministic. */
export function assembleTranscript(shots: ShotMessage[][], opts: { hostName: string | null }): Assembled {
  const warnings: string[] = [];
  const clean = (m: ShotMessage): ShotMessage => ({
    ...m,
    author: m.author ? cleanName(m.author) || null : null,
    text: m.kind === 'photo' ? '' : oneLine(m.text),
    time: cleanTime(m.time),
  });

  let merged: ShotMessage[] = [];
  shots.forEach((raw, i) => {
    const list = raw.map(clean).filter((m) => m.kind !== 'text' || m.text !== '');
    if (list.length === 0) { warnings.push(`Screenshot ${i + 1} had no readable messages.`); return; }
    if (merged.length === 0) { merged = list; return; }
    // Find where this screenshot overlaps the end of what we have. Everything in it up to the last
    // overlapping message is either already there or a misread of something that is, so only what
    // comes after is new.
    const tail = merged.slice(-OVERLAP_WINDOW);
    const offset = merged.length - tail.length;
    let pairs = alignOverlap(tail, list);
    if (pairs.length > 0 && tail.length - 1 - pairs[pairs.length - 1]![0] > OVERLAP_SLACK) pairs = []; // matched only something far back: not a real overlap
    if (pairs.length === 0) {
      warnings.push(`Screenshot ${i} and screenshot ${i + 1} share no message, so something between them may be missing. Add a screenshot that overlaps both.`);
      merged = merged.concat(list);
      return;
    }
    for (const [ti, lj] of pairs) {
      const mine = merged[offset + ti]!;
      const theirs = list[lj]!;
      if (!mine.fromHost && !mine.author && theirs.author) mine.author = theirs.author;
      if (mine.time === null && theirs.time !== null) mine.time = theirs.time;
      if (theirs.text.length > mine.text.length) mine.text = theirs.text; // keep the whole version, not the cut-off one
    }
    // Items before the first overlapping message are the garbled slivers seen at the top of a screenshot: dropped.
    // An unmatched item BETWEEN overlapping ones is more likely a real message the previous screenshot missed: kept, in place.
    const firstJ = pairs[0]![1], lastJ = pairs[pairs.length - 1]![1];
    const anchorOf = new Map(pairs.map(([ti, lj]) => [lj, offset + ti] as const));
    const insertAfter = new Map<number, ShotMessage[]>();
    let anchor = -1;
    for (let j = firstJ; j <= lastJ; j++) {
      const at = anchorOf.get(j);
      if (at !== undefined) anchor = at;
      else insertAfter.set(anchor, [...(insertAfter.get(anchor) ?? []), list[j]!]);
    }
    const next: ShotMessage[] = [];
    merged.forEach((m, idx) => { next.push(m, ...(insertAfter.get(idx) ?? [])); });
    merged = next.concat(list.slice(lastJ + 1));
  });

  const host = opts.hostName ? cleanName(opts.hostName) || 'Host' : 'Host';
  const lines: string[] = [];
  let day: string | null = null;
  let runAuthor: string | null = null; // the sender whose name label started the current run of bubbles
  let unknownCount = 0;
  for (const m of merged) {
    if (m.kind === 'date') { day = m.text; runAuthor = null; continue; }
    let author: string;
    if (m.fromHost) { author = host; runAuthor = null; }
    else if (m.author) { author = m.author; runAuthor = author; }
    else if (runAuthor) author = runAuthor; // an unlabeled bubble continues the previous sender's run
    else { author = UNKNOWN_SENDER; unknownCount++; }
    const stamp = [day, m.time].filter(Boolean).join(' ').slice(0, 38);
    lines.push(`${stamp.length >= 3 ? `[${stamp}] ` : ''}${author}: ${m.kind === 'photo' ? '[photo]' : m.text}`);
  }
  if (unknownCount > 0) {
    warnings.push(`${unknownCount} message${unknownCount === 1 ? '' : 's'} ${unknownCount === 1 ? 'has' : 'have'} no readable sender and ${unknownCount === 1 ? 'is' : 'are'} marked “${UNKNOWN_SENDER}”. Fix the name in the text if it matters.`);
  }
  if (lines.length === 0) warnings.push('Nothing could be read from these screenshots. Try clearer screenshots of the chat.');
  return { chat: lines.join('\n'), messageCount: lines.length, warnings, unknownCount };
}
