import { PayPalError } from './errors.js';
import type {
  AuthorizedPayment, CaptureInput, CaptureResult, CreateOrderInput, CreatePayoutInput,
  OrderCreated, OrderInfo, PayoutBatchInfo, PayPalClient,
} from './types.js';

/**
 * In-memory stand-in for PayPal, used by tests (and nothing else). It mimics the behaviours
 * we observed in the real sandbox: idempotent replays by request id, no void after capture,
 * capture fee of 3.49% + 49c, payout fee of 25c per item, payout item SUCCESS arriving later
 * than batch creation. It is NOT PayPal; anything it asserts must also hold in the sandbox.
 */
export type FakeMethod = keyof PayPalClient;

interface FakeOrder { id: string; amountCents: number; currency: string; status: 'CREATED' | 'PAYER_ACTION_REQUIRED' | 'APPROVED' | 'COMPLETED'; payerEmail: string | null; authorizationId?: string }
interface FakeAuth { id: string; amountCents: number; currency: string; status: 'CREATED' | 'CAPTURED' | 'VOIDED'; payerEmail: string | null }
interface FakePayoutItem { senderItemId: string; payoutItemId: string; receiver: string; amountCents: number; status: string }

export class FakePayPal implements PayPalClient {
  /** Every call made, in order, for assertions. */
  readonly calls: { method: FakeMethod; args: unknown }[] = [];
  readonly orders = new Map<string, FakeOrder>();
  readonly auths = new Map<string, FakeAuth>();
  readonly captures = new Map<string, CaptureResult & { authorizationId: string }>();
  readonly payouts = new Map<string, { batchId: string; status: string; currency: string; items: FakePayoutItem[] }>();
  /** Remaining merchant balance for payouts; null = unlimited. */
  payoutBalanceCents: number | null = null;
  /** Captures return this status instead of COMPLETED (to test PENDING handling). */
  nextCaptureStatus: string | null = null;
  /** Currency the merchant account actually holds; a mismatch reproduces the PHP incident. */
  merchantCurrency: string | null = null;

  private idem = new Map<string, unknown>();
  private failures = new Map<FakeMethod, PayPalError[]>();
  private seq = 0;

  failNext(method: FakeMethod, error: PayPalError, times = 1): void {
    this.failures.set(method, Array(times).fill(error) as PayPalError[]);
  }
  callsTo(method: FakeMethod): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  /** Test helper: the buyer approves on PayPal's page. */
  approveOrder(orderId: string, payerEmail = 'buyer@example.test'): void {
    const o = this.mustOrder(orderId);
    o.status = 'APPROVED';
    o.payerEmail = payerEmail;
  }
  /** Test helper: PayPal finishes processing payout items (they succeed later than creation). */
  completePayouts(status = 'SUCCESS'): void {
    for (const p of this.payouts.values()) {
      for (const it of p.items) if (it.status === 'PENDING') it.status = status;
      p.status = 'SUCCESS';
    }
  }

  private enter(method: FakeMethod, args: unknown): void {
    this.calls.push({ method, args });
    const q = this.failures.get(method);
    if (q && q.length) throw q.shift()!;
  }
  private once<T>(requestId: string, make: () => T): T {
    if (this.idem.has(requestId)) return this.idem.get(requestId) as T;
    const v = make();
    this.idem.set(requestId, v);
    return v;
  }
  private id(prefix: string): string { return `${prefix}${String(++this.seq).padStart(4, '0')}`; }
  private mustOrder(id: string): FakeOrder {
    const o = this.orders.get(id);
    if (!o) throw new PayPalError('not_found', 'fake: order not found');
    return o;
  }
  private mustAuth(id: string): FakeAuth {
    const a = this.auths.get(id);
    if (!a) throw new PayPalError('not_found', 'fake: authorization not found');
    return a;
  }
  private conflict(issue: string): PayPalError {
    return new PayPalError('conflict', `fake: ${issue}`, { issue, httpStatus: 422 });
  }

  async createAuthorizeOrder(i: CreateOrderInput): Promise<OrderCreated> {
    this.enter('createAuthorizeOrder', i);
    return this.once(i.requestId, () => {
      const id = this.id('ORDER');
      this.orders.set(id, { id, amountCents: i.amountCents, currency: i.currency, status: 'PAYER_ACTION_REQUIRED', payerEmail: null });
      return { orderId: id, status: 'PAYER_ACTION_REQUIRED', approveUrl: `https://fake.paypal.test/approve/${id}` };
    });
  }

  async getOrder(orderId: string): Promise<OrderInfo> {
    this.enter('getOrder', { orderId });
    const o = this.mustOrder(orderId);
    return { orderId, status: o.status, payerEmail: o.payerEmail };
  }

