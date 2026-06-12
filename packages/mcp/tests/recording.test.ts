import { describe, expect, it } from 'vitest';
import type { ActStep, AssertStep } from '@casepilot/core';
import {
  assembleReplay,
  createRecordingState,
  finalStepResults,
  finalizeRecording,
  recordStepOutcome,
  type RecordingMeta,
} from '../src/recording.js';

const META: RecordingMeta = {
  caseName: 'login',
  url: 'https://example.test/login',
  providerUsed: 'agent',
  recordedAt: '2026-06-11T10:00:00.000Z',
};

const click = (selector: string): ActStep => ({ kind: 'act', action: 'click', selector });
const assertVisible = (selector: string): AssertStep => ({ kind: 'assert', assert: 'visible', selector });

describe('recordStepOutcome', () => {
  it('appends successful steps to both results and replay', () => {
    const state = createRecordingState();
    recordStepOutcome(state, click('#login'), { ok: true, durationMs: 12, offsetMs: 340 });
    expect(state.replaySteps).toHaveLength(1);
    expect(state.stepResults).toEqual([
      { index: 0, step: click('#login'), status: 'passed', error: undefined, durationMs: 12, offsetMs: 340 },
    ]);
  });

  it('defaults offsetMs to 0 when the caller does not provide it', () => {
    const state = createRecordingState();
    recordStepOutcome(state, click('#login'), { ok: true, durationMs: 12 });
    expect(state.stepResults[0]).toMatchObject({ offsetMs: 0 });
  });

  it('keeps failed steps out of the replay but tracks the result', () => {
    const state = createRecordingState();
    recordStepOutcome(state, click('#missing'), { ok: false, error: 'timeout', durationMs: 5000 });
    recordStepOutcome(state, click('#login'), { ok: true, durationMs: 10 });
    expect(state.replaySteps).toEqual([click('#login')]);
    expect(state.stepResults[0]).toMatchObject({ index: 0, status: 'failed', error: 'timeout' });
    expect(state.stepResults[1]).toMatchObject({ index: 0, status: 'passed' });
  });

  it('strips ANSI escape codes from stored errors', () => {
    const state = createRecordingState();
    const ESC = String.fromCharCode(27);
    const ansiError = `Timed out ${ESC}[2m5000ms${ESC}[22m waiting for ${ESC}[31mlocator${ESC}[39m`;
    recordStepOutcome(state, click('#missing'), { ok: false, error: ansiError, durationMs: 5000 });
    expect(state.stepResults[0]!.error).toBe('Timed out 5000ms waiting for locator');
  });
});

describe('finalStepResults', () => {
  it('keeps only the last attempt per index with a retry counter', () => {
    const state = createRecordingState();
    recordStepOutcome(state, assertVisible('[role="complementary"]:has-text("Casepilot")'), {
      ok: false,
      error: 'timeout',
      durationMs: 5000,
    });
    recordStepOutcome(state, assertVisible('aside:has-text("Casepilot")'), { ok: true, durationMs: 20 });
    const final = finalStepResults(state);
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({
      index: 0,
      status: 'passed',
      step: assertVisible('aside:has-text("Casepilot")'),
      retries: 1,
    });
  });

  it('produces unique step indices', () => {
    const state = createRecordingState();
    recordStepOutcome(state, click('#a'), { ok: false, error: 'nope', durationMs: 1 });
    recordStepOutcome(state, click('#a2'), { ok: true, durationMs: 1 });
    recordStepOutcome(state, assertVisible('#b'), { ok: false, error: 'nope', durationMs: 1 });
    recordStepOutcome(state, assertVisible('#b'), { ok: false, error: 'nope again', durationMs: 1 });
    recordStepOutcome(state, assertVisible('#b2'), { ok: true, durationMs: 1 });
    const final = finalStepResults(state);
    expect(final.map((r) => r.index)).toEqual([0, 1]);
    expect(final.map((r) => r.status)).toEqual(['passed', 'passed']);
    expect(final[1]).toMatchObject({ retries: 2 });
  });

  it('does not add a retries field to single-attempt steps', () => {
    const state = createRecordingState();
    recordStepOutcome(state, click('#login'), { ok: true, durationMs: 1 });
    expect(finalStepResults(state)[0]).not.toHaveProperty('retries');
  });
});

