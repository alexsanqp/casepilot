import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { ChatProvider, RunResult } from '@casepilot/core';
import { executeRun, type RunnerDeps } from '../src/runner.js';
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
