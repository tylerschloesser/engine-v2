# M33d: Action results across a frame bundle, sprite picking, a viewport on stepped pages

Status: not started · After: 33b · Tyler-dependent: no

Written by the orchestrator at M33b's gate (2026-09-30). M33b's implementer worked around three engine behaviours without explaining them; a diagnosis agent then confirmed each and located it. Two are defects on the production path and one is a test-driver gap. All three are diagnosed to a named function, so this brief is fixes and the regressions that prove them, not investigation.

## Goal
A client receives every action result the host sent, including those in the earlier frames of a `FrameBundle`. A tap inside a drawn sprite returns that record's `pick_id`. A stepped `engine/test` page sees the same `px_per_tile` a real-rAF page would. Each has a regression test that is red on `M33b done`.

## The evidence (orchestrator, from the diagnosis at M33b's gate)
**A. Results lost in a bundle (production defect).** `ClientCore::on_frame` (`crates/engine/src/client/core.rs`, about line 979) applies a `FrameBundle` frame by frame through `apply`, and `apply` runs `self.results.clear()` (about line 1120). Only the last frame of a bundle keeps its `ActionResults`; `pending` is still retired, because `ack_seq` comes from the last frame, so the client sees an ack and no result. `game_instance.rs` (about line 1094) drains once after `on_frame`, so the production client worker loses them the same way. The host emits bundles at degrade level 2 and above (`take_bundle`, `host/mod.rs::build_frame`; ADR 0041). No existing test asserts results across a bundle.
- Native red (Loopback, reference testkit shape; port it to an engine fixture game): two `lb.action` calls 25 ticks apart push the client to level 2, then `dispatch` s1, one `step`, `dispatch` s2, 40 steps draining results each step: `got=[s2]`, expected `[s1, s2]`.
- Real-path red (netcode, `puts` fixture): connect, `setCamera`, 20 ticks, `link(0).stall(2_600)`, 60 ticks, `dispatch({SetMotd:{n:1}})`, `advanceTicks(1)`, `dispatch({SetMotd:{n:2}})`, 80 ticks, `settle()`: `onActionResult` seqs are `[2]`, expected `[1, 2]` (level 4, 6 bundles). The same run without the stall is green, and so is a gap of 0 ticks (both results ride one frame).

**A2. Why the testkit trips it (testkit defect).** `Loopback::action`, `set_camera` and `set_presence` send an uplink whose `last_received_tick` is 0. `PaceState::on_uplink` (`host/pacing.rs`, about line 468) recomputes `backlog_sample` from the stale last real ack, reads 13+ ticks of lag against `BACKLOG_HI_TICKS` 12, and degrades the connection to level 2. A real client always sends a fresh ack. M33b's "a second client joined" framing did not reproduce; the trigger is these uplinks.

**B. Sprites are unpickable (production defect against 0019 §4).** `DrawList::sprite` (`client/drawlist.rs`, about line 263) writes `size = [0, 0]`: a sprite's size and pivot live only in the GPU sprite tables. `containsRecord` in `src/input/pick.ts` tests a sprite like a rect, against the centred `size / 2` box, which for size 0 is the single point `pos`. `pick.test.ts` covers circle, ring, radial, rect, bar and ghost; nothing picks a sprite (M18's review Finding 8 deferred it).
- Red: a sprite record at (10, 10) with `pickId: 9`, `sizeX: 0, sizeY: 0`; `pick` at (10.5, 10.5) returns 0, expected 9.

