import { runSuite, writeSuiteReports, type RunSuiteOptions } from './suiteRunner.js';
import { suiteDirPath, newSuiteId } from './workspace.js';
import { executeRun, type RunnerDeps } from './runner.js';
import type { RunRegistry } from './runs.js';
import type { SuiteRegistry } from './suites.js';

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
    try {
      const suite = await runSuite(
        {
          workspace: this.workspace,
          caseNames: input.caseNames,
          concurrency: input.concurrency,
          replayOptions: input.replayOptions,
          onCaseStart: (runId, caseName, runDir) =>
            this.runs.create({ runId, case: caseName, mode: 'replay', provider: 'replay', runDir }),
          onCaseSettled: (runId, result, error) =>
            result ? this.runs.complete(runId, result) : this.runs.fail(runId, error ?? 'suite case failed'),
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
