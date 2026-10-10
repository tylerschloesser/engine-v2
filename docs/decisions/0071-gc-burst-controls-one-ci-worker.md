# 0071: Gc burst controls on CI run on one worker

Status: Accepted (2026-10-10). Amends [0068](0068-phase-3-decisions-testing-and-tooling.md) §14 (CI's `gc`/`gc-reference` worker count) and the CI entry of its §6 list of known intermittents.

## Context

0068 §14 capped the `gc` and `gc-reference` Playwright projects at 2 workers on CI (`ENGINE_GPU=swiftshader`) after burst negative controls timed out against the 90 s `gcTimeoutMs`, and said: if CI times out again, first try fewer workers, then profile; never raise `gcTimeoutMs`. §6 listed CI `[gc] ... neg burst sim @slow` as an intermittent not to chase on a first recurrence. On 2026-10-10 the slow tier went red on a `neg burst sim @slow` control (`drawables` four times, `connected-terrain` once, `reference_single_player` once) on 5 of the 6 pushes to `main`, and twice in a row on `ef57973b` (a timeout inside a measured window). It is no longer intermittent.

## Decision

**CI runs the `gc` and `gc-reference` projects with 1 worker each** (`packages/engine/playwright.config.ts`, `gcWorkers`). `gcTimeoutMs` (90 s on CI) and every budget stay as they are. Locally nothing changes (no worker cap on the Mac).

## Alternatives rejected

- **A longer `gcTimeoutMs`.** 0068 §14: never; a slower control is a signal, not a number to absorb.
- **Profile first.** 0068 §14 orders fewer workers first; profiling a control on a Linux SwiftShader runner is the next step if one worker still times out.

## Consequences

- The slow tier's browser suite on CI takes longer (the gc controls run one at a time per project).
- Trigger to revisit: a `neg burst` timeout on CI with one worker. Then profile one control on a Linux SwiftShader runner (a `workflow_dispatch` job), as 0068 §14 says.

## Sources

- CI runs 38069934191, 38071296507, 38077551375, 38081595716, 38083462126 (and its rerun), 2026-10-10; the one green run in that span, 38072962400.
