import path from 'node:path';
import { createReadStream } from 'node:fs';
import { ZipArchive } from 'archiver';
import type { FastifyInstance } from 'fastify';
import { fileExists } from './workspace.js';
import type { ResolveContext } from './routeContext.js';

function isSafeFileName(fileName: string): boolean {
  return fileName.length > 0 && !/[\\/]/.test(fileName) && !fileName.includes('..');
}

export function registerArtifactRoutes(app: FastifyInstance, base: string, resolve: ResolveContext): void {
  app.get<{ Params: { id: string; fileName: string } }>(
    `${base}/runs/:id/screenshots/:fileName`,
    async (req, reply) => {
      const ctx = await resolve(req, reply);
      if (!ctx) return reply;
      const { id, fileName } = req.params;
      if (!isSafeFileName(fileName)) {
        return reply.status(400).send({ error: 'invalid screenshot file name' });
      }
      const entry = ctx.registry.get(id);
      if (!entry) return reply.status(404).send({ error: `run "${id}" not found` });
      const filePath = path.join(entry.runDir, 'screenshots', fileName);
      if (!(await fileExists(filePath))) {
        return reply.status(404).send({ error: `no screenshot "${fileName}" for run "${id}"` });
      }
      return reply.header('content-type', 'image/png').send(createReadStream(filePath));
    },
  );

  app.get<{ Params: { id: string } }>(`${base}/runs/:id/archive`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    const { id } = req.params;
    const entry = ctx.registry.get(id);
    if (!entry || !(await fileExists(entry.runDir))) {
      return reply.status(404).send({ error: `run "${id}" not found` });
    }
    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.directory(entry.runDir, false);
    void archive.finalize();
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${entry.case}-${id}.zip"`)
      .send(archive);
  });
}
