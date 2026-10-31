import { z } from 'zod';
import { formatCents, parseMoney } from '../domain/money.js';
import { classifyHttpError, PayPalError } from './errors.js';
import type {
  AuthorizedPayment, CaptureInput, CaptureResult, CreateOrderInput, CreatePayoutInput,
  OrderCreated, OrderInfo, PayoutBatchInfo, PayPalClient,
} from './types.js';

/** SANDBOX ONLY. There is deliberately no way to configure a live host. */
export const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';

export interface RealClientOptions {
  clientId: string;
  clientSecret: string;
  /** Tests only: must be loopback. Anything else is refused. */
  baseUrlForTests?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

const Money = z.object({ currency_code: z.string(), value: z.string() });
const PayoutMoney = z.object({ currency: z.string(), value: z.string() });
const Link = z.object({ rel: z.string(), href: z.string() });

const OrderSchema = z.object({
  id: z.string(),
  status: z.string(),
  links: z.array(Link).optional(),
  payer: z.object({ email_address: z.string().optional() }).optional(),
});
const AuthorizeSchema = z.object({
  payer: z.object({ email_address: z.string().optional() }).optional(),
  purchase_units: z.array(z.object({
    payments: z.object({
      authorizations: z.array(z.object({
        id: z.string(), status: z.string(), amount: Money, expiration_time: z.string().optional(),
      })).min(1),
    }),
  })).min(1),
});
const CaptureSchema = z.object({
  id: z.string(),
  status: z.string(),
  amount: Money,
  seller_receivable_breakdown: z.object({
    paypal_fee: Money.optional(),
    net_amount: Money.optional(),
  }).optional(),
});
const AuthStatusSchema = z.object({ status: z.string() });
const PayoutCreatedSchema = z.object({
  batch_header: z.object({ payout_batch_id: z.string(), batch_status: z.string() }),
});
const PayoutBatchSchema = z.object({
  batch_header: z.object({ payout_batch_id: z.string(), batch_status: z.string() }),
  items: z.array(z.object({
    payout_item_id: z.string(),
    transaction_status: z.string(),
    payout_item_fee: PayoutMoney.optional(),
    payout_item: z.object({ sender_item_id: z.string().optional() }).optional(),
    errors: z.object({ name: z.string().optional() }).optional(),
  })).optional(),
});

/** The approval link is sent to a person's browser: refuse anything that is not https on paypal.com. */
export function safeApprovalUrl(href: string): string {
  let url: URL;
  try { url = new URL(href); } catch { throw new PayPalError('unexpected_response', 'Approval link is not a valid URL'); }
  const hostOk = url.hostname === 'paypal.com' || url.hostname.endsWith('.paypal.com');
  if (url.protocol !== 'https:' || !hostOk) throw new PayPalError('unexpected_response', `Approval link has unexpected host ${url.hostname}`);
  return url.toString();
}

/** Fee/net are advisory. If PayPal sends something we cannot parse after money moved, say "unknown", don't fail the capture. */
function tryMoney(m: { value: string } | undefined): number | null {
  if (!m) return null;
  try { return parseMoney(m.value); } catch { return null; }
}

export class RealPayPalClient implements PayPalClient {
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private token: { value: string; expiresAt: number } | null = null;
  private tokenInFlight: Promise<string> | null = null;

  constructor(private readonly opts: RealClientOptions) {
    if (!opts.clientId || !opts.clientSecret) throw new Error('PayPal sandbox client id and secret are required');
    this.base = SANDBOX_BASE_URL;
    if (opts.baseUrlForTests) {
      const host = new URL(opts.baseUrlForTests).hostname;
      if (host !== 'localhost' && host !== '127.0.0.1') throw new Error('baseUrlForTests must be loopback');
      this.base = opts.baseUrlForTests.replace(/\/$/, '');
    }
    this.doFetch = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 300;
  }

