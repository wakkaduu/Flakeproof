// Runs the Prisma CLI with the repo's .env (if present) and a SQLite default.
// Usage: node scripts/db.mjs migrate deploy | migrate dev --name x | generate
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..', '..');
const env = { ...process.env };
const envFile = resolve(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
Object.assign(env, { DATABASE_URL: process.env.DATABASE_URL || 'file:./dev.db' });
const r = spawnSync('npx', ['prisma', ...process.argv.slice(2)], { stdio: 'inherit', env, cwd: resolve(import.meta.dirname, '..') });
process.exit(r.status ?? 1);
