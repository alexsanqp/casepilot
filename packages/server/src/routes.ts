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
import type { RunRegistry } from './runs.js';
import type { RunService } from './service.js';

export interface ApiDeps {
  workspace: string;
  version: string;
  registry: RunRegistry;
  service: RunService;
  loadRegistry(workspace: string): Promise<ProviderRegistryLike>;
}

const putCaseBodySchema = z.object({ specYaml: z.string().min(1) });

const postRunBodySchema = z.object({
  case: z.string().min(1),
  provider: z.string().optional(),
  mode: z.enum(['record', 'replay']),
  video: z.boolean().optional(),
  headed: z.boolean().optional(),
});

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerApiRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { workspace } = deps;

  app.setErrorHandler((err: unknown, _req, reply) => {
    const statusCode =
      err instanceof Error && 'statusCode' in err && typeof err.statusCode === 'number' && err.statusCode >= 400
        ? err.statusCode
        : 500;
    void reply.status(statusCode).send({ error: errorMessage(err) });
  });

  app.get('/api/health', async () => ({ ok: true, version: deps.version }));

  app.get('/api/cases', async () => listCases(workspace));

  app.get<{ Params: { name: string } }>('/api/cases/:name', async (req, reply) => {
    const { name } = req.params;
    if (!isSafeName(name)) return reply.status(400).send({ error: `invalid case name "${name}"` });
    if (!(await fileExists(caseFilePath(workspace, name)))) {
      return reply.status(404).send({ error: `case "${name}" not found` });
    }
    const specYaml = await readFile(caseFilePath(workspace, name), 'utf8');
    let spec: CaseSpec;
    try {
      spec = parseCaseSpec(YAML.parse(specYaml), `case "${name}"`);
    } catch (err) {
      return reply.status(400).send({ error: errorMessage(err) });
    }
    const payload: { spec: CaseSpec; specYaml: string; replay?: ReplayFile } = { spec, specYaml };
    if (await fileExists(caseReplayPath(workspace, name))) {
      payload.replay = await loadReplayFile(caseReplayPath(workspace, name));
    }
    return payload;
  });

  app.put<{ Params: { name: string } }>('/api/cases/:name', async (req, reply) => {
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
    await mkdir(casesDir(workspace), { recursive: true });
    await writeFile(caseFilePath(workspace, name), body.data.specYaml, 'utf8');
    return { name, spec };
  });

  app.delete<{ Params: { name: string } }>('/api/cases/:name', async (req, reply) => {
    const { name } = req.params;
    if (!isSafeName(name)) return reply.status(400).send({ error: `invalid case name "${name}"` });
    if (!(await fileExists(caseFilePath(workspace, name)))) {
      return reply.status(404).send({ error: `case "${name}" not found` });
    }
    await rm(caseFilePath(workspace, name));
    await rm(caseReplayPath(workspace, name), { force: true });
    return reply.status(204).send();
  });

  app.post<{ Params: { name: string } }>('/api/cases/:name/export', async (req, reply) => {
    const { name } = req.params;
    if (!isSafeName(name)) return reply.status(400).send({ error: `invalid case name "${name}"` });
    if (!(await fileExists(caseReplayPath(workspace, name)))) {
      return reply.status(404).send({ error: `no replay recorded for case "${name}"` });
    }
    try {
      const replay = await loadReplayFile(caseReplayPath(workspace, name));
      return { specTs: exportToPlaywrightSpec(replay) };
    } catch (err) {
      return reply.status(400).send({ error: errorMessage(err) });
    }
  });

  app.get('/api/providers', async (_req, reply) => {
    try {
      const registry = await deps.loadRegistry(workspace);
      return { default: registry.default().id, providers: registry.list() };
    } catch (err) {
      return reply.status(500).send({ error: errorMessage(err) });
    }
  });

  app.post('/api/runs', async (req, reply) => {
    const body = postRunBodySchema.safeParse(req.body);
    if (!body.success) {
      return reply
        .status(400)
        .send({ error: 'body must be {case, mode: "record"|"replay", provider?, video?, headed?}' });
    }
    const { case: caseName, mode, provider, video, headed } = body.data;
    if (!isSafeName(caseName)) return reply.status(400).send({ error: `invalid case name "${caseName}"` });
    if (!(await fileExists(caseFilePath(workspace, caseName)))) {
      return reply.status(404).send({ error: `case "${caseName}" not found` });
    }
    if (mode === 'replay' && !(await fileExists(caseReplayPath(workspace, caseName)))) {
      return reply.status(404).send({ error: `no replay recorded for case "${caseName}"; record it first` });
    }
    const { runId } = deps.service.start({ caseName, mode, providerId: provider, video, headed });
    return reply.status(202).send({ runId });
  });

  app.get('/api/runs', async () => deps.registry.list());

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const entry = deps.registry.get(req.params.id);
    if (!entry) return reply.status(404).send({ error: `run "${req.params.id}" not found` });
    return { status: entry.status, result: entry.result, error: entry.error };
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/video', async (req, reply) => {
    const entry = deps.registry.get(req.params.id);
    const videoPath = entry?.result?.artifacts.videoPath;
    if (!videoPath || !(await fileExists(videoPath))) {
      return reply.status(404).send({ error: `no video for run "${req.params.id}"` });
    }
    return reply.header('content-type', 'video/webm').send(createReadStream(videoPath));
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/transcript', async (req, reply) => {
    const entry = deps.registry.get(req.params.id);
    const transcriptPath = entry?.result?.artifacts.transcriptPath;
    if (!transcriptPath || !(await fileExists(transcriptPath))) {
      return reply.status(404).send({ error: `no transcript for run "${req.params.id}"` });
    }
    return reply.header('content-type', 'text/plain; charset=utf-8').send(await readFile(transcriptPath, 'utf8'));
  });
}
