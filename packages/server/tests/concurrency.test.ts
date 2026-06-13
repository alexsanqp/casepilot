import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../src/concurrency.js';

describe('mapWithConcurrency', () => {
  it('preserves input order in the output regardless of completion order', async () => {
    const out = await mapWithConcurrency([30, 10, 20], 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2]);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency([1, 1, 1, 1, 1], 2, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it.each([NaN, 0, -3, 1.5])('runs every item with a non-finite or invalid limit (%s)', async (limit) => {
    const calls: number[] = [];
    const out = await mapWithConcurrency([10, 20, 30], limit, async (value, i) => {
      calls.push(i);
      return value;
    });
    expect(calls.sort()).toEqual([0, 1, 2]);
    expect(out).toHaveLength(3);
    expect(out).toEqual([10, 20, 30]);
    expect(out.some((entry) => entry === undefined)).toBe(false);
  });
});
