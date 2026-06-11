import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { loadCaseFile, loadReplayFile, recordCase, replayCase, saveReplayFile } from '@casepilot/core';
import type {
  AgentProvider,
  CaseSpec,
  ChatProvider,
  HealerFn,
  ReplayFile,
  RunOptions,
  RunResult,
} from '@casepilot/core';
import { buildHealer } from './healer.js';
import { loadWorkspaceRegistry, type ProviderRegistryLike } from './providersLoader.js';
import { assertCaseName, caseFilePath, caseReplayPath, fileExists } from './workspace.js';

export interface RunRequest {
  workspace: string;
  caseName: string;
  mode: 'record' | 'replay';
  providerId?: string;
  video?: boolean;
  headed?: boolean;
  /** Replay only. Default true: heal with a chat provider when one is available. */
  heal?: boolean;
  runDir: string;
}

export interface RunEngine {
  recordCase(
    spec: CaseSpec,
    provider: ChatProvider,
    options: RunOptions,
  ): Promise<{ result: RunResult; replay: ReplayFile }>;
  replayCase(replay: ReplayFile, options: RunOptions, healer?: HealerFn): Promise<RunResult>;
}

export interface RunnerDeps {
  engine: RunEngine;
  loadRegistry(workspace: string): Promise<ProviderRegistryLike>;
  resolveMcpBin(): string;
}

export function resolveMcpBinPath(): string {
  const require = createRequire(import.meta.url);
  return require.resolve('@casepilot/mcp/bin');
}

export function defaultRunnerDeps(): RunnerDeps {
  return {
    engine: { recordCase, replayCase },
    loadRegistry: loadWorkspaceRegistry,
    resolveMcpBin: resolveMcpBinPath,
  };
}

export function buildAgentTaskPrompt(spec: CaseSpec): string {
  return [
    `You are executing a UI test case named "${spec.name}" against a real browser.`,
    'A casepilot MCP server exposes the browser tools: query_page, snapshot, act, assert, report_result.',
    `The browser is already open at the start URL: ${spec.url}`,
    'Execute these steps in order:',
    ...spec.steps.map((s, i) => `  ${i + 1}. ${s}`),
    'Then verify every expectation with assert calls:',
    ...spec.expect.map((e, i) => `  ${i + 1}. ${e}`),
    'Rules:',
    '- Use query_page to locate elements and prefer the selectors it returns.',
    '- Every successful act/assert is recorded into a deterministic replay.',
    '- You MUST finish by calling report_result with passed=true/false and a short explanation. Do not stop before that.',
  ].join('\n');
}

async function pickHealer(req: RunRequest, deps: RunnerDeps): Promise<HealerFn | undefined> {
  let registry: ProviderRegistryLike;
  try {
    registry = await deps.loadRegistry(req.workspace);
  } catch (err) {
    if (req.providerId) throw err;
    return undefined;
  }
  if (req.providerId) {
    const provider = registry.get(req.providerId);
    if (provider.kind !== 'chat') {
      throw new Error(`provider "${req.providerId}" is kind "${provider.kind}"; replay healing requires a chat provider`);
    }
    return buildHealer(provider);
  }
  try {
    const fallback = registry.default();
    if (fallback.kind === 'chat') return buildHealer(fallback);
    const chat = registry.list().find((p) => p.kind === 'chat');
    if (!chat) return undefined;
    const provider = registry.get(chat.id);
    return provider.kind === 'chat' ? buildHealer(provider) : undefined;
  } catch {
    return undefined;
  }
}

