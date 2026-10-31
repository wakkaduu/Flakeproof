import { afterEach, describe, expect, it } from 'vitest';
import { estimateCaptureNet } from '../src/domain/money.js';
import { makeHarness, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => { await h?.close(); });

async function ready(names: string[], depositCents = 2000) {
  const ev = await h.createEvent({ names, depositCents });
  for (const g of ev.guests) await h.deposit(g.invite);
  await h.api('POST', `/api/host/${ev.hostToken}/end`);
  const U = `/api/host/${ev.hostToken}`;
  const mark = (i: number, attendance: 'showed' | 'no_show') => h.api('PUT', `${U}/guests/${ev.guests[i]!.id}/attendance`, { attendance });
  const decide = (i: number, decision: 'capture' | 'forgive') => h.api('PUT', `${U}/guests/${ev.guests[i]!.id}/decision`, { decision });
  const settle = () => h.api('POST', `${U}/settle`, { approve: true });
  const view = () => h.api('GET', `${U}/event`);
  return { ev, mark, decide, settle, view };
}

describe('estimateCaptureNet matches what the real sandbox did', () => {
  const fee = { bps: 349, fixedCents: 49 };
  it('reproduces the three observed captures (to within the 1c we round up)', () => {
    expect(estimateCaptureNet(500, fee)).toBe(434 - 1); // observed net 434 ($5.00)
    expect(estimateCaptureNet(1000, fee)).toBe(916);    // observed net 916 ($10.00)
    expect(estimateCaptureNet(2000, fee)).toBe(1881);   // fake model; formula agrees with both real points
  });
  it('never goes negative and rejects bad input', () => {
    expect(estimateCaptureNet(10, fee)).toBe(0);
    expect(() => estimateCaptureNet(1.5, fee)).toThrow();
  });
});

describe('money can never be captured into a pot nobody can receive', () => {
  it('blocks capturing when no one who came can be paid, and nothing moves', async () => {
    h = await makeHarness();
    const { ev, mark, decide, settle, view } = await ready(['Ana', 'Ben']);
    await mark(0, 'no_show'); await mark(1, 'no_show');
    await decide(1, 'capture');
    const d = await decide(0, 'capture');
    const v = (await view()).body;
    expect(v.blockers.join(' ')).toContain('nobody to give the money to');
    expect(d.body.canSettle).toBe(false);
    expect((await settle()).status).toBe(409);
    expect(h.paypal.callsTo('captureAuthorization') + h.paypal.callsTo('voidAuthorization')).toBe(0);
    // forgiving everyone is allowed and settles with no payout
    await decide(0, 'forgive'); await decide(1, 'forgive');
    expect((await settle()).body.status).toBe('settled');
    expect(ev.guests.length).toBe(2);
  });

  it('exposes an honest estimate of the payout before the host approves', async () => {
    h = await makeHarness();
    const { mark, decide, view } = await ready(['Ana', 'Ben', 'Cy', 'Dee']);
    await mark(0, 'showed'); await mark(1, 'showed'); await mark(2, 'showed'); await mark(3, 'no_show');
    await decide(3, 'capture');
    const p = (await view()).body.payoutPreview;
    expect(p).toMatchObject({ provisional: false, capturingCount: 1, recipientCount: 3, estimatedPotCents: 1881, estimatedPerPersonCents: 602, problem: null, unpayableNames: [] });
  });

  it('marks the preview provisional while someone is unmarked', async () => {
    h = await makeHarness();
    const { mark, view } = await ready(['Ana', 'Ben']);
    await mark(0, 'showed');
    expect((await view()).body.payoutPreview.provisional).toBe(true);
  });

  it('warns when someone who came has no PayPal email, and pays only the others', async () => {
    h = await makeHarness();
    const { ev, mark, decide, settle, view } = await ready(['Ana', 'Ben', 'Cy']);
    await h.db.deposit.updateMany({ where: { guestId: ev.guests[1]!.id }, data: { payerEmail: null } });
    await mark(0, 'showed'); await mark(1, 'showed'); await mark(2, 'no_show');
    await decide(2, 'capture');
    const v = (await view()).body;
    expect(v.problems.join(' ')).toContain('Ben: PayPal gave no email');
    expect(v.payoutPreview).toMatchObject({ recipientCount: 1, unpayableNames: ['Ben'] });
    h.paypal.completePayouts();
    const r = await settle();
    expect(r.status).toBe(200);
    const batch = [...h.paypal.payouts.values()][0]!;
    expect(batch.items.length).toBe(1); // only Ana is paid; the pot is not split with Ben
  });

  it('if the estimate was optimistic and the real pot is too small, it says so loudly instead of silently settling', async () => {
    // Estimate thinks there are no fees; the (fake) PayPal charges 49c + 3.49%.
    h = await makeHarness({ captureFeeBps: 0, captureFeeFixedCents: 0 });
    const { mark, decide, settle } = await ready(['Ana', 'Ben'], 150);
    await mark(0, 'showed'); await mark(1, 'no_show');
    await decide(1, 'capture');
    const r = await settle();
    expect(r.status).toBe(200);
    expect(r.body.payout).toMatchObject({ status: 'SKIPPED', skippedReason: 'pot_too_small' });
    expect(r.body.problems.join(' ')).toContain('was captured but could not be paid out');
  });
});

describe('abuse and hardening', () => {
  it('rate limits event creation per client', async () => {
    h = await makeHarness({ eventsPerMinute: 2 });
    const ok: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await h.api('POST', '/api/events', { title: 'x', startsAt: new Date(h.clock.now.getTime() + 3_600_000).toISOString(), depositCents: 1000, guests: [{ name: 'A' }] });
      ok.push(r.status);
    }
    expect(ok).toEqual([201, 201, 429, 429]);
  });

  it('without trust proxy all clients share one bucket; with it, each forwarded IP gets its own', async () => {
    const body = { chat: 'Sam: $5', timeZone: 'UTC' };
    h = await makeHarness({ rsvpPerMinute: 1 });
    await h.api('POST', '/api/rsvp/parse', body, { 'x-forwarded-for': '1.1.1.1' });
    expect((await h.api('POST', '/api/rsvp/parse', body, { 'x-forwarded-for': '2.2.2.2' })).status).toBe(429);
    await h.close();
    h = await makeHarness({ rsvpPerMinute: 1 }, { trustProxy: 1 });
    await h.api('POST', '/api/rsvp/parse', body, { 'x-forwarded-for': '1.1.1.1' });
    expect((await h.api('POST', '/api/rsvp/parse', body, { 'x-forwarded-for': '2.2.2.2' })).status).not.toBe(429);
    expect((await h.api('POST', '/api/rsvp/parse', body, { 'x-forwarded-for': '1.1.1.1' })).status).toBe(429);
  });

  it('sets a strict CSP and anti-framing headers on every response', async () => {
    h = await makeHarness();
    const res = await fetch(`${h.base}/api/health`);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});
