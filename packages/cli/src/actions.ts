import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { exportToPlaywrightSpec, loadReplayFile } from '@casepilot/core';
import type { RunResult } from '@casepilot/core';
import {
  approveHeal,
  caseReplayPath,
  executeRun,
  listHeals,
  newRunId,
  readRunsFromDir,
  rejectHeal,
  resolveMcpBinPath,
  runDirPath,
  runsDir,
  type ApprovalOutcome,
  type RunSummary,
} from '@casepilot/server/runner';
import { initWorkspace } from './init.js';
import { resolveBaseUrl } from './options.js';
import { formatHealDiff, formatHealList, formatRunResult, formatRunSummaries } from './format.js';
import { startHeartbeat } from './heartbeat.js';
import { formatTranscript } from './transcript.js';
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

function reportApproval(io: CliIo, outcome: ApprovalOutcome, successSuffix: string): void {
  if (outcome.ok) {
    io.out(formatHealDiff(outcome.heal));
    io.out(`Heal ${outcome.heal.id} ${successSuffix}.`);
    return;
  }
  const messages = {
    'not-found': 'no heal with that id',
    'already-resolved': 'heal already resolved',
    conflict: 'replay step changed since heal was recorded',
  } as const;
  io.err(messages[outcome.code]);
  process.exitCode = 1;
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

    async record({ workspace, caseName, provider, video, headed, screenshots, viewport, optimizeVideo, videoPadMs, baseUrl }) {
      const ws = path.resolve(workspace);
      const runId = newRunId();
      const runDir = runDirPath(ws, runId);
      io.out(`Recording case "${caseName}" (run ${runId})...`);
      const stopHeartbeat = startHeartbeat({ label: 'record', write: (line) => io.err(line) });
      let result: RunResult;
      try {
        result = await executeRun({
          workspace: ws,
          caseName,
          mode: 'record',
          providerId: provider,
          video,
          headed,
          screenshots,
          viewport,
          optimizeVideo,
          videoPadMs,
          baseUrl: resolveBaseUrl(baseUrl),
          runDir,
        });
      } finally {
        stopHeartbeat();
      }
      io.out(formatRunResult(result));
      io.out(`Run dir:    ${runDir}`);
      if (result.verdict !== 'passed' && result.artifacts.transcriptPath) {
        io.out(`Inspect the provider transcript with: casepilot transcript ${runId}`);
      }
      process.exitCode = result.verdict === 'passed' ? 0 : 1;
    },

    async run({ workspace, caseName, video, headed, heal, healPolicy, screenshots, viewport, optimizeVideo, videoPadMs, baseUrl }) {
      const ws = path.resolve(workspace);
      const runId = newRunId();
      const runDir = runDirPath(ws, runId);
      io.out(`Replaying case "${caseName}" (run ${runId})...`);
      const stopHeartbeat = startHeartbeat({ label: 'run', write: (line) => io.err(line) });
      let result: RunResult;
      try {
        result = await executeRun({
          workspace: ws,
          caseName,
          mode: 'replay',
          video,
          headed,
          heal,
          healPolicy,
          screenshots,
          viewport,
          optimizeVideo,
          videoPadMs,
          baseUrl: resolveBaseUrl(baseUrl),
          runDir,
        });
      } finally {
        stopHeartbeat();
      }
      io.out(formatRunResult(result));
      io.out(`Run dir:    ${runDir}`);
      if (result.verdict !== 'passed' && result.artifacts.transcriptPath) {
        io.out(`Inspect the provider transcript with: casepilot transcript ${runId}`);
      }
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

    async transcript({ workspace, runId }) {
      const ws = path.resolve(workspace);
      const transcriptPath = path.join(runsDir(ws), runId, 'transcript.txt');
      let raw: string;
      try {
        raw = await readFile(transcriptPath, 'utf8');
      } catch {
        io.err(`No transcript found for run "${runId}" (looked for ${transcriptPath})`);
        process.exitCode = 1;
        return;
      }
      io.out(formatTranscript(raw));
    },

    async serve({ workspace, port, registry }) {
      const { startServer } = await import('@casepilot/server');
      const { address } = await startServer({
        workspace: workspace ? path.resolve(workspace) : undefined,
        port,
        registryPath: registry,
      });
      io.out(`casepilot server listening on ${address}`);
      io.out(workspace ? `Serving workspace ${path.resolve(workspace)}` : 'Serving all registered projects.');
      io.out('Press Ctrl+C to stop.');
    },

    async projectsList({ registry }) {
      const { defaultRegistryPath, loadProjects } = await import('@casepilot/server/projects');
      const registryPath = registry ?? defaultRegistryPath();
      const { projects } = await loadProjects(registryPath);
      if (projects.length === 0) {
        io.out(`No projects registered in ${registryPath}`);
        io.out('Register one with: casepilot projects add <path> [--name <name>]');
        return;
      }
      for (const project of projects) {
        io.out(`${project.id}  ${project.name}  ${project.path}`);
      }
    },

    async projectsAdd({ path: projectPath, name, registry }) {
      const { defaultRegistryPath, registerProject } = await import('@casepilot/server/projects');
      const registryPath = registry ?? defaultRegistryPath();
      const project = await registerProject(registryPath, { name, path: path.resolve(projectPath) });
      io.out(`Registered project "${project.name}" (id: ${project.id})`);
      io.out(`  path:     ${project.path}`);
      io.out(`  registry: ${registryPath}`);
    },

    async projectsRemove({ id, registry }) {
      const { defaultRegistryPath, removeProject } = await import('@casepilot/server/projects');
      const registryPath = registry ?? defaultRegistryPath();
      if (await removeProject(registryPath, id)) {
        io.out(`Removed project "${id}" from ${registryPath} (workspace files untouched).`);
      } else {
        io.err(`No project with id "${id}" in ${registryPath}`);
        process.exitCode = 1;
      }
    },

    async healsList({ workspace, all }) {
      const ws = path.resolve(workspace);
      const heals = await listHeals(ws, all ? undefined : 'pending');
      io.out(formatHealList(heals));
    },

    async healsApprove({ workspace, healId }) {
      const ws = path.resolve(workspace);
      reportApproval(io, await approveHeal(ws, healId), 'approved; replay updated');
    },

    async healsReject({ workspace, healId }) {
      const ws = path.resolve(workspace);
      reportApproval(io, await rejectHeal(ws, healId), 'rejected; replay untouched');
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
