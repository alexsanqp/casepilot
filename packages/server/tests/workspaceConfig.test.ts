import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  isAbsoluteHttpUrl,
  readWorkspaceAuthRefresh,
  readWorkspaceBaseUrl,
  readWorkspaceDefaultAuth,
  readWorkspaceHealPolicy,
  readWorkspaceVideoConfig,
} from '../src/workspaceConfig.js';
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

describe('readWorkspaceVideoConfig', () => {
  it('defaults both video and optimizeVideo to true when the keys or the file are missing', async () => {
    await expect(readWorkspaceVideoConfig(await workspaceWith('providers: []\n'))).resolves.toEqual({
      video: true,
      optimizeVideo: true,
    });
    await expect(readWorkspaceVideoConfig(await workspaceWith())).resolves.toEqual({
      video: true,
      optimizeVideo: true,
    });
  });

  it('reads explicit booleans, including false', async () => {
    const workspace = await workspaceWith('providers: []\nvideo: false\noptimizeVideo: false\n');
    await expect(readWorkspaceVideoConfig(workspace)).resolves.toEqual({ video: false, optimizeVideo: false });
  });

  it('defaults each key independently', async () => {
    const workspace = await workspaceWith('providers: []\nvideo: false\n');
    await expect(readWorkspaceVideoConfig(workspace)).resolves.toEqual({ video: false, optimizeVideo: true });
  });

  it('rejects non-boolean values with an actionable error', async () => {
    const workspace = await workspaceWith('providers: []\nvideo: yes please\n');
    await expect(readWorkspaceVideoConfig(workspace)).rejects.toThrow(/video.*boolean/);
  });
});

describe('readWorkspaceDefaultAuth', () => {
  it('returns the configured defaultAuth profile', async () => {
    const workspace = await workspaceWith('providers: []\ndefaultAuth: main\n');
    await expect(readWorkspaceDefaultAuth(workspace)).resolves.toBe('main');
  });

  it('returns undefined when the key or the config file is missing', async () => {
    await expect(readWorkspaceDefaultAuth(await workspaceWith('providers: []\n'))).resolves.toBeUndefined();
    await expect(readWorkspaceDefaultAuth(await workspaceWith())).resolves.toBeUndefined();
  });

  it('rejects a non-string defaultAuth with an actionable error', async () => {
    const workspace = await workspaceWith('providers: []\ndefaultAuth: 123\n');
    await expect(readWorkspaceDefaultAuth(workspace)).rejects.toThrow(/defaultAuth.*string/);
  });

  it('does not disturb other reads', async () => {
    const workspace = await workspaceWith('providers: []\ndefaultAuth: main\nhealPolicy: auto\n');
    await expect(readWorkspaceHealPolicy(workspace)).resolves.toBe('auto');
    await expect(readWorkspaceDefaultAuth(workspace)).resolves.toBe('main');
  });
});

describe('readWorkspaceAuthRefresh', () => {
  it('defaults to manual when the key or the config file is missing', async () => {
    await expect(readWorkspaceAuthRefresh(await workspaceWith('providers: []\n'))).resolves.toBe('manual');
    await expect(readWorkspaceAuthRefresh(await workspaceWith())).resolves.toBe('manual');
  });

  it('reads an explicit auto value', async () => {
    const workspace = await workspaceWith('providers: []\nauthRefresh: auto\n');
    await expect(readWorkspaceAuthRefresh(workspace)).resolves.toBe('auto');
  });

  it('reads an explicit manual value', async () => {
    const workspace = await workspaceWith('providers: []\nauthRefresh: manual\n');
    await expect(readWorkspaceAuthRefresh(workspace)).resolves.toBe('manual');
  });

  it('rejects an unknown authRefresh value with an actionable error', async () => {
    const workspace = await workspaceWith('providers: []\nauthRefresh: sometimes\n');
    await expect(readWorkspaceAuthRefresh(workspace)).rejects.toThrow(/authRefresh.*manual.*auto/);
  });
});
