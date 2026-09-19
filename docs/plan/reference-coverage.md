# Reference-game coverage of the engine feature list

Closes the item deferred in `PRE-PLAN.md` §10 ("Final check of reference-game feature coverage against the engine feature list"; owners `docs/spec/reference-game.md` and `0003` Consequences). Feature sources: the Requirements of `docs/spec/*.md` and the coverage list in `0003` Consequences. Milestone numbers are `PLAN.md` rows plus the splits 20b, 33b, 34b, 34c.

**Kind:** *play* = ordinary gameplay reaches it; *scripted* = reached only by luck in play, so a scripted reference-game test pins it (`0003`, `0020` §8); *fixture* = no reference feature reaches it; an engine fixture test is the only cover.

M34b and M34c keep the test columns true: a row is done when the named test exists and passes.

## 1. Engine feature → reference-game feature

| Engine feature (source) | Exercised by | Kind | M |
|---|---|---|---|
| Game-owned deterministic worldgen, `Params`, `hash2` (`world.md`, 0008) | simplex terrain + resource scatter; golden over raw tiles | play | 20 |
| Async generation, gen workers, chunk lifecycle, streaming (`world.md`, `client.md`) | panning the world | play | 20 |
| Two tile layers + `aux`; `tile_visual`; art contract; dithering, variants (0007, 0018) | base + resource layer, depletion stages, script-made art | play | 20 |
| Tile overlays, canonical overlay (0007) | depletion; last unit clears the resource | play | 20 |
| Trait tables, `traits_at`, shared rule helper (0007, 0003) | `NOT_BUILDABLE` on water, resources, furnace; `can_place` for host, prediction and ghost | play | 33 |
| Game actions, `dispatch` → ack → `onActionResult`, reject reasons (0004) | collect, craft, place, deposit, take | play | 20b–33b |
| `admit` + presence witness (0001) | `StartCollect { tile, from }` | play | 20b |
| Engine actions `Joined` / `Connected` / `Disconnected` via `on_player` (`simulation.md`) | default player state; colour on join; collect cancelled after the grace | play + scripted | 20, 32, 34, 34c |
| Presence uplink and relay; interpolation of remote motion (0001, 0012) | own spring writes presence; remote circles | play | 20b, 34 |
| Per-player scope (0011) | inventory, unlocks, timers | play | 20–32 |
| Global scope: engine roster + `put_global` (0011) | coloured roster dots | play | 34 |
| `SimRng` and its snapshot (0002, 0003) | colour picked with `w.rng()` on join | play | 34 |
| Multi-tile entity, prototypes, occupancy, `entity_at` (0007) | 2x2 furnace | play | 33 |
| Furnace across a chunk border, partial subscription (0003 list) | scripted placement at a chunk corner | scripted | 33, 34c |
| Timer wheel, sleep/wake, O(active) tick (0007) | smelting; idle furnaces cost nothing | play | 33b |
| Off-screen state keeps simulating (0003 list) | furnace smelts while unsubscribed | scripted | 34b |
| Time units, `done_at`, `clock()` (0006) | 2 s / 5 s durations as `const`; CSS progress | play | 20–33b |
| Prediction and rollback of discrete actions; one-frame ghost swap (0012) | every own action; placement most visibly | play | 33 (engine: 25, 26) |
| `Game::predict` opt-out (0012) | `FurnaceTake` | play | 33b |
| `Unknown` reads → `NotPredictable` at the subscription edge (0003 list) | scripted far placement | scripted | 34c |
| Rejection races: last unit, same spot, same ingots (0003 list) | three race tests at three latencies | scripted | 34c |
| Provisional ids, tile addressing (ADR 0022) | deposit into a just-placed furnace; panel survives the swap | play + scripted | 33b |
| `Ui` observation, low-GC state reads (0003, `client.md`) | every panel; `in_range` at tile-crossing rate | play | 20b |
| Static overlay anchors (0019) | collect buttons, touch Confirm, furnace panel | play | 20b, 33, 33b |
| Tile picking, cursor tile, ghost with `ANCHOR_CURSOR_TILE` (0019) | placement | play | 33 |
| Entity picking from the DrawList (0019) | tap a furnace | play | 33b |
| Semantic `tap`, `pointerType`, touch flow (0019) | mouse click-to-place vs tap-then-confirm | play | 33 |
| Camera pan/zoom, WASD, gestures (`client.md`) | moving around | play + device | 20 |
| `camera.moveTo`; follow target (0019) | new-player spawn; one-frame follow for a returning player | play | 20b, 34 |
| DrawList kinds: `circle`, `ring`, `sprite`, `ghost`, `bar`, `rect`; `PREDICTED`, `SCREEN_PX_STROKE`; `FrameView.zoom` LOD (0018) | players, range ring, furnaces, progress, open-furnace outline | play | 20b–33b |
| Persistence: log, snapshots, reload, replay equality (`simulation.md`, 0005) | reload resumes; golden log replay in every runtime | scripted | 34b |
| Export / import; single-player → hosted (0005) | round trip; save reclaimed on a server by the same secret | scripted | 34b |
| `WorldBusy` (0005) | second tab | scripted | 34b |
| State budget when full (0007, 0004) | tiny `max_entities`; `PlaceFurnace` rejected | scripted | 34b |
| Panic recovery with `Skip`; `SaveIncompatible` (0005) | `test-hooks` build | scripted (slow) | 34b |
| Zero GC in normal play (0016) | GC window over the scripted game; allocation criterion of 20b | scripted | 20b, 34b |
| Server entrypoint, Node adapter, join key, device secret, `max_players` (`sync.md`, 0013) | `games/reference-server`; `Full` / `BadKey` | play + scripted | 34, 34c |
| Reconnect, resume hint, pending resend, disconnect grace (0013) | drop tests | scripted + device | 34c |
| Late join (0013) | third client after the game | scripted | 34c |
| Idle world pauses at zero players (`simulation.md`) | both leave; furnace frozen | scripted | 34c |
| Viewport-scoped deltas, rates, byte budgets, desync hashes on (0010, 0013) | counters over the two-player game | scripted | 34c |
| Same protocol single-player and multiplayer (`sync.md`) | one script, both topologies, equal hashes | scripted | 34b, 34c |
| Capability screen from `checkSupport` (0018 §7) | reference game screen | play | 35 (owned there) |
| Download budgets (`runtime-and-packaging.md`) | size test on the reference `.wasm` | scripted | 35 |
| Heavy mode; tick and frame benchmarks; soak (0020) | reference logs and the standard large save | scripted (slow) | 36 |

