# 0033: Fast tier budgets, re-divided after the build fix: 15 s build, 35 s browser

Status: Accepted (2026-09-23). Amends [0020](0020-testing-strategy.md) §3 (the suites-and-budgets
table and its "55 s if run serially" line). Implemented in milestone M17d.

## Context

[0020](0020-testing-strategy.md) §3 set `buildBudgetMs` at 30 s and the `browser` suite's budget at
25 s from a planning estimate, before any of it was measured (§3's own Consequences: "measuring the
30 s rebuild target and the per-suite numbers... deferred to Phase 3, because no code exists to
measure"). By M17d, `pnpm test` on a warm tree with no source change actually cost 35-42 s of build
(`build WARN`) plus 23-24 s for the `browser` suite -- 58-66 s serially, over Tyler's one-minute
requirement (`docs/spec/testing.md`).

M17d step 1 added per-step build timings (`test-results/build/timings.json`,
`scripts/lib/report.mjs`'s `buildStepsReport`). Step 2 named the cause with evidence
(`CARGO_LOG=cargo::core::compiler::fingerprint=info`): the `fixtures` build step's own bindings
call (`exportBindings`, `packages/engine/src/build-game.ts`) ran `cargo test` scoped to one package
(`-p`, implicit from its working directory), while the `cargo-tests` build step ran `cargo nextest
run --workspace --no-run`. Cargo's per-invocation feature/metadata-hash resolution is sensitive to
that package-selection scope alone -- confirmed by ruling out the original suspect
(`TS_RS_EXPORT_DIR`, M16's env override) with the *identical* value passed under both scopes and
still seeing the same dirty fingerprint (`UnitDependencyInfoChanged` on the crate's own `serde`
dependency edge) -- so the two steps recompiled one fixture crate for each other, every single
`pnpm test`, warm or not. Step 3 fixed it: `exportBindings` now runs `--workspace` too, with no env
override (the same ambient environment `.cargo/config.toml` already gives every other cargo
invocation of the build), and copies only its own crate's output out of every workspace member's
harmless, gitignored scratch write.

**Measured** (Tyler's Mac, warm, no source change, `test-results/build/timings.json`):

| step | before (M17d's own evidence) | after |
|---|---|---|
| `tsc` | 0.5 s | ~0.4 s |
| `fixtures` | 15.9 s | ~0.9 s |
| `cargo-tests` | 15.9 s | ~0.2 s |
| `doctests` | 5.7 s | ~4.2-5.5 s (unchanged; a `compile_fail` doctest re-pays its own compile check every run, by design -- not part of this fix) |
| `pages` | 0.6 s | ~0.6 s |
| **total build** | **35-42 s** | **~6.3-6.6 s** |

`browser` (unchanged by this milestone, from M17d's own evidence and [0031](0031-browser-suite-five-workers.md)): 23-24 s quiet, 29 s under `node scripts/repeat.mjs browser 8 --load 10`.

Step 4 measured the other spec target this milestone touches, the 30 s incremental rebuild
(`docs/spec/testing.md`) from a one-line edit in `crates/engine/src/`: cargo's own reported compile
time (`cargo nextest run --workspace --no-run`'s "Finished ... in Ns" line) was consistently
**~17 s**, under the 30 s target. The wall-clock time this session actually observed around that
figure was far higher (100-150 s) and did not track the source-code cost: `user`+`sys` CPU time
accounted for well under half of it, and the gap reproduced across repeated isolated measurements
after this same session had already run dozens of manual cargo invocations across many different
package-selection experiments (`-p`, `-p a -p b`, `--workspace`, `--workspace --exclude ...`),
swelling the shared `target/` directory to 6.6 GB with 481+ fingerprint entries. That overhead is
recorded here as a finding, not folded into a budget: nothing in `scripts/suites.mjs` gates on the
30 s rebuild figure (it is a spec target verified by hand, not a suite budget), and a machine-local,
session-local artifact is not evidence for changing one. Deviations has the full trail; a clean
`cargo clean` remeasurement is a fair follow-up if the gap recurs outside a long experimental
session.

## Decision

**1. `buildBudgetMs` (`scripts/suites.mjs`): 30,000 → 15,000.** Comfortably above the ~6.3-6.6 s
measured in isolation, and above the noisier figure seen right after a browser-suite-heavy `pnpm
test`: back-to-back full runs on this machine repeatedly showed `fixtures` alone at 7-9 s (total
build ~15-16 s) with a clean fingerprint every time (`CARGO_LOG=cargo::core::compiler::fingerprint
=info` showed zero dirty entries) -- machine/disk contention, not a rebuild. 15,000 sits at the
edge of that observed noise rather than inside it, so it does not cry wolf on ordinary back-to-back
`pnpm test` use, while the existing WARN-at-budget/FAIL-at-1.5x-budget classification
(`scripts/lib/report.mjs`'s `classifyBudget`, `FAIL_MULTIPLE`) still catches a real regression back
toward the old ping-pong well before it could pass unnoticed: that cost 15-17 s *per affected step*
(30+ s combined), double this budget's own FAIL line (22.5 s).

**2. `browser` suite budget (`scripts/suites.mjs`): 25,000 → 35,000.** The build no longer eats
most of the one-minute budget, so the suite that was always the fast tier's real bottleneck gets
the room this milestone's Goal asks for ("so M18 and later milestones have room for fast browser
tests"): build (15 s) + browser (35 s) = 50 s, a 10 s margin under Tyler's 60 s requirement even at
both budgets' own ceiling simultaneously -- today's actual wall time (~6.5-16 s build + 23-29 s
browser, 30-40 s measured depending on machine load) sits comfortably inside that with room to
spare. `rust` (10 s), `unit` (3 s) and `wasm` (7 s) are unchanged: neither this milestone's fix nor
its Goal touches them, and none was ever the bottleneck (0020 §3's own table).

**3. Nothing here raises a number `pnpm test`'s own warm build already meets in isolation.** The
15,000 ms figure is a budget (a threshold to warn or fail on) sized to this session's own observed
noise floor, not a claim that the build always takes that long; a clean, isolated run measures
under 7 s.

## Alternatives rejected

- **Leaving `browser`'s budget at 25,000.** Meets the one-minute requirement today with an even
  wider margin, but does nothing for the Goal's stated purpose (room for M18+); the whole point of
  fixing the build was to free budget for the suite that actually needs it.
- **Splitting the freed build-budget margin across `rust`/`unit`/`wasm` too.** None of the three is
  near its own budget (0020 §3's table: 10 s / 3 s / 7 s against sub-2.5 s measured every one), and
  they run in parallel with `browser` -- raising their budgets would not change the fast tier's wall
  time, only hide a real regression in one of them later.
- **Folding the ~17 s vs 100-150 s incremental-rebuild gap into a number here.** It never showed up
  as a *budget* miss (nothing in `scripts/suites.mjs` measures it), and the session-local cause
  (target-directory bloat from this milestone's own experimentation) is not evidence the number
  belongs in a suite's checked-in budget.

## Consequences

- `docs/plan/17d-fast-tier-wall-time.md` Deviations has the step-by-step measurements this ADR
  rests on, including the incremental-rebuild finding's full trail.
- If a future milestone's browser suite content pushes past ~35 s quiet, the next re-division is
  this ADR's job to redo, not a silent budget bump.
- Follow-up, not blocking: a clean `cargo clean` remeasurement of the 30 s incremental-rebuild
  target, to confirm cargo's own ~17 s figure (rather than this session's noisy 100-150 s) is what
  a normal development session actually sees.

## Sources

- `test-results/build/timings.json`, this session (2026-09-23), Tyler's Mac.
- `docs/plan/17d-fast-tier-wall-time.md` (the brief and its Deviations).
- [0020](0020-testing-strategy.md) §3, §10. [0031](0031-browser-suite-five-workers.md) (the
  `browser` suite's own quiet/under-load figures, unchanged by this milestone).
