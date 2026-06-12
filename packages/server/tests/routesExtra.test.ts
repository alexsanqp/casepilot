import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatProvider, ReplayFile, RunResult } from '@casepilot/core';
import { createServer } from '../src/server.js';
import { addHeal, type HealInput } from '../src/heals.js';
import type { RunEngine } from '../src/runner.js';
import type { ProviderRegistryLike } from '../src/providersLoader.js';

const CASE_YAML = `name: login
url: https://example.test/login
steps:
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
    steps: [{ kind: 'act', action: 'click', selector: '#old' }],
    meta: { healCount: 0 },
  };
}

function makeResult(mode: 'record' | 'replay'): RunResult {
  return {
    case: 'login',
    caseName: 'login',
    mode,
    verdict: 'passed',
    explanation: 'ok',
    steps: [],
    artifacts: { screenshots: [] },
    startedAt: '2026-06-11T10:00:00.000Z',
    finishedAt: '2026-06-11T10:00:05.000Z',
  };
}

function healInput(overrides?: Partial<HealInput>): HealInput {
  return {
    caseName: 'login',
    stepIndex: 0,
    oldStep: { kind: 'act', action: 'click', selector: '#old' },
    newStep: { kind: 'act', action: 'click', selector: '#new' },
    runId: 'run-1',
    createdAt: '2026-06-12T08:00:00.000Z',
    ...overrides,
  };
}

const chatProvider: ChatProvider = { kind: 'chat', id: 'fake-chat', generate: async () => ({ text: '' }) };

const registry: ProviderRegistryLike = {
  get: () => chatProvider,
  list: () => [{ id: 'fake-chat', kind: 'chat', type: 'fake' }],
  default: () => chatProvider,
};

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function setup(engineOverrides?: Partial<RunEngine>) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'cp-routes-'));
  await mkdir(path.join(workspace, 'cases'), { recursive: true });
  await writeFile(path.join(workspace, 'casepilot.config.yaml'), 'providers: []\n', 'utf8');
  await writeFile(path.join(workspace, 'cases', 'login.case.yaml'), CASE_YAML, 'utf8');
  await writeFile(path.join(workspace, 'cases', 'login.replay.json'), JSON.stringify(makeReplay(), null, 2), 'utf8');
  const engine: RunEngine = {
    recordCase: vi.fn(async () => ({ result: makeResult('record'), replay: makeReplay() })),
    replayCase: vi.fn(async () => makeResult('replay')),
    ...engineOverrides,
  };
  const app = await createServer({
    workspace,
    registryPath: path.join(await mkdtemp(path.join(os.tmpdir(), 'cp-reg-')), 'projects.json'),
    deps: { engine, loadRegistry: async () => registry, resolveMcpBin: () => 'C:/fake/mcp/bin.js' },
  });
  openApps.push(app);
  return { workspace, app, engine };
}

async function startRun(app: FastifyInstance, payload: Record<string, unknown>): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/projects/default/runs', payload });
  expect(res.statusCode).toBe(202);
  const { runId } = res.json() as { runId: string };
  await app.runService.settled(runId);
  return runId;
}

describe('POST /runs body options plumbing', () => {
  it('passes screenshots and viewport through to the engine RunOptions', async () => {
    const { app, engine } = await setup();
    await startRun(app, {
      case: 'login',
      mode: 'record',
      screenshots: true,
      viewport: { width: 1280, height: 720 },
    });
    const options = (engine.recordCase as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(options).toMatchObject({ stepScreenshots: true, viewport: { width: 1280, height: 720 } });
  });

  it('passes optimizeVideo and videoPadMs through to the engine RunOptions', async () => {
    const { app, engine } = await setup();
    await startRun(app, {
      case: 'login',
      mode: 'record',
      video: true,
      optimizeVideo: true,
      videoPadMs: 250,
    });
    const options = (engine.recordCase as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(options).toMatchObject({ video: true, optimizeVideo: true, videoPadMs: 250 });
  });

  it('passes healPolicy auto through to the replay hooks', async () => {
    const { app, engine } = await setup();
    await startRun(app, { case: 'login', mode: 'replay', healPolicy: 'auto' });
    const hooks = (engine.replayCase as ReturnType<typeof vi.fn>).mock.calls[0]![3];
    expect(hooks).toMatchObject({ applyHeals: true });
  });

  it('defaults to review hooks when the body has no healPolicy', async () => {
    const { app, engine } = await setup();
    await startRun(app, { case: 'login', mode: 'replay' });
    const hooks = (engine.replayCase as ReturnType<typeof vi.fn>).mock.calls[0]![3];
    expect(hooks).toMatchObject({ applyHeals: false });
    expect(typeof hooks.onHeal).toBe('function');
  });

  it('400s on a malformed viewport or healPolicy', async () => {
    const { app } = await setup();
    const badViewport = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { case: 'login', mode: 'record', viewport: { width: -1, height: 0 } },
    });
    expect(badViewport.statusCode).toBe(400);
    const badPolicy = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { case: 'login', mode: 'replay', healPolicy: 'yolo' },
    });
    expect(badPolicy.statusCode).toBe(400);
  });

  it('passes slowMo and stepDelayMs through to the engine RunOptions', async () => {
    const { app, engine } = await setup();
    await startRun(app, { case: 'login', mode: 'replay', slowMo: 150, stepDelayMs: 600 });
    const options = (engine.replayCase as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(options).toMatchObject({ slowMo: 150, stepDelayMs: 600 });
  });

  it('accepts the slowMo/stepDelayMs bounds 0 and 10000', async () => {
    const { app, engine } = await setup();
    await startRun(app, { case: 'login', mode: 'replay', slowMo: 0, stepDelayMs: 10000 });
    const options = (engine.replayCase as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(options).toMatchObject({ slowMo: 0, stepDelayMs: 10000 });
  });

  it('400s on negative, fractional, over-cap, or non-numeric slowMo/stepDelayMs', async () => {
    const { app } = await setup();
    for (const field of ['slowMo', 'stepDelayMs']) {
      for (const bad of [-1, 1.5, 10001, 'fast']) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/runs',
          payload: { case: 'login', mode: 'replay', [field]: bad },
        });
        expect(res.statusCode).toBe(400);
      }
    }
  });

  it('400s on a malformed optimizeVideo or videoPadMs', async () => {
    const { app } = await setup();
    const badOptimize = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { case: 'login', mode: 'record', optimizeVideo: 'yes' },
    });
    expect(badOptimize.statusCode).toBe(400);
    for (const bad of [-5, 0, 1.5]) {
      const badPad = await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: { case: 'login', mode: 'record', videoPadMs: bad },
      });
      expect(badPad.statusCode).toBe(400);
    }
  });
});

describe('GET /runs/:id/video/optimized', () => {
  it('streams the optimized video when the run produced one', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'cp-optvid-'));
    const optimizedVideoPath = path.join(workspace, 'video.optimized.webm');
    await writeFile(optimizedVideoPath, 'webm-bytes', 'utf8');
    const result = makeResult('replay');
    result.artifacts.optimizedVideoPath = optimizedVideoPath;
    const { app } = await setup({ replayCase: vi.fn(async () => result) });

    const runId = await startRun(app, { case: 'login', mode: 'replay' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/default/runs/${runId}/video/optimized`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/webm');
    expect(res.rawPayload.toString('utf8')).toBe('webm-bytes');
  });

  it('404s when the run has no optimized video or the run is unknown', async () => {
    const { app } = await setup();
    const runId = await startRun(app, { case: 'login', mode: 'replay' });
    expect(
      (
        await app.inject({ method: 'GET', url: `/api/projects/default/runs/${runId}/video/optimized` })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/api/projects/default/runs/ghost/video/optimized' })).statusCode,
    ).toBe(404);
  });
});

