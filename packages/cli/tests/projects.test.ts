import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { loadProjects } from '@casepilot/server/projects';
import { createActions, type CliIo } from '../src/actions.js';

function captureIo(): CliIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
  };
}

async function setup(): Promise<{ registryPath: string; projectDir: string }> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cp-cli-reg-'));
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'cp-cli-proj-'));
  return { registryPath: path.join(home, 'projects.json'), projectDir };
}

describe('casepilot projects actions', () => {
  it('add registers a project, scaffolds the workspace and list shows it', async () => {
    const { registryPath, projectDir } = await setup();
    const io = captureIo();
    const actions = createActions(io);

    await actions.projectsAdd({ path: projectDir, name: 'Demo App', registry: registryPath });
    expect(io.lines.join('\n')).toContain('id: demo-app');

    const { projects } = await loadProjects(registryPath);
    expect(projects).toEqual([{ id: 'demo-app', name: 'Demo App', path: projectDir }]);
    expect(await readFile(path.join(projectDir, 'casepilot.config.yaml'), 'utf8')).toContain('providers: []');

    io.lines.length = 0;
    await actions.projectsList({ registry: registryPath });
    expect(io.lines).toEqual([`demo-app  Demo App  ${projectDir}`]);
  });

  it('add defaults the name to the directory basename', async () => {
    const { registryPath, projectDir } = await setup();
    const actions = createActions(captureIo());
    await actions.projectsAdd({ path: projectDir, registry: registryPath });
    const { projects } = await loadProjects(registryPath);
    expect(projects[0]?.name).toBe(path.basename(projectDir));
  });

  it('add fails for a missing directory', async () => {
    const { registryPath, projectDir } = await setup();
    const actions = createActions(captureIo());
    await expect(
      actions.projectsAdd({ path: path.join(projectDir, 'ghost'), registry: registryPath }),
    ).rejects.toThrow(/does not exist/);
  });

  it('remove deletes the registry entry but keeps workspace files', async () => {
    const { registryPath, projectDir } = await setup();
    const io = captureIo();
    const actions = createActions(io);
    await actions.projectsAdd({ path: projectDir, name: 'Demo', registry: registryPath });

    await actions.projectsRemove({ id: 'demo', registry: registryPath });
    expect((await loadProjects(registryPath)).projects).toEqual([]);
    expect(await readFile(path.join(projectDir, 'casepilot.config.yaml'), 'utf8')).toContain('providers: []');
  });

  it('remove reports a missing id and sets a non-zero exit code', async () => {
    const { registryPath } = await setup();
    const io = captureIo();
    const actions = createActions(io);
    const prevExitCode = process.exitCode;
    try {
      await actions.projectsRemove({ id: 'ghost', registry: registryPath });
      expect(process.exitCode).toBe(1);
      expect(io.errors[0]).toContain('ghost');
    } finally {
      process.exitCode = prevExitCode;
    }
  });

  it('list explains how to register when the registry is empty', async () => {
    const { registryPath } = await setup();
    const io = captureIo();
    const actions = createActions(io);
    await actions.projectsList({ registry: registryPath });
    expect(io.lines[0]).toContain('No projects registered');
  });
});
