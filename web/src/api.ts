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

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
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

export interface HostApi {
  parseRsvp(chat: string, timeZone: string): Promise<RsvpProposal>;
  createEvent(body: CreateEventBody): Promise<CreatedEvent>;
}

export const hostApi: HostApi = {
  parseRsvp: (chat, timeZone) => request('POST', '/api/rsvp/parse', { chat, timeZone }),
  createEvent: (body) => request('POST', '/api/events', body),
};
