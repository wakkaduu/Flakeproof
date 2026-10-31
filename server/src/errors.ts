import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { AiError } from './ai/types.js';
import { IllegalTransitionError } from './domain/stateMachine.js';
import { PayPalError } from './paypal/errors.js';

/** An error whose message is safe to show to the person who triggered it. */
export class AppError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'AppError';
  }
}
export const notFound = (what = 'Not found') => new AppError(404, 'not_found', what);
export const conflict = (code: string, message: string) => new AppError(409, code, message);

const PAYPAL_STATUS: Record<string, number> = {
  auth: 500, bad_request: 502, declined: 402, not_found: 502, conflict: 409,
  insufficient_funds: 409, unavailable: 503, unexpected_response: 502, unknown: 502,
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'The request was not valid.', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
    return;
  }
  if (err instanceof PayPalError) {
    // Log diagnostics (never secrets); show only the safe message.
    console.error(`[paypal] ${err.kind} ${err.message} debugId=${err.detail.debugId ?? '-'} issue=${err.detail.issue ?? '-'}`);
    res.status(PAYPAL_STATUS[err.kind] ?? 502).json({ error: { code: `paypal_${err.kind}`, message: err.userMessage } });
    return;
  }
  if (err instanceof AiError) {
    console.error(`[ai] ${err.kind} ${err.message}`); // never the chat text
    const status = { not_configured: 503, misconfigured: 502, unavailable: 503, invalid_output: 502, blocked: 422 }[err.kind];
    res.status(status).json({ error: { code: `ai_${err.kind}`, message: err.userMessage } });
    return;
  }
  if (err instanceof IllegalTransitionError) {
    console.error(`[state] ${err.message}`);
    res.status(409).json({ error: { code: 'illegal_transition', message: 'That action is not possible in the current state.' } });
    return;
  }
  if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'invalid_json', message: 'The request body is not valid JSON.' } });
    return;
  }
  console.error('[server] unexpected error', err instanceof Error ? err.stack : err);
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong on our side.' } });
};
