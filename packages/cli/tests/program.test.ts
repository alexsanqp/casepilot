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
    projectsList: vi.fn(async () => {}),
    projectsAdd: vi.fn(async () => {}),
    projectsRemove: vi.fn(async () => {}),
    healsList: vi.fn(async () => {}),
    healsApprove: vi.fn(async () => {}),
    healsReject: vi.fn(async () => {}),
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
      screenshots: false,
      viewport: undefined,
      optimizeVideo: false,
      videoPadMs: undefined,
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
      screenshots: false,
      viewport: undefined,
      optimizeVideo: false,
      videoPadMs: undefined,
    });
  });

  it('parses record --screenshots and --viewport', async () => {
    const actions = stubActions();
    await parse(actions, ['record', 'login', '--screenshots', '--viewport', '1280x720']);
    expect(actions.record).toHaveBeenCalledWith(
      expect.objectContaining({ screenshots: true, viewport: { width: 1280, height: 720 } }),
    );
  });

  it('rejects a malformed --viewport', async () => {
    const actions = stubActions();
    await expect(parse(actions, ['record', 'login', '--viewport', 'huge'])).rejects.toThrow();
    expect(actions.record).not.toHaveBeenCalled();
  });

  it('rejects a zero-dimension --viewport', async () => {
    const actions = stubActions();
    await expect(parse(actions, ['run', 'login', '--viewport', '0x600'])).rejects.toThrow();
    expect(actions.run).not.toHaveBeenCalled();
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
      healPolicy: undefined,
      screenshots: false,
      viewport: undefined,
      optimizeVideo: false,
      videoPadMs: undefined,
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
      healPolicy: undefined,
      screenshots: false,
      viewport: undefined,
      optimizeVideo: false,
      videoPadMs: undefined,
    });
  });

  it('parses run --heal-policy auto and --screenshots/--viewport', async () => {
    const actions = stubActions();
    await parse(actions, ['run', 'login', '--heal-policy', 'auto', '--screenshots', '--viewport', '1920x1080']);
    expect(actions.run).toHaveBeenCalledWith(
      expect.objectContaining({
        healPolicy: 'auto',
        screenshots: true,
        viewport: { width: 1920, height: 1080 },
      }),
    );
  });

  it('parses record --optimize-video and --video-pad', async () => {
    const actions = stubActions();
    await parse(actions, ['record', 'login', '--video', '--optimize-video', '--video-pad', '250']);
    expect(actions.record).toHaveBeenCalledWith(
      expect.objectContaining({ video: true, optimizeVideo: true, videoPadMs: 250 }),
    );
  });

  it('parses run --optimize-video without --video-pad', async () => {
    const actions = stubActions();
    await parse(actions, ['run', 'login', '--video', '--optimize-video']);
    expect(actions.run).toHaveBeenCalledWith(
      expect.objectContaining({ optimizeVideo: true, videoPadMs: undefined }),
    );
  });

  it('rejects a non-positive --video-pad', async () => {
    const actions = stubActions();
    await expect(parse(actions, ['run', 'login', '--video-pad', '-50'])).rejects.toThrow();
    await expect(parse(actions, ['record', 'login', '--video-pad', '0'])).rejects.toThrow();
    expect(actions.run).not.toHaveBeenCalled();
    expect(actions.record).not.toHaveBeenCalled();
  });

  it('rejects an unknown --heal-policy value', async () => {
    const actions = stubActions();
    await expect(parse(actions, ['run', 'login', '--heal-policy', 'yolo'])).rejects.toThrow();
    expect(actions.run).not.toHaveBeenCalled();
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
    expect(actions.serve).toHaveBeenCalledWith({ workspace: undefined, port: 8080, registry: undefined });
  });

  it('defaults serve to port 7700 and registry mode without --workspace', async () => {
    const actions = stubActions();
    await parse(actions, ['serve']);
    expect(actions.serve).toHaveBeenCalledWith({ workspace: undefined, port: 7700, registry: undefined });
  });

  it('parses serve with an explicit --workspace (single-project mode)', async () => {
    const actions = stubActions();
    await parse(actions, ['--workspace', 'C:\\tmp\\ws', 'serve']);
    expect(actions.serve).toHaveBeenCalledWith({ workspace: 'C:\\tmp\\ws', port: 7700, registry: undefined });
  });

  it('parses serve with --registry', async () => {
    const actions = stubActions();
    await parse(actions, ['serve', '--registry', 'C:\\tmp\\projects.json']);
    expect(actions.serve).toHaveBeenCalledWith({
      workspace: undefined,
      port: 7700,
      registry: 'C:\\tmp\\projects.json',
    });
  });

  it('parses projects list', async () => {
    const actions = stubActions();
    await parse(actions, ['projects', 'list', '--registry', 'C:\\tmp\\projects.json']);
    expect(actions.projectsList).toHaveBeenCalledWith({ registry: 'C:\\tmp\\projects.json' });
  });

  it('parses projects add with name and registry', async () => {
    const actions = stubActions();
    await parse(actions, ['projects', 'add', 'C:\\tmp\\proj', '--name', 'My App', '--registry', 'C:\\tmp\\r.json']);
    expect(actions.projectsAdd).toHaveBeenCalledWith({
      path: 'C:\\tmp\\proj',
      name: 'My App',
      registry: 'C:\\tmp\\r.json',
    });
  });

  it('parses projects add without options', async () => {
    const actions = stubActions();
    await parse(actions, ['projects', 'add', 'C:\\tmp\\proj']);
    expect(actions.projectsAdd).toHaveBeenCalledWith({ path: 'C:\\tmp\\proj', name: undefined, registry: undefined });
  });

  it('parses projects remove', async () => {
    const actions = stubActions();
    await parse(actions, ['projects', 'remove', 'demo']);
    expect(actions.projectsRemove).toHaveBeenCalledWith({ id: 'demo', registry: undefined });
  });

  it('requires the path argument for projects add', async () => {
    const actions = stubActions();
    await expect(parse(actions, ['projects', 'add'])).rejects.toThrow();
    expect(actions.projectsAdd).not.toHaveBeenCalled();
  });

  it('parses heals list (pending only by default)', async () => {
    const actions = stubActions();
    await parse(actions, ['heals', 'list']);
    expect(actions.healsList).toHaveBeenCalledWith({ workspace: process.cwd(), all: false });
  });

  it('parses heals list --all with a workspace', async () => {
    const actions = stubActions();
    await parse(actions, ['--workspace', 'C:\\tmp\\ws', 'heals', 'list', '--all']);
    expect(actions.healsList).toHaveBeenCalledWith({ workspace: 'C:\\tmp\\ws', all: true });
  });

  it('parses heals approve and reject with an id', async () => {
    const actions = stubActions();
    await parse(actions, ['heals', 'approve', 'ab12cd34']);
    expect(actions.healsApprove).toHaveBeenCalledWith({ workspace: process.cwd(), healId: 'ab12cd34' });

    const actions2 = stubActions();
    await parse(actions2, ['heals', 'reject', 'ab12cd34']);
    expect(actions2.healsReject).toHaveBeenCalledWith({ workspace: process.cwd(), healId: 'ab12cd34' });
  });

  it('requires the id argument for heals approve', async () => {
    const actions = stubActions();
    await expect(parse(actions, ['heals', 'approve'])).rejects.toThrow();
    expect(actions.healsApprove).not.toHaveBeenCalled();
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
