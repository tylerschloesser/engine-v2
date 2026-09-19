# Requirement coverage

Every Requirement in `docs/spec/` mapped to the milestone exit criterion, named test or device check that verifies it. This file holds the mapping only: the Requirement text lives in the spec, the test's definition lives in the brief (`docs/plan/<NN>-<slug>.md`, "Tests added" and "Exit criteria"). Quotes are a few identifying words, not the Requirement.

Axis: spec Requirement → verifier. The other axis (engine feature → reference-game feature) is `reference-coverage.md` §1–2; its §3 links to the last table here, which is the only Requirement matrix for the reference game (M34b and M34c keep it true).

**Status.** *covered*: an exit criterion, a named test an exit criterion requires, or a device-check item verifies it. *unverified*: a brief builds it (Goal or Scope) but nothing checks it. *uncovered*: no brief mentions it. *n/a*: a non-goal or a statement with nothing to build. Three rows carry a ruling instead: *waived (Q5)*, *covered by policy, pending Q12*, *unverified by decision (Q6), carried to 39b* (`questions-for-tyler.md`).

**Keeping it true.** A Phase 3 session that adds, renames or drops an exit criterion or test updates the rows that cite it, in the same commit. A row turns *covered* only when the cited name exists in the brief. M39 re-audits the whole file against the code (`pnpm acceptance:check` finds every cited test; `39-acceptance.md`), and M39b carries forward whatever is still *unverified*. `-android` device-check rows are never cited (Q5: no device).

Audited 2026-09-19 against the working tree of `phase-2-plan`.

## `overview.md`

### Engine vs. game ([overview.md#engine-vs-game](../spec/overview.md#engine-vs-game))

| Requirement | M | Verified by | Status |
|---|---|---|---|
| Engine: "Camera, viewport, and most user input" | 11 | `camera.pan_keeps_world_point`, `camera.pinch_about_midpoint`, `camera.wheel_about_cursor`, `input.dom_path_pan_and_tap` | covered |
| Engine: "which chunks are visible/subscribed; requesting async chunk generation; chunk lifecycle" | 08b, 15 | `gen: visible before ring 1 before ring 2`, `queue_cancels_undispatched_beyond_ring3`, `subs_ring1_plus_lookahead`, `subs_unsubscribe_after_hold` | covered |
| Engine: "WebGPU rendering" | 09, 17 | `terrain.probe_tile_colours`, `draw.circle_and_ring_probe`, `canvas.presents` (09b) | covered |
| Engine: "Tick loop and scheduling; … worker or on a server" | 13, 27 | `simhost_paces_at_tick_rate`, `sim_worker_steps_and_hashes`, `join-converges` | covered |
| Engine: "Engine-defined actions (connect/disconnect)" | 12b, 28, 28b | `joined_must_put_player`, `handshake/join-then-return-same-player`, `reconnect/after-grace-logs-disconnected` | covered |
| Engine: "Connected players and their chunk subscriptions" | 15 | `subs_*`, `replica_hash_equals_host_region_hash` | covered |
| Engine: "Transport, delta derivation and delivery, the interpolation/prediction machinery" | 12b, 15, 25, 29, 30 | `every_put_is_one_delta_with_scope`, `modified_chunk_enters_as_snapshot_then_deltas_from_next_tick`, `placement_is_immediate_and_converges`, `ws/join-converges`, `constant_latency_tracks_path` | covered |
| Engine: "Persistence (snapshots + action log) and replay" | 22, 22b | `replay_from_snapshot_matches_genesis_replay`, `recovered_hash_equals_uninterrupted_replay` | covered |
| Game: "World generation algorithm" | 08, 20 | `worldgen_contract_fixture`, `worldgen_golden` | covered |
| Game: "Tile art and assets" | 09, 17b, 20 | `manifest.schema_errors`, `sprites.schema_errors`, `gen_assets_reproducible` | covered |
| Game: "Data model (tiles, entities, player state)" | 12 | `store_roundtrip_bytes_equal`, `puts_fixture_builds_wasm32` | covered |
| Game: "Simulation rules and game-defined actions" | 12b, 16 | `puts_script_a_golden`, `vertical_slice` | covered |
| Game: "Replicated data types, the presence type, per-action prediction opt-outs" | 12, 19, 25 | `store_golden_bytes`, `presence_section_golden`, `opt_out_declines` | covered |
| Game: "Game UI (DOM overlay)" | 16b, 18 | `dom_counter_follows_global`, `overlay.anchor_tracks_world_point` | covered |
| Game: "Per-game config (chunk size, world cap, etc.)" | 07, 06b, 21 | M07 exit 1 (`CHUNK_BITS` 4, 5, 6), `start.arena_config_rejected`, `init_rejects_budget_over_arena` | covered |

