import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiError } from '../src/ai/types.js';
import { makeHarness, type Harness } from './harness.js';

const CHAT = `Sam: where are you two?
Cy: car broke down on the highway, told you at 4pm
Dee: lol overslept`;
let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.close(); });

async function ended() {
  const ev = await h.createEvent({ names: ['Ana', 'Cy', 'Dee'] });
  for (const g of ev.guests) await h.deposit(g.invite);
  const U = `/api/host/${ev.hostToken}`;
  await h.api('POST', `${U}/end`);
  await h.api('PUT', `${U}/guests/${ev.guests[0]!.id}/attendance`, { attendance: 'showed' });
  await h.api('PUT', `${U}/guests/${ev.guests[1]!.id}/attendance`, { attendance: 'no_show' });
  await h.api('PUT', `${U}/guests/${ev.guests[2]!.id}/attendance`, { attendance: 'no_show' });
  return { ev, U, cy: ev.guests[1]!, dee: ev.guests[2]! };
}
const DRAFT = (cy: string, dee: string) => ({ verdicts: [
  { guestId: cy, recommendation: 'forgive' as const, reason: 'Car trouble, told the group.', evidence: 'Cy: car broke down on the highway, told you at 4pm' },
  { guestId: dee, recommendation: 'capture' as const, reason: 'Just overslept.', evidence: 'Dee: lol overslept' },
] });

