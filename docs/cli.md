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
| `--headed` | run with a visible browser |
| `--base-url <url>` | absolute http(s) base URL relative case urls resolve against |

```bash
casepilot record login --provider claude-code
casepilot record login --no-video --base-url https://staging.example.com
```

## casepilot run \<case\>

Replay a recorded case (`cases/<case>.replay.json`). No LLM cost unless healing triggers. Exit code reflects the verdict.

| Option | Meaning |
| --- | --- |
| `--video` / `--no-video` | record a video of the run (default: **on**; `video:` in `casepilot.config.yaml` changes the default) |
| `--optimize-video` / `--no-optimize-video` | also write an idle-trimmed copy of the video (default: **on**; `optimizeVideo:` key changes the default) |
| `--slow-mo <ms>` | milliseconds Playwright pauses between browser operations (0-10000) |
| `--step-delay <ms>` | milliseconds to wait between replay steps (0-10000) |
| `--headed` | run with a visible browser |
| `--no-heal` | disable AI healing of failed steps |
| `--base-url <url>` | absolute http(s) base URL relative case urls resolve against |

Healing picks a chat provider automatically: the default provider if it is a chat provider, otherwise the first configured chat provider; with none available, the run simply fails on the broken step.

```bash
casepilot run login
casepilot run login --no-heal --no-video
casepilot run login --slow-mo 150 --step-delay 600   # watchable pacing
```

Video defaults: both the run video and its idle-trimmed copy are produced by default so every run leaves proof artifacts. Opt out per run with `--no-video` / `--no-optimize-video`, or per workspace with `video: false` / `optimizeVideo: false` in `casepilot.config.yaml` (an explicit flag always wins over the workspace key).

### Base URL precedence

For `record` and `run`, the effective base URL is resolved as: `--base-url` flag > `CASEPILOT_BASE_URL` environment variable > `baseUrl:` key in `casepilot.config.yaml` > none. Both the flag and the env var must be absolute http(s) URLs.

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