## 2. Engine features no reference feature exercises

| Feature | Recommendation |
|---|---|
| `WorldWrite::despawn`, `EntityGone`, prediction tombstones, occupancy release | **Gap worth closing.** Nothing in the spec removes a furnace, yet removal touches occupancy, chunk index, delta scope, per-chunk hashes and the overlay. Recommended: a small addition, "pick up an empty furnace" (one action, one button in the panel): question R3. Until answered: fixture-only (M21, M25) |
| `Game::migrate` with a real second schema; tick-rate rescale (0005, 0006) | fixture-only (M24b `migrate-v*`). A fake old schema in the reference game would be test scaffolding dressed as content |
| Non-default `CHUNK_BITS`, `TICK_RATE`, arena sizes, `keepTickingWhenEmpty` | fixture-only (M07, M12b, M06b, M28b). `durations_at_20_and_30_hz` checks the conversion against the reference durations |
| World edge: `Tile::VOID`, clamp at ±2^23 | fixture-only (M07, M11); the worldgen golden reaches ±2^18 |
| A sim-owned moving entity; entities crossing chunks; continuous prediction | accepted gaps (`0003` Consequences, `0001`); fixture test for chunk-crossing `EntityGone` (M15) |
| `overlay.anchorSlot` + `out.anchor(slot, pos)` | fixture-only (M18). A name tag over the own circle would cover it but is outside the spec |
| Input: `hover` listener, `longpress`, `setMode('tool')` drags, `suspend`/`resume`, keyboard focus rules | fixture-only (M11, M18 test page; `0003` already assigns keyboard focus there) |
| `camera.setConstraints` bounds; a persistent follow target | fixture-only (M11, M18) |
| DrawList `radial`, `FLIP_X`; a full DrawList dropping records | fixture-only (M17) |
| `WorldRead::entities_in` range reads inside rules | fixture-only (M25) |
| `VersionMismatch` reload, `Superseded`, epoch resync, `ResyncChunk` after a real desync, tick-panic `onFatal`, device loss / `rendererLost`, `durable: false` | fixture-only (M28, M28b, M29, M31b, M24, M37) plus device checks; the reference game only displays the resulting status (M34, M34b, M37) |
| Frame-rate degrade, soft cap, chunk token bucket under a dense base | M31 fixtures; M36 on the standard large save (reference bench build) |
| Worker pattern B; Bun and Deno adapters; tarball install; Durable Objects | M35, M35b, M38. Pattern B's smoke uses a `worker.ts` in `games/reference` |
| Single-player pause while the tab is hidden | fixture (M13/M23) plus device check M23 item 5 |

## 3. Requirement matrix (`docs/spec/reference-game.md`)

