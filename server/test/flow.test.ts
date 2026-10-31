import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PayPalError } from '../src/paypal/errors.js';
import { makeHarness, type Harness } from './harness.js';

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.close(); });

const setup = async () => {
  const ev = await h.createEvent();
  for (const g of ev.guests) await h.deposit(g.invite);
  return ev;
};

describe('the demo story: three show, one flakes', () => {
  it('voids the three, captures the no-show, pays the pot to the three, and only counts item SUCCESS', async () => {
    const ev = await setup();
    const [ana, ben, cy, dee] = ev.guests as [typeof ev.guests[0], typeof ev.guests[0], typeof ev.guests[0], typeof ev.guests[0]];

    expect((await h.api('POST', `/api/host/${ev.hostToken}/end`)).status).toBe(200);
    for (const g of [ana, ben, cy]) await h.api('PUT', `/api/host/${ev.hostToken}/guests/${g.id}/attendance`, { attendance: 'showed' });
    await h.api('PUT', `/api/host/${ev.hostToken}/guests/${dee.id}/attendance`, { attendance: 'no_show' });
    const dec = await h.api('PUT', `/api/host/${ev.hostToken}/guests/${dee.id}/decision`, { decision: 'capture' });
    expect(dec.body.canSettle).toBe(true);

    // Nothing has moved yet: the AI/host decision alone changes no money.
    expect(h.paypal.callsTo('voidAuthorization')).toBe(0);
    expect(h.paypal.callsTo('captureAuthorization')).toBe(0);

    const first = await h.api('POST', `/api/host/${ev.hostToken}/settle`, { approve: true });
    expect(first.status).toBe(200);
    // Voids happen before the capture.
    const order = h.paypal.calls.map((c) => c.method).filter((m) => ['voidAuthorization', 'captureAuthorization', 'createPayout'].includes(m));
    expect(order).toEqual(['voidAuthorization', 'voidAuthorization', 'voidAuthorization', 'captureAuthorization', 'createPayout']);

    // Payout was created but PayPal has not finished: NOT settled, nobody is "paid out" yet.
    expect(first.body.status).toBe('ended');
    expect(first.body.guests.map((g: any) => g.stage)).toEqual(['voided', 'voided', 'voided', 'captured']);

    // $20.00 deposit: fee 3.49% + 49c = 119c, net 1881c. Reserve 3 x 25c. 1806 / 3 = 602 each.
    const dee1 = first.body.guests[3];
    expect(dee1.deposit).toMatchObject({ status: 'captured', amountCents: 2000, feeCents: 119, netCents: 1881 });
    expect(first.body.payout).toMatchObject({ potCents: 1881, feeReserveCents: 75, distributableCents: 1806 });
    expect(first.body.guests.slice(0, 3).map((g: any) => g.payout.amountCents)).toEqual([602, 602, 602]);

    h.paypal.completePayouts();
    const second = await h.api('POST', `/api/host/${ev.hostToken}/settle`, { approve: true });
    expect(second.body.status).toBe('settled');
    expect(second.body.guests.map((g: any) => g.stage)).toEqual(['paid_out', 'paid_out', 'paid_out', 'captured']);
    expect(second.body.payout.actualFeesCents).toBe(75);

    // PayPal received exactly one capture and one payout batch, for exactly the planned amounts.
    expect(h.paypal.callsTo('captureAuthorization')).toBe(1);
    expect(h.paypal.callsTo('createPayout')).toBe(1);
    const batch = [...h.paypal.payouts.values()][0]!;
    expect(batch.items.map((i) => i.amountCents)).toEqual([602, 602, 602]);
    expect(batch.items.every((i) => i.receiver.endsWith('@buyer.test'))).toBe(true);

    // What each guest sees.
    const aView = await h.api('GET', `/api/g/${ana.invite}`);
    expect(aView.body.outcome).toEqual({ kind: 'received', amountCents: 602 });
    const dView = await h.api('GET', `/api/g/${dee.invite}`);
    expect(dView.body.outcome).toEqual({ kind: 'charged', amountCents: 2000 });
  });

  it('forgiving the only no-show voids everyone, pays nothing, and settles', async () => {
    const ev = await setup();
    await h.api('POST', `/api/host/${ev.hostToken}/end`);
    for (const g of ev.guests.slice(0, 3)) await h.api('PUT', `/api/host/${ev.hostToken}/guests/${g.id}/attendance`, { attendance: 'showed' });
    const dee = ev.guests[3]!;
    await h.api('PUT', `/api/host/${ev.hostToken}/guests/${dee.id}/attendance`, { attendance: 'no_show' });
    await h.api('PUT', `/api/host/${ev.hostToken}/guests/${dee.id}/decision`, { decision: 'forgive' });
    const r = await h.api('POST', `/api/host/${ev.hostToken}/settle`, { approve: true });
    expect(r.body.status).toBe('settled');
    expect(r.body.payout).toMatchObject({ status: 'SKIPPED', skippedReason: 'no_capture' });
    expect(h.paypal.callsTo('captureAuthorization')).toBe(0);
    expect(h.paypal.callsTo('createPayout')).toBe(0);
    expect(h.paypal.callsTo('voidAuthorization')).toBe(4);
    expect((await h.api('GET', `/api/g/${dee.invite}`)).body.outcome).toEqual({ kind: 'nothing_charged' });
  });
});

