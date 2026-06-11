import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { exportToPlaywrightSpec, loadReplayFile } from '@casepilot/core';
import type { RunResult } from '@casepilot/core';
import {
  caseReplayPath,
  executeRun,
  newRunId,
  readRunsFromDir,
  resolveMcpBinPath,
  runDirPath,
  runsDir,
  type RunSummary,
} from '@casepilot/server/runner';
import { initWorkspace } from './init.js';
import { formatRunResult, formatRunSummaries } from './format.js';
import type { CliActions } from './program.js';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const consoleIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

function apiUrl(server: string, route: string): string {
  return `${server.replace(/\/+$/, '')}${route}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed with ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export function createActions(io: CliIo = consoleIo): CliActions {
  return {
    async init({ workspace }) {
      const ws = path.resolve(workspace);
      const outcome = await initWorkspace(ws);
      for (const file of outcome.created) io.out(`created  ${file}`);
      for (const file of outcome.skipped) io.out(`skipped  ${file} (already exists)`);
      io.out('');
      io.out('Next steps:');
      io.out('  1. Edit casepilot.config.yaml and configure a provider.');
      io.out('  2. casepilot record example');
      io.out('  3. casepilot run example');
    },

    async record({ workspace, caseName, provider, video, headed }) {
      const ws = path.resolve(workspace);
      const runId = newRunId();
      const runDir = runDirPath(ws, runId);
      io.out(`Recording case "${caseName}" (run ${runId})...`);
      const result = await executeRun({
        workspace: ws,
        caseName,
        mode: 'record',
        providerId: provider,
        video,
        headed,
        runDir,
      });
      io.out(formatRunResult(result));
      io.out(`Run dir:    ${runDir}`);
      process.exitCode = result.verdict === 'passed' ? 0 : 1;
    },

    async run({ workspace, caseName, video, headed, heal }) {
      const ws = path.resolve(workspace);
      const runId = newRunId();
      const runDir = runDirPath(ws, runId);
      io.out(`Replaying case "${caseName}" (run ${runId})...`);
      const result = await executeRun({
        workspace: ws,
        caseName,
        mode: 'replay',
        video,
        headed,
        heal,
        runDir,
      });
      io.out(formatRunResult(result));
      io.out(`Run dir:    ${runDir}`);
      process.exitCode = result.verdict === 'passed' ? 0 : 1;
    },

    async export({ workspace, caseName, out }) {
      const ws = path.resolve(workspace);
      const replay = await loadReplayFile(caseReplayPath(ws, caseName));
      const specTs = exportToPlaywrightSpec(replay);
      const outPath = out ? path.resolve(out) : path.join(ws, 'cases', `${caseName}.spec.ts`);
      await writeFile(outPath, specTs, 'utf8');
      io.out(`Wrote ${outPath}`);
    },

    async runs({ workspace, server }) {
      const summaries = server
        ? await fetchJson<RunSummary[]>(apiUrl(server, '/api/runs'))
        : await readRunsFromDir(runsDir(path.resolve(workspace)));
      io.out(formatRunSummaries(summaries));
    },

    async report({ workspace, runId, server }) {
      if (server) {
        const body = await fetchJson<{ status: string; result?: RunResult; error?: string }>(
          apiUrl(server, `/api/runs/${encodeURIComponent(runId)}`),
        );
        if (body.result) {
          io.out(formatRunResult(body.result));
        } else {
          io.out(`Run ${runId}: ${body.status}${body.error ? ` (${body.error})` : ''}`);
        }
        return;
      }
      const ws = path.resolve(workspace);
      let raw: string;
      try {
        raw = await readFile(path.join(runsDir(ws), runId, 'result.json'), 'utf8');
      } catch {
        io.err(`No report found for run "${runId}" in ${runsDir(ws)}`);
        process.exitCode = 1;
        return;
      }
      io.out(formatRunResult(JSON.parse(raw) as RunResult));
    },

    async serve({ workspace, port }) {
      const { startServer } = await import('@casepilot/server');
      const { address } = await startServer({ workspace: path.resolve(workspace), port });
      io.out(`casepilot server listening on ${address}`);
      io.out('Press Ctrl+C to stop.');
    },

    async mcp({ workspace }) {
      const ws = path.resolve(workspace);
      let command: string;
      let args: string[];
      try {
        command = process.execPath;
        args = [resolveMcpBinPath(), 'control', '--workspace', ws];
      } catch {
        command = 'casepilot-mcp';
        args = ['control', '--workspace', ws];
      }
      const snippet = { mcpServers: { casepilot: { command, args } } };
      io.out('casepilot control MCP server');
      io.out('============================');
      io.out('');
      io.out('It exposes tools to list/get/upsert/run/export cases and read run reports.');
      io.out('Record-via-agent runs go through the REST server: start it with "casepilot serve".');
      io.out('');
      io.out('Add this to your MCP client configuration (e.g. Claude Code .mcp.json):');
      io.out('');
      io.out(JSON.stringify(snippet, null, 2));
      io.out('');
      io.out('Claude Code one-liner:');
      io.out(`  claude mcp add casepilot -- ${[command, ...args].join(' ')}`);
    },
  };
}