describe('heals REST API', () => {
  it('lists pending heals by default and everything with ?all=1', async () => {
    const { app, workspace } = await setup();
    const a = await addHeal(workspace, healInput());
    const b = await addHeal(workspace, healInput({ stepIndex: 5 }));
    const reject = await app.inject({ method: 'POST', url: `/api/projects/default/heals/${b.id}/reject` });
    expect(reject.statusCode).toBe(200);
    expect(reject.json()).toEqual({ applied: false });

    const pending = await app.inject({ method: 'GET', url: '/api/projects/default/heals' });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().heals).toEqual([expect.objectContaining({ id: a.id, status: 'pending' })]);

    const all = await app.inject({ method: 'GET', url: '/api/projects/default/heals?all=1' });
    expect(all.json().heals).toHaveLength(2);
  });

  it('approve applies the heal into the replay and bumps healCount', async () => {
    const { app, workspace } = await setup();
    const heal = await addHeal(workspace, healInput());
    const res = await app.inject({ method: 'POST', url: `/api/projects/default/heals/${heal.id}/approve` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ applied: true });

    const replay = JSON.parse(
      await readFile(path.join(workspace, 'cases', 'login.replay.json'), 'utf8'),
    ) as ReplayFile;
    expect(replay.steps[0]).toMatchObject({ selector: '#new' });
    expect(replay.meta.healCount).toBe(1);
  });

  it('409s with the conflict message when the replay step changed', async () => {
    const { app, workspace } = await setup();
    const heal = await addHeal(
      workspace,
      healInput({ oldStep: { kind: 'act', action: 'click', selector: '#stale' } }),
    );
    const res = await app.inject({ method: 'POST', url: `/api/projects/default/heals/${heal.id}/approve` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'replay step changed since heal was recorded' });
  });

  it('404s for unknown heals and 409s when already resolved', async () => {
    const { app, workspace } = await setup();
    expect(
      (await app.inject({ method: 'POST', url: '/api/projects/default/heals/ghost/approve' })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: '/api/projects/default/heals/ghost/reject' })).statusCode,
    ).toBe(404);

    const heal = await addHeal(workspace, healInput());
    await app.inject({ method: 'POST', url: `/api/projects/default/heals/${heal.id}/reject` });
    const again = await app.inject({ method: 'POST', url: `/api/projects/default/heals/${heal.id}/reject` });
    expect(again.statusCode).toBe(409);
    const approveResolved = await app.inject({
      method: 'POST',
      url: `/api/projects/default/heals/${heal.id}/approve`,
    });
    expect(approveResolved.statusCode).toBe(409);
  });
});

