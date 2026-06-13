# CLI reference

```
casepilot [--workspace <dir>] <command>
```

`--workspace <dir>` is a global option (default: current directory). It selects the directory containing `casepilot.config.yaml`, `cases/`, and `runs/`.

## casepilot init

Scaffold a casepilot workspace: `casepilot.config.yaml`, `cases/`, and `cases/example.case.yaml`. Existing files are skipped, never overwritten.

```bash
casepilot init
casepilot --workspace ./my-tests init
```

## casepilot record \<case\>

Record a case with an AI provider into a deterministic replay. `<case>` refers to `cases/<case>.case.yaml`. On a passing verdict, `cases/<case>.replay.json` is written. Exit code 0 = passed, 1 = failed.

| Option | Meaning |
| --- | --- |
| `--provider <id>` | provider id from `casepilot.config.yaml` (default: `defaultProvider`) |
| `--video` / `--no-video` | record a video of the run (default: **on**; `video:` in `casepilot.config.yaml` changes the default) |
| `--optimize-video` / `--no-optimize-video` | also write an idle-trimmed copy of the video (default: **on**; `optimizeVideo:` key changes the default) |
| `--video-pad <ms>` | padding kept around each step when trimming idle video time (default 400) |
| `--headed` | run with a visible browser |
| `--screenshots` | capture a screenshot after every step (failed steps are always screenshotted) |
| `--viewport <WxH>` | browser viewport, e.g. `1920x1080` (the default) |
| `--base-url <url>` | absolute http(s) base URL relative case urls resolve against |

```bash
casepilot record login --provider claude-code
casepilot record login --no-video --base-url https://staging.example.com
```

While a record or run is in flight, a heartbeat line (`[record] still working... 15s elapsed`) is printed to stderr every 15 seconds so CI logs do not look stalled.

## casepilot run \<case\>

Replay a recorded case (`cases/<case>.replay.json`). No LLM cost unless healing triggers. Exit code reflects the verdict.

| Option | Meaning |
| --- | --- |
| `--video` / `--no-video` | record a video of the run (default: **on**; `video:` in `casepilot.config.yaml` changes the default) |
| `--optimize-video` / `--no-optimize-video` | also write an idle-trimmed copy of the video (default: **on**; `optimizeVideo:` key changes the default) |
| `--video-pad <ms>` | padding kept around each step when trimming idle video time (default 400) |
| `--slow-mo <ms>` | milliseconds Playwright pauses between browser operations (0-10000) |
| `--step-delay <ms>` | milliseconds to wait between replay steps (0-10000) |
| `--headed` | run with a visible browser |
| `--no-heal` | disable AI healing of failed steps |
| `--heal-policy <policy>` | `review` (queue heals for approval, the default) or `auto` (apply immediately); overrides the workspace `healPolicy:` key |
| `--screenshots` | capture a screenshot after every step (failed steps are always screenshotted) |
| `--viewport <WxH>` | browser viewport, e.g. `1920x1080` (the default) |
| `--base-url <url>` | absolute http(s) base URL relative case urls resolve against |

