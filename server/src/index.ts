import { createApp } from './app.js';
import { loadEnv } from './config.js';
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

const app = createApp({
  db: createDb(env.databaseUrl),
  paypal: new RealPayPalClient({ clientId: env.clientId, clientSecret: env.clientSecret }),
  config: env.config,
  mutex: new KeyedMutex(),
  now: () => new Date(),
});

app.listen(env.port, () => {
  console.log(`ShowUp server on http://localhost:${env.port}  (PayPal SANDBOX)`);
});
