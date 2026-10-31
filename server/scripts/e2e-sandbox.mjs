// End-to-end check of the SERVER against the real PayPal SANDBOX.
// Starts the server on a temp database, then plays the demo story through its HTTP API:
// 3 friends deposit ($10 each, you approve as the sandbox buyer), 2 show, 1 flakes and is
// captured, and the net pot is paid to the two who came. Prints a pasteable report.
//   Run from the repo root:  npm run e2e:sandbox
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const serverDir = resolve(import.meta.dirname, '..');
const root = resolve(serverDir, '..');
const PORT = 3198;
const base = `http://127.0.0.1:${PORT}`;
const db = `file:${join(mkdtempSync(join(tmpdir(), 'flakeproof-e2e-')), 'e2e.db')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, extra = '') => { checks.push({ name, ok }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const mig = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: serverDir, env: { ...process.env, DATABASE_URL: db }, encoding: 'utf8' });
if (mig.status !== 0) { console.error(mig.stderr || mig.stdout); process.exit(1); }

const srv = spawn(process.execPath, [`--env-file=${join(root, '.env')}`, '--import', 'tsx', 'src/index.ts'], {
  cwd: serverDir, env: { ...process.env, PORT: String(PORT), DATABASE_URL: db }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
srv.stdout.on('data', (d) => (serverLog += d));
srv.stderr.on('data', (d) => (serverLog += d));
const stop = () => srv.kill();
process.on('exit', stop);

async function api(method, path, body) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}

try {
  for (let i = 0; i < 40; i++) { if (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)) break; await sleep(250); }
  if (!(await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false))) throw new Error(`Server did not start:\n${serverLog}`);

  console.log('\nFlakeproof server end-to-end on the PayPal SANDBOX\n');
  const startsAt = new Date(Date.now() + 2 * 3600e3).toISOString();
  const created = await api('POST', '/api/events', { title: 'E2E court booking', startsAt, depositCents: 1000, guests: [{ name: 'Ana' }, { name: 'Ben' }, { name: 'Cy' }] });
  if (created.status !== 201) throw new Error(`create event failed: ${JSON.stringify(created.body)}`);
  const hostToken = created.body.hostToken;
  const guests = created.body.event.guests.map((g) => ({ ...g, invite: g.inviteUrl.split('/g/')[1] }));

  console.log('  >>> Open each link in a PRIVATE window, log in as the sandbox BUYER (personal) account, approve.');
  console.log('  >>> The same buyer can approve all three.\n');
  for (const g of guests) {
    const r = await api('POST', `/api/g/${g.invite}/deposit`);
    if (r.status !== 200) throw new Error(`start deposit failed: ${JSON.stringify(r.body)}`);
    console.log(`  ${g.name}: ${r.body.approveUrl}`);
  }
  console.log('\n  Waiting for approvals (up to 15 min)...\n');
  const deadline = Date.now() + 15 * 60e3;
  const pending = new Set(guests.map((g) => g.invite));
  while (pending.size && Date.now() < deadline) {
    for (const inv of [...pending]) {
      const r = await api('POST', `/api/g/${inv}/authorize`);
      if (r.status === 200) { pending.delete(inv); console.log(`      ${guests.find((g) => g.invite === inv).name}: hold in place`); }
      else if (r.body?.error?.code !== 'not_approved') throw new Error(`authorize failed: ${JSON.stringify(r.body)}`);
    }
    if (pending.size) await sleep(3000);
  }
  if (pending.size) throw new Error('Timed out waiting for approvals. Re-run.');

  const H = `/api/host/${hostToken}`;
  await api('POST', `${H}/end`);
  const [ana, ben, cy] = guests;
  await api('PUT', `${H}/guests/${ana.id}/attendance`, { attendance: 'showed' });
  await api('PUT', `${H}/guests/${ben.id}/attendance`, { attendance: 'showed' });
  await api('PUT', `${H}/guests/${cy.id}/attendance`, { attendance: 'no_show' });
  // The AI Judge (real Gemini, if a key is configured): it may suggest, but must never pre-select a decision.
  const j = await api('POST', `${H}/judge`, { chat: 'Sam: Cy where are you?\nCy: lol overslept, my bad', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  if (j.status === 200) {
    const cyView = j.body.guests.find((g) => g.name === 'Cy');
    check('AI judge gave a suggestion for the no-show', !!cyView.ai, `suggests ${cyView.ai?.recommendation}`);
    check('AI did not pre-select a decision (host must choose)', cyView.decision === null && j.body.canSettle === false);
  } else {
    console.log(`  (AI judge skipped: ${j.body?.error?.code ?? j.status})`);
  }
  const ready = await api('PUT', `${H}/guests/${cy.id}/decision`, { decision: 'capture' });
  check('host can approve only after attendance and decisions', ready.body.canSettle === true);

  console.log('\n  Approving settlement...');
  let view = (await api('POST', `${H}/settle`, { approve: true }));
  if (view.status !== 200) throw new Error(`settle failed: ${JSON.stringify(view.body)}`);
  for (let i = 0; i < 40 && view.body.status !== 'settled'; i++) {
    await sleep(3000);
    view = await api('POST', `${H}/settle`, { approve: true });
    if (view.status !== 200) throw new Error(`settle failed: ${JSON.stringify(view.body)}`);
    console.log(`      payout: ${view.body.payout?.status}  items: ${view.body.guests.map((g) => g.payout?.status ?? '-').join(',')}`);
  }
  const v = view.body;

  console.log('\n================ E2E REPORT (safe to paste; no secrets) ================');
  check('Ana deposit voided', v.guests[0].deposit.status === 'voided');
  check('Ben deposit voided', v.guests[1].deposit.status === 'voided');
  check('Cy deposit captured', v.guests[2].deposit.status === 'captured', `fee=${v.guests[2].deposit.feeCents} net=${v.guests[2].deposit.netCents} (cents)`);
  check('pot equals Cy net', v.payout?.potCents === v.guests[2].deposit.netCents, `pot=${v.payout?.potCents}`);
  const items = v.guests.slice(0, 2).map((g) => g.payout);
  check('both attendees have payout items', items.every(Boolean), `amounts=${items.map((i) => i?.amountCents).join(',')}`);
  check('items + reserved fees == pot', items.reduce((s, i) => s + i.amountCents, 0) + v.payout.feeReserveCents === v.payout.potCents);
  check('every payout item is SUCCESS (item status, not batch)', items.every((i) => i.status === 'SUCCESS'), `statuses=${items.map((i) => i.status).join(',')} batch=${v.payout.status}`);
  check('event settled', v.status === 'settled');
  console.log(`  actual payout fees: ${v.payout?.actualFeesCents} cents vs reserved ${v.payout?.feeReserveCents} cents`);
  if (v.problems.length) console.log('  problems:', v.problems);
  const ok = checks.every((c) => c.ok);
  console.log(`\nSERVER E2E: ${ok ? 'ALL PASS' : 'NOT ALL PASS'}`);
  console.log('========================================================================\n');
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.error(`\nE2E aborted: ${e.message}`);
  const lines = serverLog.trim().split('\n').slice(-8).join('\n');
  if (lines) console.error(`--- server log (tail) ---\n${lines}`);
  process.exitCode = 1;
} finally {
  stop();
}
