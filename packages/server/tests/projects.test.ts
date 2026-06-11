import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  addProject,
  defaultRegistryPath,
  getProject,
  loadProjects,
  registerProject,
  removeProject,
  saveProjects,
  slugify,
} from '../src/projects.js';
import { scaffoldWorkspace } from '../src/scaffold.js';

async function tmpDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function setup(): Promise<{ registryPath: string; projectDir: string }> {
  const home = await tmpDir('cp-registry-');
  const projectDir = await tmpDir('cp-project-');
  return { registryPath: path.join(home, 'projects.json'), projectDir };
}

describe('slugify', () => {
  it('turns a display name into a stable slug', () => {
    expect(slugify('Superset Demo')).toBe('superset-demo');
    expect(slugify('  My  --  App!! ')).toBe('my-app');
    expect(slugify('!!!')).toBe('project');
  });
});

describe('defaultRegistryPath', () => {
  it('honors CASEPILOT_HOME', () => {
    const prev = process.env.CASEPILOT_HOME;
    process.env.CASEPILOT_HOME = 'C:\\custom\\home';
    try {
      expect(defaultRegistryPath()).toBe(path.join('C:\\custom\\home', 'projects.json'));
    } finally {
      if (prev === undefined) delete process.env.CASEPILOT_HOME;
      else process.env.CASEPILOT_HOME = prev;
    }
  });

  it('falls back to <homedir>/.casepilot/projects.json', () => {
    const prev = process.env.CASEPILOT_HOME;
    delete process.env.CASEPILOT_HOME;
    try {
      expect(defaultRegistryPath()).toBe(path.join(os.homedir(), '.casepilot', 'projects.json'));
    } finally {
      if (prev !== undefined) process.env.CASEPILOT_HOME = prev;
    }
  });
});

describe('project registry CRUD', () => {
  it('loads an empty registry when the file does not exist', async () => {
    const { registryPath } = await setup();
    expect(await loadProjects(registryPath)).toEqual({ version: 1, projects: [] });
  });

  it('adds a project with a slug id and persists it atomically', async () => {
    const { registryPath, projectDir } = await setup();
    const project = await addProject(registryPath, { name: 'Superset Demo', path: projectDir });
    expect(project).toEqual({ id: 'superset-demo', name: 'Superset Demo', path: path.resolve(projectDir) });

    const file = await loadProjects(registryPath);
    expect(file).toEqual({ version: 1, projects: [project] });

    const leftovers = (await readdir(path.dirname(registryPath))).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('keeps generated ids unique and never assigns "default"', async () => {
    const { registryPath } = await setup();
    const dirA = await tmpDir('cp-a-');
    const dirB = await tmpDir('cp-b-');
    const dirC = await tmpDir('cp-c-');
    const first = await addProject(registryPath, { name: 'Demo', path: dirA });
    const second = await addProject(registryPath, { name: 'Demo', path: dirB });
    const reserved = await addProject(registryPath, { name: 'Default', path: dirC });
    expect(first.id).toBe('demo');
    expect(second.id).toBe('demo-2');
    expect(reserved.id).toBe('default-2');
  });

  it('rejects a missing path, a file path, and a duplicate path', async () => {
    const { registryPath, projectDir } = await setup();
    await expect(addProject(registryPath, { name: 'x', path: path.join(projectDir, 'nope') })).rejects.toThrow(
      /does not exist/,
    );
    const filePath = path.join(projectDir, 'file.txt');
    await writeFile(filePath, 'x', 'utf8');
    await expect(addProject(registryPath, { name: 'x', path: filePath })).rejects.toThrow(/not a directory/);

    await addProject(registryPath, { name: 'x', path: projectDir });
    await expect(addProject(registryPath, { name: 'y', path: projectDir })).rejects.toThrow(/already registered/);
  });

  it('gets and removes projects by id', async () => {
    const { registryPath, projectDir } = await setup();
    const project = await addProject(registryPath, { name: 'demo', path: projectDir });
    expect(await getProject(registryPath, project.id)).toEqual(project);
    expect(await getProject(registryPath, 'ghost')).toBeUndefined();

    expect(await removeProject(registryPath, project.id)).toBe(true);
    expect(await removeProject(registryPath, project.id)).toBe(false);
    expect((await loadProjects(registryPath)).projects).toEqual([]);
  });

  it('rejects a malformed registry file', async () => {
    const { registryPath } = await setup();
    await mkdir(path.dirname(registryPath), { recursive: true });
    await writeFile(registryPath, JSON.stringify({ version: 2, projects: [] }), 'utf8');
    await expect(loadProjects(registryPath)).rejects.toThrow();
  });

  it('round-trips via saveProjects', async () => {
    const { registryPath, projectDir } = await setup();
    const data = { version: 1 as const, projects: [{ id: 'demo', name: 'Demo', path: projectDir }] };
    await saveProjects(registryPath, data);
    expect(JSON.parse(await readFile(registryPath, 'utf8'))).toEqual(data);
  });
});

describe('registerProject', () => {
  it('scaffolds a bare directory into a casepilot workspace', async () => {
    const { registryPath, projectDir } = await setup();
    const project = await registerProject(registryPath, { path: projectDir });
    expect(project.name).toBe(path.basename(projectDir));
    const config = await readFile(path.join(projectDir, 'casepilot.config.yaml'), 'utf8');
    expect(config).toContain('providers: []');
    expect(await readFile(path.join(projectDir, 'cases', 'example.case.yaml'), 'utf8')).toContain('name: example');
  });

  it('leaves an existing workspace untouched', async () => {
    const { registryPath, projectDir } = await setup();
    await scaffoldWorkspace(projectDir);
    await writeFile(path.join(projectDir, 'casepilot.config.yaml'), 'providers: []\n# customized\n', 'utf8');
    await registerProject(registryPath, { name: 'Existing', path: projectDir });
    expect(await readFile(path.join(projectDir, 'casepilot.config.yaml'), 'utf8')).toContain('# customized');
  });
});
