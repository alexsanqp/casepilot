# Getting started

## Install

casepilot is a TypeScript monorepo using npm workspaces. From the repo root:

```bash
npm install
npx playwright install chromium   # the engine launches Playwright chromium
npm run build                     # builds core -> providers -> mcp -> server -> cli -> dashboard
```

Run the test suites with `npm test`.

## Create a workspace

A workspace is any directory containing `casepilot.config.yaml` and a `cases/` folder. Scaffold one:

```bash
mkdir my-tests && cd my-tests
npx casepilot init
```

This creates:

- `casepilot.config.yaml` - provider configuration (starts with `providers: []` plus commented examples)
- `cases/example.case.yaml` - a working example against `https://example.com/`

All CLI commands accept `--workspace <dir>`; the default is the current directory.

Optionally add a top-level `baseUrl: https://your-app.example.com` to `casepilot.config.yaml`: it becomes the default target base URL for every run in the workspace, letting cases use relative urls like `/login` (override per run with `--base-url` or `CASEPILOT_BASE_URL`).

## Configure a provider

Edit `casepilot.config.yaml`. Minimal local example with LM Studio:

```yaml
defaultProvider: lmstudio
providers:
  - id: lmstudio
    type: openai-compatible
    baseUrl: http://127.0.0.1:1234/v1
    model: qwen2.5-coder-32b-instruct
```

Or with the Claude Code CLI (no API key, uses your `claude` login):

```yaml
defaultProvider: claude-code
providers:
  - id: claude-code
    type: claude-code
```

See [providers.md](providers.md) for all types and options.

## Write your first case

`cases/login.case.yaml`:

```yaml
name: login
url: https://app.example.com/login
steps:
  - Fill the username field with "demo"
  - Fill the password field with "demo123"
  - Click the "Sign in" button
expect:
  - The page url contains "/dashboard"
```

All four keys are required; `steps` and `expect` are plain-English string lists. The file name (minus `.case.yaml`) is the case name used on the command line.

## Record

```bash
npx casepilot record login
```

The provider drives a real browser, executes the steps, verifies the expectations, and reports a verdict. Output ends with the run directory path. Exit code 0 means passed. Run videos (plus an idle-trimmed copy) are recorded by default; disable with `--no-video` or `video: false` in `casepilot.config.yaml`.

Artifacts after a successful record:

```
cases/login.replay.json          # deterministic replay (only written when the recording passed)
runs/<runId>/result.json         # full run report (verdict, per-step results, artifact paths)
runs/<runId>/replay.json         # the replay as produced by this run
runs/<runId>/transcript.txt      # agent provider session transcript (agent CLIs)
runs/<runId>/transcript.json     # chat message log (chat providers)
runs/<runId>/video/*.webm        # on by default; skipped with --no-video
```

Run ids look like `20260611-142233-a1b2c3` (timestamp + random hex).

## Replay

```bash
npx casepilot run login
```

No LLM is involved unless a step fails and healing kicks in (a chat provider must be configured; disable with `--no-heal`). The process exit code is 0 for passed, 1 for failed, so it drops straight into CI.

## Export

```bash
npx casepilot export login            # writes cases/login.spec.ts
npx casepilot export login -o e2e/login.spec.ts
```

The result is a standalone `@playwright/test` spec with no casepilot dependency.

## Server and dashboard (optional)

```bash
npx casepilot serve                   # REST API on http://127.0.0.1:7700
cd packages/dashboard && npm run dev  # web UI on http://localhost:7701 (proxies /api to 7700)
```

Without `--workspace`, the server serves every project registered via `casepilot projects add`. See [rest-api.md](rest-api.md) and [cli.md](cli.md).
