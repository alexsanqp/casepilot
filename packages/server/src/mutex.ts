/**
 * A minimal async keyed mutex. Calls to {@link KeyedMutex.run} that share a
 * `key` are serialized: each waits for the previously queued task on that key
 * to settle before running. Tasks on different keys run concurrently.
 *
 * Used to make workspace-scoped read-modify-write sequences (heals.json and
 * <case>.replay.json) race-free within a single process, where the key is the
 * absolute workspace path.
 */
export class KeyedMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  /** Number of keys with an in-flight or queued tail. Primarily for tests. */
  get size(): number {
    return this.chains.size;
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Wait for the prior tail (if any). We swallow its outcome so a rejection
    // upstream never poisons our own task — we only need ordering.
    const prior = this.chains.get(key) ?? Promise.resolve();
    const result = prior.then(fn, fn);

    // The new tail is the settle of `result`; mapping to a resolved promise
    // ensures the next task chains on completion regardless of success/failure.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);

    // Remove the entry once it drains, but only if we are still the tail
    // (another task may have queued after us). Prevents unbounded growth.
    tail.then(() => {
      if (this.chains.get(key) === tail) {
        this.chains.delete(key);
      }
    });

    return result;
  }
}

/**
 * Process-wide singleton shared by heals.ts and healApproval.ts so that an
 * addHeal, an approveHeal, and a rejectHeal in the same workspace cannot
 * interleave their load -> mutate -> save critical sections.
 */
export const workspaceMutex = new KeyedMutex();