  async authorizeOrder(i: { requestId: string; orderId: string }): Promise<AuthorizedPayment> {
    this.enter('authorizeOrder', i);
    return this.once(i.requestId, () => {
      const o = this.mustOrder(i.orderId);
      if (o.status === 'COMPLETED') throw this.conflict('ORDER_ALREADY_AUTHORIZED');
      if (o.status !== 'APPROVED') throw this.conflict('ORDER_NOT_APPROVED');
      const a: FakeAuth = { id: this.id('AUTH'), amountCents: o.amountCents, currency: o.currency, status: 'CREATED', payerEmail: o.payerEmail };
      this.auths.set(a.id, a);
      o.status = 'COMPLETED';
      o.authorizationId = a.id;
      return {
        authorizationId: a.id, status: 'CREATED', amountCents: a.amountCents, currency: a.currency,
        expiresAt: new Date(Date.now() + 29 * 86_400_000), payerEmail: a.payerEmail,
      };
    });
  }

  async captureAuthorization(i: CaptureInput): Promise<CaptureResult> {
    this.enter('captureAuthorization', i);
    return this.once(i.requestId, () => {
      const a = this.mustAuth(i.authorizationId);
      if (a.status === 'CAPTURED') throw this.conflict('AUTHORIZATION_ALREADY_CAPTURED');
      if (a.status === 'VOIDED') throw this.conflict('AUTHORIZATION_VOIDED');
      if (i.amountCents > a.amountCents) throw this.conflict('MAX_CAPTURE_EXCEEDED');
      const fee = Math.round(i.amountCents * 0.0349) + 49;
      const status = this.nextCaptureStatus ?? 'COMPLETED';
      this.nextCaptureStatus = null;
      a.status = 'CAPTURED';
      const c = {
        captureId: this.id('CAP'), status, amountCents: i.amountCents, currency: i.currency,
        feeCents: fee, netCents: i.amountCents - fee, netCurrency: this.merchantCurrency ?? i.currency,
        authorizationId: a.id,
      };
      this.captures.set(c.captureId, c);
      return c;
    });
  }

  async getCapture(captureId: string): Promise<CaptureResult> {
    this.enter('getCapture', { captureId });
    const c = this.captures.get(captureId);
    if (!c) throw new PayPalError('not_found', 'fake: capture not found');
    // A pending capture resolves the next time somebody looks.
    if (c.status === 'PENDING') c.status = 'COMPLETED';
    return c;
  }

  async voidAuthorization(i: { requestId: string; authorizationId: string }): Promise<void> {
    this.enter('voidAuthorization', i);
    this.once(i.requestId, () => {
      const a = this.mustAuth(i.authorizationId);
      if (a.status === 'CAPTURED') throw this.conflict('PREVIOUSLY_CAPTURED');
      a.status = 'VOIDED';
      return true;
    });
  }

  async getAuthorizationStatus(authorizationId: string): Promise<string> {
    this.enter('getAuthorizationStatus', { authorizationId });
    return this.mustAuth(authorizationId).status;
  }

  async createPayout(i: CreatePayoutInput): Promise<{ batchId: string; batchStatus: string }> {
    this.enter('createPayout', i);
    return this.once(i.requestId, () => {
      if (this.merchantCurrency && this.merchantCurrency !== i.currency) {
        throw new PayPalError('insufficient_funds', 'fake: no balance in payout currency', { issue: 'INSUFFICIENT_FUNDS', httpStatus: 422 });
      }
      const total = i.items.reduce((s, it) => s + it.amountCents + 25, 0);
      if (this.payoutBalanceCents !== null) {
        if (total > this.payoutBalanceCents) {
          throw new PayPalError('insufficient_funds', 'fake: INSUFFICIENT_FUNDS', { issue: 'INSUFFICIENT_FUNDS', httpStatus: 422 });
        }
        this.payoutBalanceCents -= total;
      }
      const batchId = this.id('PAYOUT');
      this.payouts.set(batchId, {
        batchId, status: 'PROCESSING', currency: i.currency,
        items: i.items.map((it) => ({
          senderItemId: it.senderItemId, payoutItemId: this.id('ITEM'), receiver: it.receiverEmail,
          amountCents: it.amountCents, status: 'PENDING',
        })),
      });
      return { batchId, batchStatus: 'PENDING' };
    });
  }

  async getPayout(batchId: string): Promise<PayoutBatchInfo> {
    this.enter('getPayout', { batchId });
    const p = this.payouts.get(batchId);
    if (!p) throw new PayPalError('not_found', 'fake: payout not found');
    return {
      batchId, batchStatus: p.status,
      items: p.items.map((it) => ({
        senderItemId: it.senderItemId, payoutItemId: it.payoutItemId, status: it.status,
        feeCents: it.status === 'SUCCESS' ? 25 : null, errorName: null,
      })),
    };
  }
}