describe('GET /runs/:id/screenshots/:fileName', () => {
  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  async function runWithScreenshot(app: FastifyInstance, workspace: string): Promise<string> {
    const runId = await startRun(app, { case: 'login', mode: 'replay' });
    const dir = path.join(workspace, 'runs', runId, 'screenshots');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'step-0.png'), PNG_BYTES);
    return runId;
  }

  it('streams an existing screenshot as png', async () => {
    const { app, workspace } = await setup();
    const runId = await runWithScreenshot(app, workspace);
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/default/runs/${runId}/screenshots/step-0.png`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.subarray(0, 4)).toEqual(PNG_BYTES.subarray(0, 4));
  });

  it('rejects path traversal file names with 400', async () => {
    const { app, workspace } = await setup();
    const runId = await runWithScreenshot(app, workspace);
    for (const bad of ['..%2Fresult.json', '..%5Cresult.json', 'a%2Fb.png']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/default/runs/${runId}/screenshots/${bad}`,
      });
      expect(res.statusCode).toBe(400);
    }
    // A literal ".." segment never reaches the handler: the router refuses it.
    const dotDot = await app.inject({
      method: 'GET',
      url: `/api/projects/default/runs/${runId}/screenshots/%2E%2E`,
    });
    expect(dotDot.statusCode).not.toBe(200);
  });

  it('404s for a missing screenshot or unknown run', async () => {
    const { app, workspace } = await setup();
    const runId = await runWithScreenshot(app, workspace);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/projects/default/runs/${runId}/screenshots/nope.png`,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({ method: 'GET', url: '/api/projects/default/runs/ghost/screenshots/step-0.png' })
      ).statusCode,
    ).toBe(404);
  });
});

describe('GET /runs/:id/archive', () => {
  it('streams a zip of the run dir as an attachment', async () => {
    const { app } = await setup();
    const runId = await startRun(app, { case: 'login', mode: 'replay' });
    const res = await app.inject({ method: 'GET', url: `/api/projects/default/runs/${runId}/archive` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="login-${runId}.zip"`);
    expect(res.rawPayload.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('404s for an unknown run', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/projects/default/runs/ghost/archive' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/fs/dirs', () => {
  it('lists subdirectories sorted by name, filtering hidden and system dirs', async () => {
    const { app } = await setup();
    const root = await mkdtemp(path.join(os.tmpdir(), 'cp-fs-'));
    for (const name of ['beta', 'alpha', '.hidden', '$Recycle.Bin']) {
      await mkdir(path.join(root, name), { recursive: true });
    }
    await writeFile(path.join(root, 'file.txt'), 'x', 'utf8');

    const res = await app.inject({ method: 'GET', url: `/api/fs/dirs?path=${encodeURIComponent(root)}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { path: string; parent: string | null; dirs: Array<{ name: string; path: string }> };
    expect(body.path).toBe(root);
    expect(body.parent).toBe(path.dirname(root));
    expect(body.dirs.map((d) => d.name)).toEqual(['alpha', 'beta']);
    expect(body.dirs[0]!.path).toBe(path.join(root, 'alpha'));
  });

  it('400s for a missing or relative path', async () => {
    const { app } = await setup();
    const missing = await app.inject({
      method: 'GET',
      url: `/api/fs/dirs?path=${encodeURIComponent(path.join(os.tmpdir(), 'cp-definitely-missing'))}`,
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toHaveProperty('error');

    const relative = await app.inject({ method: 'GET', url: '/api/fs/dirs?path=not-absolute' });
    expect(relative.statusCode).toBe(400);
  });

  it('returns the drive list on win32 when no path is given', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/fs/dirs' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { parent: string | null; dirs: Array<{ name: string; path: string }> };
    expect(body.parent).toBeNull();
    if (process.platform === 'win32') {
      expect(body.dirs).toEqual(expect.arrayContaining([{ name: 'C:', path: 'C:\\' }]));
    } else {
      expect(Array.isArray(body.dirs)).toBe(true);
    }
  });
});
