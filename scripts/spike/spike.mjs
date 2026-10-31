#!/usr/bin/env node
// Flakeproof sandbox spike. Answers one question: does the money flow actually work?
//
//   1. Create two AUTHORIZE orders (deposit A, deposit B) -> you approve both as the buyer
//   2. Authorize both (a hold; nothing is charged)
//   3. CAPTURE A  (the "no-show")
//   4. VOID B     (the "showed up")
//   5. PAYOUT the captured amount to a second sandbox personal account
//   6. Poll until the payout ITEM is SUCCESS (batch status alone does not count)
//
// SANDBOX ONLY. The base URL is hardcoded to the sandbox host. There is no live mode.
// Zero dependencies. Run: npm run spike   (reads .env)
// State is saved to .spike-state.json after every step, so a re-run resumes where it
// stopped. All PayPal-Request-Id keys derive from that state, so retries are idempotent.
//
// Commands: (none) run/resume | reset | status

import { readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';
const STATE_FILE = process.env.SPIKE_STATE_FILE || '.spike-state.json';

// ---------------------------------------------------------------- config

function baseUrl() {
  // Test-only escape hatch so the script logic can be exercised against a local fake.
  // Restricted to loopback so it can never point at a real PayPal host.
  const override = process.env.PAYPAL_BASE_URL_TEST_ONLY;
  if (!override) return SANDBOX_BASE;
  const host = new URL(override).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error('PAYPAL_BASE_URL_TEST_ONLY must be a loopback address.');
  }
  return override.replace(/\/$/, '');
}

function config() {
  const need = (k) => {
    const v = process.env[k]?.trim();
    if (!v) throw new Error(`Missing ${k}. Copy .env.example to .env and fill it in.`);
    return v;
  };
  const depositCents = Number(process.env.SPIKE_DEPOSIT_CENTS ?? 500);
  if (!Number.isInteger(depositCents) || depositCents < 100 || depositCents > 5000) {
    throw new Error('SPIKE_DEPOSIT_CENTS must be an integer between 100 and 5000.');
  }
  return {
    clientId: need('PAYPAL_CLIENT_ID'),
    clientSecret: need('PAYPAL_CLIENT_SECRET'),
    receiver: need('SPIKE_PAYOUT_RECEIVER_EMAIL'),
    currency: (process.env.SPIKE_CURRENCY || 'USD').toUpperCase(),
    depositCents,
    returnUrl: process.env.SPIKE_RETURN_URL || 'https://example.com/spike-return',
    approvalTimeoutS: Number(process.env.SPIKE_APPROVAL_TIMEOUT_S ?? 900),
    pollMs: Number(process.env.SPIKE_POLL_INTERVAL_MS ?? 3000),
  };
}

// ---------------------------------------------------------------- money (integer cents)

const centsToValue = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
function valueToCents(v) {
  const m = /^(\d+)\.(\d{2})$/.exec(String(v));
  if (!m) throw new Error(`Unexpected money string from PayPal: ${JSON.stringify(v)}`);
  return Number(m[1]) * 100 + Number(m[2]);
}

// ---------------------------------------------------------------- PayPal client (minimal)

class PayPalError extends Error {
  constructor(message, { status, debugId, body } = {}) {
    super(message);
    this.status = status;
    this.debugId = debugId;
    this.body = body;
  }
}

let cachedToken = null; // { value, expiresAt }

