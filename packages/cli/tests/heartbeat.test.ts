import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatHeartbeat, startHeartbeat, HEARTBEAT_INTERVAL_MS } from '../src/heartbeat.js';

describe('formatHeartbeat', () => {
  it('formats elapsed time in whole seconds', () => {
    expect(formatHeartbeat('record', 15_000)).toBe('[record] still working... 15s elapsed');
    expect(formatHeartbeat('run', 90_400)).toBe('[run] still working... 90s elapsed');
  });
});

describe('startHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits a line every interval until stopped', () => {
    const lines: string[] = [];
    const stop = startHeartbeat({ label: 'record', write: (l) => lines.push(l), intervalMs: 15_000 });

    vi.advanceTimersByTime(14_999);
    expect(lines).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(lines).toEqual(['[record] still working... 15s elapsed']);

    vi.advanceTimersByTime(15_000);
    expect(lines).toEqual([
      '[record] still working... 15s elapsed',
      '[record] still working... 30s elapsed',
    ]);

    stop();
    vi.advanceTimersByTime(60_000);
    expect(lines).toHaveLength(2);
  });

  it('is safe to stop more than once', () => {
    const stop = startHeartbeat({ label: 'run', write: () => {}, intervalMs: 15_000 });
    stop();
    expect(() => stop()).not.toThrow();
  });

  it('defaults to a 15s interval', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(15_000);
  });
});
