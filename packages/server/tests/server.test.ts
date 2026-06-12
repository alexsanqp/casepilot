import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AgentProvider, CaseSpec, ChatProvider, Provider, ReplayFile, RunResult } from '@casepilot/core';
import { createServer } from '../src/server.js';
import { saveProjects } from '../src/projects.js';
import type { RunEngine } from '../src/runner.js';
import type { ProviderRegistryLike } from '../src/providersLoader.js';

const CASE_YAML = `name: login
url: https://example.test/login
steps:
  - Fill the username field with "demo"
  - Click the Login button
expect:
  - The dashboard heading is visible
`;

function makeReplay(): ReplayFile {
  return {
    version: 1,
    case: 'login',
    url: 'https://example.test/login',
    providerUsed: 'fake-chat',
    recordedAt: '2026-06-11T10:00:00.000Z',
    steps: [
      { kind: 'act', action: 'click', selector: 'role=button[name="Login"]' },
      { kind: 'assert', assert: 'visible', selector: 'role=heading[name="Dashboard"]' },
    ],
    meta: { healCount: 0 },
  };
}

function makeResult(mode: 'record' | 'replay', verdict: 'passed' | 'failed' = 'passed'): RunResult {
  return {
    case: 'login',
    caseName: 'login',
    mode,
    verdict,
    explanation: verdict === 'passed' ? 'all expectations verified' : 'something broke',
    steps: [],
    artifacts: { screenshots: [] },
    startedAt: '2026-06-11T10:00:00.000Z',
    finishedAt: '2026-06-11T10:00:05.000Z',
  };
}

const chatProvider: ChatProvider = {
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

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    return (await stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function setup(overrides?: {
  providers?: Provider[];
  defaultId?: string;
  engine?: Partial<RunEngine>;
  withReplay?: boolean;
}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'cp-server-'));
  await mkdir(path.join(workspace, 'cases'), { recursive: true });
  await writeFile(path.join(workspace, 'casepilot.config.yaml'), 'providers: []\n', 'utf8');
  await writeFile(path.join(workspace, 'cases', 'login.case.yaml'), CASE_YAML, 'utf8');
  if (overrides?.withReplay) {
    await writeFile(
      path.join(workspace, 'cases', 'login.replay.json'),
      JSON.stringify(makeReplay(), null, 2),
      'utf8',
    );
  }
  const engine: RunEngine = {
    recordCase: vi.fn(async () => ({ result: makeResult('record'), replay: makeReplay() })),
    replayCase: vi.fn(async () => makeResult('replay')),
    ...overrides?.engine,
  };
  const registry = makeRegistry(overrides?.providers ?? [chatProvider], overrides?.defaultId ?? 'fake-chat');
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
  return { workspace, app, engine, registryPath };
}

describe('GET /api/health', () => {
  it('reports ok with a version', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, version: expect.any(String) });
  });
});

