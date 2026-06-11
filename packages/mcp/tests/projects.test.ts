import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createControlServer,
  readProjectsFile,
  resolveControlWorkspace,
  type ControlDeps,
} from '../src/control.js';

async function writeRegistry(projects: Array<{ id: string; name: string; path: string }>): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cp-mcp-reg-'));
  const registryPath = path.join(home, 'projects.json');
  await writeFile(registryPath, JSON.stringify({ version: 1, projects }, null, 2), 'utf8');
  return registryPath;
}

function fakeDeps(workspace: string): ControlDeps {
  return {
    workspace,
    engine: { recordCase: vi.fn(), replayCase: vi.fn() } as unknown as ControlDeps['engine'],
    loadRegistry: vi.fn(),
    exportSpec: vi.fn(),
    newRunId: () => 'run-1',
  };
}

describe('readProjectsFile', () => {
  it('returns an empty registry for a missing file', async () => {
    const missing = path.join(os.tmpdir(), 'cp-mcp-missing', 'projects.json');
    expect(await readProjectsFile(missing)).toEqual({ version: 1, projects: [] });
  });

  it('parses a valid registry and rejects a malformed one', async () => {
    const registryPath = await writeRegistry([{ id: 'demo', name: 'Demo', path: 'C:\\ws\\demo' }]);
    expect((await readProjectsFile(registryPath)).projects).toHaveLength(1);

    const home = await mkdtemp(path.join(os.tmpdir(), 'cp-mcp-bad-'));
    const badPath = path.join(home, 'projects.json');
    await mkdir(home, { recursive: true });
    await writeFile(badPath, JSON.stringify({ version: 99 }), 'utf8');
    await expect(readProjectsFile(badPath)).rejects.toThrow();
  });
});

describe('resolveControlWorkspace', () => {
  it('prefers an explicit workspace', async () => {
    expect(await resolveControlWorkspace({ workspace: 'C:\\ws' })).toBe('C:\\ws');
  });

  it('requires either workspace or registry', async () => {
    await expect(resolveControlWorkspace({})).rejects.toThrow(/--workspace or --registry/);
  });

  it('resolves the workspace from --project', async () => {
    const registryPath = await writeRegistry([
      { id: 'a', name: 'A', path: 'C:\\ws\\a' },
      { id: 'b', name: 'B', path: 'C:\\ws\\b' },
    ]);
    expect(await resolveControlWorkspace({ registryPath, projectId: 'b' })).toBe('C:\\ws\\b');
  });

  it('falls back to the "default" project, then the first project', async () => {
    const withDefault = await writeRegistry([
      { id: 'a', name: 'A', path: 'C:\\ws\\a' },
      { id: 'default', name: 'Default', path: 'C:\\ws\\default' },
    ]);
    expect(await resolveControlWorkspace({ registryPath: withDefault })).toBe('C:\\ws\\default');

    const withoutDefault = await writeRegistry([{ id: 'a', name: 'A', path: 'C:\\ws\\a' }]);
    expect(await resolveControlWorkspace({ registryPath: withoutDefault })).toBe('C:\\ws\\a');
  });

  it('fails for an unknown project id and for an empty registry', async () => {
    const registryPath = await writeRegistry([{ id: 'a', name: 'A', path: 'C:\\ws\\a' }]);
    await expect(resolveControlWorkspace({ registryPath, projectId: 'ghost' })).rejects.toThrow(/"ghost" not found/);

    const empty = await writeRegistry([]);
    await expect(resolveControlWorkspace({ registryPath: empty })).rejects.toThrow(/no projects registered/);
  });
});

describe('list_projects tool', () => {
  async function connect(registryPath?: string) {
    const server = createControlServer(fakeDeps('C:\\ws'), { registryPath });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it('is registered and lists projects when started with a registry', async () => {
    const registryPath = await writeRegistry([{ id: 'demo', name: 'Demo', path: 'C:\\ws\\demo' }]);
    const client = await connect(registryPath);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('list_projects');

    const result = await client.callTool({ name: 'list_projects', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text)).toEqual([{ id: 'demo', name: 'Demo', path: 'C:\\ws\\demo' }]);
  });

  it('is absent in plain --workspace mode', async () => {
    const client = await connect(undefined);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).not.toContain('list_projects');
  });
});
