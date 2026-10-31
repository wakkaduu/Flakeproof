#!/usr/bin/env node
// Hackathon status: countdown to the deadline plus automated checks of what the Official Rules require.
//   npm run status               full report
//   npm run status -- --brief    countdown and next milestone only (used as a session-start reminder)
//   npm run status -- --tests    also run the test suite
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const sh = (cmd) => { try { return execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };
const read = (p) => (existsSync(resolve(root, p)) ? readFileSync(resolve(root, p), 'utf8') : '');

// From the Official Rules: submissions close Thu Nov 12, 2026, 12:00 pm Pacific (PST, UTC-8) = 20:00 UTC.
const DEADLINE = Date.parse('2026-11-12T20:00:00Z');
const INTERNAL = DEADLINE - 24 * 3600e3; // our own target: submit a day early
const JUDGING_ENDS = Date.parse('2026-12-15T16:00:00Z'); // the project must stay available until here

const fmt = (ms) => {
  const m = Math.max(0, Math.floor(ms / 60000));
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
};
const when = (t, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }).format(new Date(t));
const now = Date.now();

const has = (p) => existsSync(resolve(root, p));
const milestones = [
  { by: '2026-11-03', name: 'Step 5 built: AI Judge + host dashboard', done: has('server/src/ai/judge.ts') && has('web/src/pages/HostPage.tsx') },
  { by: '2026-11-04', name: 'Full real run with the four sandbox accounts', done: /Demo rehearsal/i.test(read('docs/spike-results.md')) },
  { by: '2026-11-07', name: 'Feature freeze; README, screenshots, Devpost text ready', done: has('docs/devpost-description.md') },
  { by: '2026-11-09', name: 'Demo video recorded and public on YouTube (link in README)', done: /(youtube\.com|youtu\.be)\//i.test(read('README.md')) },
  { by: '2026-11-11', name: 'Submitted on Devpost (a day early)', done: false, manual: true },
];

const left = DEADLINE - now;
console.log(`\nDEADLINE  ${when(DEADLINE, 'America/Los_Angeles')}  =  ${when(DEADLINE, Intl.DateTimeFormat().resolvedOptions().timeZone)}`);
console.log(left > 0 ? `TIME LEFT ${fmt(left)}   (our target to submit: in ${fmt(INTERNAL - now)})` : 'THE SUBMISSION PERIOD HAS ENDED. No edits are allowed.');
const next = milestones.find((m) => !m.done);
if (next) {
  const late = now > Date.parse(`${next.by}T23:59:59+08:00`);
  console.log(`NEXT      ${late ? 'OVERDUE ' : ''}${next.by}  ${next.name}`);
}
if (args.has('--brief')) { console.log(''); process.exit(0); }

console.log('\nMilestones');
for (const m of milestones) {
  const late = !m.done && now > Date.parse(`${m.by}T23:59:59+08:00`);
  console.log(`  ${m.done ? 'DONE   ' : late ? 'OVERDUE' : m.manual ? 'MANUAL ' : 'todo   '}  ${m.by}  ${m.name}`);
}

const checks = [];
const check = (ok, name, detail = '') => checks.push({ ok, name, detail });

// ---- what the Official Rules require of the repo
check(/MIT License/.test(read('LICENSE')), 'LICENSE is the standard MIT text (GitHub must detect it)');
const tracked = sh('git ls-files') ?? '';
check(!/(^|\n)\.env(\n|$)/.test(tracked) && !/\.spike-state\.json|\.db(\n|$)/.test(tracked), 'No .env, spike state or database file is tracked');
const envVals = read('.env').split('\n').map((l) => l.match(/^(PAYPAL_CLIENT_SECRET|GEMINI_API_KEY|PAYPAL_CLIENT_ID)=(.{12,})$/)).filter(Boolean).map((m) => m[2]);
const leaked = envVals.filter((v) => sh(`git grep -qF -- ${JSON.stringify(v)} $(git rev-list --all) && echo leak`) === 'leak');
check(envVals.length === 0 || leaked.length === 0, 'No secret from .env appears anywhere in git history', envVals.length ? '' : '(.env not found, cannot compare)');
check(/Before you start/.test(read('README.md')), 'README has a judge-first "Before you start" section');
check(has('docs/screenshots') && readdirSync(resolve(root, 'docs/screenshots')).filter((f) => f.endsWith('.png')).length >= 3, 'README screenshots exist (3 or more)');
check(!/sk-ant-|AIza[0-9A-Za-z_-]{30,}/.test(sh('git grep -hE "sk-ant-|AIza[0-9A-Za-z_-]{30,}" HEAD') ?? ''), 'No API-key-shaped strings in the committed code');

// ---- repo public, licence detected, pushed
const remote = sh('git remote get-url origin');
if (!remote) {
  check(false, 'Public GitHub repository exists and this repo is pushed to it', 'no git remote yet');
} else {
  const m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  const unpushed = sh('git rev-list --count @{u}..HEAD');
  check(unpushed === '0', 'All commits are pushed', unpushed === null ? 'no upstream branch' : `${unpushed} unpushed`);
  if (m) {
    try {
      const r = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}`, { headers: { 'user-agent': 'status-script' }, signal: AbortSignal.timeout(8000) });
      const j = r.ok ? await r.json() : null;
      check(!!j && j.private === false, 'Repository is public', j ? '' : `GitHub returned ${r.status} (private or missing)`);
      check(j?.license?.spdx_id === 'MIT', "GitHub detects the MIT licence (shows in the About section)", j ? `detected: ${j.license?.spdx_id ?? 'none'}` : '');
    } catch {
      check(false, 'Repository is public and licence detected', 'could not reach GitHub');
    }
  }
}
check((sh('git status --porcelain') ?? 'x') === '', 'Working tree is clean (everything committed)');
if (args.has('--tests')) {
  const ok = sh('npm test 2>&1 | tail -3') !== null;
  check(ok, 'npm test passes');
}

console.log('\nChecks');
for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
console.log(`\nKeep until ${when(JUDGING_ENDS, 'America/Los_Angeles')}: the project must stay free and available to judges.`);
console.log('Rules reminders: video under 3:00 and public on YouTube; no third-party trademarks or copyrighted music; no edits after the deadline.\n');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
