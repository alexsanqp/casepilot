import type { Provider } from '@casepilot/core';
import { createAnthropicProvider } from './anthropic.js';
import { createClaudeCodeProvider } from './claudeCode.js';
import { createCodexProvider } from './codex.js';
import type { ProviderEntry, ProvidersConfig } from './config.js';
import { createOpenAICompatibleProvider } from './openaiCompatible.js';

export type ProviderFactory = (entry: ProviderEntry) => Provider;

function required(entry: ProviderEntry, field: 'baseUrl' | 'model' | 'apiKey'): string {
  const value = entry[field];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Provider "${entry.id}" (type "${entry.type}") requires "${field}" in casepilot.config.yaml`);
  }
  return value;
}

const builtinFactories: ReadonlyMap<string, ProviderFactory> = new Map<string, ProviderFactory>([
  [
    'openai-compatible',
    (entry) =>
      createOpenAICompatibleProvider({
        id: entry.id,
        baseUrl: required(entry, 'baseUrl'),
        model: required(entry, 'model'),
        apiKey: entry.apiKey,
        temperature: entry.temperature,
        headers: entry.headers,
      }),
  ],
  [
    'anthropic',
    (entry) =>
      createAnthropicProvider({
        id: entry.id,
        apiKey: required(entry, 'apiKey'),
        model: required(entry, 'model'),
        baseUrl: entry.baseUrl,
        maxTokens: entry.maxTokens,
      }),
  ],
  [
    'claude-code',
    (entry) =>
      createClaudeCodeProvider({
        id: entry.id,
        command: entry.command,
        model: entry.model,
        extraArgs: entry.extraArgs,
        maxTurns: entry.maxTurns,
      }),
  ],
  [
    'codex',
    (entry) =>
      createCodexProvider({
        id: entry.id,
        command: entry.command,
        model: entry.model,
        extraArgs: entry.extraArgs,
      }),
  ],
]);

const customFactories = new Map<string, ProviderFactory>();

/** Third-party extension point: register a factory for a custom `type` value. */
export function registerProviderType(type: string, factory: ProviderFactory): void {
  if (builtinFactories.has(type)) {
    throw new Error(`Cannot override built-in provider type "${type}"`);
  }
  customFactories.set(type, factory);
}

export function knownProviderTypes(): string[] {
  return [...builtinFactories.keys(), ...customFactories.keys()];
}

export function createProvider(entry: ProviderEntry): Provider {
  const factory = customFactories.get(entry.type) ?? builtinFactories.get(entry.type);
  if (!factory) {
    throw new Error(
      `Unknown provider type "${entry.type}" for provider "${entry.id}". Known types: ${knownProviderTypes().join(
        ', ',
      )}. Custom types can be added with registerProviderType().`,
    );
  }
  return factory(entry);
}

export interface ProviderListing {
  id: string;
  kind: Provider['kind'];
  type: string;
}

export class ProviderRegistry {
  private constructor(
    private readonly providers: Map<string, { provider: Provider; type: string }>,
    private readonly defaultId: string,
  ) {}

  static fromConfig(cfg: ProvidersConfig): ProviderRegistry {
    const providers = new Map<string, { provider: Provider; type: string }>();
    for (const entry of cfg.providers) {
      if (providers.has(entry.id)) {
        throw new Error(`Duplicate provider id "${entry.id}" in config`);
      }
      providers.set(entry.id, { provider: createProvider(entry), type: entry.type });
    }
    const defaultId = cfg.defaultProvider ?? cfg.providers[0]?.id;
    if (!defaultId || !providers.has(defaultId)) {
      throw new Error(
        `defaultProvider "${String(defaultId)}" does not match any configured provider id (${[...providers.keys()].join(', ')})`,
      );
    }
    return new ProviderRegistry(providers, defaultId);
  }

  get(id: string): Provider {
    const found = this.providers.get(id);
    if (!found) {
      throw new Error(`Unknown provider "${id}". Configured providers: ${[...this.providers.keys()].join(', ')}`);
    }
    return found.provider;
  }

  list(): ProviderListing[] {
    return [...this.providers.entries()].map(([id, { provider, type }]) => ({ id, kind: provider.kind, type }));
  }

  default(): Provider {
    return this.get(this.defaultId);
  }
}
