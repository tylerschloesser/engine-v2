# M52: Reference game: belt topology

Status: not started · After: 51 · Tyler-dependent: T (shape and side-load lines marked **(assumed)**)

Later-phase brief: goal, exit criteria and open questions. Filled in at the start of its phase.

## Goal
Placed belts become lines: the game's host tick rule maps a woken belt entity onto the engine's lines by the shape rules R1-R7, joins straight-through chains, splits on removal, reshapes curves (106/295 with rescale), wires side-loads as `Merge` at the geometric entry points, and registers segments; the entity's derived `shape` is put for rendering. Items are not yet created (M53), but the full-game golden covers topology edits.

## Read first
1. `docs/architecture/README.md`
2. `games/reference/README.md` ("Belts": Numbers, Lanes, Shape, Side-loading)
3. `docs/decisions/0076-transport-lines-engine-game-split.md` (§3, §4, §6)
4. `/Users/tyler/repos/belts/docs/dev/undergrounds-curves.md` ("Shapes") and `docs/03-belt-shapes-and-connections.md` §4 (R1-R8 with their measured verification; undergrounds and splitters are M54, M55)
Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/prediction.md` (nothing here runs in `apply`).

## Scope (sketch)
- `rules/belts/topology.rs`: on wake of a belt entity (placed, rotated, picked up, or a neighbour changed: the rule wakes the four neighbours), recompute the tile's shape and links from its inputs; `map(tile)`: find or create the two lane lines, `join` into the back neighbour's lines when fed straight from behind and the back line has no other output, `split` when a tile leaves a merged line, `rescale` on reshape, `set_out` to `Next`, `Merge { at }` or `DeadEnd`; `set_segments` per lane (straight segments merged along a run of tiles, arcs for curves); head-on belts connect to nothing.
- The entity's `shape` field put once per change (whole-value, chunk-scoped).
- Native tests on `RefScenario`: every rule R1-R7 as a table; a chain of 20 tiles is two lines; removing the middle tile splits; placing it back joins; a curve's lanes are 106/295; a side-load merge lands at 192/64 from the front; rescale on reshape keeps items (items injected with the engine's `insert_at` in the test).
- The full-game golden gains a belt-building passage (reviewed diff).

## Seams
**Provides:** `rules::belts::topology::{map, unmap, neighbours}`, the `shape` field, `RefScenario::place_belt`.
**Consumes:** M43 surgery and geometry, M44 `Merge`, M51 entities.

## Exit criteria
- [ ] The R1-R7 table test and the structural tests pass with inject-fail-reverts.
- [ ] `idle_belts_cost_nothing`: a world of mapped belts with no items and no edits visits no belt entity per tick (the timer and active-list rule of the furnace).
- [ ] `pnpm test` and `pnpm lint` are green.

## Open questions (answered by earlier phases)
- M43: whether `join` requires the back line's output to already be `Next(front)` (it does, per M43's scope) and the cost of `split` on long lines.
- Tyler: the **(assumed)** shape and side-load lines.

## Deviations
(filled in during execution)
