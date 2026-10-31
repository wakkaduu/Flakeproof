// Builds one migrated SQLite template DB; each test file copies it (fast, isolated).
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const TEMPLATE_DB = join(tmpdir(), 'flakeproof-test', 'template.db');

export default function setup() {
  mkdirSync(join(tmpdir(), 'flakeproof-test'), { recursive: true });
  rmSync(TEMPLATE_DB, { force: true });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, DATABASE_URL: `file:${TEMPLATE_DB}` },
    stdio: 'pipe',
  });
}
