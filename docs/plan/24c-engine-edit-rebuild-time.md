# M24c: Engine-edit rebuild time back inside 0020 §3

Status: not started · After: 24b · Tyler-dependent: no (Tyler approved the milestone, 2026-09-26)

Written by the orchestrator at M24b's gate (deferred ledger row "After any engine-crate change `pnpm test` spends ~170 s building"). Same shape as M17d: attribute first, fix what the attribution names, re-measure.

## Goal
A one-line edit in `packages/engine/crates/engine/src/` reaches the first suite starting in ≤ 30 s on Tyler's Mac (0020 §3, "Compilation is budgeted separately"). Today it takes ~188 s: measured by `touch crates/engine/src/lib.rs; pnpm test unit`, with the `fixtures` build step at 173.5 s. The time is known per build step and per test binary, and a test keeps the fix from regressing silently.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0020-testing-strategy.md` (§2, §3 including the compilation paragraph) and `0033-fast-tier-budget-after-build-fix.md`
3. `docs/plan/17d-fast-tier-wall-time.md` (Goal, Planning decisions, Deviations: the rebuild ping-pong it fixed and why `BINDINGS_CARGO_ARGS` is `--workspace`)
4. `packages/engine/crates/engine/CLAUDE.md` (test placement)

## What is already known (measured at M24b's gate)
- After touching `crates/engine/src/lib.rs`, `test-results/build/fixtures.log` reads `puts … cargo 676ms bindings 162800ms`; every other fixture's `cargo` step is under 1.4 s, and `cargo-tests` then takes 1.0 s.
- The bindings step is `cargo test --workspace --color never export_bindings` (`BINDINGS_CARGO_ARGS`, `packages/engine/src/build-game.ts`). It is `--workspace` on purpose, so it shares fingerprints with the `cargo-tests` step and the two stop rebuilding each other (M17d; pinned by `scripts/lib/build-game-bindings-scope.test.mjs`). **Dropping `--workspace` is therefore not the fix.** The 163 s is the whole workspace's test build (every crate's unit and integration test binaries, every fixture crate), landing in whichever step runs first.
- Warm runs are unaffected (`fixtures` 2.0 s, `doctests` 2.6 s).

## Scope
- Attribution: `cargo build --timings` (or `-Z`-free equivalents) on exactly the test build the pipeline runs, after a one-line engine edit. Record per-unit compile and link time, the number of test binaries per crate, and how much is codegen vs linking. Record the table under Deviations.
- Fix whatever the table names, most likely among: consolidating integration-test files into one binary per crate (a `tests/main.rs` with `mod` files, the standard Cargo pattern), trimming test-profile debug info or codegen settings for test builds (`[profile.test]` / `debug = "line-tables-only"` or similar), a faster linker if one is available without new tooling (say what `setup:tools` would need), and anything specific the attribution shows.
- A guard: a deterministic test that pins whatever structural property the fix relies on (for example, "each crate has at most one integration-test binary"), in the style of `build-game-bindings-scope.test.mjs`. It must not be a wall-clock test (17d fix round 1: timing tests fail on legitimate work).
- Re-measure: the same `touch` + `pnpm test unit` command, three runs, and a warm `pnpm test` to show nothing else moved.

## Non-scope
Cold builds and CI cache (0020 §3 budgets them separately). The `wasm32` fixture builds, which are already under 1.4 s each. sccache or a shared `CARGO_TARGET_DIR` for worktrees (0020 Consequences, deferred). Any change to what a test asserts.

## Files, packages and crates touched
`packages/engine/crates/engine/tests/**` and `Cargo.toml` (test layout, profiles), fixture crates' `tests/` if they are part of the cost, `packages/engine/src/build-game.ts` only if the attribution names it, `scripts/` (guard test, `suites.mjs`).

## Seams
**Provides:** a documented rebuild time and the guard test. **Consumes:** M17d's build steps and `BINDINGS_CARGO_ARGS` scope rule, `scripts/suites.mjs`.

## Planning decisions
1. **Moving test files is allowed; changing them is not.** Consolidating integration tests changes paths and module wiring only. Every test keeps its name and body. `cargo nextest list` before and after must name the same tests (compare the sorted lists), and nextest's per-test process isolation must not be relied on by any test that moves (check for tests that use process-global state: the counting allocator, `set_force_release_audit_for_test`, arena statics). A test that needs its own process stays in its own binary, with a comment saying why.
2. **If 30 s is out of reach,** get as close as the attribution allows, record the floor and what sets it, and stop: a changed budget is an ADR the orchestrator writes, not this milestone's.

## Order of work
1. Measure and attribute (no code change). 2. Apply the cheapest fixes in order of measured payoff, re-measuring after each. 3. Guard test. 4. Final measurement.

## Tests added
The guard test (named in Deviations). `cargo nextest list` equality before/after, pasted as a count plus the diff (empty).

## Exit criteria
- [ ] The attribution table (per step, per test binary, compile vs link) is in Deviations.
- [ ] `touch packages/engine/crates/engine/src/lib.rs && pnpm test unit` reaches the suite in ≤ 30 s (three runs pasted), or the floor and its cause are recorded per Planning decision 2.
- [ ] The test list is unchanged (sorted `cargo nextest list` diff empty); no test body changed.
- [ ] The guard test exists and was shown to fail when its structural property is violated.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`touch packages/engine/crates/engine/src/lib.rs && pnpm test unit` (×3) · `cargo nextest list --workspace` before/after · `pnpm test` · `pnpm lint`

## Budgets
0020 §3's compilation budget (≤ 30 s, one-line Rust edit to tests starting).

## Context artifacts
If integration tests are consolidated: one line in `packages/engine/crates/engine/CLAUDE.md` (and any fixture `CLAUDE.md` affected) saying where a new integration test goes and why.

## Manual device checks
none

## Deviations
