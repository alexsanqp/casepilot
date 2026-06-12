import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { exportToPlaywrightSpec, loadReplayFile, parseCaseSpec } from '@casepilot/core';
import type { CaseSpec, ReplayFile } from '@casepilot/core';
import {
  caseFilePath,
  caseReplayPath,
  casesDir,
  fileExists,
  isSafeName,
  listCases,
} from './workspace.js';
import type { ProviderRegistryLike } from './providersLoader.js';
import type { ProjectManager } from './projectManager.js';
import type { ResolveContext } from './routeContext.js';
import { registerHealRoutes } from './healRoutes.js';
import { registerArtifactRoutes } from './artifactRoutes.js';
import { registerFsRoutes } from './fsRoutes.js';

export interface ApiDeps {
  version: string;
  manager: ProjectManager;
  loadRegistry(workspace: string): Promise<ProviderRegistryLike>;
}

const putCaseBodySchema = z.object({ specYaml: z.string().min(1) });

const postRunBodySchema = z.object({
  case: z.string().min(1),
  provider: z.string().optional(),
  mode: z.enum(['record', 'replay']),
  video: z.boolean().optional(),
  headed: z.boolean().optional(),
  screenshots: z.boolean().optional(),
  viewport: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .optional(),
  healPolicy: z.enum(['review', 'auto']).optional(),
  optimizeVideo: z.boolean().optional(),
  videoPadMs: z.number().int().positive().optional(),
});

const postProjectBodySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
});

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function registerProjectScopedRoutes(app: FastifyInstance, deps: ApiDeps, base: string, resolve: ResolveContext): void {
  app.get(`${base}/cases`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    return listCases(ctx.workspace);
  });

  app.get<{ Params: { name: string } }>(`${base}/cases/:name`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    const { name } = req.params;
    if (!isSafeName(name)) return reply.status(400).send({ error: `invalid case name "${name}"` });
    if (!(await fileExists(caseFilePath(ctx.workspace, name)))) {
      return reply.status(404).send({ error: `case "${name}" not found` });
    }
    const specYaml = await readFile(caseFilePath(ctx.workspace, name), 'utf8');
    let spec: CaseSpec;
    try {
      spec = parseCaseSpec(YAML.parse(specYaml), `case "${name}"`);
    } catch (err) {
      return reply.status(400).send({ error: errorMessage(err) });
    }
    const payload: { spec: CaseSpec; specYaml: string; replay?: ReplayFile } = { spec, specYaml };
    if (await fileExists(caseReplayPath(ctx.workspace, name))) {
      payload.replay = await loadReplayFile(caseReplayPath(ctx.workspace, name));
    }
    return payload;
  });

  app.put<{ Params: { name: string } }>(`${base}/cases/:name`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    const { name } = req.params;
    if (!isSafeName(name)) return reply.status(400).send({ error: `invalid case name "${name}"` });
    const body = putCaseBodySchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'body must be {specYaml: string}' });
    let spec: CaseSpec;
    try {
      spec = parseCaseSpec(YAML.parse(body.data.specYaml), `case "${name}"`);
    } catch (err) {
      return reply.status(400).send({ error: errorMessage(err) });
    }
    await mkdir(casesDir(ctx.workspace), { recursive: true });
    await writeFile(caseFilePath(ctx.workspace, name), body.data.specYaml, 'utf8');
    return { name, spec };
  });

  app.delete<{ Params: { name: string } }>(`${base}/cases/:name`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    const { name } = req.params;
    if (!isSafeName(name)) return reply.status(400).send({ error: `invalid case name "${name}"` });
    if (!(await fileExists(caseFilePath(ctx.workspace, name)))) {
      return reply.status(404).send({ error: `case "${name}" not found` });
    }
    await rm(caseFilePath(ctx.workspace, name));
    await rm(caseReplayPath(ctx.workspace, name), { force: true });
    return reply.status(204).send();
  });

  app.post<{ Params: { name: string } }>(`${base}/cases/:name/export`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    const { name } = req.params;
    if (!isSafeName(name)) return reply.status(400).send({ error: `invalid case name "${name}"` });
    if (!(await fileExists(caseReplayPath(ctx.workspace, name)))) {
      return reply.status(404).send({ error: `no replay recorded for case "${name}"` });
    }
    try {
      const replay = await loadReplayFile(caseReplayPath(ctx.workspace, name));
      return { specTs: exportToPlaywrightSpec(replay) };
    } catch (err) {
      return reply.status(400).send({ error: errorMessage(err) });
    }
  });

  app.get(`${base}/providers`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    try {
      const registry = await deps.loadRegistry(ctx.workspace);
      return { default: registry.default().id, providers: registry.list() };
    } catch (err) {
      return reply.status(500).send({ error: errorMessage(err) });
    }
  });

  app.post(`${base}/runs`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    const body = postRunBodySchema.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({
        error:
          'body must be {case, mode: "record"|"replay", provider?, video?, headed?, screenshots?, viewport?: {width, height}, healPolicy?: "review"|"auto", optimizeVideo?, videoPadMs?}',
      });
    }
    const {
      case: caseName,
      mode,
      provider,
      video,
      headed,
      screenshots,
      viewport,
      healPolicy,
      optimizeVideo,
      videoPadMs,
    } = body.data;
    if (!isSafeName(caseName)) return reply.status(400).send({ error: `invalid case name "${caseName}"` });
    if (!(await fileExists(caseFilePath(ctx.workspace, caseName)))) {
      return reply.status(404).send({ error: `case "${caseName}" not found` });
    }
    if (mode === 'replay' && !(await fileExists(caseReplayPath(ctx.workspace, caseName)))) {
      return reply.status(404).send({ error: `no replay recorded for case "${caseName}"; record it first` });
    }
    const { runId } = ctx.service.start({
      caseName,
      mode,
      providerId: provider,
      video,
      headed,
      screenshots,
      viewport,
      healPolicy,
      optimizeVideo,
      videoPadMs,
    });
    return reply.status(202).send({ runId });
  });

  app.get(`${base}/runs`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    return ctx.registry.list();
  });

  app.get<{ Params: { id: string } }>(`${base}/runs/:id`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    const entry = ctx.registry.get(req.params.id);
    if (!entry) return reply.status(404).send({ error: `run "${req.params.id}" not found` });
    return { status: entry.status, result: entry.result, error: entry.error };
  });

  app.get<{ Params: { id: string } }>(`${base}/runs/:id/video`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    const entry = ctx.registry.get(req.params.id);
    const videoPath = entry?.result?.artifacts.videoPath;
    if (!videoPath || !(await fileExists(videoPath))) {
      return reply.status(404).send({ error: `no video for run "${req.params.id}"` });
    }
    return reply.header('content-type', 'video/webm').send(createReadStream(videoPath));
  });

  app.get<{ Params: { id: string } }>(`${base}/runs/:id/video/optimized`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    const entry = ctx.registry.get(req.params.id);
    const optimizedVideoPath = entry?.result?.artifacts.optimizedVideoPath;
    if (!optimizedVideoPath || !(await fileExists(optimizedVideoPath))) {
      return reply.status(404).send({ error: `no optimized video for run "${req.params.id}"` });
    }
    return reply.header('content-type', 'video/webm').send(createReadStream(optimizedVideoPath));
  });

  app.get<{ Params: { id: string } }>(`${base}/runs/:id/transcript`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    const entry = ctx.registry.get(req.params.id);
    const transcriptPath = entry?.result?.artifacts.transcriptPath;
    if (!transcriptPath || !(await fileExists(transcriptPath))) {
      return reply.status(404).send({ error: `no transcript for run "${req.params.id}"` });
    }
    return reply.header('content-type', 'text/plain; charset=utf-8').send(await readFile(transcriptPath, 'utf8'));
  });

  registerHealRoutes(app, base, resolve);
  registerArtifactRoutes(app, base, resolve);
}

