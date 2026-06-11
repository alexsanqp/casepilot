import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { AgentProvider, ChatProvider, Provider, ReplayFile, RunResult } from '@casepilot/core';
import { createControlHandlers, type ControlDeps, type ToolText } from '../src/control.js';
import type { ProviderRegistryLike } from '../src/providersLoader.js';

const CASE_YAML = `name: login
url: https://example.test/login
steps:
  - Fill the username field with "demo"
  - Click the Login button
expect:
  - The dashboard heading is visible
`;

function makeReplay(name = 'login'): ReplayFile {
  return {
    version: 1,
    case: name,
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

const agentProvider: AgentProvider = {
  kind: 'agent',
  id: 'fake-agent',
  runTask: async () => ({ transcript: '' }),
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

interface Fixture {
  workspace: string;
  deps: ControlDeps;
  recordCase: ReturnType<typeof vi.fn>;
  replayCase: ReturnType<typeof vi.fn>;
}

async function makeFixture(overrides?: {
  registry?: ProviderRegistryLike;
  recordResult?: RunResult;
  replayResult?: RunResult;
  withCase?: boolean;
  withReplay?: boolean;
}): Promise<Fixture> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'cp-control-'));
  await mkdir(path.join(workspace, 'cases'), { recursive: true });
  if (overrides?.withCase !== false) {
    await writeFile(path.join(workspace, 'cases', 'login.case.yaml'), CASE_YAML, 'utf8');
  }
  if (overrides?.withReplay) {
    await writeFile(
      path.join(workspace, 'cases', 'login.replay.json'),
      JSON.stringify(makeReplay(), null, 2),
      'utf8',
    );
  }
  const recordCase = vi.fn(async () => ({
    result: overrides?.recordResult ?? makeResult('record'),
    replay: makeReplay(),
  }));
  const replayCase = vi.fn(async () => overrides?.replayResult ?? makeResult('replay'));
  let counter = 0;
  const deps: ControlDeps = {
    workspace,
    engine: { recordCase, replayCase },
    loadRegistry: async () => overrides?.registry ?? makeRegistry([chatProvider, agentProvider], 'fake-chat'),
    exportSpec: () => `import { test, expect } from '@playwright/test';`,
    newRunId: () => `run-${++counter}`,
  };
  return { workspace, deps, recordCase, replayCase };
}

function payload(result: ToolText): string {
  return result.content[0]!.text;
}

describe('list_cases', () => {
  it('returns an empty list for a workspace without cases', async () => {
    const { deps } = await makeFixture({ withCase: false });
    const handlers = createControlHandlers(deps);
    expect(JSON.parse(payload(await handlers.list_cases()))).toEqual([]);
  });

  it('lists cases with url and replay presence', async () => {
    const { deps, workspace } = await makeFixture({ withReplay: true });
    const handlers = createControlHandlers(deps);
    const cases = JSON.parse(payload(await handlers.list_cases())) as Array<Record<string, unknown>>;
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      name: 'login',
      url: 'https://example.test/login',
      hasReplay: true,
      file: path.join(workspace, 'cases', 'login.case.yaml'),
    });
  });
});

describe('get_case', () => {
  it('returns spec, raw yaml and replay when present', async () => {
    const { deps } = await makeFixture({ withReplay: true });
    const handlers = createControlHandlers(deps);
    const body = JSON.parse(payload(await handlers.get_case({ name: 'login' })));
    expect(body.spec.name).toBe('login');
    expect(body.specYaml).toContain('Click the Login button');
    expect(body.replay.providerUsed).toBe('fake-chat');
  });

  it('errors for an unknown case', async () => {
    const { deps } = await makeFixture();
    const handlers = createControlHandlers(deps);
    const result = await handlers.get_case({ name: 'nope' });
    expect(result.isError).toBe(true);
    expect(payload(result)).toContain('not found');
  });

  it('rejects unsafe names', async () => {
    const { deps } = await makeFixture();
    const handlers = createControlHandlers(deps);
    const result = await handlers.get_case({ name: '../escape' });
    expect(result.isError).toBe(true);
  });
});

describe('upsert_case', () => {
  it('saves a valid case yaml', async () => {
    const { deps, workspace } = await makeFixture({ withCase: false });
    const handlers = createControlHandlers(deps);
    const result = await handlers.upsert_case({ name: 'signup', yaml: CASE_YAML.replace('login', 'signup') });
    expect(result.isError).toBeUndefined();
    const written = await readFile(path.join(workspace, 'cases', 'signup.case.yaml'), 'utf8');
    expect(written).toContain('Click the Login button');
  });

  it('rejects yaml that is not a valid case spec', async () => {
    const { deps } = await makeFixture();
    const handlers = createControlHandlers(deps);
    const result = await handlers.upsert_case({ name: 'bad', yaml: 'name: bad\nurl: x\n' });
    expect(result.isError).toBe(true);
    expect(payload(result)).toContain('steps');
  });

  it('rejects syntactically broken yaml', async () => {
    const { deps } = await makeFixture();
    const handlers = createControlHandlers(deps);
    const result = await handlers.upsert_case({ name: 'bad', yaml: 'name: [unclosed' });
    expect(result.isError).toBe(true);
    expect(payload(result)).toContain('invalid YAML');
  });
});

