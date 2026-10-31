import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiError, type RsvpDraft } from '../src/ai/types.js';
import { localNow } from '../src/services/rsvp.js';
import { makeHarness, type Harness } from './harness.js';

const CHAT = "Sam: court Saturday 6pm, $15 each\nAna: I'm in!\nBen: maybe";
const DRAFT: RsvpDraft = {
  organizer: 'Sam', title: 'Court', startsAtLocal: '2026-11-07T18:00', depositCents: 1500, depositEvidence: 'Sam: court Saturday 6pm, $15 each',
  guests: [
    { name: 'Ana', rsvp: 'in', evidence: "Ana: I'm in!" },
    { name: 'Ben', rsvp: 'maybe', evidence: 'Ben: maybe' },
    { name: 'Ghost', rsvp: 'in', evidence: 'Ghost: in' },
  ],
  questions: ['Is Ben coming?'],
};
let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.close(); });
const parse = (body: unknown) => h.api('POST', '/api/rsvp/parse', body);

describe('POST /api/rsvp/parse', () => {
  it('returns a verified proposal, drops the invented guest, and creates nothing', async () => {
    h.rsvp.willReturn(DRAFT);
    const r = await parse({ chat: CHAT, timeZone: 'Asia/Manila' });
    expect(r.status).toBe(200);
    expect(r.body.guests.map((g: any) => g.name)).toEqual(['Ana', 'Ben']);
    expect(r.body.depositCents).toBe(1500);
    expect(r.body.questions).toContain('Is Ben coming?');
    expect(r.body.notes.join(' ')).toContain('Ghost');
    expect(await h.db.event.count()).toBe(0);
    expect(h.paypal.calls.length).toBe(0); // the AI route can never touch money
  });

  it('gives the model the host\'s local time, not the server\'s', async () => {
    h.rsvp.willReturn(DRAFT);
    h.clock.now = new Date('2026-10-31T20:30:00Z'); // 04:30 next day in Manila
    await parse({ chat: CHAT, timeZone: 'Asia/Manila' });
    expect(h.rsvp.inputs[0]!.now).toEqual({ localIso: '2026-11-01T04:30', weekday: 'Sunday', timeZone: 'Asia/Manila' });
  });

  it('validates input', async () => {
    expect((await parse({ chat: '   ', timeZone: 'Asia/Manila' })).status).toBe(400);
    expect((await parse({ timeZone: 'Asia/Manila' })).status).toBe(400);
    expect((await parse({ chat: CHAT, timeZone: 'Mars/Olympus' })).body.error.code).toBe('invalid_time_zone');
    const big = await parse({ chat: 'x'.repeat(h.config.rsvpMaxChars + 1), timeZone: 'UTC' });
    expect(big.status).toBe(413);
    expect(h.rsvp.inputs.length).toBe(0);
  });

  it('maps AI failures to safe messages that never contain the chat', async () => {
    for (const [kind, status] of [['unavailable', 503], ['misconfigured', 502], ['invalid_output', 502], ['blocked', 422]] as const) {
      h.rsvp.willFail(new AiError(kind, `internal ${CHAT}`));
      const r = await parse({ chat: CHAT, timeZone: 'UTC' });
      expect(r.status).toBe(status);
      expect(r.body.error.code).toBe(`ai_${kind}`);
      expect(JSON.stringify(r.body)).not.toContain('Ana');
      expect(r.body.error.message).toContain('by hand');
    }
  });

  it('rate limits so the free AI quota cannot be burned by one client', async () => {
    h.rsvp.willReturn(DRAFT);
    const ok: number[] = [];
    for (let i = 0; i < h.config.rsvpPerMinute + 2; i++) ok.push((await parse({ chat: CHAT, timeZone: 'UTC' })).status);
    expect(ok.filter((s) => s === 429).length).toBe(2);
    const limited = await parse({ chat: CHAT, timeZone: 'UTC' });
    expect(limited.body.error.code).toBe('rate_limited');
  });

  it('says so plainly when no AI is configured', async () => {
    const { createApp } = await import('../src/app.js');
    const { KeyedMutex } = await import('../src/util.js');
    const app = createApp({ db: h.db, paypal: h.paypal, rsvp: null, judge: null, config: h.config, mutex: new KeyedMutex(), now: () => new Date() });
    const server = await new Promise<import('node:http').Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/rsvp/parse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat: CHAT, timeZone: 'UTC' }) });
      expect(res.status).toBe(503);
      expect(((await res.json()) as any).error.code).toBe('ai_not_configured');
    } finally { await new Promise<void>((r) => server.close(() => r())); }
  });

  it('a proposal can become an event only through the normal, validated create route', async () => {
    h.rsvp.willReturn(DRAFT);
    const p = (await parse({ chat: CHAT, timeZone: 'Asia/Manila' })).body;
    const created = await h.api('POST', '/api/events', {
      title: p.title, startsAt: new Date(h.clock.now.getTime() + 3_600_000).toISOString(),
      depositCents: p.depositCents, guests: p.guests.filter((g: any) => g.rsvp === 'in').map((g: any) => ({ name: g.name })),
    });
    expect(created.status).toBe(201);
    expect(created.body.event.guests.map((g: any) => g.name)).toEqual(['Ana']);
  });
});

describe('localNow', () => {
  it('formats in the given zone', () => {
    expect(localNow(new Date('2026-10-31T14:05:00Z'), 'UTC')).toEqual({ localIso: '2026-10-31T14:05', weekday: 'Saturday', timeZone: 'UTC' });
    expect(localNow(new Date('2026-10-31T14:05:00Z'), 'America/Los_Angeles').localIso).toBe('2026-10-31T07:05');
  });
});