### Fixed decisions ([overview.md#fixed-decisions-tylers](../spec/overview.md#fixed-decisions-tylers))

| Requirement | M | Verified by | Status |
|---|---|---|---|
| "pnpm monorepo" | 01 | exit 1 (`pnpm install --frozen-lockfile`), exit 3 | covered |
| "TypeScript on the JS side" | 01 | exit 6 (`pnpm lint` four checks incl. typecheck) | covered |
| "Rust→WASM for everything that reasonably can be" | 06b, 29 | `workers.spawn_local` (WASM roles), M29 exit 2 (no frame parsing in `net.ts`) | covered |
| "Accepted exception: … WebGPU calls, the camera, and input handling are TypeScript on the main thread" | 09, 11 | `terrain.upload_budget_while_panning`, `camera.block_reaches_worker_each_frame` | covered |
| "Game authors write simulation logic in Rust" (worldgen, types, actions, tick, presence, view code) | 12, 17, 19, 20 | `puts_fixture_builds_wasm32`, `drawlist.fixture_hash_golden`, `sampler_rate_and_on_change`, M20 exit 4 | covered |
| "game crate and engine crate compile into one WASM module" | 02, 06b | `build: game.json matches bytes`, `abi registry`, `fresh_instance_reuses_module` (24) | covered |
| "TypeScript is for bootstrapping and UI" | 20, 20b | `reference_package_depends_only_on_engine`, `reference_collect_flow` | covered |
| "single published npm package, with zero runtime npm dependencies" | 35, 35b | M35 exit 1 (`pack --json`), M35b exit 5 (zero `dependencies`) | covered |
| "multiple entrypoints (main thread, worker, server)" | 35 | `exports-map` | covered |
| "reference game is a separate, private package: Vite plus a simple game" | 20 | exit 1; `reference_package_depends_only_on_engine` (asserts `"private": true` and the single `workspace:*` dependency) | covered |
| "Custom WebGPU renderer; no rendering library" | 09, 35b | `wgsl.terrain_validates`, M35b exit 5 | covered |
| "WebSockets for multiplayer" | 29 | `ws/join-converges`, `mp/two-pages` | covered |
| "Game UI is a game-owned DOM overlay; the engine renders no UI widgets" | 18, 20b | `overlay.widget_click_not_a_tap`, `reference_several_buttons` | covered |
| "The camera never mutates the world, and is not an action" | 15 | `camera_walk_changes_no_state` (same action script, different camera walks, equal state hashes); camera reports feed `SubscriptionSet` only | covered |
| "host uses each client's camera + viewport only to decide chunk subscriptions" | 15, 27 | `subs_clamps_oversized_and_zero_views`, `headless-ui-and-camera` | covered |
| "Only actions change the world" | 12b, 19, 22 | `rejecting_apply_wrote_nothing`, `presence_is_not_state`, `replay_from_genesis_checkpoints` | covered |
| "server entrypoint should be agnostic to where it's hosted" | 27, 35b | M27 exit 3 (no `node:` import outside the adapter), `server adapters export parity` | covered |

### Scale and trust, non-goals ([overview.md#scale-and-trust](../spec/overview.md#scale-and-trust))

| Requirement | M | Verified by | Status |
|---|---|---|---|
| "2–8 players per world" | 28, 34, 38 | `handshake/full`, `joined_assigns_distinct_colours` (eight), M38 results-table criterion (tick p50/p99 under 8 clients) | covered |
| "One process per world" | 27 | `server/load-or-create` | covered |
| "The world fits in memory" | 21, 36 | `full_world_rejects_place_accepts_remove_then_place`, `slow_tick_large_save`, device M39-large-save | covered |
| "Server-authoritative validation of actions is enough" | 16, 19, 31 | `admit_reject_is_not_recorded`, `admit_witness`, `rates/action-rate-limited` | covered |
| "decent, modern mobile connections" | 27, 30, 31 | `conditioned-link`, `jitter_profile_adapts`, `rates/*` via `assertBudget`; device M38-socket-resume | covered |
| Non-goals (auth, matchmaking, audio, non-WebGPU fallback, modding, several worlds per process) | – | non-goal: nothing to build | n/a |

## `world.md` ([Requirements](../spec/world.md#requirements))

