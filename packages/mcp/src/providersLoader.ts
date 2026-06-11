import path from 'node:path';
import type { Provider } from '@casepilot/core';

export interface ProviderSummary {
  id: string;
  kind: 'chat' | 'agent';
  type: string;
}

export interface ProviderRegistryLike {
  get(id: string): Provider;
  list(): ProviderSummary[];
  default(): Provider;
}

interface ProvidersModule {
  loadProvidersConfig(configPath: string): unknown;
  ProviderRegistry: {
    fromConfig(cfg: unknown): ProviderRegistryLike | Promise<ProviderRegistryLike>;
  };
}

export const CONFIG_FILE_NAME = 'casepilot.config.yaml';

export async function loadWorkspaceRegistry(workspace: string): Promise<ProviderRegistryLike> {
  const mod = (await import('@casepilot/providers')) as unknown as ProvidersModule;
  const cfg = await Promise.resolve(mod.loadProvidersConfig(path.join(workspace, CONFIG_FILE_NAME)));
  return Promise.resolve(mod.ProviderRegistry.fromConfig(cfg));
}
