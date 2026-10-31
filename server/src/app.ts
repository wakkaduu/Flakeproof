import express, { type NextFunction, type Request, type Response, Router } from 'express';
import { z } from 'zod';
import type { Ctx } from './context.js';
import { errorHandler, notFound } from './errors.js';
import { finalizeDeposit, getGuestView, startDeposit } from './services/deposits.js';
import {
  CreateEventInput, createEvent, endEvent, hostView, loadHostEvent, markAttendance, setDecision,
} from './services/events.js';
import { settle } from './services/settlement.js';

const Token = z.string().min(16).max(64).regex(/^[A-Za-z0-9_-]+$/);
const Id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export function createApp(ctx: Ctx) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '50kb' }));
  app.use((_req: Request, res: Response, next: NextFunction) => {
    // Responses contain capability tokens and money state: never cache, never sniff.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  const api = Router();
  api.get('/health', (_req, res) => { res.json({ ok: true }); });

  // ---- host creates an event (no accounts: the host link IS the credential) ----
  api.post('/events', async (req, res) => {
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
  app.use(errorHandler);
  return app;
}