| Requirement | M | Verified by | Status |
|---|---|---|---|
| "infinite 2D grid world, split into chunks" | 07 | `chunk_of_negative_tiles_floors`, `chunk_key_roundtrip` | covered |
| "How the world is generated … and the tile art are the game's responsibility" | 08, 09 | `worldgen_contract_fixture`, `texel.registered_tables` | covered |
| "engine manages the viewport, knows which chunks are visible, and requests chunk generation" | 08b | `visible_rect_negative_and_edge`, `gen: visible before ring 1 before ring 2` | covered |
| "Chunk generation is async" | 07, 08b | `cache_invisible_insert_pristine_any_order`, `queue_keeps_late_results`, `gen: drops 0, mem_grows 0, stats exact` | covered |
| "Generation is deterministic: same seed, parameters, and chunk coordinates" | 08, 08b | M08 exit 1 (golden in six runtimes), `gen: one and two workers give equal chunk hashes` | covered |
| "Chunk size … configurable per game" | 07 | exit 1 (`CHUNK_BITS` 4, 5, 6), `dims_reject_unsupported_bits` | covered |
| "max world size (chunk count or bytes) … configurable per game" | 21 | `full_world_rejects_place_accepts_remove_then_place`, `init_rejects_budget_over_arena` | covered |
| "can be assumed to fit in memory" | 36 | `slow_tick_large_save`, M36 exit 6 (high-water mark) | covered |
| "±8.4 million tiles per axis (±2^23)" | 07, 09, 11, 17 | `worldpos_range_and_clamp`, `terrain.far_from_origin_exact`, `camera.precision_at_2pow23`, `drawlist.pos_relative_to_window_origin_exact_at_2pow23` | covered |
| "Worldgen code and the seed ship to clients" | 15, 28 | `pristine_chunk_enters_as_coord_only`, `handshake/reveal-after-visible-chunks` | covered |
| "worldgen emits tile data only: no generator-spawned entities" | 08 | `gen: gen_chunk fills GenOut` (the ABI returns a tile slab only) | covered |
| Reading: "the cap applies to *materialized* chunks" | 07 | `cache_invisible_matrix`, `lru_evicts_least_recent` | covered |

## `simulation.md` ([Requirements](../spec/simulation.md#requirements))

| Requirement | M | Verified by | Status |
|---|---|---|---|
| "tick-based simulation" | 13 | `simhost_paces_at_tick_rate`, `simhost_caps_catchup_and_drops_time` | covered |
| "runs in the cloud (multiplayer) or in a web worker (single-player). Same sim code" | 13, 27 | `wasm_idle_100_matches_native`, `sim_worker_steps_and_hashes`, M27 exit 2 | covered |
| "All actions are serialized and sent as messages" | 14, 16 | `golden_uplink_batch`, `vertical_slice` | covered |
| "the world can be reconstructed exactly" | 12b, 22, 34b | `replay_equals_live`, `replay_from_genesis_checkpoints`, `reference_golden_replay` | covered |
| "tracks which players are connected and what each is seeing" | 15 | `subs_ring1_plus_lookahead`, `first_frame_has_global_and_own_player` | covered |
| "Some actions are engine-defined … others are game-defined" | 12b, 16, 28b | `joined_must_put_player`, `action_lands_on_next_tick`, `reconnect/after-grace-logs-disconnected` | covered |
| "Camera + viewport updates … neither logged nor needed for replay" | 22, 34b | `camera_walk_changes_no_log` (different camera walks, byte-identical logs); replay without cameras: `reference_golden_replay` | covered |
| "engine manages data storage: … browser, … server" | 22b, 23 | `storage_conformance_fs`, `storage_conformance_opfs` | covered |
| "persisted occasionally, for crash recovery" | 22, 22b | `snapshot_every_1200_ticks_if_dirty`, `crash_mid_frame_truncates_and_resumes` | covered |
| "Actions are stored indefinitely" | 22b | `prune_keeps_bases_and_latest_two`, `replay_world_checkpoints_node` (from genesis across rolled segments) | covered |
| "multiplayer world pauses at zero connected players" | 28b | `lifecycle/idle-stops-ticks-then-onidle`, `lifecycle/hello-resumes` | covered |
| "a per-game flag can keep it ticking" | 28b | `lifecycle/keep-ticking-when-empty` | covered |
| "single-player world pauses when the tab is hidden" | 23 | `hidden_pauses_and_snapshots`; device M23-hidden-pause | covered |
| "No offline progress" | 28b, 34c | `lifecycle/idle-stops-ticks-then-onidle` (timer fixture unchanged), `reference_idle_world_pauses` | covered |
| "saves and logs are version-stamped" | 22, 24b | `persist_snapshot_golden_bytes`, `identity_compare_matrix` | covered |
| "a mismatch produces a clean 'save incompatible' error" | 24b | `no_migrate_hook_save_incompatible_files_untouched`, `save_incompatible_rejects_ready_and_export_still_works` | covered |
| "optional `migrate` hook" | 24b | `schema_bump_runs_migrate`, `migrate_default_is_save_incompatible` | covered |
| "Old sim binaries are not archived" | – | nothing to build | n/a |
| "Save export/import at the engine level" | 23 | `export_import_roundtrip_browser`, `export_import_roundtrip_node`, `archive_golden_bytes` | covered |
| "the path from a single-player world to a hosted one" | 23, 34b | `export_browser_import_node_same_hash`, `reference_single_player_save_to_server` | covered |
| "Game UI for it is optional" | 34b | `reference_export_import_roundtrip` | covered |

