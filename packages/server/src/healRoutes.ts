import type { FastifyInstance } from 'fastify';
import { listHeals } from './heals.js';
import { approveHeal, rejectHeal, type ApprovalOutcome } from './healApproval.js';
import type { ResolveContext } from './routeContext.js';

function statusFor(outcome: Extract<ApprovalOutcome, { ok: false }>): { status: number; error: string } {
  switch (outcome.code) {
    case 'not-found':
      return { status: 404, error: 'heal not found' };
    case 'already-resolved':
      return { status: 409, error: 'heal already resolved' };
    case 'conflict':
      return { status: 409, error: 'replay step changed since heal was recorded' };
  }
}

export function registerHealRoutes(app: FastifyInstance, base: string, resolve: ResolveContext): void {
  app.get<{ Querystring: { all?: string } }>(`${base}/heals`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    const all = req.query.all === '1' || req.query.all === 'true';
    return { heals: await listHeals(ctx.workspace, all ? undefined : 'pending') };
  });

  app.post<{ Params: { healId: string } }>(`${base}/heals/:healId/approve`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    const outcome = await approveHeal(ctx.workspace, req.params.healId);
    if (!outcome.ok) {
      const { status, error } = statusFor(outcome);
      return reply.status(status).send({ error });
    }
    return { applied: true };
  });

  app.post<{ Params: { healId: string } }>(`${base}/heals/:healId/reject`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    const outcome = await rejectHeal(ctx.workspace, req.params.healId);
    if (!outcome.ok) {
      const { status, error } = statusFor(outcome);
      return reply.status(status).send({ error });
    }
    return { applied: false };
  });
}
