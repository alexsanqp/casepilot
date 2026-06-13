import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Provider, ReplayFile, RunResult } from '@casepilot/core';
import { createServer } from '../src/server.js';
import type { RunEngine } from '../src/runner.js';
import type { ProviderRegistryLike } from '../src/providersLoader.js';

const CASE_YAML = `name: login
url: https://example.test/login
steps:
  - Click the Login button
expect:
  - The dashboard heading is visible
`;

function makeReplay(caseName: string): ReplayFile {
  return {
    version: 1,
    case: caseName,
    url: 'https://example.test/login',
    providerUsed: 'fake-chat',
    recordedAt: '2026-06-11T10:00:00.000Z',
    steps: [],
    meta: { healCount: 0 },
  };
}

function makeResult(caseName: string, verdict: 'passed' | 'failed' = 'passed'): RunResult {
  return {
    case: caseName,
    caseName,
    mode: 'replay',
    verdict,
    explanation: verdict === 'passed' ? 'all expectations verified' : 'something broke',
    steps: [],
    artifacts: { screenshots: [] },
    startedAt: '2026-06-11T10:00:00.000Z',
    finishedAt: '2026-06-11T10:00:05.000Z',
  };
}

const chatProvider: Provider = {
  kind: 'chat',
  id: 'fake-chat',
  generate: async () => ({ text: '' }),
};

function makeRegistry(providers: Provider[], defaultId: string): ProviderRegistryLike {
  return {
    get(id) {
      const provider = providers.find((p) => p.id === id);
      if (!provider) throw new Error(`unknown provider "${id}"`);
      return provider;
    },
    list() {
      return providers.map((p) => ({ id: p.id, kind: p.kind, type: 'fake' }));
    },
    default() {
      return this.get(defaultId);
    },
  };
}

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function setup(recordedCases: string[], unrecordedCases: string[] = [], throwingCases: string[] = []) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'cp-suite-routes-'));
  await mkdir(path.join(workspace, 'cases'), { recursive: true });
  await writeFile(path.join(workspace, 'casepilot.config.yaml'), 'providers: []\n', 'utf8');
  for (const name of [...recordedCases, ...unrecordedCases]) {
    await writeFile(
      path.join(workspace, 'cases', `${name}.case.yaml`),
      CASE_YAML.replace('name: login', `name: ${name}`),
      'utf8',
    );
  }
  for (const name of recordedCases) {
    await writeFile(
      path.join(workspace, 'cases', `${name}.replay.json`),
      JSON.stringify(makeReplay(name), null, 2),
      'utf8',
    );
  }
  // Inject a fake replay engine so suite cases resolve instantly with no browser.
  // A throwing case simulates an infra blow-up (e.g. browser crash) that escapes
  // replayCase, mirroring how executeRun rethrows after persisting result.json.
  const engine: RunEngine = {
    recordCase: vi.fn(async () => ({ result: makeResult('login'), replay: makeReplay('login') })),
    replayCase: vi.fn(async (replay: ReplayFile) => {
      if (throwingCases.includes(replay.case)) throw new Error(`replay blew up for "${replay.case}"`);
      return makeResult(replay.case, replay.case === 'broken' ? 'failed' : 'passed');
    }),
  };
  const registry = makeRegistry([chatProvider], 'fake-chat');
  const registryPath = path.join(await mkdtemp(path.join(os.tmpdir(), 'cp-reg-')), 'projects.json');
  const app = await createServer({
    workspace,
    registryPath,
    deps: {
      engine,
      loadRegistry: async () => registry,
      resolveMcpBin: () => 'C:/fake/mcp/dist/bin.js',
    },
  });
  openApps.push(app);
  return { workspace, app, engine };
}

interface SuiteCaseView {
  caseName: string;
  status: string;
  verdict?: 'passed' | 'failed';
  runId?: string;
}

interface SuiteView {
  status: string;
  result?: { passed: number; failed: number; skipped: number; cases: SuiteCaseView[] };
}

async function pollSuite(app: FastifyInstance, url: string): Promise<SuiteView> {
  let body: SuiteView = { status: 'running' };
  for (let i = 0; i < 50 && body.status === 'running'; i++) {
    body = (await app.inject({ method: 'GET', url })).json();
    if (body.status === 'running') await new Promise((r) => setTimeout(r, 5));
  }
  return body;
}

