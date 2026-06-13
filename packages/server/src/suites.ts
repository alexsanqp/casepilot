import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import type { SuiteResult } from '@casepilot/core';

export type SuiteStatus = 'running' | 'done' | 'error';

export interface SuiteEntry {
  suiteId: string;
  status: SuiteStatus;
  result?: SuiteResult;
  error?: string;
  startedAt: string;
}

export interface SuiteSummary {
  suiteId: string;
  status: SuiteStatus;
  startedAt: string;
  passed?: number;
  failed?: number;
  skipped?: number;
}

export class SuiteRegistry {
  private readonly suites = new Map<string, SuiteEntry>();

  static async open(suitesDirPath: string): Promise<SuiteRegistry> {
    const reg = new SuiteRegistry();
    let entries: string[] = [];
    try {
      entries = await readdir(suitesDirPath);
    } catch {
      return reg;
    }
    for (const name of entries) {
      try {
        const result = JSON.parse(
          await readFile(path.join(suitesDirPath, name, 'suite.json'), 'utf8'),
        ) as SuiteResult;
        reg.suites.set(name, { suiteId: name, status: 'done', result, startedAt: result.startedAt });
      } catch {
        /* not a finished suite dir */
      }
    }
    return reg;
  }

  create(suiteId: string): void {
    this.suites.set(suiteId, { suiteId, status: 'running', startedAt: new Date().toISOString() });
  }

  complete(suiteId: string, result: SuiteResult): void {
    const e = this.suites.get(suiteId);
    if (!e) return;
    e.status = 'done';
    e.result = result;
  }

  fail(suiteId: string, error: string): void {
    const e = this.suites.get(suiteId);
    if (!e) return;
    e.status = 'error';
    e.error = error;
  }

  get(suiteId: string): SuiteEntry | undefined {
    return this.suites.get(suiteId);
  }

  list(): SuiteSummary[] {
    return [...this.suites.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((e) => ({
        suiteId: e.suiteId,
        status: e.status,
        startedAt: e.startedAt,
        passed: e.result?.passed,
        failed: e.result?.failed,
        skipped: e.result?.skipped,
      }));
  }
}
