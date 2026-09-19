# M36b: Suite audit and the deferred measurements

Status: not started · After: 36 · Tyler-dependent: no

Split out of M36 (sizing rule: line count). This milestone writes little product code: it measures, decides and records. Four PRE-PLAN §10 items end here: the 30 s rebuild and per-suite numbers with the build-cache choice (0020), engine-side byte diffing (0011), and `wasm-opt` / `+simd128` for the sim module (0002, handed over by M02). The undo-journal item is **not** here: M21b measures and decides it.

## Goal
Every fast suite is proven inside its 0020 §3 budget with per-test p95 numbers, and anything over the demotion limits has been demoted in the 0020 §4 order. The one-line-edit rebuild is measured against its target and the build-cache strategy for agent worktrees is final. Byte diffing is closed with a measurement on a busy furnace field: open a milestone for it, or record why not. `wasm-opt` and `+simd128` are each allowed or kept off by golden evidence.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0020-testing-strategy.md` (§2 warning and failure thresholds, §3 suite budgets and the separate compile budget, §4 demotion rule and order, Consequences: third "Deferred to Phase 3" bullet)
3. `docs/decisions/0011-wire-format-and-deltas.md` ("Deltas are the only write path", "Versions instead of acks", Consequences: whole-value re-send and the byte-diffing deferral)
4. `docs/decisions/0002-determinism-same-wasm-everywhere.md` (§2 the target-features row, §3 enforcement, Consequences: the `+simd128` / `wasm-opt` deferral)

The bandwidth rows of 0010 are not re-read: M31 put them in `budgets.json` under `net.*`, and the decision question below quotes M15. Hand-overs to read in place: M02 Planning decisions "`+simd128` and `wasm-opt`" and "Rebuild and suite numbers"; M15 Planning decisions "Real frame sizes"; M34's answer to M31's question (its Deviations). Rules that apply: `.claude/rules/hot-paths.md` (the diff counter must compile out of normal builds).

## Scope
- **Per-test timings.** `scripts/test-timings.mjs` runs `pnpm test` K = 10 times warm and aggregates the reports the runner already writes (`test-results/<suite>/report.json`, nextest and Playwright equivalents, and the runner's build line; M10's `timings.json` shape where present) into p95 per test, per suite, and "edit → tests starting". No change to stdout (0020 §2).
- **Demotion-rule audit** against 0020 §3–§4. For each offender: tag `@slow` / rename `slow_*` in the §4 order, or shrink the scenario when it is the only test of a feature. Each demotion is listed in Deviations (test, p95, reason). The final table goes in the ADR.
- **The 30 s rebuild.** `scripts/measure-rebuild.mjs`: warm caches; append a comment to one line in (a) the engine crate's innermost module and (b) the reference `sim` crate (in a temp copy of the line, restored afterwards; tracked files end unchanged, as M02b requires of rebuild tests); run `pnpm test`; read the runner's build time; five repetitions each, median. Owner of the target: 0020 §3. "Before" numbers: M02's and M35's Deviations.
- **Build cache, final decision.** Measure on a fresh `git worktree`: cold to "tests starting" with a per-worktree `target/`; read M10's cached CI build time. Apply M02's triggers (Planning decisions). Only if one fired: repeat with `RUSTC_WRAPPER=sccache`, and with one shared `CARGO_TARGET_DIR` including two worktrees building at once.
- **`wasm-opt` and `+simd128`** (M02's hand-over): build the reference game and every golden fixture on release (a) plain, (b) `wasmOpt: true`, (c) `RUSTFLAGS=-C target-feature=+simd128` through `buildGame({ env })`; replay every golden under Node, Bun and M03's determinism page in Chromium, WebKit and Firefox, locally and on M10's x86-64 runner (`feature-matrix @slow`); report brotli delta (M35's size code) and tick-time delta (M36's `tick-large-save node`).
- **Byte diffing: measure, do not build.** Cargo feature `measure-diff` on the engine crate adds two deterministic counters at frame build: whole-value bytes actually sent, and the bytes a field-mask diff of the same put would send (mask + changed bytes, id unchanged) whenever the previous encoding is known. Netcode test `busy-furnace-field @slow` runs the **reference game** with 200 fuelled furnaces with staggered timers inside one client's view (0010's worked example, M15's question), plus two players depositing or taking once per second, 60 virtual seconds after all chunks arrived; a second run at 1,000 furnaces is recorded for scale. M31's `rates/steady-busy-field` on `fixtures/busy-field` is the fixture-level twin and gets the same counters.
- **One ADR,** "Fast-tier budgets, dev loop and wire measurements" (next free number): audit table, rebuild numbers, cache decision, byte-diffing decision. If `wasm-opt` or `+simd128` is allowed, a second, short ADR amends 0002 (M02's instruction); if both stay off, a paragraph in the first ADR records the evidence.

## Non-scope
Building byte diffing. The undo journal (M21b). New feature tests. Changing a suite budget or the one-minute figure: if demotion cannot meet it, that is a question for Tyler (it is a Requirement), reported, not decided here. Splitting the engine crate (a new milestone if lever 2 below is needed). CI timing as a gate (0020 §10).

## Files, packages and crates touched
Repo `scripts/` (`test-timings.mjs`, `measure-rebuild.mjs`), test files that get a slow tag, the engine crate (feature `measure-diff` only), `packages/engine/tests/netcode/busy-furnace-field.test.ts`, `packages/engine/tests/wasm/feature-matrix.test.ts` + a determinism-page entry, `docs/decisions/`. `.cargo/config.toml` only if a cache tool is adopted.

## Seams
**Provides:** `pnpm test:timings`, `pnpm measure:rebuild`; engine-crate feature `measure-diff` with counters `diff_bytes_whole`, `diff_bytes_masked` in the `engine/test` counter set; tests `busy-furnace-field @slow`, `feature-matrix @slow`; the ADR(s).
**Consumes:** runner reports and build line (M01), `timings.json` (M10); `buildGame({ wasmOpt, env, features })` (M02, M35, M36); target-features allowlist test (M02) (it must be taught the `+simd128` exception for case (c) only); determinism page (M03); netcode harness, `HeadlessClient`, `net.*` counters (M27, M15, M31); `fixtures/busy-field`, `rates/steady-busy-field` (M31); reference furnace and M34's multiplayer scripts (M33b, M34); `tick-large-save node`, `bench-gate.mjs` (M36); size measurement (M35).

## Planning decisions
- **Build cache: M02's provisional "neither" becomes final unless a trigger fires.** Triggers, unchanged from M02: a cold build in a fresh worktree over 3 minutes on Tyler's Mac, or M10's cached CI build over 5 minutes. No trigger → record the numbers, decide "nothing", done. Trigger → adopt sccache if it cuts the cold time by at least 40 %, as an *optional* local tool (never required by `pnpm test`; CI keeps `Swatinem/rust-cache`, 0020 §10). A shared `CARGO_TARGET_DIR` is adopted only if the concurrent-worktree run shows neither lock blocking nor fingerprint thrash, which is not expected; it is the last resort because parallel agent worktrees are the very case it serialises.
- **Rebuild over target: levers in order** (0017 Consequences, PRE-PLAN risk 7, M01's crate-split triggers): `debug = "line-tables-only"` if M35 did not adopt it; then a crate split along the most-edited module boundary, which is a new milestone with an ADR, not work for this session. The intermediate profile is not a lever for this number (it concerns browser-suite speed, M35).
- **Byte diffing decision = M15's question, plus a worth-it test.** Open `36c-byte-diffing.md` (template brief + `PLAN.md` row, written by this session; M39 then waits on it) only if (a) at 200 active machines in view, steady-state downlink per client is above the 0010 soft cap or more than twice the typical range (`net.*` rows), or M34 reported the degrade engaging in normal play, **and** (b) `diff_bytes_masked` is at least 40 % below `diff_bytes_whole`. Otherwise close the 0011 deferral as "not needed, remains a non-API option" with the numbers. A furnace value is about a dozen bytes behind a varint id, so "no" is the expected outcome. The 1,000-furnace run informs the ADR only.
- **`wasm-opt` / `+simd128`: allowed only on equal goldens in every runtime on both architectures *and* a gain worth a second build identity:** at least 10 % brotli or 10 % median tick time. `+simd128` additionally changes the target-features guard and the support floor, so it needs both gains to be worth it; expected outcome: `wasm-opt` allowed for release builds, `+simd128` stays off.
- **Per-suite numbers live in the ADR only;** M39's ledger links to it.

## Order of work
1. `test-timings.mjs`; ten warm runs. 2. Demotions and shrinks; ten more runs. 3. `measure-rebuild.mjs`. 4. Fresh-worktree and CI numbers; cache decision (experiment only on a trigger). 5. `feature-matrix`, locally then on CI. 6. `measure-diff` counters, `busy-furnace-field`; decision. 7. ADR(s); `36c` brief and row if called for.

## Tests added
`busy-furnace-field @slow` (asserts only that both counters are non-zero and reproducible for the seed; the decision reads its report). `feature-matrix @slow` (asserts golden equality per build per runtime; a mismatch is a finding, recorded, and that variant stays off). `unit`: `test-timings: aggregates reports`.

## Exit criteria
- [ ] `pnpm test:timings` over 10 warm runs shows every fast suite within its 0020 §3 budget and no fast test over the 0020 §4 p95 limits; every demoted test runs under `pnpm test:slow`; no feature lost its only fast test.
- [ ] `pnpm test` parallel wall clock is under the Requirement's one minute on Tyler's Mac, warm; the number is in the ADR.
- [ ] `pnpm measure:rebuild` reports both medians; they meet the compile budget, or lever 1 was pulled and the remainder is raised as a plan edit.
- [ ] Fresh-worktree and cached-CI build times are in the ADR with the decision the triggers produce; any config change it implies is committed.
- [ ] `pnpm test:slow wasm -t feature-matrix` has run locally and on CI (run URL in Deviations); the allow / keep-off decision for each of `wasm-opt` and `+simd128` is recorded by ADR.
- [ ] `pnpm test:slow netcode -t busy-furnace-field` passes; both counters and the build / do-not-build decision are in the ADR; if "build", `docs/plan/36c-byte-diffing.md` and its `PLAN.md` row exist.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test` · `pnpm lint` · `pnpm test:timings` · `pnpm measure:rebuild` · `pnpm test:slow wasm -t feature-matrix` · `pnpm test:slow netcode -t busy-furnace-field` · `cargo build -p engine --features measure-diff --target wasm32-unknown-unknown`

## Budgets
PRE-PLAN §7 "Test suite" (per suite and total): `pnpm test:timings`. "Dev loop": `pnpm measure:rebuild`. "Bandwidth per client, steady": `busy-furnace-field` against `net.*` (a report, not a gate: the field is heavier than typical play). "Download": brotli deltas of the feature matrix.

## Context artifacts
`run-tests` skill: `pnpm test:timings`, the demotion procedure, how to tag slow tests. Root `CLAUDE.md` gains one line only if a cache tool is adopted. No new rule file.

## Manual device checks
none

## Deviations
(filled in during Phase 3)
