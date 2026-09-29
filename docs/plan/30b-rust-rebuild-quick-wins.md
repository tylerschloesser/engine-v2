# M30b: Rust rebuild time, simple options only

Status: not started · After: 30 · Tyler-dependent: partly (a macOS setting only Tyler can change; everything else runs without him)

Written by the orchestrator at M30's gate, at Tyler's request (2026-09-29): "investigate speeding up the rust build. I only want to consider simple options and/or quick wins. I'd prefer a long build over complexity." **That sentence is this brief's governing rule.** A change that makes the build faster but the repo harder to understand is out of scope, however large its payoff.

## Goal
We know why a one-line edit in `packages/engine/crates/engine/src/` now costs 208-494 s before the first suite starts, when it cost 54-58 s on 2026-09-26 (deferred-ledger row "After any engine-crate change `pnpm test` spends ~147 s…"). Every simple fix that measurably helps is applied. Everything else is written down as rejected, with the reason.

## What is already known
- M24c attribution (its Deviations): compile + link is ~27-30 s. The rest was macOS's first-launch security check on each freshly linked test binary (~1.2-3 s each, 67 binaries then), all executed by the fixtures step's `--workspace` bindings run (`BINDINGS_CARGO_ARGS`, `packages/engine/src/build-game.ts`).
- Tyler enabled macOS Developer Tools for his terminal. Re-measured 2026-09-26: 54-58 s wall (`fixtures` 38-40 s, `reference` ~7 s, `doctests` ~4.7 s).
- This session measured `build WARN 226s/10s (fixtures 208s)` on the first `pnpm test`, and `518s (fixtures 494s)` after M30 step 2 added one Rust test binary. The machine is shared with other sessions (check `uptime` before each timing).
- `--workspace` on the bindings step is deliberate (M17d; pinned by `scripts/lib/build-game-bindings-scope.test.mjs`). M24c showed `--lib` only moves the cost into `cargo-tests`.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0020-testing-strategy.md` (§3, the compilation paragraph) and `docs/decisions/0033-fast-tier-budget-after-build-fix.md`
3. `docs/plan/24c-engine-edit-rebuild-time.md` (Deviations: the attribution method and the consolidation pattern)

## Scope
Candidates, in this order. Measure each before and after, and keep only what helps:
1. **Explain the regression first.** Is the first-launch check back? Measure one freshly linked binary's first and second `--list` run, as M24c did. Check whether Developer Tools is still on for the app that actually runs the builds. A Claude Code session may run under a different parent app than the terminal Tyler enabled; `sudo spctl developer-mode enable-terminal` covers only Terminal. Also check whether the binary count, machine load or anything else moved. If the fix is a macOS setting, you cannot change it: write the exact steps for Tyler under Deviations and report it.
2. **Cargo profile settings only**, for example `debug = "line-tables-only"` or `debug = 0` for dependencies under `[profile.dev]`/`[profile.test]`. Keep a setting only if it measurably helps and backtraces still show file:line.
3. **Fixture test-binary consolidation**, the ledger's named next step, using M24c's existing `tests/main.rs` + `mod` pattern and guard. Do it only if step 1's numbers show the binary count still dominates *after* any macOS fix, and it is pure file moves. Otherwise record it as rejected with the measured payoff it would have had.

## Non-scope
Anything that adds a tool, a moving part or a concept: sccache, a shared target dir, alternative linkers, the Cranelift backend, nightly flags, `cargo-hakari`-style workspace hacks, splitting or merging crates, changing the build-step pipeline or `BINDINGS_CARGO_ARGS`, CI caching. Changing what any test asserts. Changing 0020 §3's 30 s budget: if it stays out of reach, record the floor and stop; the ADR is the orchestrator's.

## Files, packages and crates touched
Root `Cargo.toml` (profiles), fixture crates' `tests/` only under candidate 3, `scripts/lib/engine-test-binary-layout.test.mjs` (or a sibling guard) only under candidate 3.

## Seams
**Provides:** none. **Consumes:** M17d's build steps, M24c's guard and consolidation pattern.

## Planning decisions
1. **Simplicity beats speed** (Tyler, above). When in doubt, reject and record.
2. **Timing discipline.** Every timed run carries its `uptime` line. The command is `touch packages/engine/crates/engine/src/lib.rs && pnpm test unit`, three runs per data point. A run at a 1-minute load above ~8 is discarded and re-taken. No wall-clock tests (17d fix round 1).
3. **Test list unchanged.** Sorted `cargo nextest list --workspace` has the same count before and after, and no test body changes (M24c Planning decision 1).

## Order of work
1. Baseline and regression attribution (no code change). 2. Apply the kept candidates, re-measuring after each. 3. Final three-run measurement and a warm `pnpm test`.

## Tests added
None, unless candidate 3 is taken; then extend the binary-layout guard and show it failing on a stray file.

## Exit criteria
- [ ] Deviations hold the baseline, the regression's cause (or what was ruled out) and a before/after table per candidate, each with `uptime`.
- [ ] Every candidate is applied or rejected, each with a one-line reason; any macOS step for Tyler is written out exactly.
- [ ] The sorted `cargo nextest list --workspace` count is unchanged.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`touch packages/engine/crates/engine/src/lib.rs && pnpm test unit` (×3, before and after) · `cargo nextest list --workspace | sort | wc -l` · `pnpm test` · `pnpm lint`

## Budgets
0020 §3 compilation budget (≤ 30 s from a one-line Rust edit to tests starting): measured, not necessarily met.

## Context artifacts
If a profile setting or consolidation lands: one line in `packages/engine/crates/engine/CLAUDE.md` saying what was chosen and why.

## Manual device checks
none

## Deviations
(filled in during Phase 3)
