// Typed client for the Flakeproof server. The server decides every amount; the browser only
// ever sends "start" and "confirm", never a price.

export type GuestStage = 'invited' | 'authorized' | 'showed' | 'no_show' | 'voided' | 'captured' | 'paid_out';

export interface GuestView {
  guestName: string;
  event: { title: string; startsAt: string; depositCents: number; currency: string; status: 'open' | 'ended' | 'settled' };
  stage: GuestStage;
  depositStatus: 'pending' | 'authorized' | 'capture_pending' | 'captured' | 'voided' | null;
  outcome: { kind: 'none' | 'held' | 'nothing_charged' | 'charged' | 'received'; amountCents?: number };
  share: { amountCents: number; status: string } | null;
  canApprove: boolean;
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the server. Check your connection and try again.');
  }
  let payload: unknown = null;
  try { payload = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    const e = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? 'Something went wrong. Please try again.');
  }
  return payload as T;
}

export interface GuestApi {
  getGuest(token: string): Promise<GuestView>;
  startDeposit(token: string): Promise<{ approveUrl: string }>;
  authorize(token: string): Promise<GuestView>;
}

const enc = encodeURIComponent;
export const guestApi: GuestApi = {
  getGuest: (t) => request('GET', `/api/g/${enc(t)}`),
  startDeposit: (t) => request('POST', `/api/g/${enc(t)}/deposit`),
  authorize: (t) => request('POST', `/api/g/${enc(t)}/authorize`),
};

// ---- host side: read a pasted chat, then create the event ----------------------------------

/** What the server proposes after reading a chat. Every guest/amount/time was verified against the chat. */
export interface RsvpProposal {
  organizer: string | null;
  title: string | null;
  /** Local wall-clock "YYYY-MM-DDTHH:mm" in the host's time zone, or null when unclear. */
  startsAtLocal: string | null;
  depositCents: number | null;
  guests: { name: string; rsvp: 'in' | 'maybe' | 'out'; source: 'author' | 'mentioned'; evidence: string; downgraded: boolean }[];
  questions: string[];
  notes: string[];
}

export interface CreateEventBody {
  title: string;
  startsAt: string; // ISO with offset
  depositCents: number;
  guests: { name: string }[];
}

export interface CreatedEvent {
  hostToken: string;
  hostUrl: string;
  event: { id: string; title: string; warnings: string[]; guests: { id: string; name: string; inviteUrl: string }[] };
}

/** One message read from a screenshot (server/src/ai/transcribe.ts: ShotMessage). */
export interface ShotMessage {
  author: string | null;
  fromHost: boolean;
  kind: 'text' | 'photo' | 'date';
  text: string;
  time: string | null;
}
/** A screenshot shrunk on the device: base64 JPEG, no "data:" prefix. */
export interface ShotImage { mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; data: string }
/** The transcript made from all screenshots, one "[Day time] Name: text" line per message. */
export interface Assembled { chat: string; messageCount: number; warnings: string[]; unknownCount: number }

export interface HostApi {
  parseRsvp(chat: string, timeZone: string): Promise<RsvpProposal>;
  createEvent(body: CreateEventBody): Promise<CreatedEvent>;
  /** AI: reads ONE screenshot. The image is not stored. */
  readShot(image: ShotImage): Promise<{ messages: ShotMessage[] }>;
  /** No AI: merges the messages read from the screenshots (oldest first) into one transcript. */
  assembleShots(shots: ShotMessage[][], hostName: string): Promise<Assembled>;
}

export const hostApi: HostApi = {
  parseRsvp: (chat, timeZone) => request('POST', '/api/rsvp/parse', { chat, timeZone }),
  createEvent: (body) => request('POST', '/api/events', body),
  readShot: (image) => request('POST', '/api/rsvp/screenshot', image),
  assembleShots: (shots, hostName) => request('POST', '/api/rsvp/transcript', { shots, hostName }),
};

// ---- host dashboard ---------------------------------------------------------------------------
// Mirrors GET /api/host/:token/event (server/src/services/events.ts: hostView). Money is integer cents.

export type Attendance = 'unknown' | 'showed' | 'no_show';
export type Decision = 'capture' | 'forgive';

export interface HostGuest {
  id: string;
  name: string;
  inviteUrl: string;
  attendance: Attendance;
  /** The host's own choice. Always null until the host picks; the AI never fills it in. */
  decision: Decision | null;
  /** The AI's verified suggestion (audit only), or null. */
  ai: { recommendation: 'capture' | 'forgive' | 'unclear'; reason: string; evidence: string | null; flag: 'addresses_the_ai' | null; minutesBeforeStart: number | null } | null;
  stage: GuestStage;
  deposit: { status: 'pending' | 'authorized' | 'capture_pending' | 'captured' | 'voided'; amountCents: number; feeCents: number | null; netCents: number | null; payerEmail: string | null } | null;
  payout: { amountCents: number; status: string; feeCents: number | null } | null;
}

export interface PayoutPreview {
  provisional: boolean;
  capturingCount: number;
  recipientCount: number;
  estimatedPotCents: number;
  estimatedPerPersonCents: number | null;
  problem: 'no_recipients' | 'pot_too_small' | null;
  unpayableNames: string[];
}

export interface HostView {
  id: string;
  title: string;
  startsAt: string;
  depositCents: number;
  currency: string;
  status: 'open' | 'ended' | 'settled';
  /** Excuses sent at least this long before the start count as timely: a fact shown to the host, not a rule that decides. */
  graceMinutes: number;
  settlementApproved: boolean;
  canSettle: boolean;
  blockers: string[];
  warnings: string[];
  problems: string[];
  guests: HostGuest[];
  payoutPreview: PayoutPreview | null;
  payout: { status: string; skippedReason: string | null; potCents: number; feeReserveCents: number; distributableCents: number; actualFeesCents: number | null } | null;
}

export interface HostDashboardApi {
  getEvent(token: string): Promise<HostView>;
  end(token: string): Promise<HostView>;
  setAttendance(token: string, guestId: string, attendance: 'showed' | 'no_show'): Promise<HostView>;
  setDecision(token: string, guestId: string, decision: Decision): Promise<HostView>;
  judge(token: string, chat: string, timeZone: string): Promise<HostView>;
  /** The explicit approval. Safe to call again to resume or refresh payout status. */
  settle(token: string): Promise<HostView>;
}

export const hostDashboardApi: HostDashboardApi = {
  getEvent: (t) => request('GET', `/api/host/${enc(t)}/event`),
  end: (t) => request('POST', `/api/host/${enc(t)}/end`, {}),
  setAttendance: (t, g, attendance) => request('PUT', `/api/host/${enc(t)}/guests/${enc(g)}/attendance`, { attendance }),
  setDecision: (t, g, decision) => request('PUT', `/api/host/${enc(t)}/guests/${enc(g)}/decision`, { decision }),
  judge: (t, chat, timeZone) => request('POST', `/api/host/${enc(t)}/judge`, { chat, timeZone }),
  settle: (t) => request('POST', `/api/host/${enc(t)}/settle`, { approve: true }),
};
