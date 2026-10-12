# M43b: Transport surgery goldens (`fx-belts` ops)

Status: done (2026-10-12) · After: 43 · Tyler-dependent: no

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
- [x] The three goldens are written by `pnpm golden belts` from the `.wasm` under Node and match natively and under Bun; each property holds; each had an inject-fail-revert.
- [x] The fast `rust` suite stays inside 10 s and `wasm` inside 7 s.
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t belts_golden` · `pnpm golden belts` · `pnpm test wasm -t determinism` · `pnpm test && pnpm lint`

## Budgets
- Fast-tier suite budgets: `rust` 10 s, `wasm` 7 s.

## Context artifacts
`fixtures/belts/CLAUDE.md` (the ops).

## Manual device checks
none

## Deviations
Steps 1-3 by the implementer (2026-10-11); the commit is the manager's.

**Built** (`packages/engine/fixtures/belts/`, lines): `src/lib.rs` 613 (+228: the nine ops, `WPos`, `Seg`, `Thing::Tally`, the `"tally"` active list), `tests/golden_scenarios.rs` 951 after the review fixes (+572: three goldens, five `belts_op_*` smoke tests, `census` skips a line `Join` destroyed), `golden/scenario-edit-while-running.json` 80, `scenario-inserter-like.json` 142, `scenario-geometry-arc.json` 137 and their `golden-*.json`, `CLAUDE.md` 58 (cap 60). No engine file changed. The four M42b goldens did not move (adding variants at the end of `Op` and `Thing` and a second active-list system changes no existing byte), so `SCHEMA_VERSION` stays 2.

**Goldens** (`maxLines` 16, `maxItems` 512; properties after every tick; one checkpoint each):
- `edit-while-running` (tick 260, `7078ea1fdd1213b3`): chain 0 (4 tiles) `Next` chain 1 (4 tiles, `Sink`), speed 24, a `period` 256 spawner. Tick 60 `Cut` chain 1 at 512 (chain 2 = its back half; asserted: lengths, `out`s, chain 2 = the old positions `- 512 - 24`); tick 100 `Join` 1 + 2 (chain 2 answers `Err`, chain 1 is 1024 with the halves appended); tick 130 `Extend` chain 0 at the front and chain 1 at the back by 256 (positions `+ 256 - 24`); tick 170 `Rescale` chain 0 1280 -> 1200 (every packed pair 64 -> 60). Conservation every tick; gaps under `SPACING` (on a line or across a `Next` boundary) in exactly ticks 170, 171, 172; chain 0 pinned at ticks 170 and 171 (`RESCALED`: `15 + 60k`; the front item moves 23 and lands at 1272, `SPACING` behind chain 1's tail at 1208, its free landing 1271 held back; then `clamp(-4 + d_ahead, 0, 24)` = 19, 15, 11, 7, 3, 0; in tick 171 the item at 375 moves 23, the five behind it 19 to 3, and the pair at 735 still waits); final `(live, sunk, spawned) = (39, 58, 97)`.
- `inserter-like` (tick 120, `8f9e2c0328a08fcb`; superseded the first draft's `799b8b5d400dd693`, Review fixes 1): one 8-tile line (2048, `Sink`) with a packed stream fed by a `period` 256 spawner (front at 0 near tick 84); ticks 100-113 each carry `Remove { pos: 800 }` then `Insert { pos: 800, item: 7 }`. Every tick `inserted + spawned == live + removed + sunk`; every accepted insert leaves item 7 at exactly `800 - 24` with both neighbours at least `SPACING` away; in tick 100 the stream's phase puts an item exactly at 800, so the swap lands in its slot inside the packed stretch (the whole line is the previous tick's moved 24, only that item now kind 7, between 712 and 840); accepted ticks 100, 102, 104, 105, 107, 108, 110, 112, 113 (the others land in holes earlier removes made); final tally 9 inserted, 14 removed.
- `geometry-arc` (tick 60, `2b52b6a7cdd5e2b0`): a belt turning right at curve tile (31, 32), arcs centred on its inside corner (8192, 8192), start 128, sweep -64; inner lane radius 67, arc 106, len 1130; outer 188, 295, 1319; each a 4-tile `Chain` + `Extend` back + `Segments` in tick 1, sinking, fed by spawners. Every tick `pos_to_world` equals the stated literals at positions 0, 511, 512, 565 (the inner arc's 3/8 turn: `(8192 - 48, 8192 + 47)` from the table's 46341), 618, 1129 (inner) and 0, 512, 807, 1318 (outer), and `None` at `len`; after tick 1: `chunks_of` (chunk bits 5) = `(0,0), (0,1), (1,1)`, `anchor` `(0,0)`, three segments each, `lines_at((31, 32))` = both lines at offset 512.

**Changed from the brief, and why.**
1. *The inserter runs 14 ticks, not the whole scenario.* `runScriptScenario` (`tests/support/scenario.ts`) sends every action through an encoder client whose pending queue (0012, capacity 32) is never acked, so the 33rd `on_action` fails `OutOfMemory` under Node (found at tick 54 of an 80-tick first draft, 163 actions). A script scenario is therefore capped at 32 actions; `inserter-like` uses 30 (31 in the first draft). Lifting it means the harness acking or draining the encoder (outside this milestone's files): the manager's call. Recorded in `tests/golden_scenarios.rs`' module doc.
2. *A tally entity, not `Global` counters.* `inserted`/`removed`/`taken` in `Global` would have changed every existing `fx-belts` hash; a `Thing::Tally` on its own active list changes none.
3. *Inject-fail-revert on the fixture and the scenarios only*: the engine crate was off limits (M44 in progress), so no `QUARTER_TABLE` or landing inject in `engine::transport`.
4. *The cut position is invisible to the hash.* The join 40 ticks later restores the same line, so a cut at 520 instead of 512 leaves `7078ea1fdd1213b3` unchanged; the property catches it. The hash-moving injects for this golden are a changed extend and a changed rescale.

**Inject-fail-revert** (each injected, run, reverted from a saved copy and `cmp`-checked; hashes read with a temporary print and the property disabled):
- Scenario `Cut` at 520: `belts_golden_edit_while_running` red "tick 60: front part", left `Ok(520)`, right `Ok(512)`; hash unchanged (change 4).
- `extend_front(l, by + 1)` in `lib.rs`: red "left: Ok(1281) right: Ok(1280)" at tick 130 (message since added: "tick 130: chain 0 extended"); hash `2c35fdc88389c551`.
- `rescale(.., new_len + 8)`: red "tick 170: rescaled, then the squash rule", left `[56, 120, 184, 248, 312, 376, 437, 498, ...]`; hash `764c87e224a2171b`.
- `insert_at(.., pos + 1, ..)` (first draft): `belts_golden_inserter_like` red "tick 40: the insert landed at 800: [(7, 777), (1, 1064), ...]"; hash `e9c8e7b2b4b0f691`. Redone on the new scenario in Review fixes 1.
- Tally counting a remove twice (first draft): red "tick 40: inserted + spawned == live + removed + sunk", left 16, right 17; hash `5da86653970b9e7d`.
- Scenario inner arc 106 -> 107 and back straight 512 -> 511: `belts_golden_geometry_arc` red "tick 1: chain 0 position 618", left `(8191, 8258)`, right `(8192, 8259)`; hash `d3f6dde525e47e99` (same items and lengths: the segments alone moved it).
- `golden-inserter-like.json` `...693` -> `...692`: both legs red, "belts/golden-inserter-like.json: checkpoint 0: got 799b8b5d400dd693, golden has 799b8b5d400dd692" (Node) and the Bun leg; green after the revert.

**Engine defects found:** none.

**Notes.** The `.wasm` that `pnpm golden belts` built, and the native tests, compiled against the working tree with M44's in-progress edits in `crates/engine/` (`transport/{advance,codec,line,mod,order}.rs`, `predict/predicting.rs`); the four M42b hashes were unchanged by them. If M44 changes a hash for these scenarios, rerun `pnpm golden belts` and these tests on the final tree. `pnpm format` runs `cargo fmt` over the workspace, so it may have reformatted those in-progress files.

**Review fixes** (`m43b-review.md`, the manager's decisions):
1. *`inserter-like` swaps inside a packed stream.* The first draft's inserts (ticks 40-53) all landed ahead of the stream's front. Now the line fills first, and ticks 100-113 send `Remove` then `Insert` at 800 (30 actions, inside the 32 cap); the property and literals are in the Goldens bullet above. The new golden is `8f9e2c0328a08fcb`. Inject-fail-revert: `insert_at(.., pos + 1, ..)` turns it red with "tick 100: a swap inside the packed stretch" (the insert at 801 is refused, 63 short of the item at 864, leaving a hole at 776), hash `ee1bb992536739cd`.
2. *Deviations wording:* the tick-170 landing and the tick-171 moves (Goldens bullet 1) are corrected; the `RESCALED` doc's tick-171 prose is corrected the same way.
3. *`census` skips only the joined line:* `census_without(sim, dead)` skips the id `Join` destroyed (chain 2 from tick 100 in `edit-while-running`) and `expect`s every other line, so a refused `Chain` in any scenario fails loudly again.
4. *Tick 130 pins the back extension by positions:* chain 1 is the previous tick's positions moved 24 (the front item sank), which `extend_front` would have shifted by 256.
5. *`CLAUDE.md`:* the long line is wrapped and both configs are stated (M42b 64 / 4,096; M43b 16 / 512); 59 lines.

Hashes after the fixes (`pnpm golden belts`): `golden.json` `60a22c73b46f98c5`, `deadend-backup` `806c734f63e1daf0`, `spawn-to-sink` `ad314a709a98fb35`, `big-step` `fec39527c906aa81`, `edit-while-running` `7078ea1fdd1213b3`, `geometry-arc` `2b52b6a7cdd5e2b0` (all unchanged); `inserter-like` `8f9e2c0328a08fcb` (new).

**Manager's gate and review (2026-10-12).** Adversarial review (an Opus reviewer, read-only): the code and the hash-stability claim hold (new variants appended last, the tally entity exists only after an accepted request); one real gap, `inserter-like` never inserted into a packed stretch (its inserts landed on empty belt ahead of the stream), fixed in "Review fixes" (the line fills first, then a remove and an insert at 800 in the same tick: a true swap between packed neighbours at tick 100, new hash `8f9e2c0328a08fcb`); four small items fixed (the census skips only the destroyed line, the tick-130 check covers positions, the Deviations' landing wording, `CLAUDE.md`). Scope cut recorded: the scenario runner's 32-action cap (M44b lifts it). The manager reran on the final tree (with M44's engine changes present): `belts_` 12, `pnpm golden belts` idempotent (seven hashes, six unchanged from before the review fix), `pnpm lint` green, full `pnpm test` green (rust 3.7 s of 10 s, wasm 3.6 s of 7 s).
