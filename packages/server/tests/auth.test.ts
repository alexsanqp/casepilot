import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { AgentProvider, ReplayFile, RunOptions, RunResult } from '@casepilot/core';
import {
  authDir,
  authProfilePath,
  executeRun,
  resolveAuthOptions,
  type RunnerDeps,
} from '../src/runner.js';
import { fileExists } from '../src/workspace.js';
import { CONFIG_FILE_NAME } from '../src/scaffold.js';
import type { ProviderRegistryLike } from '../src/providersLoader.js';

const chatProvider = {
  kind: 'chat' as const,
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

/**
 * A minimal agent provider whose runTask is a no-op (no real CLI). Used to
 * exercise the agent-record dispatch branch in executeRun without spawning a
 * process; runTask is a spy so tests can assert it was never reached.
 */
function fakeAgentProvider(): AgentProvider & { runTask: ReturnType<typeof vi.fn> } {
  const runTask = vi.fn(async () => ({ transcript: '' }));
  return { kind: 'agent', id: 'fake-agent', runTask };
}

/** A registry whose default provider is the given agent provider. */
function agentRegistry(agent: AgentProvider): ProviderRegistryLike {
  return {
    get: (id) => {
      if (id !== agent.id) throw new Error(`unknown provider "${id}"`);
      return agent;
    },
    list: () => [{ id: agent.id, kind: 'agent', type: 'fake' }],
    default: () => agent,
  };
}

function passedResult(mode: 'record' | 'replay'): RunResult {
  return {
    case: 'x',
    caseName: 'x',
    mode,
    verdict: 'passed',
    explanation: 'ok',
    steps: [],
    artifacts: { screenshots: [] },
    startedAt: '2026-06-13T10:00:00.000Z',
    finishedAt: '2026-06-13T10:00:05.000Z',
  };
}

function replayFor(name: string, extra: Partial<ReplayFile> = {}): ReplayFile {
  return {
    version: 1,
    case: name,
    url: 'https://example.test/',
    providerUsed: 'fake-chat',
    recordedAt: '2026-06-13T10:00:00.000Z',
    steps: [{ kind: 'act', action: 'click', selector: '#x' }],
    meta: { healCount: 0 },
    ...extra,
  };
}

const CASE_YAML = (name: string) => `name: ${name}
url: https://example.test/
steps:
  - Click something
expect:
  - It worked
`;

async function workspace(config?: string): Promise<string> {
  const ws = await mkdtemp(path.join(os.tmpdir(), 'cp-auth-'));
  await mkdir(path.join(ws, 'cases'), { recursive: true });
  if (config !== undefined) {
    await writeFile(path.join(ws, CONFIG_FILE_NAME), config, 'utf8');
  }
  return ws;
}

function depsWith(
  over: Partial<RunnerDeps['engine']> = {},
  registryOverride?: ProviderRegistryLike,
): RunnerDeps {
  return {
    engine: { recordCase: vi.fn(), replayCase: vi.fn(), ...over },
    loadRegistry: async () => registryOverride ?? registry,
    resolveMcpBin: () => 'C:/fake/mcp/bin.js',
  };
}

describe('authProfilePath', () => {
  it('rejects a path-traversal profile name', () => {
    expect(() => authProfilePath('C:/ws', '../x')).toThrow(/invalid auth profile name/);
    expect(() => authProfilePath('C:/ws', 'a/b')).toThrow(/invalid auth profile name/);
  });

  it('rejects the reserved profile name "none"', () => {
    expect(() => authProfilePath('C:/ws', 'none')).toThrow(/auth profile name "none" is reserved/);
  });

  it('builds a path under auth/ for a safe name', () => {
    expect(authProfilePath('C:/ws', 'main')).toBe(path.join('C:/ws', 'auth', 'main.json'));
  });
});

describe('resolveAuthOptions — resolution table', () => {
  it('explicit useAuth wins and points storageStatePath at the profile (auto-refresh off when present)', async () => {
    const ws = await workspace('providers: []\ndefaultAuth: ignored\n');
    // Make the profile present so no missing-profile path triggers.
    await mkdir(authDir(ws), { recursive: true });
    await writeFile(authProfilePath(ws, 'admin'), '{"cookies":[],"origins":[]}', 'utf8');
    const out = await resolveAuthOptions(ws, { useAuth: 'admin' }, depsWith());
    expect(out.storageStatePath).toBe(authProfilePath(ws, 'admin'));
    expect(out.saveStorageStatePath).toBeUndefined();
  });

  it('a producer (saveAuth set) resolves effective useAuth to none → no storageStatePath', async () => {
    const ws = await workspace('providers: []\ndefaultAuth: main\n');
    const out = await resolveAuthOptions(ws, { saveAuth: 'main' }, depsWith());
    expect(out.storageStatePath).toBeUndefined();
    expect(out.saveStorageStatePath).toBe(authProfilePath(ws, 'main'));
  });

  it('falls back to the workspace defaultAuth when neither useAuth nor saveAuth is set', async () => {
    const ws = await workspace('providers: []\ndefaultAuth: main\n');
    await mkdir(authDir(ws), { recursive: true });
    await writeFile(authProfilePath(ws, 'main'), '{"cookies":[],"origins":[]}', 'utf8');
    const out = await resolveAuthOptions(ws, {}, depsWith());
    expect(out.storageStatePath).toBe(authProfilePath(ws, 'main'));
    expect(out.saveStorageStatePath).toBeUndefined();
  });

  it('resolves to none (no paths) when nothing is configured', async () => {
    const ws = await workspace('providers: []\n');
    const out = await resolveAuthOptions(ws, {}, depsWith());
    expect(out.storageStatePath).toBeUndefined();
    expect(out.saveStorageStatePath).toBeUndefined();
  });

  it('explicit useAuth: none opts out even when a defaultAuth exists', async () => {
    const ws = await workspace('providers: []\ndefaultAuth: main\n');
    const out = await resolveAuthOptions(ws, { useAuth: 'none' }, depsWith());
    expect(out.storageStatePath).toBeUndefined();
  });

  it('writes auth/.gitignore (= "*") when a saveAuth resolution runs', async () => {
    const ws = await workspace('providers: []\n');
    await resolveAuthOptions(ws, { saveAuth: 'main' }, depsWith());
    const gi = await readFile(path.join(authDir(ws), '.gitignore'), 'utf8');
    expect(gi).toBe('*\n');
  });

  it('rejects a saveAuth of the reserved name "none"', async () => {
    const ws = await workspace('providers: []\n');
    await expect(resolveAuthOptions(ws, { saveAuth: 'none' }, depsWith())).rejects.toThrow(
      /auth profile name "none" is reserved/,
    );
  });
});

describe('resolveAuthOptions — missing profile', () => {
  it('manual (default) + missing profile throws the actionable message', async () => {
    const ws = await workspace('providers: []\ndefaultAuth: main\n');
    await expect(resolveAuthOptions(ws, { useAuth: 'main' }, depsWith())).rejects.toThrow(
      /auth profile "main" not found; record or run the login case \(saveAuth: main\) first/,
    );
  });

  it('auto + missing profile invokes the producer case, which writes the profile, then resolves', async () => {
    const ws = await workspace('providers: []\ndefaultAuth: main\nauthRefresh: auto\n');
    // A producer case "do-login" whose replay carries saveAuth: main.
    await writeFile(path.join(ws, 'cases', 'do-login.case.yaml'), CASE_YAML('do-login'), 'utf8');
    await writeFile(
      path.join(ws, 'cases', 'do-login.replay.json'),
      JSON.stringify(replayFor('do-login', { saveAuth: 'main' }), null, 2),
      'utf8',
    );

    // The injected replay engine simulates the producer effect: a passing run
    // writes the storageState file to saveStorageStatePath.
    const replayCase = vi.fn(async (_replay: ReplayFile, options: RunOptions) => {
      if (options.saveStorageStatePath) {
        await mkdir(path.dirname(options.saveStorageStatePath), { recursive: true });
        await writeFile(options.saveStorageStatePath, '{"cookies":[],"origins":[]}', 'utf8');
      }
      return passedResult('replay');
    });
    const deps = depsWith({ replayCase });

    const out = await resolveAuthOptions(ws, { useAuth: 'main' }, deps);
    expect(replayCase).toHaveBeenCalledTimes(1);
    expect(out.storageStatePath).toBe(authProfilePath(ws, 'main'));
    expect(await fileExists(authProfilePath(ws, 'main'))).toBe(true);
  });

  it('auto + missing profile with no producer falls back to the actionable error', async () => {
    const ws = await workspace('providers: []\nauthRefresh: auto\n');
    await expect(resolveAuthOptions(ws, { useAuth: 'main' }, depsWith())).rejects.toThrow(
      /auth profile "main" not found/,
    );
  });

  it('auto + missing profile where the producer still does not write it falls back to the error', async () => {
    const ws = await workspace('providers: []\nauthRefresh: auto\n');
    await writeFile(path.join(ws, 'cases', 'do-login.case.yaml'), CASE_YAML('do-login'), 'utf8');
    await writeFile(
      path.join(ws, 'cases', 'do-login.replay.json'),
      JSON.stringify(replayFor('do-login', { saveAuth: 'main' }), null, 2),
      'utf8',
    );
    // Producer runs but does NOT create the profile (e.g. it failed silently).
    const replayCase = vi.fn(async () => passedResult('replay'));
    await expect(
      resolveAuthOptions(ws, { useAuth: 'main' }, depsWith({ replayCase })),
    ).rejects.toThrow(/auth profile "main" not found/);
    expect(replayCase).toHaveBeenCalledTimes(1);
  });
});

describe('executeRun auth wiring', () => {
  it('sets storageStatePath on RunOptions for a replay whose replay carries useAuth', async () => {
    const ws = await workspace('providers: []\n');
    await mkdir(authDir(ws), { recursive: true });
    await writeFile(authProfilePath(ws, 'main'), '{"cookies":[],"origins":[]}', 'utf8');
    await writeFile(
      path.join(ws, 'cases', 'edit.case.yaml'),
      CASE_YAML('edit'),
      'utf8',
    );
    await writeFile(
      path.join(ws, 'cases', 'edit.replay.json'),
      JSON.stringify(replayFor('edit', { useAuth: 'main' }), null, 2),
      'utf8',
    );
    const replayCase = vi.fn(async (_replay: ReplayFile, options: RunOptions) => {
      expect(options.storageStatePath).toBe(authProfilePath(ws, 'main'));
      expect(options.saveStorageStatePath).toBeUndefined();
      return passedResult('replay');
    });

    await executeRun(
      { workspace: ws, caseName: 'edit', mode: 'replay', runDir: path.join(ws, 'runs', 'r1') },
      depsWith({ replayCase }),
    );
    expect(replayCase).toHaveBeenCalledTimes(1);
  });

  it('sets saveStorageStatePath (and no storageStatePath) for a record of a producer case with saveAuth', async () => {
    const ws = await workspace('providers: []\ndefaultAuth: main\n');
    await writeFile(
      path.join(ws, 'cases', 'do-login.case.yaml'),
      `name: do-login\nurl: https://example.test/login\nsaveAuth: main\nsteps:\n  - Log in\nexpect:\n  - Dashboard is visible\n`,
      'utf8',
    );
    const recordCase = vi.fn(async (_spec, _provider, options: RunOptions) => {
      expect(options.saveStorageStatePath).toBe(authProfilePath(ws, 'main'));
      expect(options.storageStatePath).toBeUndefined();
      return { result: passedResult('record'), replay: replayFor('do-login', { saveAuth: 'main' }) };
    });

    await executeRun(
      { workspace: ws, caseName: 'do-login', mode: 'record', runDir: path.join(ws, 'runs', 'r1') },
      depsWith({ recordCase }),
    );
    expect(recordCase).toHaveBeenCalledTimes(1);
  });
});

describe('executeRun — auth on agent-CLI records is rejected', () => {
  it('throws an actionable error for an agent-provider record that requests saveAuth', async () => {
    const ws = await workspace('providers: []\n');
    await writeFile(
      path.join(ws, 'cases', 'do-login.case.yaml'),
      `name: do-login\nurl: https://example.test/login\nsaveAuth: main\nsteps:\n  - Log in\nexpect:\n  - Dashboard is visible\n`,
      'utf8',
    );
    const agent = fakeAgentProvider();
    await expect(
      executeRun(
        { workspace: ws, caseName: 'do-login', mode: 'record', runDir: path.join(ws, 'runs', 'r1') },
        depsWith({}, agentRegistry(agent)),
      ),
    ).rejects.toThrow(/auth \(useAuth\/saveAuth\) is not supported on agent-CLI records yet.*"main"/);
    // The agent CLI must never be reached when auth is requested.
    expect(agent.runTask).not.toHaveBeenCalled();
  });

  it('throws an actionable error for an agent-provider record that requests useAuth', async () => {
    const ws = await workspace('providers: []\n');
    // Profile present so resolveAuthOptions does not throw missing-profile first.
    await mkdir(authDir(ws), { recursive: true });
    await writeFile(authProfilePath(ws, 'main'), '{"cookies":[],"origins":[]}', 'utf8');
    await writeFile(
      path.join(ws, 'cases', 'edit.case.yaml'),
      `name: edit\nurl: https://example.test/\nuseAuth: main\nsteps:\n  - Click something\nexpect:\n  - It worked\n`,
      'utf8',
    );
    const agent = fakeAgentProvider();
    await expect(
      executeRun(
        { workspace: ws, caseName: 'edit', mode: 'record', runDir: path.join(ws, 'runs', 'r1') },
        depsWith({}, agentRegistry(agent)),
      ),
    ).rejects.toThrow(/auth \(useAuth\/saveAuth\) is not supported on agent-CLI records yet.*"main"/);
    expect(agent.runTask).not.toHaveBeenCalled();
  });

  it('does NOT throw for an agent-provider record with no auth (still records)', async () => {
    const ws = await workspace('providers: []\n');
    await writeFile(path.join(ws, 'cases', 'plain.case.yaml'), CASE_YAML('plain'), 'utf8');
    const agent = fakeAgentProvider();
    // The agent records normally: runTask returns, then the bridge result.json
    // is read. Pre-seed a passing result.json so recordViaAgent succeeds.
    agent.runTask.mockImplementation(async () => {
      await writeFile(
        path.join(ws, 'runs', 'r1', 'result.json'),
        JSON.stringify({ verdict: 'passed', artifacts: { screenshots: [] } }),
        'utf8',
      );
      return { transcript: 'done' };
    });

    const result = await executeRun(
      { workspace: ws, caseName: 'plain', mode: 'record', runDir: path.join(ws, 'runs', 'r1') },
      depsWith({}, agentRegistry(agent)),
    );
    expect(agent.runTask).toHaveBeenCalledTimes(1);
    expect(result.verdict).toBe('passed');
  });
});

describe('ensureAuthProfile — auto-refresh producer failure', () => {
  it('wraps a producer run failure with the profile and producer case context', async () => {
    const ws = await workspace('providers: []\ndefaultAuth: main\nauthRefresh: auto\n');
    await writeFile(path.join(ws, 'cases', 'do-login.case.yaml'), CASE_YAML('do-login'), 'utf8');
    await writeFile(
      path.join(ws, 'cases', 'do-login.replay.json'),
      JSON.stringify(replayFor('do-login', { saveAuth: 'main' }), null, 2),
      'utf8',
    );
    // The producer replay engine blows up (e.g. the login UI changed).
    const replayCase = vi.fn(async () => {
      throw new Error('login button not found');
    });

    await expect(resolveAuthOptions(ws, { useAuth: 'main' }, depsWith({ replayCase }))).rejects.toThrow(
      /auto-refresh of auth profile "main" failed while running producer case "do-login": login button not found/,
    );
  });
});
