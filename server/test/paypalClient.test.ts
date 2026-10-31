import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RealPayPalClient } from '../src/paypal/client.js';
import { PayPalError } from '../src/paypal/errors.js';

/** A tiny local HTTP server speaking PayPal's JSON shapes (as observed in the real sandbox). */
let server: http.Server;
let base: string;
let seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[];
let handler: (req: { method: string; url: string; body: string }, res: http.ServerResponse) => void;
let tokenCalls: number;

beforeEach(async () => {
  seen = []; tokenCalls = 0;
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      if (req.url === '/v1/oauth2/token') {
        tokenCalls++;
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      }
      handler({ method: req.method!, url: req.url!, body }, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

const client = (extra = {}) =>
  new RealPayPalClient({ clientId: 'id', clientSecret: 'secret', baseUrlForTests: base, retryDelayMs: 1, ...extra });
const json = (res: http.ServerResponse, status: number, body: unknown, debug = 'dbg1') => {
  res.writeHead(status, { 'content-type': 'application/json', 'paypal-debug-id': debug });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

describe('RealPayPalClient', () => {
  it('refuses a non-loopback test base URL (no way to reach a live host)', () => {
    expect(() => new RealPayPalClient({ clientId: 'a', clientSecret: 'b', baseUrlForTests: 'https://api-m.paypal.com' })).toThrow();
  });

  it('creates an authorize order, sends request id, caches the token', async () => {
    handler = (_r, res) => json(res, 200, { id: 'O1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'self', href: 'x' }, { rel: 'payer-action', href: 'https://pp/approve' }] });
    const c = client();
    const input = { requestId: 'showup-order-d1', referenceId: 'd1', description: 'Deposit', amountCents: 2000, currency: 'USD', returnUrl: 'https://app/r', cancelUrl: 'https://app/c' };
    const o = await c.createAuthorizeOrder(input);
    await c.createAuthorizeOrder(input);
    expect(o).toEqual({ orderId: 'O1', status: 'PAYER_ACTION_REQUIRED', approveUrl: 'https://pp/approve' });
    expect(tokenCalls).toBe(1);
    const post = seen.find((s) => s.url === '/v2/checkout/orders')!;
    expect(post.headers['paypal-request-id']).toBe('showup-order-d1');
    expect(post.headers.authorization).toBe('Bearer tok');
    const body = JSON.parse(post.body);
    expect(body.intent).toBe('AUTHORIZE');
    expect(body.purchase_units[0].amount).toEqual({ currency_code: 'USD', value: '20.00' });
  });

  it('parses an authorization and the payer email into cents', async () => {
    handler = (_r, res) => json(res, 201, {
      status: 'COMPLETED', payer: { email_address: 'b@x.test' },
      purchase_units: [{ payments: { authorizations: [{ id: 'A1', status: 'CREATED', amount: { currency_code: 'USD', value: '20.00' }, expiration_time: '2026-11-29T05:11:17Z' }] } }],
    });
    const a = await client().authorizeOrder({ requestId: 'k', orderId: 'O1' });
    expect(a).toMatchObject({ authorizationId: 'A1', status: 'CREATED', amountCents: 2000, currency: 'USD', payerEmail: 'b@x.test' });
    expect(a.expiresAt?.toISOString()).toBe('2026-11-29T05:11:17.000Z');
  });

  it('parses capture fee and net, including a net in another currency', async () => {
    handler = (_r, res) => json(res, 201, {
      id: 'C1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '5.00' },
      seller_receivable_breakdown: { paypal_fee: { currency_code: 'USD', value: '0.47' }, net_amount: { currency_code: 'PHP', value: '279.41' } },
    });
    const c = await client().captureAuthorization({ requestId: 'k', authorizationId: 'A1', amountCents: 500, currency: 'USD', invoiceId: 'i' });
    expect(c).toMatchObject({ captureId: 'C1', status: 'COMPLETED', amountCents: 500, feeCents: 47, netCents: 27941, netCurrency: 'PHP' });
  });

  it('treats void 204 as success', async () => {
    handler = (_r, res) => { res.writeHead(204); res.end(); };
    await expect(client().voidAuthorization({ requestId: 'k', authorizationId: 'A1' })).resolves.toBeUndefined();
  });

  it('maps PayPal errors to typed errors with safe user messages', async () => {
    handler = (_r, res) => json(res, 422, { name: 'UNPROCESSABLE_ENTITY', message: 'secret internal text', details: [{ issue: 'PREVIOUSLY_CAPTURED' }] }, 'dbgX');
    const e = await client().voidAuthorization({ requestId: 'k', authorizationId: 'A1' }).catch((x) => x);
    expect(e).toBeInstanceOf(PayPalError);
    expect(e.kind).toBe('conflict');
    expect(e.detail).toMatchObject({ httpStatus: 422, issue: 'PREVIOUSLY_CAPTURED', debugId: 'dbgX' });
    expect(e.userMessage).not.toContain('secret internal text');
  });

  it('maps insufficient funds on payouts', async () => {
    handler = (_r, res) => json(res, 422, { name: 'INSUFFICIENT_FUNDS', message: 'Sender does not have sufficient funds.' });
    const e = await client().createPayout({ requestId: 'k', senderBatchId: 's', currency: 'USD', emailSubject: 'x', items: [{ senderItemId: 'i', receiverEmail: 'r@x.test', amountCents: 500, note: 'n' }] }).catch((x) => x);
    expect(e.kind).toBe('insufficient_funds');
  });

  it('retries transient 5xx with the same request id, then succeeds', async () => {
    let n = 0;
    handler = (_r, res) => (++n < 3 ? json(res, 503, { name: 'SERVICE_UNAVAILABLE' }) : json(res, 200, { status: 'VOIDED' }));
    const s = await client().getAuthorizationStatus('A1');
    expect(s).toBe('VOIDED');
    expect(n).toBe(3);
  });

  it('gives up after maxRetries and reports unavailable', async () => {
    handler = (_r, res) => json(res, 503, {});
    const e = await client({ maxRetries: 1 }).getAuthorizationStatus('A1').catch((x) => x);
    expect(e.kind).toBe('unavailable');
    expect(seen.filter((s) => s.url.includes('/authorizations/')).length).toBe(2);
  });

  it('does not retry client errors', async () => {
    handler = (_r, res) => json(res, 404, { name: 'RESOURCE_NOT_FOUND' });
    const e = await client().getOrder('nope').catch((x) => x);
    expect(e.kind).toBe('not_found');
    expect(seen.filter((s) => s.url.includes('/orders/')).length).toBe(1);
  });

  it('refuses a 2xx that does not match the verified shape', async () => {
    handler = (_r, res) => json(res, 200, { surprise: true });
    const e = await client().getAuthorizationStatus('A1').catch((x) => x);
    expect(e.kind).toBe('unexpected_response');
  });

  it('reports bad credentials as auth without echoing the response', async () => {
    server.removeAllListeners('request');
    server.on('request', (_q, res) => json(res, 401, { error: 'invalid_client', error_description: 'Client Authentication failed' }));
    const e = await client().getOrder('x').catch((x) => x);
    expect(e.kind).toBe('auth');
    expect(e.message).not.toContain('Client Authentication failed');
  });

  it('reads payout item statuses, fee and sender item id', async () => {
    handler = (_r, res) => json(res, 200, {
      batch_header: { payout_batch_id: 'B1', batch_status: 'PROCESSING' },
      items: [{ payout_item_id: 'PI1', transaction_status: 'SUCCESS', payout_item_fee: { currency: 'USD', value: '0.25' }, payout_item: { sender_item_id: 'pi_local' } }],
    });
    const p = await client().getPayout('B1');
    expect(p.batchStatus).toBe('PROCESSING');
    expect(p.items[0]).toEqual({ senderItemId: 'pi_local', payoutItemId: 'PI1', status: 'SUCCESS', feeCents: 25, errorName: null });
  });
});
