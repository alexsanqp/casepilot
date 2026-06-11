# Architecture

## Record flow

Two paths, depending on the provider kind.

**Chat provider** (openai-compatible, anthropic): the casepilot recorder owns the agent loop.

```
recorder loop (core/engine/recorder.ts)
  ├─ system prompt + case message
  ├─ provider.generate({messages, tools}) ──► chat API
  ├─ tool calls executed against BrowserSession
  │     query_page / snapshot / act / assert
  ├─ successful act/assert appended to replay steps
  └─ report_result ──► verdict guard ──► replay.json + transcript.json
```

The loop is capped at `maxSteps` provider turns (default 25). Failed tool calls feed the error text back to the model so it can retry differently.

**Agent provider** (claude-code, codex): the CLI owns the loop; casepilot owns the browser.

```
runner (server/runner.ts)
  └─ AgentProvider.runTask(taskPrompt, mcp)
       └─ spawned CLI (claude -p / codex exec)
            └─ stdio MCP ──► casepilot-mcp browser-tools
                              └─ BrowserSession (Playwright chromium)
                                   └─ report_result ──► replay.json + result.json in the run dir
```

The runner writes the CLI transcript to `runs/<id>/transcript.txt`, reads back `result.json`, and on a passing verdict copies `replay.json` to `cases/<name>.replay.json`. If the bridge wrote no `result.json`, the run fails with "the agent likely never called report_result".

## Replay flow

`replayCase` opens the start URL and executes recorded steps in order: `act` steps run directly, `assert` steps must return ok. The first unrecovered failure ends the run as `failed`. No LLM is contacted on the happy path.

## Healer flow

When a replay step fails and healing is enabled, the replayer:

1. takes an accessibility snapshot of the current page;
2. calls the healer (a chat provider with a strict JSON-only system prompt) with the failed step, the error, the original case, and the snapshot;
3. parses the reply as exactly one replay step (schema-validated; anything else means "no fix");
4. retries the fixed step. On success the step is marked `healed`, the replay file is rewritten in place, and `meta.healCount` is incremented. If the retry also fails, the run fails.

Only the broken step is sent to the model, never the whole test.

## Why a11y tree and query_page instead of screenshots

Screenshots force a vision model and cost thousands of image tokens per look. casepilot keeps the model in cheap text space:

- `snapshot` returns Playwright's ARIA snapshot, truncated to 6000 chars.
- `query_page` does the heavy lifting in plain code: the page is scanned for up to 400 interactive/labeled elements (role, accessible name, surrounding context, CSS path), a lexical scorer ranks them against the natural-language query, and the top K come back with ready-to-use Playwright selectors (`role=...[name="..."]` preferred, then `text=`, then a CSS path).

The model usually needs one short `query_page` round-trip per element instead of reading a screenshot, which makes small local models viable as recorders.

## Verdict guard design

A model saying "passed" proves nothing, so verdicts are computed server-side (in the recorder loop and identically in the browser-tools bridge):

- no `report_result` call -> failed (turn budget exhausted);
- `report_result(passed: false)` -> failed;
- `report_result(passed: true)` -> only passes if at least one assertion was executed and the final attempt of each distinct assertion passed. Distinctness ignores the `note` field, so a retried assertion is judged by its last attempt.

Replays do not need the guard: their verdict is the deterministic outcome of executing the recorded steps.

## Cost model

| Phase | LLM cost |
| --- | --- |
| record | one agent session per case (chat tokens or CLI turns) |
| replay | zero |
| replay with a broken step | one small healer call per broken step (single step + snapshot) |
| exported Playwright spec | zero, forever |

A recorded suite is free to run on every commit; you pay again only when the UI changes enough to break a selector, and then only for the broken step.

## Run lifecycle (server)

`POST /runs` creates a run dir, registers the run as `running` in an in-memory `RunRegistry`, and executes asynchronously via `RunService`. Completion sets `done` (with the `RunResult`) or `error`. Every run, even a crashed one, leaves a diagnosable `result.json` in `runs/<id>/`; the registry is rehydrated from that directory on server start. The same `executeRun` path backs the CLI, so artifacts are identical either way.
