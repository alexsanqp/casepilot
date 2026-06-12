# Case format

## case.yaml

A case lives at `cases/<name>.case.yaml`. Schema (strict: unknown keys are rejected):

```yaml
name: checkout            # non-empty string; conventionally matches the file name
url: https://shop.example.com/cart   # start URL, opened before the first step
steps:                    # at least one plain-English action
  - Click the "Proceed to checkout" button
  - Fill the email field with "buyer@example.com"
  - Click "Place order"
expect:                   # at least one plain-English expectation
  - The text "Order confirmed" is visible
  - The page url contains "/orders/"
```

Case names used by the CLI/API must match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`.

`steps` tell the recording LLM what to do; `expect` tells it what to verify with `assert` tool calls. Be specific about visible labels ("the Sign in button") because element lookup is driven by accessible names.

### Per-step expectations

Each entry of `steps` is either a plain string (as above) or an object with `do` and an optional `expect`:

```yaml
steps:
  - Click the "Proceed to checkout" button
  - do: Fill the email field with "buyer@example.com"
    expect: The Place order button becomes enabled     # single expectation
  - do: Click "Place order"
    expect:                                            # or a list
      - A spinner appears
      - The spinner disappears
expect:
  - The text "Order confirmed" is visible
```

Semantics:

- A step's `expect` is verified **immediately after that step**, before the next step runs. The recording agent is instructed to issue the corresponding `assert` calls right away, so the resulting replay interleaves the assertions at the point where they hold.
- This buys **fail-fast locality**: when an intermediate expectation breaks, the run fails at that step instead of at the end, and the failure points at the step that caused it.
- The top-level `expect` list is unchanged and still required: it holds the final, end-state expectations verified after all steps.
- String and object steps mix freely; `do` carries exactly the same plain-English instruction a string step would.

### Relative urls and baseUrl

`url` may be either an absolute URL (`https://shop.example.com/cart`) or a relative path starting with `/` (`/cart`). Anything else (empty string, `cart`, `shop.example.com/cart`) is rejected.

A relative url is resolved against a **base URL** at navigation time, so the same case runs against any host. The base URL comes from, in order of precedence:

1. `--base-url` CLI flag / `baseUrl` field in the `POST .../runs` body
2. `CASEPILOT_BASE_URL` environment variable (CLI only)
3. `baseUrl:` top-level key in `casepilot.config.yaml` (must be an absolute http(s) URL)

With no base URL configured, a relative-url case cannot navigate; absolute urls always work as-is.

## replay.json

A passing recording writes `cases/<name>.replay.json`:

```json
{
  "version": 1,
  "case": "checkout",
  "url": "https://shop.example.com/cart",
  "providerUsed": "lmstudio",
  "recordedAt": "2026-06-11T14:22:33.000Z",
  "steps": [
    { "kind": "act", "action": "click", "selector": "role=button[name=\"Proceed to checkout\"]", "note": "Click the checkout button" },
    { "kind": "act", "action": "fill", "selector": "role=textbox[name=\"Email\"]", "value": "buyer@example.com" },
    { "kind": "assert", "assert": "textPresent", "text": "Order confirmed" },
    { "kind": "assert", "assert": "urlContains", "text": "/orders/" }
  ],
  "meta": { "healCount": 0 }
}
```

Notes:

- `providerUsed` is the provider id for chat recordings, or the literal `"agent"` when an agent CLI recorded through the browser-tools bridge.
- Only steps that **succeeded** during recording are stored; failed attempts never enter the replay.
- `url` stores the case url verbatim, so a relative case url stays relative in the replay and resolves against the effective base URL on every run. `goto` targets recorded against a relative-url case are re-relativized when they land on the same origin the case url resolved to; cross-origin targets are kept absolute.
- `meta.healCount` increments every time a healed step is written into the replay: on approval under the default `review` heal policy, or immediately under `auto` (see [cli.md](cli.md#casepilot-heals)).

### Step kinds

Every step is either an `act` or an `assert`. All steps may carry a `note` (the human step they implement) and most carry a `selector`, which is a Playwright selector string (`role=button[name="Save"]`, `text="Save"`, or a CSS path).

`act` actions:

| action | selector | value | meaning |
| --- | --- | --- | --- |
| `click` | required | - | click the element |
| `fill` | required | required | click to focus, then fill the input |
| `press` | optional | required | press a key (on the element, or globally) |
| `select` | required | required | select an option by value |
| `goto` | - | URL | navigate (falls back to `selector` as the URL) |
| `scroll` | optional | px (default 600) | scroll element into view, or wheel-scroll |
| `waitFor` | optional | ms | wait for element visible, or sleep up to 5000 ms |

`assert` kinds:

| assert | selector | text | passes when |
| --- | --- | --- | --- |
| `visible` | required | - | element becomes visible |
| `absent` | required | - | element is hidden or gone |
| `textPresent` | optional (default `body`) | required | element text contains `text` |
| `urlContains` | - | required | page URL contains `text` |
| `valueEquals` | required | required | input value equals `text` |

Actions time out after 5 s, navigations after 15 s.

Native dialogs (confirm/alert/prompt) are **accepted** by default during record and replay, so flows behind confirmation dialogs stay drivable (Playwright alone would dismiss them). The policy is the `dialogs: 'accept' | 'dismiss'` field of the library-level `RunOptions`; it is not exposed as a CLI flag.

## How verdicts are computed

A recording's verdict is **not** the model's claim. The rules (enforced in the recorder and in the browser-tools bridge):

1. The provider must call the `report_result` tool. If the turn budget runs out first, the run fails with an explanation saying so.
2. If `report_result` says `passed: false`, the run fails with the model's explanation.
3. If it says `passed: true`, a validation pass checks the executed assertions:
   - at least one assertion must have been executed, and
   - the final attempt of each distinct assertion must have passed.

   If validation disagrees, the verdict is `failed` with `"Provider reported passed, but validation disagrees: ..."`.

Retried attempts at the same step index collapse to one result: the final attempt decides the verdict and earlier attempts show up as a `retries` count on that step. Step indices are unique in `result.json`.

A replay's verdict is simpler: every recorded step must execute successfully (after healing, if enabled). The first unrecoverable failure stops the run with `failed`.

## result.json

Every run leaves `runs/<runId>/result.json` with `case` (and the mirror field `caseName`), `mode`, `verdict`, `explanation`, `steps`, `artifacts` (video, optimized video, replay, screenshots, transcript paths), `startedAt`, and `finishedAt`. Per-step results have `status` of `passed`, `failed`, or `healed` plus `durationMs`, `offsetMs` (from session start, used to seek the run video), an optional `screenshot` file name, an optional `retries` count, and the error text when relevant.
