import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { FakeJudgeModel, FakeRsvpModel, FakeScreenshotModel } from '../src/ai/fake.js';
import { createApp } from '../src/app.js';
import { DEFAULT_CONFIG, type AppConfig } from '../src/config.js';
import { FakePayPal } from '../src/paypal/fake.js';
import { KeyedMutex } from '../src/util.js';

const TEMPLATE_DB = join(tmpdir(), 'flakeproof-test', 'template.db');

export interface Harness {
  base: string;
  paypal: FakePayPal;
  rsvp: FakeRsvpModel;
  judge: FakeJudgeModel;
  screens: FakeScreenshotModel;
  db: PrismaClient;
  config: AppConfig;
  clock: { now: Date };
  api: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
  /** Creates an event; returns host token and guests with invite tokens. */
  createEvent: (opts?: { names?: string[]; depositCents?: number; hoursAhead?: number }) => Promise<{ hostToken: string; eventId: string; guests: { id: string; name: string; invite: string }[] }>;
  /** A guest goes through the whole PayPal approval flow. */
  deposit: (invite: string, email?: string) => Promise<void>;
}

export async function makeHarness(configOverride: Partial<AppConfig> = {}, appOpts: { trustProxy?: number } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'flakeproof-db-'));
  const file = join(dir, 'test.db');
  copyFileSync(TEMPLATE_DB, file);
  const db = new PrismaClient({ datasources: { db: { url: `file:${file}` } } });
  const paypal = new FakePayPal();
  const rsvp = new FakeRsvpModel();
  const judge = new FakeJudgeModel();
  const screens = new FakeScreenshotModel();
  const config = { ...DEFAULT_CONFIG, ...configOverride };
  const clock = { now: new Date('2026-11-01T12:00:00Z') };
  const app = createApp({ db, paypal, rsvp, judge, screens, config, mutex: new KeyedMutex(), now: () => clock.now }, appOpts);
  const server: Server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const api: Harness['api'] = async (method, path, body, headers = {}) => {
    const res = await fetch(`${base}${path}`, {
      method, headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const createEvent: Harness['createEvent'] = async (opts = {}) => {
    const names = opts.names ?? ['Ana', 'Ben', 'Cy', 'Dee'];
    const start = new Date(clock.now.getTime() + (opts.hoursAhead ?? 24) * 3_600_000).toISOString();
    const r = await api('POST', '/api/events', {
      title: 'Court booking', startsAt: start, depositCents: opts.depositCents ?? 2000, guests: names.map((name) => ({ name })),
    });
    if (r.status !== 201) throw new Error(`createEvent failed: ${JSON.stringify(r.body)}`);
    const ev = await db.event.findFirstOrThrow({ orderBy: { createdAt: 'desc' }, include: { guests: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } });
    return { hostToken: r.body.hostToken, eventId: ev.id, guests: ev.guests.map((g) => ({ id: g.id, name: g.name, invite: g.inviteToken })) };
  };

  const deposit: Harness['deposit'] = async (invite, email) => {
    const s = await api('POST', `/api/g/${invite}/deposit`);
    if (s.status !== 200) throw new Error(`deposit start failed: ${JSON.stringify(s.body)}`);
    const orderId = s.body.approveUrl.split('/').pop() as string;
    paypal.approveOrder(orderId, email ?? `${invite.slice(0, 6).toLowerCase()}@buyer.test`);
    const f = await api('POST', `/api/g/${invite}/authorize`);
    if (f.status !== 200) throw new Error(`authorize failed: ${JSON.stringify(f.body)}`);
  };

  return {
    base, paypal, rsvp, judge, screens, db, config, clock, api, createEvent, deposit,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await db.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
