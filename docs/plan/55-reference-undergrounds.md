# M55: Reference game: undergrounds

Status: not started · After: 53 · Tyler-dependent: T (the **(assumed)** underground line: rotate turns one end only)

Later-phase brief: goal, exit criteria and open questions. Filled in at the start of its phase.

## Goal
Entrance and exit entities pair over at most 4 empty tiles (Tyler, 2026-10-11) with the nearest same-facing exit; a paired entrance's lanes run visible half (128), hidden `(gap + 1) x 256`, visible half (128) as one line per lane; an unpaired entrance backs up at its hood; an unpaired exit accepts nothing from behind; a side-load whose entry point lands in the hidden half connects to nothing; items are not drawn on the hidden stretch; art for both ends.

## Read first
1. `docs/architecture/README.md`
2. `games/reference/README.md` ("Belts": Numbers, Undergrounds, Side-loading)
3. `/Users/tyler/repos/belts/docs/dev/undergrounds-curves.md` ("Undergrounds": the measured pairing and lengths)
4. `docs/plan/52-reference-belt-topology.md` Deviations
Rules that apply: `.claude/rules/determinism.md`.

## Scope (sketch)
- `kind: UndergroundIn | UndergroundOut`; pairing in `topology.rs` on wake (nearest wins, a closer new end steals, recomputed on every change within the span); the hidden stretch is `extend_back`/`extend_front` of the exit's line (or a separate line with `Next` links; M52's Deviations decide which is simpler with the join rule).
- Segments: the hidden stretch registers a straight segment flagged `hidden` so `draw_items` skips it (an `ItemStyle` hook or a segment flag; decided here).
- Tests: native (pairing table: gaps 0..5, stealing, unpaired behaviour, capacity 4 per tile per lane on the hidden stretch, travel time equals the surface belt replaced), browser (items vanish at the entrance and reappear at the exit).

## Seams
**Provides:** `kind: UndergroundIn | UndergroundOut`, `Segment` hidden flag (engine, small), `RefScenario::place_underground`.
**Consumes:** M43 segments and extend, M52.

## Exit criteria
- [ ] `underground_pairing_table`, `underground_unpaired_ends`, `underground_capacity_and_travel`, `underground_sideload_hood`; `reference_underground_on_screen`.
- [ ] `pnpm test` and `pnpm lint` are green.

## Open questions (answered by earlier phases)
- M52: hidden stretch as an extension or a separate line.
- M49: how `draw_items` learns a segment is hidden.

## Deviations
(filled in during execution)
