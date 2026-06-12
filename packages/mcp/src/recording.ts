import { collapseStepResults, stripAnsi, validateFinalOutcomes } from '@casepilot/core';
import type { ReplayFile, ReplayStep, StepResult } from '@casepilot/core';

export interface RecordingState {
  stepResults: StepResult[];
  replaySteps: ReplayStep[];
}

export interface ReportedResult {
  passed: boolean;
  explanation: string;
}

export interface RecordingMeta {
  caseName: string;
  url: string;
  providerUsed: string;
  recordedAt: string;
}

export interface FinalizedRecording {
  replay: ReplayFile;
  verdict: 'passed' | 'failed';
  explanation: string;
  /** Final per-index outcomes: retries supersede earlier attempts at the same index. */
  steps: StepResult[];
}

export function createRecordingState(): RecordingState {
  return { stepResults: [], replaySteps: [] };
}

export function recordStepOutcome(
  state: RecordingState,
  step: ReplayStep,
  outcome: { ok: boolean; error?: string; durationMs: number; offsetMs?: number },
): void {
  state.stepResults.push({
    index: state.replaySteps.length,
    step,
    status: outcome.ok ? 'passed' : 'failed',
    error: outcome.ok ? undefined : stripAnsi(outcome.error ?? 'unknown error'),
    durationMs: outcome.durationMs,
    offsetMs: outcome.offsetMs ?? 0,
  });
  if (outcome.ok) state.replaySteps.push(step);
}

/**
 * Final per-index outcomes. Failed attempts do not advance the replay, so a
 * retry of the same logical step reuses the index and supersedes the earlier
 * attempt. Mirrors core recorder semantics.
 */
export function finalStepResults(state: RecordingState): StepResult[] {
  return collapseStepResults(state.stepResults);
}

export function assembleReplay(state: RecordingState, meta: RecordingMeta): ReplayFile {
  return {
    version: 1,
    case: meta.caseName,
    url: meta.url,
    providerUsed: meta.providerUsed,
    recordedAt: meta.recordedAt,
    steps: state.replaySteps,
    meta: { healCount: 0 },
  };
}

export function finalizeRecording(
  state: RecordingState,
  reported: ReportedResult | undefined,
  meta: RecordingMeta,
): FinalizedRecording {
  const steps = finalStepResults(state);
  let verdict: 'passed' | 'failed';
  let explanation: string;
  if (!reported) {
    verdict = 'failed';
    explanation = 'Recording finished without report_result being called.';
  } else if (!reported.passed) {
    verdict = 'failed';
    explanation = reported.explanation;
  } else {
    const validation = validateFinalOutcomes(steps);
    if (validation.ok) {
      verdict = 'passed';
      explanation = reported.explanation;
    } else {
      verdict = 'failed';
      explanation = `Provider reported passed, but validation disagrees: ${validation.reason}.`;
    }
  }
  return { replay: assembleReplay(state, meta), verdict, explanation, steps };
}
