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
- `meta.healCount` increments every time the healer rewrites a step; the healed replay is saved back to disk.

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

## How verdicts are computed

A recording's verdict is **not** the model's claim. The rules (enforced in the recorder and in the browser-tools bridge):

1. The provider must call the `report_result` tool. If the turn budget runs out first, the run fails with an explanation saying so.
2. If `report_result` says `passed: false`, the run fails with the model's explanation.
3. If it says `passed: true`, a validation pass checks the executed assertions:
   - at least one assertion must have been executed, and
   - the final attempt of each distinct assertion must have passed.

   If validation disagrees, the verdict is `failed` with `"Provider reported passed, but validation disagrees: ..."`.

A replay's verdict is simpler: every recorded step must execute successfully (after healing, if enabled). The first unrecoverable failure stops the run with `failed`.

Per-step results in `result.json` have `status` of `passed`, `failed`, or `healed` plus `durationMs` and the error text when relevant.
