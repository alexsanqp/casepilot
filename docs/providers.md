# Providers

Providers are configured in `casepilot.config.yaml` at the workspace root.

## Config schema

```yaml
defaultProvider: <id>     # optional; defaults to the first provider
providers:                # at least one entry
  - id: <unique id>       # referenced by --provider and the REST API
    type: <provider type> # openai-compatible | anthropic | claude-code | codex | custom
    # type-specific fields below
```

Per-entry fields (all optional unless a type requires them): `baseUrl`, `model`, `apiKey`, `temperature`, `maxTokens`, `command`, `extraArgs`, `maxTurns`, `headers`. Unknown extra keys are allowed and passed through to custom factories.

`${VAR}` anywhere in a string value is interpolated from the environment; a missing variable is a hard error naming the key.

There are two provider kinds:

- **chat** (`openai-compatible`, `anthropic`): a tool-calling chat API. The casepilot recorder runs the agent loop itself. Chat providers also power replay healing.
- **agent** (`claude-code`, `codex`): an agentic CLI spawned as a subprocess. It runs its own loop and reaches the browser through the `casepilot-mcp browser-tools` stdio bridge. Agent providers cannot heal replays.

## openai-compatible (chat)

Works with any `/v1/chat/completions` endpoint. Requires `baseUrl` and `model`; `apiKey`, `temperature` (default 0), and extra `headers` are optional. It also tolerates local models that emit tool calls as fenced JSON instead of the wire protocol.

OpenAI:

```yaml
providers:
  - id: openai
    type: openai-compatible
    baseUrl: https://api.openai.com/v1
    model: gpt-4o-mini
    apiKey: ${OPENAI_API_KEY}
```

LM Studio (local):

```yaml
  - id: lmstudio
    type: openai-compatible
    baseUrl: http://127.0.0.1:1234/v1
    model: qwen2.5-coder-32b-instruct
```

Ollama (local):

```yaml
  - id: ollama
    type: openai-compatible
    baseUrl: http://127.0.0.1:11434/v1
    model: qwen2.5-coder:32b
```

OpenRouter:

```yaml
  - id: openrouter
    type: openai-compatible
    baseUrl: https://openrouter.ai/api/v1
    model: anthropic/claude-3.5-sonnet
    apiKey: ${OPENROUTER_API_KEY}
```

## anthropic (chat)

Direct Anthropic Messages API. Requires `apiKey` and `model`; optional `baseUrl` (default `https://api.anthropic.com`) and `maxTokens` (default 4096).

```yaml
  - id: anthropic
    type: anthropic
    model: claude-sonnet-4-5
    apiKey: ${ANTHROPIC_API_KEY}
```

## claude-code (agent)

Spawns the `claude` CLI in headless print mode (`-p`). Options: `command` (default `claude`), `model`, `extraArgs` (prepended to the CLI args), `maxTurns` (default 100; every tool call costs a turn, so real login flows need a generous budget).

```yaml
  - id: claude-code
    type: claude-code
    maxTurns: 150          # optional
    # model: claude-sonnet-4-5   # optional
```

casepilot isolates the headless session from your personal Claude Code setup. The injected flags:

- `--mcp-config <tempfile>` + `--strict-mcp-config` - only the casepilot browser-tools MCP server is loaded; your user-level MCP servers stay out.
- `--settings {"disableAllHooks":true}` - your hooks cannot run inside (or fail) the recording session.
- `--allowedTools mcp__casepilot__*` - the agent may only use the browser tools.
- `MCP_TIMEOUT=120000`, `MCP_TOOL_TIMEOUT=300000` env vars - tolerate slow first page loads behind the bridge.

## codex (agent)

Spawns the `codex` CLI via `codex exec`. Options: `command` (default `codex`), `model`, `extraArgs`.

```yaml
  - id: codex
    type: codex
    # model: gpt-5-codex   # optional
```

Injected behavior:

- the prompt is passed over stdin (`exec -`), because the Windows npm `.cmd` shim cannot carry newlines in argv;
- `--ignore-user-config` - isolates from `~/.codex/config.toml`, whose user-level MCP gateways with stale auth would otherwise abort the session at startup (`auth.json` is still used for login);
- `--json --skip-git-repo-check`, plus `-c mcp_servers.casepilot.command/args=...` pointing at the browser-tools bridge.

## Adding a custom provider

Register a factory for a new `type` value before the registry is built:

```ts
import { registerProviderType } from '@casepilot/providers';
import type { ChatProvider } from '@casepilot/core';

registerProviderType('my-gateway', (entry) => {
  const provider: ChatProvider = {
    kind: 'chat',
    id: entry.id,
    async generate({ messages, tools }) {
      // call your backend; return { text?, toolCalls? }
      return { text: 'ok' };
    },
  };
  return provider;
});
```

Then reference it in config:

```yaml
providers:
  - id: gw
    type: my-gateway
    baseUrl: https://llm.internal.example.com   # any extra keys reach your factory
```

A factory may also return an `AgentProvider` (`kind: 'agent'` with `runTask({ taskPrompt, mcp, cwd })`). Built-in type names cannot be overridden.
