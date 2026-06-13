import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatProvider, Provider } from '@casepilot/core';
import { createServer } from '../src/server.js';
import type { RunEngine } from '../src/runner.js';
import type { ProviderRegistryLike } from '../src/providersLoader.js';

const CASE_YAML = `name: login
url: https://example.test/login
steps:
  - Click the Login button
expect:
  - The dashboard heading is visible
`;

const chatProvider: ChatProvider = {
  kind: 'chat',
  id: 'fake-chat',
  generate: async () => ({ text: '' }),
};

function makeRegistry(providers: Provider[], defaultId: string): ProviderRegistryLike {
  return {
    get(id) {
      const provider = providers.find((p) => p.id === id);
      if (!provider) throw new Error(`unknown provider "${id}"`);
      return provider;
    },
    list() {
      return providers.map((p) => ({ id: p.id, kind: p.kind, type: 'fake' }));
    },
    default() {
      return this.get(defaultId);
    },
  };
}

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function setup(): Promise<{ app: FastifyInstance }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'cp-sec-'));
  await mkdir(path.join(workspace, 'cases'), { recursive: true });
  await writeFile(path.join(workspace, 'casepilot.config.yaml'), 'providers: []\n', 'utf8');
  await writeFile(path.join(workspace, 'cases', 'login.case.yaml'), CASE_YAML, 'utf8');
  const registryPath = path.join(await mkdtemp(path.join(os.tmpdir(), 'cp-reg-')), 'projects.json');
  const app = await createServer({
    workspace,
    registryPath,
    deps: {
      engine: { recordCase: vi.fn(), replayCase: vi.fn() } as unknown as RunEngine,
      loadRegistry: async () => makeRegistry([chatProvider], 'fake-chat'),
      resolveMcpBin: () => 'C:/fake/mcp/dist/bin.js',
    },
  });
  openApps.push(app);
  return { app };
}

describe('CORS loopback-only reflection (Bug C2)', () => {
  it('does NOT reflect a non-loopback origin on an API route', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/fs/dirs',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('reflects the dashboard loopback origin (localhost:7701)', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://localhost:7701' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:7701');
  });

  it('reflects 127.0.0.1 and [::1] loopback origins on any port', async () => {
    const { app } = await setup();
    const v4 = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://127.0.0.1:5173' },
    });
    expect(v4.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');

    const v6 = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://[::1]:8080' },
    });
    expect(v6.headers['access-control-allow-origin']).toBe('http://[::1]:8080');
  });

  it('blocks a cross-origin preflight (OPTIONS) from a non-loopback origin', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/runs',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });

  it('still serves the request with no Origin header (same-origin / curl)', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });
});
