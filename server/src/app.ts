import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type Response, Router } from 'express';
import { z } from 'zod';
import type { Ctx } from './context.js';
import { AppError, errorHandler, notFound } from './errors.js';
import { finalizeDeposit, getGuestView, startDeposit } from './services/deposits.js';
import {
  CreateEventInput, createEvent, endEvent, hostView, loadHostEvent, markAttendance, setDecision,
} from './services/events.js';
import { runJudge } from './services/judge.js';
import { parseRsvp } from './services/rsvp.js';
import { settle } from './services/settlement.js';
import { RateLimiter } from './util.js';

const Token = z.string().min(16).max(64).regex(/^[A-Za-z0-9_-]+$/);
const Id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export function createApp(ctx: Ctx, opts: { webDir?: string; trustProxy?: number } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Behind a reverse proxy/host, req.ip is the proxy unless told how many hops to trust; without
  // this every visitor would share one rate-limit bucket.
  if (opts.trustProxy) app.set('trust proxy', opts.trustProxy);
  app.use(express.json({ limit: '50kb' }));
  app.use((_req: Request, res: Response, next: NextFunction) => {
    // Responses contain capability tokens and money state: never cache, never sniff.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    // The app is same-origin only: scripts, styles, API calls. PayPal is reached by a top-level
    // redirect, which CSP does not restrict.
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    next();
  });

  const aiLimiter = new RateLimiter(ctx.config.rsvpPerMinute, 60_000);
  const eventsLimiter = new RateLimiter(ctx.config.eventsPerMinute, 60_000);
  const api = Router();
  api.get('/health', (_req, res) => { res.json({ ok: true }); });

  // ---- AI: read a pasted chat and PROPOSE guests/amount/time. Creates nothing; the host reviews.
  api.post('/rsvp/parse', async (req, res) => {
    if (!aiLimiter.allow(req.ip ?? 'unknown')) {
      res.setHeader('Retry-After', '30');
      throw new AppError(429, 'rate_limited', 'Too many requests. Wait a moment and try again.');
    }
    res.json(await parseRsvp(ctx, req.body));
  });

  // ---- host creates an event (no accounts: the host link IS the credential) ----
  api.post('/events', async (req, res) => {
    if (!eventsLimiter.allow(req.ip ?? 'unknown')) {
      res.setHeader('Retry-After', '30');
      throw new AppError(429, 'rate_limited', 'Too many events created. Wait a moment and try again.');
    }
    const input = CreateEventInput.parse(req.body);
    const { hostToken, event } = await createEvent(ctx, input);
    res.status(201).json({
      hostToken,
      hostUrl: `${ctx.config.appBaseUrl}/host/${hostToken}`,
      event: hostView(ctx, event),
    });
  });

  // ---- host ----
    api.get('/host/:token/event', async (req, res) => {
    const t = Token.parse(req.params.token);
    res.json(hostView(ctx, await loadHostEvent(ctx, t)));
  });
  // AI recommendation for each no-show. Only recommends: it cannot set a decision or move money.
  api.post('/host/:token/judge', async (req, res) => {
    if (!aiLimiter.allow(req.ip ?? 'unknown')) {
      res.setHeader('Retry-After', '30');
      throw new AppError(429, 'rate_limited', 'Too many requests. Wait a moment and try again.');
    }
    res.json(hostView(ctx, await runJudge(ctx, Token.parse(req.params.token), req.body)));
  });
  api.post('/host/:token/end', async (req, res) => {
    res.json(hostView(ctx, await endEvent(ctx, Token.parse(req.params.token))));
  });
  api.put('/host/:token/guests/:guestId/attendance', async (req, res) => {
    const body = z.object({ attendance: z.enum(['showed', 'no_show']) }).parse(req.body);
    res.json(hostView(ctx, await markAttendance(ctx, Token.parse(req.params.token), Id.parse(req.params.guestId), body.attendance)));
  });
  api.put('/host/:token/guests/:guestId/decision', async (req, res) => {
    const body = z.object({ decision: z.enum(['capture', 'forgive']) }).parse(req.body);
    res.json(hostView(ctx, await setDecision(ctx, Token.parse(req.params.token), Id.parse(req.params.guestId), body.decision)));
  });
  // The explicit approval. `approve: true` must be sent, so nothing moves money by accident.
  api.post('/host/:token/settle', async (req, res) => {
    z.object({ approve: z.literal(true) }).parse(req.body);
    res.json(hostView(ctx, await settle(ctx, Token.parse(req.params.token))));
  });

  // ---- guest (one link, no account) ----
    api.get('/g/:invite', async (req, res) => { res.json(await getGuestView(ctx, Token.parse(req.params.invite))); });
  // No body is read: the amount is decided by the server from the event.
  api.post('/g/:invite/deposit', async (req, res) => { res.json(await startDeposit(ctx, Token.parse(req.params.invite))); });
  api.post('/g/:invite/authorize', async (req, res) => { res.json(await finalizeDeposit(ctx, Token.parse(req.params.invite))); });

  app.use('/api', api);
  app.use('/api', (_req, _res, next) => next(notFound('No such endpoint')));
  // Production-style single process: serve the built web app and fall back to index.html
  // for client-side routes. In dev, Vite serves the web app and proxies /api here.
  const webDir = opts.webDir;
  if (webDir && existsSync(join(webDir, 'index.html'))) {
    app.use(express.static(webDir, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api(\/|$)).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(join(webDir, 'index.html'));
    });
  }
  app.use(errorHandler);
  return app;
}
