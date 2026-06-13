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

### GET /api/fs/dirs

Directory listing for the dashboard's "Browse" directory picker. Without `?path=`, returns the filesystem roots (drive letters on Windows, `/` elsewhere); with `?path=<absolute dir>`, its subdirectories:

```json
{ "path": "C:\\work", "parent": "C:\\", "dirs": [ { "name": "myapp-tests", "path": "C:\\work\\myapp-tests" } ] }
```

Hidden directories (`.` / `$` prefixes) are skipped; a relative path is a `400`.

## Case routes

Base: `/api/projects/:projectId` (or `/api` in single-workspace mode). `<name>` must match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`.

### GET .../cases

```json
[ { "name": "login", "url": "https://app.example.com/login", "hasReplay": true, "file": "...cases/login.case.yaml",
    "lastRun": { "id": "20260611-142233-a1b2c3", "status": "done", "verdict": "passed", "finishedAt": "..." } } ]
```

`lastRun` is present only for cases with at least one known run.

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
{ "case": "login", "mode": "record", "provider": "claude-code", "video": true, "headed": false,
  "screenshots": true, "viewport": { "width": 1600, "height": 900 }, "healPolicy": "review",
  "optimizeVideo": true, "videoPadMs": 400, "slowMo": 150, "stepDelayMs": 600,
  "baseUrl": "https://staging.example.com" }
```

`mode` is `"record"` or `"replay"`; everything else is optional. `baseUrl` must be an absolute http(s) URL; relative case urls resolve against it, and it takes precedence over the workspace `baseUrl:` in `casepilot.config.yaml`. `screenshots` captures a screenshot after every step (failed steps are always screenshotted), `viewport` overrides the default 1920x1080. `healPolicy` (replay only) is `"review"` (queue heals in `heals.json`, the workspace default) or `"auto"` (rewrite the replay in place); it overrides the workspace `healPolicy:` key. Responses: `202 {"runId": "20260611-142233-a1b2c3"}` on accept; `404` when the case (or, for replay, the replay file) is missing; `400` for a malformed body.

Pacing: `slowMo` (milliseconds Playwright pauses between every browser operation) and `stepDelayMs` (milliseconds between replay steps) are non-negative integers capped at 10000. They mainly matter for replay pacing and watchable videos; `slowMo` also applies to agent recordings.

Video defaults: when `video` / `optimizeVideo` are omitted, they default to the workspace `video:` / `optimizeVideo:` keys in `casepilot.config.yaml`, which themselves default to **true**. An explicit `false` in the body always wins.

This is the only way to record through an **agent** provider (the server spawns the CLI and the MCP bridge).

### GET .../runs

Run summaries, newest first. `?case=<name>` filters to one case (the case page's run history uses this):

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

### GET .../runs/:id/video/optimized

Streams the idle-trimmed copy of the run video (`video/webm`). `404` when no optimized video was produced.

### GET .../runs/:id/screenshots/:fileName

Streams a step screenshot (`image/png`). `fileName` comes from the `screenshot` field of a step result in `result.json`; path separators and `..` are rejected with `400`.

### GET .../runs/:id/archive

Streams the whole run directory as a zip (`application/zip`, `content-disposition: attachment; filename="<case>-<runId>.zip"`). Backs the dashboard's "Download artifacts" button.

### GET .../runs/:id/transcript

Returns the agent session transcript as `text/plain`. `404` when absent (chat-provider runs write `transcript.json` into the run dir instead).

## Heal routes

Replay runs under the `review` heal policy queue successful heals in the workspace `heals.json` instead of rewriting the replay. Heal records carry `id`, `caseName`, `stepIndex`, `oldStep`, `newStep`, `runId`, `createdAt`, `status` (`pending`/`approved`/`rejected`), and `resolvedAt` once resolved.

### GET .../heals

Pending heals by default; `?all=1` (or `?all=true`) includes resolved ones:

```json
{ "heals": [ { "id": "a1b2c3d4", "caseName": "login", "stepIndex": 2, "oldStep": {...}, "newStep": {...}, "runId": "...", "createdAt": "...", "status": "pending" } ] }
```

### POST .../heals/:healId/approve

Applies the pending heal into `cases/<case>.replay.json` (bumps `meta.healCount`). Returns `{"applied": true}`; `404` for an unknown id, `409 {"error":"heal already resolved"}` when not pending, `409 {"error":"replay step changed since heal was recorded"}` when the replay no longer matches the heal's `oldStep` (conflict guard).

### POST .../heals/:healId/reject

Marks the pending heal rejected without touching the replay. Returns `{"applied": false}`; same `404`/`409` failures as approve.

## Suite routes

A suite replays a set of recorded cases into one aggregate verdict and writes CI-ingestible reports. As with the rest of the workspace API, these routes exist both project-scoped (`/api/projects/:projectId/suites/runs...`) and, in single-workspace mode, as unscoped `/api/suites/runs...` aliases.

### POST .../suites/runs

Starts a suite run asynchronously.

Request:

```json
{ "caseNames": ["login", "checkout"], "concurrency": 4, "heal": false, "headed": false, "video": true,
  "baseUrl": "https://staging.example.com" }
```

`caseNames` is optional — omit it to run every recorded case. `concurrency` (default 1) is how many cases replay in parallel. Any other keys are passed through as per-case replay options (e.g. `heal`, `healPolicy`, `headed`, `video`, `baseUrl`), mirroring the `run` flags. Cases with no recorded replay (and unknown named cases) are skipped, not failed. Responds `200 {"suiteId": "suite-...", "status": "running"}`.

### GET .../suites/runs

Suite summaries, newest first:

```json
[ { "suiteId": "suite-20260613-142233-a1b2c3", "status": "done", "startedAt": "...", "passed": 3, "failed": 1, "skipped": 1 } ]
```

`status` is `running`, `done`, or `error`. `passed`/`failed`/`skipped` are present once the suite has a result. Finished suites from previous server sessions are rehydrated from `suites/` (their `suite.json`) on startup with status `done`.

### GET .../suites/runs/:suiteId

Poll this until `status` leaves `running`:

```json
{ "status": "done",
  "result": { "startedAt": "...", "finishedAt": "...", "total": 5, "ran": 4, "passed": 3, "failed": 1, "skipped": 1,
    "cases": [ { "caseName": "login", "status": "passed", "verdict": "passed", "runId": "...", "durationMs": 1200 },
               { "caseName": "draft", "status": "skipped", "durationMs": 0, "reason": "not recorded" } ] },
  "error": null }
```

The `result` (`SuiteResult`) carries the aggregate counts plus a per-case `cases` array (`SuiteCaseResult`): `caseName`; `status` (`passed` / `failed` / `skipped`); `verdict` and `runId` only when the case actually ran (a `runId` links to the matching entry under `.../runs/:id`); `durationMs`; and `reason` for the failure message or the skip cause. `status: "error"` means the suite itself blew up and `error` holds the message. `404 {"error":"suite \"<suiteId>\" not found"}` for an unknown suite.

### GET .../suites/runs/:suiteId/junit

Returns the suite's JUnit XML report (`application/xml`), one `<testcase>` per case with `<failure>`/`<skipped>` for non-passing cases. `404` for an unknown or invalid `suiteId`, or when no report has been written yet.

### GET .../suites/runs/:suiteId/json

Returns the suite's JSON report (`application/json`) — the same `SuiteResult` shape as the poll route's `result`. Same `404` behavior as `/junit`.

## Static artifacts

In single-workspace mode only, the workspace `runs/` directory is also served at `/artifacts/` (e.g. `/artifacts/<runId>/result.json`).
