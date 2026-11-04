import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './harness.js';

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.close(); });

const HOUR = 3_600_000;

describe("a friend who can't make it", () => {
  it('releases their own hold before the cutoff: nothing charged, out of the event, not paid a share', async () => {
    const ev = await h.createEvent(); // starts in 24 h; the cutoff is 2 h before
    for (const g of ev.guests) await h.deposit(g.invite);
    const [ana, ben, cy, dee] = ev.guests as [typeof ev.guests[0], typeof ev.guests[0], typeof ev.guests[0], typeof ev.guests[0]];

    const before = await h.api('GET', `/api/g/${ben.invite}`);
    expect(before.body.cancel).toMatchObject({ state: null, can: 'release' });

    const r = await h.api('POST', `/api/g/${ben.invite}/cancel`);
    expect(r.status).toBe(200);
    expect(r.body.stage).toBe('cancelled');
    expect(r.body.outcome).toEqual({ kind: 'nothing_charged' });
    expect(r.body.canApprove).toBe(false);
    expect(r.body.cancel).toMatchObject({ state: 'released', can: null });
    expect(h.paypal.callsTo('voidAuthorization')).toBe(1);

    // Doing it twice voids nothing twice.
    expect((await h.api('POST', `/api/g/${ben.invite}/cancel`)).status).toBe(200);
    expect(h.paypal.callsTo('voidAuthorization')).toBe(1);

    // The host sees it as a fact, with the time.
    const host = await h.api('GET', `/api/host/${ev.hostToken}/event`);
    const benRow = host.body.guests[1];
    expect(benRow.stage).toBe('cancelled');
    expect(benRow.cancel).toMatchObject({ kind: 'released', minutesBeforeStart: 24 * 60 });

    // They cannot be marked as having come (that would make them a payout recipient).
    await h.api('POST', `/api/host/${ev.hostToken}/end`);
    const mark = await h.api('PUT', `/api/host/${ev.hostToken}/guests/${ben.id}/attendance`, { attendance: 'showed' });
    expect(mark.status).toBe(409);
    expect(mark.body.error.code).toBe('released');

    // Settlement: Ben needs no check-in; Ana and Cy came, Dee flaked and is charged. Ben is not paid.
    await h.api('PUT', `/api/host/${ev.hostToken}/guests/${ana.id}/attendance`, { attendance: 'showed' });
    await h.api('PUT', `/api/host/${ev.hostToken}/guests/${cy.id}/attendance`, { attendance: 'showed' });
    await h.api('PUT', `/api/host/${ev.hostToken}/guests/${dee.id}/attendance`, { attendance: 'no_show' });
    const dec = await h.api('PUT', `/api/host/${ev.hostToken}/guests/${dee.id}/decision`, { decision: 'capture' });
    expect(dec.body.canSettle).toBe(true);
    await h.api('POST', `/api/host/${ev.hostToken}/settle`, { approve: true });
    h.paypal.completePayouts();
    const done = await h.api('POST', `/api/host/${ev.hostToken}/settle`, { approve: true });
    expect(done.body.status).toBe('settled');
    expect(done.body.guests.map((g: any) => g.stage)).toEqual(['paid_out', 'cancelled', 'paid_out', 'captured']);
    expect(done.body.guests[1].payout).toBeNull();
    // One void for Ben's early release, two at settlement for Ana and Cy.
    expect(h.paypal.callsTo('voidAuthorization')).toBe(3);
    expect([...h.paypal.payouts.values()][0]!.items).toHaveLength(2);
  });

  it('can release before ever placing a hold, and then cannot place one', async () => {
    const ev = await h.createEvent({ names: ['Ana', 'Ben'] });
    const [ana] = ev.guests as [typeof ev.guests[0]];
    expect((await h.api('POST', `/api/g/${ana.invite}/cancel`)).body.stage).toBe('cancelled');
    expect(h.paypal.callsTo('voidAuthorization')).toBe(0);
    const start = await h.api('POST', `/api/g/${ana.invite}/deposit`);
    expect(start.status).toBe(409);
    expect(start.body.error.code).toBe('released');
    expect(h.paypal.callsTo('createAuthorizeOrder')).toBe(0);
  });

  it('after the cutoff it only warns the host: the hold stays and the host still decides', async () => {
    const ev = await h.createEvent({ names: ['Ana', 'Cy'] });
    for (const g of ev.guests) await h.deposit(g.invite);
    const cy = ev.guests[1]!;
    h.clock.now = new Date(h.clock.now.getTime() + 23 * HOUR); // 1 h before the start, past the 2 h cutoff

    const view = await h.api('GET', `/api/g/${cy.invite}`);
    expect(view.body.cancel.can).toBe('warn');
    const r = await h.api('POST', `/api/g/${cy.invite}/cancel`);
    expect(r.status).toBe(200);
    expect(r.body.cancel).toMatchObject({ state: 'late_notice', can: null });
    expect(r.body.stage).toBe('authorized'); // still holding
    expect(r.body.outcome.kind).toBe('held');
    expect(h.paypal.callsTo('voidAuthorization')).toBe(0);

    const host = await h.api('GET', `/api/host/${ev.hostToken}/event`);
    expect(host.body.guests[1].cancel).toMatchObject({ kind: 'late_notice', minutesBeforeStart: 60 });
    // Still needs the host's check-in and decision before money can move.
    await h.api('POST', `/api/host/${ev.hostToken}/end`);
    const after = await h.api('GET', `/api/host/${ev.hostToken}/event`);
    expect(after.body.canSettle).toBe(false);
  });

  it('is refused once the event has ended or the host has marked them', async () => {
    const ev = await h.createEvent({ names: ['Ana', 'Ben'] });
    for (const g of ev.guests) await h.deposit(g.invite);
    const [ana, ben] = ev.guests as [typeof ev.guests[0], typeof ev.guests[0]];
    await h.api('PUT', `/api/host/${ev.hostToken}/guests/${ana.id}/attendance`, { attendance: 'showed' });
    const marked = await h.api('POST', `/api/g/${ana.invite}/cancel`);
    expect(marked.status).toBe(409);
    expect(marked.body.error.code).toBe('already_marked');
    await h.api('POST', `/api/host/${ev.hostToken}/end`);
    const ended = await h.api('POST', `/api/g/${ben.invite}/cancel`);
    expect(ended.status).toBe(409);
    expect(ended.body.error.code).toBe('event_closed');
    expect(h.paypal.callsTo('voidAuthorization')).toBe(0);
  });
});