## `sync.md` ([Requirements](../spec/sync.md#requirements))

| Requirement | M | Verified by | Status |
|---|---|---|---|
| "deltas to each client/renderer, scoped to that client's viewport" | 15 | `view_unknown_outside_subscription`, `entity_straddling_subscribed_and_unsubscribed_chunks_delivered_once` | covered |
| "client-side layer manages the currently displayed state and the latest received state" | 15, 25 | `frame_is_atomic_on_malformed_tail`, `dependent_actions_replay_across_ack` | covered |
| "interpolates and predicts so lag isn't noticeable" | 26, 30 | `prediction-no-flicker`, `stall_then_recover`; device M34-own-timer-bar, M34-remote-motion | covered |
| "engine derives deltas from the rules' writes" | 12b | `every_put_is_one_delta_with_scope` | covered |
| "predicts by re-running the same `apply` on the client" | 25 | `placement_is_immediate_and_converges`, `rival_takes_the_spot_never_torn` | covered |
| "interpolates remote motion" | 30 | `hermite_hits_samples_and_is_c1`, `constant_latency_tracks_path` | covered |
| "game writes no delta types and no separate prediction or interpolation logic" | 33, 34 | `predicted_place_then_ack_keeps_one_furnace`, `extract_hash_remote_players` (reference game has neither) | covered |
| "may opt individual actions out of prediction" | 25, 33b | `opt_out_declines`, `take_is_not_predicted` | covered |
| "Tick rate … must accommodate mobile network patterns" | 12b, 31 | `ticks_conversion_20_and_30_hz`, `rates/steady-busy-field`, `rates/degrade-on-stall`; device M38-remote-motion | covered |
| "Transport: likely WebSockets" | 29 | `ws/join-converges`, `ws/trace-identical` | covered |
| Hosting: "a library that needs one long-lived context, a timer, injected connections, and injected storage" | 27 | exit 3, exit 4, `memory-connection`, `server/accept-before-ready-waits` | covered |
| Hosting: "Node/Bun process … first" | 27, 29, 35b | M27 exit 2, `reference-server/smoke`, `bun-adapter loopback` | covered |
| Hosting: "Cloudflare Durable Objects second" | 38 | DO ADR criterion, `do/local-smoke` | covered |
| Hosting: "Vercel is not a target for the sim (it can serve the static client)" | 38, 39b | client is served by the Fly machine (`reference-server/static-headers`, `deployed/coi-and-online`); a separate static host is not deployed: M38's README criterion records it and M39b's exit criterion `grep -n "static host" PROMPT.md` carries it | unverified by decision (Q6), carried to 39b |
| Hosting: "about $5/month per always-available world, about $0 while idle" | 38 | results-table criterion (Fly always-on and idle cost, DO projected cost) | covered |
| Sessions: "join key in the invite link plus a device-local identity secret" | 28 | `handshake/bad-key`, `handshake/join-then-return-same-player`, `secret/persists-across-reload` | covered |
| Sessions: "no cross-device recovery" | – | nothing to build | n/a |
| Sessions: "exactly one world, created or loaded at startup" | 27 | `server/load-or-create`, `server/ready-rejects-on-corrupt-world` | covered |
| Sessions: "mapping URLs to worlds is the deployer's problem" | – | nothing to build | n/a |
| Reading: "Clients never hold the whole world" | 15 | `leave_frees_overlay_keeps_pristine`, `view_unknown_outside_subscription` | covered |
| Reading: "Single-player uses the identical protocol; the only difference is the transport" | 15b, 34b, 34c | `host_accepts_ring_connection_and_hashes_match`, `reference_full_game_single` vs `reference_full_game_two_players` | covered |

## `runtime-and-packaging.md`