describe('cases CRUD', () => {
  it('lists cases with replay presence', async () => {
    const { app } = await setup({ withReplay: true });
    const res = await app.inject({ method: 'GET', url: '/api/cases' });
    expect(res.statusCode).toBe(200);
    const cases = res.json() as Array<Record<string, unknown>>;
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ name: 'login', url: 'https://example.test/login', hasReplay: true });
  });

  it('returns a single case with spec, raw yaml and replay', async () => {
    const { app } = await setup({ withReplay: true });
    const res = await app.inject({ method: 'GET', url: '/api/cases/login' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.spec.name).toBe('login');
    expect(body.specYaml).toContain('Click the Login button');
    expect(body.replay.version).toBe(1);
  });

  it('404s for an unknown case', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/cases/ghost' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty('error');
  });

  it('creates a case via PUT and validates the yaml', async () => {
    const { app, workspace } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/cases/signup',
      payload: { specYaml: CASE_YAML.replace('name: login', 'name: signup') },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().spec.name).toBe('signup');
    const written = await readFile(path.join(workspace, 'cases', 'signup.case.yaml'), 'utf8');
    expect(written).toContain('name: signup');
  });

  it('rejects an invalid case spec with 400', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/cases/bad',
      payload: { specYaml: 'name: bad\nurl: x\n' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('steps');
  });

  it('rejects unsafe case names with 400', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/cases/..%2Fescape' });
    expect(res.statusCode).toBe(400);
  });

  it('deletes a case and its replay', async () => {
    const { app } = await setup({ withReplay: true });
    const del = await app.inject({ method: 'DELETE', url: '/api/cases/login' });
    expect(del.statusCode).toBe(204);
    const res = await app.inject({ method: 'GET', url: '/api/cases/login' });
    expect(res.statusCode).toBe(404);
  });

  it('404s when deleting an unknown case', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'DELETE', url: '/api/cases/ghost' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/cases/:name/export', () => {
  it('exports a recorded case as a Playwright spec', async () => {
    const { app } = await setup({ withReplay: true });
    const res = await app.inject({ method: 'POST', url: '/api/cases/login/export' });
    expect(res.statusCode).toBe(200);
    expect(res.json().specTs).toContain(`import { test, expect } from '@playwright/test';`);
  });

  it('404s without a replay', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/cases/login/export' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/providers', () => {
  it('returns the default provider and the provider list', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/providers' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      default: 'fake-chat',
      providers: [{ id: 'fake-chat', kind: 'chat', type: 'fake' }],
    });
  });
});

