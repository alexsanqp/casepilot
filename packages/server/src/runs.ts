import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import type { RunResult } from '@casepilot/core';

export type RunStatus = 'running' | 'done' | 'error';

export interface RunSummary {
  runId: string;
  case: string;
  mode: 'record' | 'replay';
  provider: string;
  status: RunStatus;
  verdict?: 'passed' | 'failed';
  startedAt: string;
  finishedAt?: string;
}

export interface RunEntry extends RunSummary {
  result?: RunResult;
  error?: string;
  runDir: string;
}

export async function readRunsFromDir(runsDirPath: string): Promise<RunEntry[]> {
  let entries;
  try {
    entries = await readdir(runsDirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: RunEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(runsDirPath, entry.name);
    let result: RunResult;
    try {
      result = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')) as RunResult;
    } catch {
      continue;
    }
    let provider = 'unknown';
    try {
      const replay = JSON.parse(await readFile(path.join(runDir, 'replay.json'), 'utf8')) as {
        providerUsed?: string;
      };
      provider = replay.providerUsed ?? 'unknown';
    } catch {
      // replay is optional; runs without one keep provider "unknown"
    }
    out.push({
      runId: entry.name,
      case: result.case,
      mode: result.mode,
      provider,
      status: 'done',
      verdict: result.verdict,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      result,
      runDir,
    });
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export class RunRegistry {
  private readonly runs = new Map<string, RunEntry>();

  static async open(runsDirPath: string): Promise<RunRegistry> {
    const registry = new RunRegistry();
    for (const entry of await readRunsFromDir(runsDirPath)) {
      registry.runs.set(entry.runId, entry);
    }
    return registry;
  }

  create(input: { runId: string; case: string; mode: 'record' | 'replay'; provider: string; runDir: string }): void {
    this.runs.set(input.runId, {
      runId: input.runId,
      case: input.case,
      mode: input.mode,
      provider: input.provider,
      status: 'running',
      startedAt: new Date().toISOString(),
      runDir: input.runDir,
    });
  }

  complete(runId: string, result: RunResult): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    entry.status = 'done';
    entry.verdict = result.verdict;
    entry.finishedAt = result.finishedAt;
    entry.result = result;
  }

  fail(runId: string, error: string): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    entry.status = 'error';
    entry.error = error;
    entry.finishedAt = new Date().toISOString();
  }

  get(runId: string): RunEntry | undefined {
    return this.runs.get(runId);
  }

  list(): RunSummary[] {
    return [...this.runs.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((entry) => ({
        runId: entry.runId,
        case: entry.case,
        mode: entry.mode,
        provider: entry.provider,
        status: entry.status,
        verdict: entry.verdict,
        startedAt: entry.startedAt,
        finishedAt: entry.finishedAt,
      }));
  }
}
