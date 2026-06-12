import { describe, expect, it } from 'vitest';
import type { StepResult } from '../src/types.js';
import { collapseStepResults, validateFinalOutcomes } from '../src/engine/outcomes.js';
import { stripAnsi } from '../src/text.js';

function step(
  index: number,
  status: StepResult['status'],
  overrides?: Partial<StepResult> & { kind?: 'act' | 'assert'; selector?: string },
): StepResult {
  const kind = overrides?.kind ?? 'act';
  return {
    index,
    step:
      kind === 'act'
        ? { kind: 'act', action: 'click', selector: overrides?.selector ?? '#el' }
        : { kind: 'assert', assert: 'visible', selector: overrides?.selector ?? '#el' },
    status,
    error: overrides?.error,
    durationMs: 1,
    offsetMs: 0,
  };
}

describe('collapseStepResults', () => {
  it('keeps the last attempt per index and counts retries', () => {
    const collapsed = collapseStepResults([
      step(0, 'failed', { selector: '#wrong', error: 'timeout' }),
      step(0, 'passed', { selector: '#right' }),
      step(1, 'passed'),
    ]);
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]).toMatchObject({ index: 0, status: 'passed', retries: 1 });
    expect(collapsed[0]!.step).toMatchObject({ selector: '#right' });
    expect(collapsed[1]).toMatchObject({ index: 1, status: 'passed' });
    expect(collapsed[1]).not.toHaveProperty('retries');
  });

  it('returns unique indices even after multiple retries', () => {
    const collapsed = collapseStepResults([
      step(0, 'failed'),
      step(0, 'failed'),
      step(0, 'passed'),
      step(1, 'failed'),
      step(1, 'passed'),
    ]);
    expect(collapsed.map((r) => r.index)).toEqual([0, 1]);
    expect(collapsed.map((r) => r.retries)).toEqual([2, 1]);
  });

  it('keeps a failed final attempt failed', () => {
    const collapsed = collapseStepResults([step(0, 'passed'), step(1, 'failed', { error: 'gone' })]);
    expect(collapsed[1]).toMatchObject({ index: 1, status: 'failed', error: 'gone' });
  });
});

describe('validateFinalOutcomes', () => {
  it('fails when no asserts were executed', () => {
    expect(validateFinalOutcomes([step(0, 'passed')])).toEqual({
      ok: false,
      reason: 'no assertions were executed',
    });
  });

  it('passes when every final outcome passed and an assert ran', () => {
    expect(validateFinalOutcomes([step(0, 'passed'), step(1, 'passed', { kind: 'assert' })])).toEqual({
      ok: true,
    });
  });

  it('accepts healed steps as passing outcomes', () => {
    expect(validateFinalOutcomes([step(0, 'healed'), step(1, 'passed', { kind: 'assert' })])).toEqual({
      ok: true,
    });
  });

  it('fails when a final assert outcome failed', () => {
    const validation = validateFinalOutcomes([step(0, 'failed', { kind: 'assert', error: 'not visible' })]);
    expect(validation.ok).toBe(false);
    expect(validation.reason).toContain('assert visible failed: not visible');
  });

  it('fails when a final act outcome failed even if asserts passed', () => {
    const validation = validateFinalOutcomes([
      step(0, 'failed', { error: 'detached' }),
      step(1, 'passed', { kind: 'assert' }),
    ]);
    expect(validation.ok).toBe(false);
    expect(validation.reason).toContain('act click failed: detached');
  });
});

describe('stripAnsi', () => {
  it('removes ANSI styling sequences', () => {
    const ESC = String.fromCharCode(27);
    expect(stripAnsi(`Timed out ${ESC}[2m5000ms${ESC}[22m for ${ESC}[31mlocator${ESC}[39m`)).toBe(
      'Timed out 5000ms for locator',
    );
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('plain [bracketed] text')).toBe('plain [bracketed] text');
  });
});