export function registerApiRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { manager } = deps;

  app.setErrorHandler((err: unknown, _req, reply) => {
    const statusCode =
      err instanceof Error && 'statusCode' in err && typeof err.statusCode === 'number' && err.statusCode >= 400
        ? err.statusCode
        : 500;
    void reply.status(statusCode).send({ error: errorMessage(err) });
  });

  app.get('/api/health', async () => ({ ok: true, version: deps.version }));

  app.get('/api/projects', async () => ({ projects: await manager.list() }));

  app.post('/api/projects', async (req, reply) => {
    const body = postProjectBodySchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'body must be {name: string, path: string}' });
    try {
      const project = await manager.add(body.data);
      return reply.status(201).send({ project });
    } catch (err) {
      return reply.status(400).send({ error: errorMessage(err) });
    }
  });

  app.delete<{ Params: { projectId: string } }>('/api/projects/:projectId', async (req, reply) => {
    if (!(await manager.remove(req.params.projectId))) {
      return reply.status(404).send({ error: `project "${req.params.projectId}" not found in registry` });
    }
    return reply.status(204).send();
  });

  const resolveDefault: ResolveContext = async (_req, reply) => {
    const ctx = manager.hasDefault ? await manager.getContext('default') : undefined;
    if (!ctx) {
      await reply.status(404).send({ error: 'project-scoped route required' });
      return undefined;
    }
    return ctx;
  };

  const resolveScoped: ResolveContext = async (req, reply) => {
    const projectId = (req.params as { projectId?: string }).projectId ?? '';
    const ctx = await manager.getContext(projectId);
    if (!ctx) {
      await reply.status(404).send({ error: `project "${projectId}" not found` });
      return undefined;
    }
    return ctx;
  };

  registerProjectScopedRoutes(app, deps, '/api/projects/:projectId', resolveScoped);
  registerProjectScopedRoutes(app, deps, '/api', resolveDefault);
  registerFsRoutes(app);
}
