import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { ChatProvider, ReplayFile, ReplayHooks, RunOptions, RunResult } from '@casepilot/core';
import { executeRun, type RunnerDeps } from '../src/runner.js';
import { listHeals } from '../src/heals.js';
import { CONFIG_FILE_NAME } from '../src/scaffold.js';
import type { ProviderRegistryLike } from '../src/providersLoader.js';

const CASE_YAML = `name: login
url: https://example.test/login
steps:
  - Click the Login button
expect:
  - The dashboard heading is visible
`;

const chatProvider: ChatProvider = {
  kind: 'chat',
  id: 'fake-chat',
  generate: async () => ({ text: '' }),
};

const registry: ProviderRegistryLike = {
  get: (id) => {
    if (id !== 'fake-chat') throw new Error(`unknown provider "${id}"`);
    return chatProvider;
  },
  list: () => [{ id: 'fake-chat', kind: 'chat', type: 'fake' }],
  default: () => chatProvider,
};

async function setupWorkspace(): Promise<{ workspace: string; runDir: string }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'cp-runner-'));
  await mkdir(path.join(workspace, 'cases'), { recursive: true });
  await writeFile(path.join(workspace, 'cases', 'login.case.yaml'), CASE_YAML, 'utf8');
  return { workspace, runDir: path.join(workspace, 'runs', 'r1') };
}

describe('executeRun failure reporting', () => {
  it('writes an error result.json to the run dir when the provider/engine throws', async () => {
    const { workspace, runDir } = await setupWorkspace();
    // Simulate the 0-byte video stub a hard-killed bridge leaves behind.
    await mkdir(path.join(runDir, 'video'), { recursive: true });
    await writeFile(path.join(runDir, 'video', 'page@dead.webm'), '', 'utf8');
    const deps: RunnerDeps = {
      engine: {
        recordCase: vi.fn(async () => {
          throw new Error('provider exploded: 401 Invalid authentication credentials');
        }),
        replayCase: vi.fn(),
      },
      loadRegistry: async () => registry,
      resolveMcpBin: () => 'C:/fake/mcp/bin.js',
    };

    await expect(
      executeRun({ workspace, caseName: 'login', mode: 'record', runDir }, deps),
    ).rejects.toThrow(/provider exploded/);

    const result = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')) as RunResult;
    expect(result.verdict).toBe('failed');
    expect(result.mode).toBe('record');
    expect(result.explanation).toMatch(/provider exploded: 401/);
    await expect(readFile(path.join(runDir, 'video', 'page@dead.webm'))).rejects.toThrow();
  });

  it('persists the captured transcript when an agent provider rejects', async () => {
    const { workspace, runDir } = await setupWorkspace();
    const agentError = Object.assign(new Error('claude exited with code 1'), {
      stdout: '{"type":"result","subtype":"error_max_turns"}',
    });
    const agentProvider = {
      kind: 'agent' as const,
      id: 'fake-agent',
      runTask: vi.fn(async () => {
        throw agentError;
      }),
    };
    const agentRegistry: ProviderRegistryLike = {
      get: () => agentProvider,
      list: () => [{ id: 'fake-agent', kind: 'agent', type: 'fake' }],
      default: () => agentProvider,
    };
    const deps: RunnerDeps = {
      engine: { recordCase: vi.fn(), replayCase: vi.fn() },
      loadRegistry: async () => agentRegistry,
      resolveMcpBin: () => 'C:/fake/mcp/bin.js',
    };

    await expect(
      executeRun({ workspace, caseName: 'login', mode: 'record', providerId: 'fake-agent', runDir }, deps),
    ).rejects.toThrow(/exited with code 1/);

    const transcript = await readFile(path.join(runDir, 'transcript.txt'), 'utf8');
    expect(transcript).toContain('error_max_turns');
  });

  it('writes an error result.json when the replay file is missing', async () => {
    const { workspace, runDir } = await setupWorkspace();
    const deps: RunnerDeps = {
      engine: { recordCase: vi.fn(), replayCase: vi.fn() },
      loadRegistry: async () => registry,
      resolveMcpBin: () => 'C:/fake/mcp/bin.js',
    };

    await expect(executeRun({ workspace, caseName: 'login', mode: 'replay', runDir }, deps)).rejects.toThrow();

    const result = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')) as RunResult;
    expect(result.verdict).toBe('failed');
    expect(result.mode).toBe('replay');
    expect(result.explanation).toBeTruthy();
  });
});