| Requirement | M | Verified by | Status |
|---|---|---|---|
| [Runtime](../spec/runtime-and-packaging.md#runtime-and-performance): "everything is async. The main thread does only what is necessary" | 06b, 17b | M06b exit 2 (`postMessage` only for lifecycle), `bench.frame_worstcase` (main rAF share) | covered |
| "as much as possible in Rust→WASM running in web workers" | 06b | `workers.spawn_local`, `workers.spawn_remote` | covered |
| "minimal or no garbage collection" | 04 + every `zeroGcSuite` page | `gc-loop clean`, pages `terrain`, `input`, `drawables`, `anchors`, `gc/multiplayer-topology`, `gc.reference_single_player` | covered |
| [Packaging](../spec/runtime-and-packaging.md#packaging): "engine has no dependencies and is the single export" | 35, 35b | M35 exit 1, M35b exit 5 | covered |
| "Exports must be modeled so a bundler like Vite can import each piece" (worker splitting) | 35 | `tarball-install @slow` (patterns A and B, dev and build), `exports-map` | covered |
| "engine also exports a server entrypoint" | 27 | exit 4, `server/load-or-create` | covered |
| "`engine/vite` plugin entrypoint … Node built-ins only; Vite is a types-only optional peer" | 02b | exit 3 | covered |
| "injected transport adapter … the game's server package installs `ws`" | 29 | `reference-server/smoke`, `ws/join-converges` | covered |
| Rust crate policy: allowed list (`serde`, `postcard`, `serde_json`, `ts-rs`, `libm`), "anything else needs an ADR" | 02 | `crate-policy` (`unit`; M02 exit: adding `rand` fails it); M35 consumes it | covered |
| "`ts-rs` … code LTO removes; the size test checks that" | 35 | `ts-rs zero bytes @slow` | covered |
| "Stable Rust only (so no WASM threads)" | 01, 02 | M01 exit 2 (pins), `target features` | covered |
| "Rust crate is bundled inside the npm package; a tarball-install test" | 35 | exit 1, exit 2 | covered |
| "Not published publicly yet" | 01 | exit 8 (`settings.json` denies `pnpm publish`, `cargo publish`) | covered |
| "Node ≥ 22 and Bun are tested" | 02, 27, 35b | M02 exit 1, M27 exit 2, `bun-adapter loopback` | covered |
| "Deno is best-effort" | 35b | `deno-adapter @slow` | covered |
| [Platform](../spec/runtime-and-packaging.md#platform-requirements-and-budgets): "Cross-origin isolation is mandatory" | 02b, 03, 06b | `plugin-dev: headers on every response`, `wiring.spec.ts`, `start.not_isolated_error` | covered |
| "There is no `postMessage` fallback" | 06b, 37 | M06b exit 2, M37 exit 5 | covered |
| "Baseline phone: iPhone 12-class / 4 GB Android" | 11, 16 | device M11-memory, M16-coexist (iPhone; Android half: see `client.md` Chrome Android row) | covered |
| "At most 256 MB per WASM instance" | 06b | `arena.sum_rule`, `start.arena_config_rejected`, `workers.spawn_local` (`W_MEM_PAGES`) | covered |
| "64 MiB default world budget" | 07, 21, 36 | `cache_events_report_slots` (`memory_bytes()`), `init_rejects_budget_over_arena`, M36 exit 6; device M39-large-save | covered |
| "game `.wasm` ≤ 1 MB brotli (warn), 2 MB (fail)" | 35 | `size @slow`, exit 3 | covered |
| [Consequence](../spec/runtime-and-packaging.md#consequence-of-games-are-written-in-rust): "cannot ship a prebuilt WASM binary … npm package plus Rust crate(s)" | 02, 35 | `build: game.json matches bytes`, M35 exit 1 (`crates/**` in the pack list) | covered |
| "Every game therefore needs a Rust toolchain … make that painless" | 02b, 35 | `plugin-dev: touch triggers rebuild and full-reload`, `plugin: rustc error reaches overlay and recovers @slow`, `tarball-install @slow` | covered |

## `client.md` ([Requirements](../spec/client.md#requirements))

| Requirement | M | Verified by | Status |
|---|---|---|---|
| "Custom WebGPU rendering engine" | 09, 17 | `terrain.probe_tile_colours`, `counters.draws_equal_nonempty_layers` | covered |
| "WebGPU calls are issued from TypeScript on the main thread" | 09, 09b | `terrain.upload_budget_while_panning`, `canvas.presents` | covered |
| "Rust in a worker produces all frame data into shared memory" | 09, 17 | `upload.record_layout_golden`, `drawlist.triple_newest_wins` | covered |
| "no WASM runs on the main thread" | 06b | `main.no_wasm_instantiate` (source scan of `client.ts`'s import closure) | covered |
| "camera is user-driven and engine-owned" | 11 | `camera.pan_keeps_world_point`, `camera.persisted_and_restored` | covered |
| "A game can set constraints" | 11 | `camera.zoom_clamps_and_constraints` | covered |
| "move it programmatically" | 11, 20b | `camera.moveto_cancelled_by_input`, `reference_new_player_spawns_on_land` | covered |
| "attach an optional follow target" | 18 | `follow.centres_in_same_frame_pan_ignored_zoom_works`, `framecx.follow_written_to_header` | covered |
| "No 'WASD moves a sim player' mode in v1" | – | non-goal: nothing to build | n/a |
| "Zoom range: 12 to 256 tiles … configurable per game" | 11, 31 | `camera.zoom_clamps_and_constraints`, `zoomout/baseline-256x144` | covered |
| "about 128 subscribed chunks per client" | 15, 31 | `subs_cap_evicts_farthest_first`, M31 exit 2 (`zoomout/*` numbers) | covered |
| Tier 1: Chrome desktop | 03 onward | the `browser` suite runs on Chromium | covered |
| Tier 1: Chrome Android | 39 | `-android` device rows are "not run: no device"; M39's `client.md` audit table records the waiver (Scope, "Tier 1 rows decided outside the suites") | waived (Q5): desktop Chrome only |
| Tier 1: Safari macOS | 03, 17b, 35, 36 | `determinism @engines` (WebKit), `webkit-readback`; device M17b-harness-desktop-safari, M35-safari-build-mac | covered |
| Tier 1: Safari iOS 26+ | 39 | exit 5 (every device-check entry re-run on the iPhone) | covered |
| "current and previous major version" | 35, 39 | M35 exit 5 (the ADR "Build profiles, measured" holds the browser-version policy: `checkSupport` feature-detects, current engine versions tested); M39's audit lists Q12 | covered by policy, pending Q12 |
| Tier 2: Firefox desktop | 03, 06, 17b | `determinism @engines`, `sab.ring_both_directions`; device M17b-harness-desktop-firefox, M39-desktop-browsers | covered |
| "Anything else gets a capability screen" | 35 | `checkSupport: each code`, `reference: capability screen on failure`; device M35-capability | covered |
| "Design inside the WebGPU compatibility-mode subset" | 09 | `device.requests_compatibility_defaults` (`featureLevel`, no raised limits, no features) | covered |
| "Desktop: WASD moves the camera" | 11 | `camera.wasd_speed_scales_with_extent` | covered |
| "scroll zooms" | 11 | `camera.wheel_about_cursor` | covered |
| "Mobile: pointer drag moves the camera" | 11 | `camera.pan_keeps_world_point`, `input.dom_path_pan_and_tap`; device M11-gestures | covered |
| "pinch zooms" | 11 | `camera.pinch_about_midpoint`; device M11-gestures | covered |
| "manages the viewport, knows which chunks are visible, and requests their generation" | 08b, 09b | `gen: visible before ring 1 before ring 2`, `viewport.resize_renders_same_frame` | covered |
| "Tile art is the game's responsibility" | 09, 20 | `manifest.schema_errors`, `gen_assets_reproducible` | covered |
| Overlay needs: "world↔screen transforms" | 11, 18 | `transform.roundtrip`, `overlay.anchor_tracks_world_point` | covered |
| Overlay needs: "tile/entity picking" | 11, 18 | `input.events_reach_wasm` (tile), `pick.tap_reports_entity_pick_id`, `pick.matches_interpolated_frame_on_screen` | covered |
| Overlay needs: "a low-GC way to observe state" | 16b | `ui_unchanged_value_writes_nothing`, `no_ui_change_no_main_allocation` | covered |

## `testing.md`

| Requirement | M | Verified by | Status |
|---|---|---|---|
| [Requirements](../spec/testing.md#requirements): "automated test suite covering as much as possible" | 01, 39 | M01 exit 3–5 (runner contract), M39 exit 2 (`pnpm acceptance:check`) | covered |
| "Avoid mocking unless it's necessary. Unit test pure functions" | 27, 35 | M27 exit 1 (real server + real `.wasm` behind in-memory `Connection`s), `checkSupport: each code` ("the only stubs") | covered |
| "Research the latest LLM-optimized automated browser testing" | 01, 03 | Phase 1 (ADR 0020); M01 exit 5 (quiet output contract), M03 exit 7 (`run-tests` skill) | covered |
| "deterministically run the game and assert that no garbage collection occurred" | 04 | exit 1, exit 2 (instrument sees engine code), exit 5 (reliability) | covered |
| "under 1 minute for all tests" | 36b, 39 | M36b exit 1–2, M39 exit 1 | covered |
| "split into a fast suite and a slower … one" | 01, 36b | M01 exit 4 (`pnpm test:slow`), M36b exit 1 (demotions) | covered |
| "incremental rebuild after a one-line Rust edit … 30 seconds or less" | 36b | exit 3 (`pnpm measure:rebuild`) | covered |
| "CI is GitHub Actions on Linux with a software WebGPU adapter" | 10 | exit 1–3 | covered |
| "Real-GPU and timing-sensitive runs happen only on Tyler's Mac" | 10, 17b, 36 | M10 exit 4 (timings never gate), M17b exit 2, M36 exit 5 (gate only on the baseline machine) | covered |
| "iOS Safari is covered by a manual checklist on a real phone" | 39 | exit 5 (`device-checks.md`) | covered |
| "zero major GCs and approximately zero allocation on every engine-owned isolate" | 04, 06b | `gc-loop clean` + five negative controls, pages `topology`, `echo` | covered |
| "rendering thread has a small fixed floor" (budget in 0016) | 09, 17 | M09 exit 2, M17 exit 2 (`gc.pages.*.main` by formula) | covered |
| "net worker … ≤ 1 KB per message with zero major GCs … confined to its own heap" | 29 | `gc/multiplayer-topology`, `gc/net-negative-control`; device M29-net-heap | covered |
| [Implications](../spec/testing.md#implications-for-the-engines-design): "never reads wall-clock time" | 03, 13 | M03 exit 4 (`Date.now()` fails lint), M13 exit 2 | covered |
| "Clock, frame stepping, tick stepping, and input are all injectable" | 03, 11 | `manual clock: *`, `stepping.spec.ts`, `input.events_reach_wasm` (via `injectPointer`) | covered |
| "Everything random is seeded" (sim, tests, netcode) | 02, 12, 27 | M02 exit 3 (`getrandom` fails the import allowlist), `simrng_golden_sequence`, `conditioned-link` | covered |
| "Everything random is seeded" (engine TypeScript) | 03 | `lint.no_ambient_random` (source scan: `Math.random`, `getRandomValues`, `randomUUID`; one allowlisted module, M28's `src/client/secret.ts`); M03 exit (adding `Math.random()` fails it) | covered |
| "sim runs headless outside a browser (native `cargo test`, and the WASM module under a JS runtime)" | 02, 12b, 13 | `scenario_matches_golden`, `puts_script_a_golden`, `wasm_idle_100_matches_native` | covered |
| "replay a recorded action log and compare a state hash across native, WASM, and each browser" | 22b, 34b | `replay_world_checkpoints_node`/`_bun`, `reference_golden_replay`, `golden_replay`, reference log on the determinism page | covered |

## `reference-game.md`

| Requirement | M | Verified by | Status |
|---|---|---|---|
| Intro: "exercises every engine feature" | 34b, 34c | M34b exit 2, M34c exit 2 (this table and the engine-feature table of `reference-coverage.md` name tests that exist) | covered |
| Intro: "in single-player and multiplayer" | 34b, 34c | `reference_full_game_single`, `reference_full_game_two_players` | covered |
| [World](../spec/reference-game.md#world): "Simplex noise with multiple octaves" | 20 | `worldgen_golden` | covered |
| "Simple tiles and biomes: grass, dirt, water, sand" | 20 | `reference_terrain_renders`, `landmarks_fixture_current` | covered |
| "pixel-art feel: slight per-tile randomness, some noise, and dithering" | 09b, 20 | `terrain.variants_match_reference`, `terrain.dither_only_inside_band`, `gen_assets_reproducible` | covered |
| "Tile assets are pre-generated by a script" | 20 | `gen_assets_reproducible`, exit 3 | covered |
| "Resource tiles (iron, wood, stone, coal) … randomly but deterministically" | 20 | `worldgen_golden`, `landmarks_fixture_current` | covered |
| "A resource is a separate layer on top of the base tile" | 20 | `collect_last_unit_clears_resource_and_overlay_is_canonical`, `reference_depletion_visible` | covered |
| "No resources on water" | 20 | `worldgen_no_resource_on_water` | covered |
| "Resources deplete: 10 units per tile" | 20, 20b | `collect_last_unit_clears_resource_and_overlay_is_canonical`, M20b exit 2 | covered |
| "Tiles are 16 px with 4 variants per terrain" | 20 | `gen_assets_reproducible` (manifest limits) | covered |
| [Players](../spec/reference-game.md#players): "drawn as circles" | 20b | `extract_hash_player_circle` | covered |
| "follows their camera with a springy effect" | 20b | `spring_settles_and_is_dt_independent` | covered |
| "Player position is presence, not world state" | 19, 20b | `presence_is_not_state`, `admit_rejects_without_sample` | covered |
| "relayed to other clients as ephemeral, unlogged presence" | 34 | `reference_presence_only_to_subscribers`, `reference_two_players_see_each_other` | covered |
| "collect carries the player's claimed position, and the sim range-checks that" | 20, 20b | `collect_out_of_range_rejected`, `admit_rejects_far_witness` | covered |
| "within 3 tiles … (centre … to centre)" | 20, 20b | `collect_out_of_range_rejected` (boundary at `RANGE`), `ui_from_is_within_range_of_its_tile` | covered |
| "a collect button appears (several can show at once)" | 20b | `reference_collect_flow`, `reference_several_buttons`, `ui_in_range_lists_each_resource_once` | covered |
| "Collecting takes 2 seconds" | 20 | `durations_at_20_and_30_hz`, `collect_completes_and_depletes` | covered |
| "the button fills to show progress" | 20b | `reference_collect_flow` (one running fill animation with the collect's duration on the clicked button, gone at completion); device M34-own-timer-bar | covered |
| "One collect and one craft at a time; no queue" | 20, 32 | `collect_busy_rejected`, `craft_rejected_when_busy`, `collect_and_craft_run_together` | covered |
| "Panning out of range cancels a collect" | 20b | `reference_pan_out_cancels` | covered |
| "Inventory and unlocks are per player" | 32 | `unlock_is_per_player` | covered |
| "new player spawns at the land tile nearest the origin" | 20b | `spawn_is_nearest_land_tile`, `reference_new_player_spawns_on_land` | covered |
| "a returning player resumes where they were" | 34, 34b | `reference_returning_player_resumes`, `reference_reload_resumes` | covered |
| "Players may float over water" | 20b | `admit_accepts_within_tolerance` | covered |
| "tiny player roster (coloured dots) … global state is exercised" | 34 | `joined_assigns_distinct_colours`, `reference_roster_follows_join_grace_and_return` | covered |
| [Crafting](../spec/reference-game.md#crafting-and-building): "mined 5 stone, they unlock the furnace recipe" | 32 | `unlock_on_threshold_stone_not_before` | covered |
| "a crafting menu appears" | 32 | `reference_craft_flow`, exit 2 | covered |
| "A furnace costs 5 stone and takes 5 seconds to craft" | 32 | `craft_deducts_cost_then_completes_on_time`, `craft_duration_at_20_and_30_hz` | covered |
| "open a construction UI and place it" | 33 | `reference_place_mouse`, `place_without_item_rejected` | covered |
| "occupies 2x2 tiles" | 33 | `place_ok_consumes_item_and_occupies_four_tiles`, `place_across_chunk_corner_sets_occupancy_in_four_chunks` | covered |
| "can't be placed on water or on other buildings" | 33 | `place_on_water_rejected`, `place_overlapping_furnace_rejected` | covered |
| "With a mouse, the placement ghost follows the cursor and a click places it" | 33 | `reference_place_mouse` | covered |
| "on touch, a tap positions the ghost and a DOM confirm button places it" | 33 | `reference_place_touch`; device M39-full-game-touch | covered |
| "must not be written as 'can't build on water' … placement asks the tiles" | 33 | `can_place_names_no_tile_type` | covered |
| [Furnace](../spec/reference-game.md#furnace): "Clicking a furnace opens a UI for depositing … iron, plus coal or wood" | 33b | `reference_furnace_flow`, `deposit_validates_item_count_and_cap` | covered |
| "smelts one ingot in 5 seconds" | 33b | `smelt_takes_five_seconds_at_20_and_30_hz` | covered |
| "One coal fuels 10 ingots. One wood fuels 2" | 33b | `one_coal_smelts_exactly_ten`, `one_wood_smelts_exactly_two` | covered |
| "Any player can use any furnace" | 33b | `any_player_can_use_any_furnace` | covered |
| "Output ingots can be taken back out (take-all); ore and fuel stay in" | 33b, 34c | `take_all_moves_ingots`, `reference_race_same_ingots`, `reference_full_game_two_players` (no action removes ore or fuel) | covered |
| "An empty furnace … can be picked up by any player" | 33b, 34b, 34c | exit 2: `pickup_empty_despawns_and_returns_item`, `pickup_rejected_unless_empty`, `pickup_by_any_footprint_tile_and_any_player`, `predicted_pickup_tombstone_then_ack`, `pickup_sends_entity_gone_and_closes_other_panel`, `reference_furnace_pick_up`; `reference_full_game_single`, `reference_full_game_two_players` | covered |
| [UI](../spec/reference-game.md#ui): "Framework-free TypeScript. The engine must not care either way" | 20 | `reference_package_depends_only_on_engine` | covered |
| Notes: "Durations above are in seconds" | 20 | `durations_at_20_and_30_hz` | covered |
