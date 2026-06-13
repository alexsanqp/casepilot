import type { StepResult } from '../types.js';

/**
 * Collapses repeated attempts at the same step index into the final attempt.
 * A retry of a logical step reuses the index (failed attempts do not advance
 * the replay), so the last attempt per index supersedes the earlier ones.
 */
export function collapseStepResults(stepResults: StepResult[]): StepResult[] {
  const finalByIndex = new Map<number, StepResult>();
  const attemptsByIndex = new Map<number, number>();
  for (const result of stepResults) {
    finalByIndex.set(result.index, result);
    attemptsByIndex.set(result.index, (attemptsByIndex.get(result.index) ?? 0) + 1);
  }
  return [...finalByIndex.values()].map((result) => {
    const retries = (attemptsByIndex.get(result.index) ?? 1) - 1;
    return retries > 0 ? { ...result, retries } : result;
  });
}

/**
 * True when at least one `assert` step actually ran and verified (passed or
 * healed). Replay relies on this so a recorded case that asserts nothing — an
 * empty replay, or one reduced to only act steps after a heal dropped its
 * single assertion — cannot replay to a false "passed".
 */
export function assertionsWereVerified(stepResults: StepResult[]): boolean {
  return stepResults.some(
    (r) => r.step.kind === 'assert' && (r.status === 'passed' || r.status === 'healed'),
  );
}

/**
 * Verdict guard over final per-index outcomes: every step's final attempt must
 * have passed (or healed) and at least one assert must have been executed.
 */
export function validateFinalOutcomes(finalSteps: StepResult[]): { ok: boolean; reason?: string } {
  if (!finalSteps.some((r) => r.step.kind === 'assert')) {
    return { ok: false, reason: 'no assertions were executed' };
  }
  const failed = finalSteps.filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    return {
      ok: false,
      reason: failed
        .map((r) => {
          const label = r.step.kind === 'assert' ? `assert ${r.step.assert}` : `act ${r.step.action}`;
          return `${label} failed: ${r.error ?? 'unknown error'}`;
        })
        .join('; '),
    };
  }
  return { ok: true };
}
