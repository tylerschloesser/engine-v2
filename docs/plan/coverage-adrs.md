# Coverage: ADR decisions, budgets, engine events and context artifacts

Every decision of ADRs 0001 to 0024 (judged against the amendments of 0022, 0023 and 0024), every budget row of `PRE-PLAN.md` §7, every engine event of the `PRE-PLAN.md` §4 TS sketch and every ADR 0021 context artifact, mapped to the milestone exit criterion or named test that verifies it. Status: **covered** (an exit criterion, or a named test that an exit criterion requires to pass), **unverified** (in a brief's Scope, Seams, Budgets or Context artifacts only), **uncovered** (in no brief), **n/a** (a constraint with nothing to build or test), and one row ruled **unverified by decision (Q6), carried to 39b**; the open rows are collected under Gaps at the end with an owner and a proposed criterion.

## ADR 0001: Camera and presence

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| Camera report: 16-byte latest-wins message, on change, at most 10 Hz | M14, M15, M31 | `golden_uplink_batch`; `uplink_at_most_one_batch_per_interval`; `rates/uplink-panning`, `rates/camera-flood-dropped` | covered |
| Camera report: never logged, not visible to `apply`/`tick`, absent from snapshots and hashes | M13, M19, M22 | `warm_is_invisible_to_hash`; `presence_is_not_state` (equal hashes and scripts with and without uplink traffic); `snapshot_excludes_dense_cache` | covered |
| Camera report: host derives chunk set and look-ahead from rect and velocity | M15, M15b | `subs_ring1_plus_lookahead`; `pan_changes_subscription` | covered |
| Presence trait: `Codec + Copy + Default`, 32-byte limit per sample, `()` allowed (amended by 0024 §6) | M19 | `oversize_dropped` (counter `presence_oversize`); `presence_section_golden` | covered |
| Presence producer: client-side Rust writes it once per frame from the camera block | M19, M20b | `presence-worker-path`; `spring_settles_and_is_dt_independent` | covered |
| Presence uplink: at most 10 Hz while changing, one at-rest sample, same batch as camera | M19 | `sampler_rate_and_on_change`; criterion "`uplinkPresenceBytes` ... within the budgets-file ceiling" | covered |
| Presence host: latest sample per player, world-cap check, relay to subscribers of `pos()` chunk, never queued | M19, M34 | `relay_recipients`, `outside_world_cap_dropped`; `reference_presence_only_to_subscribers` | covered |
| Presence host: disconnect tells clients at once | M19, M28b, M30 | `rerelay_and_gone`; `reconnect/presence-vanishes-at-once`; `disconnect_removes_at_once` | covered |
| Remote rendering through the interpolation buffer; host re-relays held sample at least once per second | M19, M30 | `rerelay_and_gone`; `rerelay_refreshes_without_new_sample`, `resting_player_stays_solid` | covered |
| Last sample kept in host session table (outside snapshot and hash); returning camera starts there; client remembers its own camera | M28, M34, M11 | `reference_returning_player_resumes`; `camera.persisted_and_restored`. M28 names no test for `lastPresence` in `Welcome` itself | covered |
| Presence readable only by `admit`; type system enforces it | M19 | criterion "`PresenceTable` appears in the signature of `admit` only; a compile-fail doc test" | covered |
| Witness step 1: `G::admit` compares `from` with latest sample; reject if far or no sample | M19, M20b | `admit_witness`; `admit_rejects_far_witness`, `admit_rejects_without_sample`, `admit_accepts_within_tolerance` | covered |
| Witness step 2: `apply` checks range in fixed-point from the action's own bytes | M20 | `collect_out_of_range_rejected` (boundary at exactly `RANGE`) | covered |
| Witness step 3: panning out of range is a client-sent `CancelCollect`, an ordinary logged action | M20, M20b | `cancel_collect_clears_timer`; `reference_pan_out_cancels` | covered |
| Soundness: log only admitted actions; `apply` re-validates on replay, one code path | M16, M19, M22 | `admit_reject_is_not_recorded`, `apply_reject_is_recorded_and_replays`; `apply_range_is_replayable`; `replay_includes_rejected_actions` | covered |
| Consequences: `admit` needs its own unit tests | M19, M20b | `admit_witness`; the three `admit_*` tests of M20b | covered |
| Consequences: replays show the world without avatars | M19 | `apply_range_is_replayable` (empty `PresenceTable`) | covered |
| Consequences: sim rules cannot depend on player position; modified client can lie within tolerance | | trust-model constraint, nothing to build | n/a |
| Deferred: typed fast input path and quantized deltas for continuous streams | M14 | deferred-ledger row: decided not built; uplink flag bits kept free | n/a |
| Deferred: presence as an optional replay track | M19 | deferred-ledger row: decided not built | n/a |

## ADR 0002: Determinism by the same .wasm everywhere

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| §1 One artifact: browser and server run the same `.wasm`; no native server; `.wasm` runs are the authoritative determinism tests | M02, M12b, M27 | criterion "golden ... identical natively, under Node and under Bun"; M12b criterion "the `.wasm` value is authoritative"; criterion "`pnpm test wasm` runs its logs through `createWorldServer` under Node and Bun" | covered |
| §1 Sim identity is the content hash of the file | M02, M24b | `build: game.json matches bytes`; `identity_compare_matrix` | covered |
| §2 Allowed float ops are bit-identical everywhere | M02, M03, M10 | `determinism: node matches golden`, Bun leg, `determinism.spec.ts @engines`; M10 criterion "`x86_64` ... determinism tests passing against unchanged goldens" | covered |
| §2 No std transcendentals; hand polynomials or pinned `libm` | M02, M20 | M02 exit (a temporary `f32::sin` in `fx-hash` fails `pnpm lint` naming `clippy::disallowed_methods`; fixtures carry `[lints] workspace = true`); M20 criterion covers `reference-sim` | covered |
| §2 `libm` pinned with `=` when used (also Consequences) | M02 | `crate-policy` (`unit`): any `libm` requirement in a workspace manifest starts with `=` | covered |
| §2 `mul_add` allowed but avoided in hot paths | | guidance only | n/a |
| §2 NaN bits never observable (guards; no `to_bits`, `total_cmp` ... on possibly-NaN) | M05, M02 | `canon_bits_table`, `codec_nan_debug_asserts`, `codec_nan_release_canonical`; the NaN-observing method ban shares the unverified lint row above | covered |
| §2 Persistent quantities are integers or fixed-point; no `usize`/`isize` in hashed or serialized state; explicit wrapping ops | M05 | `no_usize_in_serialized_types` (source scan); M05 exit "`determinism.md` names ... the no-`usize`-in-state rule" | covered |
| §2 No `HashMap`/`HashSet` in sim state | M07, M12, M20 | criteria "No `HashMap`/`HashSet` ... under `src/world/`"; "`grep -r "HashMap" crates/engine/src/store*` is empty"; M20 criterion for `sim/` | covered |
| §2 `SimRng`: owned PCG32, state in the snapshot, reachable only through the write context; predicted `apply` declines | M12, M12b, M25, M34 | `simrng_golden_sequence`; `puts_script_a_golden` (includes `Roll`); `rng_declines`; `colour_assignment_replays_identically` (RNG state in the snapshot) | covered |
| §2 Worldgen uses stateless coordinate hashes only | M08 | `hash2_vectors`, `worldgen_contract_fixture` (order and repetition do not change output) | covered |
| §2 No wall clock, no I/O, no ambient input | M02, M03, M13 | `import allowlist`; criterion "Adding `Date.now()` to `src/loader.ts` makes `pnpm lint` fail"; M13 criterion on ambient timers | covered |
| §2 Default target features only; stable Rust; `panic=abort` (0024 §13: wasm32 aborts by target default) | M02 | `target features`; `loader: panic marks instance dead with message` | covered |
| §3 Import allowlist test plus target-feature assertion | M02 | `import allowlist`, `target features`; criterion "adding `getrandom` ... makes `import allowlist` fail naming the module" | covered |
| §3 Lint bans: `disallowed_methods`, `disallowed_types` for engine sim crates and game crates; `#[allow]` needs a comment | M01, M02, M07, M20 | M02 exit (a temporary `HashMap` field and `std::time::Instant` in `fx-hash` fail `pnpm lint` naming `clippy::disallowed_types`; `clippy.toml` lists match 0002 §3); M07 ("no `#[allow(clippy::disallowed_types)]`") and M20 criteria | covered |
| §3 NaN canonicalization in `Codec`; snapshots and hash only from `Codec` bytes | M05 | `canon_bits_table`, `codec_nested_nan_canonical`, `hash_value_equals_hash_of_encoded_bytes` | covered |
| §3 Heavy mode (save, load into fresh instance, compare; N=1 in slow suite) | M22, M22b, M36 | `heavy_mode_fixture_n25`, `heavy_mode_fixture_n1`; `heavy_wasm_n50`, `heavy_wasm_n1`; criterion "`heavy-n1 all logs` ... pass" | covered |
| §3 Replay equality | M12b, M21b, M22, M20 | `replay_equals_live`, `truncated_log_differs`; `replay_equals_live_with_timers`; `replay_from_genesis_checkpoints`; `replay_equals_live_hash` | covered |
| §3 Cross-engine golden hashes: Node, Bun, three browsers, native; raw bits hashed | M02, M03, M08, M34b | criterion "golden has ≥ 10 checkpoints and is identical natively, under Node and under Bun"; criterion "golden reproduced in three engines"; reference log added to the determinism page | covered |
| §3 State hash is 64-bit FNV-1a over canonical snapshot bytes | M02, M05 | `Fnv64` vectors; `fnv64_is_a_byte_sink`, `fnv1a64Hex vectors`; criterion "FNV prime in `hash.rs` only" | covered |
| Consequences: `Cargo.lock` committed | M01 | criterion "`pnpm-lock.yaml` and `Cargo.lock` are committed" | covered |
| Consequences: any build change gives a new hash and a new log segment | M24b | `rules_only_change_direct_load_new_segment` | covered |
| Deferred: run on real x86-64 | M10 | criterion "log shows `x86_64` ... deferred-ledger marks 'determinism on real x86-64' ... closed" | covered |
| Deferred: run on a physical iPhone and Android phone | M03, M39 | criterion "`pnpm device:serve` serves `determinism.html`"; device-checks entry (D); M39 criterion "every entry re-run ... and ticked" | covered |
| Deferred: whether `+simd128` and `wasm-opt` may be enabled | M36b | `feature-matrix @slow`; criterion "allow / keep-off decision ... recorded by ADR" | covered |

## ADR 0003: Game-facing API

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| `Game` trait: associated types and consts declared (`Action`, `Reject`, `Entity`, `Player`, `Global`, `Presence`, `Ui`, `Client`, `Worldgen`) | M12, M08, M19, M16b | `puts_fixture_builds_wasm32`, `store_roundtrip_bytes_equal`; fixture games implement the trait in every later test | covered |
| `SCHEMA_VERSION` (also covers `G::Action` layout, amended by 0024 §3a) | M24b | `schema_bump_runs_migrate`, `identity_compare_matrix` | covered |
| `TICK_RATE` const, default 20 Hz | M12b, M20 | `ticks_conversion_20_and_30_hz`; `durations_at_20_and_30_hz` | covered |
| `CHUNK_BITS` 4, 5 or 6; runtime `ChunkDims`; browser topology asserts 5 with a readable fatal (amended by 0024 §9) | M07, M08b, M09 | criterion "pass by name at `CHUNK_BITS` 4, 5 and 6"; `dims_reject_unsupported_bits`; `gen: oversize slab is a readable fatal`. M09's init failure on another size is a planning decision without a named test | covered |
| `register` + `prototype` + `anchor` hook (amended by 0024 §7a): engine derives occupancy and delta scope | M12, M12b, M21 | `every_put_is_one_delta_with_scope`; `footprint_sets_every_overlapped_chunk`, `footprint_larger_than_chunk_panics_at_register` | covered |
| `genesis` runs once at tick 0 | M12b, M13 | `puts_idle_100_golden`; `wasm_idle_100_matches_native` (`sim_genesis`) | covered |
| `on_player` with `Joined`/`Connected`/`Disconnected`, logged | M12b, M28, M28b | `joined_must_put_player`; `handshake/join-then-return-same-player`; `reconnect/after-grace-logs-disconnected` | covered |
| `apply` returns `Result<(), Reject>`; same code on host, replay, prediction | M12b, M16, M25 | `rejecting_apply_wrote_nothing`; `apply_reject_is_recorded_and_replays`; `placement_is_immediate_and_converges` | covered |
| `predict` per-action opt-out | M25 | `opt_out_declines` | covered |
| `tick(cx: &mut TickCx)` host only; `TickCx` is a `WorldWrite` | M12b, M21b | `puts_idle_100_golden`; `timer_fires_at_exact_tick_in_key_order`, `smelt_cycle_golden` | covered |
| `admit` host only, never replayed | M16, M19 | `admit_reject_is_not_recorded`; `admit_witness` | covered |
| `migrate` hook, default `SaveIncompatible` | M24b | `migrate_default_is_save_incompatible`, `migrate_v1_to_v2_preserves_ids_and_occupancy` | covered |
| `growth(&Action)` hook (amended by 0023) | M21 | `growth_declarations_are_honest`, `undeclared_action_uses_max_action_growth` | covered |
| `WorldRead`: total on host, `Unknown` outside a client's subscription | M12b, M15, M21 | `host_reads_are_total`, `missing_player_is_unknown`; `view_unknown_outside_subscription`; `entity_at_any_covered_tile`, `replica_traits_at_matches_host` | covered |
| `WorldRead::tick` frozen per pending action under prediction | M25 | `frozen_predicted_tick` | covered |
| `WorldWrite`: every method is one whole-value put = one `Delta` | M12b | `every_put_is_one_delta_with_scope` | covered |
| `WorldWrite::rng`: host only, `Unknown` under prediction | M25 | `rng_declines` | covered |
| `ClientSide::frame` (camera block, input events, `cx.follow`) | M18, M20b | `framecx.tap_visible_in_frame`, `framecx.follow_written_to_header`, `follow.centres_in_same_frame_pan_ignored_zoom_works` | covered |
| `ClientSide::extract` into `DrawList` | M17 | `drawlist.fixture_hash_golden`, `frameview.entities_sorted_and_clipped` | covered |
| `ClientSide::tile_visual` per tile on load or patch, never per frame | M09 | `texel.default_identity`, `texel.override_shows_aux`, `terrain.patch_one_texel` | covered |
| `ClientSide::ui` into a reused `G::Ui` | M16b | `ui_called_only_after_replica_change`, `ui_unchanged_value_writes_nothing` | covered |
| `export_game!` emits the exports for every role | M02, M08, M22 | `abi registry`; `gen: sim role returns WrongRole`; M22 criterion "ABI registry test includes the four new exports" | covered |
| Contexts: `Authority` (apply + record + scope) | M12b | `every_put_is_one_delta_with_scope`, `authority_put_existing_key_no_alloc` | covered |
| Contexts: `Predicting` (overlay then replica; writes to overlay) | M25 | `placement_is_immediate_and_converges`, `entities_in_merges_overlay` | covered |
| Contexts: read-only `View` for renderer, `ui` and shared rule helpers | M15, M33 | `view_unknown_outside_subscription`; `can_place_names_no_tile_type` | covered |
| Contexts: `TickCx` = `Authority` plus active-entity iteration | M21b | `active_iteration_stable_under_deactivate`, `idle_world_visits_zero_entities` | covered |
| Contexts: `dyn` with trait-object upcasting | | compiles or not; nothing to test | n/a |
| Deltas are engine-defined; puts cover every scope; `Store`'s only mutator is apply-a-delta; no game `save`/`load` | M12, M12b, M22 | `store_apply_is_idempotent`, `store_roundtrip_bytes_equal`; `every_put_is_one_delta_with_scope`; `heavy_mode_fixture_n25` | covered |
| Engine roster via `Delta::Roster` in `Global` scope (amended by 0024 §8) | M12, M14, M34 | `golden_global_and_own_player`; `reference_roster_follows_join_grace_and_return`, `global_written_only_on_join` | covered |
| Author rules: validate first, copy-modify-put, `?` on reads, `From<Unknown>` | M12b, M25, M16 | `rejecting_apply_wrote_nothing` (and `#[should_panic]` twin); `.claude/rules/prediction.md`; `add-action-type` skill criterion | covered |
| Outside the deterministic core: subscriptions, camera, presence, session table, pacing, storage, `admit`, `ClientSide` unhashed and unreachable | M07, M13, M19, M28b | `cache_invisible_matrix`; `warm_is_invisible_to_hash`; `presence_is_not_state`; `reconnect/within-grace-logs-nothing`. M15's module-visibility test is "if cheap" only | covered |
| `Codec` = serde + postcard with canonical floats; all game-typed bytes on wire, log, snapshot | M05, M14, M22 | `varint_matches_postcard`, `codec_roundtrip_plain_data`; `golden_uplink_batch`; `persist_frame_golden_bytes` | covered |
| `seq`, `Tick`, `EntityId` are `u32`; `PlayerId` small integer at first join | M12, M16, M28 | `entity_id_policy_*`; `dispatch_returns_monotonic_seq_from_seed`; `handshake/join-then-return-same-player` | covered |
| TS-facing types avoid `u64` | M02, M16 | M16 exit "`grep -rn bigint packages/engine/fixtures/*/bindings` prints nothing" | covered |
| TypeScript types by `ts-rs` on `Params`, `Action`, `Reject`, `Ui`; bindings written by build tooling | M16, M16b, M20, M35 | criteria "`bindings/*.ts` ... committed and regenerate byte-identically"; "`bindings/PutsUi.ts` ... type-checks"; M20 `git diff --exit-code ... bindings`; `ts-rs zero bytes @slow` | covered |
| `client.dispatch` returns `seq` synchronously; JSON into a SAB ring; main assigns `seq` from a counter seeded by `Welcome` | M16, M28 | `dispatch_returns_monotonic_seq_from_seed`, `dispatch_before_ready_throws`, `vertical_slice` | covered |
| Client WASM parses JSON to `G::Action`, emits postcard; host never sees JSON | M16 | `wasm_script_a_matches_native`, `malformed_action_is_protocol_error`, `vertical_slice` | covered |
| `serde_json` 1.x with `default-features = false`, `alloc` only | M02, M16 | `crate-policy`: declared `default-features = false` with `alloc` only, and `cargo tree -p engine --target wasm32-unknown-unknown -e normal,features` shows no `std` | covered |
| UI observation: `ui` on replica, overlay or `ui_dirty` change (amended by 0024 §7d); `PartialEq` gate; JSON to ring; `onUi` only on change | M16b, M18 | `ui_reruns_when_dirty_flag_set`, `onui_gets_only_latest_per_drain`, `no_ui_change_no_main_allocation`; `framecx.ui_dirty_reruns_ui` | covered |
| Per-frame values never via `Ui`: anchors from an engine-filled array; progress from `done_at` and `client.clock()` | M16b, M18 | `progress_from_done_at_and_clock`, `clock_returns_same_object`; `overlay.slot_anchor_follows_rust` | covered |
| `onActionResult(seq, Confirmed or Rejected)`; `NotPredictable` reported at dispatch | M16, M25 | `ui_ring_delivers_results_in_order`, `vertical_slice`; `predict_not_predictable_event` | covered |
| 0024 §7b: puts through `Authority` outside `G::tick` wake the entity in the same tick; queue is sim state | M21b | `put_from_apply_wakes_same_tick`, `put_from_tick_does_not_self_wake`, `wake_dedup_and_order`, `timers_survive_encode_decode` | covered |
| 0024 §7c: `client.input.emit` writes a kind-7 game record surfaced in `FrameCx::input()` | M18 | `framecx.emit_visible_in_frame`, `input.game_record_round_trip`, `input.game_record_survives_overflow` | covered |
| Consequences: reference-game feature coverage list | M34b, M34c | criteria "Every single-player row ... filled with a test that exists"; "Every multiplayer row ... names a test that exists" (the `reference-game.md` table of `coverage.md` and the engine-feature table of `reference-coverage.md`) | covered |
| Consequences, scripted: furnace spanning a chunk border | M33, M34c | `place_across_chunk_corner_sets_occupancy_in_four_chunks`; `reference_furnace_across_chunk_border` | covered |
| Consequences, scripted: rejection races (last unit, same spot, same ingots) | M34c | `reference_race_last_unit`, `reference_race_same_spot`, `reference_race_same_ingots` | covered |
| Consequences, scripted: action at the subscription edge | M33, M34c | `predicted_place_at_subscription_edge_is_not_predictable`; `reference_subscription_edge_not_predictable` | covered |
| Consequences, scripted: state budget when full | M21, M34b | `full_world_rejects_place_accepts_remove_then_place`; `reference_state_budget_full`, `reference_state_budget_full_shows_reason` | covered |
| Consequences, scripted: panic recovery, `SaveIncompatible`, export/import | M34b | `reference_panic_in_apply_skips_and_recovers`, `reference_save_incompatible_leaves_files`, `reference_export_import_roundtrip` | covered |
| Consequences: keyboard focus covered by an engine test page | M11 | `input.keyboard_focus_rules` | covered |
| Deferred (1): provisional ids for predicted entities | M25 | ADR 0022; `provisional_id_stable_across_replays`, `provisional_id_rejected_by_deserialize` | covered |
| Deferred (2): taint after a `NotPredictable` pending action | M25 | `taint_dependency`, `taint_rollback_visibility`, `taint_independence`; criterion "chosen taint rule ... under Deviations" | covered |
| Deferred (3): per-frame overlay change list and "predicted" flag for the renderer | M26 | `swap_is_one_render`, `texel_upload_only_on_change`, `drawlist_hash_stable_across_replays` | covered |
| Deferred (4): host-side atomicity of `apply`, undo journal | M21b | `journal_rolls_back_store_indexes_wakes_counts`; criterion "The journal ADR exists" | covered |
| Deferred (5): own-timer completion gap | M26 | `own_timer_no_jump_at_ack`, `completion_gap_measured` | covered |
| Deferred (6): range reads through an object-safe trait | M21, M25 | `entities_in_visits_each_once_in_id_order`; `entities_in_merges_overlay` | covered |
| Deferred (7): exact `TickCx`, `FrameCx`, `FrameView`, `OldStore` shapes | M21b, M18, M17, M24b | tests of those briefs; M24b criterion "`OldStore`, `OldValue` ... public ... with rustdoc examples that compile" | covered |
| Deferred (8): `entity(id)` gone vs unsubscribed on a client | M25 | `entity_id_gone_vs_unsubscribed` | covered |

## ADR 0004: Action timing and rejection

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| Action received during T lands on T+1; clients never choose ticks (seal rule amended by 0024 §1) | M16, M13 | `action_lands_on_next_tick`, `host_applies_only_sealed_records`; `simhost_seal_precedes_tick` | covered |
| Host arrival order within a tick, before tick rules; log order is canonical | M16, M12b | `arrival_order_within_tick`; `puts_script_a_golden` | covered |
| Connection events sequenced in the same stream, delivered through `on_player` | M12b, M28, M28b | `joined_must_put_player`; `handshake/crash-between-table-and-log`; `reconnect/after-grace-logs-disconnected` | covered |
| Host stamps `who` from the connection | M14, M32 | `golden_uplink_batch` (no player field on the uplink); `unlock_is_per_player` | covered |
| Per-player `seq`, monotonic across reconnects and reloads; last processed `seq` is sim state rebuilt by replay; `ack_seq` in each frame header | M16, M14, M22, M22b, M28b | `dispatch_returns_monotonic_seq_from_seed`, `resent_seq_is_dropped`; `golden_frame_header`; `replay_rebuilds_last_seq`; `resend_after_recovery_not_applied_twice`; `reconnect/host-restart-epoch` (`seq` continues) | covered |
| Pipeline 1: malformed action is a protocol error, connection closed | M16 | `malformed_action_is_protocol_error` | covered |
| Pipeline 2: rate limit 20/s burst 40 per connection, then `G::admit`; rejection not logged | M31, M16 | `rates/action-rate-limited` (unlogged); `admit_reject_is_not_recorded` | covered |
| Pipeline 3: frame written to the log before it is applied; storage failure fatal | M22, M37 | `write_ahead_order`, `storage_onError_is_fatal`; `fatal: storage error` | covered |
| Pipeline 4: `apply` validates then writes; rejected action stays in the log and replays identically; rejecting `apply` wrote nothing | M16, M12b, M22 | `apply_reject_is_recorded_and_replays`; `rejecting_apply_wrote_nothing`; `replay_includes_rejected_actions` | covered |
| State-budget check before `apply`, `StateBudgetFull`, deterministic in live, replay, recovery (amended by 0023: growth declaration) | M21 | `full_world_rejects_place_accepts_remove_then_place`, `budget_verdict_replays_identically`, `under_declared_growth_panics_in_debug` | covered |
| State-budget check never covers `on_player`, `genesis` or tick-rule writes (soft budget) | M21, M21b | `full_world_still_accepts_join` (M21), `tick_rule_put_past_limit_is_applied` (M21b) | covered |
| Predicting client does not run the budget check; the ack decides | M25, M34b | M25 Non-scope states it; `reference_state_budget_full_shows_reason` (item stays, reason shown after the ack) | covered |
| Acks ride on deltas: results in the T+1 frame, in `seq` order, applied atomically; a frame is sent whenever there is an ack | M16, M15 | `ack_and_deltas_share_a_frame`, `ui_ring_delivers_results_in_order`, `vertical_slice` (rejected `Paint` yields a result with no deltas); `frame_is_atomic_on_malformed_tail` | covered |
| `Ack`, `Rejected::{Game, Engine}`, `EngineReject::{RateLimited, StateBudgetFull, EngineFault}` | M14, M31, M21, M24 | `golden_action_results_all_tags`; `rates/action-rate-limited`; `full_world_*`; `skipped_action_acked_engine_fault` | covered |
| `Applied.spawned` provisional | | superseded by 0022 (stable-key addressing, `Applied` carries nothing) | n/a |
| Third result `Lost`, client-side only (amended by 0024 §8) | M28b | `reconnect/lost-ack-reports-lost` | covered |
| Flow to prediction: pop by `ack_seq`, clear overlay, re-run pending; ghost swap in one render | M25, M26 | `dependent_actions_replay_across_ack`, `rival_takes_the_spot_never_torn`; `swap_is_one_render`, `reject_is_one_render` | covered |
| Local prediction failure is a hint: the client always sends | M25 | `edge_action_declines_but_resolves`, `predict_not_predictable_event` (`NotPredictable` then `Confirmed`) | covered |
| After reconnect the client resends pending actions above the host's last processed `seq` | M28b, M34c | `reconnect/pending-resent-once`; `reference_pending_place_applied_once_after_reconnect` | covered |
| Log growth: about 12 to 18 bytes per action, about 9 per connection event; no compaction needed | M22 | `bytes_per_logged_action`; criterion "`budgets.json` has `logBytesPerAction`"; `persist_frame_golden_bytes` | covered |
| Consequences: latency to authority at most one tick | M16 | `action_lands_on_next_tick` (Budgets: Latency row) | covered |
| Consequences: host asserts a rejecting `apply` recorded no writes | M12b | `rejecting_apply_wrote_nothing` with its `#[should_panic]` twin | covered |
| Consequences: rate limit is an engine default, overridable per game | M31 | `rates/action-rate-limited` (run at the default and with `WorldConfig.actionRate` overridden) | covered |
| Consequences: shrinking actions at a full budget (per-action growth declaration) | M21 | ADR 0023; `full_world_rejects_place_accepts_remove_then_place` | covered |
| Deferred: typed fast path for continuous action streams | M14 | deferred-ledger row: decided not built | n/a |

## ADR 0005: Persistence and recovery

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| Formats: postcard through `Codec` inside hand-written containers; overlays as raw little-endian arrays | M22, M07 | `persist_frame_golden_bytes`, `persist_snapshot_golden_bytes`; `golden_terrain_canonical`, `tile_le_byte_order` | covered |
| Sim identity: 128 bits of the build hash plus versions, `tick_rate_hz`, worldgen stamp | M02, M08, M22, M24b | `build: game.json matches bytes`; `fingerprint_golden`; `identity_compare_matrix`, `worldgen_stamp_mismatch_requires_migrate` | covered |
| Snapshot container layout, taken at a tick boundary, ends with `state_hash`, `crc32` (streamed per 0024 §1) | M22 | `persist_snapshot_golden_bytes`, `snapshot_roundtrip_random_blocks`, `replay_from_snapshot_matches_genesis_replay` | covered |
| Snapshot written aside then replaced; previous kept until the new one verifies | M22b | `crash_torn_snapshot_uses_previous`, `crash_snapshot_without_log_tail_is_skipped` | covered |
| Log: segments with identity header and base snapshot; one frame per tick with actions; record kinds action, connection event, `Skip` | M22, M24 | `persist_frame_golden_bytes`, `skip_kind_decodes_as_noop`, `replay_rebuilds_last_seq`; `skip_record_golden_bytes` | covered |
| Segments roll at `SEGMENT_ROLL_BYTES` when a snapshot is written (amended by 0024 §2) | M22b | `segment_rolls_at_snapshot_over_limit`, `crash_before_manifest_rewrite_on_roll` | covered |
| No compaction; snapshots pruned to segment bases plus latest two | M22b | `prune_keeps_bases_and_latest_two` | covered |
| Sealed segments may be gzip-compressed | M22 | optional in the ADR; M22 Non-scope records "not built" | n/a |
| Cadence: snapshot every 1,200 ticks if dirty | M22 | `snapshot_every_1200_ticks_if_dirty`, `no_snapshot_when_clean` | covered |
| Cadence: snapshot at clean boundaries: zero-player pause, hidden tab, `pagehide` | M22b, M23, M28b | `pause_flushes_and_snapshots_if_dirty`; `hidden_pauses_and_snapshots`; `lifecycle/idle-stops-ticks-then-onidle` | covered |
| Cadence: snapshot on server shutdown signal | M38 | `reference-server/sigterm-snapshots` (M38 part C wires `SIGTERM`/`SIGINT` to `stop()`; fast-tier criterion) | covered |
| Cadence: write-ahead append; `sync` at most once per second when dirty | M22, M23 | `write_ahead_order`, `sync_at_most_once_per_second`; M23 Budgets: `persistenceCounters()` in-browser | covered |
| Loss windows (tab close, crash, panic: 0 admitted actions lost; OS crash up to 1 s) | M22b, M24 | criterion "crash matrix covers every byte cut of the final frame"; `panic_in_apply_writes_skip_then_resumes` | covered |
| Loss window, object-store adapter (2 s parts) | M38 | deployer-written; exercised only if the Durable Object check is a go | n/a |
| Resume at max(snapshot tick, last logged frame tick) | M22b | `load_resumes_at_max_of_snapshot_and_log_tick` | covered |
| Recovery: newest CRC-valid snapshot, replay to first torn frame, truncate by `write(validPrefix)` (amended by 0024 §2) | M22b, M22 | `crash_mid_frame_truncates_and_resumes`, `recovered_hash_equals_uninterrupted_replay`, `fs_crash_truncated_file`; `storage_conformance_memory` (append after write) | covered |
| Recovery bumps the session epoch; clients take a full resync | M28b | `reconnect/host-restart-epoch`, `reconnect/panic-recovery-resync` | covered |
| Upgrades: identity differs, direct load when schema and rate match; new segment; old sealed | M24b | `rules_only_change_direct_load_new_segment`, `upgrade_crash_before_manifest_is_restartable` | covered |
| Upgrades: otherwise through `G::migrate`; `SaveIncompatible` leaves every file untouched | M24b | `schema_bump_runs_migrate`, `no_migrate_hook_save_incompatible_files_untouched`, `save_incompatible_rejects_ready_and_export_still_works` | covered |
| Upgrades: tail re-executed only when `SCHEMA_VERSION` equal; else dropped and counted; undecodable record dropped (amended by 0024 §3) | M24b | `schema_bump_runs_migrate` (`tailReexecuted: false`, dropped count), `undecodable_tail_action_is_dropped_and_counted` | covered |
| `Storage` interface shape; calls on one key take effect in order; `bytes` valid only during the call | M22, M22b, M23 | `storage_conformance_memory`, `storage_conformance_fs`, `storage_conformance_opfs` | covered |
| Tick path never awaits storage; failure only through `onError`, fatal to the world | M22 | `tick_path_never_awaits`, `storage_onError_is_fatal` | covered |
| No shipped adapter allocates a promise on the tick path in steady state | M22b, M23 | `fs_append_allocates_no_buffers`; `zero_gc_singleplayer_with_snapshot`, `neg_control_snapshot_allocates` | covered |
| Host awaits `flush()` at clean boundaries only | M22b, M35b | `pause_flushes_and_snapshots_if_dirty`; adapter tests "assert a clean `stop()` (flush awaited ...)" | covered |
| Adapter: browser OPFS with sync access handle, scratch-file snapshot; `move()` probe or slot files (amended by 0024 §4) | M23 | `storage_conformance_opfs` (three browsers), `world_survives_reload`; criterion "Decision 3 outcome recorded" | covered |
| Adapter: Node/Bun/Deno `fs` with preallocated buffer, temp file + rename | M22b, M35b | `storage_conformance_fs`, `fs_append_allocates_no_buffers`; `bun-adapter loopback`, `deno-adapter @slow` (write failure reaches `onError`) | covered |
| Adapter: memory (`durable: false`) | M22 | `storage_conformance_memory` | covered |
| Adapter: object store / Durable Object with numbered parts (deployer-written) | M38 | `do/local-smoke` only if go; criterion "The DO ADR exists ... (or the skip is recorded)" | covered |
| Browser: Web Lock held for the worker's lifetime; `WorldBusy` | M23, M34b | `second_tab_gets_world_busy`; `reference_world_busy_second_tab` | covered |
| Browser: `navigator.storage.persist()` once after a gesture; expose `{ persisted, usage, quota }` | M23 | `storage_status_reports_estimate` | covered |
| Browser: no OPFS gives the memory adapter and `durable: false` | M23 | `no_opfs_falls_back_durable_false` | covered |
| Server: engine ships a Node `fs` adapter with zero npm dependencies, plus memory | M22b, M35b | `storage_conformance_fs`; criterion "`packages/engine` still has zero `dependencies`" | covered |
| Export/import: one gzip archive of manifest, segments, pruned snapshots, session table; import takes the normal load path including upgrade | M23, M24b | `archive_golden_bytes`, `export_import_roundtrip_browser`, `export_import_roundtrip_node`, `import_refuses_existing_world`, `export_works_after_load_failure`; `import_then_upgrade` | covered |
| Single-player to hosted: same containers and keys; same secret reclaims the player | M23, M34b | `export_browser_import_node_same_hash`; `reference_single_player_save_to_server` | covered |
| Panic recovery 1: every export call wrapped; dead instance never called again; `Module` kept; message via `engine.panic` | M02, M24 | `loader: panic marks instance dead with message`; `host_never_calls_raw_exports`, `fresh_instance_reuses_module`, `dead_instance_memory_still_readable` | covered |
| Panic recovery 2: fresh instance, snapshot, replay tail, epoch bump; sockets stay open; second `Welcome` is the resync signal (amended by 0024 §8) | M24, M28b | `connections_stay_open_across_recovery`, `recovery_fires_onRecovered_once`, `sim_worker_recovers_from_panic`; `reconnect/panic-recovery-resync` | covered |
| Panic recovery 2: main thread respawns a dead sim worker | M37 | `sim worker death respawns and resyncs` | covered |
| Panic recovery 3: recurring panic in `apply` appends `Skip`, sender acked `EngineFault`, replay stays exact | M24 | `panic_in_apply_writes_skip_then_resumes`, `skipped_action_acked_engine_fault`, `recovered_hash_equals_replay_with_skip`, `recovery_loop_guard` | covered |
| Panic recovery 4: recurring panic in `tick` is fatal: stop, keep files, `onFatal` | M24, M37 | `panic_in_tick_is_fatal_and_files_untouched`; `fatal: server onFatal stops world and closes sockets` | covered |
| Panic recovery 4: a failed `memory.grow` takes the same route | M24, M37 | `alloc_failure_in_tick_is_fatal_and_files_untouched` (M24, fixture action `ArmTickAlloc`) | covered |
| Idle pause: host snapshots and stops calling `tick`; nothing logged; resume on `Hello` | M28b, M23 | `lifecycle/idle-stops-ticks-then-onidle`, `lifecycle/hello-resumes`, `lifecycle/keep-ticking-when-empty`; `hidden_pauses_and_snapshots` | covered |
| At most 5 catch-up ticks per wakeup; sim time falls behind | M13 | `simhost_caps_catchup_and_drops_time` | covered |
| Consequences: sim worker is a dedicated worker and owns single-player storage | M23 | `storage_conformance_opfs`, `zero_gc_singleplayer_with_snapshot` (sync handles exist only there) | covered |
| Consequences: engine-to-UI events (`SaveIncompatible`, `WorldBusy`, `durable: false`, estimate, `Resyncing`, `onFatal`) | M37 | `engine event surface`; `reference: status walks every event` | covered |
| Consequences: recovery, skip records, torn-frame truncation and upgrade path each have a scripted test | M22b, M24, M24b | crash matrix; `replay_honours_skip_and_advances_seq`; `crash_mid_frame_truncates_and_resumes`; M24b Vitest list | covered |
| Deferred: OPFS append/flush latency on iOS Safari | M23, M39 | criterion "`device-checks.md` section for this milestone matches what was built" (`opfs-latency.html`); M39 ticks it | covered |
| Deferred: `OldStore` shape | M24b | criterion "`OldStore`, `OldValue`, `Rescale` ... public ... rustdoc examples that compile" | covered |

## ADR 0006: Time units

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| Types: `Tick(u32)` point, `Ticks(u32)` duration; plain `number` in TS | M12b, M16b | `ticks_conversion_20_and_30_hz`; `clock_returns_same_object` | covered |
| Sim state stores only `Tick`/`Ticks`, never seconds or floats of time | | authoring constraint; nothing to build | n/a |
| Conversion rule: integer, nearest with ties up, never zero for non-zero | M12b, M24b | `ticks_conversion_20_and_30_hz`; `rescale_matches_0006_rounding` (non-zero floor) | covered |
| `TickRate::hz` compile error outside 10..=60; `DT` const | M12b | doc tests `tickrate_hz_out_of_range` (two `compile_fail` blocks), run by build step `doctests` (M12b exit: flipping one block fails the build phase); `dt_is_reciprocal` | covered |
| No `f32` seconds entry point | | absence of an API | n/a |
| Where: `const fn`, converted at compile time or at init, never inside a tick; handlers store `done_at` | M21b, M20 | fixture `const SMELT = TICK_RATE.secs(5)` under `smelt_cycle_golden`; `collect_completes_and_depletes` | covered |
| Rates: ratios stay counts; integer accumulator; `DT` with closed-form springs | M33b, M20b | guidance; shown by `one_coal_smelts_exactly_ten`, `spring_settles_and_is_dt_independent` | n/a |
| Client: UI derives remaining time from `done_at` and `client.clock()` (authoritative, predicted, `ticksPerSecond`) | M16b, M26 | `progress_from_done_at_and_clock`; `prediction-no-flicker` (`predicted − authoritative` equals the lead) | covered |
| Rate change 1: new sim identity and new segment; durations re-convert | M24b | `rules_only_change_direct_load_new_segment`, `identity_compare_matrix` | covered |
| Rate change 2: `tick_rate_hz` stamped; mismatch treated as a schema mismatch; `migrate` rescales; else `SaveIncompatible` | M24b | `tick_rate_change_without_bump_still_requires_migrate`, `migrate_hz_change_rescales_engine_timers`, `rescale_matches_0006_rounding` | covered |
| Rate change 3: the world tick counter is never rescaled | M24b | `rescale_matches_0006_rounding` (`deadline` for past and future ticks), `rescale_identity_is_noop` | covered |
| Consequences: conversion unit-tested at 20 and 30 Hz against the reference game's durations | M20, M32, M33b | `durations_at_20_and_30_hz`; `craft_duration_at_20_and_30_hz`; `smelt_takes_five_seconds_at_20_and_30_hz` | covered |
| Deferred: helper that rescales `Tick`/`Ticks` fields during `migrate` | M24b | `Rescale`, `RescaleTicks` public (criterion); `rescale_matches_0006_rounding` | covered |


## ADR 0007: World model

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| §1 pristine is a total pure function; sim has no ungenerated state or chunk event | M07, M08 | `source_called_once_per_chunk_when_unlimited`, `host_reads_are_total` (M12b), `pristine_matches_generate` | covered |
| §1 state = overlays + entities + players/globals; snapshots, hashes and wire never carry pristine | M07, M15, M22 | `golden_terrain_canonical`, `pristine_chunk_enters_as_coord_only`, `snapshot_excludes_dense_cache` | covered |
| §1 dense chunks are an invisible LRU cache; miss generates synchronously in the tick | M07, M08, M12b | `cache_invisible_matrix` (3 capacities x 3 prewarm modes), `cache_invisible_real_worldgen`, `puts_cache_invisible` | covered |
| §1 replica read outside subscription is `Unknown` | M15 | `view_unknown_outside_subscription` | covered |
| §1 canonical overlay (no entry equal to pristine; cached pristine never serialized; count can fall) | M07 | `overlay_never_holds_pristine`, `set_back_to_pristine_drops_entry_and_count`, `canonical_bytes_independent_of_write_history`, `loaded_entries_learn_pristine_on_materialize` | covered |
| §2 `TilePos`, floor chunk coords, row-major local index | M07 | `chunk_of_negative_tiles_floors`, `local_index_row_major` | covered |
| §2 `WorldPos` Q24.8, range ±2^23, clamp, writes rejected, reads `VOID` | M07 | `worldpos_range_and_clamp`, `out_of_range_reads_void_writes_rejected`, `tile_void_traits_all` | covered |
| §2 u64 chunk key; ordered containers for state | M07, M12 | `chunk_key_roundtrip`, `overlay_sorted`; exit "No `HashMap`/`HashSet` under `src/world/`"; M12 grep on `store*` | covered |
| §2 camera-relative rendering far from origin | M09 | `terrain.far_from_origin_exact` | covered |
| §3 chunk size 16/32/64, default 32, compile-time const (runtime `ChunkDims`, amended by 0024 §9) | M07 | `dims_reject_unsupported_bits`; exit "pass by name at `CHUNK_BITS` 4, 5 and 6" | covered |
| §3 chunk size recorded in world params | M24b | `chunk_bits_mismatch_save_incompatible_files_untouched` (`ManifestV1.params.chunkBits`, reason `ChunkSize`) | covered |
| 0024 §9 browser topology asserts `CHUNK_BITS = 5` with a readable fatal | M08b, M09 | `gen: oversize slab is a readable fatal` (M09's init check is Planning text only) | covered |
| §4 `Tile` is 4 bytes, LE layer order, 4,096-byte row-major slab | M07 | `tile_le_byte_order`, `golden_terrain_canonical`; `memory_bytes()` asserted in `cache_events_report_slots` | covered |
| §4 upload path: one copy into the upload ring is the texel pass; one `writeTexture` per chunk; delta patches one texel | M09 | `upload.record_layout_golden`, `terrain.probe_tile_colours`, `terrain.patch_one_texel`, `terrain.upload_budget_while_panning` | covered |
| §5 `ChunkTerrain` / `ChunkOverlay` / `ChunkIndex` lifetimes; index derived and rebuilt on load | M07, M21 | `lru_evicts_least_recent`, `overlay_sorted`, `index_rebuild_equals_incremental` | covered |
| §5 entities stored globally keyed by `EntityId`, ids from a sim-state counter (amended by 0022 §1, §3: one ordered map, never reused) | M12 | `entity_id_policy_*`, `store_hash_ignores_insertion_order` | covered |
| §5 worldgen spawns no entities in v1 | M08 | enforced by the `Worldgen` signature; `worldgen_contract_fixture` | n/a |
| §5 multi-tile entities: anchor + footprint, all overlapped chunks updated in one tick | M21, M33 | `footprint_sets_every_overlapped_chunk`, `despawn_clears_all_chunks`, `move_updates_old_and_new`, `place_across_chunk_corner_sets_occupancy_in_four_chunks` | covered |
| §5 footprint ≤ chunk size asserted | M21 | `footprint_larger_than_chunk_panics_at_register` | covered |
| §5 anchor chunk owns hashing; relevant if any overlapped chunk subscribed | M15, M21 | `entity_straddling_subscribed_and_unsubscribed_chunks_delivered_once`, `border_machine_delivered_once_to_partial_subscriber` | covered |
| §6 `TraitSet(u64)`, three-table `traits_at`, game-declared bits | M07, M21 | `traits_union_of_tables`, `entity_at_any_covered_tile` | covered |
| §6 placement asks the tiles, names no tile type | M21, M33 | `placement_is_one_trait_query`, `can_place_names_no_tile_type` | covered |
| §6 same tables in the client-role instance | M21, M33 | `replica_traits_at_matches_host`, `reference_place_mouse` (invalid tint over water) | covered |
| §7 chunks never tick; per-system active lists in insertion order | M21b | `active_iteration_stable_under_deactivate`, `idle_world_visits_zero_entities` | covered |
| §7 sleep/wake applied at one fixed point (amended by 0024 §7b: put outside `tick` wakes same tick) | M21b | `put_from_apply_wakes_same_tick`, `put_from_tick_does_not_self_wake`, `wake_dedup_and_order`, `undrained_wakes_are_dropped` | covered |
| §7 timer wheel keyed `(tick, EntityId)` | M21b, M33b | `timer_fires_at_exact_tick_in_key_order`, `wake_at_replaces`, `idle_furnaces_cost_nothing` | covered |
| §7 lists, wakes and timers are sim state in canonical order | M21b, M22 | `timers_survive_encode_decode`, `replay_equals_live_with_timers` | covered |
| §8 cache budget: fixed pool at init, LRU, exploration never refused; host default 1,024 chunks | M07 | `lru_evicts_least_recent`, `no_alloc_terrain`, exact `memory_bytes()` for the default capacity | covered |
| §8 client cache default 1,024; resident set at most 225 | M08b | `queue_counts_at_view_bound` | covered |
| §8 state budget counts, enforced per action before `apply` (amended by 0023: `growth`) | M21 | `full_world_rejects_place_accepts_remove_then_place`, `undeclared_action_uses_max_action_growth`, `budget_verdict_replays_identically`, `growth_declarations_are_honest` | covered |
| §8 nominal costs fixed by the engine (128 B, 12 B), not `size_of` | M21 | `nominal_costs_are_constants` | covered |
| §8 tick-rule writes never refused; budget soft by the margin | M21b | `tick_rule_put_past_limit_is_applied` | covered |
| §8 init computes the split from real `size_of` and fails startup over budget or arena | M21 | `init_rejects_budget_over_arena` | covered |
| §8 view bound arithmetic (81 / 121 / 128) | M15, M08b | `subs_clamps_oversized_and_zero_views`, `queue_counts_at_view_bound` | covered |
| §9 `WORLDGEN_VERSION` + fingerprint of 16 fixed chunks | M08 | `fingerprint_stable_and_sensitive`, `fingerprint_golden` | covered |
| §9 stamp carried in params, snapshots, segment headers; mismatch gives `SaveIncompatible` | M22, M24b | `persist_snapshot_golden_bytes`, `worldgen_stamp_mismatch_requires_migrate` | covered |
| Consequences: replay with cache capacity 1 / default / unlimited and shuffled generation order | M07, M12b | `cache_invisible_matrix`, `cache_invisible_insert_pristine_any_order`, `puts_cache_invisible` | covered |
| Consequences: raised budgets fail cleanly on a phone | M21 | `init_rejects_budget_over_arena` | covered |
| Consequences: two 8-bit layers fixed; more needs an ADR | none | constraint | n/a |
| Deferred: entity store layout and id reuse (settled by 0022) | M12 | `entity_id_policy_*` | covered |
| Deferred: overlay promotion at 512 entries; bucketed area effects | M07, M36 | decided not built (M07 Planning 9, deferred ledger); trigger is M36 `mem.simHighWaterLargeSave` | n/a |
| Deferred: on-device validation of the 64 MiB split | M36, M39 | M36 "Memory per instance" high-water + zero grows in soaks; M39 device checklist | covered |

## ADR 0008: Chunk generation

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| §1 `Worldgen` trait: pure, synchronous, non-allocating, writes every element | M08 | `worldgen_contract_fixture` (every element written, zero allocation inside `generate`) | covered |
| §1 no neighbour reads; output independent of order and repetition | M08 | `worldgen_contract_fixture`, `pristine_matches_generate` | covered |
| §1 randomness only from `hash2`; never the sim PRNG | M08 | `hash2_vectors`; signature gives no RNG | covered |
| §1 one chunk single-threaded; parallelism across chunks only | M08b | `gen: one and two workers give equal chunk hashes` | covered |
| §1 f64 noise coordinates; sim-grade float rules | M08, M20 | `noise_raw_bits_golden`, `noise_bounded`; M20 `worldgen_golden` with chunks near ±2^18; import-allowlist and clippy bans on `reference-sim` | covered |
| §1 per-chunk, not per-tile; `tile(pos)` answered from the cache | M07 | `source_called_once_per_chunk_when_unlimited` | covered |
| §2 client gen workers: `gen` role, tiny arena, SAB rings; 1 worker, 2 at ≥ 8 cores | M08, M08b | `gen: gen_chunk fills GenOut`, `gen: sim role returns WrongRole`, `genWorkerCount rule`, `gen: drops 0, mem_grows 0, stats exact` | covered |
| §2 worker count cannot affect results | M08b | `gen: one and two workers give equal chunk hashes` | covered |
| §2 sim host generates synchronously on a miss (also client role under prediction; full-speed replay) | M07, M12b, M27 | `cache_invisible_real_worldgen`, `replay_equals_live`; headless clients generate on miss in every netcode scenario (`join-converges`) | covered |
| §2 host warmer: idle gap, 2 ms budget, visible rect, nearest first, invisible to the sim | M13 | `simhost_warmer_respects_budget`, `warm_nearest_first`, `warm_is_invisible_to_hash` | covered |
| §3 clients regenerate pristine; host sends pristine list entry or snapshot as of tick T, deltas from T+1 | M15 | `pristine_chunk_enters_as_coord_only`, `modified_chunk_enters_as_snapshot_then_deltas_from_next_tick` | covered |
| §3 leave frees overlay and entities, pristine cache survives | M15 | `leave_frees_overlay_keeps_pristine` | covered |
| §3 section id reserved for a full tile payload, not built | M14 | `golden_section_ids` | covered |
| §3 generated chunk uploaded as pristine at once, patched when the snapshot arrives; `Unknown` until then | M15, M15b | `overlay_tile_reaches_screen`, `view_unknown_outside_subscription` | covered |
| §4 queue in the client worker, preallocated, sorted in place | M08b | `no_alloc_gen_queue` | covered |
| §4 priority ring class then look-ahead distance; re-sort on chunk or zoom change | M08b | `queue_orders_ring_class_then_distance`, `queue_resorts_only_on_chunk_or_zoom_change`, `gen: visible before ring 1 before ring 2` | covered |
| §4 at most 2 in flight per worker | M08b | `queue_in_flight_cap_per_worker` | covered |
| §4 cancel only undispatched beyond ring 3; late results cached | M08b | `queue_cancels_undispatched_beyond_ring3`, `queue_keeps_late_results` | covered |
| §5 ring 1 generate + upload, ring 2 generate only, retain through ring 3 | M08b, M09 | `queue_touches_retained`, `gen: visible before ring 1 before ring 2`; `terrain.upload_budget_while_panning` (all ring-1 chunks resident at rest) | covered |
| §5 generation set is a superset of the subscription set (shared look-ahead) | M08b | `queue_generation_superset_of_lookahead`, `lookahead_caps_extra_chunks` | covered |
| §5 169 generated / 225 retained at the view bound | M08b | `queue_counts_at_view_bound`; `genJoinChunks` exact in `budgets.json` | covered |
| §6 generator budget: desktop benchmark warns above 0.25 ms per chunk | M08, M20, M36 | `worldgen-bench` exit criterion; `baselines/worldgen.json` | covered |
| §6 1 ms per chunk on the baseline phone | M08 | device check "M08: Worldgen ms per chunk" (`worldgen-bench.html`) | covered |
| Consequences: permanent golden hash across Node, Bun, Chromium, Firefox, WebKit on raw tile bytes | M08 | exit "`fixtures/worldgen/golden.json` is matched natively, under Node, under Bun and in the three browsers" | covered |
| Consequences: server holds no chunk because it is viewed (small warmed set only) | M13 | `simhost_warmer_respects_budget` (`chunksWarmed` ceiling) | covered |
| Deferred: phone ms per chunk; revisit budget and worker count | M08 | device check M08 | covered |
| Deferred: sampled pristine-hash check | M07, M08 | decided none (deferred ledger); dev-build assert in `insert_pristine`, exercised by `cache_invisible_insert_pristine_any_order` | n/a |
| Deferred: noise helpers into the engine crate | M08 | `noise_raw_bits_golden`, `noise_bounded` (`engine::noise`) | covered |

## ADR 0009: Transport and hosting

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| WebSocket binary, `arraybuffer`, one socket per client owned by the net worker | M29 | `ws/join-converges`, `mp/two-pages`; grep test "no frame parsing in `src/worker/net.ts`" | covered |
| No `permessage-deflate` | M29 | `ws/deflate-refused`; `ws/join-converges` asserts empty negotiated extensions | covered |
| Message classes `reliable-ordered` / `latest-wins`; packed into one packet without datagrams; separate with `datagrams: true` | M27, M14 | `latest-wins-datagrams`, `golden_section_ids` | covered |
| `Connection` interface (engine-owned buffer, optional `bufferedAmount`) | M27, M15b | `memory-connection`, `byte-pump-backpressure`, `ring_connection_roundtrip` | covered |
| `HostServices` + `createWorldServer` (amended by 0024 §5: `ready`, `onFatal`) | M27, M37 | exit "return type and `HostServices.onFatal?` match 0024 §5 (type-asserted)"; `server/ready-rejects-on-corrupt-world`, `server/accept-before-ready-waits`, `fatal: server onFatal stops world and closes sockets` | covered |
| `WorldConfig` field list, used unchanged by server and single-player sim worker | M13, M27 | type declared in M13; per field: `load_ignores_config_params_when_world_exists` (M22b), `handshake/bad-key`, `handshake/full`, `lifecycle/keep-ticking-when-empty`, `subs_clamps_oversized_and_zero_views`, `start.arena_config_rejected`, `rates/action-rate-limited`, `rates/bucket-refill-exact` | covered |
| 0024 §5 seed stays decimal text; `createSimHost` converts once to `HexU64` | M13 | `simhost_seed_decimal_to_hex_u64` | covered |
| Params, budgets and `arenaBytes` reach the instance as one-time JSON config | M02, M21 | `abi::` config errors give `BadConfig`; `init_rejects_budget_over_arena` | covered |
| Node adapter structurally typed; engine imports nothing, no RFC 6455 code | M29, M35b | `ws/join-converges`, `reference-server/smoke`; exit "`packages/engine` still has zero `dependencies`" | covered |
| Bun and Deno adapters wrap built-in servers | M35b | `bun-adapter loopback`, `deno-adapter @slow`, `server adapters export parity` | covered |
| Host-agnostic: no runtime-conditional code in the core | M27, M35b | exit "No `node:` import outside `src/server-node.ts`" (grep test); "no `Bun.` or `Deno.` identifier outside" adapters | covered |
| Target 1: Node ≥ 22 or Bun as a process; tests run here | M27, M29 | exit "`pnpm test wasm` runs its logs through `createWorldServer` under Node and Bun" | covered |
| Target 2: Durable Objects proof (and deferred feasibility check) | M38 | `do/local-smoke`; exit "The DO ADR exists" + results table (memory, timer p50/p99, cost, restarts) | covered |
| Target 3: Deno best-effort | M35b | `deno-adapter @slow` (passes with `deno-missing`) | covered |
| Vercel, API Gateway, Deno Deploy out for the sim | none | constraint | n/a |
| DO constraints accepted: no `bufferedAmount`, backpressure by `last_received_tick` | M31 | `rates/degrade-on-stall` | covered |
| DO constraints accepted: restart is routine, so recovery is a normal path | M22b, M28b | crash matrix; `reconnect/host-restart-epoch` | covered |
| Cost target about $5/month, about $0 idle; server exits on `onIdle` | M38, M28b, M29 | M38 results table (Fly always-on and idle cost, wake time); `lifecycle/idle-stops-ticks-then-onidle`; `reference-server/smoke` (`--exit-on-idle`) | covered |
| Single-player: same bytes over a SAB ring pair `Connection`, `datagrams: false`, no net worker | M15b | `ring_connection_roundtrip`, `host_accepts_ring_connection_and_hashes_match`, `replica_hash_equals_host_in_browser`; `workers.spawn_local` (M06b) | covered |
| Consequences: WebSocket garbage confined to the net worker | M29 | `gc/multiplayer-topology`, `gc/net-negative-control` | covered |
| Consequences: tests use the real in-memory pair or loopback `ws` under a deterministic conditioner; nothing mocked | M27, M29 | `conditioned-link`, `memory-connection`, `conditioner`, `ws/trace-identical` | covered |
| Consequences: two deploy recipes documented, no engine code for either | M38 | exit "Both recipes are in `games/reference-server/README.md`"; `reference-server/docker-args` | covered |
| Deferred: WebTransport adapter | M27 | decided no milestone (M27 Planning decisions); `datagrams` path kept alive by `latest-wins-datagrams` | n/a |

## ADR 0010: Rates, subscriptions, bandwidth

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| Rates: tick 20 Hz default, per-game constant, fixed for a world's life | M12b, M13, M24b | `ticks_conversion_20_and_30_hz`, `simhost_paces_at_tick_rate`, `tick_rate_change_without_bump_still_requires_migrate` | covered |
| Rates: tick rate constant limited to 10 to 60 | M12b | `tickrate_hz_out_of_range`: `TICK_RATE` can only be built by `TickRate::hz`, which fails to compile at 9 and 61 | covered |
| Rates: one frame per tick when there is anything; idle sends nothing; heartbeat every 500 ms | M15, M28, M31 | `idle_tick_builds_no_frame`, `liveness/heartbeat-idle-world`, `golden_heartbeat_is_10_bytes`, `rates/idle-sends-only-heartbeats` | covered |
| Rates: degrade to every 2nd then 4th tick on backlog or soft cap | M31 | `rates/degrade-on-stall` | covered |
| Rates: adaptive interpolation delay (150 initial, 100 floor, 400 cap, ≤ 10 % dilation, never stepped) | M30 | `delay_initial_floor_cap`, `delay_follows_p95_formula`, `delay_never_steps`, `jitter_profile_adapts` | covered |
| 0024 §15 conditional: extrapolation ratio above 0.2 forces a superseding ADR | M30 | `extrapolation_ratio`; exit "`extrapolation_ratio` and its verdict are written under Deviations" | covered |
| Rates: uplink at most one batch per 50 ms; actions flushed at once; camera and presence ≤ 10 Hz on change; `last_received_tick` | M15, M19, M14 | `uplink_at_most_one_batch_per_interval`, `sampler_rate_and_on_change`, `golden_uplink_batch` | covered |
| Rates: at least one uplink batch per 1 s | M15 | `uplink_keepalive_batch_every_1s` | covered |
| Rates: host drops camera reports beyond 20/s | M31 | `rates/camera-flood-dropped` | covered |
| Tick CPU budget ≤ 10 ms; proxy median ≤ 3 ms on the large save | M36, M38 | `slow_tick_large_save` meets the 0010 desktop proxy; M38 results table (tick p50/p99 under 8 clients on Fly) | covered |
| Tick overrunning 50 ms is counted and reported | M13 | `simhost_counts_tick_overrun` | covered |
| Camera report: 16 B `latest-wins`, never seen by the sim | M14, M19 | `golden_uplink_batch` (16 B fixed); `presence_is_not_state` pattern; M15 `host_and_client` outside `sim/` | covered |
| Camera report sent on quantized change, leading-edge and trailing sends | M15, M15b | `camera_report_on_change_leading_and_trailing` (M15) | covered |
| Subscription: ring 1 + look-ahead capped at 2 chunks | M15 | `subs_ring1_plus_lookahead` | covered |
| Subscription: unsubscribe beyond ring 3 and 5 s outside; small pans cause no traffic | M15, M15b | `subs_unsubscribe_after_hold`, `subs_hysteresis_no_traffic_on_small_pan`, `pan_changes_subscription` | covered |
| Subscription: cap 128, farthest-first eviction in priority order | M15, M15b | `subs_cap_evicts_farthest_first`, `join_at_max_zoom_out_never_drops` | covered |
| Clamps: view ≤ 256 tiles per axis, centre in range, zero or oversize clamped not rejected | M15 | `subs_clamps_oversized_and_zero_views` | covered |
| Clamps sent in `Welcome` so the client clamps zoom-out to match | M28, M11 | `golden-welcome`, `camera.zoom_clamps_and_constraints`, `handshake/welcome-view-clamp-limits-zoom` | covered |
| Camera teleports allowed; chunk pacing is the limit | M31 | `rates/join-dense-visible-first`, `zoomout/*` | covered |
| Bandwidth: steady down 1 to 5 KB/s typical | M31, M34c | `rates/steady-busy-field`, `rates/seven-remote-presences`, `reference_bytes_and_mispredictions_in_budget` | covered |
| Bandwidth: steady up about 0.4 KB/s panning, about 0 at rest | M31, M19 | `rates/uplink-panning`; `uplink_presence_bytes_per_s` ceiling | covered |
| Bandwidth: soft cap 16 KB/s; deltas larger than a snapshot collapse to the snapshot | M31 | `rates/degrade-on-stall`, `rates/deltas-collapse-to-snapshot` | covered |
| Bandwidth: chunk token bucket 48 KB/s + 128 KB burst, visible first; tick frames never queue behind chunks | M31 | `rates/bucket-refill-exact`, `rates/join-dense-visible-first` | covered |
| Bandwidth: hard ceiling 64 KB/s | M31 | `rates/hard-ceiling` | covered |
| Bandwidth: data use 10 to 20 MB per hour | none | derived from the rows above | n/a |
| Worked numbers: header 10 B, pristine enter about 3 B | M14 | `golden_frame_header`, `golden_heartbeat_is_10_bytes`, exit on `golden_coord_list_*` byte costs | covered |
| Worked numbers: join wilderness and dense; worst pan | M15, M31 | `golden_frame_bytes_join_wilderness`, `budgets.json` `join_wilderness` / `join_modified` ceilings, `rates/join-wilderness`, `zoomout/pan-2vw` | covered |
| Worked numbers: seven presences about 1 KB/s; hashes about 60 B/s | M30, M31b | `presence_bytes_budget`, `integrity/hash-bytes-per-second` | covered |
| Worked numbers: reconnect hint about 1 KB up | M28b | `reconnect/cost` | covered |
| Consequences: never replicate per-tick progress; derive from `done_at` and the clock | M16b, M33b | `progress_from_done_at_and_clock`, `idle_furnaces_cost_nothing` | covered |
| Consequences: clamp and pacing live host-side, outside the sim, unlogged | M15, M19 | `replica_hash_equals_host_region_hash`, `presence_is_not_state`; crate rule `sim/` may not import `host/` | covered |
| Consequences: every number is config with these defaults | M31, M13 | bucket, soft cap and rate read `WorldConfig.bandwidth` / `actionRate` (`rates/bucket-refill-exact`); `budgets.json` `net.*` rows cite the 0010 cell | covered |
| Deferred: real frame sizes with the reference game on a scripted network | M34c, M36b | `reference_bytes_and_mispredictions_in_budget`, `busy-furnace-field @slow` | covered |

## ADR 0011: Wire format and deltas

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| Encoding: tagless LE framing, LEB128 varints, run-length overlay runs | M14, M05 | `golden_*` wire tests, `golden_overlay_runs_literal_and_repeat`, `varint_matches_postcard` | covered |
| Encoding: game values are `postcard` via `Codec`, same bytes as the log | M05, M14, M22 | `codec_roundtrip_plain_data`, `golden_uplink_batch`, `persist_frame_golden_bytes` | covered |
| Encoding: only the handshake prefix is layout-stable across builds | M28 | `session/golden-hello`, `golden-reject` (frozen prefix bytes) | covered |
| 0024 §8: handshake magic first byte ≥ 0x80, type bytes 0x01..0x7F | M14, M28 | `golden_section_ids` / type table; `handshake/garbage-before-hello` | covered |
| Frame: 10-byte header, fixed section order | M14 | `golden_frame_header`, `golden_section_ids`, `sections_out_of_order_rejected` | covered |
| Frame applied atomically before the next `extract` | M15, M16 | `frame_is_atomic_on_malformed_tail`, `ack_and_deltas_share_a_frame`, `vertical_slice` (result and colour in the same stepped frame) | covered |
| Decode path: net worker copies bytes to a ring, client worker to a receive region, one `on_frame` export, parse in place, no JS object per frame | M15, M15b, M29 | `encode_decode_no_alloc`, `host_and_client_steady_state_no_alloc`, M15b zero-GC page with panning, M29 grep test "no frame parsing in `src/worker/net.ts`" | covered |
| Plain-data requirement on `G::Entity`, `G::Player`, `G::Action` | M05, M12 | `no_alloc_codec`, `store_apply_existing_key_no_alloc` | covered |
| `Delta<G>` is the only write path, derived mechanically; games write no encoders | M12, M12b | `every_put_is_one_delta_with_scope`, `store_apply_is_idempotent` | covered |
| 0024 §8: engine-only `Delta::Roster` | M12, M14, M34 | `golden_global_and_own_player` (roster in `Global`), `reference_roster_follows_join_grace_and_return` | covered |
| Replica applies the same value through the same `Store::apply`; snapshot = puts from empty; puts idempotent | M12, M15 | `store_apply_is_idempotent`, `replica_hash_equals_host_region_hash` | covered |
| Scopes: `Chunk` to subscribers | M15 | `modified_chunk_enters_as_snapshot_then_deltas_from_next_tick`, `view_unknown_outside_subscription` | covered |
| Scopes: `Player` to that player only; `Global` to all; both sent in full on every connect | M15, M27 | `first_frame_has_global_and_own_player`, `late-join` | covered |
| Scopes: `Presence` never hashed or logged | M19 | `presence_is_not_state`, `presence_section_golden` | covered |
| Entity delivered if any footprint chunk subscribed, deduplicated by id; anchor chunk owns hashing | M15, M21 | `entity_straddling_subscribed_and_unsubscribed_chunks_delivered_once`, `border_machine_delivered_once_to_partial_subscriber` | covered |
| Entity moving between chunks: full state on entering a subscription, `EntityGone` on leaving | M21 | loopback `moved_entity_enters_and_leaves_subscription` (fixture action `Move`) | covered |
| Chunk enter: pristine entry (coord only) or snapshot as of T; deltas from T+1; host never sends pristine tiles | M15, M14 | `pristine_chunk_enters_as_coord_only`, `modified_chunk_enters_as_snapshot_then_deltas_from_next_tick`, `golden_chunk_snapshot` | covered |
| Chunk leave frees overlay and orphaned entities; pristine cache survives | M15, M21 | `leave_frees_overlay_keeps_pristine`, `border_machine_gone_when_last_overlapped_chunk_leaves` | covered |
| Per-chunk version = tick of last replicated change, on both sides | M28b | `session/hint-diff`, `reconnect/resume-keeps-unchanged-chunks`, `reconnect/changed-while-away` | covered |
| Queued deltas larger than the snapshot are replaced by the snapshot | M31 | `rates/deltas-collapse-to-snapshot` | covered |
| Consequences: any wire change is a build-hash change; no mixed versions | M28 | `handshake/version-mismatch` | covered |
| Consequences: overlay may arrive before local generation; replica stores overlays sparsely | M07 | `cache_invisible_insert_pristine_any_order` (results early, late, duplicated), `loaded_entries_learn_pristine_on_materialize` | covered |
| Deferred: byte-diffing after a busy-furnace-field measurement | M36b | `busy-furnace-field @slow`; exit "build / do-not-build decision are in the ADR" | covered |
| Deferred: section ids, varint coordinate coding, overlay run format | M14 | `golden_section_ids`, `golden_coord_list_negative_and_far`, `golden_overlay_runs_literal_and_repeat` | covered |

## ADR 0012: Prediction and reconciliation

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| Only own discrete actions are predicted, all by default; opt-out for cascade or RNG | M25 | `placement_is_immediate_and_converges`, `opt_out_declines`, `rng_declines` | covered |
| Client runs no tick rules | M02, M26 | `loader: wrong-role export returns WrongRole`; own timers tested without client ticks (`own_timer_no_jump_at_ack`) | covered |
| Reset-and-replay overlay: three preallocated vectors, truncate to mark on failure | M25 | `taint_rollback_visibility`, `rival_takes_the_spot_never_torn`, `predict_alloc` | covered |
| Per-frame steps: apply deltas, pop acked, clear, re-run pending | M25 | `dependent_actions_replay_across_ack`, `insufficient_inventory_with_pending_spend` | covered |
| `Confirmed` / `Rejected(reason)` raised to the UI (no id map, amended by 0022 §6) | M16, M25 | `vertical_slice` (`onActionResult` Confirmed and typed Rejected), `predict_not_predictable_event` | covered |
| 0024 §8: client-side `Lost` result after reconnect | M28b | `reconnect/lost-ack-reports-lost` | covered |
| 0 allocations over 190 frames x 4 pending | M25 | `predict_alloc`; exit "`predict_alloc` reports 0" | covered |
| Pending queue fixed capacity 32; dispatch fails locally when full | M16, M25 | `dispatch_when_queue_full_fails_locally` (M16; M25 inherits it unchanged) | covered |
| `Unknown` reads: `saw_unknown` overrides, truncate, mark `NotPredictable`, still send | M25, M34c | `edge_action_declines_but_resolves`, `predict_not_predictable_event`, `reference_subscription_edge_not_predictable` | covered |
| Local `Rejected` is a hint; the client always sends | M25 | `taint_dependency` (contradicted verdicts counted; host accepts both) | covered |
| Frozen predicted tick per pending action | M25, M26 | `frozen_predicted_tick`, `lead_change_leaves_pending_frozen` | covered |
| Two clocks: authoritative and predicted = authoritative + lead | M16b, M26 | `clock_returns_same_object`, `prediction-no-flicker` (`predicted − authoritative` equals the lead), `lead_converges_to_exact` | covered |
| Own timers rendered in the predicted clock, no jump at ack | M26 | `own_timer_no_jump_at_ack` | covered |
| Correction: ack and deltas in one frame, ghost leaves as the real result appears | M26, M33 | `swap_is_one_render`, `reference_ghost_swap_one_frame` | covered |
| Correction: conflicting delta before the reject; never torn (ghost XOR refund) | M26 | `reject_is_one_render` | covered |
| Correction: `extract` marks overlay-sourced items `predicted` | M26 | `swap_is_one_render` (`PREDICTED` reads 1…1 0…0) | covered |
| Correction: k-tick own-timer correction eases over about 200 ms | M26 | `own_timer_correction_eases` | covered |
| Remote motion: Hermite interpolation at host time minus delay; extrapolate ≤ 250 ms then hold; fade after 2 s | M30 | `hermite_hits_samples_and_is_c1`, `extrapolates_then_holds`, `fades_after_silence_and_recovers`, `stall_then_recover` | covered |
| Remote motion: moving entities share the presence buffer and code path | M30 | `interp_entity_key_same_path` (buffer and path; feeding entities stays M30 Non-scope: no v1 moving entity) | covered |
| Remote machine and player progress derived from parameters + authoritative clock | M16b, M33b | `progress_from_done_at_and_clock`, `reference_furnace_flow` | covered |
| Single-player runs the identical path with prediction on | M25, M26, M33 | exit "browser zero-GC test passes with prediction on"; `prediction-no-flicker`, `reference_place_mouse` on the single-player page | covered |
| Consequences: author rules (validate first, `?` on reads) | M25 | `.claude/rules/prediction.md` created (Context artifacts); `under-validated` handler twin `rejecting_apply_wrote_nothing` (M12b) | covered |
| Consequences: panic under prediction traps only the client instance | M37 | `trap: client instance recovers and resyncs`, `trap: headless client resyncs` | covered |
| Interim rule made permanent: address predicted things by tile (amended by 0022 §6) | M25, M33b | `provisional_id_rejected_by_deserialize`, `deposit_into_predicted_furnace_before_ack` | covered |
| Deferred: provisional ids (settled by 0022 §5, §7) | M25 | `provisional_id_stable_across_replays`, `entity_id_gone_vs_unsubscribed` | covered |
| Deferred: taint rule after `NotPredictable` | M25 | `taint_dependency`, `taint_independence`; exit "chosen taint rule and the measured counts are written under Deviations", "No losing taint strategy remains" | covered |
| Deferred: per-frame overlay change list for the renderer | M26 | `texel_upload_only_on_change`, `drawlist_hash_stable_across_replays` | covered |
| Deferred: undo journal measurement; until then assert a rejecting handler wrote nothing | M12b, M21b | `rejecting_apply_wrote_nothing`; `journal_rolls_back_store_indexes_wakes_counts`, `apply_journal_overhead`; exit "The journal ADR exists" | covered |
| Deferred: own-timer completion gap | M26 | `completion_gap_measured`; exit "measured gaps are recorded under Deviations"; device check M34-own-timer-bar | covered |
| Deferred: lead estimation | M26, M30 | `lead_seed_from_rtt`, `lead_converges_to_exact`, `lead_tracks_rtt_under_jitter`, `host_clock_under_jitter` | covered |
| Deferred: iterating reads over replica + overlay | M25 | `entities_in_merges_overlay`, `entities_in_order_matches_authority` | covered |
| Deferred: "does not exist" vs "outside my subscription" in `entity(id)` (settled by 0022 §7) | M25 | `entity_id_gone_vs_unsubscribed` | covered |


## ADR 0013: Sessions and integrity

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| Identity: device secret minted once, kept in `localStorage` | M28 | `secret/persists-across-reload` | covered |
| Identity: host session table `SHA-256(secret)` to `PlayerId`, persisted outside sim state | M28 | `handshake/join-then-return-same-player`, `handshake/crash-between-table-and-log` | covered |
| Identity: first sight of a secret is a join (`Joined`, later `Connected`) | M28 | `handshake/join-then-return-same-player` (`Connected` not `Joined`) | covered |
| Join key: shared secret from server config; `BadKey` | M28, M34c | `handshake/bad-key`, `reference_full_and_bad_key_rejected` | covered |
| Join key travels in the invite link URL fragment | M29, M34 | `readInvite: parses #k= and ignores unknown parameters`; `mp/two-pages` joins through an invite URL | covered |
| `max_players` cap and `Full`; default 8 | M28, M34c | `handshake/full`, `reference_full_and_bad_key_rejected`; the default value 8 is not asserted | covered |
| Single-player uses the same handshake with an empty key | M28 | "Every netcode scenario opens with `Hello`; no provisional-join code path remains" + existing single-player browser tests | covered |
| Handshake: `Hello` frozen prefix, layout (magic first byte >= 0x80, amended by 0024 §8) | M14, M28 | `session/golden-hello`; `handshake/garbage-before-hello`, `handshake/no-hello-timeout` | covered |
| Handshake: `Welcome` contents (ids, epoch, tick, seed, clamps, last seq, last presence) | M28 | `golden-welcome` | covered |
| Handshake: `Reject` frozen layout, three reasons, server build hash | M28 | `golden-reject`; "`Reject` golden bytes are identical from the TS builder and the Rust parser" | covered |
| Join is late join: logged connection event after `Welcome`; first frames carry `Global` + `Player`, visible chunks first | M15, M27, M31 | `first_frame_has_global_and_own_player`, `late-join`, `rates/join-dense-visible-first` | covered |
| Client reveals world once visible chunks are received and generated | M28, M29 | `handshake/reveal-after-visible-chunks`, `mp/reveal-waits-for-visible-chunks` | covered |
| Reconnect: resume hint, keep / snapshot / leave per chunk; host keeps no per-session state | M28b | `session/hint-diff`, `session/golden-keep-entry`, `reconnect/resume-keeps-unchanged-chunks`, `reconnect/changed-while-away` | covered |
| Reconnect: `Global` and `Player` always resent | M28b | `reconnect/resume-keeps-unchanged-chunks` (first frame after the resume carries `Global` and `OwnPlayer` with every chunk kept) | covered |
| Reconnect: `epoch` increments per host start; foreign-epoch hint ignored | M28b | `reconnect/host-restart-epoch`, `session/hint-diff` (foreign epoch) | covered |
| Reconnect: pending actions resent above `last_processed_action_seq`, applied once, also across host restart | M28b, M22b, M34c | `reconnect/pending-resent-once`, `resend_after_recovery_not_applied_twice`, `reference_pending_place_applied_once_after_reconnect` | covered |
| Reconnect: `Lost` result for acked-but-unreported actions (amended by 0024 §8) | M28b | `reconnect/lost-ack-reports-lost` | covered |
| Reconnect: second `Welcome` is the resync signal (amended by 0024 §8) | M28b | `reconnect/panic-recovery-resync` | covered |
| Reconnect cost: one RTT, about 1 KB each way | M28b | `reconnect/cost` against `reconnectBytesUp/Down` rows | covered |
| Discarded page reloads and rejoins with the same secret | M28, M34 | `secret/persists-across-reload`, `reference_returning_player_resumes` | covered |
| Client policy: dead after 3 s without a frame, or on `close` | M28 | `liveness/dead-after-silence`, `liveness/heartbeat-idle-world` | covered |
| Client policy: probe at once on `visible` / `online`, 1 s deadline | M28, M29 | `liveness/probe-on-visible`; the main to net `probe` message: device check M29-socket-resume | covered |
| Client policy: backoff 0, 0.5, 1, 2, 5 s, jittered | M28 | `liveness/backoff-schedule` | covered |
| Client policy: new socket opens before the old one is discarded | M28 | `liveness/stale-socket-ignored` | covered |
| Client policy: game stays interactive; indicator after 1 s; no modal | M29, M34, M37 | M37 `engine event surface` row "reconnect indicator delay"; device check M29-play-through-drop | covered |
| Disconnected: presence vanishes from others at once | M28b, M30 | `reconnect/presence-vanishes-at-once`, `disconnect_removes_at_once` | covered |
| Disconnected: logged only after 10 s grace; `Bye` skips grace | M28b | `reconnect/within-grace-logs-nothing`, `reconnect/after-grace-logs-disconnected`, `reconnect/bye-skips-grace` | covered |
| Disconnected: game handler decides consequences | M32, M34c | `disconnect_cancels_collect_keeps_craft`, `reference_short_drop_keeps_collect`, `reference_long_drop_cancels_collect_keeps_craft` | covered |
| Player state persists under its `PlayerId`; last presence sample kept in session table | M28, M34 | `reference_returning_player_resumes`, `reference_roster_follows_join_grace_and_return` | covered |
| Same secret in a second tab: newest wins, `Bye{Superseded}`, no auto-reconnect | M28, M29 | `handshake/superseded`, `mp/superseded` | covered |
| Build hash = SHA-256 of `.wasm`; strict equality; `Reject{VersionMismatch}` | M02, M28, M29 | `build: game.json matches bytes`, `handshake/version-mismatch`, `ws/version-mismatch` | covered |
| Mismatch event: default handler reloads once (`sessionStorage` guard), then "updating" and backoff | M29 | `mp/version-mismatch-reloads-once` | covered |
| World lifecycle: one world per server; load newest snapshot + tail, else create from params | M27, M22b | `server/load-or-create`, `load_empty_storage_creates_world`, `load_ignores_config_params_when_world_exists` | covered |
| World lifecycle: ticking stops at last `Disconnected`; after 30 s snapshot, flush, `onIdle`; `keepTickingWhenEmpty`; new connection resumes | M28b, M29, M34c | `lifecycle/idle-stops-ticks-then-onidle`, `lifecycle/hello-resumes`, `lifecycle/keep-ticking-when-empty`, `reference-server/smoke`, `reference_idle_world_pauses` | covered |
| Ticks are counted, so a pause is invisible to replay | M28b | `lifecycle/idle-stops-ticks-then-onidle` (tick counter frozen, timer fixture unchanged) | covered |
| Desync hash: state hash over the chunk-enter encoding; replica only, never the overlay | M31b | `integrity/hash-ignores-overlay`, `integrity/clean-session-no-reports` | covered |
| Desync hash schedule: one chunk per 4 ticks, recent first then round-robin; about 60 B/s | M31b | `integrity/schedule-recent-first-then-round-robin`, `integrity/hash-bytes-per-second` | covered |
| `Global` and `Player` hashes every 5 s; mismatch recovery by reserved coordinate (amended by 0024 §8) | M31b | `integrity/global-mismatch-heals` | covered |
| Mismatch: `ResyncChunk`, snapshot through the chunk bucket, desync report on both sides | M31b, M37 | `integrity/golden-resync-chunk`, `integrity/corrupt-chunk-heals`, `integrity/skipped-delta-heals`, `integrity/resync-respects-bucket`; `onDesync` in `engine event surface` | covered |
| Dev builds hash every chunk every frame and dump both encodings | M31b | `integrity/hash-all-dumps-encodings`; "every pre-existing netcode scenario passes with `hashAll: true`" | covered |
| Consequences: service-worker games must bypass cache on mismatch reload | | advice to game authors, nothing to build | n/a |
| Consequences: host restart costs a full join | M28b | `reconnect/host-restart-epoch` | covered |
| Deferred: "copy my player link" | M28 | decided not built; `deferred-ledger.md` row | n/a |
| Deferred: iOS worker-owned socket behaviour after resume | M29 | device check M29-socket-resume (M29 device section criterion) | covered |

## ADR 0014: JS to WASM boundary

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| §1 no wasm-bindgen / wasm-pack; fixed C ABI; build is plain `cargo build` | M02, M35 | `import allowlist`; exit criterion "imports of `fx-hash` is exactly `engine.panic`, `engine.log`"; tarball test asserts allowlist | covered |
| §1 one fixed runtime-agnostic loader (worker, Node, Bun) | M02, M03 | `determinism: node matches golden`, Bun leg, `determinism @engines` | covered |
| §2 numbers only: no `i64`, no multi-value, no `externref`, no strings | M02 | `abi registry` (signatures read through `readSections`: fails on `i64`, `externref` or more than one result) | covered |
| §2 64-bit values cross as two `u32` halves | M02 | `sim_hash` through `readU64Hex`, exercised by every golden test | covered |
| §2 JS never sees a game-specific symbol | M02 | `abi registry` (function exports equal `ABI_EXPORTS` exactly) | covered |
| §3 exactly two imports, output-only; time, randomness, storage are never imports | M02 | `import allowlist`; the `getrandom` by-hand exit criterion | covered |
| §3 `log` compiled out below `warn` in release builds | M35 | `release module drops info logs @slow` | covered |
| §3 a `log` call inside the measured window fails 0016 | M04 | named as a usual cause in the `gc-test` skill; no control test | n/a |
| §3 memory is exported, not imported | M02 | `import allowlist` (`memory` is an export of kind `memory`; no import of kind `memory`) | covered |
| §3 allowlist test: every fixture and the reference game; failure text names module and culprit | M02, M08b, M20, M24, M24b | `import allowlist` "failure text per 0014 §3"; "M02 import-allowlist test ... run against `reference-sim`" | covered |
| §3 loader supplies only `engine.*` (LinkError otherwise) | M02 | follows from `import allowlist`; no separate test needed | covered |
| §4 `engine_abi_version`; mismatch is a load error naming both versions | M02, M03 | `loader: abi mismatch`; `wiring.spec.ts` ABI version matches | covered |
| §4 `engine_boot` region; `engine_init` parses config, reserves arena, status codes | M02 | `abi::` unit tests (config errors to `BadConfig`), `loader: init failure carries status` | covered |
| §4 sim hot exports incl. `sim_seal_frame`, `sim_snapshot_begin/next` (amended by 0024 §1) | M13, M16, M22 | `simhost_seal_precedes_tick`, `host_applies_only_sealed_records`, `write_ahead_order`; "ABI registry test includes the four new exports" | covered |
| §4 client hot exports `on_frame`, `on_action`, `on_input`, `frame` | M11, M15b, M16 | `input.events_reach_wasm`, `replica_hash_equals_host_in_browser`, `vertical_slice` | covered |
| §4 gen export `gen_chunk` writing one slab | M08 | `gen: gen_chunk fills GenOut`, `gen: sim role returns WrongRole` | covered |
| §4 slab size from runtime `ChunkDims`; browser asserts `CHUNK_BITS = 5` with readable fatal (amended by 0024 §9) | M07, M08b, M09 | tests "at `CHUNK_BITS` 4, 5 and 6"; `gen: oversize slab is a readable fatal`; M09 has no named test for its half of the assertion | covered |
| §4 regions laid out once, never move; views built once after init | M02, M06b | `region()` stable holder under `loader: views survive memory growth`; `sab.no_alloc_syntax`; pages `topology`, `echo` | covered |
| §4 copy in / copy out through view pairs; no `subarray` or `new Uint8Array` in steady state | M06b, M08b, M15b | page `echo`; grep criteria in M08b and M15b | covered |
| §4 growth detaches views; one call wrapper checks and rebuilds | M02, M24 | `loader: views survive memory growth`; `host_never_calls_raw_exports` | covered |
| §4 config crosses once as JSON in the boot region; `Params` typed by `ts-rs` | M02, M16b, M20 | `abi::` config tests; bindings regenerate criteria; typed `Params` binding not named | covered |
| §4 server uses the same regions without rings | M27 | `pnpm test wasm` logs through `createWorldServer` under Node and Bun with existing goldens | covered |
| §5 `export_game!` is the only ABI line; emits all exports, allocator, panic hook | M02, M12 | `abi registry` on every fixture; `puts_fixture_builds_wasm32` | covered |
| §5 one role for life; other role's export returns an error status | M02, M08 | `loader: wrong-role export returns WrongRole`, `gen: sim role returns WrongRole` | covered |
| §5 wrong-role call traps in debug | M02 | M02 Planning decision "Wrong-role calls return `Status::WrongRole` on every profile": the debug trap is deliberately not built (departure recorded under M02 Deviations for M39b's ADR sweep); the status is `loader: wrong-role export returns WrongRole` | covered |
| §6 `panic = "abort"`; dev-profile `.wasm` panic still traps (amended by 0024 §13) | M01, M02 | `loader: panic marks instance dead with message` (`panicAtTick`, dev profile) | covered |
| §6 hook formats into boot region without allocating; `engine.panic` stores text | M02, M03 | message asserted by `loader: panic marks instance dead with message` and `wiring.spec.ts` (`EngineTrap` with the Rust message); the no-allocation property is order-of-work text only | covered |
| §6 wrapper catches `RuntimeError`, marks instance dead, no further export call | M02, M24 | `loader: panic marks instance dead with message`, `dead_instance_memory_still_readable`, `host_never_calls_raw_exports` | covered |
| §6 sim trap goes to the 0005 recovery path | M24 | `panic_in_apply_writes_skip_then_resumes`, `sim_worker_recovers_from_panic` | covered |
| §6 client trap: fresh instance plus full resync | M37 | `trap: client instance recovers and resyncs`, `trap: headless client resyncs` | covered |
| §6 gen trap: fresh instance, requests re-queued | M37, M08b | `trap: gen instance recovers and chunk arrives`, `queue_requeue_in_flight` | covered |
| §6 compiled `Module` kept for re-instantiation | M24 | `fresh_instance_reuses_module` | covered |
| §6 trap without `engine.panic` reports the `RuntimeError` message | M24 | `trap_without_panic_uses_runtime_error_message` | covered |
| Consequences: WASM to SAB direction first measured in Phase 3 | M06b | page `echo` | covered |
| Deferred: final export list, region ids, status codes | M02 onward | `abi registry`, re-asserted by M08, M08b, M22, M24 | covered |
| Deferred: where `engine.log` text is decoded | M02, M03 | `wiring.spec.ts` (an `engine.log` line arrives through `onLog`); ledger row | covered |

## ADR 0015: Threads, memory and topology

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| §1 main compiles the module once, spawns every worker, posts `Module` + SABs; no nested workers | M06b | `workers.spawn_local`, `workers.spawn_remote`, `workers.url_fallback` | covered |
| §1 main thread never instantiates WASM | M06b (M35 cites it) | `main.no_wasm_instantiate` (M06b source scan; M35's `exports-map` bullet cites it and adds no second check) | covered |
| §1 client worker owns replica, prediction, gen queue, `extract`, all uplink assembly | M08b, M15b, M19 | `pan_changes_subscription`, `presence-worker-path`, `uplink_at_most_one_batch_per_interval` | covered |
| §1 net worker is a byte pump that never parses frames | M29 | grep test "no frame parsing in `src/worker/net.ts`"; `gc/net-negative-control` | covered |
| §1 sim worker owns the world, tick loop, OPFS handles and Web Lock | M13, M23 | `sim_worker_steps_and_hashes`, `second_tab_gets_world_busy`, `world_survives_reload` | covered |
| §1 worldgen workers: 1, or 2 at `hardwareConcurrency >= 8` | M08b | `genWorkerCount rule`, `gen: one and two workers give equal chunk hashes` | covered |
| §1 client worker cannot tell single-player from multiplayer (same bytes, same ring) | M15b, M29 | `replica_hash_equals_host_in_browser`, `ws/join-converges`, `mp/two-pages` | covered |
| §1 topologies: MP = main + client + net + gen; SP = main + client + sim + gen | M06b, M29 | `workers.spawn_local`, `workers.spawn_remote`, `gc/multiplayer-topology` | covered |
| §1 server: one context, one sim instance, no workers, no SABs; bytes copied straight to regions | M27 | `join-converges`, `server/load-or-create` | covered |
| §1 TS sim host is the same code in worker and server; only `Connection`, `Storage`, clock differ | M13, M27 | grep test "no `node:` import outside `src/server-node.ts`"; `wasm_idle_100_matches_native` + `sim_worker_steps_and_hashes` on one host | covered |
| §1 `Storage` writes never awaited on the tick path | M22 | `tick_path_never_awaits` | covered |
| §1 server worldgen synchronous plus between-tick warmer | M13 | `warm_nearest_first`, `warm_is_invisible_to_hash`, `simhost_warmer_respects_budget` | covered |
| §2 SPSC ring: fixed slots, one preallocated view per slot, large messages span slots | M06, M15b | `ring.spsc_sequence`, `ring.fixed_records`, `ring.wrap_and_span`, `ring_connection_spans_slots`, `sab.ring_both_directions` | covered |
| §2 full ring is backpressure, never loss; `drops` reads 0 in tests | M06, M15b, M27 | `ring.full_is_backpressure`, `ring_connection_backpressure_retries_not_drops`, `byte-pump-backpressure` | covered |
| §2 seqlock block for small latest-wins records | M06 | `seqlock.no_torn_read`, `camera_block.roundtrip` | covered |
| §2 triple buffer for large latest-wins frames | M06, M17 | `triple.newest_wins_never_partial`, `drawlist.triple_newest_wins` | covered |
| §2 no `Atomics.waitAsync`; main never blocks, polls rings once per rAF | M06, M06b | `sab.no_alloc_syntax` (fails on `waitAsync` under `src/` and on `Atomics.wait(` outside `sab/control.ts` and `src/test/**`); `main.no_wasm_instantiate` (main never names `waitForWake` or `Atomics.wait`) | covered |
| §2 workers block in `Atomics.wait`; one wake word per consumer (amended by 0024 §10) | M06, M06b | `control.no_lost_wakeup`; page `topology` | covered |
| §2 client worker frame clock: notified by main once per rAF after the camera-block write | M06b, M11 | page `topology`, `camera.block_reaches_worker_each_frame` | covered |
| §2 sim worker waits with timeout to next tick deadline | M13 | `simhost_paces_at_tick_rate`, `sim_worker_steps_and_hashes` | covered |
| §2 `yield` flag returns a blocked worker to its event loop | M06b, M13 | `workers.park_resume`, `sim_worker_yields_for_cdp` | covered |
| §2 net worker event-driven; uplink drained on `setInterval` | M29 | `gc/multiplayer-topology` (net isolate); the poll period has no named test | covered |
| §2 `postMessage` only for setup, fatal, lifecycle | M06b, M37 | grep criterion in M06b, repeated in M37 | covered |
| §3 exact COOP/COEP on every response incl. worker script and wasm | M02b, M03 | `plugin-dev: headers on every response`, `plugin-build: preview sends COOP/COEP`, `wiring.spec.ts` | covered |
| §3 `credentialless` never used | M02b | header value asserted only indirectly by `crossOriginIsolated` in WebKit (`determinism @engines`) | covered |
| §3 engine checks `crossOriginIsolated` at start; readable errors for not isolated and blocked worker | M06b, M29 | `start.not_isolated_error`, `start.worker_blocked_error`, `mp/coep-worker-error-message` | covered |
| §3 what breaks (cross-origin resources, popups, iframes) | | documentation of platform behaviour | n/a |
| §3 per-host header recipes; one real static host verified | M38, M39b | own handler only: `check-coi.mjs $FLY_URL`, `reference-server/static-headers`, `deployed/coi-and-online`; no static host is deployed (Pages not approved); M39b carries the open item | unverified by decision (Q6), carried to 39b |
| §3 GitHub Pages and `coi-serviceworker` unsupported | | constraint, nothing to build | n/a |
| §4 no WASM threads or shared memory; stable Rust; copy-in / copy-out | M01, M02 | toolchain pin criterion; `target features` rejects `atomics` | covered |
| §5 one `memory.grow` to the role's arena at init, before views | M06b, M08b | `workers.spawn_local` (`W_MEM_PAGES` equals each arena), `engine_mem_grows() == 0` | covered |
| §5 module declares no memory `maximum` | M02 | `import allowlist` (memory section read through `readSections`: no `maximum`) | covered |
| §5 arena sizes are per-game config per role; defaults 96 / 48 / 4 MiB | M06b | `workers.spawn_local`, `arena.sum_rule`; default values not asserted by name | covered |
| §5 whole-tab target of 256 MiB on the baseline phone | M06, M06b, M11, M16 | `layout.sab_total_under_budget`; device checks M11-memory, M16-coexist | covered |
| §5 instance checks its budgets against its arena at init | M21 | `init_rejects_budget_over_arena` | covered |
| §5 main rejects a config whose arenas sum past the tab target | M06b | `start.arena_config_rejected`, `arena.sum_rule` | covered |
| §5 growth counted: `engine_mem_grows()`, views rebuilt, 0 in steady state | M02, M06b, M36 | `loader: views survive memory growth`; zero-grow assertions on every gc page; soak zero grows | covered |
| §5 dev and test builds trap with a message on arena exhaustion; release grows in 16 MiB steps to the ceiling; failed grow is a panic | M02 (dev trap), M35 (release steps), M24 (failed grow) | `loader: arena exhaustion traps with message` (M02); `release growth steps 16 MiB and counts @slow` (M35); `alloc_failure_in_tick_is_fatal_and_files_untouched` (M24) | covered |
| §5 memory never shrinks; leaving a world drops the instance | M06b | `workers.destroy_terminates` | covered |
| §6 one `.wasm`, instantiated per role; no client-only build | M02, M06b | `abi registry` (every module carries every export); spawn tests | covered |
| §6 size budgets: `.wasm` 1 MB warn / 2 MB fail, engine JS 50 KB brotli | M35 | `size @slow`; `size.json` criterion | covered |
| §6 default target features only; never `relaxed-simd` | M02, M36b | `target features`; `feature-matrix @slow` | covered |
| Consequences: hosting limits documented in the reference game's README | M38 | M38 exit criterion on the `games/reference/README.md` Hosting section (0015 Consequences limits) | covered |
| Consequences: worker to main only was measured; both directions owed | M06, M06b | `sab.ring_both_directions`, page `echo` | covered |
| Deferred: on-device memory ceilings | M11 | device check M11-memory (M11 device section criterion) | covered |
| Deferred: ring capacities, uplink poll period, control-block layout, `yield` protocol | M06, M06b, M15b | `layout.sab_total_under_budget`, `join_at_max_zoom_out_never_drops`, `workers.park_resume` | covered |

## ADR 0016: Zero-GC definition

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| §1 main-thread budget by the WebGPU wrapper formula; per-page rows (amended by 0024 §12) | M04, M09, M17 | `gc.pages.terrain` with `main` derived by the formula; final `main` on `gc.pages.drawables` | covered |
| §1 strict 8 B/frame, zero GC events on client, sim and gen workers | M04, M06b, M08b, M13, M15b | `gc-loop clean`; pages `topology`, `echo`; `gen: zero-GC over a scripted pan`; sim isolate extension | covered |
| §1 net worker budgeted per received message, no `MajorGC`; still measured | M29 | `gc/multiplayer-topology`, `gc/net-negative-control` | covered |
| §1 every WASM instance: `memory.buffer.byteLength` unchanged | M06b, M08b, M17, M29 | "unchanged `memory.buffer.byteLength` on every instance"; `memGrows() == 0` criteria | covered |
| §1 bytes per frame = exact sampled bytes / N main frames | M04 | `gc analyse: sums selfSize exactly` | covered |
| §1 budgets in one checked-in file; raising one is a reviewed change; formula text kept | M04, M09, M18 | `budgets: every gc page lists main`; M09 and M18 criteria on `formula` | covered |
| §1 renderer keeps wrapper-returning calls per frame constant | M09, M17 | `counters.draws_equal_nonempty_layers`; page budgets derived from the count | covered |
| §2 window includes ticks, deltas, continuous pan and zoom, chunk generate / upload / evict | M09, M11, M15b | page `terrain` scripted pan; page `input`; M15b 600 frames with panning | covered |
| §2 window includes game actions from pre-encoded bytes | M16, M17 | "Zero-GC test now includes actions via `dispatchRaw`"; page `drawables` | covered |
| §2 chunk-enter bursts not exempt; chunk CPU and GPU storage pooled at setup | M08b, M09 | `gen: zero-GC over a scripted pan`, page `terrain`, `terrain.upload_budget_while_panning` | covered |
| §2 exempt: setup and 120 warm-up frames | M04 | harness sequence (`run(warmup)`); frame count not asserted | covered |
| §2 exempt: game DOM UI; test page mounts no UI | M04, M20b | pages are fixture pages; M20b asserts only the client-worker budget on the reference page | covered |
| §2 overlay anchoring: separate budget line with a fixed anchor count | M18 | page `anchors`; `overlay.idle_writes_nothing`; "`gc.pages.anchors` with the constant in its `formula`" | covered |
| §2 exempt: `dispatch` JSON encode on main only | M16 | window uses `dispatchRaw`, so ring, parse, prediction, wire encode stay covered | covered |
| §2 exempt rare discontinuities (resize, device loss, reconnect, panic recovery) | M24, M37, M37b | "recovery stays out of the zero-GC window by construction"; `device loss then zero-GC window @slow` | covered |
| §3 one test per topology; multiplayer against a real local server | M23, M29, M34b | `zero_gc_singleplayer_with_snapshot`, `gc.reference_single_player`, `gc/multiplayer-topology` | covered |
| §3 launch flags (unsafe WebGPU, spare-renderer off, suppressed randomness) | M04 | project `gc` uses "the launch args of 0016 §3" (Seams text); `pnpm gc reliability` 50/50 is the indirect check | covered |
| §3.1 COOP/COEP page, non-null adapter, `adapter.info` recorded | M09, M10 | "every GPU test records `adapter.info` and fails on a null adapter" | covered |
| §3.2 CDP sessions per isolate; both transports (amended by 0024 §12) | M04 | `gc analyse: events are attributed to named isolates`, `gc: flat transport parity` | covered |
| §3.3 to 3.5 warm-up, collect, sampling at interval 1, marks, N = 600 stepped frames in lockstep | M04 | `gc-loop clean` within budget; `pnpm gc reliability` clean 50/50 | covered |
| §3.6 assertion A: zero GC events inside the marks on every isolate | M04 | `gc analyse: GC events outside the marks are ignored`; burst controls | covered |
| §3.7 assertion B: bytes / N within budget; failure prints top call frames | M04 | exit criterion: `{}` in `call0` fails `gc-loop clean` with `call0` among printed sites | covered |
| §3.8 permanent negative controls, each failing on its named isolate only | M04, M06b, M09, M29 | `gc-loop neg *` tests; generated controls per page; `gc/net-negative-control` | covered |
| Caveat a: `Tracing.start` stall reported as a named warning | M04 | `gc verdict: tracing stall is a warning`; M04 exit "`pnpm test unit -t \"gc verdict\"`" | covered |
| Caveat b: software-adapter form of B (attributed bytes, smaller N) | M04, M10 | `gc verdict: software mode uses attributed bytes`; `pnpm gc software -t "gc-loop clean"`; M10 `software` block criterion | covered |
| Caveat c: only the V8 heap is measured | | limitation statement | n/a |
| Consequences: no `postMessage` on per-frame or per-tick paths | M04, M06b | `gc-loop neg post-message main<->sim`; grep criterion | covered |
| Consequences: engine-level input injection that does not allocate | M11, M18 | page `input`; `framecx.emit_visible_in_frame` (allocates nothing) | covered |
| Consequences: test-only build exposes stepping, negative-control hook, memory size | M03, M04, M06b | `stepping.spec.ts`; `memGrows()`; `asHarness`; dist grep finds no test import | covered |
| Consequences: desktop Chromium only; iOS checked by feel | M16, M39 | device check M16-coexist (no visible hitch); M39 full checklist | covered |
| Consequences: fallback if `sendMessageToTarget` is removed (amended by 0024 §12) | M04 | `gc: flat transport parity`; `pnpm gc flat` | covered |
| Deferred: final main-thread number | M17 | "final `main` number on `gc.pages.drawables` by the formula" | covered |
| Deferred: overlay-anchoring string constant | M18 | `gc.pages.anchors` constant criterion | covered |
| Deferred: software-adapter numbers | M10 | "every zero-GC page with WebGPU has a non-null `software` block ... pass on the runner" | covered |
| Deferred: snapshot `write` inside or outside the strict window | M23 | "Decision 1 is resolved in writing"; `zero_gc_singleplayer_with_snapshot`, `neg_control_snapshot_allocates` | covered |
| Log `append` and `sync` inside the strict window | M23, M22b | `zero_gc_singleplayer_with_snapshot`; `fs_append_allocates_no_buffers` | covered |

## ADR 0017: Packaging and build

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| §1 one pnpm workspace, one cargo workspace, one lockfile each, one `target/` | M01 | "`pnpm install --frozen-lockfile` succeeds; `pnpm-lock.yaml` and `Cargo.lock` are committed" | covered |
| §1 `packages/engine`: `src` to `dist` by `tsc`, crate under `crates/`, fixtures outside `files` | M01, M35 | "`pack --json` lists only `dist/**`, `crates/**`, `package.json`" | covered |
| §1 `games/reference` and `games/reference-server` layout | M20, M29 | `pnpm --filter reference dev` criterion; `reference-server/smoke` | covered |
| §1 in-repo game depends on the crate by direct relative path, never `node_modules` | M20 | `reference_package_depends_only_on_engine` (relative `path` in `sim/Cargo.toml`, `workspace:*`) | covered |
| §2 exports map: explicit subpaths, no runtime conditions | M35, M35b | `exports-map` (final); `server adapters export parity` | covered |
| §2 zero runtime dependencies; `vite` optional types-only peer | M02b, M35, M35b | "`vite.ts` imports Node built-ins and types only"; "`packages/engine` still has zero `dependencies`" | covered |
| §2 `dist/worker.js` self-contained; one worker script for every kind | M06b, M35 | `exports-map` (no bare import, no `import(`); tarball test "all four worker kinds" | covered |
| §2 `./test` never imported by production code | M03, M22b, M35 | dist grep criterion; `exports-map` | covered |
| §3 pattern A default: engine constructs the worker | M06b, M35 | `workers.spawn_local`; tarball cells with pattern A | covered |
| §3 pattern B escape hatch via `createWorker` | M35 | `tarball-install @slow` "all four worker kinds under pattern B" | covered |
| §3 plugin appends engine dir to `server.fs.allow` | M02b, M35 | `plugin-dev: fs.allow contains engine dir`; link cell of the tarball test | covered |
| §4 `buildGame` writes `game.wasm` + `game.json` | M02 | `build: game.json matches bytes` | covered |
| §4 browser: `virtual:engine/wasm` yields url + `buildHash` | M02b, M03 | `plugin-dev: virtual module carries url and buildHash`; `wiring.spec.ts` | covered |
| §4 dev middleware serves `application/wasm` with cache-buster | M02b | `plugin-dev: wasm served as application/wasm`, `plugin-dev: touch triggers rebuild and full-reload` (`?v` incremented) | covered |
| §4 build emits a hashed, never inlined asset | M02b, M35 | `plugin-build: hashed non-inlined wasm asset`; tarball assertion | covered |
| §4 main `compileStreaming` once and posts `Module`; URL fallback in the worker | M06b, M11 | `workers.spawn_local`, `workers.url_fallback`; real-Safari device check | covered |
| §4 server: every adapter exports `loadGame(dir)` | M02, M35b, M35 | `server adapters export parity`; tarball server leg (Node + Bun) | covered |
| §4 build hash = SHA-256 of final bytes, after `wasm-opt` | M02, M35 | `build: game.json matches bytes`; `build: wasm-opt changes hash and sets game.json @slow` | covered |
| §4 `vite dev` = dev profile, `vite build` = release; dev client cannot join release server | M02b | `plugin: default profile follows the Vite command`; `plugin-build: default profile writes a release game.json @slow` (M02b exit names both) | covered |
| §5 `buildGame` = plain cargo, optional `wasm-opt`, hash; one function for plugin, tests, server scripts | M02, M34b | `pnpm test wasm` criterion; `build-game-features` | covered |
| §5 plugin: build in `buildStart`, recursive watch of game and engine crates, debounce, `full-reload` | M02b, M10, M35 | `plugin-dev: touch triggers rebuild and full-reload`; `plugin-dev: nested touch triggers rebuild`; Linux criterion in M10 | covered |
| §5 plugin: rustc error to overlay, recovery after fix | M02b | `plugin: rustc error reaches overlay and recovers @slow` | covered |
| §5 plugin sets COOP/COEP (dev + preview), `worker.format: 'es'`, no `optimizeDeps.exclude` | M02b | header tests; `worker.format` and the absence of `optimizeDeps.exclude` are Scope text only | covered |
| §5 bindings step after build, not gating reload; generated files committed | M16, M16b, M20 | "`bindings/*.ts` ... regenerate byte-identically"; `git diff --exit-code games/reference/src/bindings` | covered |
| §5 `wasm-opt` optional, off in dev and tests, fixed flag list | M35 | `build: wasm-opt changes hash and sets game.json @slow` | covered |
| §6 what a game writes: three-line vite config, `sim/Cargo.toml`, `export_game!` | M20, M35 | `pnpm --filter reference dev` criterion; tarball scratch app | covered |
| §6 profiles as listed (amended by 0024 §13: repo keeps them verbatim, no `panic = "abort"` in dev) | M01, M35 | M01 has no criterion on the profile tables; M35 "root `Cargo.toml` matches" the measured ADR | covered |
| §6 external game must have no ancestor `[workspace]` | M35 | tarball scratch location outside the repo; rule recorded in `packages/engine/CLAUDE.md` | covered |
| §6 reference README carries host recipes and the two-header requirement | M38 | M38 exit criterion on the README Hosting section (two headers, per-host listings, each marked unverified) | covered |
| §7 engine crate runtime deps are exactly the listed set | M02 (M35 consumes) | `crate-policy` (M02; M35 adds no second test) | covered |
| §7 `ts-rs` adds nothing reachable; size test watches it | M35 | `ts-rs zero bytes @slow` | covered |
| §7 new dependency needs an ADR with the listed evidence | M01 | process rule, carried by the `write-adr` skill | n/a |
| §7 game crates gated by the import allowlist and lint bans | M02, M20 | `import allowlist`; "No `HashMap`, std transcendental or wall clock in `sim/`" | covered |
| §8 not published; tarball-install test keeps discipline | M35 | `tarball-install @slow` every cell | covered |
| §9 size measured on release `game.wasm` at brotli 11 | M35 | `size @slow` | covered |
| §9 fast tier builds on the dev profile incl. packaging smoke | M03, M35 | served `vite build` on the dev profile (M03 decision); M35 "packaging smoke if absent" | covered |
| §9 slow tier builds release: size, tarball, golden replay on the release module | M35, M36 | `size @slow`, `tarball-install @slow`, `release-golden` | covered |
| §10 exact toolchain pins (Rust, Node, pnpm, Vite, TS, Playwright, Vitest, nextest, Biome, Bun) | M01 | "every devDependency is an exact version matching 0017 §10"; "`cargo nextest --version` reports the pin" | covered |
| §10 bumping a pin re-runs both tiers, goldens, negative controls | | process rule | n/a |
| §10 Biome + rustfmt + clippy + `tsc`; `pnpm lint` runs all four | M01 | "`pnpm lint` prints four `pass` lines"; mis-formatted scratch file criterion | covered |
| §10 the two no-compile checks are the commit hook | M01 | hook-by-pipe criterion | covered |
| Consequences: native linker needed (`DEVELOPER_DIR`) | M01 | `toolEnv()`; `pnpm setup:tools` criterion | covered |
| Consequences: only the slow tier proves the release module | M36 | `release-golden` | covered |
| Consequences: deploy must ship one `buildGame` output (`wasm-opt` skew) | M35 | `game.json` gains `wasmOpt`; `build: wasm-opt changes hash ...` | covered |
| Consequences, untested by spike: `fs.allow`, Safari posted `Module`, recursive `fs.watch` on Linux, `ts-rs` zero bytes | M02b, M06b, M10, M11, M35 | named tests above; M10 Linux criterion; device check | covered |
| Deferred: one crate or several | M01, M36b | split triggers in M01; lever order in M36b `pnpm measure:rebuild` criterion | covered |
| Deferred: release build time and size, intermediate profile, `line-tables-only` | M35 | "The ADR 'Build profiles, measured' holds every number ... and the three profile decisions" | covered |
| Deferred: snapshot, reload, restore on Rust edit | M37 | `dev-reload-keeps-world @slow` | covered |


## ADR 0018: Renderer

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| §1 TS renderer on main, all WebGPU calls in one rAF callback, no game knowledge | M09, M17 | zero-GC pages `terrain` and `drawables` on isolate `main`; `canvas.presents` (M09b) | covered |
| §1 descriptors, submit array and views created once; wrapper floor is the main budget | M09, M17 | M09 criterion "`gc.pages.terrain` with `main` derived by 0016 §1's formula"; M17 final `main` number | covered |
| §1 `GPUTexture`-as-view startup probe skips `createView()` | M09 | `device.view_probe_both_paths` | covered |
| §2 `extract` fills an engine-owned `DrawList`; shape helpers sprite, circle, ring, rect, bar, radial, ghost | M17, M17b | `draw.circle_and_ring_probe`, `draw.rect_bar_radial_probe`, `sprite.pivot_and_size_probe`, `drawlist.fixture_hash_golden` | covered |
| §2 `Draw` is exactly 32 bytes little-endian | M17 | `draw.layout_is_32_bytes_le` | covered |
| §2 capacity 65,536 records; a full list drops and counts | M17 | `drawlist.full_drops_and_counts`; criterion `drawListDropped == 0` | covered |
| §2 publish = stable counting sort by layer into a SAB triple-buffer slot with header | M17 | `drawlist.counting_sort_stable`, `drawlist.layer_counts_and_prefix`, `drawlist.triple_newest_wins` | covered |
| §2 one `writeBuffer`, one instanced draw per non-empty layer, no depth, bundles or indirect | M17 | `counters.draws_equal_nonempty_layers`; `counters["render.drawCallsMax"]` | covered |
| §2 `pick_id` not bound as a vertex attribute | M17 | `uberquad.vertex_layout_has_no_pick_id` (M17 Scope names `UBERQUAD_VERTEX_LAYOUT`) | covered |
| §2 positions relative to window origin; one-frame-old list under newest camera has no error | M17 | `draw.one_frame_old_list_has_no_error`, `drawlist.pos_relative_to_window_origin_exact_at_2pow23` | covered |
| §2 `tile_visual` default from tables, game override shows `aux` | M09 | `texel.default_identity`, `texel.registered_tables`, `texel.override_shows_aux` | covered |
| §2 `FrameView` carries interpolated `WorldRead`, clocks, visible rect, cursor tile | M16b, M17, M18 | `frameview.entities_sorted_and_clipped`, `ghost.mouse_tracks_cursor_tile` | covered |
| §3 terrain is one full-viewport triangle, pixel to tile to chunk to slot to texel | M09 | `terrain.probe_tile_colours`, `counters["render.drawCallsTerrain"] = 1` | covered |
| §3 texel format `rg16uint`, converted by client-role WASM into the upload ring | M09 | `upload.record_layout_golden`, `texel.*` | covered |
| §3 tile page texture, slot = dense-cache slab index, one `writeTexture` per chunk, one texel per delta, byte budget per frame | M09, M15b | `terrain.patch_one_texel`, `terrain.upload_budget_while_panning`, `upload.stage_respects_max`, `overlay_tile_reaches_screen` | covered |
| §3 64x64 toroidal indirection texture, ±31 window, non-resident draws neutral | M09 | `upload.toroidal_window_pm31`, `upload.indir_after_chunk`, `terrain.nonresident_is_neutral` | covered |
| §3 neighbour reads through indirection; missing neighbour = self | M09b | `terrain.missing_neighbour_is_self` | covered |
| §3 visual table as a 16 KiB uniform (first layer, variants, flags, priority, band) | M09, M09b | `terrain.variants_match_reference`, `terrain.dither_only_inside_band` read every field | covered |
| §3 art sampling: tile array texture, PCG variant/flip/jitter, Bayer edge dither with fade, fat-pixel magnify, trilinear minify | M09b | `terrain.variants_match_reference`, `terrain.dither_only_inside_band`, `terrain.dither_fades_when_minified`, `terrain.magnified_texel_exact`, `terrain.minified_converges_to_mean` | covered |
| §3 no zoom snapping; camera snaps to device pixels at rest | M11 | `camera.snaps_to_device_px_at_rest_only` | covered |
| §4 `tiles.png` + `tiles.json` contract, limits 256 images and 1,024 visuals, mips to 1x1, premultiplied load | M09, M09b, M20 | `manifest.schema_errors`, `terrain.minified_converges_to_mean`, `gen_assets_reproducible` | covered |
| §4 `sprites.png` atlas with 2 px extrusion, 2 mips, `sprites.json`, 4,096 sprites | M17b | `sprites.schema_errors`, `sprite.no_bleed_at_mip1`, `sprite.frames_by_param` | covered |
| §4 one uber-quad pipeline draws all kinds; no in-canvas text | M17, M17b | `wgsl.uberquad_validates`, `sprite.layering_with_shapes`, `counters["render.pipelineSwitches"]` | covered |
| §4 no compressed formats, no engine asset tool | none | constraint | n/a |
| §5 camera-relative maths: i32 tile + f32 frac, precision independent of origin distance | M09, M11, M17 | `terrain.far_from_origin_exact`, `camera.precision_at_2pow23`, `drawlist.pos_relative_to_window_origin_exact_at_2pow23` | covered |
| §6 zoom limits default 12 to 256 tiles | M11 | `camera.zoom_clamps_and_constraints` | covered |
| §6 far zoom needs no terrain LOD (mips converge to mean colour); worst case 65,536 drawables | M09b, M17b | `terrain.minified_converges_to_mean`, `bench.frame_worstcase` | covered |
| §6 `FrameView.zoom` exposed so a game can skip small drawables | M17 | `frameview.zoom_matches_camera_block` | covered |
| §7 no non-WebGPU path; `checkSupport()` from the package root explains failures | M35, M06b | `checkSupport: each code`, `reference: capability screen on failure`, `support.report_shape` | covered |
| §7 compatibility mode as a design constraint (feature level, limits not raised, vertex-buffer instances) | M09, M35 | ADR says not a test commitment; M09 Scope requests it, M35 adds `limits-too-low` | n/a |
| §8 canvas configured once: preferred format, opaque, no depth, no MSAA | M09b | `canvas.presents` | covered |
| §8 resize and DPR: observer records, next rAF applies and renders, clamp to max texture size | M09b | `viewport.resize_renders_same_frame`, `viewport.dpr_change`, `viewport.clamped_to_limit` | covered |
| §8 render scale default `min(DPR, 2)`, per-game config | M09b | `viewport.render_scale_caps_at_2` | covered |
| §8 backgrounding: stop rAF on hidden, reset clock and re-base interpolation on visible | M09b, M30 | `lifecycle.hidden_stops_visible_rebases`, `rebase-on-visible` | covered |
| §8 device loss: rebuild device, pipelines, art, re-enqueue resident chunks; camera, input, overlay, sim never stop | M37b | `device loss recovers`, `upload.requeue_all_marks_every_resident_chunk_once`, `device loss: uploads stay under the frame budget` | covered |
| §8 null adapter or two losses in the interval raise fatal `rendererLost`; tested with a test flag | M37b, M37 | `two losses raise rendererLost`, `null adapter raises rendererLost`, `no recovery attempt after rendererLost` | covered |
| §9 frame-time shares; desktop proxy asserted as a slow-tier benchmark | M17b, M36 | `bench.frame_worstcase` criterion "meets the desktop proxy of 0018 §9"; `bench.frame_reference` | covered |
| §9 phone numbers checked by hand | M09b, M39 | device check `M09b-fill-rate`; M09b criterion "device-checks section matches" | covered |
| Consequences: zero-GC harness shape run by hand in Safari and Firefox | M17b | device checks `M17b-harness-desktop-safari`, `-firefox`; M17b criterion on device-checks section | covered |
| Consequences: terrain fill-rate on real phones, with ordered fallbacks | M09b, M18 | device checks `M09b-fill-rate`, `M18-fill-rate-with-anchors`; `ClientOptions.render.scaleCap`, `neighbourCutoffPx` exist for the fallbacks | covered |
| Consequences: exact WGSL, manifest schema, upload-ring layout settled in Phase 2 | M09 | `wgsl.terrain_validates`, `manifest.schema_errors`, `upload.record_layout_golden` | covered |

## ADR 0019: Camera, input, picking, overlay

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| §1 camera is main-thread TS state, integrated once per rAF, time-based | M11 | `camera.inertia_decay_time_based`, `camera.pan_keeps_world_point` | covered |
| §1 camera block: seqlock SAB record written once per rAF, read by the client worker, nothing posted | M06, M06b, M11 | `camera_block.roundtrip`, `workers.camera_block_reaches_wasm`, `camera.block_reaches_worker_each_frame` | covered |
| §1 camera saved to `localStorage` at rest and on `visibilitychange`, restored at start | M11 | `camera.persisted_and_restored` | covered |
| §1 `client.camera.setConstraints / moveTo / read / worldToScreen / screenToWorld` | M11 | `camera.zoom_clamps_and_constraints`, `camera.moveto_cancelled_by_input`, `transform.roundtrip` | covered |
| §1 camera controls clamped to the host's view clamp from `Welcome` | M28 (calls M11 `setViewClamp`) | `handshake/welcome-view-clamp-limits-zoom` | covered |
| §1 follow target via `cx.follow`, centred in the frame that draws that list; pan ignored, zoom works | M18 | `follow.centres_in_same_frame_pan_ignored_zoom_works`, `framecx.follow_written_to_header` | covered |
| §2 camera report derived from the block, never a main-thread message | M15, M15b | `pan_changes_subscription`; M06b criterion `grep -n postMessage` shows lifecycle only | covered |
| §2 reporting stops while the tab is hidden; subscriptions stay as last reported | M15b | `hidden_tab_sends_no_camera_report` (M15b Scope "Hidden tab") | covered |
| §3 Pointer Events on the canvas only, two fixed slots, never `getCoalescedEvents` | M11 | criterion "Source scan: no `getCoalescedEvents`, no listener outside the canvas"; zero-GC page `input` | covered |
| §3 `setPointerCapture` on `pointerdown` (drag survives passing under a widget, §4) | M11 | `input.drag_survives_passing_under_widget` (M11 Scope: `input/pointers.ts`) | covered |
| §3 one-pointer pan, two-pointer pan + zoom about midpoint | M11 | `camera.pan_keeps_world_point`, `camera.pinch_about_midpoint` | covered |
| §3 wheel zoom about cursor, `deltaMode` and `ctrlKey` scaling, 100 ms notch easing | M11 | `camera.wheel_about_cursor` (constants in Planning decisions) | covered |
| §3 macOS Safari trackpad pinch through `gesturechange.scale` | M11 | `camera.gesturechange_scale_zooms_about_cursor`; device check `M11-pinch-desktop-safari` | covered |
| §3 inertia from an 80 ms sample ring, exponential decay, cancelled by `pointerdown` | M11 | `camera.inertia_decay_time_based`; device check `M11-gestures` (flick) | covered |
| §3 WASD by `event.code`, speed proportional to extent, ramp | M11 | `camera.wasd_speed_scales_with_extent` | covered |
| §3 canvas CSS, non-passive listeners with `preventDefault`, page-CSS helper against pull-to-refresh | M11, M20 | device check `M11-gestures` (pull down from top edge, double-tap); `installPageStyles` in Scope | covered |
| §4 semantic events `tap`, `hover`, `longpress` with thresholds | M11 | `semantic.tap_vs_drag_thresholds`, `semantic.longpress`, `semantic.hover_only_on_change` | covered |
| §4 tool mode: `setMode('tool')` gives `dragstart/drag/dragend`, two-finger pan still works | M11 | `semantic.tool_mode_drag_events` | covered |
| §4 events as fixed records in a SAB ring drained by client Rust, and to `client.input.on` with one reused object | M11, M18 | `input.record_layout_golden`, `input.decode_record_golden`, `input.events_reach_wasm`, `framecx.tap_visible_in_frame` | covered |
| §4 picking: tiles by arithmetic; entities by scanning the newest DrawList slot front to back; hover at most once per rAF | M18 | `pick.contains_per_kind`, `pick.front_to_back_order`, `pick.skips_zero_id_and_cursor_anchored`, `pick.hover_once_per_raf_on_change`, `pick.matches_interpolated_frame_on_screen` | covered |
| §4 cursor tile in camera block and uniform; ghost with `ANCHOR_CURSOR_TILE`; touch tap-then-confirm | M17, M18, M33 | `draw.ghost_follows_cursor_same_frame`, `ghost.mouse_tracks_cursor_tile`, `ghost.touch_tap_then_confirm`, `reference_place_touch` | covered |
| §4 input over DOM UI: overlay root `pointer-events: none`, widgets opt in, engine listens nowhere else | M11, M18 | `input.widget_blocks_canvas`, `overlay.widget_click_not_a_tap` | covered |
| §4 keyboard focus rules; state cleared on `blur`, `visibilitychange`, `pointercancel`; `suspend/resume` | M11 | `input.keyboard_focus_rules`, `input.suspend_resume` | covered |
| §5 `overlay.anchor` and `anchorSlot` (64 slots) API | M18 | `overlay.anchor_tracks_world_point`, `overlay.slot_anchor_follows_rust`, `drawlist.anchor_table_and_mask` | covered |
| §5 at most two property writes per frame on one layer; idle writes nothing; same rAF as the GPU submit | M18 | `overlay.pan_one_write_zoom_two`, `overlay.idle_writes_nothing` | covered |
| §5 origin re-based beyond 50,000 CSS px; off-screen anchors hidden on transitions only | M18 | `overlay.rebase_beyond_50000px`, `overlay.offscreen_hidden_on_transition_only`, `overlay.rebase_math` | covered |
| §5 no layout reads in overlay or input code | M18 | criterion "Source scan: no `getBoundingClientRect`, `offsetWidth`" | covered |
| §6 collect-button fill is a one-shot CSS animation, zero per-frame JS | M16b, M20b | `progress_from_done_at_and_clock`; M20b zero-allocation criterion with two buttons mounted | covered |
| Consequences: overlay string allocation budgeted as a separate line | M18 | criterion "`gc.pages.anchors` with the constant in its `formula`" | covered |
| Consequences: anchoring on iOS Safari by device check; per-anchor translate fallback | M18 | device check `M18-anchors`; `overlay.translate_mode_equivalent` | covered |
| Consequences: input-ring layout, easing and wheel constants, `FrameCx` shape settled in Phase 2 | M11, M18 | `input.record_layout_golden`, `framecx.input_slice_order_and_clear` | covered |

## ADR 0020: Testing strategy

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| §1 cargo-nextest with fast/slow `default-filter` profiles | M01 | criterion "`cargo nextest --version` reports the pin"; `pnpm test rust -t runner_negative_control` | covered |
| §1 Vitest in Node mode for TS and Node-hosted suites | M01, M02 | `pnpm test` prints `unit`; `pnpm test wasm` passes | covered |
| §1 `@playwright/test`, `channel: 'chromium'`, raw CDP sessions | M03, M04 | `pnpm test browser` passes; `gc-loop clean` (CDP) | covered |
| §1 `playwright-cli` skill for exploratory looks; DevTools MCP only on demand | M03 | `run-tests` skill text (criterion: skill exists and commands were run) | covered |
| §1 all tools dev-only; package keeps zero runtime dependencies | M35b, M35 | criterion "`packages/engine` still has zero `dependencies`"; pack list criterion | covered |
| §2 `pnpm test [suite] [-t]`: one line per suite, failure blocks only, artefacts under `test-results/`, exit codes | M01 | criteria on two stdout lines, `--self-check-fail`, `pnpm test nosuch` exits 2 | covered |
| §2 over budget warns, over 1.5x fails | M01 | `classifyBudget` unit test; criterion `--budget-scale 0.000001` fails both suites | covered |
| §2 `pnpm test:slow` same contract; every test addressable by name | M01, M36 | M01 criterion `pnpm test:slow` exits 0; M36 criterion one line per suite | covered |
| §2 `pnpm lint` quiet, separate; no-compile subset gates commits | M01 | criteria "`pnpm lint` prints four `pass` lines" and the hook-by-pipe criterion | covered |
| §3 five suites with per-suite budgets | M01, M03, M27, M36b | M03 "runs five suites in parallel"; M27 "`pnpm test netcode` passes within the 0020 §3 budget"; M36b `pnpm test:timings` | covered |
| §3 compile budget: 30 s from a one-line Rust edit to tests starting | M02, M36b | M02 "Rebuild time ... recorded"; M36b "`pnpm measure:rebuild` ... meet the compile budget" | covered |
| §3 browser tests step frames, never real rAF pacing | M03 | `stepping.spec.ts` (1,000 `stepTick()` in one task); `manual clock: frame runs callbacks once` | covered |
| §4 demotion rule, p95 limits, `slow` tag mechanism | M01, M36b | M01 `@slow` and `slow_` filters; M36b criterion "no fast test over the 0020 §4 p95 limits ... no feature lost its only fast test" | covered |
| §5 checkpointed golden hashes natively, under Node and Bun, and in three browsers | M02, M03 | M02 "identical natively, under Node and under Bun"; `determinism.spec.ts @engines`; first divergent checkpoint named | covered |
| §5 reference-game log replayed in every runtime | M34b | `reference_golden_replay`, `golden_replay`, determinism page run with the reference log | covered |
| §5 goldens regenerated only by an explicit command from the `.wasm` run | M02, M12b | M02 "`pnpm golden hash` rewrites an identical `golden.json`"; M12b criterion on switching to `.wasm`-blessed goldens | covered |
| §5 worldgen golden hashes raw tile bytes and float bits | M08, M20 | `noise_raw_bits_golden`, `fixtures/worldgen/golden.json` criterion, `worldgen_golden` | covered |
| §5 slow tier: heavy mode at N = 1 | M22, M22b, M36 | `heavy_mode_fixture_n1`, `heavy_wasm_n1`, `heavy-n1 all logs` | covered |
| §5 dev builds check every chunk hash every frame | M31b | criterion "every pre-existing netcode scenario passes with `hashAll: true`" | covered |
| §6 local real adapter headless; every GPU test records `adapter.info`, fails on null adapter | M09 | criterion "every GPU test records `adapter.info` and fails on a null adapter" | covered |
| §6 Linux CI on SwiftShader with the flag set | M10 | criterion "non-null adapter with its `adapter.info` on every GPU test" on `ubuntu-latest` | covered |
| §6 one WebKit readback scene in the slow tier; Firefox sim hash only | M09, M36, M03 | `terrain.probe_tile_colours` `@slow` on WebKit; `webkit-readback`; `determinism @engines` | covered |
| §6 layer (a): DrawList bytes hashed exactly, no GPU | M17, M20b, M33 | `drawlist.fixture_hash_golden`, `extract_hash_player_circle`, `extract_hash_ghost_and_furnace` | covered |
| §6 layer (b): offscreen target readback, semantic pixel probes are the gate | M09 | `terrain.probe_tile_colours`, `terrain.nothing_outside_viewport`; `renderTo`/`readPixels` | covered |
| §6 pixel goldens secondary with stated tolerances | none | no brief adds a pixel golden; tolerance applies only if one is added | n/a |
| §6 layer (c): one canvas-presentation smoke test | M09b | `canvas.presents` | covered |
| §6 page screenshots never used for pixel assertions | M09 | constraint; recorded in `packages/engine/CLAUDE.md` | n/a |
| §6 every browser test fails on `uncapturederror`, device loss, non-empty compilation info | M09, M37b | M09 criterion; M37b "`loseDevice` without `allowDeviceLoss` turns a test red" | covered |
| §6 per-adapter-class golden rather than wider tolerance | M10 | M10 Scope "only if needed"; conditional | n/a |
| §7 netcode harness: real server entrypoint, real `.wasm`, K headless clients over `Connection` | M27 | `join-converges`, `harness-accepts-build-dir`, `headless-ui-and-camera` | covered |
| §7 in-memory pair and real `ws` on loopback | M27, M29 | `memory-connection`; `ws/join-converges`, `ws/reconnect-resume` | covered |
| §7 seeded conditioner, stall model, latest-wins drops, virtual clock total order | M27 | `conditioned-link` (identical `trace()` twice), `latest-wins-datagrams`, `virtual-clock`, `conditioner` | covered |
| §7 failures print the seed and dump the action log | M27, M28b | M28b criterion "each reproducible from its printed seed"; netcode `CLAUDE.md` "seed always printed" | covered |
| §7 assertions: replica hash = host region hash, bounded mispredictions, bytes per tick, reconnect, late join, version mismatch | M27, M28, M28b, M34c | `join-converges` (`assertConverged`), `late-join`, `counters-exact`, `handshake/version-mismatch`, `reconnect/*`, `reference_bytes_and_mispredictions_in_budget` | covered |
| §7 one Playwright test with two pages against a real server | M29 | `mp/two-pages` | covered |
| §8 `test` entrypoint absent from production bundles | M03, M22b, M35 | M03 criterion `grep -r "test/" ... dist`; M22b "production entrypoints do not import them"; `exports-map` | covered |
| §8 one injectable `Clock`/`Scheduler`; no ambient time outside it | M03, M13 | `manual clock: *`; M03 criterion "Adding `Date.now()` ... makes `pnpm lint` fail"; M13 criterion | covered |
| §8 `stepTick()` on the host and `stepFrame(dt)` on the client | M03, M06b, M13 | `stepping.spec.ts`, `sim_worker_steps_and_hashes`, page `topology` (600 stepped frames) | covered |
| §8 awaitable cross-thread quiescence (sequence/ack counters) | M03, M06b | `untilQuiescent()` assertion in `stepping.spec.ts`; `workers.park_resume` | covered |
| §8 caller-supplied render target | M09 | `renderTo(client, ...)` used by every `terrain.*` readback test | covered |
| §8 whole-world and per-region state hashes at any tick | M13, M15, M31b | `sim_worker_steps_and_hashes`, `replica_hash_equals_host_region_hash`, `integrity/*` | covered |
| §8 every seed a parameter | M02, M27 | scenario `golden/scenario.json` fixed seed; `createNetHarness({ seed })`, `seed_reproducible` | covered |
| §8 input injected as engine-level events; one or two tests on the real DOM path | M11 | `injectPointer/Wheel/Key` used by page `input`; `input.dom_path_pan_and_tap` | covered |
| §8 deterministic counters | M09, M15, M27 | `terrain.upload_budget_while_panning`, `counters-exact`, `assertBudget` rows | covered |
| §8 negative-control allocation hook | M04 | `gc-loop neg *`; criterion "every negative control's verdict matches 0016 §3.8" | covered |
| §8 engine tests use fixture games, one per feature | M02, M12b | README rule; M12b `packages/engine/fixtures/CLAUDE.md`; no criterion needed | n/a |
| §8 reference game adds the scripted coverage of 0003 | M34b, M34c | criteria that every row of the `reference-game.md` table of `coverage.md` and of `reference-coverage.md` §1 names a test that exists | covered |
| §9 `packages/engine/budgets.json`, exact counters with ceilings | M04, M09, M15, M31 | M04 lands the file; M09 and M31 criteria name rows in it | covered |
| §9 budgets file outside the package `files` | M35 | criterion "`pack --json` lists only `dist/**`, `crates/**`, `package.json`" | covered |
| §9 counter classes: net bytes/messages, JS bytes per isolate, draws, upload bytes, pipeline switches, WASM high-water | M09, M17, M31, M36 | `render.uploadBytesPerFrame`, `render.drawCallsMax`, `render.pipelineSwitches`, `net.*`, `gc.pages.*`, `mem.simHighWaterLargeSave` | covered |
| §9 raising a budget number is a reviewed change | M31 | process rule in netcode `CLAUDE.md` and `gc-test` skill | n/a |
| §9 slow tier wall clock against a checked-in baseline, 25 % threshold, gating on Tyler's Mac only | M36 | `bench-gate: threshold and fingerprint`; criterion "gate fails when a sample is pushed 30 % over baseline ... only records under another fingerprint" | covered |
| §9 browser frame time from a CDP trace with real rAF | M17b, M36 | `bench.frame_worstcase`, `bench.frame_reference` | covered |
| §9 standard large save: entity, tile, timer and player counts from a seeded bench-only builder | M36 | `large_save_builder_is_deterministic`; criterion "builder's native test proves the §9 counts and determinism" | covered |
| §9 tick benchmark reports median and p99 of 1,200 ticks after 200 warm-up | M36 | `slow_tick_large_save` criterion "meets the 0010 desktop proxy" | covered |
| §10 GitHub Actions on `ubuntu-latest`, fast and slow tiers, caches, timings recorded never gating | M10 | criteria on the green run URL and "a deliberately slow suite does not fail the job" | covered |
| §10 real-GPU rendering and timing only on Tyler's Mac | M36 | bench gate fingerprint unit test | covered |
| §10 iOS Safari manual checklist before a milestone is called done | M03 to M39 | `device-checks.md`; M39 criterion "every entry re-run on the final build and ticked" | covered |
| §10 runner exports `DEVELOPER_DIR` on macOS when unset | M01 | `toolEnv: sets DEVELOPER_DIR on darwin only when unset` (M01 exit names it) | covered |
| Consequences: spike B with the first CI workflow | M10 | criterion "Spike B findings ... are under Deviations" | covered |
| Consequences: spike C, byte-identical traces over loopback `ws` | M29 | `ws/trace-identical`, slow `ws/spike-c` | covered |
| Consequences: measure rebuild and suite numbers; sccache vs shared target dir | M02, M36b | M36b criterion "Fresh-worktree and cached-CI build times are in the ADR with the decision" | covered |


## ADR 0021: context architecture

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| §1 nested `CLAUDE.md` per package and crate, created with the package, ~60-line cap | M01; later files per the artifacts table | M01 exit "both nested `CLAUDE.md` files ... exist"; `context-artifacts` (`unit`, permanent, M01): every nested `CLAUDE.md` is at most 60 lines, so each later file listed under a brief's Context artifacts is checked through `pnpm test` | covered |
| §1 path-scoped rule files `hot-paths.md` and `determinism.md`, created with the first code they govern, globs from the real layout | M02 (creates), M05, M06 | M05 exit "`determinism.md` names `Codec` ... under 40 lines"; M06 exit "`hot-paths.md` globs cover `src/sab/**` and `src/camera/**`" | covered |
| §1 root `CLAUDE.md` names each global invariant in one line and links its rule file | M02 (both lines; M25 adds the prediction line) | M02 exit "Root `CLAUDE.md` has one line each ..."; `context-artifacts` fails when root `CLAUDE.md` does not name a rule file | covered |
| §1 no rule file without `paths:` | M01 (test), M02, M25 | `context-artifacts` | covered |
| §2 no `@path` import in root `CLAUDE.md` | M01, M39b | M01 exit "root `CLAUDE.md` is within its line cap and has no `@` import" | covered |
| §2 nested `CLAUDE.md` imports only a short file of its own package | none | constraint, nothing to build | n/a |
| §3 sub-agents briefed with files | M39, M39b (Scope: "briefed per 0021 §3") | constraint on how sessions delegate | n/a |
| §4 skills written when the procedure is real, by the session that ran it, wrapping a command | M03, M04, M16, M17b | exit criteria "commands were each run once in this session" (M03, M04), "was followed once" (M16), "its command was run" (M17b) | covered |
| §4 table: five expected skills, each an exit criterion of its milestone | M01, M03, M04, M16, M17b | see artifacts table | covered |
| §5 no custom sub-agent definitions | M34c (note only) | constraint | n/a |
| §6 one `PreToolUse` hook on `git commit`: script re-checks the command, format and lint only, exit 2 with the fix command | M01 | exit "Hook, by pipe ..."; `scripts/lib/pre-commit-check.test.mjs` | covered |
| §6 hook cost target (under 3 s), `timeout: 30` | M01 | exit "wall time under the 0021 §6 target"; "`.claude/settings.json` parses, matches 0021 §6–7" | covered |
| §6 tests, `tsc`, clippy and builds stay out of the hook, enforced by `pnpm test` / `pnpm lint` exit criteria | every milestone | last exit criterion of every brief; M01 `pre-commit-check.test.mjs` ("without running any tool") | covered |
| §6 triggers to extend or remove the gate | none | future trigger, nothing to build | n/a |
| §7 permission allowlist and deny list in checked-in `.claude/settings.json` | M01 | exit "`.claude/settings.json` parses, matches 0021 §6–7, and `claude` starts ... without a settings warning" | covered |
| §7 machine-specific entries in `settings.local.json` | none | constraint | n/a |
| §8 `PROMPT.md` status block overwritten, never appended; nothing in auto memory | process (`docs/process.md`), M39b | M39b exit "`PROMPT.md` is the Phase 4 prompt"; the per-session status block is a process rule | n/a |
| §8 per-milestone state in `PLAN.md` and the brief's Deviations | M16, M39, M39b | M16 exit "PLAN.md marks the vertical slice complete"; M39 exit "every `PLAN.md` row is ticked or has a recorded deviation"; M39b exit "`PLAN.md` is fully ticked" | covered |
| Consequences: root `CLAUDE.md` stays a map under its cap through Phase 4 | M01, M39b | M01 exit (line cap); M39b exit "`CLAUDE.md`'s map matches the files that exist and is within its line cap" | covered |
| Consequences: briefs list the rule files that apply | Phase 2 (brief template, `docs/plan/README.md`) | planning artifact, 53 of 60 briefs carry the line | n/a |
| Consequences: rule globs follow the layout (update `paths:` in the same commit) | M06, M07, M08b, M12, M20, M22, M29 | `context-artifacts` (every `paths:` glob matches at least one file; M06 no longer lists globs for directories that do not exist yet); M06 exit on globs | covered |
| Consequences: settings, hook and `write-adr` in the first milestone; every other skill and rule attached to a milestone | M01 and the artifacts table | M01 exit criteria | covered |
| Consequences: the hook script is small code with no dependencies | M01 | `scripts/lib/pre-commit-check.test.mjs` | covered |


## ADR 0022: Entity ids and provisional ids

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| §1 real ids host-allocated from `next_entity_id`, from 1, monotonic, never reused, bit 31 clear | M12 | `entity_id_policy_*` | covered |
| §1 ids in `spawn` call order so replay reproduces them | M12b, M21b | `replay_equals_live`, `replay_equals_live_with_timers` | covered |
| §2 state-budget check rejects `StateBudgetFull` when too few ids remain | M21 | `id_exhaustion_rejects_state_budget_full` | covered |
| §2 tick-rule `spawn` with no id left is an engine fault | M21b | `tick_spawn_without_ids_is_engine_fault` | covered |
| §3 one ordered map keyed by id; layout is not state | M12 | criterion "`grep -r "HashMap" crates/engine/src/store*` is empty"; `store_roundtrip_bytes_equal` | covered |
| §3 revisit trigger is the large-save tick benchmark | M36 | `slow_tick_large_save` | covered |
| §4 hashed and snapshotted: `next_entity_id` then entities in ascending id order | M12, M22 | `store_hash_ignores_insertion_order`, `store_golden_bytes`, `persist_snapshot_golden_bytes` | covered |
| §4 per-chunk hash takes anchored entities in id order | M31b | `integrity/clean-session-no-reports`, `integrity/corrupt-chunk-heals` | covered |
| §4 ids on the wire as varints | M14 | `golden_chunk_deltas` | covered |
| §5 provisional ids: bit 31, derived from `seq` and spawn index, stable across replays | M25 | `provisional_id_stable_across_replays` | covered |
| §5 `Deserialize` refuses bit 31; never encoded, sent, logged or hashed | M25, M16 | `provisional_id_rejected_by_deserialize` (JSON and postcard), `malformed_action_is_protocol_error` | covered |
| §6 actions address predicted things by tile; `entity_at` resolves under both authorities | M25, M33b | `dependent_actions_replay_across_ack`, `deposit_into_predicted_furnace_before_ack` | covered |
| §6 no id map in `Confirmed`; client state keyed by anchor tile survives the swap | M26, M33b | `swap_is_one_render`, `reference_furnace_panel_survives_swap` | covered |
| §7 `entity(id)` on a client: `Unknown`, `Ok(None)` for provisional and tombstone | M25 | `entity_id_gone_vs_unsubscribed` (four cases) | covered |
| Consequences: game-author rule "name buildings by tile" in the skill | M25 | M01 `context-artifacts` (the brief lists the skill step under Context artifacts; ruling: no per-brief criterion) | covered |

## ADR 0023: Action growth declaration

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| `Game::growth` provided hook and `Growth` type | M21 | `full_world_rejects_place_accepts_remove_then_place` | covered |
| Check: declared growth rejects only when it exceeds free counts; `NONE` always passes | M21 | `full_world_rejects_place_accepts_remove_then_place` | covered |
| Check: undeclared actions use `max_action_growth` | M21 | `undeclared_action_uses_max_action_growth` | covered |
| Check is host only, before `apply`; never for `on_player`, `genesis`, `migrate`, tick rules or a predicting client | M21, M21b, M24b, M25 | `full_world_still_accepts_join` (M21), `tick_rule_put_past_limit_is_applied` (M21b); `migrate`: M24b Planning decision 4; predicting client: M25 Non-scope | covered |
| Id exhaustion uses the same declared number | M21 | `id_exhaustion_rejects_state_budget_full` (a `Growth::NONE` action passes with no ids left) | covered |
| Declaration above `max_action_growth` is a `debug_assert!` | M21 | `over_max_declaration_panics_in_debug` | covered |
| Audit: debug and test builds panic on under-declaration | M21 | `under_declared_growth_panics_in_debug`, `growth_declarations_are_honest` | covered |
| Audit: release builds keep writes, bump `growth_violations`, warn | M21 | `under_declared_growth_counts_in_release` | covered |
| Determinism: verdict replays exactly and stays in the log | M21 | `budget_verdict_replays_identically` | covered |
| Reference game declares `PlaceFurnace` = one entity, others `NONE` | M33, M33b, M34b | `reference_state_budget_full`, `reference_state_budget_full_shows_reason` | covered |
| Consequences: second half of the scripted "state budget when full" test | M21, M34b | `full_world_rejects_place_accepts_remove_then_place` | covered |
| Consequences: `add-action-type` skill gains the `growth` step | M21 | M01 `context-artifacts` (the brief lists the skill step under Context artifacts; ruling: no per-brief criterion) | covered |

## ADR 0024: Planning amendments

| Decision (ADR §, few identifying words) | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| §1 `sim_seal_frame` then log sink then `sim_tick` | M13, M16, M22 | `simhost_seal_precedes_tick`, `host_applies_only_sealed_records`, `write_ahead_order` | covered |
| §1 streamed snapshot exports `sim_snapshot_begin/next` | M22 | `persist_snapshot_golden_bytes`, `snapshot_roundtrip_random_blocks`; criterion "ABI registry test includes the four new exports" | covered |
| §2 truncation by `write(logKey, validPrefix)`; adapters accept `append` after `write` | M22, M22b, M23 | `storage_conformance_memory/fs/opfs`, `crash_mid_frame_truncates_and_resumes` | covered |
| §2 segment rolls at 4 MiB when a periodic snapshot is written | M22b | `segment_rolls_at_snapshot_over_limit`, `prune_keeps_bases_and_latest_two` | covered |
| §3a `SCHEMA_VERSION` also covers `G::Action` layout | M24b | M24b Context artifacts now lists the `add-action-type` step and the rustdoc sentence on `Game::SCHEMA_VERSION`; M01 `context-artifacts` (the brief lists them under Context artifacts; ruling: no per-brief criterion) | covered |
| §3b tail re-executed only on equal `SCHEMA_VERSION`, else dropped and counted | M24b | `schema_bump_runs_migrate`, `rules_only_change_direct_load_new_segment` | covered |
| §3c undecodable tail record dropped, counted, warned | M24b | `undecodable_tail_action_is_dropped_and_counted` | covered |
| §4 probe OPFS `move()`; slot-file fallback | M23 | criterion "Decision 3 outcome recorded"; `storage_conformance_opfs` in three engines | covered |
| §5 `createWorldServer` returns `{ ready, accept, stop }`; `ready` rejects with `WorldLoadError` | M27 | criterion "return type and `HostServices.onFatal?` match 0024 §5"; `server/ready-rejects-on-corrupt-world`, `server/accept-before-ready-waits` | covered |
| §5 `HostServices.onFatal`; server stops ticking, closes sockets, touches no file | M24, M27, M37 | `panic_in_tick_is_fatal_and_files_untouched`, `fatal: server onFatal stops world and closes sockets` | covered |
| §5 decimal seed converted once to `HexU64` in `createSimHost` | M13 | `simhost_seed_decimal_to_hex_u64` | covered |
| §6 `Presence: Default`; 32-byte limit per encoded sample, oversize dropped and counted | M19 | `oversize_dropped`; `impl Presence for ()` compiles | covered |
| §7a required `Game::anchor`, scope and occupancy routed by it | M12, M12b, M21 | `every_put_is_one_delta_with_scope`, `footprint_sets_every_overlapped_chunk` | covered |
| §7b puts through `Authority` outside `G::tick` queue a wake; queue is sim state | M21b | `put_from_apply_wakes_same_tick`, `put_from_tick_does_not_self_wake`, `wake_dedup_and_order`, `timers_survive_encode_decode` | covered |
| §7c `client.input.emit` writes a kind-7 record, not dropped on overflow | M18, M33 | `framecx.emit_visible_in_frame`, `input.game_record_round_trip`, `input.game_record_survives_overflow` | covered |
| §7d `FrameCx::ui_dirty()` re-runs `ui`; `PartialEq` gate unchanged | M16b, M18, M20b | `ui_reruns_when_dirty_flag_set`, `framecx.ui_dirty_reruns_ui`, `ui_unchanged_value_writes_nothing` | covered |
| §8 `Delta::Roster` engine-only variant | M12, M14, M34 | `golden_global_and_own_player`, `reference_roster_follows_join_grace_and_return` | covered |
| §8 third action result `Lost`, client-side only | M28b | `reconnect/lost-ack-reports-lost` | covered |
| §8 second `Welcome` on an open connection is the resync signal | M28b | `reconnect/panic-recovery-resync` | covered |
| §8 `ResyncChunk` reserved coordinate for `Global`/`Player` mismatch | M31b | `integrity/global-mismatch-heals`, `integrity/golden-resync-chunk` | covered |
| §8 handshake magic's first wire byte is at least `0x80` | M14, M28 | `session/golden-hello`, `golden-reject`, `handshake/garbage-before-hello` | covered |
| §9 runtime `ChunkDims`; sizes 4, 5, 6 tested natively | M07 | criterion "pass by name at `CHUNK_BITS` 4, 5 and 6"; `dims_reject_unsupported_bits` | covered |
| §9 browser topology asserts `CHUNK_BITS = 5` with a readable fatal | M08b, M09 | `gen: oversize slab is a readable fatal` (M08b); M09's own init assertion has no test | covered |
| §10 one `W_WAKE` per consumer thread; no lost wake-up | M06 | `control.no_lost_wakeup` | covered |
| §11 DrawList slot header is 1,024 B with the anchor table | M06, M17, M18 | `layout.sab_total_under_budget`, `drawlist.layer_counts_and_prefix`, `drawlist.anchor_table_and_mask` | covered |
| §11 sprite table as two `rgba32float` data textures | M17b | `sprite.pivot_and_size_probe`, `wgsl.uberquad_validates` | covered |
| §12 both CDP transports behind `IsolateSession`; parity test | M04 | `gc: flat transport parity`; criterion `pnpm gc software` | covered |
| §12 byte budgets per page with a `formula` string | M04, M09, M17 | `budgets: every gc page lists main`; M09 and M17 `budgets.json` criteria | covered |
| §13 profiles kept verbatim; dev profile does not set `panic = "abort"`; dev `.wasm` panic still traps | M01, M02 | `loader: panic marks instance dead with message`; M12b `#[should_panic]` twin proves native unwinding | covered |
| §14 record-only WASM twin of the tick benchmark | M36 | `tick-large-save node @slow` under Provides; criterion "`pnpm test:slow` runs every slow test" | covered |
| §15 measure `extrapolation_ratio`; above 0.2 a new ADR supersedes the 0010 row | M30 | criterion "`extrapolation_ratio` and its verdict are written under Deviations" | covered |


## Context artifacts (ADR 0021)

| Artifact | Created by | Exit criterion or test | Status |
|---|---|---|---|
| `.claude/settings.json` | M01 | exit "`.claude/settings.json` parses, matches 0021 §6–7" | covered |
| `.claude/hooks/pre-commit-check.sh` | M01 | exit "Hook, by pipe ..."; `pre-commit-check.test.mjs` | covered |
| skill `write-adr` | M01 | exit "`write-adr` skill ... exist"; used by M21b exit (journal ADR "numbered by the `write-adr` skill") | covered |
| skill `run-tests` | M03 (extended M09, M10, M27, M31b, M34b, M35, M36, M36b) | M03 exit "`.claude/skills/run-tests/SKILL.md` exists and its commands were each run once" | covered |
| skill `gc-test` | M04 (extended M06b, M23, M29) | M04 exit "`.claude/skills/gc-test/SKILL.md` exists; its commands were each run once" | covered |
| skill `add-action-type` | M16 (extended M16b, M21, M25, M26; 0024 Consequences adds a line) | M16 exit "`add-action-type/SKILL.md` exists and was followed once" | covered |
| skill `profile-frame` | M17b (extended M36) | M17b exit "`profile-frame/SKILL.md` exists and its command was run" | covered |
| skill `device-check` | M39b | M39b exit "`device-check/SKILL.md` exists and contains every entry" | covered |
| skill `bump-schema` (conditional, not named by 0021) | M24b, only if the procedure is performed | none; optional by 0021 §4 | n/a |
| rule `.claude/rules/determinism.md` | M02 (globs extended M12, M20, M22) | M02 has no criterion; M05 exit "`determinism.md` names `Codec`, `ByteSink` and `decode_canonical` and is under 40 lines" | covered |
| rule `.claude/rules/hot-paths.md` | M02 (extended M04, M06, M07, M08b, M29) | M02 has no criterion; M06 exit "`hot-paths.md` globs cover ..." | covered |
| rule `.claude/rules/prediction.md` | M25 (extended M26) | M01 `context-artifacts` (the brief lists the file under Context artifacts; ruling: no per-brief criterion); the test also requires `paths:` and matching globs | covered |
| root `CLAUDE.md`: commands line, map rows, alias caution | M01, M39b | M01 exit (map update, cap, no import); M39b exit (map matches files) | covered |
| root `CLAUDE.md`: one line per global invariant linking `determinism.md`, `hot-paths.md` (0021 §1) | M02 | M02 exit; `context-artifacts` (M01) | covered |
| `packages/engine/CLAUDE.md` | M01 (updated by most engine milestones) | M01 exit "both nested `CLAUDE.md` files" | covered |
| `packages/engine/crates/engine/CLAUDE.md` | M01 | M01 exit, same criterion | covered |
| `packages/engine/fixtures/worldgen/CLAUDE.md` | M08 | `context-artifacts` (M01) through `pnpm test`; listed under M08 Context artifacts | covered |
| `packages/engine/fixtures/CLAUDE.md` | M12b (line added M21b) | `context-artifacts` (M01) through `pnpm test`; listed under M12b Context artifacts | covered |
| `packages/engine/src/CLAUDE.md` | M13 (updated M15b, M16) | `context-artifacts` (M01) through `pnpm test`; listed under M13 Context artifacts | covered |
| `packages/engine/crates/engine/src/wire/CLAUDE.md` | M14 | `context-artifacts` (M01) through `pnpm test`; listed under M14 Context artifacts (its own cap is 30 lines) | covered |
| `games/reference/CLAUDE.md` | M20 (updated M20b, M32–M34c, M36, M37) | M01 `context-artifacts` (the brief lists the file under Context artifacts; ruling: no per-brief criterion) | covered |
| `packages/engine/crates/engine/src/persist/CLAUDE.md` | M22 (updated M22b, M24b) | M01 `context-artifacts` (the brief lists the file under Context artifacts; ruling: no per-brief criterion) | covered |
| `packages/engine/src/storage/CLAUDE.md` | M22b (extended M23) | M01 `context-artifacts` (the brief lists the file under Context artifacts; ruling: no per-brief criterion) | covered |
| `packages/engine/src/host/CLAUDE.md` | M24 | M01 `context-artifacts` (the brief lists the file under Context artifacts; ruling: no per-brief criterion) | covered |
| `packages/engine/tests/netcode/CLAUDE.md` | M27 (updated M28, M28b, M31, M31b) | M01 `context-artifacts` (the brief lists the file under Context artifacts; ruling: no per-brief criterion) | covered |
| `games/reference-server/CLAUDE.md` | M29 (updated M34, M35b) | M01 `context-artifacts` (the brief lists the file under Context artifacts; ruling: no per-brief criterion) | covered |
| `games/reference-server-do/CLAUDE.md` (conditional on the DO go decision) | M38 | none; exists only if the package stays | n/a |

## Budgets (PRE-PLAN §7)

| Budget row | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| Frame time, phone: main rAF callback share | M09b, M36 (bench HUD), M39 (device) | device check `M39-frame-shares` (`main p95` on M36's bench HUD); M39 exit criterion that the M39 section is run | covered |
| Frame time, phone: GPU share | M09b, M18 | device check `M09b-fill-rate`, `M18-fill-rate-with-anchors` (M09b and M18 exit: device-checks section matches) | covered |
| Frame time, phone: client-worker `frame` share | M36 (bench HUD), M39 (device) | device check `M39-frame-shares` (`frame p95`) | covered |
| Frame time, desktop proxy (main and worker) | M17b, M18, M36, M37b | M17b exit "`pnpm bench:frame` meets the desktop proxy"; `bench.frame_worstcase`; M36 `bench.frame_reference` with baseline | covered |
| Tick time, slowest host: Fly shared-cpu-1x | M38 | M38 exit "Deviations holds the results table ... tick p50/p99 under 8 clients"; verdict in M39 budgets ledger | covered |
| Tick time, slowest host: phone sim worker | M36 (bench HUD), M39 (device) | device check `M39-large-save` (`tick p95` on the bench HUD) | covered |
| Tick time, desktop proxy on the standard large save | M36 (guards: M21b, M33b) | M36 exit "`slow_tick_large_save` meets the 0010 desktop proxy"; `idle_world_visits_zero_entities`, `idle_furnaces_cost_nothing` | covered |
| Chunk generation, per chunk on the phone | M08 | device check `M08-worldgen-ms-per-chunk`, `M08-warn-threshold` | covered |
| Chunk generation, desktop warn threshold | M08, M36 | M08 exit "`pnpm test:slow wasm -t worldgen-bench` prints ms per chunk"; `worldgenMsPerChunkWarn`; M36 `baselines/worldgen.json` | covered |
| Chunk generation, host warmer per tick gap | M13 | `simhost_warmer_respects_budget`, `chunksWarmed` | covered |
| Chunk generation, join at full zoom-out | M08b, M15b | `queue_counts_at_view_bound`, `genJoinChunks` exact; `join_at_max_zoom_out_never_drops` (count asserted; milliseconds follow from the per-chunk rows) | covered |
| GPU upload per frame | M09, M15b, M26, M37b | `terrain.upload_budget_while_panning`; M09 exit `counters["render.uploadBytesPerFrame"]` | covered |
| GPU constant draws | M09, M17 | M09 exit `render.drawCallsTerrain`; M17 exit `render.drawCallsMax`; `counters.draws_equal_nonempty_layers` | covered |
| Bandwidth steady, down | M31, M30, M31b, M34, M34c | M31 exit "every `rates/*` test asserts through `assertBudget`": `rates/steady-busy-field`, `rates/seven-remote-presences`; `presence_bytes_budget`; `integrity/hash-bytes-per-second` | covered |
| Bandwidth steady, up (panning, at rest) | M19, M31, M30 | M19 exit "`uplinkPresenceBytes` ... within the ceiling"; `rates/uplink-panning`, `rates/idle-sends-only-heartbeats`; `resting_player_stays_solid` | covered |
| Bandwidth steady, soft cap for tick frames | M31 | `rates/degrade-on-stall`, `rates/deltas-collapse-to-snapshot` | covered |
| Bandwidth burst, chunk token bucket (refill and burst) | M31 | `rates/bucket-refill-exact`, `rates/join-dense-visible-first`, `rates/join-wilderness` | covered |
| Bandwidth burst, hard ceiling | M31 | `rates/hard-ceiling` | covered |
| Bandwidth burst, megabytes per hour of play | M34c | `reference_bytes_and_mispredictions_in_budget` (projected `net.bytesPerHour` ceiling in `budgets.json`) | covered |
| Bandwidth burst, reconnect cost | M28b | M28b exit "`reconnect/cost` asserts `reconnectBytesUp/Down`" | covered |
| Action rate, sustained and burst | M31 | `rates/action-rate-limited` | covered |
| Log bytes per logged action | M22 | `bytes_per_logged_action`; M22 exit "`budgets.json` has `logBytesPerAction`" | covered |
| Log bytes per active player-hour | M34b | `reference_golden_replay` (projected `logBytesPerPlayerHour` ceiling in `budgets.json`) | covered |
| Memory per instance, arena sizes | M06b, M08b, M17 | `workers.spawn_local` (`W_MEM_PAGES`), `arena.sum_rule`, `start.arena_config_rejected` | covered |
| Memory per instance, mobile ceiling | M11 | device check `M11-memory` | covered |
| Memory per instance, world budget (entities, modified tiles) | M21, M36 | `init_rejects_budget_over_arena`, `full_world_rejects_place_accepts_remove_then_place`; M36 exit "builder's native test proves the §9 counts"; `mem.simHighWaterLargeSave` | covered |
| Memory per instance, dense cache | M07 | `cache_events_report_slots` (exact `memory_bytes()`) | covered |
| Memory, whole tab on the phone | M11, M16, M39 | device checks `M11-memory`, `M16-coexist`, `M39-large-save` | covered |
| Memory, GPU (page, instances, art) | M09, M17b | `counters.gpu_bytes_within_budget` against `counters["render.gpuBytes"]` (M17b exit names the key) | covered |
| Memory, SABs | M06 | `layout.sab_total_under_budget` | covered |
| Download, game `.wasm` | M35 | M35 exit "`pnpm test:slow wasm -t size`"; `size @slow` | covered |
| Download, engine JS | M35 (M35b adapters counted) | `size @slow` | covered |
| Allocation, main per frame | M09, M17, M18 | M17 exit "final `main` number on `gc.pages.drawables`"; M18 exit `gc.pages.anchors` | covered |
| Allocation, client, sim and gen workers per frame | M04, M06b, M08b, M13, M15b, M20b, M25 | M04 exit "`gc-loop clean` passes"; pages `topology`, `echo`; `gc: zero-GC over a scripted pan` | covered |
| Allocation, net worker per message | M29 | `gc/multiplayer-topology`, `gc/net-negative-control` | covered |
| Allocation, zero major GCs | M04, M36 | M04 exit "zero GC events"; M36 `soak-browser` | covered |
| Allocation, zero `memory.grow` | M03, M06b, M08b, M17, M36 | `memGrows()` assertions; M17 exit "no `memory.grow`"; M36 "zero grows in both soaks" | covered |
| Latency, action to authority | M16 | `action_lands_on_next_tick` | covered |
| Latency, interpolation delay (adaptive range, initial) | M30 | `delay_initial_floor_cap`, `delay_follows_p95_formula`, `jitter_profile_adapts` | covered |
| Latency, snapshot cadence | M22, M36 | `snapshot_every_1200_ticks_if_dirty`; M36 exit "snapshot-stall answer ... recorded" | covered |
| Latency, log sync | M22, M23 | `sync_at_most_once_per_second`; M23 in-browser `persistenceCounters()` | covered |
| Dev loop, one-line Rust edit to tests starting | M36b (recorded in M02, M02b, M35) | M36b exit "`pnpm measure:rebuild` reports both medians; they meet the compile budget" | covered |
| Test suite, per-suite budgets | M01, M36b | M01 exit "`pnpm test --budget-scale 0.000001` fails both suites"; M36b exit "`pnpm test:timings` ... every fast suite within its 0020 §3 budget" | covered |
| Test suite, fast tier under one minute warm | M36b, M39 | M36b exit "parallel wall clock is under ... one minute"; M39 exit | covered |
| Hosting cost | M38 | M38 exit "results table: ... projected monthly cost ... Fly always-on and idle cost"; go/no-go ADR | covered |
| All rows: final verdict and permanent record | M39, M39b | M39 exit "`budgets.md` has a verdict for every PRE-PLAN §7 row"; M39b exit (measured-budgets ADR) | covered |

## Engine events (PRE-PLAN §4 TS sketch)

| Event | Milestone(s) | Exit criterion or test | Status |
|---|---|---|---|
| `client.onActionResult` | M16 | `vertical_slice`, `ui_ring_delivers_results_in_order` | covered |
| `client.onUi` | M16b | `onui_gets_only_latest_per_drain`, `onui_fires_before_action_results`, `dom_counter_follows_global` | covered |
| `client.clock()` | M16b, M26 | `clock_returns_same_object`, `progress_from_done_at_and_clock`, `prediction-no-flicker` | covered |
| `client.input.on(...)` semantic events | M11, M18 | `semantic.tap_vs_drag_thresholds`, `semantic.longpress`, `semantic.hover_only_on_change`, `input.dom_path_pan_and_tap`, `pick.tap_reports_entity_pick_id` | covered |
| `SaveIncompatible` | M24b, M34b, M37 | `save_incompatible_rejects_ready_and_export_still_works`; `reference_save_incompatible_leaves_files`; audit `engine event surface` | covered |
| `WorldBusy` | M23, M34b, M37 | `second_tab_gets_world_busy`, `reference_world_busy_second_tab`; audit | covered |
| `durable: false` (`client.onStorage`) | M23, M37 | `no_opfs_falls_back_durable_false`; audit | covered |
| storage estimate (`persisted`, `usage`, `quota`) | M23, M37 | `storage_status_reports_estimate` (M23); M37 audit type-asserts the member | covered |
| `Resyncing` (`client.onResyncing`) | M28b, M37 | `reconnect/panic-recovery-resync`; `trap: client instance recovers and resyncs`; audit | covered |
| `onFatal` (browser) | M24, M37 | `panic_in_tick_is_fatal_and_files_untouched`; `fatal: two client traps`, `fatal: storage error` | covered |
| `onFatal` (server, `HostServices.onFatal?`, 0024 §5) | M27, M37 | M27 exit (type-asserted); `fatal: server onFatal stops world and closes sockets` | covered |
| `rendererLost` | M37b, M37 | `two losses raise rendererLost`, `null adapter raises rendererLost`, `no recovery attempt after rendererLost`; audit | covered |
| version mismatch, reload once, `updating` | M28, M29, M37 | `handshake/version-mismatch`, `ws/version-mismatch`, `mp/version-mismatch-reloads-once`; audit | covered |
| `exportWorld` / `importWorld` | M23, M24b, M34b | `export_import_roundtrip_browser`, `export_works_after_load_failure`, `import_then_upgrade`, `reference_export_import_roundtrip` | covered |
| server `createWorldServer(...)`: `ready`, `accept`, `stop` | M27 | M27 exit (return type matches 0024 §5); `server/load-or-create`, `server/ready-rejects-on-corrupt-world`, `server/accept-before-ready-waits` | covered |
| server `onIdle` | M28b, M29 | `lifecycle/idle-stops-ticks-then-onidle`; `reference-server/smoke` | covered |
| beyond the sketch: `client.onLink` states incl. `superseded` | M29, M37 | `mp/reconnect`, `mp/superseded`; audit | covered |
| beyond the sketch: `EngineFault` and `Lost` action results | M24, M28b | `skipped_action_acked_engine_fault`; `reconnect/lost-ack-reports-lost` | covered |
| beyond the sketch: `client.onDesync` | M31b (report), M37 (surface) | `integrity/corrupt-chunk-heals` (report); `desync: onDesync fires once per report` (M37) | covered |
| beyond the sketch: reconnect indicator delay | M34 (Scope), M29 (device) | device check `M29-play-through-drop`; no automated test | covered |
| beyond the sketch: `SimHost.onRecovered` | M24, M24b | `recovery_fires_onRecovered_once`; `rules_only_change_direct_load_new_segment` (`'upgrade'`) | covered |
| beyond the sketch: `onLog`, `EngineTrap`, `EngineStartError` | M03, M06b | `wiring.spec.ts` (log line, panic as `EngineTrap`); `start.not_isolated_error`, `start.worker_blocked_error`, `start.arena_config_rejected` | covered |
| `checkSupport` | M35 | `checkSupport: each code`; M35 exit | covered |
| whole surface, one delivery style, every row has a behaviour test | M37 | M37 exit "`pnpm test unit -t \"engine event surface\"` passes with every table row present"; `reference: status walks every event` | covered |


## Gaps

Each line: item | status | owner milestone | proposed exit criterion. A milestone that closes a line edits the row above and deletes the line here.

