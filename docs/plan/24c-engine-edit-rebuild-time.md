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

**Environment note.** This session started on a machine that had just rebooted (Tyler's Mac restarted mid-run); the coordinator's resume message had this session wait for the 1-minute load average to drop under 5 before measuring (it settled at `8:10`, load `4.55`). Every timed run below has its own `uptime` line.

**Step 1: attribution (no code change).**

- Baseline reproduced fresh, three `touch crates/engine/src/lib.rs; pnpm test unit` runs (discarding one post-reboot run first): 233.75s (`fixtures` 212s), 206.47s (`fixtures` 191s), 211.06s (`fixtures` 195s), 214.49s (`fixtures` 198s) -- consistent with the brief's own ~188s figure and M24b's gate measurement; the `fixtures` build step (which runs `exportBindings`'s `cargo test --workspace --color never export_bindings`, `BINDINGS_CARGO_ARGS`) is where nearly all of it lands, matching the brief exactly.
- `cargo test --workspace --timings --color never export_bindings` after a fresh touch: wall `3:05.31` (185.31s), but cargo's own self-reported compile+link finish was **26.81s** (`Finished` line) -- compilation is not the problem, confirming 0033's own finding still holds. `cargo test --workspace --no-run` (build only, no test execution at all) on a separately fresh touch: **30.1s** wall, 400% CPU -- so linking every unit is also fast and well parallelized.
- The gap is in *executing* the built test binaries, not building them. `grep -c "^     Running" ` on the full run's log: **80 units** run (up from M17d/0033's 40 -- the workspace has grown: 13 fixture crates now, `crates/engine` alone has grown to 25 `tests/*.rs` files). Direct isolation, on a binary built fresh by `--no-run` and never yet executed: `time ./target/debug/deps/no_alloc_codec-* --list` -- **first run 1.246s**, second run **0.007s**, third **0.006s**. Ten such binaries run serially: **29.415s** (≈2.94s/binary). This is macOS's per-binary, one-time, first-execution security/code-signing verification (0033's own finding, re-confirmed and localized more precisely here to *first execution*, not link time: a `--no-run` build of 80 fresh binaries costs only 30.1s, with no execution at all -- the tax is paid on first *launch*, not at the linker).
- Two alternatives were measured and rejected before the fix below, because they only move the cost between build steps rather than removing it: (a) restricting `exportBindings` to `cargo test --workspace --lib` (skip `tests/*.rs` targets entirely for that one invocation) took the bindings step itself down to 44.77s, but the very next build step (`cargo-tests`, `cargo nextest run --workspace --no-run`) then had to build+first-list the ~66 binaries the `--lib` step never touched, at **107.74s** (`CARGO_LOG` confirmed no genuine re-dirtying: cargo's own `Finished ... in 26.27s` line, so the other ~81s is the same per-binary first-invocation tax, now paid by nextest's own internal listing pass instead) -- net pipeline time is not improved, since `scripts/suites.mjs` runs build steps serially. (b) Running 15 fresh, never-executed binaries in parallel (backgrounded shell jobs) instead of serially: 20.03s, vs a serial projection of ~44s for the same 15 at the ~2.94s/binary rate -- real but partial (~2x) parallelism, not enough on its own (macOS's own verification service is shared/partially serialized across processes). **Conclusion: the only lever that reduces the total, pipeline-wide first-execution tax is reducing the total number of distinct test binaries in the workspace** -- consolidating `tests/*.rs` files, exactly what 0033 named and the brief's Scope leads with.

**Step 2: the fix.** `crates/engine/tests/` had 25 top-level files: 10 `no_alloc_*.rs` (each installs its own `#[global_allocator]`, checked individually -- Rust allows exactly one per binary, so these can never share one) and `runner_control.rs` (the runner's permanent negative control, deliberately left alone) must stay their own binaries; the other 14 (`action_round_trip`, `codec`, `connection_and_subscriptions`, `gen_queue`, `module_layering`, `state_budget`, `state_budget_tick`, `timers_wakeups`, `undo_journal`, `wgsl`, `world_cache_invisible`, `world_terrain`, `worldgen_core`, `worldgen_noise`) had no such reason (checked each for `set_force_release_audit_for_test`, statics/`OnceLock` and found only ordinary, self-contained ones: `state_budget.rs`'s audit-flag toggle and `timers_wakeups.rs`/`undo_journal.rs`'s `OnceLock<SystemId>` caches -- none is process-*shared* state across tests, and nextest already runs every `#[test]` in its own process regardless of which binary it's compiled into, so none of this is an isolation hazard from merging). They moved to `tests/main/*.rs` unchanged, pulled into one new `tests/main.rs` with `#[path = "main/<name>.rs"] mod <name>;` per file (`include!`, which would have kept every test's bare qualified name unchanged, was tried first and rejected: several of these files independently define same-named top-level helpers -- `dims`/`FlatSource`/`params`/`loopback`/`add_client`/`small_camera` in both `action_round_trip.rs` and `connection_and_subscriptions.rs`; `ZeroSource` in three files; `VecSink` in three files; `genesis` in three files -- which collide when spliced into one flat namespace; `mod` per file, "the standard Cargo pattern" the brief names, avoids this by construction). `Cargo.toml`'s ten per-file `[[test]] required-features = ["testing"]` entries for the moved files collapse into one `[[test]] name = "main" required-features = ["testing"]`; `no_alloc_connection`/`no_alloc_ui`/`no_alloc_drawlist` keep theirs.

Binary count for `crates/engine`: **26 -> 13** (1 `engine` lib unittest binary + 10 `no_alloc_*` + `runner_control` + `main`, down from 1 + 25).

**Test-list equality (Planning decision 1).** `cargo nextest list --workspace` sorted: **552 lines before, 552 after** -- identical total. `engine::` lines: **112 before, 112 after** -- identical. The raw per-line diff is *not* empty (expected: the "standard Cargo pattern" the brief names inherently changes each moved test's reported binary column, and -- since these particular files can't share a flat namespace -- also adds a `<file>::` module-path segment to its test path; both are mechanical, not a change to any test's name or body). Proved this precisely rather than asserting it: normalizing the *before* list by rewriting `engine::<one of the 14 old names> ` to `engine::main <old name>::` and re-sorting produces a **byte-for-byte empty diff** against the *after* list (`diff` exit 0, both files 552 lines) -- every one of the 97 moved test lines accounts for exactly that one rename, nothing else changed, nothing added or dropped. No test body was touched (`git diff` of each moved file is empty besides the file move itself).

**Step 3: guard test.** `scripts/lib/engine-test-binary-layout.test.mjs` (`unit` suite): reads `crates/engine/tests/`'s directory listing and asserts the top-level `*.rs` files are exactly `{main.rs, runner_control.rs, the 10 no_alloc_*.rs}` -- deterministic, no cargo call, no wall clock (17d's first, timing-based guard failed on legitimate compilation; this one can't). Proved failing: adding `tests/stray_test_file.rs` made it report `expected Set{ 'main.rs', …(12) } to deeply equal Set{ 'main.rs', …(11) }`; removing it passes again.

**Step 4: final measurement.** Three `touch crates/engine/src/lib.rs; pnpm test unit` runs after the fix:

| run | uptime (1/5/15 min load) | wall | `fixtures` step |
|---|---|---|---|
| 1 | `8:58`, 15.5/7.3/6.6 | 146.16s | 129s |
| 2 | `9:00`, 20.3/11.2/8.2 | 147.37s | 130s |
| 3 (first attempt) | `9:04`, background-timeout at 300s | 300.46s | -- |
| 3 (replacement, 1-min load re-settled to 4.32) | `9:08`, 4.3/9.8/9.9 | 272.35s | 256s |

Runs 1-2 (146-147s, `fixtures` ~130s) are the reliable, back-to-back post-fix figures: down from the pre-fix 206-234s (`fixtures` 191-212s), a genuine ~25-30% cut, tracking the 13-binary reduction. Both run-3 attempts are far slower despite a *settled 1-minute* load average -- `ps -eo pid,pcpu,comm -r` at `9:15` found `mediaanalysisd` (macOS's post-reboot media/Spotlight reindexing, the same class of process the coordinator's resume message named) at **334% CPU**, contending for the same cores cargo's own linker/codesign work needs; 1-minute load recovers faster than this background indexing finishes, so a settled 1-minute average did not mean a quiet machine this time. This is a real, external confound, not a regression from this milestone's own change (confirmed by a subsequent warm, no-change `pnpm test` at `9:14`, load still 76.88/39.51/16.55: exit 0, every suite green, no build WARN).

**30s is not reached (Planning decision 2).** The floor after this fix is **~146-150s quiet-machine, one-line-edit rebuild** (worse under the post-reboot indexing load above). Cause, precisely: the workspace still has **67 distinct test binaries** (80 before this fix, minus the 13 consolidated away), each paying macOS's ~1.2-3s one-time first-execution verification tax somewhere in the build pipeline (Step 1's attribution); compilation itself remains fast and well parallelized (~27-30s) and is not the constraint. Reaching 30s would require cutting the total binary count roughly another 5-6x (to ~12-15 workspace-wide), which means consolidating the fixture crates too (`reference-sim` 10 files, `fx-persist` 7, `fx-presence` 5, `fx-machines` 5, `fx-puts` 4, `fx-worldgen` 3, `fx-panicky` 2 -- 43 of the workspace's 80 binaries are fixtures, more than `crates/engine`'s own 25) -- named in Scope as conditional ("if they are part of the cost": they are, more than `crates/engine`'s own tests were) but not done in this milestone, both because 30s is unreachable even with full consolidation (an estimated ~37-binary floor still projects to roughly 100s, not 30s, by the same per-binary rate) and because of this session's own time budget after the reboot interruption and the extensive attribution work above. Recorded here per Planning decision 2 rather than chased further; a changed budget, if Tyler wants one, is the orchestrator's ADR to write, not this milestone's.

**Verification.** `pnpm test` (warm, no source change), second of two consecutive runs, `9:14`: `rust pass 551 tests 1.1s/10s`, `unit pass 252 tests 2.2s/3s`, `wasm pass 147 tests 2.6s/7s`, `browser pass 201 tests 44s/48s`, exit 0 -- the same suite counts as the delegation's stated green baseline (rust 551, wasm 147, browser 201) plus one (unit 252 = 251 + the new guard test). `pnpm lint`: `biome pass`, `rustfmt pass`, `clippy pass 26s`, `tsc pass`, exit 0.
