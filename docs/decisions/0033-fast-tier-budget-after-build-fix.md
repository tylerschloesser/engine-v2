# 0033: Fast tier budgets, re-divided after the build fix: 10 s build, 35 s browser

Status: Accepted (2026-09-23). Amends [0020](0020-testing-strategy.md) §3 (the suites-and-budgets
table and its "55 s if run serially" line). Implemented in milestone M17d.

## Context

[0020](0020-testing-strategy.md) §3 set `buildBudgetMs` at 30 s and the `browser` suite's budget at
25 s from a planning estimate, before any of it was measured (§3's own Consequences: "measuring the
30 s rebuild target and the per-suite numbers... deferred to Phase 3, because no code exists to
measure"). By M17d, `pnpm test` on a warm tree with no source change actually cost 35-42 s of build
(`build WARN`) plus 23-24 s for the `browser` suite -- 58-66 s serially, over Tyler's one-minute
requirement (`docs/spec/testing.md`).

**Two build-step problems, both now fixed with a named, reproducible cause.**

**1. The `fixtures`/`cargo-tests` rebuild ping-pong** (M17d steps 2-3). `exportBindings`'s own
`cargo test` (`packages/engine/src/build-game.ts`) ran scoped to one package (`-p`, implicit from
its working directory), while the `cargo-tests` build step ran `cargo nextest run --workspace
--no-run`. `CARGO_LOG=cargo::core::compiler::fingerprint=info` named the dirty reason:
`UnitDependencyInfoChanged` on the crate's own `serde` dependency edge, every time the scope
switched between the two -- confirmed to be about *package-selection scope alone*, not env (the
original suspect, `TS_RS_EXPORT_DIR`, was ruled out by passing it the *identical* value under both
scopes and still seeing the dirty fingerprint). Fixed: `exportBindings` now runs `--workspace` too.

**2. A second, independent cause of the same symptom, found in fix round 1** (the orchestrator measured `build
WARN 15s/15s` on two consecutive quiet-machine runs after 1 above landed). Attributed precisely:
`packages/engine/tests/wasm/plugin-dev.test.ts`'s `"touch triggers rebuild and full-reload"` test
calls `utimes(fixtures/hash/src/lib.rs, now, now)` to simulate a file-watcher touch for Vite's
dev-rebuild path -- a **real fixture source file**, not a copy, and the mtime was never restored
afterward. `CARGO_LOG` on the very next `pnpm test`'s `cargo-tests` step named it exactly:
`FsStatusOutdated(StaleItem(ChangedFile { reference: ".../fx-hash.../dep-test-lib-fx_hash",
reference_mtime: T0, stale: ".../fixtures/hash/src/lib.rs", stale_mtime: T1 > T0 }))` -- cargo saw
the *untouched-in-content* source file as newer than its own fingerprint and recompiled `fx-hash`,
every time the `wasm` suite (which runs concurrently with `unit`/`rust`/`browser`, so this fires on
every ordinary `pnpm test`) ran before the next build. Fixed: the test now records the file's mtime
before touching it and restores it in a `finally`, pass or fail (`packages/engine/tests/wasm/
plugin-dev.test.ts`).

**Measured** (Tyler's Mac, warm, no source change, `test-results/build/timings.json`, three
consecutive full `pnpm test` runs after both fixes):

| step | before (M17d's original evidence) | after both fixes |
|---|---|---|
| `tsc` | 0.5 s | ~0.4 s |
| `fixtures` | 15.9 s | ~0.87-0.89 s, consistently, including immediately after the `browser` suite |
| `cargo-tests` | 15.9 s | ~0.19-0.20 s, consistently |
| `doctests` | 5.7 s | ~4.2-4.4 s (unchanged; a `compile_fail` doctest re-pays a real rustc invocation every run, by design -- not part of either fix) |
| `pages` | 0.6 s | ~0.6 s |
| **total build** | **35-42 s** | **~6.3-6.5 s, repeatably, including right after `browser`** |

`browser` (unchanged by this milestone, from M17d's own evidence and [0031](0031-browser-suite-five-workers.md)): 23-24 s quiet, 29 s under `node scripts/repeat.mjs browser 8 --load 10`.

**3. The 30 s incremental rebuild** (`docs/spec/testing.md`), from a one-line comment added to
`crates/engine/src/lib.rs`, then `pnpm test`'s build. **This one is not reachable within 30 s in
this milestone, with a precise, measured cause** -- attributed with `cargo test --workspace
--timings` (cargo's own per-unit compile profiler, not a guess) plus direct process sampling during
the slow window, not folded into a budget (nothing in `scripts/suites.mjs` measures this figure):

- One cargo invocation dirties (`exportBindings`'s own `cargo test --workspace ... export_bindings`,
  the first of the build's cargo invocations to touch the changed `engine` crate). Rust's rlib model
  means every crate that depends on `engine` -- not just its lib, every one of its own *test
  binaries* -- must recompile and relink, because `--workspace` makes every workspace member a
  build target: `engine`'s own lib (2 units) + **19 separate `tests/*.rs` integration-test files,
  each its own compiled binary** (22 units total for `engine` alone) + the 5 fixtures' own libs and
  test binaries (18 more units). **40 units in total.**
- `cargo --timings`'s own report (`target/cargo-timings/cargo-timing.html`, embedded `UNIT_DATA`):
  213.7 s of aggregate per-unit compile time, but a **17.55 s wall-clock** finish (matching cargo's
  own repeatedly-observed "Finished ... in 17.2-17.6 s" line exactly) -- already well parallelized,
  about 12x over serial, close to this Mac's 14-core ceiling. **Compilation itself is not the
  problem** and is comfortably inside the 30 s target on its own.
- The gap between that 17.55 s and the observed **~150 s wall-clock** (`time`'s own report on the
  real command, repeated across several isolated measurements: 140-215 s) does not appear anywhere
  in cargo's own build-graph timing. Sampling `ps` every 2 s for the whole run's duration found
  `com.apple.CodeSigningHelper.xpc` (`/System/Library/Frameworks/Security.framework/...`) active in
  the large majority of samples: **macOS's mandatory ad-hoc code-signing of every freshly linked
  Mach-O executable on Apple Silicon**, one operation per one of the 40 binaries this rebuild
  produces. This is enforced by the OS, not by cargo, rustc or this repo's build scripts, and it is
  outside anything `pnpm test`'s Node-level orchestration touches.
- Tried and measured, not adopted: `[profile.test] debug = 0` (repo-wide). Shrank one representative
  test binary by only ~9% (996,848 -> 907,536 bytes) -- signing cost did not track binary size
  closely enough to be worth changing debug-info quality for every native test, repo-wide, for this.
- **What would actually cut it**: fewer separately-signed binaries, i.e. fewer of `crates/engine`'s
  own `tests/*.rs` files (each is its own compiled+linked+signed unit) -- consolidating them would
  cut signing operations roughly proportionally. That is a test-content/organization change
  (`tests/*.rs` file count and shape), outside this milestone's Non-scope line ("changing test
  content"), and it trades per-file test isolation for build speed. **Not decided here:** the machine setting that likely removes the
  scanning cost is Tyler's (`questions-for-tyler.md` Q14), and consolidating test files is the
  orchestrator's fallback if it doesn't.

## Decision

**1. `buildBudgetMs` (`scripts/suites.mjs`): 30,000 → 10,000.** With both build-step causes fixed,
the warm build measures ~6.3-6.5 s repeatably, including immediately after the `browser` suite;
10,000 leaves comfortable margin (~50%) without being so loose that a real regression toward either
fixed ping-pong (15-17 s per affected step) could pass unnoticed -- the existing WARN-at-budget/
FAIL-at-1.5x-budget classification (`scripts/lib/report.mjs`'s `classifyBudget`) still fails clearly
above 15,000.

**2. `browser` suite budget (`scripts/suites.mjs`): 25,000 → 35,000.** The build no longer eats most
of the one-minute budget, so the suite that was always the fast tier's real bottleneck gets the room
this milestone's Goal asks for ("so M18 and later milestones have room for fast browser tests"):
build (10 s) + browser (35 s) = 45 s, a 15 s margin under Tyler's 60 s requirement even at both
budgets' own ceiling simultaneously -- today's actual wall time (~6.5 s build + 23-29 s browser,
30-36 s measured) sits comfortably inside that with room to spare. `rust` (10 s), `unit` (3 s) and
`wasm` (7 s) are unchanged: neither this milestone's fix nor its Goal touches them, and none was
ever the bottleneck (0020 §3's own table).

**3. The 30 s incremental-rebuild target is not met and is not addressed by a budget here.**
Nothing in `scripts/suites.mjs` gates on it (it is a spec target verified by hand, `docs/spec/
testing.md`, not a suite budget), and the true, measured cause (macOS's own per-binary code-signing,
§Context) is outside what a checked-in number or this milestone's build-orchestration code can move.
The true figure (~150 s, attributed) replaces M17d's original, wrong guess (session-local
target-directory bloat, unsupported by any `cargo clean` measurement and withdrawn here).

## Alternatives rejected

- **Leaving `browser`'s budget at 25,000.** Meets the one-minute requirement today with an even
  wider margin, but does nothing for the Goal's stated purpose (room for M18+); the whole point of
  fixing the build was to free budget for the suite that actually needs it.
- **Splitting the freed build-budget margin across `rust`/`unit`/`wasm` too.** None of the three is
  near its own budget (0020 §3's table: 10 s / 3 s / 7 s against sub-2.5 s measured every one), and
  they run in parallel with `browser` -- raising their budgets would not change the fast tier's wall
  time, only hide a real regression in one of them later.
- **`[profile.test] debug = 0` (or similar) to cut code-signing cost.** Measured: ~9% smaller
  binary, not enough to expect a meaningful signing-time win, at the cost of debug-info quality for
  every native test in the repo. Not worth it for an unproven, marginal gain.
- **Consolidating `crates/engine`'s `tests/*.rs` files to cut the number of signed binaries.** The
  one lever that would actually move the number, deliberately not taken here: it changes test
  content/organization (this milestone's own Non-scope line) and trades file-level test isolation
  for build speed -- Tyler's call, not this milestone's.

## Consequences

- `docs/plan/17d-fast-tier-wall-time.md` Deviations has the step-by-step measurements this ADR
  rests on, including both build-step fixes' own before/after numbers and the incremental-rebuild
  attribution's full trail (the `cargo --timings` report and the `ps`-sampling evidence).
- If a future milestone's browser suite content pushes past ~35 s quiet, the next re-division is
  this ADR's job to redo, not a silent budget bump.
- Open, for Tyler: whether `crates/engine`'s ~19 separate `tests/*.rs` files should be consolidated
  to reduce the incremental-rebuild's code-signing cost, and if so by how much, against the
  file-level test isolation that shape currently gives.

## Sources

- `test-results/build/timings.json`, this session (2026-09-23), Tyler's Mac.
- `target/cargo-timings/cargo-timing.html` (`cargo test --workspace --timings`), this session.
- `docs/plan/17d-fast-tier-wall-time.md` (the brief and its Deviations, "Fix round 1").
- [0020](0020-testing-strategy.md) §3, §10. [0031](0031-browser-suite-five-workers.md) (the
  `browser` suite's own quiet/under-load figures, unchanged by this milestone).