Healing picks a chat provider automatically: the default provider if it is a chat provider, otherwise the first configured chat provider; with none available, the run simply fails on the broken step. Under the default `review` policy a healed step is used in-memory for this run only and queued in the workspace `heals.json` for approval (see [casepilot heals](#casepilot-heals)); `auto` restores the legacy behavior of rewriting `cases/<case>.replay.json` in place.

```bash
casepilot run login
casepilot run login --no-heal --no-video
casepilot run login --slow-mo 150 --step-delay 600   # watchable pacing
```

Video defaults: both the run video and its idle-trimmed copy are produced by default so every run leaves proof artifacts. Opt out per run with `--no-video` / `--no-optimize-video`, or per workspace with `video: false` / `optimizeVideo: false` in `casepilot.config.yaml` (an explicit flag always wins over the workspace key).

### Base URL precedence

For `record` and `run`, the effective base URL is resolved as: `--base-url` flag > `CASEPILOT_BASE_URL` environment variable > `baseUrl:` key in `casepilot.config.yaml` > none. Both the flag and the env var must be absolute http(s) URLs.

### Authentication (useAuth / saveAuth)

`record` and `run` honor auth **automatically** — there is no new flag. If the case (or its replay) carries `useAuth`, or the workspace sets `defaultAuth:`, the run loads that profile's session at launch so it starts authenticated; a case with `saveAuth` writes its session to the named profile on a passing verdict. Profiles live at `<workspace>/auth/<profile>.json` and are git-ignored secrets. See [case-format.md](case-format.md#authenticated-cases-useauth--saveauth) for the fields and the effective-useAuth resolution rule.

When a run needs a profile that does not exist yet, the workspace `authRefresh:` key decides what happens:

- `manual` (the default) fails fast with an actionable error: `auth profile "<p>" not found; record or run the login case (saveAuth: <p>) first`.
- `auto` finds the producer case (the one whose recorded replay has `saveAuth: <p>`), replays it to regenerate the profile, then continues with the original run. If no producer exists, it falls back to the same `manual` error. Keep exactly one producer per profile: if several cases declare `saveAuth: <p>`, `auto` picks the first match in case-name order arbitrarily (see [case-format.md](case-format.md#authenticated-cases-useauth--saveauth)).

**MVP limit:** only an *absent* profile is detected. An expired-but-present profile is **not** auto-detected — the loaded session is simply stale, so the case surfaces it as a normal step/assertion failure. Refresh it by re-running the producer (the case with `saveAuth: <p>`).

> Scope note: auth `storageState` is applied on the **chat-provider record path** and on **replay** (both flow through the library `RunOptions`). Recording via an **agent CLI** (`claude-code`/`codex`) does **not** yet support auth — the browser-tools bridge has no storage-state path, so `useAuth` is never injected (the session is **not** loaded) and `saveAuth` saves **no profile** (nothing is written). Rather than silently no-op'ing, an agent-CLI record of a case that declares `useAuth`/`saveAuth` now **errors fast** with an actionable message. Record such a case with a chat provider instead, or remove `useAuth`/`saveAuth`; replay continues to honor both. Agent-record storageState injection is a documented follow-up.

## casepilot run-all [cases...]

Replay a whole suite of recorded cases into one aggregate verdict. With no arguments it runs every recorded case in the workspace; pass `[cases...]` to run only those (by name). Each case is replayed exactly like `casepilot run`, so there is no LLM cost unless healing triggers.

| Option | Meaning |
| --- | --- |
| `--concurrency <n>` | how many cases to replay in parallel (default 1, i.e. serial) |
| `--junit <file>` | also write a JUnit XML report to this path |
| `--json <file>` | also write a JSON suite report to this path |
| `--no-heal` | disable AI healing of failed steps |
| `--heal-policy <policy>` | `review` (queue heals for approval, the default) or `auto` (apply immediately); overrides the workspace `healPolicy:` key |
| `--headed` | run with a visible browser |
| `--video` / `--no-video` | record a video per case (default: **on**; `video:` in `casepilot.config.yaml` changes the default) |
| `--base-url <url>` | absolute http(s) base URL relative case urls resolve against (same precedence as `run`) |

A case that has no recorded replay (`cases/<case>.replay.json`) is **skipped with a warning** rather than failing the suite; a named case that does not exist is likewise skipped. Skipped cases are reported but do not run. An infra error thrown while replaying one case (e.g. a browser crash) is isolated as a failed case so the rest of the suite keeps going.

As each case settles, a progress line (`[2/5] login … PASS`) is printed to stderr; the final summary (per-case PASS/FAIL/SKIP plus counts) goes to stdout.

Reports are always written to `<workspace>/suites/<suiteId>/suite.json` and `<workspace>/suites/<suiteId>/junit.xml`. `--junit <file>` and `--json <file>` write the same JUnit XML / JSON to those extra paths as well (handy for a fixed CI artifact location).

Exit code: `0` only if at least one case ran and none failed. If nothing ran — every selected case was skipped, or no recorded cases were found — the exit code is `1` (and `no recorded cases to run` is printed to stderr). Any failed case also yields `1`.

```bash
casepilot run-all                                   # replay every recorded case
casepilot run-all login checkout                    # only these two
casepilot run-all --concurrency 4 --junit out/junit.xml
casepilot run-all --no-heal --base-url https://staging.example.com
```

## casepilot export \<case\>

Export the recorded replay as a Playwright spec file.

| Option | Meaning |
| --- | --- |
| `-o, --out <file>` | output file (default `cases/<case>.spec.ts`) |

```bash
casepilot export login -o e2e/login.spec.ts
```

## casepilot runs

List runs from the workspace `runs/` directory, or from a running server.

| Option | Meaning |
| --- | --- |
| `--server <url>` | read runs from a casepilot REST server instead of the filesystem |

```bash
casepilot runs
casepilot runs --server http://127.0.0.1:7700
```

## casepilot report \<runId\>

Show the full report (`result.json`) of a run.

| Option | Meaning |
| --- | --- |
| `--server <url>` | read the report from a casepilot REST server |

```bash
casepilot report 20260611-142233-a1b2c3
```

## casepilot transcript \<runId\>

Render a run's agent provider transcript (`runs/<runId>/transcript.txt`, event JSONL from claude-code/codex sessions) as readable text: assistant messages, tool calls with arguments, tool results, and the final result line. After a failed record/run with an agent provider, the CLI suggests this command. Errors if the run has no transcript (chat-provider runs write `transcript.json` instead).

```bash
casepilot transcript 20260611-142233-a1b2c3
```

## casepilot heals

Review healed steps queued by replay runs. Under the default `review` heal policy, a successful heal does not touch the case replay; it lands as a pending record in the workspace `heals.json` with the old and new step.

### casepilot heals list

List pending heals with an old/new step diff. `--all` includes approved and rejected heals.

```bash
casepilot heals list
casepilot heals list --all
```

### casepilot heals approve \<id\>

Apply a pending heal into `cases/<case>.replay.json` (bumps `meta.healCount`). Fails with exit code 1 when the heal id is unknown, already resolved, or the replay step changed since the heal was recorded (conflict).

### casepilot heals reject \<id\>

Mark a pending heal rejected without touching the replay.

## casepilot serve

Start the REST server (see [rest-api.md](rest-api.md)). Without `--workspace`, it serves all projects registered in the project registry; with `--workspace`, that directory is additionally served as the implicit project `default` with unscoped `/api/...` aliases.

| Option | Meaning |
| --- | --- |
| `--port <port>` | port to listen on (default 7700) |
| `--registry <file>` | project registry file (default `~/.casepilot/projects.json`) |

```bash
casepilot serve
casepilot --workspace ./my-tests serve --port 8800
```

## casepilot projects

Manage the multi-project registry used by `casepilot serve` and the dashboard. The registry lives at `~/.casepilot/projects.json` (override the directory with the `CASEPILOT_HOME` env var, or per-command with `--registry <file>`).

### casepilot projects list

```bash
casepilot projects list
# myapp  MyApp  C:\work\myapp-tests
```

### casepilot projects add \<path\>

Register a project directory. If the directory is not yet a casepilot workspace, it is scaffolded. The project id is a slug of the name (the id `default` is reserved; duplicates get `-2`, `-3`, ... suffixes).

| Option | Meaning |
| --- | --- |
| `--name <name>` | display name (default: directory name) |
| `--registry <file>` | registry file override |

```bash
casepilot projects add ../myapp-tests --name "MyApp"
```

### casepilot projects remove \<id\>

Remove a project from the registry. Workspace files are never deleted.

```bash
casepilot projects remove myapp
```

## casepilot mcp

Print instructions for registering the casepilot **control** MCP server with an MCP client (e.g. Claude Code), including a ready `.mcp.json` snippet and a `claude mcp add` one-liner pointing at the resolved `@casepilot/mcp` binary with `control --workspace <dir>`. See [mcp.md](mcp.md).
