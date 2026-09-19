# M33b: Reference game: furnace deposit, take, pick-up, smelting and panel

Status: not started · After: 33 · Tyler-dependent: R2 (`FurnaceTake` opts out of prediction; unanswered; default assumed: yes), see `docs/plan/questions-for-tyler.md`. R3 is answered: "pick up an empty furnace" is a Requirement and is built here

Split from M33 during planning (see that brief).

## Goal
Clicking a furnace opens a panel; any player can deposit iron and fuel, take all ingots, and pick an empty furnace back up into their inventory; the furnace smelts on the timer wheel at the Requirement's rates, keeps smelting when nobody is looking, and costs nothing when idle.

## Read first
1. `docs/spec/overview.md`
2. `docs/spec/reference-game.md` (Furnace)
3. `docs/decisions/0007-world-model.md` (§7 what ticks: active lists, sleep/wake, timer wheel)
4. `docs/decisions/0022-entity-ids-and-provisional-ids.md` (§6 addressing rule, §7 `entity(id)` on a client, including the overlay tombstone)

Look up at the step: `TickCx` methods: the "Exact `TickCx` shape" decision in `docs/plan/12b-world-access-and-sim-driver.md` and the M21b brief; ratios stay counts `0006` "Rates and continuous quantities"; picking `0019` §4; prediction opt-out and the authoritative clock for remote machines `0012` ("What is predicted", "Two clocks").
Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md`, `games/reference/CLAUDE.md`. Skill: `add-action-type`.

## Scope
- `Action::FurnaceDeposit { at, item, count }` and `Action::FurnaceTake { at }`, where `at` is any tile under the footprint, resolved with `entity_at`. Deposit validates: a furnace is there, item is iron, coal or wood, `1 <= count <= held`, the slot does not overflow; then one `put_entity` and one `put_player`. Take validates `ingots_out > 0`, moves all ingots to the player. Ore and fuel never come back out.
- `Action::FurnacePickUp { at }`, addressed by tile like the other two (0022 §6): `entity_at(at)` resolves the furnace; valid only when it is empty (`iron_in`, `coal`, `wood`, `burn_left` and `ingots_out` all zero, else `Reject::FurnaceNotEmpty`; no furnace there is the same reject Deposit and Take use); then `despawn(id)` and one `put_player` with furnace item +1. Any player may do it; no range requirement (as placement, M33). `Game::growth` is `Growth::NONE` (0023). `despawn` releases occupancy and cancels the timer and wake (M21, M21b), so the four tiles are buildable again in the same tick.
- `Game::predict` returns `false` for `FurnaceTake` (R2) and `true` otherwise, so `FurnacePickUp` is predicted: the overlay holds a tombstone for the furnace and the inventory +1 until the ack.
- Smelting in `tick`, in `rules/furnace.rs`: for each woken furnace and each due timer call one `advance(cx, id)`: if a smelt is due, finish it (iron −1, ingot +1, burn −1); then, if idle with iron and either burn left or fuel to light, light fuel if needed (coal first), set `smelt_done_at = now + SMELT`, `wake_at`; otherwise sleep with no timer. One `put_entity` per state change, never per tick. Fuel ratios are `const` counts.
- `RefClient`: `open: Option<TilePos>` (anchor tile), set when a `tap` carries a furnace's `pick_id`, cleared by `local::CLOSE_PANEL`, by a tap on empty ground, or when the furnace is gone. `Ui.furnace: Option<{ at, iron_in, coal, wood, burn_left, ingots_out, smelt_done_at }>`. In `extract`: lit sprite frame while smelting, a `bar` from `smelt_done_at` on the authoritative clock, a `rect` outline on the open furnace; bars are skipped below a zoom threshold from `FrameView.zoom`.
- DOM `src/ui/furnace.ts`: panel anchored above the furnace with `client.overlay.anchor`; deposit buttons per item (+1, +5, all) enabled from the inventory; Take all; a Pick up button enabled only when `Ui.furnace` shows all five counts at zero (a press dispatches `FurnacePickUp { at }`; the panel closes through the "furnace is gone" rule above, with no TypeScript state); counts; a smelt progress element driven by one CSS animation per `smelt_done_at` change, on `clock().authoritative`. Close button emits `local::CLOSE_PANEL`.

## Non-scope
Removing a furnace that is not empty, or any removal other than pick-up; taking ore or fuel back; partial take; more than one open panel; any second machine type.

## Files, packages and crates touched
`games/reference/` only (`sim/src/rules/furnace.rs`, `sim/src/{types,content,client,lib}.rs`, `src/ui/furnace.ts`, tests).

## Seams
**Provides:** `rules::furnace::advance`, `content::{SMELT, COAL_INGOTS, WOOD_INGOTS}`, `Reject::FurnaceNotEmpty`, browser helpers `openFurnace(page, tile)`, `deposit(page, item, n)`, `takeAll(page)`, `pickUp(page)`; `RefScenario::{deposit, take, pick_up, furnace_at}`.
**Consumes:** `Furnace`, `can_place`, `local::CLOSE_PANEL`, `placeFurnace`, `craftFurnace` (M33); `TickCx::{next_woken, next_due, wake_at}` and "a put from `apply` wakes the entity" (M21b; 0024 §7); entity picking from the DrawList and `tap` events in `FrameCx` (M18); `DrawList::{bar, rect}` (M17), sprite frames (M17b); `Game::predict` honoured by the pending queue, overlay tombstones and `entity_at` over `Predicting` (M25); `despawn`, occupancy release and footprint-scoped `EntityGone` (M21; timer and wake removal M21b); tombstones skipped by `FrameView::entities()` (M26); `Growth::NONE` (M21, 0023).

## Planning decisions
- **`advance` is the only furnace rule** and is idempotent for a furnace with nothing to do, so the wake from a deposit and the wheel's due timer share one code path.
- **Fuel is lit at smelt start, ore is consumed at smelt end.** The panel then shows the iron being smelted as still inside, and an interrupted world (pause, recovery) never loses ore.
- **Coal burns before wood** when both are present. The spec is silent; any fixed order is deterministic, and this one is a one-line change.
- **`FurnaceTake` is not predicted.** Its result depends on a counter that tick rules change on the host, so a prediction is often stale by one ingot; it is also the one action in the game where opting out is defensible, and it exercises `Game::predict` and the unpredicted pending path, which no other feature does.
- **"Empty" includes `burn_left`.** The Requirement says no ore, fuel or ingots inside; lit fuel is fuel, so a furnace with burn left cannot be picked up and nothing is ever destroyed by a pick-up. A furnace that is smelting always holds ore (ore is consumed at smelt end), so an empty furnace never has a timer to lose. If it plays badly (coal leaves burn that only more iron can use up), dropping `burn_left` from the test is a one-line change: record it under Deviations.
- **Pick-up is predicted and addressed by tile.** The panel is keyed by tile and TypeScript holds no entity id, so the action carries `at`. Two players racing resolve on the host: the second `FurnacePickUp`, or a `FurnaceDeposit` that arrives after it, finds no furnace and is rejected having written nothing; a deposit that arrives first makes the pick-up `FurnaceNotEmpty`, and the predicting client's tombstone is dropped on the next replay, so the furnace reappears with the deposit inside. The second player's open panel closes because `entity_at(open)` stops being a furnace once `EntityGone` reaches their replica (checked in `frame`; `Unknown` leaves the panel open).
- **Panel state is keyed by anchor tile**, so it survives the ghost-to-real swap of a just-placed furnace (ADR 0022 §6) and a deposit sent before the placement ack is valid on the host.
- **`pick_id` is the entity id**, real or provisional; Rust resolves it to the anchor tile in `frame`. TypeScript never holds an entity id.
- **Slot cap** 999 per furnace slot, rejecting overflow, so the entity stays plain fixed-width data.

## Order of work
1. Actions, `predict`, `growth`, deposit, take and pick-up in `apply`, native tests (pick-up's prediction and two-player cases last).
2. `advance`, wake and timer wiring, ratio and idle-cost tests.
3. `open`, `Ui.furnace`, drawing (lit frame, bar, outline).
4. `furnace.ts` panel, Pick up button last. 5. Browser tests; `games/reference/CLAUDE.md`.

## Tests added
- Rust native: `deposit_validates_item_count_and_cap`, `deposit_by_any_footprint_tile`, `one_coal_smelts_exactly_ten`, `one_wood_smelts_exactly_two`, `smelt_takes_five_seconds_at_20_and_30_hz`, `coal_before_wood`, `stops_without_iron_or_fuel_and_resumes_on_deposit`, `idle_furnaces_cost_nothing` (1,000 furnaces with nothing to do: 1,000 ticks produce no puts, `active_len == 0`, hash unchanged), `take_all_moves_ingots`, `take_empty_rejected`, `any_player_can_use_any_furnace`, `same_ingots_race_second_take_rejected`, `deposit_into_predicted_furnace_before_ack` (M25 testkit), `take_is_not_predicted`, `rejected_actions_wrote_nothing`, `replay_equals_live_hash` extended through a full smelt and a pick-up. Pick-up: `pickup_empty_despawns_and_returns_item` (entity gone, four tiles buildable again, furnace item +1, no timer or wake left, placing on the same tiles succeeds), `pickup_rejected_unless_empty` (one case per counter, `burn_left` included; nothing written), `pickup_by_any_footprint_tile_and_any_player`, `pickup_no_furnace_rejected`, `predicted_pickup_tombstone_then_ack` (M25 testkit, delayed client: between dispatch and ack `entity_at(at)` over the overlay is `Ok(None)`, `can_place` on those tiles is true, inventory shows +1, and `extract` emits no furnace record; across the ack the furnace never reappears), `predicted_pickup_rejected_restores_furnace` (another player's deposit lands first: host rejects `FurnaceNotEmpty`, the tombstone is dropped on replay, the furnace is back with the deposit and the inventory +1 is gone), `pickup_sends_entity_gone_and_closes_other_panel` (two clients, B has the panel open on the furnace and a `FurnaceDeposit` in flight; A picks up; B's frame carries `EntityGone`, B's `open` becomes `None` and `Ui.furnace` is `None` on B's next `frame`, B's deposit is rejected and wrote nothing, both replicas hash equal to the host).
- Browser: `reference_furnace_flow` (place, tap the furnace, panel anchored to it, deposit iron and coal, step one smelt, bar and lit frame present in the DrawList, take all, inventory shows the ingot), `reference_furnace_panel_survives_swap` (open the panel on a predicted furnace, step across the ack, panel still open on the same tile), `reference_furnace_pick_up` (Pick up is disabled while anything is inside; after take-all on a furnace with no fuel left it enables; a press removes the furnace record from the DrawList in the next published frame, closes the panel, and the inventory shows the furnace item; placing it again works).

## Exit criteria
- [ ] All tests above pass by name.
- [ ] The reference game removes an entity: `pickup_empty_despawns_and_returns_item`, `predicted_pickup_tombstone_then_ack` and `pickup_sends_entity_gone_and_closes_other_panel` pass, and `docs/plan/reference-coverage.md` §2's `despawn` row names them.
- [ ] By hand: place, fuel and load a furnace, pan far enough away that its chunk is unsubscribed (`0010`: ring 3 plus the hold time), return, and the ingot count has advanced.
- [ ] Bindings regenerated and committed.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t reference` · `pnpm test browser -t reference_furnace` · `pnpm --filter reference dev`.

## Budgets
Tick time (`PRE-PLAN.md` §7 row 2): `idle_furnaces_cost_nothing` is the deterministic guard; the wall-clock benchmark on the standard large save of `0020` §9 belongs to M36 and uses `advance` unchanged.

## Context artifacts
`games/reference/CLAUDE.md`: "machines sleep: change state only in `advance`, one put per change, schedule with `wake_at`"; "client state that points at an entity is keyed by tile and re-checked with `entity_at` every `frame`: entities can disappear".

## Manual device checks
None of its own; M39's section plays this flow.

## Deviations
(filled in during Phase 3)