describe('suite run REST routes', () => {
  it('starts a suite, polls to done, aggregates the verdict, and downloads junit/json', async () => {
    const { app } = await setup(['login', 'broken'], ['draft']);
    const start = await app.inject({
      method: 'POST',
      url: '/api/projects/default/suites/runs',
      payload: { concurrency: 1 },
    });
    expect(start.statusCode).toBe(202);
    const { suiteId } = start.json() as { suiteId: string };
    expect(suiteId).toMatch(/^suite-/);

    const body = await pollSuite(app, `/api/projects/default/suites/runs/${suiteId}`);
    expect(body.status).toBe('done');
    expect(body.result).toMatchObject({ passed: 1, failed: 1, skipped: 1 });

    const junit = await app.inject({ method: 'GET', url: `/api/projects/default/suites/runs/${suiteId}/junit` });
    expect(junit.statusCode).toBe(200);
    expect(junit.body).toContain('<testsuite');

    const json = await app.inject({ method: 'GET', url: `/api/projects/default/suites/runs/${suiteId}/json` });
    expect(json.statusCode).toBe(200);
    expect(JSON.parse(json.body)).toMatchObject({ passed: 1, failed: 1, skipped: 1 });
  });

  it('lists suites and exposes them through the default-project alias', async () => {
    const { app } = await setup(['login']);
    const start = await app.inject({ method: 'POST', url: '/api/suites/runs', payload: {} });
    expect(start.statusCode).toBe(202);
    const { suiteId } = start.json() as { suiteId: string };

    await pollSuite(app, `/api/suites/runs/${suiteId}`);

    const list = await app.inject({ method: 'GET', url: '/api/suites/runs' });
    expect(list.statusCode).toBe(200);
    expect((list.json() as Array<{ suiteId: string }>).map((s) => s.suiteId)).toContain(suiteId);

    const scoped = await app.inject({ method: 'GET', url: '/api/projects/default/suites/runs' });
    expect((scoped.json() as Array<{ suiteId: string }>).map((s) => s.suiteId)).toContain(suiteId);
  });

  it('404s an unknown suite and unknown reports', async () => {
    const { app } = await setup(['login']);
    expect((await app.inject({ method: 'GET', url: '/api/suites/runs/ghost' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/suites/runs/ghost/junit' })).statusCode).toBe(404);
  });

  it('does not serve report files for a traversal or unknown suiteId', async () => {
    const { app } = await setup(['login']);
    for (const bad of ['..', 'suite-..', 'not-a-suite']) {
      for (const kind of ['junit', 'json']) {
        const res = await app.inject({ method: 'GET', url: `/api/suites/runs/${bad}/${kind}` });
        expect(res.statusCode).toBe(404);
        expect(res.body).not.toContain('<testsuite');
      }
    }
  });

  it('rejects an invalid suite run body with 400 but accepts a valid concurrency', async () => {
    const { app } = await setup(['login']);

    const badConcurrency = await app.inject({
      method: 'POST',
      url: '/api/projects/default/suites/runs',
      payload: { concurrency: 'fast' },
    });
    expect(badConcurrency.statusCode).toBe(400);

    const outOfRange = await app.inject({
      method: 'POST',
      url: '/api/projects/default/suites/runs',
      payload: { slowMo: 999999 },
    });
    expect(outOfRange.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/projects/default/suites/runs',
      payload: { concurrency: 2 },
    });
    expect(ok.statusCode).toBe(202);
  });

  it('exposes per-case runs through GET /runs/:id after a suite completes', async () => {
    const { app } = await setup(['login', 'broken']);
    const start = await app.inject({
      method: 'POST',
      url: '/api/projects/default/suites/runs',
      payload: { concurrency: 1 },
    });
    expect(start.statusCode).toBe(202);
    const { suiteId } = start.json() as { suiteId: string };

    const suite = await pollSuite(app, `/api/projects/default/suites/runs/${suiteId}`);
    expect(suite.status).toBe('done');
    const ranCases = (suite.result?.cases ?? []).filter((c) => c.runId);
    expect(ranCases.length).toBeGreaterThan(0);

    for (const c of ranCases) {
      const run = await app.inject({ method: 'GET', url: `/api/projects/default/runs/${c.runId}` });
      expect(run.statusCode).toBe(200);
      const body = run.json() as { status: string; result?: { verdict?: 'passed' | 'failed' } };
      expect(body.status).toBe('done');
      expect(body.result?.verdict).toBe(c.verdict);
    }
  });

  it('records a thrown suite case as a non-running per-case run (matches a restart)', async () => {
    const { app } = await setup(['login', 'kaboom'], [], ['kaboom']);
    const start = await app.inject({
      method: 'POST',
      url: '/api/projects/default/suites/runs',
      payload: { concurrency: 1 },
    });
    expect(start.statusCode).toBe(202);
    const { suiteId } = start.json() as { suiteId: string };

    const suite = await pollSuite(app, `/api/projects/default/suites/runs/${suiteId}`);
    expect(suite.status).toBe('done');
    const thrown = (suite.result?.cases ?? []).find((c) => c.caseName === 'kaboom');
    expect(thrown?.runId).toBeTruthy();

    const run = await app.inject({ method: 'GET', url: `/api/projects/default/runs/${thrown!.runId}` });
    expect(run.statusCode).toBe(200);
    const body = run.json() as { status: string; result?: { verdict?: 'passed' | 'failed' }; error?: string };
    // The per-case run must be reachable and not stuck running. executeRun wrote a
    // verdict-failed result.json before rethrowing, so the run shows done/failed —
    // matching what a server restart would reconstruct from disk.
    expect(body.status).not.toBe('running');
    expect(body.status).toBe('done');
    expect(body.result?.verdict).toBe('failed');
  });
});
