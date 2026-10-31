import { z } from 'zod';

export interface AppConfig {
  appBaseUrl: string;
  currency: string;
  payoutFeePerItemCents: number;
  minPayoutPerPersonCents: number;
  maxGuests: number;
  /** PayPal's recommended capture window after authorization. */
  honorPeriodDays: number;
}

export const DEFAULT_CONFIG: AppConfig = {
  appBaseUrl: 'http://localhost:5173',
  currency: 'USD',
  // 25c/item is what the sandbox charged once at $5.00; the real fee is recorded after payout.
  payoutFeePerItemCents: 25,
  minPayoutPerPersonCents: 100,
  maxGuests: 12,
  honorPeriodDays: 3,
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
});

export function loadEnv(env: NodeJS.ProcessEnv) {
  const e = EnvSchema.parse(env);
  const config: AppConfig = {
    ...DEFAULT_CONFIG,
    appBaseUrl: e.APP_BASE_URL.replace(/\/$/, ''),
    payoutFeePerItemCents: e.PAYOUT_FEE_PER_ITEM_CENTS,
    minPayoutPerPersonCents: e.MIN_PAYOUT_PER_PERSON_CENTS,
    maxGuests: e.MAX_GUESTS,
  };
  return { config, port: e.PORT, databaseUrl: e.DATABASE_URL, clientId: e.PAYPAL_CLIENT_ID, clientSecret: e.PAYPAL_CLIENT_SECRET };
}