async function recordViaAgent(
  req: RunRequest,
  spec: CaseSpec,
  provider: AgentProvider,
  deps: RunnerDeps,
): Promise<RunResult> {
  const mcpArgs = [
    deps.resolveMcpBin(),
    'browser-tools',
    '--case',
    caseFilePath(req.workspace, req.caseName),
    '--artifacts',
    req.runDir,
  ];
  if (req.video) mcpArgs.push('--video');
  if (req.headed) mcpArgs.push('--headed');

  const { transcript } = await provider.runTask({
    taskPrompt: buildAgentTaskPrompt(spec),
    mcp: { command: process.execPath, args: mcpArgs },
    cwd: req.workspace,
  });

  const transcriptPath = path.join(req.runDir, 'transcript.txt');
  await writeFile(transcriptPath, transcript ?? '', 'utf8');

  const resultPath = path.join(req.runDir, 'result.json');
  let raw: string;
  try {
    raw = await readFile(resultPath, 'utf8');
  } catch {
    throw new Error(
      `agent provider "${provider.id}" finished but the browser-tools bridge wrote no result.json in ${req.runDir}; the agent likely never called report_result`,
    );
  }
  const result = JSON.parse(raw) as RunResult;
  result.artifacts.transcriptPath = transcriptPath;

  if (result.verdict === 'passed') {
    const bridgeReplayPath = path.join(req.runDir, 'replay.json');
    if (await fileExists(bridgeReplayPath)) {
      const replay = await loadReplayFile(bridgeReplayPath);
      await saveReplayFile(caseReplayPath(req.workspace, req.caseName), replay);
    }
  }
  return result;
}

/**
 * A bridge killed mid-run (agent CLI crash) leaves unfinalized 0-byte .webm
 * stubs behind that no one can play; drop them so failed run dirs stay clean.
 */
async function pruneEmptyVideos(runDir: string): Promise<void> {
  const videoDir = path.join(runDir, 'video');
  let entries: string[];
  try {
    entries = await readdir(videoDir);
  } catch {
    return;
  }
  for (const name of entries) {
    const filePath = path.join(videoDir, name);
    try {
      if ((await stat(filePath)).size === 0) await rm(filePath, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
  try {
    if ((await readdir(videoDir)).length === 0) await rm(videoDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

export async function executeRun(req: RunRequest, deps: RunnerDeps = defaultRunnerDeps()): Promise<RunResult> {
  assertCaseName(req.caseName);
  await mkdir(req.runDir, { recursive: true });
  const options: RunOptions = { headless: !req.headed, video: !!req.video, artifactsDir: req.runDir };
  const startedAt = new Date().toISOString();

  let result: RunResult;
  try {
    if (req.mode === 'replay') {
      const replay = await loadReplayFile(caseReplayPath(req.workspace, req.caseName));
      const healer = req.heal === false ? undefined : await pickHealer(req, deps);
      result = await deps.engine.replayCase(replay, options, healer);
    } else {
      const spec = await loadCaseFile(caseFilePath(req.workspace, req.caseName));
      const registry = await deps.loadRegistry(req.workspace);
      const provider = req.providerId ? registry.get(req.providerId) : registry.default();
      if (provider.kind === 'chat') {
        const recorded = await deps.engine.recordCase(spec, provider, options);
        result = recorded.result;
        if (result.verdict === 'passed') {
          await saveReplayFile(caseReplayPath(req.workspace, req.caseName), recorded.replay);
        }
      } else {
        result = await recordViaAgent(req, spec, provider, deps);
      }
    }
  } catch (err) {
    // Leave a diagnosable result.json behind even when the run blows up before
    // producing one (provider launch/auth failures, missing replay, ...).
    await pruneEmptyVideos(req.runDir);
    const failure: RunResult = {
      case: req.caseName,
      mode: req.mode,
      verdict: 'failed',
      explanation: err instanceof Error ? err.message : String(err),
      steps: [],
      artifacts: { screenshots: [] },
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    await writeFile(path.join(req.runDir, 'result.json'), JSON.stringify(failure, null, 2), 'utf8');
    throw err;
  }

  await writeFile(path.join(req.runDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  return result;
}

export { newRunId, runDirPath, runsDir, casesDir, caseFilePath, caseReplayPath, listCases, fileExists } from './workspace.js';
export type { CaseSummary } from './workspace.js';
export { readRunsFromDir } from './runs.js';
export type { RunEntry, RunStatus, RunSummary } from './runs.js';
export { buildHealer } from './healer.js';
export type { ProviderRegistryLike, ProviderSummary } from './providersLoader.js';
