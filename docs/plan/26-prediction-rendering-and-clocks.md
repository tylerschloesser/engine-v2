# M26: Prediction rendering and clocks

Status: not started · After: 25, 17 · Tyler-dependent: no (Q10 answered: stretch over `duration + lead`)

## Goal
Predicted state reaches the screen correctly: `extract` sees replica plus overlay with a `predicted` query, predicted tiles reach terrain texels without a per-frame re-upload, and a ghost and its real result swap inside one DrawList (tested: never zero, never two). The client has a free-running authoritative clock, a predicted clock with an estimated lead, and a default rule for own-timer bars whose completion gap is measured.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0012-prediction-and-reconciliation.md` ("Frozen predicted tick", "Two clocks", "Correction without snapping"; Consequences items on the change list, the completion gap and lead estimation)
3. `docs/decisions/0018-renderer.md` (section 2: `Draw.flags`, `FrameView`, publishing; section 3: texel conversion and the per-tile-delta patch)
4. `docs/decisions/0006-time-units.md` ("On the client")
Mine from spikes: `spikes/prediction-api/game/tests/prediction.rs` (`timed_collect_*`, `timer_prediction_error_*`, the `visible()` equality helper); `RESULT.md` "Timers on a client that runs no tick rules". Rules that apply: `.claude/rules/hot-paths.md`, `.claude/rules/prediction.md`.

## Scope
- `OverlayDiff`: the per-frame overlay change list, feeding the dirty set that `ClientCore::drain_dirty` drains; texel conversion reads overlay-then-replica.
- `FrameView`: `entities()` becomes overlay-aware; additions `is_predicted`, `tile_is_predicted`, `predicted_tiles`, `pending`; `Clocks` gains `lead` and the two progress helpers; `Draw::predicted(bool)` if M17 lacks a setter for the `PREDICTED` flag.
- `HostClock` (v1), `LeadEstimator`; the clock block's `predicted` and `tick_fraction` filled with real values, so `client.clock()` carries both clocks.
- Own-timer helpers `Clocks::own_progress` / `Clocks::progress`, the eased correction, and the completion-gap measurement.

## Non-scope
- Interpolation delay, jitter statistics and conditioner-driven clock tests (M30 consumes `HostClock`). The `Hello`→`Welcome` RTT seed is a call M28/M29 make into `seed_rtt_ms`. Reference-game ghost styling and bars (M33). Rust-side rejection events for `ClientSide`: none; TypeScript's `onActionResult` stays the hook. No texel-format or shader change.

## Files, packages and crates touched
- `packages/engine/crates/engine/`: `predict/diff.rs`, new module `clock` (`host_clock.rs`, `lead.rs`), edits to `FrameView`, `Clocks`, the slab conversion source and `frame(t_ms)`.
- `packages/engine/src/`: clock block fields only if M16's layout lacks `tick_fraction`; nothing else.
- `packages/engine/fixtures/predict/`: a `ClientSide` with `extract` and `ui`.

## Seams
**Provides:**
- `OverlayDiff` (engine-internal): `tiles() -> &[TilePos]` whose effective value changed since the previous replay; `ClientCore::mark_dirty(ChunkCoord)` so the diff and replica deltas share one dirty set.
- `FrameView::entities()` (M17's iterator and order) now yields replica plus overlay: overlay values override by id, tombstones are skipped, provisional ids come last. `FrameView::is_predicted(EntityId) -> bool`, `tile_is_predicted(TilePos) -> bool`, `predicted_tiles(&mut dyn FnMut(TilePos, Tile))`, `pending(&mut dyn FnMut(u32, &Prediction<G::Reject>))`.
- `Clocks` (M16b's struct as grown by M17: `authoritative`, `predicted`, `tick_fraction`, `ticks_per_second`) gains `lead: Ticks`, `progress(started_at, done_at) -> f32` and `own_progress(started_at, done_at) -> f32`.
- `HostClock`: `on_frame(tick, arrived_ms)`, `now(local_ms) -> (Tick, f32)` (tick and fraction, monotone), `now_f64(local_ms)`, `rebase()`. M30 builds on it.
- `LeadEstimator`: `on_ack_sample(auth_tick_at_dispatch, ack_tick)`, `seed_rtt_ms(f64)` (M28/M29 call it), `lead() -> Ticks`. It drives M25's `ClientCore::set_lead`.
- `client.clock().predicted` differs from `.authoritative` from this milestone on; a `tickFraction` field if M16b's object lacks one.

**Consumes:** `Overlay` iterators, `View` layering, `PendingQueue`, `Prediction`, `ClientCore::set_lead`, the per-ack sample hook, `Loopback` helpers, fixture `predict` (M25). `FrameView`, `EntityIter`, `DrawList`, `Draw`, `PREDICTED`, `drawListHash`/`drawListRecords` (M17); `Clocks` (M16b, M17); `renderTo`/`expectPixel` (M09). `ClientCore::drain_dirty` and the slab rebuild "pristine + replica overlay through `tile_visual`" with its chunk-upload ring record (M15, M15b). Clock block layout (M16); `client.clock` reused object (M16b). `stepFrame`, injectable clock (M03, M06b).

## Planning decisions
- **Change list = tiles only.** The DrawList is rebuilt from `View` every frame, so entities, players and globals need no diff; `ui` already re-runs per frame and dispatch (M25). Terrain texels are the only retained renderer state. `OverlayDiff` keeps the previous deduplicated overlay tile list (single digits) and compares after each replay.
- **One resolution point, at M15b's granularity.** Replica deltas and `OverlayDiff` both only mark chunks dirty; after reconcile, M15b's slab rebuild runs once per dirty resident chunk and reads effective tiles (pristine, then replica overlay, then prediction overlay). The property that matters is that reset-and-replay with unchanged content uploads nothing: `OverlayDiff` is empty, so no chunk is marked. A confirming ack re-uploads the chunk once with identical texels (the replica delta marks it); that is one 4 KiB slab and no visible change. If M15b grew a per-tile patch record, use it; the rule is the same.
- **`predicted` flag.** Entities: `extract` asks `view.is_predicted(id)` (true for a provisional id or a real id overridden in the overlay) and sets `PREDICTED`. Tiles: the texel carries the predicted *value* only; a game styles a pending tile by drawing a `rect` or `ghost` from `predicted_tiles`. `TileTexel` has no spare meaning and the terrain shader has no per-game styling hook, whereas the DrawList has both. Closes the 0012/0003 item.
- **Cross-ack continuity** is by anchor tile (0022 6): `pick_id` changes from provisional to real at the swap; nothing else may.
- **`HostClock` lives here, not in M30.** Idle ticks send no frames (0010), so a clock that only steps on frames would freeze a bar for up to a heartbeat. v1: offset sample per arriving frame (`tick × tick_ms − arrived_ms`), estimate = maximum over a 2 s window (late arrivals only lower a sample), slewed with the dilation limit of 0010, never stepped except by `rebase()` (0018 section 8).
- **Lead estimation.** Sample per ack = `ack.tick − auth_tick_at_dispatch`: pure tick arithmetic, no wall clock. Lead = median of the last 8 samples, clamped to 1..=40 ticks. Before the first sample: 1, or `ceil(rtt / tick) + 1` once seeded. A lead change never touches a pending action (frozen tick, 0012).
- **Own-timer completion gap: the rule is "stretch"** over `duration + lead` (option 2 of 0012's deferred item; Tyler's answer to Q10). `own_progress = (authoritative − (started_at − lead)) / (done_at − started_at + lead)`: the bar starts at the tap and fills exactly when the host's completion can arrive, running `lead / duration` slower (about 7 % for a 2 s timer at 150 ms). TypeScript's equivalent needs one clock: remaining = `done_at − clock().authoritative`. `progress` (no lead term) is for timers the player does not own. **Measured here:** `completion_gap_ticks` = ticks between the bar first reading 1.0 and the completion put arriving, for the plain predicted-clock rule and for stretch, at delays 0, 1 and 3 ticks; expected `lead` versus 0 ± lead error. The rule is decided; M34's device checklist only confirms on a real network that the stretched bar ends when the result arrives. Opt-in predicted expiry stays rejected for now: it is a client tick rule.
- **Eased correction.** One scalar `own_correction` (ticks): set to `ack.tick − predicted_tick` at an own ack, decayed to zero over the time in 0012; `own_progress` subtracts it from `done_at`. One scalar, not per timer: a player has one or two own timers. A CSS animation restarted by TypeScript cannot ease; that jump is `k / (duration + lead)` and accepted.
- **M20b's interim call** ("accepted as is", bar on the predicted clock) stands until the reference game adopts `own_progress` in M33/M34; the engine default is decided here.
- **Cut line.** If the session overruns, everything under "clocks" moves to `26b-prediction-clocks.md` (new `PLAN.md` row; M30 and M33 then go after 26b).

## Order of work
1. Fixture `extract`/`ui`; `FrameView` predicted queries over M25's overlay.
2. `swap_is_one_render` and `reject_is_one_render` (expected green by construction; they pin it).
3. `OverlayDiff`, `mark_dirty`, slab conversion through the overlay; texel tests.
4. Browser `prediction-no-flicker`.
5. `HostClock`, `LeadEstimator`, `Clocks` fields, clock block values.
6. `own_progress`, correction, gap measurement.

## Tests added
Rust suite:
- `swap_is_one_render`: delay 3; in every DrawList from dispatch to 10 frames after the ack exactly one `Draw` sits on the anchor tile; `PREDICTED` reads `1…1 0…0` with its single transition in the frame that applied the ack; `Ui` inventory is constant.
- `reject_is_one_render`: a rival's delta arrives before the reject ack; never zero or two draws on the anchor; ghost gone and item refunded in the same `Ui` and DrawList (ghost XOR refund).
- `drawlist_hash_stable_across_replays`: identical overlay content gives an identical DrawList hash on consecutive frames.
- `texel_upload_only_on_change`: a predicted `set_tile` gives one upload of its chunk at dispatch with the predicted texel, none during replays with unchanged content, at most one at the ack with identical bytes, one at a rejection with the replica's texel; never two uploads of a chunk in one frame.
- `host_clock_free_runs_and_slews`, `host_clock_monotone`, `lead_converges_to_exact` (2 × delay + 1), `lead_change_leaves_pending_frozen`, `lead_seed_from_rtt`.
- `own_timer_no_jump_at_ack`, `own_timer_correction_eases` (k = 2 of 20, as the spike), `completion_gap_measured` (prints and asserts the two gaps per delay).
Browser suite: `prediction-no-flicker`: stepped frames, semantic pixel probe at the anchor tile centre is never the terrain colour from dispatch until after the ack; `client.clock().predicted − authoritative` equals the lead.

## Exit criteria
- [ ] Every test above passes; the measured gaps are recorded under Deviations.
- [ ] The browser zero-GC test passes with predicted actions in its script.
- [ ] Item M34-own-timer-bar in `docs/plan/device-checks.md` matches what was built.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t one_render` · `pnpm test rust -t texel_upload` · `pnpm test rust -t clock` · `pnpm test browser -t prediction-no-flicker` · `pnpm test && pnpm lint`

## Budgets
- GPU upload per frame (0018): M15b's upload-bytes counter, asserted in `texel_upload_only_on_change` (zero bytes on unchanged replays).
- Frame time, client-worker share (0018 section 9): the diff is O(overlay entries); counter `overlay_diff_entries` with a ceiling.
- Allocation per isolate, main and client worker (0016): zero-GC test.
- Latency row (0004): `completion_gap_measured` documents the own-timer figure.

## Context artifacts
Extend `.claude/rules/prediction.md`: texel conversion always reads overlay-then-replica and is triggered only through the dirty set; key cross-ack client state by tile. Add the own-timer rule and the two `Clocks` helpers to the `add-action-type` skill's timer section.

## Manual device checks
Owns item M34-own-timer-bar (own-timer bar on a real network), run in [M34's section of device-checks.md](device-checks.md#m34-reference-multiplayer-on-real-devices); nothing to run before M34.

## Deviations
(filled in during Phase 3)