function makeReplayFile(): ReplayFile {
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

function passedResult(mode: 'record' | 'replay'): RunResult {
  return {
    case: 'login',
    mode,
    verdict: 'passed',
    explanation: 'ok',
    steps: [],
    artifacts: { screenshots: [] },
    startedAt: '2026-06-11T10:00:00.000Z',
    finishedAt: '2026-06-11T10:00:05.000Z',
  };
}

async function setupReplayWorkspace(): Promise<{ workspace: string; runDir: string }> {
  const { workspace, runDir } = await setupWorkspace();
  await writeFile(
    path.join(workspace, 'cases', 'login.replay.json'),
    JSON.stringify(makeReplayFile(), null, 2),
    'utf8',
  );
  return { workspace, runDir };
}

describe('executeRun option plumbing', () => {
  it('passes viewport and stepScreenshots through to RunOptions for record', async () => {
    const { workspace, runDir } = await setupWorkspace();
    const recordCase = vi.fn(async (_spec, _provider, options: RunOptions) => {
      expect(options).toMatchObject({
        viewport: { width: 1280, height: 720 },
        stepScreenshots: true,
        artifactsDir: runDir,
      });
      return { result: passedResult('record'), replay: makeReplayFile() };
    });
    const deps: RunnerDeps = {
      engine: { recordCase, replayCase: vi.fn() },
      loadRegistry: async () => registry,
      resolveMcpBin: () => 'C:/fake/mcp/bin.js',
    };

    await executeRun(
      {
        workspace,
        caseName: 'login',
        mode: 'record',
        screenshots: true,
        viewport: { width: 1280, height: 720 },
        runDir,
      },
      deps,
    );
    expect(recordCase).toHaveBeenCalledTimes(1);
  });

  it('forwards --screenshots and --viewport to the browser-tools bridge args for agent records', async () => {
    const { workspace, runDir } = await setupWorkspace();
    let capturedArgs: string[] = [];
    const agentProvider = {
      kind: 'agent' as const,
      id: 'fake-agent',
      runTask: vi.fn(async ({ mcp }: { mcp: { args: string[] } }) => {
        capturedArgs = mcp.args;
        await writeFile(path.join(runDir, 'result.json'), JSON.stringify(passedResult('record')), 'utf8');
        return { transcript: 't' };
      }),
    };
    const agentRegistry: ProviderRegistryLike = {
      get: () => agentProvider,
      list: () => [{ id: 'fake-agent', kind: 'agent', type: 'fake' }],
      default: () => agentProvider,
    };
    const deps: RunnerDeps = {
      engine: { recordCase: vi.fn(), replayCase: vi.fn() },
      loadRegistry: async () => agentRegistry,
      resolveMcpBin: () => 'C:/fake/mcp/bin.js',
    };

    await executeRun(
      {
        workspace,
        caseName: 'login',
        mode: 'record',
        screenshots: true,
        viewport: { width: 800, height: 600 },
        runDir,
      },
      deps,
    );
    expect(capturedArgs).toContain('--screenshots');
    expect(capturedArgs.slice(capturedArgs.indexOf('--viewport'))).toEqual(
      expect.arrayContaining(['--viewport', '800x600']),
    );
  });

  it('passes optimizeVideo and videoPadMs through to RunOptions for replay', async () => {
    const { workspace, runDir } = await setupReplayWorkspace();
    const replayCase = vi.fn(async (_replay: ReplayFile, options: RunOptions) => {
      expect(options).toMatchObject({ video: true, optimizeVideo: true, videoPadMs: 250 });
      return passedResult('replay');
    });
    const deps: RunnerDeps = {
      engine: { recordCase: vi.fn(), replayCase },
      loadRegistry: async () => registry,
      resolveMcpBin: () => 'C:/fake/mcp/bin.js',
    };

    await executeRun(
      { workspace, caseName: 'login', mode: 'replay', video: true, optimizeVideo: true, videoPadMs: 250, runDir },
      deps,
    );
    expect(replayCase).toHaveBeenCalledTimes(1);
  });

  it('forwards --optimize-video and --video-pad to the browser-tools bridge args for agent records', async () => {
    const { workspace, runDir } = await setupWorkspace();
    let capturedArgs: string[] = [];
    const agentProvider = {
      kind: 'agent' as const,
      id: 'fake-agent',
      runTask: vi.fn(async ({ mcp }: { mcp: { args: string[] } }) => {
        capturedArgs = mcp.args;
        await writeFile(path.join(runDir, 'result.json'), JSON.stringify(passedResult('record')), 'utf8');
        return { transcript: 't' };
      }),
    };
    const agentRegistry: ProviderRegistryLike = {
      get: () => agentProvider,
      list: () => [{ id: 'fake-agent', kind: 'agent', type: 'fake' }],
      default: () => agentProvider,
    };
    const deps: RunnerDeps = {
      engine: { recordCase: vi.fn(), replayCase: vi.fn() },
      loadRegistry: async () => agentRegistry,
      resolveMcpBin: () => 'C:/fake/mcp/bin.js',
    };

    await executeRun(
      { workspace, caseName: 'login', mode: 'record', video: true, optimizeVideo: true, videoPadMs: 250, runDir },
      deps,
    );
    expect(capturedArgs).toContain('--optimize-video');
    expect(capturedArgs.slice(capturedArgs.indexOf('--video-pad'))).toEqual(
      expect.arrayContaining(['--video-pad', '250']),
    );
  });
});

describe('executeRun heal policy', () => {
  function replayDeps(replayCase: RunnerDeps['engine']['replayCase']): RunnerDeps {
    return {
      engine: { recordCase: vi.fn(), replayCase },
      loadRegistry: async () => registry,
      resolveMcpBin: () => 'C:/fake/mcp/bin.js',
    };
  }

  it('defaults to review: applyHeals false and heal events land in the queue with the runId', async () => {
    const { workspace, runDir } = await setupReplayWorkspace();
    const replayCase = vi.fn(
      async (_replay: ReplayFile, _options: RunOptions, _healer: unknown, hooks?: ReplayHooks) => {
        expect(hooks?.applyHeals).toBe(false);
        await hooks?.onHeal?.({
          caseName: 'login',
          stepIndex: 0,
          oldStep: { kind: 'act', action: 'click', selector: '#old' },
          newStep: { kind: 'act', action: 'click', selector: '#new' },
          createdAt: new Date().toISOString(),
        });
        return passedResult('replay');
      },
    );

    await executeRun({ workspace, caseName: 'login', mode: 'replay', runDir }, replayDeps(replayCase));

    const pending = await listHeals(workspace, 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      caseName: 'login',
      stepIndex: 0,
      runId: path.basename(runDir),
      newStep: { selector: '#new' },
    });
  });

  it('workspace healPolicy: auto enables applyHeals (legacy auto-apply)', async () => {
    const { workspace, runDir } = await setupReplayWorkspace();
    await writeFile(path.join(workspace, CONFIG_FILE_NAME), 'providers: []\nhealPolicy: auto\n', 'utf8');
    const replayCase = vi.fn(
      async (_replay: ReplayFile, _options: RunOptions, _healer: unknown, hooks?: ReplayHooks) => {
        expect(hooks?.applyHeals).toBe(true);
        expect(hooks?.onHeal).toBeUndefined();
        return passedResult('replay');
      },
    );

    await executeRun({ workspace, caseName: 'login', mode: 'replay', runDir }, replayDeps(replayCase));
    expect(replayCase).toHaveBeenCalledTimes(1);
  });

  it('request healPolicy overrides the workspace config', async () => {
    const { workspace, runDir } = await setupReplayWorkspace();
    await writeFile(path.join(workspace, CONFIG_FILE_NAME), 'providers: []\nhealPolicy: review\n', 'utf8');
    const replayCase = vi.fn(
      async (_replay: ReplayFile, _options: RunOptions, _healer: unknown, hooks?: ReplayHooks) => {
        expect(hooks?.applyHeals).toBe(true);
        return passedResult('replay');
      },
    );

    await executeRun(
      { workspace, caseName: 'login', mode: 'replay', healPolicy: 'auto', runDir },
      replayDeps(replayCase),
    );
    expect(replayCase).toHaveBeenCalledTimes(1);
  });
});
