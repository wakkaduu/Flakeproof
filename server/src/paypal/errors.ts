export type PayPalErrorKind =
  | 'auth' // our credentials are wrong or expired
  | 'bad_request' // we sent something PayPal rejects (a bug on our side)
  | 'declined' // the buyer's funding source was refused
  | 'not_found'
  | 'conflict' // wrong state at PayPal: already captured, voided, etc.
  | 'insufficient_funds' // merchant balance cannot cover a payout
  | 'unavailable' // network, timeout, 5xx; safe to retry with the same request id
  | 'unexpected_response' // PayPal answered 2xx but not in the shape we verified
  | 'unknown';

const SAFE_MESSAGES: Record<PayPalErrorKind, string> = {
  auth: 'The payment service is misconfigured. Please tell the host.',
  bad_request: 'The payment service rejected the request. Please try again or tell the host.',
  declined: 'PayPal could not approve that payment method. Try a different one.',
  not_found: 'PayPal could not find that payment.',
  conflict: 'That payment is not in a state where this action is possible.',
  insufficient_funds: 'The host account does not have enough balance to send the payout.',
  unavailable: 'PayPal is not responding right now. Nothing was lost; please try again in a moment.',
  unexpected_response: 'PayPal returned something we could not verify, so we stopped. Nothing was changed.',
  unknown: 'Something went wrong with PayPal. Please try again.',
};

/** Carries diagnostic detail for logs; only `userMessage` may be shown to people. */
export class PayPalError extends Error {
  readonly userMessage: string;
  constructor(
    public readonly kind: PayPalErrorKind,
    message: string,
    public readonly detail: { httpStatus?: number; debugId?: string | undefined; issue?: string | undefined } = {},
  ) {
    super(message);
    this.name = 'PayPalError';
    this.userMessage = SAFE_MESSAGES[kind];
  }
  get retryable(): boolean {
    return this.kind === 'unavailable';
  }
}

const CONFLICT_ISSUES = new Set([
  'PREVIOUSLY_CAPTURED', 'AUTHORIZATION_ALREADY_CAPTURED', 'AUTHORIZATION_VOIDED', 'AUTHORIZATION_EXPIRED',
  'ORDER_ALREADY_AUTHORIZED', 'ORDER_ALREADY_CAPTURED', 'ORDER_NOT_APPROVED', 'DUPLICATE_INVOICE_ID',
  'MAX_CAPTURE_EXCEEDED', 'PREVIOUSLY_VOIDED',
]);

export function classifyHttpError(httpStatus: number, body: unknown, debugId?: string): PayPalError {
  const b = (body && typeof body === 'object' ? body : {}) as {
    name?: string; message?: string; details?: { issue?: string }[];
  };
  const issue = b.details?.[0]?.issue ?? b.name;
  const detail = { httpStatus, debugId, issue };
  const msg = `PayPal HTTP ${httpStatus}${b.name ? ` ${b.name}` : ''}${issue && issue !== b.name ? ` / ${issue}` : ''}`;
  if (httpStatus === 401 || httpStatus === 403) return new PayPalError('auth', msg, detail);
  if (httpStatus === 404) return new PayPalError('not_found', msg, detail);
  if (httpStatus === 429 || httpStatus >= 500) return new PayPalError('unavailable', msg, detail);
  if (b.name === 'INSUFFICIENT_FUNDS' || issue === 'INSUFFICIENT_FUNDS') return new PayPalError('insufficient_funds', msg, detail);
  if (issue === 'INSTRUMENT_DECLINED') return new PayPalError('declined', msg, detail);
  if (issue && CONFLICT_ISSUES.has(issue)) return new PayPalError('conflict', msg, detail);
  if (httpStatus === 409) return new PayPalError('conflict', msg, detail);
  if (httpStatus === 400 || httpStatus === 422) return new PayPalError('bad_request', msg, detail);
  return new PayPalError('unknown', msg, detail);
}
