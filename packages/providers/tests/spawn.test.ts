import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/internal/spawn.js';

const onWindows = process.platform === 'win32';

describe.runIf(onWindows)('runCli .cmd shim handling (win32)', () => {
  async function makeShim(): Promise<string> {
    // Directory with a space reproduces npm shims under "C:\Program Files\...".
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cp spawn '));
    const shim = path.join(dir, 'echo-args.cmd');
    // %* echoes the received arguments back so the test can assert round-tripping.
    await writeFile(shim, '@echo off\r\necho ARGS:%*\r\n', 'utf8');
    return shim;
  }

  it('runs a .cmd whose path contains spaces and round-trips quoted args', async () => {
    const shim = await makeShim();
    const { stdout } = await runCli({
      command: shim,
      args: ['--flag', 'value with spaces', 'mcp__casepilot__*'],
      label: 'spawn test',
    });
    expect(stdout).toContain('ARGS:');
    expect(stdout).toContain('"value with spaces"');
    expect(stdout).toContain('mcp__casepilot__*');
  });

  it('rejects newline-bearing args for .cmd shims with an actionable error', async () => {
    const shim = await makeShim();
    await expect(
      runCli({ command: shim, args: ['line one\nline two'], label: 'spawn test' }),
    ).rejects.toThrow(/newlines.*stdin/s);
  });
});
