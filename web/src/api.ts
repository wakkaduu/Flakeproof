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

async function request<T>(method: 'GET' | 'POST', path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method, headers: { Accept: 'application/json' } });
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the server. Check your connection and try again.');
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? 'Something went wrong. Please try again.');
  }
  return body as T;
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
