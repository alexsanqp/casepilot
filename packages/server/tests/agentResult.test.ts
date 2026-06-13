import { describe, expect, it } from 'vitest';
import type { RunResult } from '@casepilot/core';
import { parseAgentResult } from '../src/runner.js';

function validResultJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    case: 'login',
    caseName: 'login',
    mode: 'record',
    verdict: 'passed',
    explanation: 'all good',
    steps: [],
    artifacts: { screenshots: [] },
    startedAt: '2026-06-11T10:00:00.000Z',
    finishedAt: '2026-06-11T10:00:05.000Z',
    ...overrides,
  });
}

describe('parseAgentResult (Bug M2)', () => {
  it('accepts a well-formed result.json and returns it unchanged in shape', () => {
    const result = parseAgentResult(validResultJson());
    expect(result.verdict).toBe('passed');
    expect(result.artifacts.screenshots).toEqual([]);
    expect(result.caseName).toBe('login');
  });

  it('preserves optional artifact fields when present', () => {
    const result = parseAgentResult(
      validResultJson({ artifacts: { screenshots: ['a.png'], videoPath: 'video/page.webm' } }),
    );
    expect(result.artifacts.screenshots).toEqual(['a.png']);
    expect(result.artifacts.videoPath).toBe('video/page.webm');
  });

  it('throws a clear, actionable error on malformed JSON (no raw SyntaxError)', () => {
    let caught: unknown;
    try {
      parseAgentResult('{ this is not json');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/invalid result\.json/i);
    expect((caught as Error).message).not.toMatch(/^Unexpected token/);
  });

  it('throws a clear error (not a raw TypeError) when artifacts is missing', () => {
    const raw = JSON.stringify({
      case: 'login',
      caseName: 'login',
      mode: 'record',
      verdict: 'passed',
      explanation: 'all good',
      steps: [],
      startedAt: '2026-06-11T10:00:00.000Z',
      finishedAt: '2026-06-11T10:00:05.000Z',
    });
    let caught: unknown;
    try {
      parseAgentResult(raw);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as Error).message).toMatch(/invalid result\.json/i);
  });

  it('throws a clear error when verdict is not passed/failed', () => {
    const raw = validResultJson({ verdict: 'maybe' });
    expect(() => parseAgentResult(raw)).toThrow(/invalid result\.json/i);
  });

  it('rejects a non-string screenshots array', () => {
    const raw = validResultJson({ artifacts: { screenshots: [123] } });
    expect(() => parseAgentResult(raw)).toThrow(/invalid result\.json/i);
  });

  it('returns a typed RunResult assignable to the core type', () => {
    const result: RunResult = parseAgentResult(validResultJson());
    expect(result.mode).toBe('record');
  });
});
