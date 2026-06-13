import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  aggregateSuite,
  suiteToJson,
  suiteToJUnitXml,
  type RunResult,
  type SuiteCaseResult,
  type SuiteResult,
} from '@casepilot/core';
import { executeRun as realExecuteRun, type RunRequest } from './runner.js';
import { listCases as realListCases, newRunId, runDirPath } from './workspace.js';
import { mapWithConcurrency } from './concurrency.js';

export type ReplayRunOptions = Omit<RunRequest, 'workspace' | 'caseName' | 'mode' | 'runDir'>;

export interface RunSuiteDeps {
  executeRun: (req: RunRequest) => Promise<RunResult>;
  listCases: (workspace: string) => Promise<{ name: string; hasReplay: boolean }[]>;
}

export interface SuiteProgress {
  index: number;
  total: number;
  caseName: string;
  phase: 'start' | 'done';
  case?: SuiteCaseResult;
}

export interface RunSuiteOptions {
  workspace: string;
  /** undefined ⇒ all recorded cases. */
  caseNames?: string[];
  /** Default 1 (serial). */
  concurrency?: number;
  replayOptions?: ReplayRunOptions;
  onProgress?: (ev: SuiteProgress) => void;
  onCaseStart?: (runId: string, caseName: string, runDir: string) => void;
  onCaseSettled?: (runId: string, result?: RunResult, error?: string) => void;
}

export async function runSuite(opts: RunSuiteOptions, deps: Partial<RunSuiteDeps> = {}): Promise<SuiteResult> {
  const executeRun = deps.executeRun ?? realExecuteRun;
  const listCases = deps.listCases ?? realListCases;
  const startedAt = new Date().toISOString();

  const all = await listCases(opts.workspace);
  const byName = new Map(all.map((c) => [c.name, c]));
  const selected = opts.caseNames ?? all.map((c) => c.name);
  const total = selected.length;

  const cases = await mapWithConcurrency(selected, opts.concurrency ?? 1, async (caseName, index) => {
    opts.onProgress?.({ index, total, caseName, phase: 'start' });
    const info = byName.get(caseName);
    const settle = (c: SuiteCaseResult): SuiteCaseResult => {
      opts.onProgress?.({ index, total, caseName, phase: 'done', case: c });
      return c;
    };
    if (!info || !info.hasReplay) {
      return settle({ caseName, status: 'skipped', durationMs: 0, reason: info ? 'not recorded' : 'no such case' });
    }
    const runId = newRunId();
    const runDir = runDirPath(opts.workspace, runId);
    opts.onCaseStart?.(runId, caseName, runDir);
    const t0 = Date.now();
    try {
      const result = await executeRun({
        ...opts.replayOptions,
        workspace: opts.workspace,
        caseName,
        mode: 'replay',
        runDir,
      } as RunRequest);
      opts.onCaseSettled?.(runId, result);
      return settle({
        caseName,
        status: result.verdict === 'passed' ? 'passed' : 'failed',
        verdict: result.verdict,
        runId,
        durationMs: Date.now() - t0,
        reason: result.verdict === 'failed' ? result.explanation : undefined,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      opts.onCaseSettled?.(runId, undefined, reason);
      return settle({ caseName, status: 'failed', runId, durationMs: Date.now() - t0, reason });
    }
  });

  return aggregateSuite(cases, startedAt, new Date().toISOString());
}

export async function writeSuiteReports(
  suiteDir: string,
  suite: SuiteResult,
  extra: { junit?: string; json?: string },
): Promise<void> {
  await mkdir(suiteDir, { recursive: true });
  const junitXml = suiteToJUnitXml(suite);
  const json = suiteToJson(suite);
  await writeFile(path.join(suiteDir, 'suite.json'), json, 'utf8');
  await writeFile(path.join(suiteDir, 'junit.xml'), junitXml, 'utf8');
  if (extra.json) {
    await mkdir(path.dirname(path.resolve(extra.json)), { recursive: true });
    await writeFile(path.resolve(extra.json), json, 'utf8');
  }
  if (extra.junit) {
    await mkdir(path.dirname(path.resolve(extra.junit)), { recursive: true });
    await writeFile(path.resolve(extra.junit), junitXml, 'utf8');
  }
}
