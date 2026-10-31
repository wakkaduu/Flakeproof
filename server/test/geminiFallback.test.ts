import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GeminiRsvpModel } from '../src/ai/gemini.js';
import { AiError } from '../src/ai/types.js';

const GOOD = { organizer: 'Sam', title: 'Court', startsAtLocal: null, depositCents: null, depositEvidence: null, guests: [], questions: [] };
const INPUT = { chat: 'Sam: hi', now: { localIso: '2026-10-31T14:05', weekday: 'Saturday', timeZone: 'UTC' } };
const wrap = (obj: unknown) => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(obj) }] } }] });

let server: http.Server; let base: string; let hits: string[]; let behaviour: Record<string, number>;
beforeEach(async () => {
  hits = []; behaviour = {};
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const model = /models\/([^:]+):/.exec(req.url!)![1]!;
      hits.push(model);
      const status = behaviour[model] ?? 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? wrap(GOOD) : { error: { status: 'X' } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));
const chain = (models: string) => new GeminiRsvpModel({ apiKey: 'k', model: models, baseUrlForTests: base, retryDelayMs: 1, timeoutMs: 500 });

describe('model chain', () => {
  it('moves to the next model when the first is overloaded, without giving up on it for next time', async () => {
    behaviour = { big: 503 };
    const m = chain('big,small');
    await expect(m.extract(INPUT)).resolves.toMatchObject({ organizer: 'Sam' });
    expect(hits).toEqual(['big', 'small']);
    behaviour = {}; hits = [];
    await m.extract(INPUT);
    expect(hits).toEqual(['big']); // the better model is tried first again, not demoted for good
  });

  it('still remembers a model that is gone (404): it is not asked again', async () => {
    behaviour = { gone: 404 };
    const m = chain('gone,small');
    await m.extract(INPUT);
    await m.extract(INPUT);
    expect(hits).toEqual(['gone', 'small', 'small']);
  });

  it('reports unavailable only when every model is overloaded', async () => {
    behaviour = { big: 429, small: 503 };
    const e = await chain('big,small').extract(INPUT).catch((x) => x);
    expect(e).toBeInstanceOf(AiError);
    expect(e.kind).toBe('unavailable');
    expect(new Set(hits)).toEqual(new Set(['big', 'small']));
  });

  it('does not fall over on a key or request problem (that would hide a real misconfiguration)', async () => {
    behaviour = { big: 403 };
    const e = await chain('big,small').extract(INPUT).catch((x) => x);
    expect(e.kind).toBe('misconfigured');
    expect(hits).toEqual(['big']);
  });
});
