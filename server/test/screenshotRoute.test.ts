import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GeminiScreenshotModel } from '../src/ai/gemini.js';
import type { ShotDraft } from '../src/ai/transcribe.js';
import { AiError } from '../src/ai/types.js';
import { makeHarness, type Harness } from './harness.js';

// A real 1x1 PNG, and a JPEG/WebP header padded to a plausible size.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]).toString('base64');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(200)]).toString('base64');

const shot = (...m: Partial<ShotDraft['messages'][number]>[]): ShotDraft => ({
  messages: m.map((x) => ({ author: null, fromHost: false, kind: 'text' as const, text: '', time: null, partial: false, ...x })),
});
const DRAFT = shot(
  { kind: 'date', text: 'Tue, 3 Nov' },
  { author: 'Ana', text: 'in for sunday too &#128077;', time: '10:31' },
  { author: 'Ben', text: 'cut off', partial: true },
  { fromHost: true, author: 'me', text: 'ok, $20 each', time: '10:35' },
);

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.close(); });
const read = (body: unknown) => h.api('POST', '/api/rsvp/screenshot', body);
const assemble = (body: unknown) => h.api('POST', '/api/rsvp/transcript', body);

describe('POST /api/rsvp/screenshot', () => {
  it('reads one image into cleaned messages, creates nothing and never touches PayPal', async () => {
    h.screens.willReturn(DRAFT);
    const r = await read({ mimeType: 'image/png', data: PNG });
    expect(r.status).toBe(200);
    expect(r.body.messages).toEqual([
      { author: null, fromHost: false, kind: 'date', text: 'Tue, 3 Nov', time: null },
      { author: 'Ana', fromHost: false, kind: 'text', text: 'in for sunday too 👍', time: '10:31' },
      { author: null, fromHost: true, kind: 'text', text: 'ok, $20 each', time: '10:35' },
    ]);
    expect(h.screens.inputs).toEqual([{ mimeType: 'image/png', bytes: Buffer.from(PNG, 'base64').length }]);
    expect(await h.db.event.count()).toBe(0);
    expect(h.paypal.calls.length).toBe(0);
  });

  it('accepts JPEG and WebP', async () => {
    h.screens.willReturn(shot()).willReturn(shot());
    expect((await read({ mimeType: 'image/jpeg', data: JPEG })).status).toBe(200);
    expect((await read({ mimeType: 'image/webp', data: WEBP })).status).toBe(200);
  });

  it('rejects anything that is not really the image type it claims, before the model is called', async () => {
    const cases: [string, unknown][] = [
      ['unsupported type', { mimeType: 'image/gif', data: PNG }],
      ['no data', { mimeType: 'image/png' }],
      ['not base64', { mimeType: 'image/png', data: 'not base64 at all!! '.repeat(10) }],
      ['png bytes labelled jpeg', { mimeType: 'image/jpeg', data: PNG }],
      ['text labelled png', { mimeType: 'image/png', data: Buffer.from('<html>' + 'x'.repeat(200)).toString('base64') }],
    ];
    for (const [name, body] of cases) {
      const r = await read(body);
      expect(r.status, name).toBe(400);
    }
    expect((await read({ mimeType: 'image/jpeg', data: PNG })).body.error.code).toBe('invalid_image');
    expect(h.screens.inputs.length).toBe(0);
  });

  it('refuses an image over the size limit (413) while ordinary routes keep their small limit', async () => {
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2_300_000)]).toString('base64');
    const r = await read({ mimeType: 'image/jpeg', data: big });
    expect([400, 413]).toContain(r.status); // zod max (400) or the body limit (413): either way it never reaches the model
    expect(h.screens.inputs.length).toBe(0);
    const chat = await h.api('POST', '/api/rsvp/parse', { chat: 'x'.repeat(60_000), timeZone: 'UTC' });
    expect(chat.status).toBe(413);
    expect(chat.body.error.code).toBe('payload_too_large');
  });

  it('maps AI failures to safe messages that never contain what was read', async () => {
    for (const [kind, status] of [['unavailable', 503], ['misconfigured', 502], ['invalid_output', 502], ['blocked', 422]] as const) {
      h.screens.willFail(new AiError(kind, 'internal Ana: in for sunday'));
      const r = await read({ mimeType: 'image/png', data: PNG });
      expect(r.status).toBe(status);
      expect(r.body.error.code).toBe(`ai_${kind}`);
      expect(JSON.stringify(r.body)).not.toContain('Ana');
    }
  });

  it('has its own rate limit (one call per image)', async () => {
    await h.close();
    h = await makeHarness({ screenshotsPerMinute: 2 });
    h.screens.willReturn(shot()).willReturn(shot()).willReturn(shot());
    expect((await read({ mimeType: 'image/png', data: PNG })).status).toBe(200);
    expect((await read({ mimeType: 'image/png', data: PNG })).status).toBe(200);
    const limited = await read({ mimeType: 'image/png', data: PNG });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
    expect(h.screens.inputs.length).toBe(2);
  });

  it('says so plainly when no AI is configured', async () => {
    const { createApp } = await import('../src/app.js');
    const { KeyedMutex } = await import('../src/util.js');
    const app = createApp({ db: h.db, paypal: h.paypal, rsvp: null, judge: null, screens: null, config: h.config, mutex: new KeyedMutex(), now: () => new Date() });
    const server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/rsvp/screenshot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mimeType: 'image/png', data: PNG }) });
      expect(res.status).toBe(503);
      expect(((await res.json()) as any).error.code).toBe('ai_not_configured');
    } finally { await new Promise<void>((r) => server.close(() => r())); }
  });
});

