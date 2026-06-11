import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AgentProvider, ChatProvider, Provider, ReplayFile, RunResult } from '@casepilot/core';
import { createServer } from '../src/server.js';
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
  const app = await createServer({
    workspace,
    deps: {
      engine,
      loadRegistry: async () => registry,
      resolveMcpBin: () => 'C:/fake/mcp/dist/bin.js',
    },
  });
  openApps.push(app);
  return { workspace, app, engine };
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

  it('marks the run as error when the engine throws', async () => {
    const { app } = await setup({
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

    const runRes = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(runRes.json()).toMatchObject({ status: 'error', error: 'provider exploded' });
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
