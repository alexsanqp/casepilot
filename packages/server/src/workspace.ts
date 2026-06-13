import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { loadCaseFile } from '@casepilot/core';

const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeName(name: string): boolean {
  return SAFE_NAME_RE.test(name);
}

export function assertCaseName(name: string): void {
  if (!isSafeName(name)) {
    throw new Error(`Invalid case name "${name}"; use letters, digits, dot, dash, underscore`);
  }
}

export function casesDir(workspace: string): string {
  return path.join(workspace, 'cases');
}

export function caseFilePath(workspace: string, name: string): string {
  return path.join(casesDir(workspace), `${name}.case.yaml`);
}

export function caseReplayPath(workspace: string, name: string): string {
  return path.join(casesDir(workspace), `${name}.replay.json`);
}

export function runsDir(workspace: string): string {
  return path.join(workspace, 'runs');
}

export function runDirPath(workspace: string, runId: string): string {
  return path.join(runsDir(workspace), runId);
}

export function newRunId(): string {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `${ts}-${randomBytes(3).toString('hex')}`;
}

export function authDir(workspace: string): string {
  return path.join(workspace, 'auth');
}

/**
 * Path to an auth profile's storageState file. Validates the profile name via
 * isSafeName so a crafted name (e.g. "../secrets") can never escape `auth/`.
 */
export function authProfilePath(workspace: string, profile: string): string {
  if (!isSafeName(profile)) {
    throw new Error(`invalid auth profile name "${profile}"`);
  }
  return path.join(authDir(workspace), `${profile}.json`);
}

export function suitesDir(workspace: string): string {
  return path.join(workspace, 'suites');
}

export function suiteDirPath(workspace: string, suiteId: string): string {
  return path.join(suitesDir(workspace), suiteId);
}

export function newSuiteId(): string {
  return `suite-${newRunId()}`;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export interface CaseSummary {
  name: string;
  url: string;
  hasReplay: boolean;
  file: string;
}

export async function listCases(workspace: string): Promise<CaseSummary[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(casesDir(workspace));
  } catch {
    return [];
  }
  const cases: CaseSummary[] = [];
  for (const entry of entries.filter((e) => e.endsWith('.case.yaml')).sort()) {
    const name = entry.slice(0, -'.case.yaml'.length);
    const file = path.join(casesDir(workspace), entry);
    let url = '(unparsable case file)';
    try {
      url = (await loadCaseFile(file)).url;
    } catch {
      // keep placeholder url so broken files still show up in listings
    }
    cases.push({ name, url, hasReplay: await fileExists(caseReplayPath(workspace, name)), file });
  }
  return cases;
}