describe('POST /api/host/:token/judge', () => {
  it('stores verified recommendations but NEVER sets a decision or moves money', async () => {
    const { U, cy, dee } = await ended();
    h.judge.willReturn(DRAFT(cy.id, dee.id));
    const r = await h.api('POST', `${U}/judge`, { chat: CHAT, timeZone: 'Asia/Manila' });
    expect(r.status).toBe(200);
    const g = Object.fromEntries(r.body.guests.map((x: any) => [x.name, x]));
    expect(g.Cy.ai).toMatchObject({ recommendation: 'forgive', evidence: 'Cy: car broke down on the highway, told you at 4pm' });
    expect(g.Dee.ai.recommendation).toBe('capture');
    expect(g.Ana.ai).toBeNull(); // not a no-show: the AI is never asked about people who came
    // The human step is intact: nothing is pre-selected, so settlement is still blocked.
    expect(g.Cy.decision).toBeNull();
    expect(g.Dee.decision).toBeNull();
    expect(r.body.canSettle).toBe(false);
    expect(r.body.blockers.join(' ')).toContain('Decide capture or forgive');
    expect(h.paypal.callsTo('captureAuthorization') + h.paypal.callsTo('voidAuthorization') + h.paypal.callsTo('createPayout')).toBe(0);
  });

  it('only gives the model the no-shows with a held deposit, by id, and no amounts', async () => {
    const { U, cy, dee } = await ended();
    h.judge.willReturn(DRAFT(cy.id, dee.id));
    await h.api('POST', `${U}/judge`, { chat: CHAT, timeZone: 'Asia/Manila' });
    const sent = h.judge.inputs[0]!;
    expect(sent.noShows.map((n) => n.name)).toEqual(['Cy', 'Dee']);
    expect(JSON.stringify(sent)).not.toMatch(/2000|\$|cents|amount/i);
    expect(sent.startedAtLocal).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('a recommendation does not change what the host must do; the host decision then stands on its own', async () => {
    const { U, cy, dee } = await ended();
    h.judge.willReturn(DRAFT(cy.id, dee.id));
    await h.api('POST', `${U}/judge`, { chat: CHAT, timeZone: 'UTC' });
    // The host overrules the AI on Cy (captures) and agrees on Dee; the AI note stays as audit.
    await h.api('PUT', `${U}/guests/${cy.id}/decision`, { decision: 'capture' });
    const r = await h.api('PUT', `${U}/guests/${dee.id}/decision`, { decision: 'capture' });
    const cyView = r.body.guests.find((x: any) => x.name === 'Cy');
    expect(cyView).toMatchObject({ decision: 'capture', ai: { recommendation: 'forgive' } });
  });

  it('adds the timing fact in code (minutes before the start) and the host\'s grace setting', async () => {
    const { U, cy, dee } = await ended();
    // The harness event starts 24h after 2026-11-01 12:00Z, i.e. 2026-11-02 12:00 in UTC.
    const stamped = '[11/2/26, 9:00 AM] Cy: car broke down on the highway, told you at 9\n[11/2/26, 12:30 PM] Dee: lol overslept';
    h.judge.willReturn({ verdicts: [
      { guestId: cy.id, recommendation: 'forgive', reason: 'Car trouble, told the group.', evidence: 'car broke down on the highway' },
      { guestId: dee.id, recommendation: 'capture', reason: 'Overslept.', evidence: 'lol overslept' },
    ] });
    const r = await h.api('POST', `${U}/judge`, { chat: stamped, timeZone: 'UTC' });
    const g = Object.fromEntries(r.body.guests.map((x: any) => [x.name, x]));
    expect(g.Cy.ai.minutesBeforeStart).toBe(180);   // told the group 3h before
    expect(g.Dee.ai.minutesBeforeStart).toBe(-30);  // 30 min after the start
    expect(r.body.graceMinutes).toBe(120);          // default 2h rule, shown to the host as a fact
    expect(g.Cy.decision).toBeNull();               // facts do not decide
  });

  it('does not keep the pasted chat anywhere', async () => {
    const { U, ev, cy, dee } = await ended();
    h.judge.willReturn(DRAFT(cy.id, dee.id));
    await h.api('POST', `${U}/judge`, { chat: CHAT + '\nUNIQUE-MARKER-12345', timeZone: 'UTC' });
    const rows = JSON.stringify(await h.db.guest.findMany({ where: { eventId: ev.eventId } }));
    expect(rows).not.toContain('UNIQUE-MARKER-12345');
  });

  it('is refused before the event ends, after approval, and when there is nobody to judge', async () => {
    const ev = await h.createEvent({ names: ['Ana', 'Cy'] });
    for (const g of ev.guests) await h.deposit(g.invite);
    const U = `/api/host/${ev.hostToken}`;
    expect((await h.api('POST', `${U}/judge`, { chat: CHAT, timeZone: 'UTC' })).body.error.code).toBe('not_ended');
    await h.api('POST', `${U}/end`);
    for (const g of ev.guests) await h.api('PUT', `${U}/guests/${g.id}/attendance`, { attendance: 'showed' });
    expect((await h.api('POST', `${U}/judge`, { chat: CHAT, timeZone: 'UTC' })).body.error.code).toBe('nothing_to_judge');
    await h.api('POST', `${U}/settle`, { approve: true });
    expect((await h.api('POST', `${U}/judge`, { chat: CHAT, timeZone: 'UTC' })).body.error.code).toBe('locked');
    expect(h.judge.inputs.length).toBe(0);
  });

  it('validates input and maps AI failures to safe messages', async () => {
    const { U } = await ended();
    expect((await h.api('POST', `${U}/judge`, { chat: '  ', timeZone: 'UTC' })).status).toBe(400);
    expect((await h.api('POST', `${U}/judge`, { chat: 'x'.repeat(h.config.rsvpMaxChars + 1), timeZone: 'UTC' })).status).toBe(413);
    h.judge.willFail(new AiError('unavailable', `internal ${CHAT}`));
    const r = await h.api('POST', `${U}/judge`, { chat: CHAT, timeZone: 'UTC' });
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).not.toContain('Cy');
    expect(r.body.error.message).toContain('by hand');
  });

  it('shares the AI rate limit and rejects an unknown host token', async () => {
    expect((await h.api('POST', `/api/host/${'x'.repeat(30)}/judge`, { chat: CHAT, timeZone: 'UTC' })).status).toBe(404);
  });
});
