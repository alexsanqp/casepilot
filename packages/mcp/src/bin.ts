#!/usr/bin/env node
import { runBrowserTools } from './browserTools.js';
import { runControl } from './control.js';

const BOOL_FLAGS = new Set(['--video', '--headed']);
const VALUE_FLAGS = new Set(['--case', '--artifacts', '--base-url', '--workspace', '--server', '--registry', '--project']);

const USAGE = `Usage:
  casepilot-mcp browser-tools --case <path.case.yaml> --artifacts <dir> [--video] [--headed] [--base-url <url>]
  casepilot-mcp control --workspace <dir> [--server <url>]
  casepilot-mcp control --registry <projects.json> [--project <id>] [--server <url>]

browser-tools  stdio MCP bridge that lets an agent provider drive a real browser
               and record a casepilot replay. Finishes via the report_result tool.
control        stdio MCP server for external AI agents (e.g. Claude Code) to
               operate a casepilot workspace: list/get/upsert/run/export cases.
               With --registry it resolves the workspace from the project
               registry (--project picks the project) and adds a list_projects tool.
`;

function parseFlags(argv: string[]): Map<string, string | boolean> {
  const out = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (BOOL_FLAGS.has(arg)) {
      out.set(arg, true);
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      out.set(arg, value);
      i++;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return out;
}

function requireString(flags: Map<string, string | boolean>, flag: string): string {
  const value = flags.get(flag);
  if (typeof value !== 'string') {
    throw new Error(`Missing required option ${flag}`);
  }
  return value;
}

function optionalString(flags: Map<string, string | boolean>, flag: string): string | undefined {
  const value = flags.get(flag);
  return typeof value === 'string' ? value : undefined;
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  switch (command) {
    case 'browser-tools': {
      const flags = parseFlags(rest);
      await runBrowserTools({
        casePath: requireString(flags, '--case'),
        artifactsDir: requireString(flags, '--artifacts'),
        video: flags.get('--video') === true,
        headed: flags.get('--headed') === true,
        baseUrl: optionalString(flags, '--base-url'),
      });
      break;
    }
    case 'control': {
      const flags = parseFlags(rest);
      const workspace = optionalString(flags, '--workspace');
      const registryPath = optionalString(flags, '--registry');
      if (!workspace && !registryPath) {
        throw new Error('control requires --workspace or --registry');
      }
      await runControl({
        workspace,
        serverUrl: optionalString(flags, '--server'),
        registryPath,
        projectId: optionalString(flags, '--project'),
      });
      break;
    }
    default:
      process.stderr.write(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`casepilot-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
