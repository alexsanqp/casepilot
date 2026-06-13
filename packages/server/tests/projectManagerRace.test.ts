import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { RunnerDeps } from '../src/runner.js';
import { ProjectManager } from '../src/projectManager.js';
import { saveProjects } from '../src/projects.js';

const CASE_YAML = `name: login
url: https://example.test/login
steps:
  - Click the Login button
expect:
  - The dashboard heading is visible
`;

function deps(): RunnerDeps {
  return {
    engine: { recordCase: vi.fn(), replayCase: vi.fn() } as unknown as RunnerDeps['engine'],
    loadRegistry: vi.fn(),
    resolveMcpBin: () => 'C:/fake/mcp/bin.js',
  };
}

async function setupProject(): Promise<{ manager: ProjectManager; id: string }> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cp-pm-home-'));
  const registryPath = path.join(home, 'projects.json');
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'cp-pm-proj-'));
  await mkdir(path.join(projectDir, 'cases'), { recursive: true });
  await writeFile(path.join(projectDir, 'cases', 'login.case.yaml'), CASE_YAML, 'utf8');
  await saveProjects(registryPath, {
    version: 1,
    projects: [{ id: 'alpha', name: 'Alpha', path: projectDir }],
  });
  const manager = new ProjectManager({ registryPath, deps: deps() });
  return { manager, id: 'alpha' };
}

describe('ProjectManager.getContext concurrency (Bug M1)', () => {
  it('returns the SAME context instance for two cold concurrent calls', async () => {
    const { manager, id } = await setupProject();
    const [a, b] = await Promise.all([manager.getContext(id), manager.getContext(id)]);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // A single RunRegistry/RunService must have been built and cached, not two.
    expect(a).toBe(b);
    expect(a!.registry).toBe(b!.registry);
    expect(a!.service).toBe(b!.service);
  });

  it('serves a cached context on a subsequent call', async () => {
    const { manager, id } = await setupProject();
    const first = await manager.getContext(id);
    const second = await manager.getContext(id);
    expect(first).toBe(second);
  });

  it('returns undefined for an unknown project id', async () => {
    const { manager } = await setupProject();
    expect(await manager.getContext('ghost')).toBeUndefined();
  });
});
