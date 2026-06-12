# Dashboard self-test suite

Dogfooding suite: casepilot test cases that exercise casepilot's own admin dashboard. The system under test is the web UI served by Vite at `http://localhost:7701`, backed by the REST server at `http://localhost:7700`.

## Prerequisites

Before recording or replaying these cases:

1. **Server running** on port 7700: `casepilot serve` (serves all registered projects from `~/.casepilot/projects.json`).
2. **Dashboard running** on port 7701: `npm run dev` inside `packages/dashboard` (or however the dev server is started in this repo).
3. **Demo project registered** under the name `demo-workspace`:
   `casepilot projects add ./demo-workspace --name demo-workspace`
   The cases reference this project by name, plus its two bundled cases: `example` (no replay) and `sprset46-project-tag-limit` (recorded, has a replay).
4. **At least one finished run** in the demo project, ideally one recorded with `--video --optimize-video --screenshots`, so the run-detail cases have something to open.
5. For the heal cases: at least one **pending heal** in the demo project's queue (produced by a replay run with heal policy `review` where a step was healed).

## Recording and replaying

This suite lives in its own workspace at `cases/dashboard`. Treat the repo root as the workspace and pass it explicitly, or run `casepilot init` wherever you want these cases to live and copy them into that workspace's `cases/` directory.

Assuming a workspace whose `cases/` directory contains these files:

```sh
# Record one case with an AI provider (creates <name>.replay.json next to the YAML)
casepilot --workspace <workspace> record projects-list --headed

# Replay it deterministically; exit code reflects the verdict
casepilot --workspace <workspace> run projects-list

# Useful extras
casepilot --workspace <workspace> run projects-list --video --optimize-video --screenshots
casepilot --workspace <workspace> runs            # list runs
casepilot --workspace <workspace> report <runId>  # full run report
```

## Caveats

- `run-start-replay` actually starts a replay of `sprset46-project-tag-limit`, which drives the Superset instance that case targets. Only run it when that environment is up.
- `heal-approve` is destructive: approving a heal rewrites the affected case's replay file. `heal-reject` only marks the heal as rejected.
- `projects-add-and-remove` and `case-editor-create-and-delete` clean up after themselves but mutate registry/case state while running.
- Several cases are order-sensitive only in the sense that they assume the prerequisites above; they do not depend on each other.

## Cases

| Case | What it covers |
| --- | --- |
| `projects-list` | Root page lists registered projects with path, case count and last-run time. |
| `projects-add-and-remove` | Adding a project via the form, then removing it via the card's Remove button with confirm dialog. |
| `projects-add-invalid-path` | Submitting a non-existent path shows an error and adds nothing. |
| `projects-browse-directory` | Browse opens the Select directory modal and selection fills the path input. |
| `project-switcher` | Sidebar project dropdown switches into a project and back to All projects. |
| `navigation-sidebar` | Sidebar links route to Cases, Runs and Heals; health indicator shows online. |
| `unknown-route` | Unknown URL renders the "Page not found." fallback. |
| `cases-list` | Cases table columns, replay badge and Record vs Re-record labels per row. |
| `run-options-popover` | Options panel toggles: video, optimize video (disabled until video), screenshots, custom viewport, heal policy. |
| `run-button-states` | Run is disabled without a replay (with tooltip) and enabled for a recorded case; provider dropdown present. |
| `run-start-replay` | Run button starts a replay run and lands on the Runs page with a running row. |
| `case-editor-create-and-delete` | New case editor with YAML template, save, then delete the case from the table. |
| `case-editor-edit` | Opening an existing case in the editor (name locked) and cancelling back to the list. |
| `case-export-modal` | Export shows the generated Playwright spec in a modal with a Copy button. |
| `runs-list` | Runs table columns, badges and the Refresh button. |
| `run-detail-steps` | Run detail banner (PASS/FAIL, explanation) and the step table with statuses and durations. |
| `run-detail-video` | Video player renders for a video run; clicking a step row seeks the video; Download video link. |
| `run-detail-video-optimized-toggle` | original/optimized toggle when an optimized video exists; timeline markers on original. |
| `run-detail-collapsibles` | Transcript and Replay JSON collapsible sections lazy-load content; back link to all runs. |
| `run-detail-download-artifacts` | Download artifacts button serves the run archive zip. |
| `heals-pending-list` | Pending heals listed with old/new diff; sidebar badge count matches. |
| `heal-approve` | Approving a pending heal removes it from the list and updates the badge. |
| `heal-reject` | Rejecting a pending heal removes it from the pending list. |
| `heals-history-toggle` | History checkbox reveals resolved heals with status badges and timestamps. |
