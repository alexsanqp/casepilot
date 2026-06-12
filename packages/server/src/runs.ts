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

export interface CaseLastRun {
  id: string;
  status: RunStatus;
  verdict?: 'passed' | 'failed';
  finishedAt?: string;
}

/**
 * Finished runs are matched on result.caseName; legacy results predating that
 * field never match. Runs without a result (running/error) were created in
 * this session, so the registry's own case field is authoritative.
 */
function entryCaseName(entry: RunEntry): string | undefined {
  return entry.result ? entry.result.caseName : entry.case;
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

  /**
   * When the failed run still produced a result.json, the entry mirrors what a
   * disk reload would show (done + failed verdict); "error" is reserved for
   * runs that left no result behind at all.
   */
  fail(runId: string, error: string, result?: RunResult): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    entry.error = error;
    if (result) {
      entry.status = 'done';
      entry.verdict = result.verdict;
      entry.finishedAt = result.finishedAt;
      entry.result = result;
    } else {
      entry.status = 'error';
      entry.finishedAt = new Date().toISOString();
    }
  }

  get(runId: string): RunEntry | undefined {
    return this.runs.get(runId);
  }

  list(caseName?: string): RunSummary[] {
    return this.sorted()
      .filter((entry) => caseName === undefined || entryCaseName(entry) === caseName)
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

  lastRunsByCase(): Map<string, CaseLastRun> {
    const out = new Map<string, CaseLastRun>();
    for (const entry of this.sorted()) {
      const name = entryCaseName(entry);
      if (!name || out.has(name)) continue;
      out.set(name, {
        id: entry.runId,
        status: entry.status,
        verdict: entry.verdict,
        finishedAt: entry.finishedAt,
      });
    }
    return out;
  }

  private sorted(): RunEntry[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}
