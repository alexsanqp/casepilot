import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { BrowserSession } from '../browser/session.js';
import { saveReplayFile } from '../caseFile.js';
import { captureStepScreenshotIfNeeded } from './stepScreenshots.js';
import type {
  CaseSpec,
  HealerFn,
  ReplayFile,
  ReplayHooks,
  ReplayStep,
  RunOptions,
  RunResult,
  StepResult,
} from '../types.js';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describeStep(step: ReplayStep): string {
  const target = step.selector ? ` ${step.selector}` : '';
  return step.kind === 'act' ? `act:${step.action}${target}` : `assert:${step.assert}${target}`;
}

function caseSpecFromReplay(replay: ReplayFile): CaseSpec {
  return {
    name: replay.case,
    url: replay.url,
    steps: replay.steps.filter((s) => s.kind === 'act').map((s) => s.note ?? describeStep(s)),
    expect: replay.steps.filter((s) => s.kind === 'assert').map((s) => s.note ?? describeStep(s)),
  };
}

async function runStep(session: BrowserSession, step: ReplayStep): Promise<void> {
  if (step.kind === 'act') {
    await session.act(step);
    return;
  }
  const { ok, detail } = await session.assert(step);
  if (!ok) throw new Error(detail);
}

export async function replayCase(
  replay: ReplayFile,
  options: RunOptions,
  healer?: HealerFn,
  hooks?: ReplayHooks,
): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const applyHeals = hooks?.applyHeals ?? false;
  await mkdir(options.artifactsDir, { recursive: true });

  const stepResults: StepResult[] = [];
  const screenshots: string[] = [];
  let verdict: 'passed' | 'failed' = 'passed';
  let explanation = `All ${replay.steps.length} recorded steps replayed successfully.`;
  let persistedHeals = false;
  let videoPath: string | undefined;
  const replayPath = path.join(options.artifactsDir, 'replay.json');

  const session = await BrowserSession.launch(options);
  try {
    await session.goto(replay.url);

    const pushResult = async (result: Omit<StepResult, 'screenshot'>): Promise<void> => {
      const screenshot = await captureStepScreenshotIfNeeded(
        session,
        options,
        result.index,
        result.status === 'failed',
        screenshots,
      );
      stepResults.push({ ...result, screenshot });
    };

    for (let i = 0; i < replay.steps.length; i++) {
      const step = replay.steps[i]!;
      const offsetMs = Date.now() - session.startedAt;
      const t0 = Date.now();
      try {
        await runStep(session, step);
        await pushResult({ index: i, step, status: 'passed', durationMs: Date.now() - t0, offsetMs });
        continue;
      } catch (err) {
        const error = errorMessage(err);
        if (healer) {
          const pageState = await session.snapshot();
          const fixedStep = await healer({
            failedStep: step,
            error,
            caseSpec: caseSpecFromReplay(replay),
            pageState,
          });
          if (fixedStep) {
            try {
              await runStep(session, fixedStep);
              await hooks?.onHeal?.({
                caseName: replay.case,
                stepIndex: i,
                oldStep: step,
                newStep: fixedStep,
                createdAt: new Date().toISOString(),
              });
              if (applyHeals) {
                replay.steps[i] = fixedStep;
                replay.meta.healCount += 1;
                persistedHeals = true;
              }
              await pushResult({
                index: i,
                step: fixedStep,
                status: 'healed',
                error,
                durationMs: Date.now() - t0,
                offsetMs,
              });
              continue;
            } catch (retryErr) {
              await pushResult({
                index: i,
                step,
                status: 'failed',
                error: `${error}; healed retry also failed: ${errorMessage(retryErr)}`,
                durationMs: Date.now() - t0,
                offsetMs,
              });
              verdict = 'failed';
              explanation = `Step ${i} (${describeStep(step)}) failed: ${error}. Healed retry (${describeStep(fixedStep)}) also failed: ${errorMessage(retryErr)}`;
              break;
            }
          }
        }
        await pushResult({ index: i, step, status: 'failed', error, durationMs: Date.now() - t0, offsetMs });
        verdict = 'failed';
        explanation = `Step ${i} (${describeStep(step)}) failed: ${error}`;
        break;
      }
    }

    if (persistedHeals) {
      await saveReplayFile(replayPath, replay);
    }
  } finally {
    ({ videoPath } = await session.close());
  }

  return {
    case: replay.case,
    mode: 'replay',
    verdict,
    explanation,
    steps: stepResults,
    artifacts: { videoPath, replayPath: persistedHeals ? replayPath : undefined, screenshots },
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
