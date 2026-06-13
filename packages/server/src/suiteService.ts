import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { RunResult } from '@casepilot/core';
import { runSuite, writeSuiteReports, type RunSuiteOptions } from './suiteRunner.js';
import { suiteDirPath, newSuiteId } from './workspace.js';
import { executeRun, type RunnerDeps } from './runner.js';
import type { RunRegistry } from './runs.js';
import type { SuiteRegistry } from './suites.js';

// Mirrors RunService.readRunResult: when a suite case throws, executeRun still
// writes a verdict-failed result.json before rethrowing, so reload it to record
// the per-case run as done/failed (matching a server restart) rather than error.
async function readRunResult(runDir: string): Promise<RunResult | undefined> {
  try {
    return JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')) as RunResult;
  } catch {
    return undefined;
  }
}

export interface SuiteStartInput {
  caseNames?: string[];
  concurrency?: number;
  replayOptions?: RunSuiteOptions['replayOptions'];
}

export class SuiteService {
  constructor(
    private readonly workspace: string,
    private readonly suites: SuiteRegistry,
    private readonly runs: RunRegistry,
    private readonly deps: RunnerDeps,
  ) {}

  start(input: SuiteStartInput): { suiteId: string } {
    const suiteId = newSuiteId();
    this.suites.create(suiteId);
    void this.execute(suiteId, input);
    return { suiteId };
  }

  private async execute(suiteId: string, input: SuiteStartInput): Promise<void> {
    // Per-case run dirs, captured on start, so a thrown case can recover the
    // verdict-failed result.json executeRun left behind (mirrors RunService).
    const runDirs = new Map<string, string>();
    try {
      const suite = await runSuite(
        {
          workspace: this.workspace,
          caseNames: input.caseNames,
          concurrency: input.concurrency,
          replayOptions: input.replayOptions,
          onCaseStart: (runId, caseName, runDir) => {
            runDirs.set(runId, runDir);
            this.runs.create({ runId, case: caseName, mode: 'replay', provider: 'replay', runDir });
          },
          onCaseSettled: async (runId, result, error) => {
            if (result) {
              this.runs.complete(runId, result);
              return;
            }
            const runDir = runDirs.get(runId);
            const persisted = runDir ? await readRunResult(runDir) : undefined;
            this.runs.fail(runId, error ?? 'suite case failed', persisted);
          },
        },
        // Thread the project's RunnerDeps so suite runs honor the same injected
        // engine as single runs (executeRun takes deps as its 2nd arg).
        { executeRun: (req) => executeRun(req, this.deps) },
      );
      await writeSuiteReports(suiteDirPath(this.workspace, suiteId), suite, {});
      this.suites.complete(suiteId, suite);
    } catch (err) {
      this.suites.fail(suiteId, err instanceof Error ? err.message : String(err));
    }
  }
}
