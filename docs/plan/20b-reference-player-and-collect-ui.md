# M20b: Reference game v0: player, presence and collect UI (first playable)

Status: not started · After: 20, 17b, 18, 19 · Tyler-dependent: no (Q4 answered: collect range is 3 tiles)

Split from M20 during planning (see that brief).

## Goal
A single-player game you can play: a circle springs after the camera, collect buttons appear over every resource in range, a press fills the button for the collect duration, the item lands in the player's state and the tile visibly depletes; panning out of range cancels. The witness range check of `0001` is enforced in `admit` and `apply`.

## Read first
1. `docs/spec/overview.md`
2. `docs/spec/reference-game.md` (Players, UI)
3. `docs/decisions/0001-camera-and-presence.md` (Decision: presence producer, witness steps 1–3)
4. `docs/decisions/0019-camera-input-and-overlay.md` (§1 camera block and `moveTo`, §5 anchoring, §6)

Look up at the step: how the UI observes state `0003` ("How the UI observes state", "Actions across the boundary"); `DrawList::circle`/`ring` and `Draw.flags` `0018` §2; the two clocks `0012` "Two clocks"; closed-form spring reference in `0001` Sources.
Rules that apply: `.claude/rules/hot-paths.md` (everything in `sim/src/client.rs` runs per frame), `.claude/rules/determinism.md`, `games/reference/CLAUDE.md`.

## Scope
- `PlayerPresence` exactly as sketched in `0001` (Decision, `Presence` code block); `impl Presence`.
- `RefClient: ClientSide<RefGame>`: `frame` integrates a critically damped spring (closed form, variable `dt`, ordinary floats) from the camera block's centre and velocity and writes the presence; `extract` draws the own player as a `circle` plus a faint `ring` of radius `RANGE` with `SCREEN_PX_STROKE`; both skipped when `FrameView.zoom` makes the circle smaller than 2 px.
- `admit(StartCollect)`: the presence-distance rule of `0001` witness step 1 (tolerance from `PRE-PLAN.md` §4, Presence row). Every other action admits.
- `Ui { me: PlayerId, inventory, collecting: Option<{ tile, done_at }>, in_range: Vec<{ tile, resource, from }> }`, filled by `ui()` from the spring position and `FrameView` tile reads. `Ui::default()` reserves the vector's capacity once; `ui()` clears and refills, so steady state allocates nothing.
- DOM (framework-free, `src/ui/collect.ts`, `src/ui/inventory.ts`): on `onUi`, diff `in_range` by tile key; create or remove one `<button>` per tile, anchored with `client.overlay.anchor(el, x + 0.5, y + 0.5)`. Click dispatches `StartCollect { tile, from }` with the entry's `from`. While `collecting` is set, the matching button gets one CSS animation whose duration is `(done_at − clock().predicted) / ticksPerSecond`, started once; other buttons are disabled. A plain inventory readout (four counts).
- Cancel on pan-out: when `collecting.tile` is no longer in `in_range`, `collect.ts` dispatches `CancelCollect` once.
- Spawn: `RefClient` finds the land tile nearest the origin by spiralling over its own terrain function (pure, no engine read) and publishes it as `Ui.spawn`; `main.ts` calls `client.camera.moveTo(spawn, { durationMs: 0 })` only when the engine restored no camera.
- `onActionResult`: a rejected `StartCollect` flashes the button (`reason` as a CSS class); no modal.

## Non-scope
Remote players and roster (M34). Crafting menu and unlock (M32). Styling beyond legible defaults. Touch-specific layout (buttons are ordinary DOM and already work).

## Files, packages and crates touched
`games/reference/` (`src/`, `sim/src/client.rs`, `sim/src/types.rs`, `sim/src/rules/collect.rs`, tests). Engine only for bug fixes.