describe('run lifecycle', () => {
  it('404s when starting a run for an unknown case', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { case: 'ghost', mode: 'record' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('404s when replaying a case without a replay', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { case: 'login', mode: 'replay' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('no replay');
  });

  it('400s on a malformed body', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { mode: 'sideways' } });
    expect(res.statusCode).toBe(400);
  });

  it('records with a chat provider, tracks the run, and copies the replay back', async () => {
    const { app, workspace, engine } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { case: 'login', mode: 'record' },
    });
    expect(res.statusCode).toBe(202);
    const { runId } = res.json() as { runId: string };
    await app.runService.settled(runId);

    expect(engine.recordCase).toHaveBeenCalledTimes(1);

    const runRes = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(runRes.statusCode).toBe(200);
    expect(runRes.json()).toMatchObject({ status: 'done', result: { verdict: 'passed', mode: 'record' } });

    const replay = JSON.parse(await readFile(path.join(workspace, 'cases', 'login.replay.json'), 'utf8'));
    expect(replay.case).toBe('login');
    const resultJson = JSON.parse(await readFile(path.join(workspace, 'runs', runId, 'result.json'), 'utf8'));
    expect(resultJson.verdict).toBe('passed');

    const list = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(list.json()).toEqual([
      expect.objectContaining({ runId, case: 'login', mode: 'record', status: 'done', verdict: 'passed' }),
    ]);
  });

  it('replays with a healer when a chat provider is available', async () => {
    const { app, engine } = await setup({ withReplay: true });
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { case: 'login', mode: 'replay' },
    });
    expect(res.statusCode).toBe(202);
    const { runId } = res.json() as { runId: string };
    await app.runService.settled(runId);

    expect(engine.replayCase).toHaveBeenCalledTimes(1);
    const healer = (engine.replayCase as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(typeof healer).toBe('function');

    const runRes = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(runRes.json()).toMatchObject({ status: 'done', result: { mode: 'replay' } });
  });

  it('records via an agent provider through the browser-tools bridge artifacts', async () => {
    const agentProviderWritesArtifacts: AgentProvider = {
      kind: 'agent',
      id: 'fake-agent',
      async runTask({ taskPrompt, mcp }) {
        expect(taskPrompt).toContain('report_result');
        expect(mcp.command).toBe(process.execPath);
        expect(mcp.args[0]).toBe('C:/fake/mcp/dist/bin.js');
        expect(mcp.args[1]).toBe('browser-tools');
        const runDir = mcp.args[mcp.args.indexOf('--artifacts') + 1]!;
        await writeFile(path.join(runDir, 'result.json'), JSON.stringify(makeResult('record'), null, 2), 'utf8');
        await writeFile(path.join(runDir, 'replay.json'), JSON.stringify(makeReplay(), null, 2), 'utf8');
        return { transcript: 'agent transcript text' };
      },
    };
    const { app, workspace } = await setup({
      providers: [agentProviderWritesArtifacts],
      defaultId: 'fake-agent',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { case: 'login', mode: 'record', provider: 'fake-agent' },
    });
    expect(res.statusCode).toBe(202);
    const { runId } = res.json() as { runId: string };
    await app.runService.settled(runId);

    const runRes = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(runRes.json()).toMatchObject({ status: 'done', result: { verdict: 'passed' } });

    const replay = JSON.parse(await readFile(path.join(workspace, 'cases', 'login.replay.json'), 'utf8'));
    expect(replay.case).toBe('login');

    const transcript = await app.inject({ method: 'GET', url: `/api/runs/${runId}/transcript` });
    expect(transcript.statusCode).toBe(200);
    expect(transcript.body).toBe('agent transcript text');
  });

  it('reports an engine throw as done+failed, matching what a disk reload shows', async () => {
    const { app, workspace } = await setup({
      engine: {
        recordCase: vi.fn(async () => {
          throw new Error('provider exploded');
        }),
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { case: 'login', mode: 'record' },
    });
    const { runId } = res.json() as { runId: string };
    await app.runService.settled(runId);

    const live = (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json() as {
      status: string;
      error?: string;
      result?: RunResult;
    };
    expect(live).toMatchObject({
      status: 'done',
      error: 'provider exploded',
      result: { verdict: 'failed', explanation: 'provider exploded' },
    });

    const list = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(list.json()).toEqual([expect.objectContaining({ runId, status: 'done', verdict: 'failed' })]);

    const rebooted = await createServer({
      workspace,
      registryPath: path.join(await mkdtemp(path.join(os.tmpdir(), 'cp-reg-')), 'projects.json'),
      deps: {
        engine: { recordCase: vi.fn(), replayCase: vi.fn() } as unknown as RunEngine,
        loadRegistry: async () => makeRegistry([chatProvider], 'fake-chat'),
        resolveMcpBin: () => 'unused',
      },
    });
    openApps.push(rebooted);
    const reloaded = (await rebooted.inject({ method: 'GET', url: `/api/runs/${runId}` })).json() as {
      status: string;
      result?: RunResult;
    };
    expect(reloaded.status).toBe(live.status);
    expect(reloaded.result?.verdict).toBe(live.result?.verdict);
    expect(reloaded.result?.explanation).toBe(live.result?.explanation);
  });

  it('keeps status "error" when the run produced no result at all', async () => {
    const { app } = await setup();
    const { runId } = app.runService.start({ caseName: 'bad/../name', mode: 'record' });
    await app.runService.settled(runId);

    const runRes = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    const body = runRes.json() as { status: string; error?: string; result?: RunResult };
    expect(body.status).toBe('error');
    expect(body.error).toContain('Invalid case name');
    expect(body.result).toBeUndefined();
  });

  it('404s for unknown run ids and missing artifacts', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/runs/nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/runs/nope/video' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/runs/nope/transcript' })).statusCode).toBe(404);
  });

  it('404s for video when the run produced none', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { case: 'login', mode: 'record' },
    });
    const { runId } = res.json() as { runId: string };
    await app.runService.settled(runId);
    expect((await app.inject({ method: 'GET', url: `/api/runs/${runId}/video` })).statusCode).toBe(404);
  });

  it('rehydrates finished runs from the runs directory on boot', async () => {
    const { app, workspace } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { case: 'login', mode: 'record' },
    });
    const { runId } = res.json() as { runId: string };
    await app.runService.settled(runId);

    const rebooted = await createServer({
      workspace,
      registryPath: path.join(await mkdtemp(path.join(os.tmpdir(), 'cp-reg-')), 'projects.json'),
      deps: {
        engine: { recordCase: vi.fn(), replayCase: vi.fn() } as unknown as RunEngine,
        loadRegistry: async () => makeRegistry([chatProvider], 'fake-chat'),
        resolveMcpBin: () => 'unused',
      },
    });
    openApps.push(rebooted);
    const list = await rebooted.inject({ method: 'GET', url: '/api/runs' });
    expect(list.json()).toEqual([
      expect.objectContaining({ runId, case: 'login', status: 'done', verdict: 'passed' }),
    ]);
  });
});