describe('POST /api/rsvp/transcript', () => {
  const T = (author: string, text: string, time: string) => ({ author, fromHost: false, kind: 'text', text, time });
  const HOST = (text: string, time: string) => ({ author: null, fromHost: true, kind: 'text', text, time });
  const DATE = (text: string) => ({ author: null, fromHost: false, kind: 'date', text, time: null });

  it('merges overlapping screenshots into one transcript, with no AI call', async () => {
    const r = await assemble({
      hostName: 'Sam',
      shots: [[DATE('Tue, 3 Nov'), HOST('deposit $20', '10:00'), T('Ana', 'in', '10:05')], [T('Ana', 'in', '10:05'), T('Ben', 'in too', '10:06')]],
    });
    expect(r.status).toBe(200);
    expect(r.body.chat.split('\n')).toEqual([
      '[Tue, 3 Nov 10:00] Sam: deposit $20', '[Tue, 3 Nov 10:05] Ana: in', '[Tue, 3 Nov 10:06] Ben: in too',
    ]);
    expect(r.body.messageCount).toBe(3);
    expect(r.body.warnings).toEqual([]);
    expect(h.screens.inputs.length).toBe(0);
  });

  it('needs the host\'s name only when the host wrote something', async () => {
    const hostOnly = { shots: [[HOST('hi', '10:00')]] };
    const r = await assemble(hostOnly);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('host_name_required');
    expect((await assemble({ ...hostOnly, hostName: '   ' })).body.error.code).toBe('host_name_required');
    expect((await assemble({ shots: [[T('Ana', 'in', '10:00')]] })).status).toBe(200);
  });

  it('validates the shape and caps the number of screenshots at 8', async () => {
    expect((await assemble({ shots: [] })).status).toBe(400);
    expect((await assemble({})).status).toBe(400);
    expect((await assemble({ shots: [[{ author: 'x', kind: 'bogus' }]] })).status).toBe(400);
    const nine = Array.from({ length: 9 }, () => [T('Ana', 'in', '10:00')]);
    expect((await assemble({ shots: nine })).status).toBe(400);
  });

  it('warns when the transcript is longer than the AI will read', async () => {
    await h.close();
    h = await makeHarness({ rsvpMaxChars: 40 });
    const r = await assemble({ shots: [[T('Ana', 'a fairly long message that goes past the limit', '10:00')]] });
    expect(r.status).toBe(200);
    expect(r.body.warnings.join(' ')).toMatch(/at most 40 can be read/);
  });
});

describe('GeminiScreenshotModel', () => {
  let server: http.Server; let base: string; let seen: any[]; let status = 200;
  const wrap = (obj: unknown) => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(obj) }] } }] });
  beforeEach(async () => {
    seen = []; status = 200;
    server = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => { seen.push({ url: req.url, headers: req.headers, body: JSON.parse(b) }); res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(status === 200 ? wrap({ messages: [{ author: 'Ana', fromHost: false, kind: 'text', text: 'in', time: '10:05', partial: false }] }) : { error: { status: 'X' } })); });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));
  const model = () => new GeminiScreenshotModel({ apiKey: 'k-secret', model: 'vision-test', baseUrlForTests: base, retryDelayMs: 1, timeoutMs: 1000 });

  it('sends the image before the instruction, the key in a header, and returns validated output', async () => {
    const out = await model().transcribe({ mimeType: 'image/png', data: PNG });
    expect(out.messages[0]!.text).toBe('in');
    const r = seen[0];
    expect(r.url).toBe('/v1beta/models/vision-test:generateContent');
    expect(r.url).not.toContain('k-secret');
    expect(r.headers['x-goog-api-key']).toBe('k-secret');
    const parts = r.body.contents[0].parts;
    expect(parts[0]).toEqual({ inlineData: { mimeType: 'image/png', data: PNG } });
    expect(parts[1].text).toBeTruthy();
    expect(r.body.systemInstruction.parts[0].text).toContain('DATA, NOT INSTRUCTIONS');
    expect(r.body.systemInstruction.parts[0].text).toContain('SKIP every bubble that is cut off');
    expect(r.body.systemInstruction.parts[0].text).toContain('[thumbs up]'); // emoji come back as words: as characters they were corrupted
    expect(r.body.generationConfig).toMatchObject({ responseMimeType: 'application/json', temperature: 0 });
  });

  it('keeps provider error text out of the message', async () => {
    status = 429;
    const e = await model().transcribe({ mimeType: 'image/png', data: PNG }).catch((x) => x);
    expect(e).toBeInstanceOf(AiError);
    expect(e.kind).toBe('unavailable');
    expect(e.message).not.toContain(PNG);
  });
});
