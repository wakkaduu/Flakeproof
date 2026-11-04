import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './harness.js';

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.close(); });

const DAY = 86_400_000;
const create = async (over: object = {}) => {
  const r = await h.api('POST', '/api/events', { title: 'Court booking', startsAt: new Date(h.clock.now.getTime() + 24 * 3_600_000).toISOString(), depositCents: 2000, ...over });
  expect(r.status).toBe(201);
  const code = (r.body.joinUrl as string).split('/').pop()!;
  return { r, code, hostToken: r.body.hostToken as string };
};

describe('the one link for the group chat', () => {
  it('is created with the event, needs no names, and never shows anyone\'s personal link', async () => {
    const { r, code } = await create();
    expect(r.body.joinUrl).toBe(`http://localhost:5173/e/${code}`);
    expect(r.body.event.joinUrl).toBe(r.body.joinUrl);
    const v = await h.api('GET', `/api/join/${code}`);
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ joinable: true, canAddName: true, joinedCount: 0, names: [], holds: { state: 'open' } });
    expect(JSON.stringify(v.body)).not.toMatch(/inviteToken|\/g\//);
  });

  it('lets people type their own name and gives each their own link, which works like any invite', async () => {
    const { code, hostToken } = await create();
    const a = await h.api('POST', `/api/join/${code}`, { name: '  Ana ' });
    expect(a.status).toBe(201);
    expect(a.body.name).toBe('Ana');
    const token = a.body.inviteUrl.split('/').pop();
    expect(token).toBe(a.body.inviteToken);
    await h.deposit(token);
    const host = await h.api('GET', `/api/host/${hostToken}/event`);
    expect(host.body.guests).toHaveLength(1);
    expect(host.body.guests[0]).toMatchObject({ name: 'Ana', joined: true, stage: 'authorized' });
  });

  it('lets a listed name be claimed exactly once, and does not leak whether it was a stranger', async () => {
    const { code } = await create({ guests: [{ name: 'Ana' }, { name: 'Ben' }] });
    const v = await h.api('GET', `/api/join/${code}`);
    expect(v.body.names.map((n: any) => [n.name, n.taken])).toEqual([['Ana', false], ['Ben', false]]);
    const ana = v.body.names[0];
    expect((await h.api('POST', `/api/join/${code}`, { guestId: ana.id })).status).toBe(201);
    const again = await h.api('POST', `/api/join/${code}`, { guestId: ana.id });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_claimed');
    const after = await h.api('GET', `/api/join/${code}`);
    expect(after.body.names[0].taken).toBe(true);
    expect(after.body.joinedCount).toBe(1);
  });

  it('refuses a name that is already there, any case, and an event that is full', async () => {
    const { code } = await create({ guests: [{ name: 'Ana' }] });
    const dup = await h.api('POST', `/api/join/${code}`, { name: 'ANA' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('name_taken');
    h.config.maxGuests = 2;
    expect((await h.api('POST', `/api/join/${code}`, { name: 'Ben' })).status).toBe(201);
    const full = await h.api('POST', `/api/join/${code}`, { name: 'Cy' });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('full');
  });

  it('validates the body and the link', async () => {
    const { code } = await create();
    expect((await h.api('POST', `/api/join/${code}`, {})).status).toBe(400);
    expect((await h.api('POST', `/api/join/${code}`, { name: '   ' })).status).toBe(400);
    expect((await h.api('POST', `/api/join/${code}`, { name: 'x'.repeat(61) })).status).toBe(400);
    expect((await h.api('POST', `/api/join/${code}`, { guestId: 'nope' })).status).toBe(404);
    expect((await h.api('GET', `/api/join/${'z'.repeat(32)}`)).status).toBe(404);
    expect((await h.api('GET', '/api/join/short')).status).toBe(400);
  });

  it('is rate limited, because it is pasted into a group chat anyone can forward', async () => {
    const lim = await makeHarness({ joinsPerMinute: 2 });
    try {
      const r = await lim.api('POST', '/api/events', { title: 'x', startsAt: new Date(lim.clock.now.getTime() + 3_600_000).toISOString(), depositCents: 500 });
      const code = r.body.joinUrl.split('/').pop();
      expect((await lim.api('POST', `/api/join/${code}`, { name: 'A' })).status).toBe(201);
      expect((await lim.api('POST', `/api/join/${code}`, { name: 'B' })).status).toBe(201);
      expect((await lim.api('POST', `/api/join/${code}`, { name: 'C' })).status).toBe(429);
    } finally { await lim.close(); }
  });

  it('closes once the event has started or ended', async () => {
    const { code, hostToken } = await create();
    await h.api('POST', `/api/host/${hostToken}/end`);
    const r = await h.api('POST', `/api/join/${code}`, { name: 'Late' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('closed');
    expect((await h.api('GET', `/api/join/${code}`)).body.joinable).toBe(false);
  });

  it('lets the host take a name off before it has a hold, and not after', async () => {
    const { code, hostToken } = await create();
    const a = await h.api('POST', `/api/join/${code}`, { name: 'Typo' });
    const b = await h.api('POST', `/api/join/${code}`, { name: 'Ben' });
    await h.deposit(b.body.inviteToken);
    let host = await h.api('GET', `/api/host/${hostToken}/event`);
    const [typo, ben] = host.body.guests;
    expect((await h.api('DELETE', `/api/host/${hostToken}/guests/${typo.id}`)).status).toBe(200);
    const refused = await h.api('DELETE', `/api/host/${hostToken}/guests/${ben.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('has_hold');
    host = await h.api('GET', `/api/host/${hostToken}/event`);
    expect(host.body.guests.map((g: any) => g.name)).toEqual(['Ben']);
    expect((await h.api('GET', `/api/g/${a.body.inviteToken}`)).status).toBe(404); // the removed person's link no longer works
  });
});

describe('when holds open', () => {
  it('lets friends join a week ahead but only opens holds 3 days before the start, then closes them at the start', async () => {
    const { code, hostToken } = await create({ startsAt: new Date(h.clock.now.getTime() + 7 * DAY).toISOString() });
    const a = await h.api('POST', `/api/join/${code}`, { name: 'Ana' });
    const invite = a.body.inviteToken;

    const early = await h.api('GET', `/api/g/${invite}`);
    expect(early.body.holds.state).toBe('not_yet');
    expect(early.body.canApprove).toBe(false);
    const tooSoon = await h.api('POST', `/api/g/${invite}/deposit`);
    expect(tooSoon.status).toBe(409);
    expect(tooSoon.body.error.code).toBe('holds_not_open');
    expect(h.paypal.callsTo('createAuthorizeOrder')).toBe(0);
    expect((await h.api('GET', `/api/host/${hostToken}/event`)).body.warnings[0]).toContain('deposits open 3 days before the start');

    h.clock.now = new Date(h.clock.now.getTime() + 4.5 * DAY); // 2.5 days before the start
    const open = await h.api('GET', `/api/g/${invite}`);
    expect(open.body.holds.state).toBe('open');
    expect(open.body.canApprove).toBe(true);
    await h.deposit(invite);

    h.clock.now = new Date(h.clock.now.getTime() + 3 * DAY); // after the start
    const b = await h.api('POST', `/api/join/${code}`, { name: 'Ben' });
    expect(b.status).toBe(409); // nobody can join an event that has started
    const closed = await h.api('GET', `/api/g/${invite}`);
    expect(closed.body.holds.state).toBe('closed');
  });

  it('refuses a new hold after the start, but lets someone who already approved on PayPal finish', async () => {
    const { code } = await create();
    const a = await h.api('POST', `/api/join/${code}`, { name: 'Ana' });
    const b = await h.api('POST', `/api/join/${code}`, { name: 'Ben' });
    const s = await h.api('POST', `/api/g/${a.body.inviteToken}/deposit`); // Ana opens PayPal before the start
    h.paypal.approveOrder(s.body.approveUrl.split('/').pop(), 'ana@buyer.test');
    h.clock.now = new Date(h.clock.now.getTime() + 25 * 3_600_000);
    const late = await h.api('POST', `/api/g/${b.body.inviteToken}/deposit`);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('started');
    expect((await h.api('POST', `/api/g/${a.body.inviteToken}/authorize`)).status).toBe(200);
  });
});

describe('per-event rules', () => {
  it('uses the host\'s free-cancellation cutoff, not a fixed one', async () => {
    const { code, hostToken } = await create({ graceHours: 12 });
    const a = await h.api('POST', `/api/join/${code}`, { name: 'Ana' });
    await h.deposit(a.body.inviteToken);
    expect((await h.api('GET', `/api/host/${hostToken}/event`)).body.graceMinutes).toBe(720);
    h.clock.now = new Date(h.clock.now.getTime() + 13 * 3_600_000); // 11 h before the start: past a 12 h cutoff
    expect((await h.api('GET', `/api/g/${a.body.inviteToken}`)).body.cancel.can).toBe('warn');
  });

  it('the host can keep a no-show\'s deposit: charged, nothing paid out, settles at once', async () => {
    const { code, hostToken } = await create({ potMode: 'keep' });
    const a = await h.api('POST', `/api/join/${code}`, { name: 'Ana' });
    const c = await h.api('POST', `/api/join/${code}`, { name: 'Cy' });
    await h.deposit(a.body.inviteToken); await h.deposit(c.body.inviteToken);
    await h.api('POST', `/api/host/${hostToken}/end`);
    const host = (await h.api('GET', `/api/host/${hostToken}/event`)).body;
    await h.api('PUT', `/api/host/${hostToken}/guests/${host.guests[0].id}/attendance`, { attendance: 'showed' });
    await h.api('PUT', `/api/host/${hostToken}/guests/${host.guests[1].id}/attendance`, { attendance: 'no_show' });
    const dec = await h.api('PUT', `/api/host/${hostToken}/guests/${host.guests[1].id}/decision`, { decision: 'capture' });
    expect(dec.body.canSettle).toBe(true);
    expect(dec.body.payoutPreview).toMatchObject({ mode: 'keep', capturingCount: 1, recipientCount: 0, problem: null });
    const done = await h.api('POST', `/api/host/${hostToken}/settle`, { approve: true });
    expect(done.body.status).toBe('settled');
    expect(h.paypal.callsTo('captureAuthorization')).toBe(1);
    expect(h.paypal.callsTo('createPayout')).toBe(0);
    expect(done.body.payout).toMatchObject({ status: 'SKIPPED', skippedReason: 'kept_by_host', potCents: 1881 });
    expect(done.body.problems).toEqual([]); // kept on purpose, not a problem
    expect(done.body.guests.map((g: any) => g.stage)).toEqual(['voided', 'captured']);
  });

  it('keep mode works even when nobody who came has a PayPal email, which share mode would refuse', async () => {
    const { code, hostToken } = await create({ potMode: 'keep' });
    const c = await h.api('POST', `/api/join/${code}`, { name: 'Cy' });
    await h.deposit(c.body.inviteToken);
    await h.api('POST', `/api/host/${hostToken}/end`);
    const g = (await h.api('GET', `/api/host/${hostToken}/event`)).body.guests[0];
    await h.api('PUT', `/api/host/${hostToken}/guests/${g.id}/attendance`, { attendance: 'no_show' });
    const dec = await h.api('PUT', `/api/host/${hostToken}/guests/${g.id}/decision`, { decision: 'capture' });
    expect(dec.body.canSettle).toBe(true);
  });
});

describe('everyone came', () => {
  it('marks everyone with a hold who is not marked yet, and leaves the rest alone', async () => {
    const { code, hostToken } = await create();
    const names = ['Ana', 'Ben', 'Cy', 'Dee'];
    const joined: any[] = [];
    for (const name of names) joined.push(await h.api('POST', `/api/join/${code}`, { name })); // one at a time, so the order is the join order
    for (const j of joined.slice(0, 3)) await h.deposit(j.body.inviteToken); // Dee never puts a hold
    await h.api('POST', `/api/g/${joined[1]!.body.inviteToken}/cancel`); // Ben releases his spot
    await h.api('POST', `/api/host/${hostToken}/end`);
    const before = (await h.api('GET', `/api/host/${hostToken}/event`)).body.guests;
    await h.api('PUT', `/api/host/${hostToken}/guests/${before[2].id}/attendance`, { attendance: 'no_show' }); // Cy flaked
    const r = await h.api('POST', `/api/host/${hostToken}/attendance/all-came`, {});
    expect(r.status).toBe(200);
    expect(r.body.guests.map((g: any) => g.attendance)).toEqual(['showed', 'unknown', 'no_show', 'unknown']);
  });
});
