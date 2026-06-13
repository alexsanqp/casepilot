import { describe, it, expect } from 'vitest';
import { aggregateSuite, suiteToJson } from '../src/engine/suiteReport.js';
import type { SuiteCaseResult } from '../src/types.js';
import { suiteToJUnitXml } from '../src/engine/suiteReport.js';

const cases: SuiteCaseResult[] = [
  { caseName: 'a', status: 'passed', verdict: 'passed', runId: 'r1', durationMs: 1000 },
  { caseName: 'b', status: 'failed', verdict: 'failed', runId: 'r2', durationMs: 2000, reason: 'Step 1 failed' },
  { caseName: 'c', status: 'skipped', durationMs: 0, reason: 'not recorded' },
];

describe('aggregateSuite', () => {
  it('counts passed/failed/skipped and ran', () => {
    const s = aggregateSuite(cases, '2026-06-13T00:00:00.000Z', '2026-06-13T00:00:03.000Z');
    expect(s).toMatchObject({ total: 3, ran: 2, passed: 1, failed: 1, skipped: 1 });
    expect(s.cases).toHaveLength(3);
  });
});

describe('suiteToJson', () => {
  it('serializes a suite result as pretty JSON', () => {
    const s = aggregateSuite(cases, '2026-06-13T00:00:00.000Z', '2026-06-13T00:00:03.000Z');
    expect(JSON.parse(suiteToJson(s))).toMatchObject({ passed: 1, failed: 1, skipped: 1 });
  });
});

describe('suiteToJUnitXml', () => {
  it('emits a testsuite with per-case testcases, failure, skipped, and escapes attrs', () => {
    const s = aggregateSuite(
      [
        { caseName: 'login', status: 'passed', verdict: 'passed', runId: 'r1', durationMs: 1500 },
        { caseName: 'a&b<"', status: 'failed', verdict: 'failed', runId: 'r2', durationMs: 500, reason: 'boom & <crash>' },
        { caseName: 'draft', status: 'skipped', durationMs: 0, reason: 'not recorded' },
      ],
      '2026-06-13T00:00:00.000Z',
      '2026-06-13T00:00:02.000Z',
    );
    const xml = suiteToJUnitXml(s);
    expect(xml).toContain('<testsuite name="casepilot" tests="3" failures="1" skipped="1"');
    expect(xml).toContain('name="a&amp;b&lt;&quot;"');
    expect(xml).toContain('<failure message="boom &amp; &lt;crash&gt;">');
    expect(xml).toContain('<skipped');
    expect(xml.startsWith('<?xml')).toBe(true);
  });
});
