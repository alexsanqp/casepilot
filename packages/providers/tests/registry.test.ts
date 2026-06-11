import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Provider } from '@casepilot/core';
import { loadProvidersConfig } from '../src/config.js';
import { ProviderRegistry, createProvider, registerProviderType } from '../src/registry.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'casepilot-providers-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env['CASEPILOT_TEST_KEY'];
});

async function writeConfig(name: string, content: string): Promise<string> {
  const filePath = path.join(dir, name);
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

describe('loadProvidersConfig', () => {
  it('parses a valid casepilot.config.yaml', async () => {
    const filePath = await writeConfig(
      'valid.yaml',
      [
        'defaultProvider: claude-code',
        'providers:',
        '  - id: lmstudio',
        '    type: openai-compatible',
        '    baseUrl: http://localhost:1234/v1',
        '    model: qwen3-coder-30b',
        '  - id: claude-code',
        '    type: claude-code',
      ].join('\n'),
    );

    const cfg = await loadProvidersConfig(filePath);
    expect(cfg.defaultProvider).toBe('claude-code');
    expect(cfg.providers).toHaveLength(2);
    expect(cfg.providers[0]).toMatchObject({ id: 'lmstudio', type: 'openai-compatible', model: 'qwen3-coder-30b' });
  });

  it('interpolates ${VAR} from the environment', async () => {
    process.env['CASEPILOT_TEST_KEY'] = 'secret-123';
    const filePath = await writeConfig(
      'env.yaml',
      [
        'providers:',
        '  - id: lmstudio',
        '    type: openai-compatible',
        '    baseUrl: http://localhost:1234/v1',
        '    model: m',
        '    apiKey: ${CASEPILOT_TEST_KEY}',
      ].join('\n'),
    );

    const cfg = await loadProvidersConfig(filePath);
    expect(cfg.providers[0]?.apiKey).toBe('secret-123');
  });

  it('fails with a clear error when a referenced env var is missing', async () => {
    const filePath = await writeConfig(
      'env-missing.yaml',
      [
        'providers:',
        '  - id: lmstudio',
        '    type: openai-compatible',
        '    baseUrl: http://localhost:1234/v1',
        '    model: m',
        '    apiKey: ${CASEPILOT_TEST_KEY}',
      ].join('\n'),
    );

    await expect(loadProvidersConfig(filePath)).rejects.toThrow(/CASEPILOT_TEST_KEY.*is not set/s);
  });

  it('rejects invalid configs with field paths', async () => {
    const filePath = await writeConfig('invalid.yaml', 'providers:\n  - type: codex\n');
    await expect(loadProvidersConfig(filePath)).rejects.toThrow(/providers\.0\.id/);
  });
});

describe('createProvider / registerProviderType', () => {
  it('creates built-in providers with the right kind', () => {
    const chat = createProvider({
      id: 'lmstudio',
      type: 'openai-compatible',
      baseUrl: 'http://localhost:1234/v1',
      model: 'm',
    });
    expect(chat.kind).toBe('chat');

    const agent = createProvider({ id: 'cc', type: 'claude-code' });
    expect(agent.kind).toBe('agent');
  });

  it('rejects unknown types listing known types', () => {
    expect(() => createProvider({ id: 'x', type: 'mystery' })).toThrow(
      /Unknown provider type "mystery".*openai-compatible.*anthropic.*claude-code.*codex.*registerProviderType/s,
    );
  });

  it('supports custom provider types via registerProviderType', () => {
    const custom: Provider = {
      kind: 'chat',
      id: 'custom-1',
      generate: async () => ({ text: 'hi' }),
    };
    registerProviderType('my-custom', (entry) => ({ ...custom, id: entry.id }));

    const provider = createProvider({ id: 'mine', type: 'my-custom' });
    expect(provider.kind).toBe('chat');
    expect(provider.id).toBe('mine');
  });
});

describe('ProviderRegistry', () => {
  const cfg = {
    defaultProvider: 'cc',
    providers: [
      { id: 'lmstudio', type: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', model: 'm' },
      { id: 'cc', type: 'claude-code' },
    ],
  };

  it('builds from config, lists, gets, and resolves the default', () => {
    const registry = ProviderRegistry.fromConfig(cfg);
    expect(registry.list()).toEqual([
      { id: 'lmstudio', kind: 'chat', type: 'openai-compatible' },
      { id: 'cc', kind: 'agent', type: 'claude-code' },
    ]);
    expect(registry.get('lmstudio').kind).toBe('chat');
    expect(registry.default().id).toBe('cc');
  });

  it('rejects unknown provider ids with the configured list', () => {
    const registry = ProviderRegistry.fromConfig(cfg);
    expect(() => registry.get('nope')).toThrow(/Unknown provider "nope".*lmstudio, cc/s);
  });

  it('rejects a defaultProvider that matches no entry', () => {
    expect(() => ProviderRegistry.fromConfig({ ...cfg, defaultProvider: 'ghost' })).toThrow(/ghost/);
  });
});