describe('the host must approve', () => {
  it('refuses to settle before the event ends, before attendance, and before decisions', async () => {
    const ev = await setup();
    const url = `/api/host/${ev.hostToken}/settle`;
    expect((await h.api('POST', url, { approve: true })).status).toBe(409);
    await h.api('POST', `/api/host/${ev.hostToken}/end`);
    const r2 = await h.api('POST', url, { approve: true });
    expect(r2.status).toBe(409);
    expect(r2.body.error.message).toContain('Mark attendance');
    for (const g of ev.guests) await h.api('PUT', `/api/host/${ev.hostToken}/guests/${g.id}/attendance`, { attendance: 'no_show' });
    const r3 = await h.api('POST', url, { approve: true });
    expect(r3.body.error.message).toContain('Decide capture or forgive');
    expect(h.paypal.callsTo('voidAuthorization') + h.paypal.callsTo('captureAuthorization')).toBe(0);
  });

  it('requires an explicit approve:true body', async () => {
    const ev = await setup();
    expect((await h.api('POST', `/api/host/${ev.hostToken}/settle`, {})).status).toBe(400);
    expect((await h.api('POST', `/api/host/${ev.hostToken}/settle`, { approve: false })).status).toBe(400);
  });

  it('locks check-ins and decisions once settlement is approved', async () => {
    const ev = await setup();
    await h.api('POST', `/api/host/${ev.hostToken}/end`);
    for (const g of ev.guests) await h.api('PUT', `/api/host/${ev.hostToken}/guests/${g.id}/attendance`, { attendance: 'showed' });
    await h.api('POST', `/api/host/${ev.hostToken}/settle`, { approve: true });
    const r = await h.api('PUT', `/api/host/${ev.hostToken}/guests/${ev.guests[0]!.id}/attendance`, { attendance: 'no_show' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('locked');
  });

  it('only a no-show with a held deposit can get a decision', async () => {
    const ev = await h.createEvent({ names: ['Ana', 'Ben'] });
    await h.deposit(ev.guests[0]!.invite); // Ben never deposits
    await h.api('POST', `/api/host/${ev.hostToken}/end`);
    const showed = await h.api('PUT', `/api/host/${ev.hostToken}/guests/${ev.guests[0]!.id}/decision`, { decision: 'capture' });
    expect(showed.body.error.code).toBe('not_no_show');
    await h.api('PUT', `/api/host/${ev.hostToken}/guests/${ev.guests[1]!.id}/attendance`, { attendance: 'no_show' });
    const noDep = await h.api('PUT', `/api/host/${ev.hostToken}/guests/${ev.guests[1]!.id}/decision`, { decision: 'capture' });
    expect(noDep.body.error.code).toBe('no_deposit');
  });
});

describe('safe retries (idempotency)', () => {
  it('two settle clicks at once capture once and create one payout', async () => {
    const ev = await setup();
    await h.api('POST', `/api/host/${ev.hostToken}/end`);
    for (const g of ev.guests.slice(0, 3)) await h.api('PUT', `/api/host/${ev.hostToken}/guests/${g.id}/attendance`, { attendance: 'showed' });
    const dee = ev.guests[3]!;
    await h.api('PUT', `/api/host/${ev.hostToken}/guests/${dee.id}/attendance`, { attendance: 'no_show' });
    await h.api('PUT', `/api/host/${ev.hostToken}/guests/${dee.id}/decision`, { decision: 'capture' });
    const [a, b] = await Promise.all([
      h.api('POST', `/api/host/${ev.hostToken}/settle`, { approve: true }),
      h.api('POST', `/api/host/${ev.hostToken}/settle`, { approve: true }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(h.paypal.callsTo('captureAuthorization')).toBe(1);
    expect(h.paypal.callsTo('createPayout')).toBe(1);
    expect(h.paypal.callsTo('voidAuthorization')).toBe(3);
  });

  it('recovers when PayPal fails mid-settlement: the retry finishes without double-acting', async () => {
    const ev = await setup();
    await h.api('POST', `/api/host/${ev.hostToken}/end`);
    for (const g of ev.guests.slice(0, 3)) await h.api('PUT', `/api/host/${ev.hostToken}/guests/${g.id}/attendance`, { attendance: 'showed' });
    const dee = ev.guests[3]!;
    await h.api('PUT', `/api/host/${ev.hostToken}/guests/${dee.id}/attendance`, { attendance: 'no_show' });
    await h.api('PUT', `/api/host/${ev.hostToken}/guests/${dee.id}/decision`, { decision: 'capture' });

    h.paypal.failNext('captureAuthorization', new PayPalError('unavailable', 'boom'));
    const bad = await h.api('POST', `/api/host/${ev.hostToken}/settle`, { approve: true });
    expect(bad.status).toBe(503);
    expect(bad.body.error.message).toContain('not responding');
    expect(JSON.stringify(bad.body)).not.toContain('boom'); // internals stay in the logs

    const view = await h.api('GET', `/api/host/${ev.hostToken}/event`);
    expect(view.body.guests.map((g: any) => g.deposit.status)).toEqual(['voided', 'voided', 'voided', 'authorized']);

    const ok = await h.api('POST', `/api/host/${ev.hostToken}/settle`, { approve: true });
    expect(ok.status).toBe(200);
    expect(ok.body.guests[3].deposit.status).toBe('captured');
    expect(h.paypal.captures.size).toBe(1);
    expect(h.paypal.callsTo('voidAuthorization')).toBe(3); // the voids were not repeated
  });

  it('guest authorize is idempotent', async () => {
    const ev = await h.createEvent({ names: ['Ana'] });
    await h.deposit(ev.guests[0]!.invite);
    const again = await h.api('POST', `/api/g/${ev.guests[0]!.invite}/authorize`);
    expect(again.status).toBe(200);
    expect(h.paypal.callsTo('authorizeOrder')).toBe(1);
    const startAgain = await h.api('POST', `/api/g/${ev.guests[0]!.invite}/deposit`);
    expect(startAgain.body.error.code).toBe('already_authorized');
  });

  it('starting a deposit twice gives the same order', async () => {
    const ev = await h.createEvent({ names: ['Ana'] });
    const a = await h.api('POST', `/api/g/${ev.guests[0]!.invite}/deposit`);
    const b = await h.api('POST', `/api/g/${ev.guests[0]!.invite}/deposit`);
    expect(a.body.approveUrl).toBe(b.body.approveUrl);
    expect(h.paypal.orders.size).toBe(1);
  });
});

describe('money safety', () => {
  it('the server decides the amount; a client-sent amount is ignored', async () => {
    const ev = await h.createEvent({ names: ['Ana'], depositCents: 2000 });
    await h.api('POST', `/api/g/${ev.guests[0]!.invite}/deposit`, { amountCents: 1, amount: '0.01' });
    expect([...h.paypal.orders.values()][0]!.amountCents).toBe(2000);
  });

  it('does not finalize before the buyer approved', async () => {
    const ev = await h.createEvent({ names: ['Ana'] });
    await h.api('POST', `/api/g/${ev.guests[0]!.invite}/deposit`);
    const r = await h.api('POST', `/api/g/${ev.guests[0]!.invite}/authorize`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('not_approved');
    expect(h.paypal.callsTo('authorizeOrder')).toBe(0);
  });

  it('rejects and releases a hold that does not match the deposit', async () => {
    const ev = await h.createEvent({ names: ['Ana'] });
    const invite = ev.guests[0]!.invite;
    const s = await h.api('POST', `/api/g/${invite}/deposit`);
    // Simulate our record disagreeing with what PayPal will hold.
    await h.db.deposit.updateMany({ data: { amountCents: 1999 } });
    h.paypal.approveOrder(s.body.approveUrl.split('/').pop());
    const r = await h.api('POST', `/api/g/${invite}/authorize`);
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('verification_failed');
    expect(h.paypal.callsTo('voidAuthorization')).toBe(1);
    expect((await h.db.deposit.findFirstOrThrow()).status).toBe('pending');
  });

  it('refuses to pay out when the merchant currency differs (the PHP incident)', async () => {
    const ev = await setup();
    h.paypal.merchantCurrency = 'PHP';
    await h.api('POST', `/api/host/${ev.hostToken}/end`);
    for (const g of ev.guests.slice(0, 3)) await h.api('PUT', `/api/host/${ev.hostToken}/guests/${g.id}/attendance`, { attendance: 'showed' });
    const dee = ev.guests[3]!;
    await h.api('PUT', `/api/host/${ev.hostToken}/guests/${dee.id}/attendance`, { attendance: 'no_show' });
    await h.api('PUT', `/api/host/${ev.hostToken}/guests/${dee.id}/decision`, { decision: 'capture' });
    const r = await h.api('POST', `/api/host/${ev.hostToken}/settle`, { approve: true });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('net_unknown');
    expect(h.paypal.callsTo('createPayout')).toBe(0);
    const view = await h.api('GET', `/api/host/${ev.hostToken}/event`);
    expect(view.body.problems.join(' ')).toContain('could not verify');
  });

  it('a pending capture is resolved on the next settle, then pays out', async () => {
    const ev = await setup();
    await h.api('POST', `/api/host/${ev.hostToken}/end`);
    for (const g of ev.guests.slice(0, 3)) await h.api('PUT', `/api/host/${ev.hostToken}/guests/${g.id}/attendance`, { attendance: 'showed' });
    const dee = ev.guests[3]!;
    await h.api('PUT', `/api/host/${ev.hostToken}/guests/${dee.id}/attendance`, { attendance: 'no_show' });
    await h.api('PUT', `/api/host/${ev.hostToken}/guests/${dee.id}/decision`, { decision: 'capture' });
    h.paypal.nextCaptureStatus = 'PENDING';
    const a = await h.api('POST', `/api/host/${ev.hostToken}/settle`, { approve: true });
    expect(a.body.guests[3].deposit.status).toBe('capture_pending');
    expect(h.paypal.callsTo('createPayout')).toBe(0);
    const b = await h.api('POST', `/api/host/${ev.hostToken}/settle`, { approve: true });
    expect(b.body.guests[3].deposit.status).toBe('captured');
    expect(h.paypal.callsTo('createPayout')).toBe(1);
  });

  it('does not call the event settled while a payout item is not SUCCESS', async () => {
    const ev = await setup();
    await h.api('POST', `/api/host/${ev.hostToken}/end`);
    for (const g of ev.guests.slice(0, 3)) await h.api('PUT', `/api/host/${ev.hostToken}/guests/${g.id}/attendance`, { attendance: 'showed' });
    const dee = ev.guests[3]!;
    await h.api('PUT', `/api/host/${ev.hostToken}/guests/${dee.id}/attendance`, { attendance: 'no_show' });
    await h.api('PUT', `/api/host/${ev.hostToken}/guests/${dee.id}/decision`, { decision: 'capture' });
    await h.api('POST', `/api/host/${ev.hostToken}/settle`, { approve: true });
    h.paypal.completePayouts('UNCLAIMED');
    const r = await h.api('POST', `/api/host/${ev.hostToken}/settle`, { approve: true });
    expect(r.body.status).toBe('ended');
    expect(r.body.problems.join(' ')).toContain('UNCLAIMED');
    expect(r.body.guests[0].stage).toBe('voided');
    expect(h.paypal.callsTo('createPayout')).toBe(1); // never auto-resent
  });

  it('shows a guest who never deposited no money movement and pays them nothing', async () => {
    const ev = await h.createEvent({ names: ['Ana', 'Ben', 'Cy'] });
    await h.deposit(ev.guests[0]!.invite);
    await h.deposit(ev.guests[1]!.invite); // Cy never deposits
    await h.api('POST', `/api/host/${ev.hostToken}/end`);
    await h.api('PUT', `/api/host/${ev.hostToken}/guests/${ev.guests[0]!.id}/attendance`, { attendance: 'showed' });
    await h.api('PUT', `/api/host/${ev.hostToken}/guests/${ev.guests[1]!.id}/attendance`, { attendance: 'no_show' });
    await h.api('PUT', `/api/host/${ev.hostToken}/guests/${ev.guests[1]!.id}/decision`, { decision: 'capture' });
    const r = await h.api('POST', `/api/host/${ev.hostToken}/settle`, { approve: true });
    expect(r.status).toBe(200);
    expect(r.body.guests[2].payout).toBeNull();
    expect(r.body.guests[0].payout.amountCents).toBe(1881 - 25);
  });
});

describe('boundaries and access', () => {
  it('validates event creation', async () => {
    const bad = (over: object) => h.api('POST', '/api/events', {
      title: 'x', startsAt: new Date(h.clock.now.getTime() + 3_600_000).toISOString(), depositCents: 2000, guests: [{ name: 'A' }], ...over,
    });
    expect((await bad({ startsAt: '2026-10-01T00:00:00Z' })).body.error.code).toBe('event_in_past');
    expect((await bad({ startsAt: new Date(h.clock.now.getTime() + 100 * 3_600_000).toISOString() })).body.error.code).toBe('event_too_far');
    expect((await bad({ depositCents: 100 })).body.error.code).toBe('deposit_out_of_range');
    expect((await bad({ depositCents: 999999 })).body.error.code).toBe('deposit_out_of_range');
    expect((await bad({ depositCents: 20.5 })).status).toBe(400);
    expect((await bad({ guests: [{ name: 'A' }, { name: 'a' }] })).body.error.code).toBe('duplicate_guest');
    expect((await bad({ guests: [] })).status).toBe(400);
    expect((await bad({ title: '   ' })).status).toBe(400);
  });

  it('closes deposits when the event ends', async () => {
    const ev = await h.createEvent({ names: ['Ana'] });
    await h.api('POST', `/api/host/${ev.hostToken}/end`);
    const r = await h.api('POST', `/api/g/${ev.guests[0]!.invite}/deposit`);
    expect(r.body.error.code).toBe('event_closed');
  });

  it('unknown or swapped tokens get 404, and tokens are not interchangeable', async () => {
    const ev = await h.createEvent({ names: ['Ana'] });
    const guestInvite = ev.guests[0]!.invite;
    expect((await h.api('GET', '/api/host/does-not-exist-0000000000/event')).status).toBe(404);
    expect((await h.api('GET', `/api/host/${guestInvite}/event`)).status).toBe(404);
    expect((await h.api('GET', `/api/g/${ev.hostToken}`)).status).toBe(404);
    expect((await h.api('GET', '/api/g/bad token!')).status).toBe(400);
  });

  it('never exposes the full payer email or other guests\' links to a guest, and masks emails for the host', async () => {
    const ev = await h.createEvent({ names: ['Ana'] });
    await h.deposit(ev.guests[0]!.invite, 'anabuyer@example.test');
    const guestView = JSON.stringify((await h.api('GET', `/api/g/${ev.guests[0]!.invite}`)).body);
    expect(guestView).not.toContain('anabuyer');
    const hostView = JSON.stringify((await h.api('GET', `/api/host/${ev.hostToken}/event`)).body);
    expect(hostView).not.toContain('anabuyer@');
    expect(hostView).toContain('an***@example.test');
  });

  it('sends no-store and no framework banner', async () => {
    const res = await fetch(`${h.base}/api/health`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('returns a safe JSON error for malformed bodies and unknown routes', async () => {
    const bad = await fetch(`${h.base}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.code).toBe('invalid_json');
    expect((await h.api('GET', '/api/nope')).status).toBe(404);
  });
});
