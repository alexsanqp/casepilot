# @casepilot/providers

Provider implementations for casepilot: chat providers (OpenAI-compatible, Anthropic) and agent providers (Claude Code CLI, Codex CLI), plus the config loader and registry.

## Configuration

Providers are declared in `casepilot.config.yaml`:

```yaml
defaultProvider: claude-code
providers:
  - id: lmstudio
    type: openai-compatible        # openai-compatible | anthropic | claude-code | codex
    baseUrl: http://localhost:1234/v1
    model: qwen3-coder-30b
    apiKey: ${LMSTUDIO_KEY}        # ${VAR} is interpolated from the environment
  - id: claude-code
    type: claude-code
```

`${VAR}` references fail fast with a clear error if the variable is unset. Load and use:

```ts
import { loadProvidersConfig, ProviderRegistry } from '@casepilot/providers';

const cfg = await loadProvidersConfig('casepilot.config.yaml');
const registry = ProviderRegistry.fromConfig(cfg);
const provider = registry.default(); // or registry.get('lmstudio')
```

## Adding a custom provider type

Implement `ChatProvider` or `AgentProvider` from `@casepilot/core` and register a factory before loading the config:

```ts
import type { ChatProvider } from '@casepilot/core';
import { registerProviderType, type ProviderEntry } from '@casepilot/providers';

registerProviderType('my-gateway', (entry: ProviderEntry): ChatProvider => ({
  kind: 'chat',
  id: entry.id,
  async generate({ messages, tools }) {
    // call your backend; return { text } and/or { toolCalls }
    return { text: 'hello' };
  },
}));
```

Then reference it from the config:

```yaml
providers:
  - id: gateway
    type: my-gateway
    baseUrl: https://internal.example.com   # extra fields pass through to your factory
```

Unknown `type` values raise an error listing all known types. Built-in types cannot be overridden.
