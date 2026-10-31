import type { RsvpDraft, RsvpInput } from './types.js';

/**
 * The model only READS and PROPOSES. This file is the guard: every person, amount and time it
 * claims is checked against the pasted text in plain code. Anything that cannot be verified is
 * dropped and turned into a question for the host. Measured reason this exists: in repeated runs
 * at temperature 0, the model sometimes invented guests ("Dee's sister") that nobody named.
 */

export interface ChatMessage { author: string | null; text: string }

export interface ProposedGuest {
  name: string;
  rsvp: 'in' | 'maybe' | 'out';
  /** author = wrote in the chat; mentioned = only named by someone else (host should confirm). */
  source: 'author' | 'mentioned';
  evidence: string;
  /** True when the quoted evidence could not be found in the chat, so "in" was downgraded to "maybe". */
  downgraded: boolean;
}

export interface RsvpProposal {
  organizer: string | null;
  title: string | null;
  startsAtLocal: string | null;
  depositCents: number | null;
  guests: ProposedGuest[];
  /** Things the model or the checks want the host to answer. */
  questions: string[];
  /** Plain-language record of what was dropped or changed, so nothing is silent. */
  notes: string[];
}

const norm = (s: string) =>
  s.normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

const LINE = /^(?:\[[^\]]{3,40}\]\s*|\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4},?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?\s*[-–]\s*)?([^:\n]{1,40}?):\s+(.*)$/i;

/** Splits "Name: text" lines (plain or WhatsApp-style); unlabeled lines continue the previous message. */
export function parseChat(chat: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const raw of chat.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = LINE.exec(line);
    if (m && m[1] && !/^\d+$/.test(m[1].trim())) out.push({ author: m[1].trim(), text: (m[2] ?? '').trim() });
    else if (out.length) out[out.length - 1]!.text += ` ${line}`;
    else out.push({ author: null, text: line });
  }
  return out;
}

/** Dollar amounts written in a string, in cents. Accepts $15, $15.50, 15 dollars, 15 bucks, 15 usd. */
export function amountsIn(text: string): number[] {
  const found: number[] = [];
  const add = (whole: string, frac?: string) => {
    const cents = Number(whole) * 100 + (frac ? Number(frac.padEnd(2, '0')) : 0);
    if (Number.isSafeInteger(cents)) found.push(cents);
  };
  for (const m of text.matchAll(/(?:\$|usd\s?)\s?(\d{1,6})(?:\.(\d{1,2}))?/gi)) add(m[1]!, m[2]);
  for (const m of text.matchAll(/(\d{1,6})(?:\.(\d{1,2}))?\s?(?:dollars?|bucks|usd)\b/gi)) add(m[1]!, m[2]);
  return [...new Set(found)];
}

const wordIn = (haystack: string, needle: string) =>
  new RegExp(`(?:^|[^\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(haystack);

export function verifyRsvp(draft: RsvpDraft, input: RsvpInput, opts: { maxGuests: number }): RsvpProposal {
  const messages = parseChat(input.chat);
  const chatNorm = norm(messages.map((m) => `${m.author ? m.author + ': ' : ''}${m.text}`).join('\n'));
  const authors = new Map<string, string>(); // norm -> canonical as written in the chat
  for (const m of messages) if (m.author) authors.set(norm(m.author), m.author);
  const notes: string[] = [];
  const questions: string[] = [];
  const evidenceInChat = (e: string) => {
    const n = norm(e);
    return n.length >= 2 && chatNorm.includes(n);
  };

  // organizer must be someone who actually wrote in the chat
  const organizer = draft.organizer ? authors.get(norm(draft.organizer)) ?? null : null;
  if (draft.organizer && !organizer) notes.push(`Ignored organizer “${draft.organizer}”: not an author in the chat.`);

  // ---- guests
  const guests: ProposedGuest[] = [];
  const seen = new Set<string>();
  for (const g of draft.guests) {
    const key = norm(g.name);
    let canonical = authors.get(key);
    if (!canonical) {
      // "Ana" for chat author "Ana Lopez", only when unambiguous
      const first = [...authors.entries()].filter(([a]) => a.split(' ')[0] === key);
      if (first.length === 1) canonical = first[0]![1];
    }
    const source: 'author' | 'mentioned' | null = canonical
      ? 'author'
      : messages.some((m) => wordIn(m.text, g.name.trim())) ? 'mentioned' : null;
    if (!source) {
      notes.push(`Left out “${g.name}”: that name does not appear in the chat.`);
      questions.push(`Someone may be coming as “${g.name}”, but no one by that name wrote or was named in the chat. Who did you mean?`);
      continue;
    }
    const name = canonical ?? g.name.trim();
    if (organizer && norm(name) === norm(organizer)) { notes.push(`Left out ${name}: they are the organizer (you).`); continue; }
    if (seen.has(norm(name))) { notes.push(`Ignored a duplicate entry for ${name}.`); continue; }
    seen.add(norm(name));
    const found = evidenceInChat(g.evidence);
    let rsvp = g.rsvp;
    let downgraded = false;
    if (!found && rsvp === 'in') { rsvp = 'maybe'; downgraded = true; notes.push(`${name}: could not find the quoted reply in the chat, so “in” was changed to “maybe”.`); }
    guests.push({ name, rsvp, source, evidence: g.evidence.trim().slice(0, 300), downgraded });
  }
  if (guests.length > opts.maxGuests) notes.push(`Found ${guests.length} people; an event can have at most ${opts.maxGuests}.`);

  // ---- deposit: a literal amount, written by the organizer, quoted from the chat
  let depositCents: number | null = null;
  if (draft.depositCents !== null && draft.depositCents > 0) {
    const ev = draft.depositEvidence ?? '';
    const evOk = evidenceInChat(ev) && amountsIn(ev).includes(draft.depositCents);
    const writtenByOrganizer = !organizer || messages.some((m) => m.author && norm(m.author) === norm(organizer) && amountsIn(m.text).includes(draft.depositCents!));
    if (evOk && writtenByOrganizer) depositCents = draft.depositCents;
    else notes.push(`Ignored a deposit of ${(draft.depositCents / 100).toFixed(2)}: ${!evOk ? 'it is not written in the chat' : 'it was not written by the organizer'}.`);
    if (depositCents !== null && organizer) {
      const others = new Set<number>();
      for (const m of messages) if (m.author && norm(m.author) === norm(organizer)) amountsIn(m.text).forEach((c) => others.add(c));
      others.delete(depositCents);
      if (others.size) notes.push(`The organizer mentioned other amounts too (${[...others].map((c) => '$' + (c / 100).toFixed(2)).join(', ')}). Please check the deposit.`);
    }
  }
  if (depositCents === null) questions.push('How much should each deposit be? No amount from the organizer was found in the chat.');

  // ---- start time: shape and "in the future" (naive local strings compare correctly)
  let startsAtLocal: string | null = null;
  const t = draft.startsAtLocal;
  if (t && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t) && !Number.isNaN(Date.parse(`${t}:00Z`))) {
    if (t > input.now.localIso) startsAtLocal = t;
    else notes.push('Ignored a start time that is already in the past.');
  }
  if (!startsAtLocal) questions.push('When does the event start?');

  // ---- model's own questions, sanitized
  for (const q of draft.questions) {
    const c = q.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (c) questions.push(c);
  }

  return {
    organizer,
    title: draft.title?.replace(/\s+/g, ' ').trim().slice(0, 120) || null,
    startsAtLocal,
    depositCents,
    guests,
    questions: [...new Set(questions)].slice(0, 10),
    notes,
  };
}
