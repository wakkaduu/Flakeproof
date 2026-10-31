// All money is integer cents. No floats anywhere in money logic.

export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError(`Invalid cents: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** Strict parse of PayPal money strings like "4.34". Rejects anything else. */
export function parseMoney(value: unknown): number {
  if (typeof value !== 'string') throw new TypeError(`Money must be a string, got ${typeof value}`);
  const m = /^(\d{1,9})\.(\d{2})$/.exec(value);
  if (!m) throw new TypeError(`Unexpected money format: ${JSON.stringify(value)}`);
  return Number(m[1]) * 100 + Number(m[2]);
}

export interface PayoutPlanInput {
  /** What PayPal actually netted from each capture, in cents (after PayPal's capture fee). */
  capturedNetCents: readonly number[];
  /** Attendees who get paid, in a stable order (the first ones receive any odd cents). */
  recipientIds: readonly string[];
  /** Estimated PayPal payout fee charged to the sender per item. */
  feePerItemCents: number;
  /** Below this per-person amount we do not pay out at all. */
  minPerPersonCents: number;
}

export type PayoutPlan =
  | {
      viable: true;
      potCents: number;
      feeReserveCents: number;
      distributableCents: number;
      items: { recipientId: string; amountCents: number }[];
    }
  | {
      viable: false;
      reason: 'no_capture' | 'no_recipients' | 'pot_too_small';
      potCents: number;
      feeReserveCents: number;
      distributableCents: number;
      items: [];
    };

/**
 * Pot rule A (decided by the owner): the pot is the sum of what PayPal actually netted from
 * the captures. Payout fees are charged to the sender on top of each item, so we reserve an
 * estimated fee per item out of the pot and split the rest equally. Odd cents go to the first
 * recipients, one each, so the items always sum to exactly the distributable amount.
 */
export function planPayout(input: PayoutPlanInput): PayoutPlan {
  const { capturedNetCents, recipientIds, feePerItemCents, minPerPersonCents } = input;
  for (const c of capturedNetCents) assertCents(c, 'capture net');
  assertCents(feePerItemCents, 'feePerItemCents');
  assertCents(minPerPersonCents, 'minPerPersonCents');
  if (new Set(recipientIds).size !== recipientIds.length) throw new Error('Duplicate recipient');

  const potCents = capturedNetCents.reduce((a, b) => a + b, 0);
  const n = recipientIds.length;
  const feeReserveCents = n * feePerItemCents;
  const distributableCents = Math.max(0, potCents - feeReserveCents);
  const nothing = (reason: 'no_capture' | 'no_recipients' | 'pot_too_small'): PayoutPlan => ({
    viable: false, reason, potCents, feeReserveCents, distributableCents, items: [],
  });

  if (capturedNetCents.length === 0 || potCents === 0) return nothing('no_capture');
  if (n === 0) return nothing('no_recipients');
  const base = Math.floor(distributableCents / n);
  if (base < minPerPersonCents || base < 1) return nothing('pot_too_small');

  const remainder = distributableCents - base * n;
  const items = recipientIds.map((recipientId, i) => ({
    recipientId,
    amountCents: base + (i < remainder ? 1 : 0),
  }));
  return { viable: true, potCents, feeReserveCents, distributableCents, items };
}

function assertCents(v: number, name: string): void {
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative integer, got ${v}`);
}

/**
 * ESTIMATE of what the merchant keeps from one captured deposit, used only to warn the host
 * before money moves. PayPal's real figure (seller_receivable_breakdown) is what the payout
 * uses. The fee model (3.49% + 49c) was observed on the sandbox at $5, $10; it is rounded UP so
 * the estimate errs low.
 */
export function estimateCaptureNet(depositCents: number, fee: { bps: number; fixedCents: number }): number {
  if (!Number.isSafeInteger(depositCents) || depositCents < 0) throw new RangeError(`Invalid cents: ${depositCents}`);
  const feeCents = Math.ceil((depositCents * fee.bps) / 10_000) + fee.fixedCents;
  return Math.max(0, depositCents - feeCents);
}
