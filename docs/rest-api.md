# REST API

Start the server with `casepilot serve` (default `http://127.0.0.1:7700`, binds to 127.0.0.1, CORS enabled).

## Scoping

Every workspace route exists in two forms:

- **Project-scoped**: `/api/projects/:projectId/...` - works for every project in the registry (`~/.casepilot/projects.json`).
- **Unscoped alias**: `/api/...` - only when the server was started with `--workspace`; that workspace is the implicit project `default`. Without `--workspace`, unscoped workspace routes return `404 {"error":"project-scoped route required"}`.

Errors are always `{"error": "<message>"}` with an appropriate 4xx/5xx status.

## Service routes

### GET /api/health

```json
{ "ok": true, "version": "0.1.0" }
```

### GET /api/projects

Lists registered projects (plus the implicit `default` in single-workspace mode) with case counts:

```json
{ "projects": [ { "id": "myapp", "name": "MyApp", "path": "C:\\work\\myapp-tests", "caseCount": 4, "lastRunAt": "2026-06-11T14:22:33.000Z" } ] }
```

### POST /api/projects

Body `{"name": "MyApp", "path": "C:/work/myapp-tests"}`. Registers the directory (scaffolding a workspace if needed). Returns `201 {"project": {"id","name","path"}}`; `400` if the path does not exist or is already registered.

### DELETE /api/projects/:projectId

Removes the project from the registry only; files are untouched. `204` on success, `404` if unknown.

## Case routes

Base: `/api/projects/:projectId` (or `/api` in single-workspace mode). `<name>` must match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`.

### GET .../cases

```json
[ { "name": "login", "url": "https://app.example.com/login", "hasReplay": true, "file": "...cases/login.case.yaml" } ]
```

### GET .../cases/:name

Returns `{ "spec": {...}, "specYaml": "...", "replay": {...} }`; `replay` only when recorded. `404` if missing, `400` if the YAML on disk is invalid.

### PUT .../cases/:name

Body `{"specYaml": "name: login\nurl: ...\nsteps: [...]\nexpect: [...]"}`. Validates and saves the case; returns `{"name", "spec"}`.

### DELETE .../cases/:name

Deletes the case file and its replay. `204` on success.

### POST .../cases/:name/export

Returns `{"specTs": "<playwright spec source>"}`; `404` if no replay exists.

### GET .../providers

```json
{ "default": "lmstudio", "providers": [ { "id": "lmstudio", "kind": "chat", "type": "openai-compatible" } ] }
```

## Run routes

### POST .../runs

Starts a run asynchronously.

Request:

```json
{ "case": "login", "mode": "record", "provider": "claude-code", "video": true, "headed": false, "baseUrl": "https://staging.example.com" }
```

`mode` is `"record"` or `"replay"`; `provider`, `video`, `headed`, `baseUrl` are optional. `baseUrl` must be an absolute http(s) URL; relative case urls resolve against it, and it takes precedence over the workspace `baseUrl:` in `casepilot.config.yaml`. Responses: `202 {"runId": "20260611-142233-a1b2c3"}` on accept; `404` when the case (or, for replay, the replay file) is missing; `400` for a malformed body.

This is the only way to record through an **agent** provider (the server spawns the CLI and the MCP bridge).

### GET .../runs

Run summaries, newest first:

```json
[ { "runId": "...", "case": "login", "mode": "record", "provider": "claude-code", "status": "running", "verdict": null, "startedAt": "...", "finishedAt": null } ]
```

`status` is `running`, `done`, or `error`. Finished runs from previous server sessions are loaded from `runs/` on startup with status `done`.

### GET .../runs/:id

Poll this until `status` leaves `running`:

```json
{ "status": "done", "result": { "case": "login", "mode": "record", "verdict": "passed", "explanation": "...", "steps": [...], "artifacts": {...}, "startedAt": "...", "finishedAt": "..." }, "error": null }
```

`status: "done"` means the run completed and `result.verdict` holds the outcome; `status: "error"` means the run itself blew up and `error` holds the message. Typical polling loop:

```bash
RUN=$(curl -s -XPOST localhost:7700/api/projects/myapp/runs \
  -H 'content-type: application/json' \
  -d '{"case":"login","mode":"replay"}' | jq -r .runId)
until [ "$(curl -s localhost:7700/api/projects/myapp/runs/$RUN | jq -r .status)" != "running" ]; do sleep 2; done
curl -s localhost:7700/api/projects/myapp/runs/$RUN | jq .result.verdict
```

### GET .../runs/:id/video

Streams the run's `video/*.webm` (`content-type: video/webm`). `404` when the run recorded no video.

### GET .../runs/:id/transcript

Returns the agent session transcript as `text/plain`. `404` when absent (chat-provider runs write `transcript.json` into the run dir instead).

## Static artifacts

In single-workspace mode only, the workspace `runs/` directory is also served at `/artifacts/` (e.g. `/artifacts/<runId>/result.json`).
