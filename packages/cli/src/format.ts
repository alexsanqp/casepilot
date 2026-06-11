import type { ReplayStep, RunResult, StepResult } from '@casepilot/core';
import type { RunSummary } from '@casepilot/server/runner';

const STATUS_MARKERS = { passed: '[PASS]', failed: '[FAIL]', healed: '[HEAL]' } as const;

export function describeStep(step: ReplayStep): string {
  const target = step.selector ? ` ${step.selector}` : '';
  return step.kind === 'act' ? `act:${step.action}${target}` : `assert:${step.assert}${target}`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string => cells.map((c, i) => pad(c, widths[i] ?? c.length)).join('  ').trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

export function formatStepTable(steps: StepResult[]): string {
  if (steps.length === 0) return '(no steps executed)';
  return formatTable(
    ['#', 'STATUS', 'STEP', 'MS', 'ERROR'],
    steps.map((s) => [
      String(s.index),
      STATUS_MARKERS[s.status],
      describeStep(s.step),
      String(s.durationMs),
      s.error ?? '',
    ]),
  );
}

export function formatRunResult(result: RunResult): string {
  const marker = result.verdict === 'passed' ? '[PASS]' : '[FAIL]';
  const lines = [
    `${marker} ${result.case} (${result.mode})`,
    '',
    formatStepTable(result.steps),
    '',
    `Explanation: ${result.explanation}`,
  ];
  const { artifacts } = result;
  if (artifacts.replayPath) lines.push(`Replay:     ${artifacts.replayPath}`);
  if (artifacts.videoPath) lines.push(`Video:      ${artifacts.videoPath}`);
  if (artifacts.transcriptPath) lines.push(`Transcript: ${artifacts.transcriptPath}`);
  for (const screenshot of artifacts.screenshots) lines.push(`Screenshot: ${screenshot}`);
  return lines.join('\n');
}

export function formatRunSummaries(runs: RunSummary[]): string {
  if (runs.length === 0) return '(no runs yet)';
  return formatTable(
    ['RUN ID', 'CASE', 'MODE', 'PROVIDER', 'STATUS', 'VERDICT', 'STARTED'],
    runs.map((r) => [r.runId, r.case, r.mode, r.provider, r.status, r.verdict ?? '-', r.startedAt]),
  );
}
