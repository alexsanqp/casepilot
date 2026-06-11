# Troubleshooting

Real issues hit during development, what they look like, and what casepilot already does about them.

## Where to look first

For run `<id>` under the workspace:

```
runs/<id>/result.json       # verdict, explanation, per-step results with errors and timings
runs/<id>/transcript.txt    # full agent CLI session (claude-code / codex), written even on failure
runs/<id>/transcript.json   # chat-provider message log (recorder runs)
runs/<id>/replay.json       # replay produced/used by this run
runs/<id>/video/*.webm      # with --video
cases/<name>.replay.json    # the canonical replay (updated on heal)
```

Failed runs still get a `result.json` with the error in `explanation`, and agent CLI failures persist the captured stdout as the transcript.

## User-level Claude Code hooks/MCP poisoning headless runs

Symptom: `casepilot record` with the `claude-code` provider fails or hangs for reasons unrelated to the test; e.g. a failing SessionEnd hook flips the exit code, or a personal MCP server breaks startup.

Mitigation (built in): casepilot launches `claude` with `--strict-mcp-config` (only the casepilot bridge is loaded) and `--settings {"disableAllHooks":true}`, and restricts tools to `mcp__casepilot__*`. Your interactive setup is untouched; it just never enters the recording session.

## Expired Claude CLI OAuth

Symptom: the claude-code provider exits non-zero; the transcript/stdout tail shows a 401 and the stored credentials have an empty `refreshToken`, so the CLI cannot refresh silently.

Fix: re-authenticate interactively with `claude auth login`, then rerun the record.

## Codex user config with a broken MCP gateway

Symptom: the `codex` provider aborts immediately at startup because an MCP gateway defined in `~/.codex/config.toml` has stale auth.

Mitigation (built in): casepilot passes `--ignore-user-config` to `codex exec`, so your user config is skipped entirely while `auth.json` (your login) still applies. The casepilot bridge is injected with explicit `-c mcp_servers.casepilot...` overrides.

## Slow first page load vs MCP handshake

Symptom: against a dev server that lazily compiles the first page (60s+), the agent CLI marks the casepilot MCP server as failed before the page is ever ready, and the browser tools never register.

Mitigation (built in): the browser-tools bridge completes the MCP handshake instantly with no browser; Chromium launches lazily on the first tool call, preceded by a plain HTTP warm-up fetch (up to 90 s) so the navigation timeout does not pay for the compile. The claude-code provider additionally sets `MCP_TIMEOUT=120000` and `MCP_TOOL_TIMEOUT=300000`.

## Max-turns exhaustion

Symptom: a record run fails with "Recording stopped after N provider turns without report_result being called", or the claude-code CLI stops at its turn limit mid-flow. Every tool call costs a turn, and a realistic login + navigate + form flow eats turns fast.

Fix: raise `maxTurns` on the claude-code provider entry (default 100). For chat providers the loop cap is `maxSteps` (default 25) in `RunOptions`. Also note the task prompt already tells agents to batch independent tool calls per message; simpler, more specific case steps reduce turns too.

## Windows: spawning npm .cmd shims

Symptom: on Windows, `claude`/`codex` installed via npm are `.cmd` shims; plain `spawn` cannot find or safely execute them (Node refuses `.cmd` with `shell:false` since CVE-2024-27980).

Mitigation (built in): casepilot resolves bare command names against PATH with `.exe/.cmd/.bat` extensions and routes `.cmd`/`.bat` through `cmd.exe` with full metacharacter escaping. Arguments containing newlines cannot pass through a `.cmd` shim at all; that is why the codex provider sends its prompt over stdin. If you hit the explicit "Cannot pass an argument containing newlines" error with a custom command, point the provider `command` at the underlying executable instead of the shim.

## Agent CLI hangs or leaks browsers

The provider kills the CLI after 10 minutes (`AGENT_TIMEOUT_MS`), using `taskkill /T` on Windows so MCP subprocesses die with it. If the agent disconnects without calling `report_result`, the bridge shuts the browser down itself and prunes unfinalized 0-byte `.webm` stubs from the run dir.

## "provider ... is an agent provider" from the control MCP server

`run_case` in `casepilot-mcp control` runs in-process and can only record with chat providers. Recording through claude-code/codex must go through the REST server, which owns the CLI + bridge orchestration: start `casepilot serve` and launch the control server with `--server http://127.0.0.1:7700`.
