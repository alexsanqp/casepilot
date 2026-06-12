import { Command } from 'commander';
import { parseHealPolicy, parseVideoPad, parseViewport, type Viewport } from './options.js';

export interface CliActions {
  init(opts: { workspace: string }): Promise<void>;
  record(opts: {
    workspace: string;
    caseName: string;
    provider?: string;
    video: boolean;
    headed: boolean;
    screenshots: boolean;
    viewport?: Viewport;
    optimizeVideo: boolean;
    videoPadMs?: number;
  }): Promise<void>;
  run(opts: {
    workspace: string;
    caseName: string;
    video: boolean;
    headed: boolean;
    heal: boolean;
    healPolicy?: 'review' | 'auto';
    screenshots: boolean;
    viewport?: Viewport;
    optimizeVideo: boolean;
    videoPadMs?: number;
  }): Promise<void>;
  export(opts: { workspace: string; caseName: string; out?: string }): Promise<void>;
  runs(opts: { workspace: string; server?: string }): Promise<void>;
  report(opts: { workspace: string; runId: string; server?: string }): Promise<void>;
  transcript(opts: { workspace: string; runId: string }): Promise<void>;
  serve(opts: { workspace?: string; port: number; registry?: string }): Promise<void>;
  mcp(opts: { workspace: string }): Promise<void>;
  projectsList(opts: { registry?: string }): Promise<void>;
  projectsAdd(opts: { path: string; name?: string; registry?: string }): Promise<void>;
  projectsRemove(opts: { id: string; registry?: string }): Promise<void>;
  healsList(opts: { workspace: string; all: boolean }): Promise<void>;
  healsApprove(opts: { workspace: string; healId: string }): Promise<void>;
  healsReject(opts: { workspace: string; healId: string }): Promise<void>;
}