## Seams
**Provides:** `RefClient` (spring state, `pos()`), `PlayerPresence`, the `Ui` type and its binding, `src/ui/dom.ts` (`el()`, keyed-list diff helper reused by M32–M34), browser helpers `panTo(page, tile)`, `uiState(page)`, `clickCollect(page, tile)` in `tests/helpers/game.ts`.
**Consumes:** `RefGame`, `in_range`, `RefScenario`, `landmarks.json`, `openGame` (M20); `ClientSide::extract`, `DrawList`, `FrameView` (M17); `client.overlay.anchor`, picking-free taps on DOM, `ClientSide::frame`, `FrameCx::camera()` (M18); `Presence` uplink, `PresenceTable`, `admit` call site (M19); `onActionResult` (M16); `onUi`, `clock()` (M16b); `FrameCx::ui_dirty()` (M18); `client.camera.moveTo`/`read`/`restored`, `ClientOptions.cameraKey` (M11).
**Relied on from other milestones (in their briefs; if one is missing in code, stop and fix the plan):**
- M16b/M18: `FrameCx::ui_dirty()` (0024 §7d): `frame` calls it when the spring moved, so `ClientSide::ui` re-runs although the replica did not change (`in_range` depends on the spring).
- M18: `client.overlay.anchor`'s per-frame refresh (`update(): void`) is not called automatically by `frame-loop.ts` — a page must wire it through its own `onOverlay` hook once per rAF, or collect buttons never track their tiles (M18 Deviations, steps 4-6).
- M11: `client.camera.restored` and `ClientOptions.cameraKey` (pass the world id).

## Planning decisions
- **Where `from` comes from.** The ADRs put the spring in Rust and `dispatch` in TypeScript, and say per-frame values must not travel through `Ui` (`0003`). Decision: each `in_range` entry carries `from` = the player's position when that tile entered range (refreshed whenever the set changes). It is a real position of this player, inside `RANGE` of the tile by construction, and at most `2 × RANGE` from the live presence sample, far inside the `admit` tolerance. `Ui` therefore changes at tile-crossing rate, never per frame. Rejected: a `ClientSide` hook that stamps actions (new `Game` API, needs an ADR); reading an anchor slot from TypeScript (f32 precision far from the origin).
- **Who sends `CancelCollect`:** the DOM layer, from `onUi`. A hidden tab sends nothing; `0001` Consequences already accepts a client that never cancels.
- **Own-timer completion gap** (`0012` Consequences, deferred 2→3): interim only. Until M26 lands, the bar fills on the predicted clock and the item appears up to one RTT later (one tick in single-player). The decided rule is M26's: own bars stretch over `duration + lead` (Q10), and this bar switches to `own_progress` there (M26's brief, Planning decisions).
- **Spring constants** live in `client.rs` as per-second values; nothing depends on their bits (`0001`).
- **Range ring** is the one non-required visual: it makes "within a certain distance" legible and exercises `ring` + `SCREEN_PX_STROKE`.

## Order of work
1. `PlayerPresence`, spring, circle; native test of the closed form; browser check that the circle lags and settles.
2. `admit` with unit tests against a hand-built `PresenceTable`.
3. `Ui`, `ui()`, bindings; `dom.ts`; collect buttons and anchoring.
4. Progress animation, cancel on pan-out, rejection flash, inventory readout.
5. Spawn rule. 6. Scripted browser test; update `games/reference/CLAUDE.md`.

