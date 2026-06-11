# MCP servers

The `@casepilot/mcp` package ships one binary, `casepilot-mcp`, with two stdio MCP servers:

```
casepilot-mcp browser-tools --case <path.case.yaml> --artifacts <dir> [--video] [--headed] [--base-url <url>]
casepilot-mcp control --workspace <dir> [--server <url>]
```

## browser-tools (the recording bridge)

`casepilot-mcp browser-tools` is the bridge that lets an **agent provider** (Claude Code, Codex) drive a real browser. You normally never start it yourself: the runner spawns the agent CLI with an MCP config pointing at this bridge, scoped to one case and one run directory.

Key behavior:

- **Lazy browser init.** The MCP handshake completes immediately with no browser; the Playwright session launches on the first tool call. Agent CLIs apply short connect timeouts, and a dev server lazily compiling for 60s+ would otherwise get the server marked failed. The first tool call also does a plain HTTP warm-up fetch (up to 90 s) before navigating.
- **Recording.** Every successful `act`/`assert` is appended to the replay. `report_result` finalizes: it closes the browser, writes `replay.json` and `result.json` into the artifacts dir, and the verdict is guarded by the same assert validation as the chat recorder (see [case-format.md](case-format.md)).
- **Cleanup.** If the agent disconnects without reporting, the bridge closes the browser and exits; 0-byte unfinalized video stubs are removed.

Tools:

| Tool | Parameters | Purpose |
| --- | --- | --- |
| `query_page` | `query` (string), `topK?` (number, default 5) | rank page elements matching a natural-language description; returns refs + Playwright selectors |
| `snapshot` | - | accessibility snapshot of the page (truncated to 6000 chars) |
| `act` | `action` (click/fill/press/select/goto/scroll/waitFor), `selector?`, `value?`, `note?` | perform a browser action; recorded on success |
| `assert` | `assert` (visible/absent/textPresent/urlContains/valueEquals), `selector?`, `text?`, `note?` | verify an expectation; recorded on success |
| `report_result` | `passed` (boolean), `explanation` (string) | REQUIRED final call; finalizes the recording |

`selector` may be a ref (`e1`, `e2`, ...) from the latest `query_page` or a raw Playwright selector.

## control (workspace operations for external AI agents)

`casepilot-mcp control --workspace <dir>` exposes a casepilot workspace to any MCP client, so an assistant like Claude Code can write, run, and inspect UI tests.

With `--server <url>` it forwards `run_case`/`get_report` to a running casepilot REST server instead of running in-process. That is required for recording with agent providers: in-process `run_case` only supports chat providers and replays, and returns an explanatory error for agent providers.

Tools:

| Tool | Parameters | Purpose |
| --- | --- | --- |
| `list_cases` | - | list cases with url, `hasReplay`, file path |
| `get_case` | `name` | parsed spec + raw YAML + replay if recorded |
| `upsert_case` | `name`, `yaml` | validate and save `cases/<name>.case.yaml` |
| `run_case` | `name`, `mode` (record/replay), `provider?`, `video?` | run a case; returns `{runId, verdict, explanation, runDir}` (or, via `--server`, an accepted runId to poll) |
| `get_report` | `runId` | the run's `result.json` |
| `export_case` | `name` | the replay as Playwright spec source |

## Registering in Claude Code

`casepilot mcp` prints a ready-made snippet for your workspace. It resolves the installed `@casepilot/mcp` binary and emits both formats:

`.mcp.json`:

```json
{
  "mcpServers": {
    "casepilot": {
      "command": "node",
      "args": [
        "<repo>/packages/mcp/dist/bin.js",
        "control",
        "--workspace",
        "<your workspace>"
      ]
    }
  }
}
```

One-liner:

```bash
claude mcp add casepilot -- node <repo>/packages/mcp/dist/bin.js control --workspace <your workspace>
```

(The exact paths in the output of `casepilot mcp` are already resolved for your machine.)
