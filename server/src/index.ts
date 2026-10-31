import { resolve } from 'node:path';
import { createApp } from './app.js';
import { loadEnv } from './config.js';
import { GeminiRsvpModel } from './ai/gemini.js';
import { createDb } from './db.js';
import { RealPayPalClient } from './paypal/client.js';
import { KeyedMutex } from './util.js';

let env: ReturnType<typeof loadEnv>;
try {
  env = loadEnv(process.env);
} catch (e) {
  console.error('Configuration error. Copy .env.example to .env and fill in the sandbox credentials.');
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

const webDir = resolve(import.meta.dirname, '..', '..', 'web', 'dist');
const app = createApp({
  db: createDb(env.databaseUrl),
  paypal: new RealPayPalClient({ clientId: env.clientId, clientSecret: env.clientSecret }),
  rsvp: env.gemini ? new GeminiRsvpModel(env.gemini) : null,
  config: env.config,
  mutex: new KeyedMutex(),
  now: () => new Date(),
}, { webDir });

app.listen(env.port, () => {
  console.log(`Flakeproof server on http://localhost:${env.port}  (PayPal SANDBOX, AI ${env.gemini ? env.gemini.model : 'off: add GEMINI_API_KEY'})`);
});
