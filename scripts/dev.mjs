// Starts the API (:3001) and the web dev server (:5173) together. Ctrl+C stops both.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
if (!existsSync(resolve(root, '.env'))) {
  console.error('Missing .env. Run: cp .env.example .env  (and fill in the sandbox credentials)');
  process.exit(1);
}
const run = (name, args) => {
  const p = spawn('npm', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const tag = (d) => String(d).split('\n').filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`));
  p.stdout.on('data', tag);
  p.stderr.on('data', tag);
  p.on('exit', (code) => { console.log(`[${name}] exited (${code})`); stopAll(); });
  return p;
};
const procs = [run('api', ['run', 'dev', '-w', 'server']), run('web', ['run', 'dev', '-w', 'web'])];
let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
