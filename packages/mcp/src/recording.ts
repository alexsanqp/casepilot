import type { AssertStep, ReplayFile, ReplayStep, StepResult } from '@casepilot/core';

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
}

export function createRecordingState(): RecordingState {
  return { stepResults: [], replaySteps: [] };
}

export function recordStepOutcome(
  state: RecordingState,
  step: ReplayStep,
  outcome: { ok: boolean; error?: string; durationMs: number },
): void {
  state.stepResults.push({
    index: state.replaySteps.length,
    step,
    status: outcome.ok ? 'passed' : 'failed',
    error: outcome.ok ? undefined : outcome.error ?? 'unknown error',
    durationMs: outcome.durationMs,
  });
  if (outcome.ok) state.replaySteps.push(step);
}

/**
 * Verdict guard: the model's "passed" only counts if asserts were executed and the
 * final attempt of each distinct assert passed. Mirrors core recorder semantics.
 */
export function validateAsserts(stepResults: StepResult[]): { ok: boolean; reason?: string } {
  const finalBySignature = new Map<string, StepResult>();
  for (const result of stepResults) {
    if (result.step.kind !== 'assert') continue;
    const { note: _note, ...signatureParts } = result.step;
    finalBySignature.set(JSON.stringify(signatureParts), result);
  }
  if (finalBySignature.size === 0) {
    return { ok: false, reason: 'no assertions were executed' };
  }
  const failed = [...finalBySignature.values()].filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    return {
      ok: false,
      reason: failed
        .map((r) => `assert ${(r.step as AssertStep).assert} failed: ${r.error ?? 'unknown error'}`)
        .join('; '),
    };
  }
  return { ok: true };
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
  let verdict: 'passed' | 'failed';
  let explanation: string;
  if (!reported) {
    verdict = 'failed';
    explanation = 'Recording finished without report_result being called.';
  } else if (!reported.passed) {
    verdict = 'failed';
    explanation = reported.explanation;
  } else {
    const validation = validateAsserts(state.stepResults);
    if (validation.ok) {
      verdict = 'passed';
      explanation = reported.explanation;
    } else {
      verdict = 'failed';
      explanation = `Provider reported passed, but validation disagrees: ${validation.reason}.`;
    }
  }
  return { replay: assembleReplay(state, meta), verdict, explanation };
}
