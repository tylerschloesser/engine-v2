# M17d: `pnpm test` back under a minute: stop the build steps rebuilding each other

Status: not started · After: 17c · Tyler-dependent: no

Written by the orchestrator at M17c's gate.

## Goal

`pnpm test` meets Tyler's requirement again (`docs/spec/testing.md`: "under 1 minute for all
tests", warm caches). Today it doesn't: a warm build step of 35-42 s (`build WARN`, budget
`buildBudgetMs` 30 s) runs before a 23-24 s `browser` suite. Most of the build is two steps
rebuilding each other's output. Once that is fixed, re-divide the fast tier's time budget in an ADR
so M18 and later milestones have room for fast browser tests.

## The evidence, gathered by the orchestrator

Each build step of `scripts/suites.mjs`, timed on its own on a warm tree with no source change
(2026-09-23, Tyler's Mac):

| step | warm, no change |
|---|---|
| `tsc` (`pnpm --filter engine build`) | 0.5 s |
| `fixtures` (`build-fixtures.mjs`) | 15.9 s |
| `cargo-tests` (`cargo nextest run --workspace --no-run`) | 15.9 s |
| `doctests` (`cargo test --doc -p engine`) | 5.7 s |
| `pages` (`vite build`) | 0.6 s |

`cargo nextest run --workspace --no-run` twice in a row takes **0.3 s, then 0.2 s**. Run
`fixtures` in between and the next `--no-run` prints `Compiling fx-puts` and takes **15.9 s**
again. The two steps invalidate each other's cargo artefacts on every `pnpm test`. That is about
30 s of the build. A likely mechanism, **unverified**: the two steps build with different
environments or flags. M16 made `buildGame`'s `exportBindings()` set `TS_RS_EXPORT_DIR`
explicitly, while `.cargo/config.toml`'s `[env]` points it at a gitignored scratch dir for ordinary
cargo runs. `ts-rs` reads that variable at build time, so a different value is a different build.
Profiles, features or `RUSTFLAGS` could do the same. Measure; don't assume.

## Read first
1. `docs/spec/overview.md`
2. `docs/spec/testing.md` (the one-minute and 30 s rebuild requirements)
3. `docs/decisions/0020-testing-strategy.md` (§3 suites and budgets, §4 demotion rule)
4. `docs/plan/16-action-round-trip.md` Deviations: search for `TS_RS_EXPORT_DIR` (why the bindings
   env exists)

## Scope
1. **Per-step build timings.** `scripts/test.mjs` records each build step's wall time and writes
   them to `test-results/build/` (and on `build WARN`, prints the slowest steps on the one line).
   Quiet output stays one line per suite.
2. **Attribute the rebuild.** Name exactly what differs between the `fixtures` step's cargo
   invocation(s) and `cargo-tests`'s (env, profile, features, target, `RUSTFLAGS`), with evidence
   (for example `CARGO_LOG=cargo::core::compiler::fingerprint=info` naming the dirty reason). Check
   `doctests` for the same.
3. **Fix it** so a warm no-change `pnpm test` build performs no crate compilation. The committed
   ts-rs bindings must stay byte-identical, and `pnpm test` must not dirty the tree (M16's fix of
   that must survive). Target: warm no-change build ≤ 5 s. Report the measured figure, and
   `buildBudgetMs` may be lowered to it plus a margin (never raised).
4. **The 30 s incremental rebuild** (`docs/spec/testing.md`): measure a one-line edit in
   `crates/engine/src/` followed by `pnpm test`'s build, and report it. Measure only, unless the
   fix in step 3 is the same one.
5. **Re-divide the fast tier's time budget (ADR).** With the build measured, write an ADR (via the
   `write-adr` skill) amending 0020 §3. It sets the `browser` budget so that warm build + the
   slowest parallel suite stays under 1 minute with a stated margin, from step 3's and today's
   measurements (`browser` 23-24 s quiet, 29 s under `--load 10`). It records the measurement it
   rests on. Update `scripts/suites.mjs`'s `budgetMs` to match. The ADR decides the number; this
   brief doesn't pre-empt it.

## Non-scope
Removing or demoting any test; shortening zero-GC windows (0028); changing test content; the
slow tier; CI's workflow beyond what the fix needs.

## Files, packages and crates touched
`scripts/test.mjs`, `scripts/suites.mjs`, `scripts/lib/`, `packages/engine/scripts/build-fixtures.mjs`
and the `buildGame` bindings code it calls, `.cargo/config.toml`, a new ADR in `docs/decisions/`
and its line under `PLAN.md`'s "Plan-level decisions" (the orchestrator writes that line; propose
its text in the report).

## Seams
**Provides:** per-step build timings in `test-results/build/`; the new ADR.
**Consumes:** M01 runner, M16's `TS_RS_EXPORT_DIR` arrangement, M17b's `solo` suites.

## Order of work
Steps 1-5 in order, each committed `M17d step k: …`.

## Tests added
If step 1 adds runner logic with a branch, a `unit` test for it (scripts' own `*.test.mjs`
precedent). Something must fail if the rebuild ping-pong returns: for example, a check that a
second consecutive build compiles nothing, in whatever tier is cheap enough. Say what it asserts
and prove it fails by reintroducing the difference.

## Exit criteria
- [ ] The rebuild's cause is named with evidence (the dirty reason cargo gives), and fixed.
- [ ] Warm no-change `pnpm test` build ≤ 5 s measured (paste per-step timings); committed
      bindings byte-identical; the tree is clean after `pnpm test`.
- [ ] One-line-edit rebuild time measured and reported.
- [ ] ADR amending 0020 §3 written, with `suites.mjs` matching it.
- [ ] `pnpm test` and `pnpm lint` are green, and `pnpm test` wall time on a warm tree is under
      60 s (paste `time pnpm test`).

## Verification commands
`time pnpm test` (twice in a row; report the second) · `pnpm lint` ·
`CARGO_LOG=cargo::core::compiler::fingerprint=info cargo nextest run --workspace --no-run`.

## Budgets
`buildBudgetMs` may be lowered to the measured figure plus a margin. The `browser` budget is set
by step 5's ADR.

## Context artifacts
`packages/engine/CLAUDE.md` or the `run-tests` skill: where per-step build timings are written,
and the rule that every cargo invocation in the build shares one environment (the stated reason,
in one line). Keep `CLAUDE.md` files within their 60-line cap.

## Manual device checks
none

## Deviations
(filled in during Phase 3)