## Tests added
- Rust native: `spring_settles_and_is_dt_independent` (same end state at 30, 60, 120 Hz within tolerance), `admit_rejects_far_witness`, `admit_rejects_without_sample`, `admit_accepts_within_tolerance` (the witness stands over a water tile: players may float over water), `ui_in_range_lists_each_resource_once`, `ui_from_is_within_range_of_its_tile`, `spawn_is_nearest_land_tile` (against `landmarks.json`), `extract_hash_player_circle` (DrawList hash, `0020` §6a).
- Browser (stepped frames, injected input): `reference_collect_flow` (pan to the nearest stone landmark, a button appears anchored within 1 CSS px of the tile centre, click, the button's `getAnimations()` holds one running fill animation whose duration is the Scope formula, step 40 ticks, inventory shows 1 stone, the animation is gone and the button is enabled again), `reference_several_buttons` (two resources in range give two buttons), `reference_pan_out_cancels` (start, pan away, `collecting` becomes null, no item), `reference_new_player_spawns_on_land`.

## Exit criteria
- [ ] All tests above pass by name.
- [ ] Played by hand with `pnpm --filter reference dev`: ten stone collected from one tile, the tile's resource disappears, the buttons never drift from their tiles while panning and zooming.
- [ ] The M04 zero-allocation assertion, pointed at the reference page for 600 stepped frames of panning with two buttons mounted, stays inside the client-worker budget of `0016` (proves `ui()` and `extract` do not allocate).
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t reference` · `pnpm test browser -t reference_` · `pnpm --filter reference dev`.

## Budgets
Allocation per isolate (`PRE-PLAN.md` §7): client worker and main rows, measured by the exit criterion above with the `gc-test` skill. Frame time is not asserted here (M36).

## Context artifacts
Update `games/reference/CLAUDE.md`: the `Ui` rule ("state-change rate only; never a per-frame value"), where DOM modules live, how to add a button.

## Manual device checks
None of its own; the M18 and M39 sections of `docs/plan/device-checks.md` use this page once it exists.

## Deviations

Steps 0-2 only (a second implementer takes steps 3-6 from these commits and this section). Base
`5696097`; `pnpm test && pnpm lint` green there and still green after these steps (`rust 395`,
`unit 226`, `wasm 57`, `browser 174` at `25-26s/35s`; lint's four checks all pass). Commits
`1210ae6`..`441cc75`.

**Step 0 (orchestrator addition): the stepped test entry.**
- `games/reference/src/game.ts::startGame(opts: StartGameOptions): Promise<StartedGame>`, exact
  shape: `StartGameOptions = { canvas, host: ClientOptions['host'], test?: ClientOptions['test'],
  clock?: Clock, scheduler?: Scheduler }` (the last two from `engine/render`); `StartedGame = {
  client, renderer, device, canvasFormat, real }`. Builds device/renderer/art/`createClient`/
  `onCamera`/`createRealFrameLoop` exactly as M20's `main.ts` did, minus `client.ready` and every
  `window.__*` hook (the caller's own job). `clock`/`scheduler` default to `engine/render`'s real
  `systemClock`/`systemScheduler` when omitted.
- `games/reference/src/main.ts` (production, `index.html`): `await startGame({...})` then `await
  client.ready`, no `ClientOptions.test`. **Deviation from "no window.__\* hooks" (flagged, not
  fixed unilaterally):** `__setCamera`/`__cameraState` remain here, because `camera.spec.ts`'s
  `reference_pan_and_zoom_work` (M20's own test) drives this page with real Playwright mouse/wheel
  gestures and reads `__cameraState` back. Moving it to the stepped entry would mean either real
  gestures against a page whose render loop needs an explicit manual-clock `.frame()` fire to
  integrate them (no such call exists anywhere in this codebase, engine or game), or rewriting the
  test onto `engine/test.injectPointer`/`injectWheel` — a change to an existing, passing test beyond
  the one this step names (`reference_depletion_visible`), which the brief's own escalation rule
  reserves for the orchestrator. `__probeTile`/`__dispatchStartCollect` (the two hooks named
  explicitly) did move off production, along with `reference_terrain_renders`'s and
  `reference_depletion_visible`'s own page target.
- `games/reference/src/test-entry.ts` (test-only, `test.html`, built into the `reference`
  Playwright preview via `vite.config.ts`'s new `build.rollupOptions.input: { main, test }`): one
  `createManualClock()` instance is passed as *both* `ClientOptions.test.clock` and `startGame`'s
  own `clock`/`scheduler` (so nothing on this page ever advances on its own — `connected-terrain.
  ts`'s own precedent). Hooks: `__probeTile(x, y)` (GPU readback, same technique as M20's, but its
  wait loop calls `stepFrame`+drains uploads instead of polling real `requestAnimationFrame`),
  `__dispatchStartCollect`, `__setCamera`/`__cameraState`, `__stepFrame(dtMs)`, `__stepTick(n)`,
  `__playerCircle()` (reads the own-player circle's DrawList record directly via `engine/test.
  drawListRecords`, `kind === 1` = `KIND_CIRCLE`, no GPU needed). `engine/test` calls actually used
  by this milestone's specs: `pumpUntilLive`, `stepFrame`, `stepTick`, `resumeWorkers`, `setCamera`,
  `drawListRecords`, `attachCameraInputTestHooks` (wired at startup, paired with `clientTestHandle
  (client).cameraBundle`, though no spec of this cut calls `injectPointer`/`injectWheel` yet — the
  brief's own "works exactly as on the engine's own test pages" is satisfied by wiring it, not by
  using it this cut).
- **New engine export (`packages/engine/src/render.ts`, "Engine only for bug fixes", M20's own
  precedent for this exact file): `createUploadDrain`/`DEFAULT_UPLOAD_BUDGET_BYTES`/`UploadDrain`
  (from `render/upload.ts`) and `RingConsumer`/`RingStats` (from `sab/ring.ts`).** Needed because a
  page driven by a manual clock has no real per-rAF frame loop to drain `client.uploadRing`
  automatically (`createRealFrameLoop`'s own upload-drain phase only runs when its scheduler is
  actually fired, and nothing on this page fires it); `test-entry.ts` runs `createUploadDrain`
  itself on a real (wall-clock) `setInterval(16ms)`, mirroring `connected-terrain.ts`'s own
  internal-only precedent for the identical gap. No existing test asserts a closed/fixed `engine/
  render` exports list (checked, same as M20's own note for `engine/render` itself).
- **Found live, fixed:** (a) `stepTick`/`untilQuiescent` park every worker on return (`engine/
  test`'s own doc comments); a later `stepFrame`/`stepSimTickSync` call hangs until an explicit
  `resumeWorkers` — every stepping hook in `test-entry.ts` now calls it first (a documented no-op
  when already resumed). (b) A dispatched action sits in the client's own action ring until a
  `stepFrame` call flushes the uplink (`client_poll_uplink`, run from the client's own `frame()`);
  calling `stepTick` right after `dispatch` without an intervening `stepFrame` leaves the action
  unflushed, arriving at the host together with later ones and rejecting all but the first `Busy`
  — every stepped spec calls `__stepFrame` once before `__stepTick`. (c) The real host queues an
  admitted action for the tick *after* the one it arrived on (0004: "Host assigns tick T+1"), unlike
  `RefScenario::dispatch` (native tests), which applies a record inside the same `Sim::step` call
  that carries it — `reference_depletion_visible` steps `content::COLLECT + 1` ticks per round, not
  `COLLECT`, found by comparing native (`cargo test`, a scratch repro, deleted) against browser
  `simCounters().ticksRun` readings (also removed): native completes in exactly 40 ticks every
  round; the browser topology needs 41.
- **`gc` Playwright project reachability, checked but not built (this cut's own ask):** as
  configured (`packages/engine/playwright.config.ts`), the `gc` project has no `testDir` override
  (inherits the top-level `./tests/browser`, i.e. `packages/engine/tests/browser`) and its
  `use.baseURL` is the top-level `baseURL` (`packages/engine`'s own preview, not `referenceBaseURL`)
  — a `gc-*.spec.ts` placed under `games/reference/tests/browser/` is invisible to it today, on
  both axes. Cut 3 (steps 5-6) needs a new project mirroring the existing `reference` project's own
  pattern (`testDir: '../../games/reference/tests/browser'`, `use.baseURL: referenceBaseURL`, plus
  the `gc` project's own launch args/`testMatch: '**/gc-*.spec.ts'`/timeout) and the matching
  `--project` addition in `scripts/suites.mjs`'s `browser`/`gc` suite args — the same shape M20 used
  to add the `reference` project itself, not a new mechanism. `installGcPage`/`asHarness(client)`
  (the adapter a production `Client` needs to run the generated zero-GC suite) already exist and are
  reachable from `test-entry.ts`'s own topology; nothing here blocks it, only the project wiring is
  missing.

**Step 1: `PlayerPresence`, spring, own-player circle.**
- `games/reference/sim/src/client.rs` (new module; `.claude/rules/hot-paths.md` applies to the
  whole file). `PlayerPresence { pos: [i32; 2] /* Q24.8 */, vel: [i16; 2] }` (0001's own sketch,
  verbatim), `impl engine::game::Presence`. `RefGame::Presence = PlayerPresence` (was `()`).
- `pub fn spring_step(pos: f64, vel: f64, target: f64, target_vel: f64, omega: f64, dt: f64) ->
  (f64, f64)`: the closed-form critically damped spring (0001 Sources), `dt <= 0.0` a no-op. Treats
  the target as fixed at its current value for the duration of `dt` (an approximation for a moving
  target, not exact physics — acceptable per 0001: "nothing depends on its bits"). Calls `f64::exp`
  under one `#[allow(clippy::disallowed_methods)]` with the required justification comment
  (`.claude/rules/determinism.md`): this is `ClientSide` code, never hashed/replicated/replayed.
  `SPRING_OMEGA = 6.0` (rad/s): an arbitrary feel choice, not tuned against any test's exact number.
- `RefClient` fields: `spring_pos: [f64; 2]`, `spring_vel: [f64; 2]`, `initialized: bool` (all
  private); `RefClient::with_spring_state(pos, vel) -> Self` (plain `pub`, not feature-gated —
  `reference-sim` is `publish = false`) and `spring_pos(&self) -> [f64; 2]` are test-only
  conveniences used by `extract_hash_player_circle`. `frame` snaps to the camera's own centre/
  velocity on its first call (`!initialized`), otherwise steps the spring per axis and calls `cx.
  ui_dirty()` unconditionally on every call (M18's `FrameCx::ui_dirty()`, 0024 §7d — cheap now since
  `Ui` is still `Default`-only; step 3's own `ui()` is what this actually matters for). `extract`
  draws a `circle` (`PLAYER_DIAMETER_TILES = 0.6`) plus a `ring` of diameter `2 * RANGE_Q8/256`
  tiles with `SCREEN_PX_STROKE`, both skipped when `view.px_per_tile() * PLAYER_DIAMETER_TILES <
  2.0` (Scope's own "smaller than 2 px", read via `px_per_tile()` since that is the accessor whose
  own doc comment names exactly this screen-space decision).
- Native tests (`sim/tests/spring.rs`): `spring_settles_and_is_dt_independent` (30/60/120 Hz agree
  within `1e-4` after 2 s, each within `1e-2` of the target — the closed form's own point over
  Euler integration), `spring_lags_a_moving_target_before_it_settles`,
  `spring_zero_dt_is_a_no_op`. `sim/tests/extract_golden.rs::extract_hash_player_circle`: builds a
  `FrameView` directly (`FrameView::new` is `pub`; `FrameCx::new` is `pub(crate)` to the engine
  crate, so no game crate can build one) against a stub `WorldRead`, calls `RefClient::extract` +
  `DrawList::sort_into`, hashes with `engine::client::drawlist::hash_region` (not re-exported at
  the `engine::client` level, reached via the full `drawlist` module path) and
  `engine::assert_golden_hash!`; golden at `sim/tests/golden/extract_hash_player_circle.hash`
  (`58c2d6cad9192e34`).
- Browser: `reference_player_circle_lags_and_settles` (`tests/browser/player.spec.ts`), on the
  stepped entry: `__setCamera(0,0,20)` (first call snaps, no lag), `__setCamera(30,0,20)` (one more
  stepped frame shows `0 < x < 29`, a lag not a teleport), then 128 `__stepFrame(16)` calls (~2 s
  simulated) settle within `0.05` tiles of the target.

**Step 2: `admit` checks the presence witness.**
- `content::ADMIT_TOLERANCE_Q8: i32 = 16 * 256` (PRE-PLAN.md §4 Presence row: 16 tiles).
- `rules::collect.rs` gains a private `fn dist_sq(a: WorldPos, b: WorldPos) -> i128` (refactored out
  of `in_range`, now shared) and `pub fn admit(p: &PresenceTable<RefGame>, who: PlayerId, from:
  WorldPos) -> Result<(), RefReject>`: `Err(ImplausiblePosition)` with no sample or when
  `dist_sq(from, sample.pos()) > ADMIT_TOLERANCE_Q8^2`, checking distance only (never `traits_at`
  — "players may float over water" applies to the witness too).
- `RefReject` gains `ImplausiblePosition` (bindings regenerated: `src/bindings/RefReject.ts`).
  `RefGame::admit` dispatches: `StartCollect { from, .. } => rules::collect::admit(p, who, from.
  world())`, `CancelCollect => Ok(())`.
- Native tests (`sim/tests/admit.rs`): `admit_rejects_without_sample`, `admit_rejects_far_witness`
  (one raw Q24.8 unit past tolerance), `admit_accepts_within_tolerance` (exactly at the tolerance
  boundary, inclusive), against a hand-built `PresenceTable::<RefGame>::empty()` + `on_sample`.

**Found, not fixed (pre-existing, out of this cut's scope): `test.html` is unreachable under
`pnpm --filter reference dev`.** `vite dev` serves `index.html` (200 OK, COI headers intact) but
403s `test.html` ("outside of Vite serving allow list") -- `packages/engine/src/vite.ts`'s `engine()`
plugin sets `server.fs.allow: [enginePackageDir()]`, which *replaces* Vite's own default allow list
(normally the project root) rather than extending it, so no file under `games/reference/` itself is
servable except the one HTML file Vite treats as "the" configured root entry. Pre-existing in the
shared plugin (not introduced by this milestone, and would affect any second HTML page any game
added); does not block anything here since every automated test reaches `test.html` through `vite
preview` on the built `dist/`, which has no `fs.allow` restriction at all (confirmed: `pnpm --filter
reference build` then `vite preview` serves both pages; the whole `reference` Playwright project
passes). Left for whoever next needs interactive dev-server access to a second page to fix in
`vite.ts` (likely: append to Vite's own default allow list, e.g. `[...serverFsAllowDefault,
enginePackageDir()]`, rather than replacing it) or route around it.

**Steps 3-4 (a third implementer, from `569717c`; base `6c5406d`; this section).** `pnpm test &&
pnpm lint` green at `6c5406d` and still green after these steps (`rust 401`, `unit 232`, `wasm 57`,
`browser 175` at ~26s/35s; lint's four checks all pass). One commit (`569717c`): steps 3 and 4
landed together (the whole vertical slice -- `Ui`/`ui()` through the inventory readout -- was built
in one pass; splitting it after the fact into two commits would have meant inventing an artificial
partial state, not a real resumption point).

- **Orchestrator ruling on cut 1's flagged decision, resolved in this commit.** `main.ts` now
  exposes no `window.__*` hooks at all. `__setCamera`/`__cameraState` moved to `test-entry.ts`
  verbatim (same shapes); a new `__tickCamera(dtMs): void` (synchronous, pure main-thread --
  `client.camera.tick(dtMs)`, the exact call `game.ts`'s own `onCamera` makes every real rAF, no
  worker round trip) was added instead of folding this into `__stepFrame` (which stays behavioural
  identical to steps 0-2's own version, for `player.spec.ts`/`depletion.spec.ts`'s sake).
  `camera.spec.ts`'s `reference_pan_and_zoom_work` moved onto `/test.html`, kept its real Playwright
  mouse-drag/wheel gestures verbatim (no `injectPointer`/`injectWheel`) and its assertions
  unchanged; between the gesture and reading `__cameraState`, the test calls `__tickCamera(16)` the
  number of times each gesture needs to integrate (one right after `pointerdown` to establish the
  drag's own baseline -- `camera/camera.ts`'s per-slot bookkeeping never applies a pan delta on the
  very first `integrate()` call after a pointer engages -- one after the `move`, one after `up`; ~10
  for the wheel notch to ease in over `WHEEL_TAU_MS` = 22 ms).
- **`Ui`/`UiCollecting`/`UiInRange`** (`lib.rs`): `RefUi { me: u32, inventory: Inventory, collecting:
  Option<UiCollecting>, in_range: Vec<UiInRange> }`; `UiCollecting { tile: TileXY, done_at: u32 }`;
  `UiInRange { tile: TileXY, resource: u8, from: WorldXY }`. `me`/`done_at` are raw numbers, not
  `engine::game::PlayerId`/`engine::time::Tick` (neither implements `TS`, and adding it would be a
  feature to the engine crate, not a bug fix -- Files touched). `Inventory` gained `TS`/`#[ts(export)]`
  (already `Serialize`/`Deserialize` for `RefPlayer`'s own sake) since `Ui.inventory` reuses it
  verbatim. `MAX_IN_RANGE: usize = 16` (a generous headroom bound, not measured -- resources are
  scattered sparsely): `RefUi::default()` reserves `in_range`'s capacity to it once.
- **`RefClient::ui()`** (`client.rs`): `me`/`inventory`/`collecting` read straight off
  `view.world().player(view.me())`. `in_range`: a bounding-box scan (`RANGE_Q8/256 + 1` = 4 tiles
  each way around `player_tile = floor(spring_pos)`) checking `world.tile(tile).resource() != 0` and
  `rules::collect::in_range(from, tile)` (the same function `apply` uses -- Provides, already
  `pub`), diffed against a new field, `tracked_range: RefCell<Vec<UiInRange>>` (fixed capacity
  `MAX_IN_RANGE`, reserved at `Default`/`with_spring_state`): a tile already in `tracked_range` keeps
  its own cached `from` (Planning decisions "Where `from` comes from"); a newly-entering tile gets
  `from` = this frame's live spring position; a tile no longer confirmed this pass is dropped
  (`Vec::retain` against a fixed `[bool; MAX_IN_RANGE]` "seen" scratch array, no allocation). `RefCell`,
  not a plain field: `ClientSide::ui` takes `&self`, but the tile-entry-time caching needs the
  *previous* call's own result, and `ui()` is the only place a `WorldRead` is available at all
  (`frame` gets none) -- doing this bookkeeping in `frame()` instead (which has `&mut self`) would
  make it untestable natively (`FrameCx::new` is `pub(crate)` to the engine crate, so no game crate
  can build one and drive `frame()` -- `extract_hash_player_circle`'s own precedent).
- **Native tests** (`sim/tests/ui.rs`, new file): `ui_in_range_lists_each_resource_once`,
  `ui_from_is_within_range_of_its_tile`, `ui_reads_inventory_and_collecting_from_player` (a fourth,
  beyond the brief's own two, since it was cheap against the same fixture) -- a hand-built
  `StubWorld` with one resource in range, one out of it, driven through `RefClient::with_spring_state`
  + a directly-constructed `FrameView` (`extract_golden.rs`'s own pattern).
- **`src/ui/dom.ts`** (Provides): `el<K>(tag, className?): HTMLElementTagNameMap[K]`; `diffKeyed<T,
  E>(live: Map<string, E>, items, key, { create, update?, remove? }): void` -- `E` is deliberately
  unconstrained (not `HTMLElement`), so the same helper reconciles anchor handles or any other
  per-key resource, not only visible DOM nodes; `update` is optional (a caller whose own per-item
  state needs a separate later pass over `live` -- `collect.ts`'s own disabling/fill pass across
  every button at once -- can omit it). Unit-tested with plain objects, no DOM
  (`src/ui/dom.test.ts`, `unit` suite; `vitest.config.ts`'s `unit` project is `environment: 'node'`,
  no jsdom in the lockfile, so `el()` itself is exercised only by the browser suite).
- **`src/ui/collect.ts`** (Deviations: DOM identity): a button carries `data-collect-tile="x,y"`
  (`tileKey()`, exported) -- `[data-collect-tile="x,y"]` is the selector. `createCollectUi(client,
  doc?): { onUi(ui), onActionResult(seq, result) }`. Anchoring: `client.overlay.anchor(button, tile.x
  + 0.5, tile.y + 0.5)` on create, `.remove()` on `diffKeyed`'s own `remove`. Progress: a `.collect-
  fill` inner `<span>`, `--collect-duration` custom property in ms (`(done_at - clock().predicted) /
  ticksPerSecond * 1000`), class `is-filling` toggled off/on (with a forced reflow, `void
  button.offsetWidth`) to (re)start the CSS animation, added once per collect (guarded by a
  per-button `filling` flag) and removed once `ui.collecting` no longer names that button. Every
  other button disabled while one collects. Cancel-on-pan-out: `ui.collecting`'s own tile key not
  present in the current button set dispatches `'CancelCollect'` once (`cancelSentFor`, reset when
  `collecting` clears or points at a different tile). Rejection flash: `pendingSeq: Map<seq, tileKey>`
  populated at dispatch time; `onActionResult` adds a `reject-<reason>` class (`reason.toLowerCase()`
  of the `RefReject`/`EngineRejectReason` value), removed on `animationend`. `<style id=
  "reference-collect-styles">` injected once, idempotently (`installPageStyles`'s own precedent).
- **`src/ui/inventory.ts`**: `createInventoryUi(container, doc?): { onUi(ui) }`, a fixed
  `<div class="inventory">` (not anchored) with one row per resource, `<style id=
  "reference-inventory-styles">` likewise.
- **Wiring** (`game.ts`'s `startGame`, shared by both pages): `createCollectUi`/`createInventoryUi`
  built once, subscribed through `client.onUi<RefUi>`/`client.onActionResult<RefReject>`.
  `createRealFrameLoop` gained `onOverlay: () => client.overlay.update()` (M18 Deviations: not
  wired automatically by `frame-loop.ts`). `test-entry.ts`'s own `__stepFrame` additionally calls
  `client.overlay.update()` directly (its own `real.loop` never ticks at all, step 0's note), so
  anchors track their tiles across stepped frames too.
- **Found live, worth a permanent note (now in `games/reference/CLAUDE.md`): `Ui.in_range`/
  `world.tile()` need a real sim tick, not just `stepFrame`.** `FrameView::world()` inside `ui()` is
  the client's own *replica* (`client/replica.rs::Replica::tile`: `Err(Unknown)` unless
  `self.held.contains_key(chunk_of(p))`), not the host's authoritative world
  `__dispatchStartCollect`/`admit`/`apply` validate against directly, and not the same data path
  `__probeTile`'s rendered art comes from (pristine terrain the client generates locally, no host
  round trip needed for an unmodified chunk's *bytes*). A chunk only becomes "held" once the host has
  actually included it in a downlink frame, which the host only produces while ticking -- driven by
  `__stepTick`, never by `__stepFrame` alone (confirmed by a scratch repro: `depletion.spec.ts`'s own
  20x `__setCamera`+`__stepFrame(50)` loop, copied verbatim, left `world.tile((0,0))` at `Unknown`
  indefinitely; adding `__stepTick(5)` after it immediately produced the expected `in_range` entry).
  Every existing stepped spec before this one only ever validated against the *host*
  (`__dispatchStartCollect`) or rendered locally-generated terrain (`__probeTile`), so this gap was
  never hit until `Ui.in_range` needed a real `WorldRead`.
- **Browser test**: `reference_ui_smoke_collect_and_inventory` (`tests/browser/ui-smoke.spec.ts`,
  this cut's own short check, not one of the brief's reserved four names) -- pan to the iron
  landmark at `(0, 0)`, settle, `__stepTick(5)` for the replica (above), the button appears, click,
  `__stepFrame` to flush the uplink, `__stepTick(3)` more for `apply` to set `collecting`, then the
  button is disabled and filling; `__stepTick(41)` completes it; the inventory readout shows
  `Iron: 1` and the button resets. ~400 ms, not flaky across repeated local runs.
- **Not verified by this cut** (steps 5-6's own exit criteria): "played by hand" (buttons never
  drifting while panning/zooming, ten stones depleting a tile), the M04 zero-allocation assertion
  against this page, and the `gc` Playwright project wiring noted in the step 0-2 Deviations above
  (still missing, still blocking that assertion). The `hot-paths.md` no-allocation discipline for
  `ui()`'s own new code was followed by construction (fixed-capacity `Vec`s, no closures that
  capture by move, no per-call String work outside the JSON encode `0016 §2` already exempts) but
  not measured by `gc-test` in this cut.

**Not yet done (step 5-6, for the next implementer):** the spawn rule (`RefClient` finding the
nearest land tile, `Ui.spawn`, `main.ts`'s `camera.moveTo`), the scripted
`reference_collect_flow`/`reference_several_buttons`/`reference_pan_out_cancels`/
`reference_new_player_spawns_on_land` browser tests, the `gc` project wiring (step 0-2 Deviations),
and the zero-allocation exit criterion itself.
