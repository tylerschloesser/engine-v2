# M39c: Acceptance gap tests

Status: not started · After: 38 (M39's coverage tables at `c02388c`) · Tyler-dependent: no

## Goal
M39's coverage audit (`docs/plan/acceptance/`) found 75 rows with status `gap`: behaviour the code has, or a decision an ADR made, that no test would notice breaking. That is far over M39's budget of about ten gap tests, so they land here, before M39 is ticked. Each gap is closed by **one small test on existing behaviour** that fails if the item stops being true, and the row's status becomes `covered` with the new title cited. No features, no refactors: a gap that turns out to need engine work is reported, not built.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/acceptance/README.md` (row format; `pnpm acceptance:check` is the gate for this milestone)
3. The tables your delegation owns (below). Each `gap` row's Item (and, in some tables, its Evidence cell) states what a small test would assert; that is the starting point, not a spec: read the code before writing the assertion.

Rules that apply: `.claude/rules/determinism.md` for any Rust test touching sim state; `.claude/rules/hot-paths.md` does not apply to tests.

## Scope
**Step 1 (first delegation only): table format.** `pnpm acceptance:check` reports, besides `gap` rows and unticked device checks, about 55 malformed Evidence entries (free text, a `test:` entry with trailing text the parser rejects, a `guard:` without its test) and one test cited in the wrong suite (`reference_subscription_edge_not_predictable`). Fix those in every table so that the check reports only `status is gap` and `device check … is not ticked` lines. Gap rows keep `-` as Evidence. Don't change any status in this step.

**Steps 2-4: close the gaps, one delegation per step.**
- Step 2: the `gap` rows of `spec-*.md`, `adr-0001-0005.md`, `adr-0006-0010.md`, `adr-0011-0015.md`.
- Step 3: the `gap` rows of `adr-0016-0020.md`, `adr-0021-0025.md`, `adr-0026-0030.md`, `adr-0031-0035.md`.
- Step 4: the `gap` rows of `adr-0036-0040.md`, `adr-0041-0045.md`, `adr-0046-0051.md`.

For each row: write the test, prove it can fail (**inject-fail-revert**: break the asserted value or behaviour in the code, or in the config file the test reads, and see the test go red, then restore; one line per test in the report), cite the exact title in the row, set `covered`. Where several rows pin repository configuration (Playwright `workers`, `scripts/suites.mjs` budgets and `first`, `Cargo.toml` profiles, `rust-toolchain.toml`, exact `devDependencies` pins, `.github/workflows/ci.yml`, the SwiftShader branch of `playwright.config.ts`, the engine crate's dependency set, `Cargo.lock` tracked, the Vite plugin's runtime imports), they share one `unit` test file, `scripts/lib/repo-config.test.mjs`, one `test(...)` per decision. Source-scan guards (engine renders no UI of its own, no `vi.mock` outside an allowlist, `getCoalescedEvents` use) follow `sab.no_alloc_syntax`'s style.

**Orchestrator rulings (apply as written; any other row you think cannot be tested is reported, never relabelled by you):**
- The compile-budget rows (`spec-testing.md` R6, `adr-0016-0020.md` 0020 §3 / 0049): `not applicable (measured budget: docs/plan/acceptance/budgets.md, ADR 0049; re-measured by pnpm measure:rebuild)`.
- `spec-client.md` R5a (WASD): the existing `camera: wasd speed scales with extent` compares 0 with 0 when WASD does nothing; fix that test so it asserts movement and direction, inject-fail-revert it, and cite it.
- `spec-runtime-and-packaging.md` R16b (64 MiB default world budget): 0007 §8 defines it as the sum of the default memory split, not as `worldBudgetBytes` (an optional ceiling, `u32::MAX` when unset). The test asserts the computed split of a default `SimConfig` is 64 MiB.
- A row whose behaviour turns out to be wrong (the code does not do what the Requirement or ADR says) is a finding: stop on that row, report it with evidence, and leave it `gap`.

## Non-scope
Engine changes, test-only hooks in production code (a test may use existing test entrypoints and `engine/test`), new device checks, editing any row that is not `gap` except in step 1.

## Files, packages and crates touched
`docs/plan/acceptance/*.md` (rows), `scripts/lib/repo-config.test.mjs` (new), test files beside the behaviour they test in `packages/engine` (`src/**/*.test.ts`, `tests/{wasm,netcode,browser}/**`, `crates/engine/tests/**`, `fixtures/**/tests/**`) and `games/reference` (`sim/tests/**`, `tests/**`). Three packages at most.

## Seams
**Provides:** `scripts/lib/repo-config.test.mjs`; every M39 table with no `gap` row.
**Consumes:** M39's tables and `pnpm acceptance:check` (`c02388c`).

## Planning decisions
- **Suite placement.** `browser` runs 43-44 s of its 48 s budget (ADR 0036) with no demotion left: a new browser test is `@slow` unless it replaces an existing one. Prefer `unit`, `netcode`, `wasm` or `rust`, where every fast test stays under 500 ms p95 (`pnpm test:timings`; ADR 0020 §4).
- **Literal values.** Where a gap is "the constant could change and the test would still pass" (tests that import the constant they check), the new test asserts the literal value from the ADR or spec.

## Order of work
Step 1, then steps 2, 3, 4, each committed per row group (`M39c step N: …`).

## Tests added
One per closed row, named in that row.

## Exit criteria
- [ ] `pnpm acceptance:check` reports no `gap` row and no format problem; the only remaining lines are unticked device checks (M39 owns those).
- [ ] Every new test has an inject-fail-revert line in its step report.
- [ ] Fast-tier suites inside budget (`pnpm test:timings`), no new fast test over its p95 limit.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm acceptance:check` · `pnpm test unit -t repo-config` · `pnpm test:timings` · `pnpm test` · `pnpm lint`

## Budgets
Suite budgets (ADR 0048); per-test p95 (ADR 0020 §4).

## Context artifacts
None.

## Manual device checks
None.

## Deviations
(Steps 1-2, first delegation.)
- **Step 1.** Every gap row now carries `-` as Evidence; the auditor's prose (what a test would assert) moved to the end of the Item cell after ` Gap: ` and is stripped when the row closes. A trailing `)` of a parenthetical note on a few steps 3-4 rows was lost in that move (cosmetic). Doc tests are not `#[test]` titles, so 0006 range / 0010 tick cite three new runtime tests (`tick_rate_hz_below_10_panics`, `tick_rate_hz_above_60_panics`, `tick_rate_hz_accepts_10_and_60`, `time.rs`). `reference_bindings_have_no_bigint` is a `describe` whose tests are named after the generated files, so it is cited as `reference_bindings_have_no_bigint > file` (how `vitest list` prints it).
- **Step 2 findings (rows left gap):** 0009 Message classes (no per-type class tag exists in code: only `MsgClass` on `Connection.send`, production sends everything `ReliableOrdered`); 0013 Identity (max_players) and the maxPlayers part of 0009 WorldConfig defaults (default 8 equals `MAX_CONNS` = 8, so a 9th connection finds no slot and `SimHost.accept` throws, `attachWebSocketServer` closes it with `CloseCode.Full`; the `Reject{Full}` branch is unreachable at the default). Its other defaults are pinned (`default_action_rate_is_20_per_second_burst_40`, `sim-config: the default sim arena is 96 MiB`, `sim_config_defaults_are_the_0007_section_8_figures`).
- `default_memory_split_is_64_mib`: `Host::init` uses the real `size_of::<Entity>()`, so the default split is 64 MiB only for a 128 B entity; the test pins the sum for the fixture's real size and asserts the 128 B arithmetic literally.
- `scripts/lib/repo-config.test.mjs` now holds: Cargo.lock tracked, engine crate dependency set, vite plugin runtime imports and package peers, fast-tier budget under a minute, CI workflow, SwiftShader branch. Steps 3-4 add to it.
- **Step 5 (row `0042 §3 (frame again)`).** `mp/welcome_frame_same_wake @slow` (`tests/browser/welcome-frame.spec.ts`, page `pages/welcome-frame.html` + `src/welcome-frame.ts`; browser suite, slow tier). No production hook: the server's `Welcome` waits for a server tick (`manualTimer`), so the page parks the client worker once its `Hello` is on the uplink ring, the spec ticks the server until the `Welcome` is in the downlink ring, then the page bumps one `CB_FRAME_REQ` (`writeCameraAndWake`) and `resumeWorkers`: `Welcome` and frame request share one wake. It reads the gen request ring's `pushed` counter at that wake's ack (gen workers spawned an hour late via `test.genSpawnDelayMs`). Inject-fail-revert with `if (false && framedThisWake)` in `worker/client.ts` `onConfigured`: `FAIL browser [chromium] mp/welcome_frame_same_wake @slow ... Expected: > 0, Received: 0`; green when reverted (3.9 s).
