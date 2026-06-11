import { describe, expect, it, vi } from 'vitest';
import { createProgram, type CliActions } from '../src/program.js';

function stubActions(): CliActions {
  return {
    init: vi.fn(async () => {}),
    record: vi.fn(async () => {}),
    run: vi.fn(async () => {}),
    export: vi.fn(async () => {}),
    runs: vi.fn(async () => {}),
    report: vi.fn(async () => {}),
    serve: vi.fn(async () => {}),
    mcp: vi.fn(async () => {}),
  };
}

async function parse(actions: CliActions, argv: string[]): Promise<void> {
  const program = createProgram(actions);
  program.exitOverride();
  await program.parseAsync(argv, { from: 'user' });
}

describe('casepilot CLI parsing', () => {
  it('init uses the cwd as the default workspace', async () => {
    const actions = stubActions();
    await parse(actions, ['init']);
    expect(actions.init).toHaveBeenCalledWith({ workspace: process.cwd() });
  });

  it('honors the global --workspace option', async () => {
    const actions = stubActions();
    await parse(actions, ['--workspace', 'C:\\tmp\\ws', 'init']);
    expect(actions.init).toHaveBeenCalledWith({ workspace: 'C:\\tmp\\ws' });
  });

  it('parses record with provider and flags', async () => {
    const actions = stubActions();
    await parse(actions, ['record', 'login', '--provider', 'lmstudio', '--video', '--headed']);
    expect(actions.record).toHaveBeenCalledWith({
      workspace: process.cwd(),
      caseName: 'login',
      provider: 'lmstudio',
      video: true,
      headed: true,
    });
  });

  it('parses record without optional flags', async () => {
    const actions = stubActions();
    await parse(actions, ['record', 'login']);
    expect(actions.record).toHaveBeenCalledWith({
      workspace: process.cwd(),
      caseName: 'login',
      provider: undefined,
      video: false,
      headed: false,
    });
  });

  it('parses run with heal enabled by default', async () => {
    const actions = stubActions();
    await parse(actions, ['run', 'login']);
    expect(actions.run).toHaveBeenCalledWith({
      workspace: process.cwd(),
      caseName: 'login',
      video: false,
      headed: false,
      heal: true,
    });
  });

  it('parses run --no-heal', async () => {
    const actions = stubActions();
    await parse(actions, ['run', 'login', '--no-heal', '--video']);
    expect(actions.run).toHaveBeenCalledWith({
      workspace: process.cwd(),
      caseName: 'login',
      video: true,
      headed: false,
      heal: false,
    });
  });

  it('parses export with -o', async () => {
    const actions = stubActions();
    await parse(actions, ['export', 'login', '-o', 'out/login.spec.ts']);
    expect(actions.export).toHaveBeenCalledWith({
      workspace: process.cwd(),
      caseName: 'login',
      out: 'out/login.spec.ts',
    });
  });

  it('parses runs with --server', async () => {
    const actions = stubActions();
    await parse(actions, ['runs', '--server', 'http://127.0.0.1:7700']);
    expect(actions.runs).toHaveBeenCalledWith({
      workspace: process.cwd(),
      server: 'http://127.0.0.1:7700',
    });
  });

  it('parses report with a run id', async () => {
    const actions = stubActions();
    await parse(actions, ['report', '20260611-101500-abc123']);
    expect(actions.report).toHaveBeenCalledWith({
      workspace: process.cwd(),
      runId: '20260611-101500-abc123',
      server: undefined,
    });
  });

  it('parses serve with a numeric port', async () => {
    const actions = stubActions();
    await parse(actions, ['serve', '--port', '8080']);
    expect(actions.serve).toHaveBeenCalledWith({ workspace: process.cwd(), port: 8080 });
  });

  it('defaults serve to port 7700', async () => {
    const actions = stubActions();
    await parse(actions, ['serve']);
    expect(actions.serve).toHaveBeenCalledWith({ workspace: process.cwd(), port: 7700 });
  });

  it('parses mcp', async () => {
    const actions = stubActions();
    await parse(actions, ['mcp']);
    expect(actions.mcp).toHaveBeenCalledWith({ workspace: process.cwd() });
  });

  it('rejects unknown commands', async () => {
    const actions = stubActions();
    await expect(parse(actions, ['frobnicate'])).rejects.toThrow();
  });

  it('requires the case argument for record', async () => {
    const actions = stubActions();
    await expect(parse(actions, ['record'])).rejects.toThrow();
    expect(actions.record).not.toHaveBeenCalled();
  });
});
