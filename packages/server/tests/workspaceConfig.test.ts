import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { isAbsoluteHttpUrl, readWorkspaceBaseUrl, readWorkspaceHealPolicy } from '../src/workspaceConfig.js';
import { CONFIG_FILE_NAME } from '../src/scaffold.js';

async function workspaceWith(config?: string): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'cp-wsconfig-'));
  if (config !== undefined) {
    await writeFile(path.join(workspace, CONFIG_FILE_NAME), config, 'utf8');
  }
  return workspace;
}

describe('isAbsoluteHttpUrl', () => {
  it('accepts http and https URLs only', () => {
    expect(isAbsoluteHttpUrl('http://127.0.0.1:7701')).toBe(true);
    expect(isAbsoluteHttpUrl('https://staging.example.com/app')).toBe(true);
    expect(isAbsoluteHttpUrl('/p/x/cases')).toBe(false);
    expect(isAbsoluteHttpUrl('ftp://example.com')).toBe(false);
    expect(isAbsoluteHttpUrl('staging.example.com')).toBe(false);
  });
});

describe('readWorkspaceBaseUrl', () => {
  it('returns the configured baseUrl', async () => {
    const workspace = await workspaceWith('providers: []\nbaseUrl: https://staging.example.com\n');
    await expect(readWorkspaceBaseUrl(workspace)).resolves.toBe('https://staging.example.com');
  });

  it('returns undefined when the key or the config file is missing', async () => {
    await expect(readWorkspaceBaseUrl(await workspaceWith('providers: []\n'))).resolves.toBeUndefined();
    await expect(readWorkspaceBaseUrl(await workspaceWith())).resolves.toBeUndefined();
  });

  it('rejects a non-http(s) baseUrl with an actionable error', async () => {
    const workspace = await workspaceWith('providers: []\nbaseUrl: staging.example.com\n');
    await expect(readWorkspaceBaseUrl(workspace)).rejects.toThrow(/baseUrl.*absolute http\(s\) URL/);
  });

  it('does not disturb healPolicy reading', async () => {
    const workspace = await workspaceWith('providers: []\nbaseUrl: https://staging.example.com\nhealPolicy: auto\n');
    await expect(readWorkspaceHealPolicy(workspace)).resolves.toBe('auto');
    await expect(readWorkspaceBaseUrl(workspace)).resolves.toBe('https://staging.example.com');
  });
});