describe('multi-project mode', () => {
  async function setupProjects() {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cp-home-'));
    const registryPath = path.join(home, 'projects.json');
    const dirA = await mkdtemp(path.join(os.tmpdir(), 'cp-proj-a-'));
    const dirB = await mkdtemp(path.join(os.tmpdir(), 'cp-proj-b-'));
    await mkdir(path.join(dirA, 'cases'), { recursive: true });
    await mkdir(path.join(dirB, 'cases'), { recursive: true });
    await writeFile(path.join(dirA, 'cases', 'login.case.yaml'), CASE_YAML, 'utf8');
    await writeFile(
      path.join(dirB, 'cases', 'signup.case.yaml'),
      CASE_YAML.replace('name: login', 'name: signup'),
      'utf8',
    );
    await saveProjects(registryPath, {
      version: 1,
      projects: [
        { id: 'alpha', name: 'Alpha', path: dirA },
        { id: 'beta', name: 'Beta', path: dirB },
      ],
    });
    const engine: RunEngine = {
      recordCase: vi.fn(async () => ({ result: makeResult('record'), replay: makeReplay() })),
      replayCase: vi.fn(async () => makeResult('replay')),
    };
    const app = await createServer({
      registryPath,
      deps: {
        engine,
        loadRegistry: async () => makeRegistry([chatProvider], 'fake-chat'),
        resolveMcpBin: () => 'C:/fake/mcp/dist/bin.js',
      },
    });
    openApps.push(app);
    return { app, registryPath, dirA, dirB, engine };
  }

  it('lists registered projects with case counts', async () => {
    const { app, dirA, dirB } = await setupProjects();
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      projects: [
        { id: 'alpha', name: 'Alpha', path: dirA, caseCount: 1 },
        { id: 'beta', name: 'Beta', path: dirB, caseCount: 1 },
      ],
    });
  });

  it('lists projects without creating directories inside project paths', async () => {
    const { app, registryPath, dirA, dirB } = await setupProjects();
    const bare = await mkdtemp(path.join(os.tmpdir(), 'cp-proj-bare-'));
    const file = JSON.parse(await readFile(registryPath, 'utf8')) as { version: 1; projects: unknown[] };
    await saveProjects(registryPath, {
      version: 1,
      projects: [...(file.projects as Array<{ id: string; name: string; path: string }>), { id: 'bare', name: 'Bare', path: bare }],
    });

    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(200);
    expect((res.json().projects as Array<{ id: string }>).map((p) => p.id)).toEqual(['alpha', 'beta', 'bare']);

    expect(await dirExists(path.join(bare, 'cases'))).toBe(false);
    expect(await dirExists(path.join(bare, 'runs'))).toBe(false);
    expect(await dirExists(path.join(dirA, 'runs'))).toBe(false);
    expect(await dirExists(path.join(dirB, 'runs'))).toBe(false);
  });

  it('serves project-scoped case routes independently', async () => {
    const { app } = await setupProjects();
    const alpha = await app.inject({ method: 'GET', url: '/api/projects/alpha/cases' });
    const beta = await app.inject({ method: 'GET', url: '/api/projects/beta/cases' });
    expect(alpha.json()).toEqual([expect.objectContaining({ name: 'login' })]);
    expect(beta.json()).toEqual([expect.objectContaining({ name: 'signup' })]);

    const single = await app.inject({ method: 'GET', url: '/api/projects/alpha/cases/login' });
    expect(single.statusCode).toBe(200);
    expect(single.json().spec.name).toBe('login');
    expect((await app.inject({ method: 'GET', url: '/api/projects/beta/cases/login' })).statusCode).toBe(404);
  });

  it('404s scoped routes for an unknown project', async () => {
    const { app } = await setupProjects();
    const res = await app.inject({ method: 'GET', url: '/api/projects/ghost/cases' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('ghost');
  });

  it('rejects unscoped aliases when no default project exists', async () => {
    const { app } = await setupProjects();
    for (const url of ['/api/cases', '/api/runs', '/api/providers']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'project-scoped route required' });
    }
  });

  it('runs cases per project and keeps run registries separate', async () => {
    const { app, dirA, engine } = await setupProjects();
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/alpha/runs',
      payload: { case: 'login', mode: 'record' },
    });
    expect(res.statusCode).toBe(202);
    const { runId } = res.json() as { runId: string };
    const ctx = await app.projectManager.getContext('alpha');
    await ctx!.service.settled(runId);
    expect(engine.recordCase).toHaveBeenCalledTimes(1);

    const report = await app.inject({ method: 'GET', url: `/api/projects/alpha/runs/${runId}` });
    expect(report.json()).toMatchObject({ status: 'done', result: { verdict: 'passed' } });
    const resultJson = JSON.parse(await readFile(path.join(dirA, 'runs', runId, 'result.json'), 'utf8'));
    expect(resultJson.verdict).toBe('passed');

    const alphaRuns = await app.inject({ method: 'GET', url: '/api/projects/alpha/runs' });
    expect(alphaRuns.json()).toEqual([expect.objectContaining({ runId })]);
    const betaRuns = await app.inject({ method: 'GET', url: '/api/projects/beta/runs' });
    expect(betaRuns.json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `/api/projects/beta/runs/${runId}` })).statusCode).toBe(404);

    const projects = await app.inject({ method: 'GET', url: '/api/projects' });
    const alpha = (projects.json().projects as Array<{ id: string; lastRunAt?: string }>).find(
      (p) => p.id === 'alpha',
    );
    expect(alpha?.lastRunAt).toEqual(expect.any(String));
  });

  it('registers a new project via POST and scaffolds a bare directory', async () => {
    const { app } = await setupProjects();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cp-proj-new-'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Fresh One', path: dir },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ project: { id: 'fresh-one', name: 'Fresh One', path: dir } });
    expect(await readFile(path.join(dir, 'casepilot.config.yaml'), 'utf8')).toContain('providers: []');

    const cases = await app.inject({ method: 'GET', url: '/api/projects/fresh-one/cases' });
    expect(cases.json()).toEqual([expect.objectContaining({ name: 'example' })]);
  });

  it('400s when registering an invalid path or body', async () => {
    const { app } = await setupProjects();
    const bad = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'nope', path: path.join(os.tmpdir(), 'cp-definitely-missing-dir') },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('does not exist');

    const malformed = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'x' } });
    expect(malformed.statusCode).toBe(400);
  });

  it('removes a project from the registry without touching its files', async () => {
    const { app, dirA } = await setupProjects();
    const del = await app.inject({ method: 'DELETE', url: '/api/projects/alpha' });
    expect(del.statusCode).toBe(204);
    expect(await readFile(path.join(dirA, 'cases', 'login.case.yaml'), 'utf8')).toContain('name: login');
    expect((await app.inject({ method: 'GET', url: '/api/projects/alpha/cases' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/projects/alpha' })).statusCode).toBe(404);
    const list = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(list.json().projects).toEqual([expect.objectContaining({ id: 'beta' })]);
  });
});

describe('single-workspace mode projects view', () => {
  it('exposes the workspace as the implicit "default" project', async () => {
    const { app, workspace } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.json()).toEqual({
      projects: [{ id: 'default', name: path.basename(workspace), path: workspace, caseCount: 1 }],
    });
  });

  it('serves the same workspace via scoped and unscoped routes', async () => {
    const { app } = await setup({ withReplay: true });
    const scoped = await app.inject({ method: 'GET', url: '/api/projects/default/cases' });
    const unscoped = await app.inject({ method: 'GET', url: '/api/cases' });
    expect(scoped.json()).toEqual(unscoped.json());
  });

  it('scaffolds a bare workspace for the implicit default project', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'cp-bare-ws-'));
    const app = await createServer({
      workspace,
      registryPath: path.join(await mkdtemp(path.join(os.tmpdir(), 'cp-reg-')), 'projects.json'),
      deps: {
        engine: { recordCase: vi.fn(), replayCase: vi.fn() } as unknown as RunEngine,
        loadRegistry: async (ws: string) => {
          // Mirrors the real loader's file dependency: throws ENOENT without a scaffolded config.
          await readFile(path.join(ws, 'casepilot.config.yaml'), 'utf8');
          return makeRegistry([chatProvider], 'fake-chat');
        },
        resolveMcpBin: () => 'unused',
      },
    });
    openApps.push(app);

    expect(await readFile(path.join(workspace, 'casepilot.config.yaml'), 'utf8')).toContain('providers: []');
    expect(await readFile(path.join(workspace, 'cases', 'example.case.yaml'), 'utf8')).toContain('name: example');

    const res = await app.inject({ method: 'GET', url: '/api/projects/default/providers' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      default: 'fake-chat',
      providers: [{ id: 'fake-chat', kind: 'chat', type: 'fake' }],
    });
  });

  it('does not overwrite an existing config when serving the default workspace', async () => {
    const { workspace } = await setup();
    expect(await readFile(path.join(workspace, 'casepilot.config.yaml'), 'utf8')).toBe('providers: []\n');
    const cases = await readFile(path.join(workspace, 'cases', 'login.case.yaml'), 'utf8');
    expect(cases).toContain('name: login');
  });

  it('cannot DELETE the implicit default project', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'DELETE', url: '/api/projects/default' })).statusCode).toBe(404);
  });
});

