import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';

// localStorage is only captured by Playwright storageState for http(s) origins,
// not file:// — so the auth fixture is served over HTTP (mirrors the relative-url
// portability test in integration.test.ts).
let baseDir: string;
let server: Server;
let fixtureUrl: string;

const dirFor = (name: string) => path.join(baseDir, name);

beforeAll(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'casepilot-auth-'));
  const html = await readFile(new URL('./fixtures/app.html', import.meta.url), 'utf8');
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  fixtureUrl = `http://127.0.0.1:${port}/app`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await rm(baseDir, { recursive: true, force: true });
});

describe('BrowserSession storageState (auth)', () => {
  it('launches with no storageStatePath (regression)', async () => {
    const session = await BrowserSession.launch({ artifactsDir: dirFor('plain') });
    try {
      await session.goto(fixtureUrl);
      expect(session.page.viewportSize()).toEqual({ width: 1920, height: 1080 });
    } finally {
      await session.close();
    }
  });

  it('saveStorageState writes a parseable {cookies, origins} file reflecting localStorage', async () => {
    const statePath = path.join(dirFor('save'), 'main.json');
    const session = await BrowserSession.launch({ artifactsDir: dirFor('save') });
    try {
      await session.goto(fixtureUrl);
      await session.page.evaluate(() => localStorage.setItem('cp-token', 'secret-123'));
      await session.saveStorageState(statePath);
    } finally {
      await session.close();
    }

    expect(existsSync(statePath)).toBe(true);
    const parsed = JSON.parse(await readFile(statePath, 'utf8')) as {
      cookies: unknown[];
      origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
    };
    expect(Array.isArray(parsed.cookies)).toBe(true);
    expect(Array.isArray(parsed.origins)).toBe(true);
    const entry = parsed.origins.flatMap((o) => o.localStorage).find((e) => e.name === 'cp-token');
    expect(entry?.value).toBe('secret-123');
  });

  it('launching with a saved storageStatePath loads it (no throw) and restores localStorage', async () => {
    const statePath = path.join(dirFor('roundtrip'), 'main.json');
    const writer = await BrowserSession.launch({ artifactsDir: dirFor('roundtrip') });
    try {
      await writer.goto(fixtureUrl);
      await writer.page.evaluate(() => localStorage.setItem('cp-token', 'restored-value'));
      await writer.saveStorageState(statePath);
    } finally {
      await writer.close();
    }

    const loader = await BrowserSession.launch({ artifactsDir: dirFor('roundtrip-load'), storageStatePath: statePath });
    try {
      await loader.goto(fixtureUrl);
      const token = await loader.page.evaluate(() => localStorage.getItem('cp-token'));
      expect(token).toBe('restored-value');
    } finally {
      await loader.close();
    }
  });

  it('launching with a missing storageStatePath throws "auth profile file not found"', async () => {
    const missing = path.join(dirFor('missing'), 'does-not-exist.json');
    await expect(
      BrowserSession.launch({ artifactsDir: dirFor('missing'), storageStatePath: missing }),
    ).rejects.toThrow(/auth profile file not found/);
  });
});
