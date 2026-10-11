# M42b: Transport core goldens (`fx-belts` requests and scenarios)

Status: not started · After: 42 · Tyler-dependent: no

## Goal
`fx-belts` drives `engine::transport` (M42) through tick-rule requests and pins the first belt goldens natively, under Node and under Bun: a straight chain fed to saturation, a dead-end backup, spawn-to-sink conservation and a big-step crossing. Split from M42 on 2026-10-11 to meet the sizing rule (M42 is the engine crate; this is the fixture and the cross-runtime proof).

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0076-transport-lines-engine-game-split.md` (§2, §3 `insert_back`, §6 topology changes are host tick rules, §9)
3. `docs/plan/42-transport-core.md` (Seams: what `TransportWrite`/`TransportRead` provide; Deviations: anything that moved)
4. `docs/architecture/testing-and-tooling.md` (goldens, `pnpm golden`, the `wasm` suite's determinism legs)
Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/prediction.md`. Skills: `.claude/skills/run-tests/SKILL.md` (goldens: `pnpm golden belts`), `.claude/skills/add-action-type/SKILL.md`.

## Scope
- `fx-belts` grows the request pattern: `Action::Request(Op)` spawns a `Request` entity (plain data, one `Op` enum: `Chain { from, dir, tiles, speed, items_at_rest }`, `Link { from_line, to_line }`, `Spawner { line, item, period }`, `Sink { line }`, `DeadEnd { line }`); the entity's auto-wake lets `Belts::tick` execute it through `transport_mut()` and despawn the request. `Belts::tick` also runs the spawners (an active list) with `insert_back` (an integer accumulator per spawner, never a burst). Scenarios (`golden/scenario-*.json`) drive everything through these actions; `Action::Noop` stays for pre-existing encoded values.
- Goldens (`pnpm golden belts`, checkpoint hashes native/Node/Bun): `straight-chain` (one line pair fed to saturation, 400 ticks: speed, spacing, hand-off), `deadend-backup` (capacity 4 per tile per lane, boundary spacing), `spawn-to-sink` (conservation: spawned = live + sunk, read through `TransportRead::count` and the per-line `sunk` counter), `big-step` (speed 72: two items crossing in one tick). Each scenario's native test also asserts the stated property, not only the hash (0069 §3: a hash comparison alone cannot catch a self-consistent error).
- `transport_request_in_apply_is_rejected`: the fixture's own proof that a request is executed by `tick`, never by `apply` (an `apply`-time `transport_mut()` is `Unknown`: M42 pins the engine side; this pins that the fixture obeys it, by asserting no line exists at the tick the action was applied and one exists at the next).

## Non-scope
- Any change to `engine::transport` (M42; a defect found here is reported, fixed in the engine crate and recorded in M42's Deviations). `Merge`/`Fork`, surgery, geometry (M43, M44). The scale benchmark (M45).

## Files, packages and crates touched
- `packages/engine/fixtures/belts/` (`src/lib.rs`, `tests/golden_scenarios.rs`, `golden/scenario-*.json`, `golden/golden-*.json`, `CLAUDE.md`).

## Seams
**Provides:** `fx-belts` `Action::Request`, `Op`, the `Request` entity, the spawner active list; goldens `straight-chain`, `deadend-backup`, `spawn-to-sink`, `big-step` (M43's edit-while-running goldens extend this set; M45's benchmark reuses the request pattern to build the bench world inside a real `Sim`).
**Consumes:** M42's `TransportWrite::{create, destroy, set_out, set_speed, insert_back}`, `TransportRead::{len, speed, out, count, front, items_in}`, `WorldWrite::transport_mut`, `WorldParams::{max_lines, max_items}`; `testing::testkit::run_script`, `pnpm golden` (0020 §5); `fx-machines`'s golden test shape (`fixtures/machines/tests/golden_scenarios.rs`).

## Planning decisions
- **Requests, not direct writes.** Every topology change goes through a `Request` entity because 0076 §6 forbids `apply` from touching lines; the auto-wake of an apply-time spawn (`next_woken` in the same tick's `tick`) is the hand-off, the same pattern as `fx-machines`'s `Feed`.
- **`Op::Chain` builds lines in tile units** (`tiles x 256` positions, one `speed`), so a scenario reads like a belt and M43's surgery goldens can reuse the vocabulary; the fixture never computes geometry (M43).
- **Scenario sizes for the fast tier.** Four scenarios of a few lines each, at most 400 ticks; `wasm` stays inside 7 s with both runtime legs.

## Order of work
1. `Op`, `Request`, `Action::Request`, `Belts::tick` executing requests and spawners; a native smoke test.
2. The four scenarios and their property assertions; `pnpm golden belts`; `pnpm test wasm -t determinism` (Node and Bun).
3. `transport_request_in_apply_is_rejected`; `fixtures/belts/CLAUDE.md`; Deviations.

## Tests added
Rust suite (`fx-belts`): `belts_golden_straight_chain`, `belts_golden_deadend_backup`, `belts_golden_spawn_to_sink`, `belts_golden_big_step` (each: hash plus property), `transport_request_in_apply_is_rejected`. `wasm` suite: the four goldens replay under Node and Bun through the existing determinism test (no new file; the fixture is discovered).

## Exit criteria
- [ ] The four goldens are written by `pnpm golden belts` from the `.wasm` under Node and match natively and under Bun; `deadend-backup` holds exactly 4 items per tile per lane at rest; `spawn-to-sink` conserves items; `big-step` lands two items in one tick.
- [ ] Each golden test had an inject-fail-revert (a changed landing position changes the hash and fails the property).
- [ ] `transport_request_in_apply_is_rejected` passes with an inject-fail-revert.
- [ ] The fast `rust` suite stays inside 10 s and `wasm` inside 7 s.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t belts_golden` · `pnpm golden belts` · `pnpm test wasm -t determinism` · `pnpm test && pnpm lint`

## Budgets
- Fast-tier suite budgets (`scripts/suites.mjs`): `rust` 10 s, `wasm` 7 s.

## Context artifacts
`fixtures/belts/CLAUDE.md`: the request pattern and the goldens; one line in `fixtures/CLAUDE.md`.

## Manual device checks
none

## Deviations
(filled in during execution)
