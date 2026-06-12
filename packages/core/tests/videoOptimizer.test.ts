import { describe, expect, it } from 'vitest';
import { computeKeepSegments } from '../src/engine/videoOptimizer.js';
import type { StepResult } from '../src/types.js';

const step = (offsetMs: number, durationMs: number, index = 0): StepResult => ({
  index,
  step: { kind: 'act', action: 'click', selector: 'role=button[name="Go"]' },
  status: 'passed',
  durationMs,
  offsetMs,
});

describe('computeKeepSegments', () => {
  it('returns no segments for empty steps', () => {
    expect(computeKeepSegments([], 400)).toEqual([]);
  });

  it('pads a single step on both sides', () => {
    expect(computeKeepSegments([step(1000, 500)], 400)).toEqual([{ startMs: 600, endMs: 1900 }]);
  });

  it('clamps the padded start at 0', () => {
    expect(computeKeepSegments([step(100, 200)], 400)).toEqual([{ startMs: 0, endMs: 700 }]);
  });

  it('clamps the padded end at videoDurationMs', () => {
    expect(computeKeepSegments([step(1000, 500)], 400, 1200)).toEqual([{ startMs: 600, endMs: 1200 }]);
  });

  it('drops segments entirely past the video end', () => {
    expect(computeKeepSegments([step(5000, 100)], 400, 1200)).toEqual([]);
  });

  it('merges overlapping and adjacent segments', () => {
    const segments = computeKeepSegments([step(1000, 500), step(2000, 100), step(10000, 50)], 400);
    expect(segments).toEqual([
      { startMs: 600, endMs: 2500 },
      { startMs: 9600, endMs: 10450 },
    ]);
  });

  it('sorts out-of-order steps before merging', () => {
    const segments = computeKeepSegments([step(10000, 50), step(1000, 500)], 100);
    expect(segments).toEqual([
      { startMs: 900, endMs: 1600 },
      { startMs: 9900, endMs: 10150 },
    ]);
  });
});
