// The only surface the rest of the app sees. Money is integer cents; PayPal's string
// amounts never leak past the real client. A fake implements the same interface.

export interface CreateOrderInput {
  /** Idempotency key derived from our own record id. */
  requestId: string;
  referenceId: string;
  description: string;
  amountCents: number;
  currency: string;
  returnUrl: string;
  cancelUrl: string;
}
export interface OrderCreated { orderId: string; status: string; approveUrl: string }

export interface OrderInfo { orderId: string; status: string; payerEmail: string | null }

export interface AuthorizedPayment {
  authorizationId: string;
  /** PayPal's authorization status; we require CREATED. */
  status: string;
  amountCents: number;
  currency: string;
  expiresAt: Date | null;
  payerEmail: string | null;
}

export interface CaptureInput {
  requestId: string;
  authorizationId: string;
  amountCents: number;
  currency: string;
  invoiceId: string;
}
export interface CaptureResult {
  captureId: string;
  /** PayPal's capture status; COMPLETED is the only success. */
  status: string;
  amountCents: number;
  currency: string;
  feeCents: number | null;
  /** What the merchant actually receives; only trustworthy when netCurrency === currency. */
  netCents: number | null;
  netCurrency: string | null;
}

export interface PayoutItemInput {
  senderItemId: string;
  receiverEmail: string;
  amountCents: number;
  note: string;
}
export interface CreatePayoutInput {
  requestId: string;
  senderBatchId: string;
  currency: string;
  emailSubject: string;
  items: PayoutItemInput[];
}
export interface PayoutBatchInfo {
  batchId: string;
  /** PayPal batch_status. NOT proof of delivery; read item statuses. */
  batchStatus: string;
  items: PayoutItemInfo[];
}
export interface PayoutItemInfo {
  senderItemId: string | null;
  payoutItemId: string;
  /** PayPal transaction_status. Only SUCCESS counts as paid. */
  status: string;
  feeCents: number | null;
  errorName: string | null;
}

export interface PayPalClient {
  createAuthorizeOrder(input: CreateOrderInput): Promise<OrderCreated>;
  getOrder(orderId: string): Promise<OrderInfo>;
  authorizeOrder(input: { requestId: string; orderId: string }): Promise<AuthorizedPayment>;
  captureAuthorization(input: CaptureInput): Promise<CaptureResult>;
  getCapture(captureId: string): Promise<CaptureResult>;
  voidAuthorization(input: { requestId: string; authorizationId: string }): Promise<void>;
  getAuthorizationStatus(authorizationId: string): Promise<string>;
  createPayout(input: CreatePayoutInput): Promise<{ batchId: string; batchStatus: string }>;
  getPayout(batchId: string): Promise<PayoutBatchInfo>;
}
