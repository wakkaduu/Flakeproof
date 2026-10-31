import { z } from 'zod';

export interface AppConfig {
  appBaseUrl: string;
  currency: string;
  payoutFeePerItemCents: number;
  minPayoutPerPersonCents: number;
  maxGuests: number;
  /** PayPal's recommended capture window after authorization. */
  honorPeriodDays: number;
  /** Observed sandbox capture fee, used only for the pre-settlement estimate. */
  captureFeeBps: number;
  captureFeeFixedCents: number;
  /** Events a client may create per minute. */
  eventsPerMinute: number;
  /** Longest chat we will send to the AI. */
  rsvpMaxChars: number;
  /** RSVP parses allowed per client per minute (the AI key has a small free quota). */
  rsvpPerMinute: number;
}

export const DEFAULT_CONFIG: AppConfig = {
  appBaseUrl: 'http://localhost:5173',
  currency: 'USD',
  // 25c/item is what the sandbox charged once at $5.00; the real fee is recorded after payout.
  payoutFeePerItemCents: 25,
  minPayoutPerPersonCents: 100,
  maxGuests: 12,
  honorPeriodDays: 3,
  captureFeeBps: 349,
  captureFeeFixedCents: 49,
  eventsPerMinute: 20,
  rsvpMaxChars: 8000,
  rsvpPerMinute: 10,
};

const int = (def: number) => z.coerce.number().int().nonnegative().default(def);

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  APP_BASE_URL: z.url().default(DEFAULT_CONFIG.appBaseUrl),
  DATABASE_URL: z.string().min(1).default('file:./dev.db'),
  PAYPAL_CLIENT_ID: z.string().min(1, 'PAYPAL_CLIENT_ID is required (sandbox)'),
  PAYPAL_CLIENT_SECRET: z.string().min(1, 'PAYPAL_CLIENT_SECRET is required (sandbox)'),
  PAYOUT_FEE_PER_ITEM_CENTS: int(DEFAULT_CONFIG.payoutFeePerItemCents),
  MIN_PAYOUT_PER_PERSON_CENTS: int(DEFAULT_CONFIG.minPayoutPerPersonCents),
  MAX_GUESTS: int(DEFAULT_CONFIG.maxGuests),
  // AI is optional: without a key the host adds guests by hand.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().trim().min(1).default('gemini-3.5-flash-lite'),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
  CAPTURE_FEE_BPS: int(DEFAULT_CONFIG.captureFeeBps),
  CAPTURE_FEE_FIXED_CENTS: int(DEFAULT_CONFIG.captureFeeFixedCents),
  EVENTS_PER_MINUTE: int(DEFAULT_CONFIG.eventsPerMinute),
  // Number of reverse-proxy hops to trust for the client IP (0 = none). Needed behind any host/proxy.
  TRUST_PROXY: int(0),
});

export function loadEnv(env: NodeJS.ProcessEnv) {
  const e = EnvSchema.parse(env);
  const config: AppConfig = {
    ...DEFAULT_CONFIG,
    appBaseUrl: e.APP_BASE_URL.replace(/\/$/, ''),
    payoutFeePerItemCents: e.PAYOUT_FEE_PER_ITEM_CENTS,
    minPayoutPerPersonCents: e.MIN_PAYOUT_PER_PERSON_CENTS,
    maxGuests: e.MAX_GUESTS,
    captureFeeBps: e.CAPTURE_FEE_BPS,
    captureFeeFixedCents: e.CAPTURE_FEE_FIXED_CENTS,
    eventsPerMinute: e.EVENTS_PER_MINUTE,
  };
  const key = e.GEMINI_API_KEY?.trim();
  const gemini = key ? { apiKey: key, model: e.GEMINI_MODEL, timeoutMs: e.AI_TIMEOUT_MS } : null;
  return { config, trustProxy: e.TRUST_PROXY, port: e.PORT, databaseUrl: e.DATABASE_URL, clientId: e.PAYPAL_CLIENT_ID, clientSecret: e.PAYPAL_CLIENT_SECRET, gemini };
}
