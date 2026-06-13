import { describe, it, expect } from 'vitest';
import type { SuiteResult } from '@casepilot/core';
import { formatSuiteResult, suiteExitCode } from '../src/format.js';

function suite(overrides: Partial<SuiteResult>): SuiteResult {
  return {
    startedAt: 'a',
    finishedAt: 'b',
    total: 0,
    ran: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    cases: [],
    ...overrides,
  };
}

describe('suiteExitCode', () => {
  it('returns 0 when at least one case ran and none failed', () => {
    expect(suiteExitCode(suite({ total: 2, ran: 2, passed: 2, failed: 0 }))).toBe(0);
    expect(suiteExitCode(suite({ total: 3, ran: 1, passed: 1, failed: 0, skipped: 2 }))).toBe(0);
  });

  it('returns 1 when any case failed', () => {
    expect(suiteExitCode(suite({ total: 2, ran: 2, passed: 1, failed: 1 }))).toBe(1);
  });

  it('returns 1 when nothing ran', () => {
    expect(suiteExitCode(suite({ total: 1, ran: 0, passed: 0, failed: 0, skipped: 1 }))).toBe(1);
  });
});

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
