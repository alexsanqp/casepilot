import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import YAML from 'yaml';
import {
  exportToPlaywrightSpec,
  loadCaseFile,
  loadReplayFile,
  parseCaseSpec,
  recordCase,
  replayCase,
} from '@casepilot/core';
import type {
  CaseSpec,
  ChatProvider,
  HealerFn,
  ReplayFile,
  RunOptions,
  RunResult,
} from '@casepilot/core';
import { loadWorkspaceRegistry, type ProviderRegistryLike } from './providersLoader.js';

export interface ControlEngine {
  recordCase(
    spec: CaseSpec,
    provider: ChatProvider,
    options: RunOptions,
  ): Promise<{ result: RunResult; replay: ReplayFile }>;
  replayCase(replay: ReplayFile, options: RunOptions, healer?: HealerFn): Promise<RunResult>;
}

export interface RemoteClient {
  runCase(body: { case: string; provider?: string; mode: 'record' | 'replay'; video?: boolean }): Promise<string>;
  getReport(runId: string): Promise<string>;
}

export interface ControlDeps {
  workspace: string;
  engine: ControlEngine;
  loadRegistry(workspace: string): Promise<ProviderRegistryLike>;
  exportSpec(replay: ReplayFile): string;
  newRunId(): string;
  remote?: RemoteClient;
}

export interface ToolText extends CallToolResult {
  content: { type: 'text'; text: string }[];
}

const text = (t: string): ToolText => ({ content: [{ type: 'text', text: t }] });
const errText = (t: string): ToolText => ({ content: [{ type: 'text', text: t }], isError: true });

