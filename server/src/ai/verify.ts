import type { RsvpDraft, RsvpInput } from './types.js';

/**
 * The model only READS and PROPOSES. This file is the guard: every person, amount and time it
 * claims is checked against the pasted text in plain code. Anything that cannot be verified is
 * dropped and turned into a question for the host. Measured reason this exists: in repeated runs
 * at temperature 0, the model sometimes invented guests ("Dee's sister") that nobody named.
 */

export interface ChatMessage {
  author: string | null;
  text: string;
  /** Local wall-clock time of the message, "YYYY-MM-DDTHH:mm", when the export has an unambiguous timestamp. */
  at: string | null;
}

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

export const norm = (s: string) =>
  s.normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

const LINE = /^(?:\[([^\]]{3,40})\]\s*|(\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4},?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)\s*[-–]\s*)?([^:\n]{1,40}?):\s+(.*)$/i;

interface RawStamp { a: number; b: number; c: number | null; hh: number; mm: number; iso: { y: number; m: number; d: number } | null }

function rawStamp(text: string): RawStamp | null {
  const t = text.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T,]+(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?/i.exec(t);
  if (m) return { a: 0, b: 0, c: null, hh: to24(Number(m[4]), m[6]), mm: Number(m[5]), iso: { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } };
  m = /^(\d{1,4})[/.-](\d{1,2})(?:[/.-](\d{1,4}))?,?\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?/i.exec(t);
  if (!m) return null;
  return { a: Number(m[1]), b: Number(m[2]), c: m[3] ? Number(m[3]) : null, hh: to24(Number(m[4]), m[6]), mm: Number(m[5]), iso: null };
}
const to24 = (h: number, ap?: string) => (ap ? (h % 12) + (/^p/i.test(ap) ? 12 : 0) : h);
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Turns the raw stamps of one chat into local "YYYY-MM-DDTHH:mm" strings. The day/month order is read
 * from the chat itself (a 31 or a 13 settles it); if every stamp is ambiguous we say nothing rather than
 * guess, because a wrong date would give a wrong "hours before" claim. Stamps without a year take the
 * year of `reference` (the event start), stepping back a year if that would put them well after it.
 */
function resolveStamps(raws: (RawStamp | null)[], reference: string | undefined): (string | null)[] {
  let order: 'mdy' | 'dmy' | null = null;
  for (const r of raws) {
    if (!r || r.iso) continue;
    if (r.a > 12) { order = 'dmy'; break; }
    if (r.b > 12) { order = 'mdy'; break; }
  }
  const refMs = reference ? Date.parse(`${reference.replace(' ', 'T')}:00Z`) : NaN;
  // Every stamp looks like 11/7: use the event's own date to pick the reading (Nov 7 vs July 11). Only
  // when exactly one reading falls within a fortnight before to a week after the event do we trust it.
  if (!order && Number.isFinite(refMs)) {
    const near = (mo: number, d: number, r: RawStamp) => {
      const y = r.c !== null ? (r.c < 100 ? 2000 + r.c : r.c) : new Date(refMs).getUTCFullYear();
      const t = Date.UTC(y, mo - 1, d, r.hh, r.mm);
      return t >= refMs - 14 * 86_400_000 && t <= refMs + 7 * 86_400_000;
    };
    for (const r of raws) {
      if (!r || r.iso || r.a === r.b) continue;
      const mdy = near(r.a, r.b, r);
      const dmy = near(r.b, r.a, r);
      if (mdy !== dmy) { order = mdy ? 'mdy' : 'dmy'; break; }
    }
  }
  return raws.map((r) => {
    if (!r) return null;
    let y: number, mo: number, d: number;
    if (r.iso) ({ y, m: mo, d } = r.iso);
    else {
      if (!order) return null;
      [mo, d] = order === 'mdy' ? [r.a, r.b] : [r.b, r.a];
      if (r.c !== null) y = r.c < 100 ? 2000 + r.c : r.c;
      else if (Number.isFinite(refMs)) {
        y = new Date(refMs).getUTCFullYear();
        if (Date.UTC(y, mo - 1, d, r.hh, r.mm) > refMs + 14 * 86_400_000) y -= 1;
      } else return null;
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || r.hh > 23 || r.mm > 59) return null;
    const out = `${y}-${pad(mo)}-${pad(d)}T${pad(r.hh)}:${pad(r.mm)}`;
    return Number.isNaN(Date.parse(`${out}:00Z`)) ? null : out;
  });
}

/** Splits "Name: text" lines (plain or WhatsApp-style); unlabeled lines continue the previous message. */
export function parseChat(chat: string, opts: { reference?: string } = {}): ChatMessage[] {
  const out: ChatMessage[] = [];
  const raws: (RawStamp | null)[] = [];
  for (const raw of chat.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = LINE.exec(line);
    if (m && m[3] && !/^\d+$/.test(m[3].trim())) {
      out.push({ author: m[3].trim(), text: (m[4] ?? '').trim(), at: null });
      raws.push(m[1] || m[2] ? rawStamp(m[1] ?? m[2] ?? '') : null);
    } else if (out.length) out[out.length - 1]!.text += ` ${line}`;
    else { out.push({ author: null, text: line, at: null }); raws.push(null); }
  }
  const stamps = resolveStamps(raws, opts.reference);
  out.forEach((msg, i) => { msg.at = stamps[i] ?? null; });
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

/** True if `evidence` (optionally prefixed "Name: ") is inside a message written by `author`. */
export function ownEvidence(messages: ChatMessage[], author: string, evidence: string): boolean {
  let e = norm(evidence);
  const prefix = `${norm(author)}:`;
  if (e.startsWith(prefix)) e = e.slice(prefix.length).trim();
  if (e.length < 1) return false;
  return messages.some((m) => m.author !== null && norm(m.author) === norm(author) && norm(m.text).includes(e));
}

/** The chat author a name refers to: exact match, or a first name that matches exactly one author. */
export function findAuthor(messages: ChatMessage[], name: string): string | null {
  const authors = new Map<string, string>();
  for (const m of messages) if (m.author) authors.set(norm(m.author), m.author);
  const key = norm(name);
  const exact = authors.get(key);
  if (exact) return exact;
  const first = [...authors.entries()].filter(([a]) => a.split(' ')[0] === key);
  return first.length === 1 ? first[0]![1] : null;
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
    // For someone who wrote in the chat, the quoted reply must come from THEIR OWN message, so the
    // model cannot credit one person with another person's "I'm in".
    const found = canonical ? ownEvidence(messages, canonical, g.evidence) : evidenceInChat(g.evidence);
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