  // ---- auth -------------------------------------------------------------

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    this.tokenInFlight ??= this.fetchToken().finally(() => { this.tokenInFlight = null; });
    return this.tokenInFlight;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64');
    const res = await this.rawFetch('/v1/oauth2/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      // Any failure to get a token is our credentials or PayPal being down; never echo the body.
      throw res.status >= 500 ? classifyHttpError(res.status, res.body, res.debugId)
        : new PayPalError('auth', `OAuth failed: HTTP ${res.status}`, { httpStatus: res.status, debugId: res.debugId });
    }
    const parsed = z.object({ access_token: z.string(), expires_in: z.number() }).safeParse(res.body);
    if (!parsed.success) throw new PayPalError('unexpected_response', 'OAuth response malformed');
    this.token = { value: parsed.data.access_token, expiresAt: Date.now() + parsed.data.expires_in * 1000 };
    return this.token.value;
  }

  // ---- transport --------------------------------------------------------

  private async rawFetch(path: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: unknown; debugId: string | undefined }> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.base}${path}`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new PayPalError('unavailable', `Network error calling PayPal: ${(e as Error).name}`);
    }
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
    }
    return { ok: res.ok, status: res.status, body, debugId: res.headers.get('paypal-debug-id') ?? undefined };
  }

  /** Calls PayPal, retrying only transient failures. Mutations MUST carry a requestId so a retry cannot double-act. */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; requestId?: string; prefer?: boolean; schema?: z.ZodType<T> | undefined; okStatuses?: number[] },
  ): Promise<T | null> {
    if (method === 'POST' && !opts.requestId) throw new Error('POST to PayPal requires a requestId');
    const okStatuses = opts.okStatuses ?? [200, 201];
    for (let attempt = 0; ; attempt++) {
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${await this.accessToken()}`,
          'Content-Type': 'application/json',
        };
        if (opts.requestId) headers['PayPal-Request-Id'] = opts.requestId;
        if (opts.prefer) headers.Prefer = 'return=representation';
        const res = await this.rawFetch(path, {
          method,
          headers,
          ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
        });
        if (res.status === 401 && attempt === 0) { this.token = null; throw new PayPalError('unavailable', 'token rejected, refreshing'); }
        if (!okStatuses.includes(res.status)) throw classifyHttpError(res.status, res.body, res.debugId);
        if (!opts.schema) return null;
        const parsed = opts.schema.safeParse(res.body);
        if (!parsed.success) {
          throw new PayPalError('unexpected_response', `Unexpected response from ${method} ${path}`, { httpStatus: res.status, debugId: res.debugId });
        }
        return parsed.data;
      } catch (e) {
        if (e instanceof PayPalError && e.retryable && attempt < this.maxRetries) {
          await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** attempt));
          continue;
        }
        throw e;
      }
    }
  }

  private async need<T>(...args: Parameters<RealPayPalClient['request']>): Promise<T> {
    const r = await this.request(...args);
    if (r === null) throw new PayPalError('unexpected_response', 'Empty response');
    return r as T;
  }

  // ---- orders -----------------------------------------------------------

  async createAuthorizeOrder(i: CreateOrderInput): Promise<OrderCreated> {
    const o = await this.need<z.infer<typeof OrderSchema>>('POST', '/v2/checkout/orders', {
      requestId: i.requestId,
      schema: OrderSchema,
      body: {
        intent: 'AUTHORIZE',
        purchase_units: [{
          reference_id: i.referenceId,
          description: i.description,
          amount: { currency_code: i.currency, value: formatCents(i.amountCents) },
        }],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: 'Flakeproof',
              shipping_preference: 'NO_SHIPPING',
              user_action: 'PAY_NOW',
              return_url: i.returnUrl,
              cancel_url: i.cancelUrl,
            },
          },
        },
      },
    });
    const link = o.links?.find((l) => l.rel === 'payer-action') ?? o.links?.find((l) => l.rel === 'approve');
    if (!link) throw new PayPalError('unexpected_response', 'Order has no approval link');
    return { orderId: o.id, status: o.status, approveUrl: safeApprovalUrl(link.href) };
  }

  async getOrder(orderId: string): Promise<OrderInfo> {
    const o = await this.need<z.infer<typeof OrderSchema>>('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`, { schema: OrderSchema });
    return { orderId: o.id, status: o.status, payerEmail: o.payer?.email_address ?? null };
  }

  async authorizeOrder(i: { requestId: string; orderId: string }): Promise<AuthorizedPayment> {
    const r = await this.need<z.infer<typeof AuthorizeSchema>>('POST', `/v2/checkout/orders/${encodeURIComponent(i.orderId)}/authorize`, {
      requestId: i.requestId, prefer: true, body: {}, schema: AuthorizeSchema,
    });
    const a = r.purchase_units[0]!.payments.authorizations[0]!;
    return {
      authorizationId: a.id,
      status: a.status,
      amountCents: parseMoney(a.amount.value),
      currency: a.amount.currency_code,
      expiresAt: a.expiration_time ? new Date(a.expiration_time) : null,
      payerEmail: r.payer?.email_address ?? null,
    };
  }

  // ---- payments ---------------------------------------------------------

  private toCapture(c: z.infer<typeof CaptureSchema>): CaptureResult {
    const b = c.seller_receivable_breakdown;
    return {
      captureId: c.id,
      status: c.status,
      amountCents: parseMoney(c.amount.value),
      currency: c.amount.currency_code,
      feeCents: tryMoney(b?.paypal_fee),
      netCents: tryMoney(b?.net_amount),
      netCurrency: b?.net_amount?.currency_code ?? null,
    };
  }

  async captureAuthorization(i: CaptureInput): Promise<CaptureResult> {
    const c = await this.need<z.infer<typeof CaptureSchema>>('POST', `/v2/payments/authorizations/${encodeURIComponent(i.authorizationId)}/capture`, {
      requestId: i.requestId, prefer: true, schema: CaptureSchema,
      body: {
        amount: { currency_code: i.currency, value: formatCents(i.amountCents) },
        final_capture: true,
        invoice_id: i.invoiceId,
      },
    });
    return this.toCapture(c);
  }

  async getCapture(captureId: string): Promise<CaptureResult> {
    const c = await this.need<z.infer<typeof CaptureSchema>>('GET', `/v2/payments/captures/${encodeURIComponent(captureId)}`, { schema: CaptureSchema });
    return this.toCapture(c);
  }

  async voidAuthorization(i: { requestId: string; authorizationId: string }): Promise<void> {
    await this.request('POST', `/v2/payments/authorizations/${encodeURIComponent(i.authorizationId)}/void`, {
      requestId: i.requestId, okStatuses: [200, 204],
    });
  }

  async getAuthorizationStatus(authorizationId: string): Promise<string> {
    const a = await this.need<z.infer<typeof AuthStatusSchema>>('GET', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`, { schema: AuthStatusSchema });
    return a.status;
  }

  // ---- payouts ----------------------------------------------------------

  async createPayout(i: CreatePayoutInput): Promise<{ batchId: string; batchStatus: string }> {
    const r = await this.need<z.infer<typeof PayoutCreatedSchema>>('POST', '/v1/payments/payouts', {
      requestId: i.requestId, schema: PayoutCreatedSchema,
      body: {
        sender_batch_header: { sender_batch_id: i.senderBatchId, email_subject: i.emailSubject },
        items: i.items.map((it) => ({
          recipient_type: 'EMAIL',
          receiver: it.receiverEmail,
          amount: { currency: i.currency, value: formatCents(it.amountCents) },
          note: it.note,
          sender_item_id: it.senderItemId,
        })),
      },
    });
    return { batchId: r.batch_header.payout_batch_id, batchStatus: r.batch_header.batch_status };
  }

  async getPayout(batchId: string): Promise<PayoutBatchInfo> {
    const r = await this.need<z.infer<typeof PayoutBatchSchema>>('GET', `/v1/payments/payouts/${encodeURIComponent(batchId)}`, { schema: PayoutBatchSchema });
    return {
      batchId: r.batch_header.payout_batch_id,
      batchStatus: r.batch_header.batch_status,
      items: (r.items ?? []).map((it) => ({
        senderItemId: it.payout_item?.sender_item_id ?? null,
        payoutItemId: it.payout_item_id,
        status: it.transaction_status,
        feeCents: tryMoney(it.payout_item_fee),
        errorName: it.errors?.name ?? null,
      })),
    };
  }
}
