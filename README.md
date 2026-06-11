# casepilot

Provider-agnostic AI UI test-case runner. You write test cases in natural language
(`*.case.yaml`), an LLM provider drives a real browser once to **record** a deterministic
replay file, and from then on the case runs as a pure **replay** with zero LLM calls.
Failed replay steps can be **healed** by a provider on demand, and any replay can be
**exported** to a plain Playwright spec.

## Architecture

```
*.case.yaml ──► recorder (LLM agent loop) ──► replay.json ──► replayer (no LLM) ──► verdict
                     │                                              │
                     │  tools: query_page / snapshot /              │ on failure: HealerFn
                     │         act / assert / report_result        ▼
                     ▼                                          exporter ──► *.spec.ts
               BrowserSession (Playwright chromium)
```

- **Provider contracts** (`ChatProvider` for tool-calling chat models, `AgentProvider`
  for agentic CLIs over MCP) keep the engine vendor-neutral.
- **Domain logic is pure**: element scoring, codegen, and replay-file handling have no
  Playwright dependency; all browser side effects live in `BrowserSession`.
- **Verdicts are validated server-side**: a recording only passes if the executed
  assertions actually passed, regardless of what the model claims.

## Packages

- `packages/core` (`@casepilot/core`) — types, browser tool layer, recorder, replayer,
  exporter, case/replay file IO.

## Usage

```bash
npm install
npx playwright install chromium
npm run build
npm test
```
