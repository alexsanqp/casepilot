import type { SuiteCaseResult, SuiteResult } from '../types.js';

export function aggregateSuite(
  cases: SuiteCaseResult[],
  startedAt: string,
  finishedAt: string,
): SuiteResult {
  return {
    startedAt,
    finishedAt,
    total: cases.length,
    ran: cases.filter((c) => c.status !== 'skipped').length,
    passed: cases.filter((c) => c.status === 'passed').length,
    failed: cases.filter((c) => c.status === 'failed').length,
    skipped: cases.filter((c) => c.status === 'skipped').length,
    cases,
  };
}

export function suiteToJson(suite: SuiteResult): string {
  return JSON.stringify(suite, null, 2);
}

const XML_ESCAPES: Record<string, string> = {
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
};
function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (ch) => XML_ESCAPES[ch]!);
}
const seconds = (ms: number): string => (ms / 1000).toFixed(3);

export function suiteToJUnitXml(suite: SuiteResult): string {
  const totalTime = seconds(suite.cases.reduce((sum, c) => sum + c.durationMs, 0));
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  lines.push(
    `<testsuite name="casepilot" tests="${suite.total}" failures="${suite.failed}" skipped="${suite.skipped}" time="${totalTime}">`,
  );
  for (const c of suite.cases) {
    const open = `  <testcase name="${escapeXml(c.caseName)}" classname="casepilot" time="${seconds(c.durationMs)}">`;
    if (c.status === 'failed') {
      lines.push(open, `    <failure message="${escapeXml(c.reason ?? 'verdict: failed')}"></failure>`, '  </testcase>');
    } else if (c.status === 'skipped') {
      lines.push(open, `    <skipped message="${escapeXml(c.reason ?? 'skipped')}"></skipped>`, '  </testcase>');
    } else {
      lines.push(`${open}</testcase>`);
    }
  }
  lines.push('</testsuite>');
  return `${lines.join('\n')}\n`;
}
