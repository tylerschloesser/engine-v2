# M44b: Merge and fork goldens and properties (`fx-belts`)

Status: not started · After: 43b, 44 · Tyler-dependent: no

## Goal
`fx-belts` drives M44's `Merge` and `Fork` through requests and pins them across runtimes: a saturated side-load at the early and the late entry, a contested target, a 50/50 fork, a blocked side, a big-step fork; and four seeded property tests (conservation, the spacing invariant, throughput, ring lap time) that M56 reuses. Split from M44 on 2026-10-11 (sizing rule), the same shape as M42b and M43b.

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0076-transport-lines-engine-game-split.md` (§1 `Output`, §2) and `games/reference/README.md` "Belts" (side-loading and splitter simplifications)
3. `docs/plan/44-transport-merge-and-fork.md` (Seams, Planning decisions, Deviations: the real `Merge`/`Fork` semantics as built)
4. `docs/plan/43b-transport-surgery-goldens.md` (Deviations: the ops and the golden pattern as they stand)
Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/prediction.md`. Skills: `run-tests` (`pnpm golden belts`).

## Scope
- `fx-belts` `Op` gains `Merge { line, into, at }` and `Fork { line, a, b }` (`set_out`), executed by `Belts::tick` like the other ops.
- Goldens (`pnpm golden belts`): `sideload-saturated` (one feeder lane onto an empty target at the early and the late entry), `sideload-contested` (target fed from behind at 1 item per 8 ticks, feeder saturated: the feeder fills gaps and never starves the target), `fork-50-50` (one input, both outputs draining: counts differ by at most 1 after 1,000 ticks), `fork-blocked-side` (one output dead-ended: everything goes to the other, the toggle holds), `big-step-fork` (speed 96 into a fork). Each native test asserts its property and the hash.
- Lift the scenario runner's 32-action cap (M43b Deviations: `runScriptScenario` in `packages/engine/tests/support/scenario.ts` sends every action through an encoder client whose pending queue, capacity 32, is never acked, so the 33rd action fails `OutOfMemory`; M43b's `inserter-like` golden runs its insert/remove pair for 14 ticks because of it): acknowledge the encoder client's queue as the real host does, or drain it per scripted tick, so a scenario may carry hundreds of actions; a native and a Node test with 40 actions prove it. This is the one edit outside `fixtures/belts/` this milestone makes.
- Properties as seeded scripted tests in `fixtures/belts/tests/props.rs` with helpers in `tests/common/props.rs` (M56 reuses them): `prop_conservation` (spawned = live + sunk + destroyed across random edits), `prop_spacing_invariant` (never under `SPACING` on a line or across a plain hand-off except a squashed pair a rescale made, checked every tick), `prop_throughput` (a saturated lane delivers `20 x speed / SPACING` items per second within 1 %), `prop_ring_lap_time` (a closed ring of four lines: an item laps in `total_len / speed` ticks, within one tick).

## Non-scope
- Any change to `engine::transport` (a defect found here is reported, fixed in the engine crate and recorded under M44's Deviations). Who wires forks and merges (M52, M54).

## Files, packages and crates touched
- `packages/engine/fixtures/belts/` (`src/lib.rs`, `tests/golden_scenarios.rs`, `tests/props.rs`, `tests/common/props.rs`, `golden/*.json`, `CLAUDE.md`); `packages/engine/tests/support/scenario.ts` (the action cap).

## Seams
**Provides:** the two ops; goldens `sideload-saturated`, `sideload-contested`, `fork-50-50`, `fork-blocked-side`, `big-step-fork`; `tests/common/props.rs` (M56).
**Consumes:** M44's `Output::Merge`/`Fork`, `TransportRead::toggle`; M43b's ops and golden pattern; M42b's request pattern.

## Planning decisions
- **Properties beside hashes** (0069 §3), and a property that cannot pass trivially (every property asserts the world did something: items sank, forked, lapped).

## Order of work
1. The two ops; a native smoke test each.
2. The five scenarios and their properties; `pnpm golden belts`; `pnpm test wasm -t determinism`.
3. The four property tests; `fixtures/belts/CLAUDE.md`; Deviations.

## Tests added
Rust suite (`fx-belts`): `belts_golden_sideload_saturated`, `belts_golden_sideload_contested`, `belts_golden_fork_50_50`, `belts_golden_fork_blocked_side`, `belts_golden_big_step_fork`, `prop_conservation`, `prop_spacing_invariant`, `prop_throughput`, `prop_ring_lap_time`. `wasm` suite: the goldens replay under Node and Bun through the discovery leg.

## Exit criteria
- [ ] The five goldens match natively, under Node and under Bun; `fork-50-50` ends with output counts differing by at most 1; each had an inject-fail-revert.
- [ ] The four properties pass, each with an inject-fail-revert (a removed room check reddens `prop_spacing_invariant` by a stated number).
- [ ] The fast `rust` suite stays inside 10 s and `wasm` inside 7 s.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t belts_golden` · `pnpm test rust -t prop_` · `pnpm golden belts` · `pnpm test wasm -t determinism` · `pnpm test && pnpm lint`

## Budgets
- Fast-tier suite budgets: `rust` 10 s, `wasm` 7 s.

## Context artifacts
`fixtures/belts/CLAUDE.md` (ops, properties).

## Manual device checks
none

## Deviations
(filled in during execution)
