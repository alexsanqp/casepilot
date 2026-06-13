import path from 'node:path';
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
  suiteDirPath,
  suitesDir,
} from './workspace.js';
import { isAbsoluteHttpUrl } from './workspaceConfig.js';
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
  slowMo: z.number().int().min(0).max(10_000).optional(),
  stepDelayMs: z.number().int().min(0).max(10_000).optional(),
  baseUrl: z
    .string()
    .refine(isAbsoluteHttpUrl, { message: 'baseUrl must be an absolute http(s) URL' })
    .optional(),
});

const suiteRunBodySchema = z.object({
  caseNames: z.array(z.string()).optional(),
  concurrency: z.number().int().positive().max(64).optional(),
  heal: z.boolean().optional(),
  healPolicy: postRunBodySchema.shape.healPolicy,
  headed: postRunBodySchema.shape.headed,
  video: postRunBodySchema.shape.video,
  screenshots: postRunBodySchema.shape.screenshots,
  viewport: postRunBodySchema.shape.viewport,
  optimizeVideo: postRunBodySchema.shape.optimizeVideo,
  videoPadMs: postRunBodySchema.shape.videoPadMs,
  slowMo: postRunBodySchema.shape.slowMo,
  stepDelayMs: postRunBodySchema.shape.stepDelayMs,
  baseUrl: postRunBodySchema.shape.baseUrl,
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
    const cases = await listCases(ctx.workspace);
    const lastRuns = ctx.registry.lastRunsByCase();
    return cases.map((row) => {
      const lastRun = lastRuns.get(row.name);
      return lastRun ? { ...row, lastRun } : row;
    });
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
          'body must be {case, mode: "record"|"replay", provider?, video?, headed?, screenshots?, viewport?: {width, height}, healPolicy?: "review"|"auto", optimizeVideo?, videoPadMs?, slowMo?: 0-10000, stepDelayMs?: 0-10000, baseUrl?: absolute http(s) URL}',
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
      slowMo,
      stepDelayMs,
      baseUrl,
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
      slowMo,
      stepDelayMs,
      baseUrl,
    });
    return reply.status(202).send({ runId });
  });

  app.get<{ Querystring: { case?: string } }>(`${base}/runs`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    return ctx.registry.list(req.query.case);
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

  app.post(`${base}/suites/runs`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    const body = suiteRunBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: body.error.message });
    }
    const { caseNames, concurrency, ...replayOptions } = body.data;
    const { suiteId } = ctx.suiteService.start({ caseNames, concurrency, replayOptions });
    return reply.status(202).send({ suiteId, status: 'running' });
  });

  app.get(`${base}/suites/runs`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    return ctx.suiteRegistry.list();
  });

  app.get<{ Params: { suiteId: string } }>(`${base}/suites/runs/:suiteId`, async (req, reply) => {
    const ctx = await resolve(req, reply);
    if (!ctx) return reply;
    const entry = ctx.suiteRegistry.get(req.params.suiteId);
    if (!entry) return reply.status(404).send({ error: `suite "${req.params.suiteId}" not found` });
    return { status: entry.status, result: entry.result, error: entry.error };
  });

  for (const kind of ['junit', 'json'] as const) {
    app.get<{ Params: { suiteId: string } }>(`${base}/suites/runs/:suiteId/${kind}`, async (req, reply) => {
      const ctx = await resolve(req, reply);
      if (!ctx) return reply;
      const { suiteId } = req.params;
      // suiteId is interpolated into a filesystem path below. Only serve reports
      // for suites the registry knows, which blocks path traversal (an attacker
      // id is never a registry key) and keeps unknown ids a clean 404.
      if (!ctx.suiteRegistry.get(suiteId)) {
        return reply.status(404).send({ error: `suite "${suiteId}" not found` });
      }
      const file = path.join(
        suiteDirPath(ctx.workspace, suiteId),
        kind === 'junit' ? 'junit.xml' : 'suite.json',
      );
      // Defense in depth: never read outside the workspace suites dir.
      if (!path.resolve(file).startsWith(path.resolve(suitesDir(ctx.workspace)) + path.sep)) {
        return reply.status(404).send({ error: `suite "${suiteId}" not found` });
      }
      try {
        const body = await readFile(file, 'utf8');
        return reply.header('content-type', kind === 'junit' ? 'application/xml' : 'application/json').send(body);
      } catch {
        return reply.status(404).send({ error: 'report not found' });
      }
    });
  }

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