describe('POST runs baseUrl', () => {
  it('400s on a non-absolute baseUrl', async () => {
    const { app } = await setup();
    for (const baseUrl of ['/relative', 'staging.example.com', 'ftp://example.com', '']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: { case: 'login', mode: 'record', baseUrl },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('baseUrl');
    }
  });

  it('passes a valid body baseUrl into the engine run options', async () => {
    const recordCase = vi.fn(async () => ({ result: makeResult('record'), replay: makeReplay() }));
    const { app, engine } = await setup({ engine: { recordCase } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { case: 'login', mode: 'record', baseUrl: 'https://req.example.com' },
    });
    expect(res.statusCode).toBe(202);
    const { runId } = res.json() as { runId: string };
    await app.runService.settled(runId);

    expect(engine.recordCase).toHaveBeenCalledTimes(1);
    const options = (engine.recordCase as ReturnType<typeof vi.fn>).mock.calls[0]![2] as { baseUrl?: string };
    expect(options.baseUrl).toBe('https://req.example.com');
  });

  it('body baseUrl overrides the workspace config baseUrl', async () => {
    const recordCase = vi.fn(async () => ({ result: makeResult('record'), replay: makeReplay() }));
    const { app, workspace, engine } = await setup({ engine: { recordCase } });
    await writeFile(
      path.join(workspace, 'casepilot.config.yaml'),
      'providers: []\nbaseUrl: https://cfg.example.com\n',
      'utf8',
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { case: 'login', mode: 'record', baseUrl: 'https://req.example.com' },
    });
    const { runId } = res.json() as { runId: string };
    await app.runService.settled(runId);

    const options = (engine.recordCase as ReturnType<typeof vi.fn>).mock.calls[0]![2] as { baseUrl?: string };
    expect(options.baseUrl).toBe('https://req.example.com');
  });
});

