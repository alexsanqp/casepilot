import { describe, expect, it } from 'vitest';
import { KeyedMutex } from '../src/mutex.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('KeyedMutex', () => {
  it('serializes tasks that share a key (no interleaving)', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];

    const task = (label: string) =>
      mutex.run('same', async () => {
        events.push(`${label}:start`);
        await delay(20);
        events.push(`${label}:end`);
      });

    await Promise.all([task('A'), task('B')]);

    // A fully runs before B (or vice versa); starts/ends never interleave.
    expect(events).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
  });

  it('runs tasks on different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];

    const task = (key: string, label: string) =>
      mutex.run(key, async () => {
        events.push(`${label}:start`);
        await delay(20);
        events.push(`${label}:end`);
      });

    await Promise.all([task('k1', 'A'), task('k2', 'B')]);

    // Different keys overlap: both start before either ends.
    expect(events.indexOf('A:start')).toBeLessThan(events.indexOf('A:end'));
    expect(events.indexOf('B:start')).toBeLessThan(events.indexOf('B:end'));
    expect(events.slice(0, 2).sort()).toEqual(['A:start', 'B:start']);
  });

  it('returns the value produced by fn', async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run('k', async () => 42)).resolves.toBe(42);
  });

  it('propagates rejection and keeps the chain usable afterward', async () => {
    const mutex = new KeyedMutex();
    await expect(
      mutex.run('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // A failed task must not poison the chain for the same key.
    await expect(mutex.run('k', async () => 'ok')).resolves.toBe('ok');
  });

  it('preserves submission order under contention', async () => {
    const mutex = new KeyedMutex();
    const order: number[] = [];
    const tasks = [0, 1, 2, 3, 4].map((n) =>
      mutex.run('q', async () => {
        await delay(5 * (5 - n));
        order.push(n);
      }),
    );
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('does not leak chain entries once a key drains', async () => {
    const mutex = new KeyedMutex();
    await mutex.run('k', async () => undefined);
    // Allow the settle handler to remove the tail.
    await delay(0);
    expect(mutex.size).toBe(0);
  });
});