**C. `px_per_tile()` is 0 on a stepped page (test-driver gap).** `game_instance.rs` (about line 762) computes it from `CameraBlock::viewport_px`, which `frame-loop.ts` `tick()` writes every rAF. `engine/test`'s `stepFrame` (`src/test/client.ts`, about line 362) writes the camera block without ever setting `viewportPxW/H`, so a stepped page reads 0 and every `px_per_tile` cull is inert in stepped browser tests. Measured: on the reference `/test.html` at `tiles_across` 20000 the player circle is not culled; with `viewportPxW = 800, viewportPxH = 600` set in `stepFrame` it is.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0041-frame-bundle.md`
3. `docs/decisions/0019-*.md` (§4 picking)
4. `docs/plan/18-picking-and-overlay.md` (Deviations: the picker's option shape and "sprite pivot is not read")

Look up at the step: the vertex shader's sprite box in `uberquad.wgsl` (`vs_main`: pivot, size, `FLIP_X`), which the CPU test must match. Rules that apply: `.claude/rules/hot-paths.md`, `.claude/rules/prediction.md`, `packages/engine/CLAUDE.md` and the crate's `CLAUDE.md` (test placement). Skill: `run-tests`.

## Scope
- **Results accumulate across a bundle.** Clear `results` on entry to `on_frame`, not inside `apply`, so a bundle's frames append in order; correct the comment at about line 1116. `results` must not allocate per frame: reserve for a bundle's worth once (`.claude/rules/hot-paths.md`), and say in Deviations what bounds it.
- **Testkit uplinks carry the client's real `last_received_tick`.** Fix the three `Loopback` helpers. Do not change `PaceState::on_uplink`: a real client never sends 0 after its first frame, and host pacing is not this milestone's to retune.
- **Sprite picking.** Expose a CPU-side pivot/size table from the loaded sprite atlas (`render/atlas.ts`, built once at load, typed arrays, no per-frame allocation), pass it to `createPicker` as an optional field (additive, as M18's Deviations anticipate), and for `KIND_SPRITE` test the same box `vs_main` draws, `FLIP_X` included. Without a table a sprite keeps today's behaviour.
- **Stepped viewport.** `stepFrame` writes a viewport: the test page's canvas size by default, overridable through a `setViewport(client, w, h)` export of `engine/test`. Add one line to `px_per_tile`'s doc comment saying which paths set it.
- **`unit` suite attribution first.** `unit` runs 3.5 s against a 3 s budget and this milestone adds unit tests. Before adding any, list the five slowest unit test files with their times under Deviations. Fix a cause only if it is one named thing under about 20 lines; otherwise report it and carry on.

## Non-scope
Changing pacing thresholds or `on_uplink`; the reference game (`RefClient::apply_tap` keeps opening the panel by tapped tile, which M33b's Deviations record as the decision); delivering `onUi` on stepped frames (ledger); any new `DrawList` record kind.

## Files, packages and crates touched
`packages/engine/crates/engine/` (`client/core.rs`, the testkit's `Loopback`, `client/frame_view.rs` doc comment), `packages/engine/src/` (`input/pick.ts`, `client.ts`, `render/atlas.ts`, `test/client.ts`, `test.ts`), engine fixtures and tests. Not `games/reference/`.

## Seams
**Provides:** `createPicker`'s optional sprite-table field (name it in Deviations), `setViewport(client, w, h)` from `engine/test`, `ClientCore` results surviving a bundle (no API change).
**Consumes:** `FrameBundle` (M31, 0041); `PaceState`, degrade levels and `pacing_counters` (M31); `createPicker`, `containsRecord`, `scanDrawListForPick` (M18); `LoadedSpriteAtlas` and the sprite pivot/size texture (M17b); `stepFrame` (M03, M16f); the netcode harness's `link(i).stall` (M27, M31).

## Planning decisions
- **Accumulate, don't drain between frames.** A caller-supplied drain inside the bundle loop would change `on_frame`'s shape for every caller; clearing at entry is two lines and keeps the one drain per `on_frame` that `game_instance.rs` already does. Frame order preserves seq order.
- **The picker gets the table, the DrawList does not get a size.** Writing a sprite's size into its record would change every extract golden that holds a sprite, and would duplicate what the atlas owns.
- **The testkit is fixed at the sender.** Making the host ignore ack 0 would hide a real client that stopped acking.

## Order of work
1. Bundle results: the unit test on a hand-built two-frame bundle (red first), the fix, the netcode regression.
2. `Loopback` uplinks carry the real ack; a test that two spaced `lb.action` calls leave `degrade_level` at 1.
3. `unit` attribution, then sprite picking: table, picker, unit cases, one browser pick.
4. Stepped viewport and its browser assertion.

Cut line: if steps 3 and 4 do not fit after 1 and 2, stop at the step 2 boundary and report.

## Tests added
- Rust: `bundle_keeps_every_frames_results` (in `core.rs`'s tests or the crate's test dir per its `CLAUDE.md`: a two-frame bundle, one result in each, both drained in seq order), `loopback_action_does_not_degrade` (level stays 1 after two `action` calls 25 ticks apart).
- Netcode: `rates/results-survive-a-bundle` (the real-path red above; passes `debugHashMode: 'production'` only if it measures bandwidth, which it should not).
- Unit (`pick.test.ts`): `pick.sprite_by_atlas_box` (inside, outside, a non-centre pivot, `FLIP_X`), `pick.sprite_without_table_is_point_only`.
- Browser: `pick.sprite_on_page` on the drawables fixture page (a tap inside a sprite's art, away from `pos`, returns its id), and `stepped_page_has_px_per_tile` (a fixture that culls by `px_per_tile` draws at one zoom and not at another under `stepFrame`). Each under 3 s; `browser` is at 42 s of 48 s, so add no others.

Each test is shown red on the unfixed code, with the red line pasted in the report: they are regressions for defects that green gates missed.

## Exit criteria
- [ ] All tests above pass by name, and each was red before its fix.
- [ ] `furnace_predict.rs` in `games/reference` still passes unchanged.
- [ ] No existing golden changed.
- [ ] The five slowest `unit` files are listed under Deviations.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t bundle_keeps` · `pnpm test netcode -t results-survive` · `pnpm test unit -t pick.sprite` · `pnpm test browser -t pick.sprite_on_page` · `pnpm test browser -t stepped_page`.

## Budgets
Zero-GC (`budgets.json`, unchanged): the picker's sprite path and the accumulated `results` allocate nothing per frame; the existing zero-GC pages are the guard and no budget moves. `unit` 3 s (0020 §3): attributed here, not widened.

## Context artifacts
`packages/engine/CLAUDE.md` or the `run-tests` skill, whichever already describes stepped pages: one line that `stepFrame` writes a viewport and how to override it.

## Manual device checks
None.

## Deviations
(filled in during Phase 3)