const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function checkName(name: string, what: string): string | undefined {
  return SAFE_NAME_RE.test(name)
    ? undefined
    : `error: invalid ${what} "${name}"; use letters, digits, dot, dash, underscore`;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export function defaultNewRunId(): string {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `${ts}-${randomBytes(3).toString('hex')}`;
}

function createRemoteClient(serverUrl: string): RemoteClient {
  const base = serverUrl.replace(/\/+$/, '');
  return {
    async runCase(body) {
      const res = await fetch(`${base}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await res.text();
      if (!res.ok) throw new Error(`server responded ${res.status}: ${payload}`);
      return payload;
    },
    async getReport(runId) {
      const res = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}`);
      const payload = await res.text();
      if (!res.ok) throw new Error(`server responded ${res.status}: ${payload}`);
      return payload;
    },
  };
}

export function createControlDeps(workspace: string, serverUrl?: string): ControlDeps {
  return {
    workspace: path.resolve(workspace),
    engine: { recordCase, replayCase },
    loadRegistry: loadWorkspaceRegistry,
    exportSpec: exportToPlaywrightSpec,
    newRunId: defaultNewRunId,
    remote: serverUrl ? createRemoteClient(serverUrl) : undefined,
  };
}

export interface RunCaseArgs {
  name: string;
  provider?: string;
  mode: 'record' | 'replay';
  video?: boolean;
}

export interface ControlHandlers {
  list_cases(): Promise<ToolText>;
  get_case(args: { name: string }): Promise<ToolText>;
  upsert_case(args: { name: string; yaml: string }): Promise<ToolText>;
  run_case(args: RunCaseArgs): Promise<ToolText>;
  get_report(args: { runId: string }): Promise<ToolText>;
  export_case(args: { name: string }): Promise<ToolText>;
}

export function createControlHandlers(deps: ControlDeps): ControlHandlers {
  const casesDir = path.join(deps.workspace, 'cases');
  const runsDir = path.join(deps.workspace, 'runs');
  const caseFile = (name: string): string => path.join(casesDir, `${name}.case.yaml`);
  const replayFile = (name: string): string => path.join(casesDir, `${name}.replay.json`);

  async function runInProcess(args: RunCaseArgs): Promise<ToolText> {
    const runId = deps.newRunId();
    const runDir = path.join(runsDir, runId);
    await mkdir(runDir, { recursive: true });
    const options: RunOptions = { headless: true, video: !!args.video, artifactsDir: runDir };
    let result: RunResult;
    if (args.mode === 'replay') {
      if (!(await fileExists(replayFile(args.name)))) {
        return errText(`error: no replay found for case "${args.name}"; record it first`);
      }
      const replay = await loadReplayFile(replayFile(args.name));
      result = await deps.engine.replayCase(replay, options);
    } else {
      if (!(await fileExists(caseFile(args.name)))) {
        return errText(`error: case "${args.name}" not found`);
      }
      const spec = await loadCaseFile(caseFile(args.name));
      const registry = await deps.loadRegistry(deps.workspace);
      const provider = args.provider ? registry.get(args.provider) : registry.default();
      if (provider.kind === 'agent') {
        return errText(
          `error: provider "${provider.id}" is an agent provider; record-via-agent must go through the casepilot REST server (POST /api/runs), which spawns the browser-tools MCP bridge for the agent. Use a chat provider here, or start the server with "casepilot serve".`,
        );
      }
      const recorded = await deps.engine.recordCase(spec, provider, options);
      result = recorded.result;
      if (result.verdict === 'passed') {
        await writeFile(replayFile(args.name), JSON.stringify(recorded.replay, null, 2), 'utf8');
      }
    }
    await writeFile(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    return text(
      JSON.stringify({ runId, verdict: result.verdict, explanation: result.explanation, runDir }, null, 2),
    );
  }

  return {
    async list_cases() {
      try {
        let entries: string[] = [];
        try {
          entries = await readdir(casesDir);
        } catch {
          entries = [];
        }
        const cases = [];
        for (const entry of entries.filter((e) => e.endsWith('.case.yaml')).sort()) {
          const name = entry.slice(0, -'.case.yaml'.length);
          const file = path.join(casesDir, entry);
          let url = '(unparsable case file)';
          try {
            url = (await loadCaseFile(file)).url;
          } catch {
            // keep placeholder url
          }
          cases.push({ name, url, hasReplay: await fileExists(replayFile(name)), file });
        }
        return text(JSON.stringify(cases, null, 2));
      } catch (err) {
        return errText(`error: ${errorMessage(err)}`);
      }
    },

    async get_case({ name }) {
      const bad = checkName(name, 'case name');
      if (bad) return errText(bad);
      try {
        if (!(await fileExists(caseFile(name)))) return errText(`error: case "${name}" not found`);
        const specYaml = await readFile(caseFile(name), 'utf8');
        const spec = parseCaseSpec(YAML.parse(specYaml), `case file ${caseFile(name)}`);
        const payload: { spec: CaseSpec; specYaml: string; replay?: ReplayFile } = { spec, specYaml };
        if (await fileExists(replayFile(name))) {
          payload.replay = await loadReplayFile(replayFile(name));
        }
        return text(JSON.stringify(payload, null, 2));
      } catch (err) {
        return errText(`error: ${errorMessage(err)}`);
      }
    },

    async upsert_case({ name, yaml }) {
      const bad = checkName(name, 'case name');
      if (bad) return errText(bad);
      try {
        let doc: unknown;
        try {
          doc = YAML.parse(yaml);
        } catch (err) {
          return errText(`error: invalid YAML: ${errorMessage(err)}`);
        }
        parseCaseSpec(doc, `case "${name}"`);
        await mkdir(casesDir, { recursive: true });
        await writeFile(caseFile(name), yaml, 'utf8');
        return text(`ok: saved ${caseFile(name)}`);
      } catch (err) {
        return errText(`error: ${errorMessage(err)}`);
      }
    },

    async run_case(args) {
      const bad = checkName(args.name, 'case name');
      if (bad) return errText(bad);
      try {
        if (deps.remote) {
          const payload = await deps.remote.runCase({
            case: args.name,
            provider: args.provider,
            mode: args.mode,
            video: args.video,
          });
          return text(`accepted by server: ${payload}. Poll get_report with the runId.`);
        }
        return await runInProcess(args);
      } catch (err) {
        return errText(`error: ${errorMessage(err)}`);
      }
    },

    async get_report({ runId }) {
      const bad = checkName(runId, 'run id');
      if (bad) return errText(bad);
      try {
        if (deps.remote) {
          return text(await deps.remote.getReport(runId));
        }
        const resultPath = path.join(runsDir, runId, 'result.json');
        if (!(await fileExists(resultPath))) return errText(`error: no report found for run "${runId}"`);
        return text(await readFile(resultPath, 'utf8'));
      } catch (err) {
        return errText(`error: ${errorMessage(err)}`);
      }
    },

    async export_case({ name }) {
      const bad = checkName(name, 'case name');
      if (bad) return errText(bad);
      try {
        if (!(await fileExists(replayFile(name)))) {
          return errText(`error: no replay found for case "${name}"; record it before exporting`);
        }
        const replay = await loadReplayFile(replayFile(name));
        return text(deps.exportSpec(replay));
      } catch (err) {
        return errText(`error: ${errorMessage(err)}`);
      }
    },
  };
}

export function createControlServer(deps: ControlDeps): McpServer {
  const handlers = createControlHandlers(deps);
  const server = new McpServer({ name: 'casepilot-control', version: '0.1.0' });

  server.registerTool(
    'list_cases',
    { description: 'List all test cases in the casepilot workspace.', inputSchema: {} },
    async () => handlers.list_cases(),
  );

  server.registerTool(
    'get_case',
    {
      description: 'Get a case spec (parsed and raw YAML) plus its recorded replay if present.',
      inputSchema: { name: z.string().describe('Case name (file cases/<name>.case.yaml).') },
    },
    async (args) => handlers.get_case(args),
  );

  server.registerTool(
    'upsert_case',
    {
      description:
        'Create or update a case. The YAML must contain: name, url, steps (string list), expect (string list).',
      inputSchema: {
        name: z.string().describe('Case name; the file is saved as cases/<name>.case.yaml.'),
        yaml: z.string().describe('Full case spec as YAML.'),
      },
    },
    async (args) => handlers.upsert_case(args),
  );

  server.registerTool(
    'run_case',
    {
      description:
        'Run a case. mode "replay" replays the recorded steps deterministically; mode "record" records with a chat provider. Record via agent providers requires the casepilot REST server.',
      inputSchema: {
        name: z.string().describe('Case name.'),
        provider: z.string().optional().describe('Provider id from casepilot.config.yaml (default provider if omitted).'),
        mode: z.enum(['record', 'replay']),
        video: z.boolean().optional().describe('Record a video of the run.'),
      },
    },
    async (args) => handlers.run_case(args),
  );

  server.registerTool(
    'get_report',
    {
      description: 'Get the result.json report for a finished run.',
      inputSchema: { runId: z.string().describe('Run id returned by run_case.') },
    },
    async (args) => handlers.get_report(args),
  );

  server.registerTool(
    'export_case',
    {
      description: 'Export the recorded replay of a case as a Playwright spec.ts file (returned as text).',
      inputSchema: { name: z.string().describe('Case name.') },
    },
    async (args) => handlers.export_case(args),
  );

  return server;
}

export async function runControl(options: { workspace: string; serverUrl?: string }): Promise<void> {
  const server = createControlServer(createControlDeps(options.workspace, options.serverUrl));
  server.server.onclose = () => {
    process.exit(0);
  };
  await server.connect(new StdioServerTransport());
}
