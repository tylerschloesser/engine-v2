# M43b: Transport surgery goldens (`fx-belts` ops)

Status: not started · After: 43 · Tyler-dependent: no

## Goal
`fx-belts` drives M43's surgery, item primitives and geometry through requests and pins them across runtimes: edits during flow (cut, join, extend, rescale), an inserter-like request inserting and removing mid-line every tick, and a line with an arc segment. Split from M43 on 2026-10-11 to meet the sizing rule (M43 is the engine crate; this is the fixture and the cross-runtime proof), the same split as M42/M42b.

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0076-transport-lines-engine-game-split.md` (§3 surgery and primitives, §4 geometry)
3. `docs/plan/43-transport-surgery-and-geometry.md` (Seams: the real API; Deviations: what moved)
4. `docs/plan/42b-transport-core-goldens.md` (Deviations: the request pattern, the id table, the spawner rule, how the goldens are written)
Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/prediction.md`. Skills: `run-tests` (`pnpm golden belts`).

## Scope
- `fx-belts` `Op` gains `Cut { line, at }`, `Join { front, back }`, `Extend { line, front: bool, by }`, `Shrink { line, front: bool, by }`, `Rescale { line, new_len }`, `Insert { line, pos, item }`, `Remove { line, pos }`, `TakeFront { line }`, `Segments { line, segments }` (segments as plain data: a fixed array of up to 4 `Segment`s), executed by `Belts::tick` through `transport_mut()` like M42b's ops; `Cut` appends the new back line to the id table.
- Goldens (`pnpm golden belts`): `edit-while-running` (a flowing chain cut, joined, extended at both ends and rescaled while items move; the property: item count and spacing hold through every edit), `inserter-like` (a saturated line with an `Insert`/`Remove` request every tick at mid positions; the property: conservation `inserted + spawned = live + removed + sunk`), `geometry-arc` (a straight segment, an arc segment and a straight segment; the property: `pos_to_world` at the segment boundaries equals the hand-computed points, and the hash covers the segments). Each native test asserts the property and the hash.

## Non-scope
- Any change to `engine::transport` (a defect found here is reported and fixed in the engine crate under M43's Deviations). `Merge`/`Fork` (M44).

## Files, packages and crates touched
- `packages/engine/fixtures/belts/` (`src/lib.rs`, `tests/golden_scenarios.rs`, `golden/scenario-*.json`, `golden/golden-*.json`, `CLAUDE.md`).

## Seams
**Provides:** the ops above; goldens `edit-while-running`, `inserter-like`, `geometry-arc` (M44 and M56 extend the set).
**Consumes:** M43's `TransportWrite::{split, join, extend_front, extend_back, shrink_front, shrink_back, rescale, destroy, take_front, set_segments}` and `TransportRead::{front, segments, pos_to_world, chunks_of, anchor, lines_at}`; M42b's request pattern and id table.

## Planning decisions
- **Requests, not direct writes** (0076 §6): as M42b.
- **Properties beside hashes** (0069 §3): every golden test asserts the behaviour it exists for, so a self-consistent error cannot pass on the hash alone.

## Order of work
1. The ops; a native smoke test per op.
2. The three scenarios and their properties; `pnpm golden belts`; `pnpm test wasm -t determinism` (Node and Bun).
3. `fixtures/belts/CLAUDE.md`; Deviations.

## Tests added
Rust suite (`fx-belts`): `belts_golden_edit_while_running`, `belts_golden_inserter_like`, `belts_golden_geometry_arc`. `wasm` suite: the goldens replay under Node and Bun through the existing determinism test.

## Exit criteria
- [ ] The three goldens are written by `pnpm golden belts` from the `.wasm` under Node and match natively and under Bun; each property holds; each had an inject-fail-revert.
- [ ] The fast `rust` suite stays inside 10 s and `wasm` inside 7 s.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t belts_golden` · `pnpm golden belts` · `pnpm test wasm -t determinism` · `pnpm test && pnpm lint`

## Budgets
- Fast-tier suite budgets: `rust` 10 s, `wasm` 7 s.

## Context artifacts
`fixtures/belts/CLAUDE.md` (the ops).

## Manual device checks
none

## Deviations
(filled in during execution)