describe('GET /api/runs?case filter', () => {
  function caseAwareRecord() {
    return vi.fn(async (spec: CaseSpec) => ({
      result: { ...makeResult('record'), case: spec.name, caseName: spec.name },
      replay: { ...makeReplay(), case: spec.name },
    }));
  }

  async function addSignupCase(workspace: string): Promise<void> {
    await writeFile(
      path.join(workspace, 'cases', 'signup.case.yaml'),
      CASE_YAML.replace('name: login', 'name: signup'),
      'utf8',
    );
  }

  async function startRun(app: FastifyInstance, caseName: string): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { case: caseName, mode: 'record' } });
    expect(res.statusCode).toBe(202);
    const { runId } = res.json() as { runId: string };
    await app.runService.settled(runId);
    return runId;
  }

  it('returns only runs whose caseName matches exactly', async () => {
    const { app, workspace } = await setup({ engine: { recordCase: caseAwareRecord() } });
    await addSignupCase(workspace);
    const loginRunId = await startRun(app, 'login');
    await startRun(app, 'signup');

    expect((await app.inject({ method: 'GET', url: '/api/runs' })).json()).toHaveLength(2);

    const filtered = await app.inject({ method: 'GET', url: '/api/runs?case=login' });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json()).toEqual([
      expect.objectContaining({ runId: loginRunId, case: 'login', status: 'done', verdict: 'passed' }),
    ]);

    const scoped = await app.inject({ method: 'GET', url: '/api/projects/default/runs?case=login' });
    expect(scoped.json()).toEqual(filtered.json());
  });

  it('returns an empty list (200) for an unknown case name', async () => {
    const { app } = await setup();
    await startRun(app, 'login');
    const res = await app.inject({ method: 'GET', url: '/api/runs?case=no-such-case' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('never matches legacy runs whose result.json predates caseName', async () => {
    const { app, workspace } = await setup();
    const { caseName: _omit, ...legacyResult } = makeResult('record');
    await mkdir(path.join(workspace, 'runs', 'legacy-run'), { recursive: true });
    await writeFile(
      path.join(workspace, 'runs', 'legacy-run', 'result.json'),
      JSON.stringify(legacyResult, null, 2),
      'utf8',
    );

    const rebooted = await createServer({
      workspace,
      registryPath: path.join(await mkdtemp(path.join(os.tmpdir(), 'cp-reg-')), 'projects.json'),
      deps: {
        engine: { recordCase: vi.fn(), replayCase: vi.fn() } as unknown as RunEngine,
        loadRegistry: async () => makeRegistry([chatProvider], 'fake-chat'),
        resolveMcpBin: () => 'unused',
      },
    });
    openApps.push(rebooted);

    const unfiltered = await rebooted.inject({ method: 'GET', url: '/api/runs' });
    expect(unfiltered.json()).toEqual([expect.objectContaining({ runId: 'legacy-run', case: 'login' })]);

    const filtered = await rebooted.inject({ method: 'GET', url: '/api/runs?case=login' });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json()).toEqual([]);
  });

  it('GET /api/cases attaches lastRun only to cases that have runs', async () => {
    const { app, workspace } = await setup({ engine: { recordCase: caseAwareRecord() } });
    await addSignupCase(workspace);

    const before = (await app.inject({ method: 'GET', url: '/api/cases' })).json() as Array<Record<string, unknown>>;
    expect(before).toHaveLength(2);
    for (const row of before) expect(row).not.toHaveProperty('lastRun');

    const firstRunId = await startRun(app, 'login');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const lastRunId = await startRun(app, 'login');
    expect(lastRunId).not.toBe(firstRunId);

    const after = (await app.inject({ method: 'GET', url: '/api/cases' })).json() as Array<{
      name: string;
      lastRun?: { id: string; status: string; verdict?: string; finishedAt?: string };
    }>;
    const login = after.find((row) => row.name === 'login');
    expect(login?.lastRun).toEqual({
      id: lastRunId,
      status: 'done',
      verdict: 'passed',
      finishedAt: expect.any(String),
    });
    const signup = after.find((row) => row.name === 'signup');
    expect(signup).toBeDefined();
    expect(signup).not.toHaveProperty('lastRun');

    const scoped = (await app.inject({ method: 'GET', url: '/api/projects/default/cases' })).json();
    expect(scoped).toEqual(after);
  });
});
