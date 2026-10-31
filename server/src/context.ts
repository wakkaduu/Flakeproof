import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from './config.js';
import type { PayPalClient } from './paypal/types.js';
import type { KeyedMutex } from './util.js';

/** Everything a service needs, injected so tests can pass a fake PayPal, temp DB and fixed clock. */
export interface Ctx {
  db: PrismaClient;
  paypal: PayPalClient;
  config: AppConfig;
  mutex: KeyedMutex;
  now: () => Date;
}
