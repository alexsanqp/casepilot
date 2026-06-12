import path from 'node:path';
import { createRequire } from 'node:module';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { loadCaseFile, loadReplayFile, recordCase, replayCase, saveReplayFile, stripAnsi } from '@casepilot/core';
import type {
  AgentProvider,
  CaseSpec,
  ChatProvider,
  HealerFn,
  ReplayFile,
  ReplayHooks,
  RunOptions,
  RunResult,
} from '@casepilot/core';
import { buildHealer } from './healer.js';
import { addHeal } from './heals.js';
import { readWorkspaceBaseUrl, readWorkspaceHealPolicy, type HealPolicy } from './workspaceConfig.js';
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
  /** Replay only. Overrides the workspace healPolicy (default "review"). */
  healPolicy?: HealPolicy;
  screenshots?: boolean;
  viewport?: { width: number; height: number };
  optimizeVideo?: boolean;
  videoPadMs?: number;
  /** Target base URL; overrides the workspace config baseUrl. */
  baseUrl?: string;
  runDir: string;
}

export interface RunEngine {
  recordCase(
    spec: CaseSpec,
    provider: ChatProvider,
    options: RunOptions,
  ): Promise<{ result: RunResult; replay: ReplayFile }>;
  replayCase(replay: ReplayFile, options: RunOptions, healer?: HealerFn, hooks?: ReplayHooks): Promise<RunResult>;
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
    '- Your turn budget is limited: batch multiple independent tool calls in a single message whenever possible (e.g. query_page for the next element together with an act on the current one, or several asserts at once).',
    '- Page state persists between tool calls; do not re-check state you already know.',
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

function closeStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => stream.end(resolve));
}

async function recordViaAgent(
  req: RunRequest,
  spec: CaseSpec,
  provider: AgentProvider,
  deps: RunnerDeps,
  baseUrl?: string,
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
  if (req.screenshots) mcpArgs.push('--screenshots');
  if (req.viewport) mcpArgs.push('--viewport', `${req.viewport.width}x${req.viewport.height}`);
  if (req.optimizeVideo) mcpArgs.push('--optimize-video');
  if (req.videoPadMs !== undefined) mcpArgs.push('--video-pad', String(req.videoPadMs));
  if (baseUrl) mcpArgs.push('--base-url', baseUrl);

  const transcriptPath = path.join(req.runDir, 'transcript.txt');
  // Stream the CLI output to disk as it arrives, so even a hard kill of the
  // provider process leaves a diagnosable transcript behind.
  const transcriptStream = createWriteStream(transcriptPath, { encoding: 'utf8' });
  let transcript: string;
  try {
    ({ transcript } = await provider.runTask({
      taskPrompt: buildAgentTaskPrompt(spec),
      mcp: { command: process.execPath, args: mcpArgs },
      cwd: req.workspace,
      onOutput: (chunk) => transcriptStream.write(chunk),
    }));
  } catch (err) {
    await closeStream(transcriptStream);
    // Agent CLI failures (CliExitError) carry the full captured stdout; persist
    // it so a failed run still leaves the complete session transcript behind.
    const captured = (err as { stdout?: unknown }).stdout;
    if (typeof captured === 'string' && captured.length > 0) {
      await writeFile(transcriptPath, captured, 'utf8');
    }
    throw err;
  }

  await closeStream(transcriptStream);
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

async function buildReplayHooks(req: RunRequest): Promise<ReplayHooks> {
  const policy = req.healPolicy ?? (await readWorkspaceHealPolicy(req.workspace));
  if (policy === 'auto') return { applyHeals: true };
  const runId = path.basename(req.runDir);
  return {
    applyHeals: false,
    onHeal: async (event) => {
      await addHeal(req.workspace, { ...event, runId });
    },
  };
}

export async function executeRun(req: RunRequest, deps: RunnerDeps = defaultRunnerDeps()): Promise<RunResult> {
  assertCaseName(req.caseName);
  await mkdir(req.runDir, { recursive: true });
  const baseUrl = req.baseUrl ?? (await readWorkspaceBaseUrl(req.workspace));
  const options: RunOptions = {
    headless: !req.headed,
    video: !!req.video,
    artifactsDir: req.runDir,
    viewport: req.viewport,
    stepScreenshots: req.screenshots,
    optimizeVideo: req.optimizeVideo,
    videoPadMs: req.videoPadMs,
    baseUrl,
  };
  const startedAt = new Date().toISOString();

  let result: RunResult;
  try {
    if (req.mode === 'replay') {
      const replay = await loadReplayFile(caseReplayPath(req.workspace, req.caseName));
      const healer = req.heal === false ? undefined : await pickHealer(req, deps);
      result = await deps.engine.replayCase(replay, options, healer, await buildReplayHooks(req));
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
        result = await recordViaAgent(req, spec, provider, deps, baseUrl);
      }
    }
  } catch (err) {
    // Leave a diagnosable result.json behind even when the run blows up before
    // producing one (provider launch/auth failures, missing replay, ...).
    await pruneEmptyVideos(req.runDir);
    const failure: RunResult = {
      case: req.caseName,
      caseName: req.caseName,
      mode: req.mode,
      verdict: 'failed',
      explanation: stripAnsi(err instanceof Error ? err.message : String(err)),
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
export { addHeal, listHeals, loadHeals, healsFilePath, resolveHeal } from './heals.js';
export type { HealRecord, HealStatus, HealsFile, HealInput } from './heals.js';
export { approveHeal, rejectHeal } from './healApproval.js';
export type { ApprovalOutcome, ApprovalFailure } from './healApproval.js';
export { readWorkspaceBaseUrl, readWorkspaceHealPolicy } from './workspaceConfig.js';
export type { HealPolicy } from './workspaceConfig.js';
export type { ProviderRegistryLike, ProviderSummary } from './providersLoader.js';
