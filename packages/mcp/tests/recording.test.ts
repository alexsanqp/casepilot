import { describe, expect, it } from 'vitest';
import type { ActStep, AssertStep } from '@casepilot/core';
import {
  assembleReplay,
  createRecordingState,
  finalizeRecording,
  recordStepOutcome,
  validateAsserts,
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
    recordStepOutcome(state, click('#login'), { ok: true, durationMs: 12 });
    expect(state.replaySteps).toHaveLength(1);
    expect(state.stepResults).toEqual([
      { index: 0, step: click('#login'), status: 'passed', error: undefined, durationMs: 12 },
    ]);
  });

  it('keeps failed steps out of the replay but tracks the result', () => {
    const state = createRecordingState();
    recordStepOutcome(state, click('#missing'), { ok: false, error: 'timeout', durationMs: 5000 });
    recordStepOutcome(state, click('#login'), { ok: true, durationMs: 10 });
    expect(state.replaySteps).toEqual([click('#login')]);
    expect(state.stepResults[0]).toMatchObject({ index: 0, status: 'failed', error: 'timeout' });
    expect(state.stepResults[1]).toMatchObject({ index: 0, status: 'passed' });
  });
});

describe('validateAsserts', () => {
  it('fails when no asserts were executed', () => {
    const state = createRecordingState();
    recordStepOutcome(state, click('#login'), { ok: true, durationMs: 1 });
    expect(validateAsserts(state.stepResults)).toEqual({ ok: false, reason: 'no assertions were executed' });
  });

  it('fails when the final attempt of a distinct assert failed', () => {
    const state = createRecordingState();
    recordStepOutcome(state, assertVisible('#dash'), { ok: false, error: 'not visible', durationMs: 1 });
    const validation = validateAsserts(state.stepResults);
    expect(validation.ok).toBe(false);
    expect(validation.reason).toContain('assert visible failed');
  });

  it('passes when a previously failed assert later succeeds', () => {
    const state = createRecordingState();
    recordStepOutcome(state, assertVisible('#dash'), { ok: false, error: 'not visible', durationMs: 1 });
    recordStepOutcome(state, assertVisible('#dash'), { ok: true, durationMs: 1 });
    expect(validateAsserts(state.stepResults)).toEqual({ ok: true });
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
