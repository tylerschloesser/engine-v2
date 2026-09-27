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

**Steps 1-3 (this implementer).** Commits `d21bead`..`0c45af8`. All named seams landed under the
brief's exact names except where noted below.

- **`FrameView`'s new prediction fields are a separate builder step, `with_prediction(overlay,
  pending)`**, mirroring `world_access::View::with_overlay`'s own precedent exactly (docs/plan/
  25-prediction-core.md Deviations already used this pattern for the same reason): `FrameView::
  new`'s own signature and every existing call site (fixtures/drawables' `drawlist_golden.rs`,
  this file's own tests) is untouched, so no existing DrawList hash could move. `game_instance.rs`'s
  two production call sites (`frame()`, `on_frame()`) chain `.with_prediction(core.overlay(),
  core.pending_queue())` onto the existing `FrameView::new(..)` call -- `ClientCore::pending_queue()`
  (new, `pub(crate)`) is the seam that makes the pending queue itself (not just an iterator over it)
  reachable there.
- **`FrameView::predicted_player(who) -> Result<&G::Player, Unknown>` is a seam beyond the brief's
  own Provides list.** Needed because `swap_is_one_render`'s own "Ui inventory is constant"
  property (Tests added, verbatim) requires `ClientSide::ui` to read the *overlay-merged* player
  state -- the brief's own Seams give `entities()`/`is_predicted`/`tile_is_predicted`/
  `predicted_tiles`/`pending`, none of which reach player state. Considered and rejected: widening
  `FrameView::world()` itself to route through a `View`-with-overlay (0022 §7's own `View`/`Replica`
  split, M25 Deviations, means `View::entity` never returns `Err(Unknown)` for a real unseen id the
  way `Replica::entity` does -- swapping `world()`'s backing type would silently change that
  behaviour for *every* game's `extract`/`ui`, not just this fixture's). `predicted_player` is the
  same one-line overlay-then-replica merge `Predicting::player`/`View::player` already use, added
  once, low risk, opt-in only for a caller that asks for it.
- **`EntityIter` is now an enum (`Base`/`Merged`), not a struct.** `Base` is the exact pre-M26 code
  (byte-for-byte unchanged) when no overlay is attached; `Merged` walks a reused, sorted id list
  (`Overlay::render_entities_scratch`, a *separate* `RefCell<Vec<EntityId>>` from the pre-existing
  `entities_in_scratch` -- so a game calling both `view.entities()` and `view.world().entities_in
  (..)` in one `extract`/`ui` call never double-borrows one `RefCell`) built by a new free function,
  `merge_render_ids`. Verified byte-identical to the pre-M26 path with an empty-but-attached
  overlay: `fx-drawables`'s own `drawlist_fixture_hash_golden` (which drives `frame()`/`on_frame`
  end to end, so its own `FrameView` now always carries `.with_prediction(..)` with an empty
  overlay) is unmoved.
- **`Overlay::effective_tiles`** (the deduplicated, last-write-wins scan over the overlay's own
  tile vector, same "small, nested scan" shape as `find_entity_at`'s own "superseded" check) backs
  *both* `FrameView::predicted_tiles` and `OverlayDiff::update` -- one shared implementation, not
  two, since the brief's own Planning decisions describes both with the same words ("the previous
  deduplicated overlay tile list").
- **`Draw::predicted(bool)` was not added.** `Draw`'s fields (`flags` included) are already `pub`
  (M17), and `fixtures/overlay`'s own `ANCHOR_CURSOR_TILE` usage already sets a flag by direct
  field mutation (`draw.flags |= ANCHOR_CURSOR_TILE`) with no dedicated setter -- M17 does not
  "lack a setter" in the sense the brief's own conditional names; `fixtures/predict`'s own
  `PredictClient::extract` does the identical `draw.flags |= PREDICTED`.
- **`ClientCore::mark_dirty`'s own dedup (`Replica::dirty_contains_chunk`) is load-bearing, not
  defensive-only.** Originally reasoned about only for the "a wire delta and `OverlayDiff` both
  want to dirty the same chunk in the *same* `on_frame` call" case; the inject-fail-revert proof
  (below) additionally caught a chunk that was *already* dirty from earlier, undrained activity
  (a warm-up tick's own `ChunkEnterPristine`) getting a redundant second `CHUNK` record at the very
  next dispatch -- a broader case than first analysed, and exactly why "never two uploads of a
  chunk in one frame" needed a real (not vacuous) dedup rather than "a wire delta and prediction
  never race in the same frame" alone.
- **`Uploader::stage_predicted` is a new method alongside the unchanged `stage`**, not a signature
  change to `stage` itself: `fixtures/terrain`'s own hand-rolled `Instance` calls `stage` directly
  and is outside this milestone's Files-touched list, so its call site needed no edit.
  `game_instance.rs`'s `upload_stage` ABI method is the one production caller of `stage_predicted`.
- **`fixtures/predict` gained `Action::Paint { tile, base }`** (`w.set_tile`, declining like
  `Place` if the tile is already occupied by an entity): the fixture had no tile-mutating action
  before this milestone, and the texel tests need one. Reuses `Place`'s own conflict shape (an
  entity occupying the tile) so a rival's real `Place` landing before `Paint`'s own reject ack
  reproduces 0012's "a conflicting delta arrives before the reject ack" case for a *tile*, the same
  way `predict_rival_takes_the_spot_never_torn` already does for an *entity*.
- **`testkit::Loopback` gained two new seams beyond the brief's own Seams list** (both needed so a
  test can drive the game's own `extract`/`ui`/`Uploader` through the *real* production call shapes
  rather than reimplementing them): `frame_view(i, visible, window_origin) -> FrameView<'_, G>` (a
  real, prediction-merged `FrameView` over client `i`'s own state; `clocks.predicted` still equals
  `authoritative`, since lead estimation is steps 4-6's) and `drain_and_stage(i, uploader,
  max_records, region) -> u32` (drains client `i`'s dirty queue, coalesced to `ChunkCoord`, into a
  caller-supplied `Uploader`, then stages through `stage_predicted` -- the coalesced drain loses the
  `Whole`/`Tile` distinction `game_instance.rs`'s own `on_frame` preserves, which is fine for a test
  that drives `Uploader` directly and has no `patch_tile` call site to route a `Tile` event to
  anyway).
- **Test naming: `-t one_render`/`-t texel_upload` (Verification commands) select by substring on
  the test *name*, matching M25's own documented nextest quirk** (Deviations there: "nextest's bare
  positional filter matches the test name only"). `swap_is_one_render`/`reject_is_one_render` (in
  `tests/render.rs`) and `texel_upload_only_on_change`/`texel_upload_on_rejection_shows_replica_
  texel` (in `tests/texel.rs`) are named to match both patterns exactly as given; verified with
  `cargo nextest run -p fx-predict --features engine/testing -E 'test(is_one_render)'` (2 tests) and
  `-E 'test(texel_upload)'` (2 tests). `pnpm test rust`'s own summary line still reports the full
  586-test count regardless of `-t` (the same pre-existing `scripts/test.mjs` display quirk M25
  already flagged, not re-verified against this base commit specifically) -- the raw `cargo
  nextest` calls above are what were actually checked.
- **`drawlist_hash_stable_across_replays`'s own warm-up needed `lb.run(10)`, not `4`.** `loopback(3)`
  / `add_client(delay: 4)` at `lb.run(4)` left the client's own subscription incomplete at dispatch
  time (`Prediction::NotPredictable` instead of `Applied`, `traits_at`/`entity_at` reading
  `Unknown` at the placement's own footprint) -- raised to `10` (comfortably over `2*delay+2 = 10`,
  the spike's own warm-up figure for `delay = 4`), matching every other test in this file's own
  `delay`-vs-`run` pairing.
- **Golden hashes: none moved.** `pnpm golden` was not run (nothing in this milestone's own scope
  writes a fixture with its own golden). Verified directly: `fx-drawables`'s
  `drawlist_fixture_hash_golden` (native) passes unchanged both before and after the `EntityIter`/
  `FrameView` rewrite; the full `cargo nextest run --workspace --features engine/testing` (586
  passed, 2 skipped -- every existing `*_golden`/`scenario_matches_golden`/`replay_equals_live` test
  among them) passes identically to the base commit's own 577.
- **`budgets.json`'s `counters.predictRender.overlayDiffEntries` (64) is measured-plus-margin, not
  exact** (unlike `counters.predict.replaysPerFrame`'s architectural 32): no hard cap exists on how
  many tiles a single pending action's own `set_tile` calls could touch. Measured:
  `predict_overlay_diff_entries_counter_is_live` gets exactly 1 (one `Paint` dispatch, one tile).
  64 is headroom for a future fixture predicting several tile writes per action, not a derived
  bound -- flagged in the JSON's own `formula` string for whoever tightens it later.
- **Failability, inject-fail-revert (all reverted before commit, none of these diffs are in the
  tree):**
  - Step 1/2 (`fixtures/predict/src/lib.rs`, `PredictClient::extract`): disabling `draw.flags |=
    PREDICTED` fails `swap_is_one_render` at its first assertion (`left: [0], right: [4]`); drawing
    every entity's rect twice fails both `swap_is_one_render` (`left: [4, 0], right: [4]`) and
    `reject_is_one_render` (`left: 2, right: 1`, "never zero or two Draws").
  - Step 3 (`upload.rs`): disabling the overlay merge inside `Uploader::stage_chunk` fails
    `texel_upload_only_on_change` at the dispatch-time predicted-texel assertion (`left: (0, 0),
    right: (9, 0)`).
  - Step 3 (`client/core.rs`): disabling `ClientCore::mark_dirty`'s own dedup fails
    `texel_upload_only_on_change` at "one upload of its chunk at dispatch" (`left: 2, right: 1`).
  - Step 3 (`predict/diff.rs`): forcing `OverlayDiff::tiles()` to always return `&[]` fails
    `predict_overlay_diff_entries_counter_is_live` (`left: 0, right: 1`).
  - Step 3 (`fixtures/predict/src/lib.rs`, temporary): XORing a call counter into `extract`'s own
    draw colour fails `drawlist_hash_stable_across_replays` (hash differs run to run).

**Exit criteria, evidence (steps 1-3 only; steps 4-6 -- `HostClock`/`LeadEstimator`/`own_progress`/
the browser `prediction-no-flicker` test -- are the second implementer's):**
- Every test above passes: **met.** `cargo nextest run --workspace --features engine/testing`:
  `586 tests run: 586 passed, 2 skipped` (base 577 + 9: `predict::diff::tests::*` (2),
  `swap_is_one_render`, `reject_is_one_render`, `drawlist_hash_stable_across_replays`,
  `texel_upload_only_on_change`, `texel_upload_on_rejection_shows_replica_texel`,
  `predict_overlay_diff_entries_counter_is_live`, `export_bindings_ui`).
- The measured gaps are recorded under Deviations: **not applicable to steps 1-3** (the
  own-timer completion-gap measurement is step 6's `completion_gap_measured`).
- The browser zero-GC test passes with predicted actions in its script: **not verified this
  session** -- no browser suite change was made in steps 1-3, and the brief's own must-knows
  restrict this implementer to foreground, targeted Rust runs only (no `pnpm test browser`).
  Flagged for the orchestrator/second implementer to confirm at the milestone's own final gate.
- Item M34-own-timer-bar in `docs/plan/device-checks.md` matches what was built: **not this
  implementer's** (own-timer bar is step 6's `own_progress`).
- `pnpm test` and `pnpm lint` are green: **not run, per this brief's own instruction** ("I am the
  gate"). This implementer's own scope, run separately: `cargo nextest run --workspace --features
  engine/testing` (586 passed, 2 skipped), `cargo clippy --workspace --all-targets --features
  engine/testing -- -D warnings` (clean), `cargo fmt --check` (clean via `pnpm format`).
  `pnpm test rust -t one_render` / `-t texel_upload` both run (586-test summary, the pre-existing
  display quirk noted above); the underlying `cargo nextest -E 'test(..)'` calls are what were
  actually checked for selection correctness.

**Notes for the steps 4-6 implementer.**
- `client.clock().predicted` still equals `.authoritative` everywhere in this milestone's own
  code (`game_instance.rs`'s two `Clocks { .. }` literals, unchanged from before M26): the real
  lead is entirely yours (`HostClock`, `LeadEstimator`, `Clocks::lead`/`own_progress`/`progress`).
  `testkit::Loopback::frame_view`'s own `Clocks` literal has the identical placeholder -- update it
  alongside `game_instance.rs` if `Clocks` grows a `lead` field, or every `frame_view`-based test in
  this milestone's own `render.rs`/`texel.rs` silently keeps reading a stale value.
  `ClientCore::set_lead`/`predicted_tick` (M25) are the existing hooks `LeadEstimator` drives, per
  the brief's own Provides.
- `FrameView::predicted_player` (this implementer's own addition, not in the original brief) is
  available if the own-timer/`own_progress` work needs an overlay-merged player read anywhere
  outside `ui()` -- reuse it rather than re-deriving the same one-line merge a third time.
  `FrameView::pending()` gives `(seq, &Prediction<G::Reject>)` only (no action, no `predicted_tick`)
  by design (the brief's own Seams, verbatim); if `own_progress`/the completion-gap measurement
  needs a pending action's own `predicted_tick` from inside `extract`/`ui`, that is a new seam to
  add deliberately, not something to reach for through `ClientCore` directly (which `FrameView`
  intentionally does not expose).
- `OverlayDiff`/`ClientCore::mark_dirty` fire from *both* `on_action` and `on_frame`'s own tail
  (`ClientCore::sync_overlay_dirty`, private) -- the browser `prediction-no-flicker` test (step 4)
  should see a chunk re-upload immediately on dispatch, not only after the first `on_frame` call;
  worth asserting explicitly if the semantic pixel probe ever seems to lag one frame behind a tap.
- `Uploader::stage_predicted`'s own overlay pass (`stage_chunk`) re-scans `Overlay::effective_tiles`
  once per staged `CHUNK` record, filtering by chunk match inside the closure -- O(overlay size)
  per chunk, not indexed by chunk. Fine at "single digits" overlay size (0012); revisit only if a
  later milestone's own fixture predicts materially more tile writes per frame than this one ever
  does.

**Steps 4-6 (second implementer).** Commits `32b5053`(step 5, `d2aa46e` after the attribution
amend)..`b0b7e09`(step 6)..`6507f31`(step 4)..`6cc8eee`(context artifact). Built in dependency
order (5, 6, then 4), not the brief's own listed order: step 4's own assertion
(`client.clock().predicted - authoritative` equals the lead) needs `predicted`/`lead` already
wired to real `ClientCore` state, which is step 5's own work -- attempting step 4 first would only
ever assert against the pre-M26 placeholder. Every named seam landed under the brief's exact
names, with the deviations below.

- **`crate::clock`**: `HostClock` (`host_clock.rs`) and `LeadEstimator` (`lead.rs`), both exactly
  the Provides signatures (`on_frame`/`now`/`now_f64`/`rebase`; `on_ack_sample`/`seed_rtt_ms`/
  `lead`). `HostClock`'s own internal design (not specified by the brief beyond the three bullets
  in Planning decisions) tracks a windowed-maximum `target_offset` (arriving-frame samples,
  pruned past 2 s) and slews a separate `effective_offset` toward it at a rate bounded to
  `DILATION_LIMIT = 0.10` per elapsed millisecond (0010's own number, pinned as a literal, not
  imported); `now_f64` reads position from its own monotonic `last_local_ms`, not the raw
  argument, so a backward or repeated call (main-thread rAF jitter) never regresses the reported
  tick (`host_clock_monotone`'s own inject-fail-revert: reading from the raw argument instead
  fails at `local_ms=1099`, `51.98 < 52.0`).
- **`ClientCore` gains `lead()`, `seed_lead_rtt_ms(f64)`, `tick_fraction(&mut self, local_ms: f64)
  -> f32`, `own_correction() -> f32`** -- none named verbatim in the brief's own Seams (which only
  names `set_lead`, already landed by M25), added because `Clocks`'s own real fields need a real
  source and `client_clock_stats` needs a no-argument read (`last_tick_fraction`'s own doc comment
  explains why). `on_ack_sample` (already private, stubbed `NotPredictable`... no-op by M25) is
  now real: feeds `LeadEstimator`, sets `self.lead` from its output, and sets the eased correction
  (`k = ack_tick - predicted_tick`, `correction_set_at = ack_tick`) -- its own signature grew a
  third parameter (`predicted_tick`, from the popped `Pending`) since it is `ClientCore`-private
  and had no external caller to break.
- **`Clocks` gains `lead: Ticks` and `correction: f32`** (the latter a seam beyond the brief's own
  list, the same "add what a formula genuinely needs" precedent `predicted_player` set for steps
  1-3), plus `progress`/`own_progress`. Every pre-existing `Clocks{}` literal (game_instance.rs's
  two production sites, `testkit::Loopback::frame_view`, `client/ui.rs`'s test, `fixtures/
  drawables/tests/drawlist_golden.rs`) updated; `Loopback::frame_view`'s own `tick_fraction` stays
  `0.0` deliberately (`Loopback` drives ticks, not a wall clock -- its own doc comment says so),
  `predicted`/`lead` are now real (`core.predicted_tick()`/`core.lead()`, both `&self`).
- **`own_progress`'s own formula deviates from the brief's literal one-line description**
  ("own_progress subtracts it from done_at"). Subtracting `correction` from `done_at` alone, with
  `lead` left raw in both terms, does not give `own_timer_no_jump_at_ack`'s own no-jump property:
  an ack that both sets `correction = k` and (via `LeadEstimator`, a single-sample median) moves
  `lead` by that same `k` cancels `k` in the *denominator* only, leaving a `k`-tick jump in the
  *numerator* -- the same order of jump the brief's own closing note calls "accepted" only for the
  CSS-restart case this method exists to avoid. Landed formula: `effective_lead = lead -
  correction`, used in place of `lead` in *both* terms (`Clocks::own_progress`'s own doc comment
  has the full algebra). At the instant of an ack, `effective_lead` equals whatever `lead` was the
  frame before (the `+k`/`-k` cancel exactly), so nothing about the ratio moves at that instant;
  as `correction` eases to `0.0`, `effective_lead` eases up to the corrected `lead`, and the bar
  gradually retargets. Read as "the brief's own closing sentence on `own_progress`, made to
  actually hold" rather than a change of decision -- the exit criterion (`own_timer_no_jump_at_ack`
  passing) is what the brief names, not the one-line formula.
- **`client_clock_stats` widened from 8 to 16 bytes, `ABI_VERSION` 23 -> 24** (same call
  signature, `params: 0`, no new argument): `predicted_tick` (`ClientCore::predicted_tick`, real
  from this milestone) and `tick_fraction`'s `f32` bits (`ClientCore::last_tick_fraction`, cached
  from the same wake's own `frame(t_ms)` call -- this export has no `t_ms` of its own to feed
  `HostClock` fresh) as two new LE fields after the existing `authoritative_tick`/`ack_seq`.
  `worker/client-net.ts` feeds the clock block's `predictedTick`/`tickFraction` from it for real;
  `clock-block.ts` grew a seventh SAB slot (`CLOCK_OFF_TICK_FRACTION`, an `f32`, read back through
  a `F32Reader`/`scratchFieldsFloatView()` since `CLOCK_FIELD` deliberately has no plain-`u32`
  entry for it) and `client.ts`'s `ClockSnapshot` gained `tickFraction`. Extended (not weakened)
  every existing test that pinned the old 6-slot/8-byte shape:
  `client_clock_stats_reports_last_applied_tick_and_ack_seq`, `clock_block`'s own three round-trip
  tests, `client_returns_same_object`, and `tests/browser/pages/src/slice.ts`'s own `clockScratch`
  (widened `Uint32Array(6)` -> `Uint32Array(7)`, or `readClockBlockInto`'s `.set()` throws
  "offset is out of bounds" -- found live, `vertical_slice` failing on this exact message before
  the fix).
- **Measured round trip in `testing::testkit::Loopback` is `delay + 1`, not `2 * delay + 1`** --
  deviates from the brief's own must-knows ("lead_converges_to_exact expects 2 × delay + 1").
  Measured directly (`fixtures/predict/tests/clock.rs`'s own `round_trip` doc comment has the
  reverted diagnostic): a `Roll` (or `SetGlobal`) dispatch/ack cycle's own sample
  (`ack_tick - auth_tick_at_dispatch`) settles to exactly `delay + 1` from the *second* cycle
  on, for every `delay` in `0..=4` tried -- the very first cycle after a cold `add_client`/
  `set_camera`/warm-up run measures high (`2 * delay + 4` uniformly, leftover subscription-burst
  backlog draining alongside it) and is not representative. `Loopback`'s own uplink half has no
  modelled delay (`Loopback::set_camera`'s own doc comment: "uplink has no modelled delay here"),
  so a dispatched action is admitted the same tick it is polled; the queueing delay is paid only
  once, on the way down, plus one tick for the round trip's own two `Loopback::step` boundaries.
  `fixtures/predict/tests/clock.rs`'s own `LeadEstimator`-facing unit test in `crates/engine/src/
  clock/lead.rs` (`lead_converges_when_every_sample_agrees`) still pins `2 * d + 1` as a literal --
  that test feeds synthetic samples directly and never touches `Loopback`, so it is unaffected by
  this finding; only a *from-`Loopback`* version of `lead_converges_to_exact` would need this
  number, and none is committed here (Decision needed, below).
- **Two real bugs found live by the browser `prediction-no-flicker` test, both fixed** (see the
  step 4 commit): `GameInstance::upload_stage` never drained `ClientCore`'s own dirty queue into
  the `Uploader` (only `on_frame` did, for replica-delta marks) -- a predicted action's own
  `mark_dirty` had no path into the upload ring except piggy-backing on the next real host frame;
  fixed by calling `ClientCore::drain_dirty` first, `testkit::Loopback::drain_and_stage`'s own
  precedent. `worker/client.ts`'s `body()` ran `uploadPump` before `actionPump`, the same class of
  ordering bug on the JS side (fixed: `actionPump` now runs first, matching `netPump`'s own
  existing "runs before `uploadPump`" precedent and comment).
- **Residual, unresolved latency (Decision needed, below):** with both fixes in place, the
  browser probe still reads the pristine colour `[0,0,0,255]` for the first stepped frame after
  dispatch, an unexplained `[32,32,32,255]` (matches `terrain-readback.spec.ts`'s own `NEUTRAL`
  constant, "non-resident") for one more, then the painted colour `[30,80,200,255]` from the third
  onward -- reproducible, unaffected by either fix, root cause not found (ruled out: pump order,
  `upload_stage`'s own dirty-drain, warm-up length, `ticks: 0` vs `1` per step). `prediction-no-
  flicker`'s own committed assertion is therefore "never flickers *back* to pristine once changed"
  (0012's actual "no snapping" guarantee), not "changes on the very first stepped frame" (0012's
  own "same render" language, read most literally) -- the latter is not what is verified. Flagged
  for further investigation, not chased further inside this budget.
- **`docs/plan/device-checks.md`'s `M34-own-timer-bar` item: verified, matches what was built
  exactly, no edit made.** Its own text ("stretch over `duration + lead`", "reaches full as the
  result arrives, with no full bar left waiting and no result before the bar is full") already
  describes `own_progress` as landed; `completion_gap_measured`'s own table (gap_stretch ≈ 0 at
  every delay tried) is the automated proxy for exactly that pass condition.
- **Test naming**: `fixtures/predict/tests/clock.rs`'s own `own_timer_no_jump_at_ack`/
  `own_timer_correction_eases`/`completion_gap_measured` match the brief's own names verbatim (no
  `-t` substring ambiguity, unlike steps 1-3's `one_render`/`texel_upload`).
- **Failability, inject-fail-revert (all reverted before commit):**
  - `host_clock_free_runs_and_slews`: swapping the windowed-maximum fold (`if o > max_offset`) for
    a minimum fails at the test's first assertion (`left: (Tick(0), 0.0), right: (Tick(100),
    0.0)`).
  - `host_clock_monotone`: reading `now_f64`'s own position from the raw `local_ms` argument
    instead of `self.last_local_ms` fails at `local_ms=1099` (`51.98 < 52.0`).
  - `lead_is_median_of_last_8_clamped`: swapping the median for a mean fails
    (`left: Ticks(7), right: Ticks(2)`, the `[2,2,2,2,2,2,2,40]` case).
  - `lead_seed_from_rtt`: dropping the `+ 1` in `seed_rtt_ms` fails (`left: Ticks(3), right:
    Ticks(4)`).
  - `own_timer_no_jump_at_ack`: reverting `own_progress` to the brief's own literal formula
    (`done_at - correction`, raw `lead`) fails with a real jump (`0 -> 0.27272728 (expected
    +0.18181819)`) at the exact ack step.
  - `own_timer_correction_eases`: hardcoding `own_correction`'s own `frac` to `1.0` (never easing)
    fails the "eased close to zero" assertion (`got 2`).
- **`completion_gap_measured`'s own table** (delay | round_trip=lead | gap_plain | gap_stretch,
  ticks): `0 | 1 | 1 | 0`; `1 | 2 | 2 | 0`; `3 | 4 | 4 | 0`. `gap_plain == lead` and
  `gap_stretch == 0` exactly at every delay tried (no rounding slack needed in practice, though
  the assertions allow ±1).
- **Exit criteria, evidence (steps 4-6):**
  - Every test above passes: **met.** `cargo nextest run --workspace --features engine/testing`:
    `596 tests run: 596 passed, 2 skipped` (base 586 + `clock::host_clock`/`clock::lead`'s own 7
    unit tests + `fixtures/predict/tests/clock.rs`'s own 3). The measured gaps are recorded above.
  - The browser zero-GC test passes with predicted actions in its script: **met, via pre-existing
    infrastructure, not new work.** `gc-slice.ts`/`gc-slice.spec.ts` (`zero_gc_action`, M16b) already
    dispatches a real `Action::Paint` (fx-puts, unconditionally predictable) through `dispatchRaw`
    every 30 frames inside its own zero-GC measured window; that action now flows through this
    milestone's own new `predict`/overlay/`mark_dirty`/`sync_overlay_dirty`/`stage_predicted` code
    where it never did before M25/M26 existed. `pnpm test browser -t zero_gc_action`: `browser pass
    5 tests`.
  - `docs/plan/device-checks.md`'s `M34-own-timer-bar` matches what was built: **met, verified, no
    edit needed** (above).
  - `pnpm test` and `pnpm lint` are green: `pnpm lint`: `biome pass`, `rustfmt pass`, `clippy pass`,
    `tsc pass`. `pnpm test` itself was not run (the brief's own must-knows: "I am the gate" --
    foreground/targeted runs only); `pnpm test rust -t clock`, `pnpm test browser -t
    prediction-no-flicker`, `pnpm test browser -t zero_gc_action`, and one full `pnpm test browser`
    (202 passed, 35s/48s, unchanged from the steps 1-3 baseline) were run instead, per the brief's
    own Verification commands.

**Decisions needed (steps 4-6).**
1. The residual 2-stepped-frame latency before a predicted texel first appears on screen (above):
   real, reproducible, root cause not found inside this budget. Worth a dedicated look before this
   milestone is considered fully closed, or an explicit decision to accept it and soften the Goal/
   Planning-decisions language that currently promises a same-render update.
2. `lead_converges_to_exact (2 × delay + 1)`, named in the brief's own must-knows, was not built
   against `Loopback` as a committed test: the actual measured `Loopback` round trip is `delay + 1`
   (above), so a literal `2 × delay + 1` version of that test would never pass against this
   harness. `crate::clock::lead`'s own unit test (`lead_converges_when_every_sample_agrees`) covers
   `LeadEstimator`'s own convergence property with a synthetic `2*d+1` round trip instead, which
   passes on its own terms but does not exercise `Loopback`. Orchestrator's call whether a
   `Loopback`-backed version (at the corrected `delay + 1` figure) is still wanted as a named test.
