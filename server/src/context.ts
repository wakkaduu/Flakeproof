import type { PrismaClient } from '@prisma/client';
import type { JudgeModel } from './ai/judge.js';
import type { RsvpModel } from './ai/types.js';
import type { AppConfig } from './config.js';
import type { PayPalClient } from './paypal/types.js';
import type { KeyedMutex } from './util.js';

/** Everything a service needs, injected so tests can pass a fake PayPal, temp DB and fixed clock. */
export interface Ctx {
  db: PrismaClient;
  paypal: PayPalClient;
  /** null when no AI key is configured: the host adds guests by hand. */
  rsvp: RsvpModel | null;
  /** null when no AI key is configured: the host decides without recommendations. */
  judge: JudgeModel | null;
  config: AppConfig;
  mutex: KeyedMutex;
  now: () => Date;
}
