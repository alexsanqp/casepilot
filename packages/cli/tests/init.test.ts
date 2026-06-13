import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { initWorkspace } from '../src/init.js';

describe('initWorkspace', () => {
  it('scaffolds config, cases dir and an example case', async () => {
    const ws = await mkdtemp(path.join(os.tmpdir(), 'cp-init-'));
    const outcome = await initWorkspace(ws);

    expect(outcome.created).toEqual([
      path.join(ws, 'casepilot.config.yaml'),
      path.join(ws, '.gitignore'),
      path.join(ws, 'cases', 'example.case.yaml'),
    ]);
    expect(outcome.skipped).toEqual([]);

    expect((await stat(path.join(ws, 'cases'))).isDirectory()).toBe(true);

    const gitignore = await readFile(path.join(ws, '.gitignore'), 'utf8');
    expect(gitignore).toContain('auth/');
    expect(gitignore).toContain('runs/');
    expect(gitignore).toContain('suites/');

    const config = await readFile(path.join(ws, 'casepilot.config.yaml'), 'utf8');
    expect(config).toContain('lmstudio');
    expect(config).toContain('claude-code');
    expect(config).toContain('providers: []');

    const example = await readFile(path.join(ws, 'cases', 'example.case.yaml'), 'utf8');
    expect(example).toContain('name: example');
    expect(example).toContain('steps:');
    expect(example).toContain('expect:');
  });

  it('does not overwrite existing files on a second run', async () => {
    const ws = await mkdtemp(path.join(os.tmpdir(), 'cp-init-'));
    await initWorkspace(ws);
    const before = await readFile(path.join(ws, 'casepilot.config.yaml'), 'utf8');

    const second = await initWorkspace(ws);
    expect(second.created).toEqual([]);
    expect(second.skipped).toHaveLength(3);

    const after = await readFile(path.join(ws, 'casepilot.config.yaml'), 'utf8');
    expect(after).toBe(before);
  });
});
