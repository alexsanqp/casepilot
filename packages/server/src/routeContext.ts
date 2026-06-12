import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ProjectContext } from './projectManager.js';

export type ResolveContext = (req: FastifyRequest, reply: FastifyReply) => Promise<ProjectContext | undefined>;

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