describe('run_case', () => {
  it('replays an existing replay and writes result.json', async () => {
    const { deps, workspace, replayCase } = await makeFixture({ withReplay: true });
    const handlers = createControlHandlers(deps);
    const body = JSON.parse(payload(await handlers.run_case({ name: 'login', mode: 'replay' })));
    expect(replayCase).toHaveBeenCalledTimes(1);
    expect(body.verdict).toBe('passed');
    const saved = JSON.parse(await readFile(path.join(workspace, 'runs', body.runId, 'result.json'), 'utf8'));
    expect(saved.mode).toBe('replay');
  });

  it('errors when replaying a case that has no replay', async () => {
    const { deps, replayCase } = await makeFixture();
    const handlers = createControlHandlers(deps);
    const result = await handlers.run_case({ name: 'login', mode: 'replay' });
    expect(result.isError).toBe(true);
    expect(payload(result)).toContain('no replay');
    expect(replayCase).not.toHaveBeenCalled();
  });

  it('records via a chat provider and copies the replay back to cases/', async () => {
    const { deps, workspace, recordCase } = await makeFixture();
    const handlers = createControlHandlers(deps);
    const body = JSON.parse(payload(await handlers.run_case({ name: 'login', mode: 'record' })));
    expect(recordCase).toHaveBeenCalledTimes(1);
    expect(body.verdict).toBe('passed');
    const replay = JSON.parse(await readFile(path.join(workspace, 'cases', 'login.replay.json'), 'utf8'));
    expect(replay.case).toBe('login');
  });

  it('does not copy the replay back when the recording verdict failed', async () => {
    const { deps, workspace } = await makeFixture({ recordResult: makeResult('record', 'failed') });
    const handlers = createControlHandlers(deps);
    const body = JSON.parse(payload(await handlers.run_case({ name: 'login', mode: 'record' })));
    expect(body.verdict).toBe('failed');
    await expect(readFile(path.join(workspace, 'cases', 'login.replay.json'), 'utf8')).rejects.toThrow();
  });

  it('refuses record mode for agent providers and points at the REST server', async () => {
    const { deps, recordCase } = await makeFixture();
    const handlers = createControlHandlers(deps);
    const result = await handlers.run_case({ name: 'login', mode: 'record', provider: 'fake-agent' });
    expect(result.isError).toBe(true);
    expect(payload(result)).toContain('REST server');
    expect(recordCase).not.toHaveBeenCalled();
  });

  it('errors when the requested provider is unknown', async () => {
    const { deps } = await makeFixture();
    const handlers = createControlHandlers(deps);
    const result = await handlers.run_case({ name: 'login', mode: 'record', provider: 'ghost' });
    expect(result.isError).toBe(true);
    expect(payload(result)).toContain('unknown provider');
  });
});

describe('get_report', () => {
  it('returns the stored result.json for a finished run', async () => {
    const { deps } = await makeFixture({ withReplay: true });
    const handlers = createControlHandlers(deps);
    const body = JSON.parse(payload(await handlers.run_case({ name: 'login', mode: 'replay' })));
    const report = await handlers.get_report({ runId: body.runId });
    expect(report.isError).toBeUndefined();
    expect(JSON.parse(payload(report)).case).toBe('login');
  });

  it('errors for an unknown run id', async () => {
    const { deps } = await makeFixture();
    const handlers = createControlHandlers(deps);
    const result = await handlers.get_report({ runId: 'run-unknown' });
    expect(result.isError).toBe(true);
  });
});

describe('export_case', () => {
  it('exports the replay through the spec exporter', async () => {
    const { deps } = await makeFixture({ withReplay: true });
    const handlers = createControlHandlers(deps);
    const result = await handlers.export_case({ name: 'login' });
    expect(result.isError).toBeUndefined();
    expect(payload(result)).toContain('@playwright/test');
  });

  it('errors when the case was never recorded', async () => {
    const { deps } = await makeFixture();
    const handlers = createControlHandlers(deps);
    const result = await handlers.export_case({ name: 'login' });
    expect(result.isError).toBe(true);
    expect(payload(result)).toContain('no replay');
  });
});
