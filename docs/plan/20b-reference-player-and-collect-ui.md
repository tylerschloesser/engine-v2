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
- Browser (stepped frames, injected input): `reference_collect_flow` (pan to the nearest stone landmark, a button appears anchored within 1 CSS px of the tile centre, click, step 40 ticks, inventory shows 1 stone and the button is enabled again), `reference_several_buttons` (two resources in range give two buttons), `reference_pan_out_cancels` (start, pan away, `collecting` becomes null, no item), `reference_new_player_spawns_on_land`.

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
(filled in during Phase 3)