async function accessToken(cfg) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.value;
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const res = await fetch(`${baseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new PayPalError(
      `OAuth failed (${res.status}): ${data.error_description || data.error || 'unknown'}. ` +
        'Check PAYPAL_CLIENT_ID/SECRET are SANDBOX credentials from a Merchant app.',
      { status: res.status, debugId: res.headers.get('paypal-debug-id'), body: data },
    );
  }
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

/** Returns { status, data, debugId } for ANY HTTP status. Throws only on network failure. */
async function call(cfg, method, path, { body, requestId, prefer } = {}) {
  const headers = {
    Authorization: `Bearer ${await accessToken(cfg)}`,
    'Content-Type': 'application/json',
  };
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  return { status: res.status, data, debugId: res.headers.get('paypal-debug-id') };
}

/** Like call(), but throws PayPalError unless the HTTP status is in `okStatuses`. */
async function must(cfg, okStatuses, method, path, opts) {
  const r = await call(cfg, method, path, opts);
  if (!okStatuses.includes(r.status)) {
    const issue = r.data?.details?.[0]?.issue;
    throw new PayPalError(
      `${method} ${path} -> HTTP ${r.status}${r.data?.name ? ` ${r.data.name}` : ''}` +
        `${issue ? ` / ${issue}` : ''}${r.data?.message ? `: ${r.data.message}` : ''}`,
      { status: r.status, debugId: r.debugId, body: r.data },
    );
  }
  return r;
}

// ---------------------------------------------------------------- state + step runner

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}
const saveState = (s) => writeFile(STATE_FILE, JSON.stringify(s, null, 2));

async function step(state, name, fn) {
  if (state.steps[name]?.ok) {
    console.log(`  [skip] ${name} (already done)`);
    return state.steps[name];
  }
  console.log(`  [run ] ${name}`);
  let rec;
  try {
    rec = { ok: true, ...(await fn()) };
  } catch (e) {
    rec = { ok: false, error: e.message, httpStatus: e.status, debugId: e.debugId, body: e.body };
    console.log(`  [FAIL] ${name}: ${e.message}${e.debugId ? ` (paypal-debug-id ${e.debugId})` : ''}`);
  }
  state.steps[name] = rec;
  await saveState(state);
  return rec;
}
const done = (state, name) => state.steps[name]?.ok === true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the flow

async function run() {
  const cfg = config();
  let state = await loadState();
  if (!state) {
    state = { runId: randomUUID().slice(0, 8), startedAt: new Date().toISOString(), steps: {}, orders: {}, auth: {} };
    await saveState(state);
  }
  const rid = (suffix) => `flakeproof-spike-${state.runId}-${suffix}`;
  const amount = { currency_code: cfg.currency, value: centsToValue(cfg.depositCents) };
  const L = ['A', 'B']; // A = no-show (captured), B = showed up (voided)

  console.log(`\nFlakeproof sandbox spike  run=${state.runId}  host=${baseUrl()}  deposit=${amount.value} ${amount.currency_code}\n`);

  // 0. credentials
  await step(state, '0 oauth token', async () => {
    await accessToken(cfg);
    return { note: 'token obtained and cached' };
  });
  if (!done(state, '0 oauth token')) return finish(state);

  // 1. create orders
  for (const l of L) {
    await step(state, `1${l} create order (AUTHORIZE)`, async () => {
      const r = await must(cfg, [200, 201], 'POST', '/v2/checkout/orders', {
        requestId: rid(`order-${l}`),
        body: {
          intent: 'AUTHORIZE',
          purchase_units: [
            {
              reference_id: `spike-${state.runId}-${l}`,
              description: 'Flakeproof spike deposit hold',
              amount,
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: 'Flakeproof (sandbox spike)',
                shipping_preference: 'NO_SHIPPING',
                user_action: 'PAY_NOW',
                return_url: cfg.returnUrl,
                cancel_url: cfg.returnUrl,
              },
            },
          },
        },
      });
      const link = r.data.links?.find((x) => x.rel === 'payer-action') ?? r.data.links?.find((x) => x.rel === 'approve');
      if (!link) throw new PayPalError('No payer-action/approve link in order response', { status: r.status, body: r.data });
      state.orders[l] = { id: r.data.id, status: r.data.status, approveUrl: link.href, linkRel: link.rel };
      return { httpStatus: r.status, orderId: r.data.id, orderStatus: r.data.status, linkRel: link.rel, debugId: r.debugId };
    });
  }
  if (!L.every((l) => done(state, `1${l} create order (AUTHORIZE)`))) return finish(state);

  // 2. human approval (the only manual step)
  const needApproval = L.filter((l) => !done(state, `3${l} authorize order`));
  if (needApproval.length) {
    console.log('\n  >>> ACTION NEEDED. Open each link in a PRIVATE/INCOGNITO window and log in as your');
    console.log('  >>> sandbox BUYER (personal) account, then approve. Do not use the merchant account.\n');
    for (const l of needApproval) console.log(`  Deposit ${l}: ${state.orders[l].approveUrl}`);
    console.log(`\n  Waiting up to ${cfg.approvalTimeoutS}s for both orders to reach APPROVED...\n`);
  }
  for (const l of needApproval) {
    await step(state, `2${l} buyer approval`, async () => {
      const deadline = Date.now() + cfg.approvalTimeoutS * 1000;
      let last;
      while (Date.now() < deadline) {
        const r = await must(cfg, [200], 'GET', `/v2/checkout/orders/${state.orders[l].id}`);
        if (r.data.status !== last) console.log(`      order ${l}: ${r.data.status}`);
        last = r.data.status;
        if (r.data.status === 'APPROVED') {
          return { orderStatus: r.data.status, payerEmail: r.data.payer?.email_address, debugId: r.debugId };
        }
        if (!['CREATED', 'PAYER_ACTION_REQUIRED', 'SAVED'].includes(r.data.status)) {
          throw new PayPalError(`Order ${l} reached unexpected status ${r.data.status}`, { body: r.data });
        }
        await sleep(cfg.pollMs);
      }
      throw new PayPalError(`Timed out waiting for approval of order ${l} (last status ${last}). Re-run to resume.`);
    });
    if (!done(state, `2${l} buyer approval`) && !done(state, `3${l} authorize order`)) return finish(state);
  }

  // 3. authorize (the hold)
  for (const l of L) {
    await step(state, `3${l} authorize order`, async () => {
      const r = await must(cfg, [200, 201], 'POST', `/v2/checkout/orders/${state.orders[l].id}/authorize`, {
        requestId: rid(`authorize-${l}`),
        prefer: 'return=representation',
        body: {},
      });
      const a = r.data.purchase_units?.[0]?.payments?.authorizations?.[0];
      if (!a) throw new PayPalError('No authorization in authorize response', { status: r.status, body: r.data });
      const amountOk = a.amount?.currency_code === amount.currency_code && valueToCents(a.amount.value) === cfg.depositCents;
      state.auth[l] = { id: a.id, status: a.status, expiration_time: a.expiration_time };
      if (a.status !== 'CREATED') {
        throw new PayPalError(`Authorization status is ${a.status}, expected CREATED`, { status: r.status, body: a });
      }
      if (!amountOk) throw new PayPalError('Authorization amount/currency mismatch', { body: a.amount });
      return {
        httpStatus: r.status, authId: a.id, authStatus: a.status, orderStatus: r.data.status,
        amount: a.amount, expiration_time: a.expiration_time, debugId: r.debugId,
      };
    });
  }

  // 4. CAPTURE A (the no-show)
  await step(state, '4 capture A', async () => {
    if (!state.auth.A) throw new PayPalError('Authorization A missing');
    const r = await must(cfg, [200, 201], 'POST', `/v2/payments/authorizations/${state.auth.A.id}/capture`, {
      requestId: rid('capture-A'),
      prefer: 'return=representation',
      body: { amount, final_capture: true, invoice_id: `spike-${state.runId}-A`, note_to_payer: 'Flakeproof sandbox spike' },
    });
    const d = r.data;
    const okAmount = d.amount?.currency_code === amount.currency_code && valueToCents(d.amount.value) === cfg.depositCents;
    if (d.status !== 'COMPLETED') throw new PayPalError(`Capture status ${d.status}, expected COMPLETED`, { status: r.status, body: d });
    if (!okAmount) throw new PayPalError('Captured amount/currency mismatch', { body: d.amount });
    state.capture = { id: d.id, status: d.status, cents: valueToCents(d.amount.value) };
    const b = d.seller_receivable_breakdown;
    return {
      httpStatus: r.status, captureId: d.id, captureStatus: d.status, amount: d.amount,
      paypalFee: b?.paypal_fee, netAmount: b?.net_amount, debugId: r.debugId,
    };
  });

  // 4b. probe: replaying the SAME request-id must not double-capture
  await step(state, '4b probe: capture replay (same request id)', async () => {
    if (!state.capture) throw new PayPalError('Skipped: capture A did not succeed');
    const r = await must(cfg, [200, 201], 'POST', `/v2/payments/authorizations/${state.auth.A.id}/capture`, {
      requestId: rid('capture-A'),
      prefer: 'return=representation',
      body: { amount, final_capture: true, invoice_id: `spike-${state.runId}-A`, note_to_payer: 'Flakeproof sandbox spike' },
    });
    const same = r.data.id === state.capture.id;
    if (!same) throw new PayPalError(`Replay produced a DIFFERENT capture id (${r.data.id} vs ${state.capture.id})`, { body: r.data });
    return { httpStatus: r.status, sameCaptureId: same, note: `docs: 200 = idempotent repeat, 201 = created; got ${r.status}`, debugId: r.debugId };
  });

  // 5. VOID B (showed up)
  await step(state, '5 void B', async () => {
    if (!state.auth.B) throw new PayPalError('Authorization B missing');
    const r = await must(cfg, [200, 204], 'POST', `/v2/payments/authorizations/${state.auth.B.id}/void`, {
      requestId: rid('void-B'),
    });
    const g = await must(cfg, [200], 'GET', `/v2/payments/authorizations/${state.auth.B.id}`);
    if (g.data.status !== 'VOIDED') throw new PayPalError(`Authorization B status ${g.data.status}, expected VOIDED`, { body: g.data });
    return { voidHttpStatus: r.status, authStatusAfter: g.data.status, debugId: r.debugId };
  });

  // 5b. probe: voiding a captured authorization should be refused (state-machine guard)
  await step(state, '5b probe: void on captured auth A (expect refusal)', async () => {
    if (!state.capture) throw new PayPalError('Skipped: capture A did not succeed');
    const r = await call(cfg, 'POST', `/v2/payments/authorizations/${state.auth.A.id}/void`, { requestId: rid('void-A-probe') });
    if (r.status < 400) throw new PayPalError(`Expected a refusal but got HTTP ${r.status}`, { status: r.status, body: r.data });
    return { httpStatus: r.status, name: r.data?.name, issue: r.data?.details?.[0]?.issue, debugId: r.debugId };
  });

  // 6. PAYOUT the captured amount
  await step(state, '6 create payout', async () => {
    if (!state.capture) throw new PayPalError('Skipped: nothing captured, so there is no pot to pay out');
    const r = await must(cfg, [200, 201], 'POST', '/v1/payments/payouts', {
      requestId: rid('payout'),
      body: {
        sender_batch_header: {
          sender_batch_id: rid('payout'),
          email_subject: 'Flakeproof sandbox spike payout',
          email_message: 'Sandbox test payout from the Flakeproof spike.',
        },
        items: [
          {
            recipient_type: 'EMAIL',
            receiver: cfg.receiver,
            amount: { currency: cfg.currency, value: centsToValue(state.capture.cents) },
            note: 'Flakeproof spike: share of the no-show pot',
            sender_item_id: `spike-${state.runId}-item-1`,
          },
        ],
      },
    });
    const bh = r.data.batch_header;
    state.payout = { batchId: bh.payout_batch_id };
    return { httpStatus: r.status, batchId: bh.payout_batch_id, batchStatus: bh.batch_status, debugId: r.debugId };
  });

  // 6b. poll until the ITEM is terminal. Only item SUCCESS counts as paid.
  await step(state, '6b payout item reaches SUCCESS', async () => {
    if (!state.payout) throw new PayPalError('Skipped: no payout batch was created');
    const deadline = Date.now() + 120_000;
    let last = '';
    while (Date.now() < deadline) {
      const r = await must(cfg, [200], 'GET', `/v1/payments/payouts/${state.payout.batchId}`);
      const item = r.data.items?.[0];
      const snap = `batch=${r.data.batch_header?.batch_status} item=${item?.transaction_status ?? 'n/a'}`;
      if (snap !== last) console.log(`      ${snap}`);
      last = snap;
      if (item && item.transaction_status === 'SUCCESS') {
        return { batchStatus: r.data.batch_header.batch_status, itemStatus: item.transaction_status, payoutItemId: item.payout_item_id, debugId: r.debugId };
      }
      const terminalBad = ['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'UNCLAIMED', 'ONHOLD'];
      if (item && terminalBad.includes(item.transaction_status)) {
        throw new PayPalError(
          `Payout item ${item.transaction_status}: ${item.errors?.name ?? ''} ${item.errors?.message ?? ''}`.trim(),
          { body: { batch: r.data.batch_header, item } },
        );
      }
      if (r.data.batch_header?.batch_status === 'DENIED') {
        throw new PayPalError('Payout batch DENIED', { body: r.data });
      }
      await sleep(cfg.pollMs);
    }
    throw new PayPalError(`Timed out; last seen: ${last}. Re-run to keep polling.`);
  });

  return finish(state);
}

// ---------------------------------------------------------------- report

function finish(state) {
  const rows = Object.entries(state.steps);
  console.log('\n================ SPIKE REPORT (safe to paste; no secrets) ================');
  console.log(`run=${state.runId}`);
  for (const [name, s] of rows) {
    const bits = [];
    for (const k of ['httpStatus', 'voidHttpStatus', 'orderStatus', 'authStatus', 'authStatusAfter', 'captureStatus', 'batchStatus', 'itemStatus', 'sameCaptureId', 'linkRel']) {
      if (s[k] !== undefined) bits.push(`${k}=${s[k]}`);
    }
    if (s.amount) bits.push(`amount=${s.amount.value} ${s.amount.currency_code}`);
    if (s.paypalFee) bits.push(`fee=${s.paypalFee.value} net=${s.netAmount?.value}`);
    if (s.name) bits.push(`${s.name}/${s.issue ?? ''}`);
    if (!s.ok) bits.push(`ERROR: ${s.error}`);
    if (s.debugId) bits.push(`debug-id=${s.debugId}`);
    console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${name}${bits.length ? '  ' + bits.join('  ') : ''}`);
  }
  const core = ['3A authorize order', '3B authorize order', '4 capture A', '5 void B', '6b payout item reaches SUCCESS'];
  const allCore = core.every((n) => state.steps[n]?.ok);
  console.log(`\nCORE FLOW (authorize x2, capture, void, payout item SUCCESS): ${allCore ? 'ALL PASS' : 'NOT COMPLETE'}`);
  console.log('Re-run `npm run spike` to resume/retry failed steps; `npm run spike:reset` to start over.');
  console.log('==========================================================================\n');
  process.exitCode = allCore ? 0 : 1;
}

// ---------------------------------------------------------------- main

const cmd = process.argv[2];
try {
  if (cmd === 'reset') {
    await rm(STATE_FILE, { force: true });
    console.log(`Removed ${STATE_FILE}`);
  } else if (cmd === 'status') {
    const s = await loadState();
    if (s) finish(s);
    else console.log('No spike state yet. Run `npm run spike`.');
  } else if (cmd === undefined) {
    await run();
  } else {
    console.log('Usage: spike.mjs [reset|status]');
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`\nSpike aborted: ${e.message}`);
  process.exitCode = 1;
}
