import { describe, it, expect } from 'vitest';
import { formatSuiteResult } from '../src/format.js';

describe('formatSuiteResult', () => {
  it('renders counts and per-case status', () => {
    const out = formatSuiteResult({
      startedAt: 'a', finishedAt: 'b', total: 3, ran: 2, passed: 1, failed: 1, skipped: 1,
      cases: [
        { caseName: 'a', status: 'passed', verdict: 'passed', runId: 'r1', durationMs: 1200 },
        { caseName: 'b', status: 'failed', verdict: 'failed', runId: 'r2', durationMs: 800, reason: 'boom' },
        { caseName: 'c', status: 'skipped', durationMs: 0, reason: 'not recorded' },
      ],
    });
    expect(out).toContain('PASS  a');
    expect(out).toContain('FAIL  b');
    expect(out).toContain('SKIP  c');
    expect(out).toMatch(/1 passed.*1 failed.*1 skipped/s);
  });
});