describe('finalizeRecording', () => {
  it('passes when the model reports passed and asserts hold', () => {
    const state = createRecordingState();
    recordStepOutcome(state, click('#login'), { ok: true, durationMs: 1 });
    recordStepOutcome(state, assertVisible('#dash'), { ok: true, durationMs: 1 });
    const final = finalizeRecording(state, { passed: true, explanation: 'all good' }, META);
    expect(final.verdict).toBe('passed');
    expect(final.explanation).toBe('all good');
    expect(final.replay.steps).toEqual([click('#login'), assertVisible('#dash')]);
  });

  it('passes when a failed exploratory attempt is superseded by a passing retry', () => {
    const state = createRecordingState();
    recordStepOutcome(state, click('#login'), { ok: true, durationMs: 1 });
    recordStepOutcome(state, assertVisible('[role="complementary"]:has-text("Casepilot")'), {
      ok: false,
      error: 'timeout 5000ms',
      durationMs: 5000,
    });
    recordStepOutcome(state, assertVisible('aside:has-text("Casepilot")'), { ok: true, durationMs: 15 });
    const final = finalizeRecording(state, { passed: true, explanation: 'sidebar verified' }, META);
    expect(final.verdict).toBe('passed');
    expect(final.explanation).toBe('sidebar verified');
    expect(final.steps.map((r) => r.index)).toEqual([0, 1]);
    expect(final.steps.every((r) => r.status === 'passed')).toBe(true);
    expect(final.replay.steps).toEqual([click('#login'), assertVisible('aside:has-text("Casepilot")')]);
  });

  it('overrides a model "passed" when no asserts were executed', () => {
    const state = createRecordingState();
    recordStepOutcome(state, click('#login'), { ok: true, durationMs: 1 });
    const final = finalizeRecording(state, { passed: true, explanation: 'trust me' }, META);
    expect(final.verdict).toBe('failed');
    expect(final.explanation).toContain('validation disagrees');
  });

  it('overrides a model "passed" when an assert ultimately failed', () => {
    const state = createRecordingState();
    recordStepOutcome(state, assertVisible('#dash'), { ok: false, error: 'not visible', durationMs: 1 });
    const final = finalizeRecording(state, { passed: true, explanation: 'looks fine' }, META);
    expect(final.verdict).toBe('failed');
    expect(final.explanation).toContain('not visible');
  });

  it('overrides a model "passed" when the final retry of a step also failed', () => {
    const state = createRecordingState();
    recordStepOutcome(state, assertVisible('#dash'), { ok: false, error: 'not visible', durationMs: 1 });
    recordStepOutcome(state, assertVisible('#dashboard'), { ok: false, error: 'still not visible', durationMs: 1 });
    const final = finalizeRecording(state, { passed: true, explanation: 'looks fine' }, META);
    expect(final.verdict).toBe('failed');
    expect(final.explanation).toContain('validation disagrees');
    expect(final.explanation).toContain('still not visible');
    expect(final.explanation).not.toContain('not visible;');
  });

  it('overrides a model "passed" when the final attempt of an act failed', () => {
    const state = createRecordingState();
    recordStepOutcome(state, assertVisible('#dash'), { ok: true, durationMs: 1 });
    recordStepOutcome(state, click('#submit'), { ok: false, error: 'detached', durationMs: 1 });
    const final = finalizeRecording(state, { passed: true, explanation: 'fine' }, META);
    expect(final.verdict).toBe('failed');
    expect(final.explanation).toContain('act click failed');
  });

  it('keeps a model "failed" verdict and explanation', () => {
    const state = createRecordingState();
    recordStepOutcome(state, assertVisible('#dash'), { ok: true, durationMs: 1 });
    const final = finalizeRecording(state, { passed: false, explanation: 'login was rejected' }, META);
    expect(final.verdict).toBe('failed');
    expect(final.explanation).toBe('login was rejected');
  });

  it('fails when no report was made', () => {
    const final = finalizeRecording(createRecordingState(), undefined, META);
    expect(final.verdict).toBe('failed');
    expect(final.explanation).toContain('without report_result');
  });
});

describe('assembleReplay', () => {
  it('builds a version 1 replay file with only the successful steps', () => {
    const state = createRecordingState();
    recordStepOutcome(state, click('#missing'), { ok: false, error: 'timeout', durationMs: 1 });
    recordStepOutcome(state, click('#login'), { ok: true, durationMs: 1 });
    recordStepOutcome(state, assertVisible('#dash'), { ok: true, durationMs: 1 });
    const replay = assembleReplay(state, META);
    expect(replay).toEqual({
      version: 1,
      case: 'login',
      url: 'https://example.test/login',
      providerUsed: 'agent',
      recordedAt: META.recordedAt,
      steps: [click('#login'), assertVisible('#dash')],
      meta: { healCount: 0 },
    });
  });
});