| Requirement | Test(s) | M |
|---|---|---|
| Simplex, octaves, biomes | `worldgen_golden`, `reference_terrain_renders` | 20 |
| Pixel-art feel: variants, noise, dithering | `gen_assets_reproducible` (variants, priority, band present); engine shader tests (M09b); by hand | 20 |
| Tile assets from a script; 16 px, 4 variants | `gen_assets_reproducible` | 20 |
| Resource layer, deterministic scatter, none on water | `worldgen_no_resource_on_water`, `worldgen_golden` | 20 |
| 10 units, depletion | `collect_last_unit_clears_resource_and_overlay_is_canonical`, `reference_depletion_visible` | 20 |
| Players are circles; spring | `extract_hash_player_circle`, `spring_settles_and_is_dt_independent` | 20b |
| Position is presence; relayed; witness range-checked | `admit_*`, `collect_out_of_range_rejected`, `reference_presence_only_to_subscribers`, `reference_two_players_see_each_other` | 20, 20b, 34 |
| Collect button per resource in range; 2 s; fill | `reference_collect_flow`, `reference_several_buttons` | 20b |
| One collect and one craft, no queue; pan-out cancels | `collect_busy_rejected`, `craft_rejected_when_busy`, `collect_and_craft_run_together`, `reference_pan_out_cancels` | 20–32 |
| Inventory and unlocks per player | `unlock_is_per_player` | 32 |
| Spawn on nearest land; returning player resumes; float over water | `spawn_is_nearest_land_tile`, `reference_new_player_spawns_on_land`, `reference_returning_player_resumes`, `reference_reload_resumes`; `admit_accepts_within_tolerance` uses a position over water | 20b, 34, 34b |
| Roster of coloured dots | `joined_assigns_distinct_colours`, `reference_roster_follows_join_grace_and_return` | 34 |
| Unlock at 5 stone; menu appears; furnace cost and time | `unlock_on_threshold_stone_not_before`, `craft_deducts_cost_then_completes_on_time`, `reference_craft_flow` | 32 |
| Construction UI; 2x2; not on water or buildings; mouse and touch flows | `place_*`, `reference_place_mouse`, `reference_place_touch` | 33 |
| The rule asks the tiles | `can_place_names_no_tile_type` | 33 |
| Furnace UI: deposit iron, coal or wood | `deposit_validates_item_count_and_cap`, `reference_furnace_flow` | 33b |
| One ingot per 5 s; coal 10, wood 2 | `smelt_takes_five_seconds_at_20_and_30_hz`, `one_coal_smelts_exactly_ten`, `one_wood_smelts_exactly_two` | 33b |
| Any player, any furnace; take-all; ore and fuel stay | `any_player_can_use_any_furnace`, `take_all_moves_ingots`, `reference_full_game_two_players` (no action removes ore or fuel) | 33b, 34c |
| Framework-free TypeScript | `reference_package_depends_only_on_engine` | 20 |
| Whole game, single-player and multiplayer | `reference_full_game_single`, `reference_golden_replay`, `reference_full_game_two_players` | 34b, 34c |

## 4. Questions (for `docs/plan/questions-for-tyler.md`; briefs assume the default)

| # | Question | Default assumed | Affects |
|---|---|---|---|
| Q4 | (existing) Collect range | 3 tiles, centre to centre | 20, 20b |
| R1 | May a furnace be placed over a resource tile (burying it)? | No: resource ids carry `NOT_BUILDABLE`; a depleted tile becomes buildable | 33 |
| R2 | `FurnaceTake` is the one unpredicted action (result shows one round trip later) so that the `predict` opt-out has a user. Acceptable feel? | Yes | 33b |
| R3 | Add "pick up an empty furnace" so that `despawn` has a reference user? It extends the spec's stated full scope. | No (fixture-only); **recommended: yes** | 33b, 34b, 34c |
| R4 | Should the game always offer Export (protection against Safari's 7-day eviction), or only on the `SaveIncompatible` / status screen? | Only on the status screen | 34b, 37 |

## 5. Gaps found in the ADRs while planning (none blocks a Requirement)

- **No TypeScript → `ClientSide` channel.** Construction mode and closing the furnace panel are client-local UI state the game's Rust must know (it draws the ghost). Proposed seam `client.input.emit` as a new input-ring record kind, owned by M18 (`33-reference-furnace.md`, Seams).
- **How TypeScript obtains the `from` witness** is unstated: the spring lives in Rust, `dispatch` in TypeScript, and `Ui` must not carry per-frame values. Settled in `20b` (Planning decisions) with no API change.
- **`ui()` must re-run on client-side state changes**, not only replica changes (`in_range` follows the spring). Required of M16/M17 in `20b`.
- **No game-facing read of the engine roster** (`FrameView` has none). `34-reference-multiplayer.md` adds `FrameView::roster` if missing.
- **Player timers have no engine timer:** the wheel is keyed by `EntityId` (`0007` §7). Covered by M12b's `TickCx::{player_count, player_id_at}`.
