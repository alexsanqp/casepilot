# casepilot

Provider-agnostic AI UI test runner. You describe a test case in plain English inside a small YAML file. An LLM provider drives a real browser (Playwright Chromium) once to **record** the case, producing a deterministic `replay.json`. Every run after that is a pure **replay**: same selectors, same assertions, zero LLM calls, exit code reflects the verdict.

When the app changes and a recorded step breaks, a **healer** (any chat LLM) repairs only the broken step using the current page's accessibility snapshot; the fix is queued for review by default and written into the replay on approval (or immediately with `healPolicy: auto`). You only pay for intelligence when something is recorded or healed. Verdicts are never taken from the model's word: a server-side guard requires that the agent called the `report_result` tool and that every executed assertion actually passed.

casepilot is provider-agnostic by contract. Tool-calling chat APIs (OpenAI, LM Studio, Ollama, OpenRouter, Anthropic) and agentic CLIs (Claude Code, Codex) plug into the same engine, and custom provider types can be registered at runtime. Recorded cases can be exported to plain Playwright spec files, so nothing locks you in.

## Architecture

```
*.case.yaml ──► recorder (LLM drives browser once) ──► replay.json ──► replayer (no LLM) ──► verdict
                     │                                                       │
                     │  tools: query_page / snapshot /                       │ on failure:
                     │         act / assert / report_result                  │ healer (chat LLM)
                     ▼                                                       ▼ fixes one step
              BrowserSession (Playwright chromium)                  exporter ──► *.spec.ts
```

Agent CLI providers (Claude Code, Codex) connect to the browser through a stdio MCP bridge:

```
runner ──► AgentProvider ──► spawned CLI ──► casepilot-mcp browser-tools ──► Playwright ──► replay.json
```

## Quickstart

```bash
npm install
npx playwright install chromium
npm run build

# 1. scaffold a workspace (casepilot.config.yaml, cases/, example case)
npx casepilot init

# 2. configure a provider in casepilot.config.yaml, then write a case
#    cases/login.case.yaml:
#      name: login
#      url: https://app.example.com/login
#      steps:
#        - Fill the username field with "demo"
#        - Fill the password field with "demo123"
#        - Click the "Sign in" button
#      expect:
#        - The page url contains "/dashboard"

# 3. record once with an LLM (writes cases/login.replay.json)
npx casepilot record login

# 4. replay forever, free (exit code = verdict)
npx casepilot run login

# 5. optionally export to a plain Playwright spec
npx casepilot export login
```

## Features

| Feature | How |
| --- | --- |
| Natural-language cases | `cases/<name>.case.yaml` with `name`, `url`, `steps`, `expect`; steps may carry per-step expectations (`{do, expect}`) |
| Host-portable cases | relative `url: /login` resolved against `--base-url` > `CASEPILOT_BASE_URL` > workspace `baseUrl:` |
| Record once with any LLM | `casepilot record <case>` via chat API or agent CLI |
| Deterministic free replays | `casepilot run <case>` replays `replay.json`, no LLM calls |
| Suite runs + CI reports | `casepilot run-all` replays every recorded case into one verdict and writes JUnit XML + JSON |
| Self-healing with review | broken steps repaired by a chat LLM and queued in `heals.json` for approval (`casepilot heals`, dashboard, or `healPolicy: auto`); `--no-heal` to disable |
| Trustworthy verdicts | server-side assert guard, never the model's claim alone |
| Proof videos by default | every record/run leaves a video plus an idle-trimmed copy; opt out with `--no-video` / `--no-optimize-video` |
| Watchable pacing | `--slow-mo` / `--step-delay` (dashboard Pace presets) for human-speed replays |
| Playwright export | `casepilot export <case>` emits `<name>.spec.ts` |
| REST server + dashboard | `casepilot serve` (port 7700) + case-centric Vite/React UI (port 7701) |
| Multi-project registry | `casepilot projects add/list/remove`, dashboard project switcher |
| MCP integration | browser-tools bridge for agent CLIs, control server for external AI agents |
| Extensible providers | `registerProviderType()` hook for custom provider types |

## Documentation

- [Getting started](docs/getting-started.md) - install, first workspace, first case end to end
- [Case format](docs/case-format.md) - case.yaml schema, replay.json anatomy, verdict rules
- [Providers](docs/providers.md) - config schema, all provider types, custom providers
- [CLI reference](docs/cli.md) - every command and option
- [REST API](docs/rest-api.md) - all routes, run lifecycle, project scoping
- [MCP servers](docs/mcp.md) - browser-tools bridge and control server
- [Architecture](docs/architecture.md) - record/replay/heal flows, cost model, verdict guard
- [Troubleshooting](docs/troubleshooting.md) - known issues and built-in mitigations

## Packages

| Package | Contents |
| --- | --- |
| `@casepilot/core` | types, `BrowserSession`, recorder, replayer, exporter, case/replay file IO |
| `@casepilot/providers` | openai-compatible, anthropic, claude-code, codex, registry + extension hook |
| `@casepilot/mcp` | `casepilot-mcp` binary: browser-tools bridge and control server |
| `@casepilot/server` | Fastify REST server, async run lifecycle, healer, project registry |
| `@casepilot/cli` | `casepilot` binary |
| `@casepilot/dashboard` | Vite + React web UI |
