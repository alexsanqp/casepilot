import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RunResult } from '@casepilot/core';
import { runSuite, writeSuiteReports } from '../src/suiteRunner.js';

async function workspaceWith(cases: { name: string; recorded: boolean }[]): Promise<string> {
  const ws = await mkdtemp(path.join(tmpdir(), 'cp-suite-'));
  await mkdir(path.join(ws, 'cases'), { recursive: true });
  for (const c of cases) {
    await writeFile(
      path.join(ws, 'cases', `${c.name}.case.yaml`),
      `name: ${c.name}\nurl: /x\nsteps:\n  - go\nexpect:\n  - ok\n`,
    );
    if (c.recorded) {
      await writeFile(
        path.join(ws, 'cases', `${c.name}.replay.json`),
        JSON.stringify({
          version: 1,
          case: c.name,
          url: '/x',
          providerUsed: 't',
          recordedAt: 'now',
          steps: [],
          meta: { healCount: 0 },
        }),
      );
    }
  }
  return ws;
}

function fakeRun(verdictByCase: Record<string, 'passed' | 'failed'>) {
  return vi.fn(
    async (req: { caseName: string }): Promise<RunResult> => ({
      case: req.caseName,
      caseName: req.caseName,
      mode: 'replay',
      verdict: verdictByCase[req.caseName] ?? 'passed',
      explanation: 'x',
      steps: [],
      artifacts: { screenshots: [] },
      startedAt: 'a',
      finishedAt: 'b',
    }),
  );
}

describe('runSuite', () => {
  it('runs all recorded cases, skips un-recorded with a reason, aggregates the verdict', async () => {
    const ws = await workspaceWith([
      { name: 'a', recorded: true },
      { name: 'b', recorded: true },
      { name: 'c', recorded: false },
    ]);
    const executeRun = fakeRun({ a: 'passed', b: 'failed' });
    const suite = await runSuite({ workspace: ws }, { executeRun });
    expect(executeRun).toHaveBeenCalledTimes(2);
    expect(suite).toMatchObject({ total: 3, ran: 2, passed: 1, failed: 1, skipped: 1 });
    expect(suite.cases.find((x) => x.caseName === 'c')).toMatchObject({ status: 'skipped', reason: 'not recorded' });
  });

  it('isolates an infra throw as a failed case and keeps going', async () => {
    const ws = await workspaceWith([
      { name: 'a', recorded: true },
      { name: 'b', recorded: true },
    ]);
    const executeRun = vi.fn(async (req: { caseName: string }) => {
      if (req.caseName === 'a') throw new Error('browser crashed');
      return fakeRun({ b: 'passed' })(req);
    });
    const suite = await runSuite({ workspace: ws }, { executeRun: executeRun as never });
    expect(suite).toMatchObject({ ran: 2, failed: 1, passed: 1 });
    expect(suite.cases.find((x) => x.caseName === 'a')).toMatchObject({ status: 'failed', reason: 'browser crashed' });
  });

  it('fires onCaseStart/onCaseSettled with the run id', async () => {
    const ws = await workspaceWith([{ name: 'a', recorded: true }]);
    const started: string[] = [];
    const settled: string[] = [];
    await runSuite(
      { workspace: ws, onCaseStart: (id) => started.push(id), onCaseSettled: (id) => settled.push(id) },
      { executeRun: fakeRun({ a: 'passed' }) },
    );
    expect(started).toHaveLength(1);
    expect(settled).toEqual(started);
  });
});

describe('writeSuiteReports', () => {
  it('writes suite.json and junit.xml into the suite dir', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cp-rep-'));
    const suite = {
      startedAt: 'a',
      finishedAt: 'b',
      total: 1,
      ran: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      cases: [{ caseName: 'a', status: 'passed' as const, verdict: 'passed' as const, runId: 'r', durationMs: 1 }],
    };
    await writeSuiteReports(dir, suite, {});
    expect(JSON.parse(await readFile(path.join(dir, 'suite.json'), 'utf8'))).toMatchObject({ passed: 1 });
    expect(await readFile(path.join(dir, 'junit.xml'), 'utf8')).toContain('<testsuite');
  });
});
