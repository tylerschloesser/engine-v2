# M54: Reference game: splitters

Status: not started · After: 53 · Tyler-dependent: T (the **(assumed)** splitter line: 128/128 halves, per-input toggle, no buffer)

Later-phase brief: goal, exit criteria and open questions. Filled in at the start of its phase.

## Goal
A 2x1 splitter entity: four input lines (128) with `Fork` outputs onto four output lines (128), one sub-splitter per lane, placed, rotated and picked up like a belt, counted as an input by neighbours (R7), with art; items alternate 50/50 and a blocked side routes to the other.

## Read first
1. `docs/architecture/README.md`
2. `games/reference/README.md` ("Belts": Splitters)
3. `docs/decisions/0076-transport-lines-engine-game-split.md` (§1 `Fork`)
4. `docs/plan/52-reference-belt-topology.md` Deviations (how `map` wires lines)
Rules that apply: `.claude/rules/determinism.md`.

## Scope (sketch)
- `RefEntity::Belt { kind: Splitter }` with a 2x1 footprint (`anchor` = left half when facing `dir`), rotation turns the footprint (a rotate that would overlap is refused).
- `topology.rs`: a splitter maps eight lines; its halves are inputs for the tiles in front and accept from the tiles behind; a belt into its long side connects to nothing.
- Art: a splitter sprite per direction; tests: native (eight lines, 50/50 counts over 1,000 ticks through the engine, blocked side), browser (place, rotate, items split on screen).

## Seams
**Provides:** `kind: Splitter`, `content::SPLITTER_FOOTPRINT`, `RefScenario::place_splitter`.
**Consumes:** M44 `Fork`, M52, M53.

## Exit criteria
- [ ] `splitter_maps_eight_lines`, `splitter_50_50`, `splitter_blocked_side`, `splitter_rotate_footprint`; `reference_splitter_on_screen`.
- [ ] `pnpm test` and `pnpm lint` are green.

## Open questions (answered by earlier phases)
- M44: the per-input toggle semantics as landed.

## Deviations
(filled in during execution)