export function createProgram(actions: CliActions): Command {
  const program = new Command('casepilot');
  program
    .description('Provider-agnostic AI UI test runner with record-and-replay')
    .option('--workspace <dir>', 'casepilot workspace directory', process.cwd());

  const workspace = (): string => program.opts<{ workspace: string }>().workspace;
  const explicitWorkspace = (): string | undefined =>
    program.getOptionValueSource('workspace') === 'default' ? undefined : workspace();

  program
    .command('init')
    .description('Scaffold a casepilot workspace (config, cases dir, example case)')
    .action(async () => {
      await actions.init({ workspace: workspace() });
    });

  program
    .command('record')
    .description('Record a case with an AI provider into a deterministic replay')
    .argument('<case>', 'case name (cases/<name>.case.yaml)')
    .option('--provider <id>', 'provider id from casepilot.config.yaml')
    .option('--video', 'record a video of the run')
    .option('--headed', 'run with a visible browser')
    .option('--screenshots', 'capture a screenshot after every step')
    .option('--viewport <WxH>', 'browser viewport, e.g. 1920x1080', parseViewport)
    .option('--optimize-video', 'also write an idle-trimmed copy of the run video')
    .option('--video-pad <ms>', 'padding kept around each step when trimming idle video time', parseVideoPad)
    .action(
      async (
        caseName: string,
        opts: {
          provider?: string;
          video?: boolean;
          headed?: boolean;
          screenshots?: boolean;
          viewport?: Viewport;
          optimizeVideo?: boolean;
          videoPad?: number;
        },
      ) => {
        await actions.record({
          workspace: workspace(),
          caseName,
          provider: opts.provider,
          video: !!opts.video,
          headed: !!opts.headed,
          screenshots: !!opts.screenshots,
          viewport: opts.viewport,
          optimizeVideo: !!opts.optimizeVideo,
          videoPadMs: opts.videoPad,
        });
      },
    );

  program
    .command('run')
    .description('Replay a recorded case; exit code reflects the verdict')
    .argument('<case>', 'case name (cases/<name>.replay.json)')
    .option('--video', 'record a video of the run')
    .option('--headed', 'run with a visible browser')
    .option('--no-heal', 'disable AI healing of failed steps')
    .option('--heal-policy <policy>', 'review (queue heals for approval) or auto (apply immediately)', parseHealPolicy)
    .option('--screenshots', 'capture a screenshot after every step')
    .option('--viewport <WxH>', 'browser viewport, e.g. 1920x1080', parseViewport)
    .option('--optimize-video', 'also write an idle-trimmed copy of the run video')
    .option('--video-pad <ms>', 'padding kept around each step when trimming idle video time', parseVideoPad)
    .action(
      async (
        caseName: string,
        opts: {
          video?: boolean;
          headed?: boolean;
          heal: boolean;
          healPolicy?: 'review' | 'auto';
          screenshots?: boolean;
          viewport?: Viewport;
          optimizeVideo?: boolean;
          videoPad?: number;
        },
      ) => {
        await actions.run({
          workspace: workspace(),
          caseName,
          video: !!opts.video,
          headed: !!opts.headed,
          heal: opts.heal,
          healPolicy: opts.healPolicy,
          screenshots: !!opts.screenshots,
          viewport: opts.viewport,
          optimizeVideo: !!opts.optimizeVideo,
          videoPadMs: opts.videoPad,
        });
      },
    );

  program
    .command('export')
    .description('Export a recorded case as a Playwright spec file')
    .argument('<case>', 'case name')
    .option('-o, --out <file>', 'output file (default cases/<name>.spec.ts)')
    .action(async (caseName: string, opts: { out?: string }) => {
      await actions.export({ workspace: workspace(), caseName, out: opts.out });
    });

  program
    .command('runs')
    .description('List runs from the runs/ directory (or a running server)')
    .option('--server <url>', 'read runs from a casepilot REST server instead of the filesystem')
    .action(async (opts: { server?: string }) => {
      await actions.runs({ workspace: workspace(), server: opts.server });
    });

  program
    .command('report')
    .description('Show the full report of a run')
    .argument('<runId>', 'run id')
    .option('--server <url>', 'read the report from a casepilot REST server instead of the filesystem')
    .action(async (runId: string, opts: { server?: string }) => {
      await actions.report({ workspace: workspace(), runId, server: opts.server });
    });

  program
    .command('transcript')
    .description('Render a run provider transcript (event JSONL) as readable text')
    .argument('<runId>', 'run id')
    .action(async (runId: string) => {
      await actions.transcript({ workspace: workspace(), runId });
    });

  program
    .command('serve')
    .description('Start the casepilot REST server (all registered projects, or one workspace with --workspace)')
    .option('--port <port>', 'port to listen on', (v) => Number.parseInt(v, 10), 7700)
    .option('--registry <file>', 'project registry file (default ~/.casepilot/projects.json)')
    .action(async (opts: { port: number; registry?: string }) => {
      await actions.serve({ workspace: explicitWorkspace(), port: opts.port, registry: opts.registry });
    });

  const projects = program
    .command('projects')
    .description('Manage the multi-project registry used by "casepilot serve" and the dashboard');

  projects
    .command('list')
    .description('List registered projects')
    .option('--registry <file>', 'project registry file (default ~/.casepilot/projects.json)')
    .action(async (opts: { registry?: string }) => {
      await actions.projectsList({ registry: opts.registry });
    });

  projects
    .command('add')
    .description('Register a project directory (scaffolds a casepilot workspace if needed)')
    .argument('<path>', 'project directory')
    .option('--name <name>', 'project display name (default: directory name)')
    .option('--registry <file>', 'project registry file (default ~/.casepilot/projects.json)')
    .action(async (projectPath: string, opts: { name?: string; registry?: string }) => {
      await actions.projectsAdd({ path: projectPath, name: opts.name, registry: opts.registry });
    });

  projects
    .command('remove')
    .description('Remove a project from the registry (never deletes files)')
    .argument('<id>', 'project id')
    .option('--registry <file>', 'project registry file (default ~/.casepilot/projects.json)')
    .action(async (id: string, opts: { registry?: string }) => {
      await actions.projectsRemove({ id, registry: opts.registry });
    });

  const heals = program.command('heals').description('Review healed steps queued by replay runs (heals.json)');

  heals
    .command('list')
    .description('List queued heals (pending by default)')
    .option('--all', 'include approved and rejected heals')
    .action(async (opts: { all?: boolean }) => {
      await actions.healsList({ workspace: workspace(), all: !!opts.all });
    });

  heals
    .command('approve')
    .description('Apply a pending heal into the case replay file')
    .argument('<id>', 'heal id')
    .action(async (healId: string) => {
      await actions.healsApprove({ workspace: workspace(), healId });
    });

  heals
    .command('reject')
    .description('Reject a pending heal without touching the replay')
    .argument('<id>', 'heal id')
    .action(async (healId: string) => {
      await actions.healsReject({ workspace: workspace(), healId });
    });

  program
    .command('mcp')
    .description('Print instructions for registering the casepilot control MCP server')
    .action(async () => {
      await actions.mcp({ workspace: workspace() });
    });

  return program;
}
