# M15: Subscriptions, frame building and the client replica (Rust core)

Status: not started · After: 13, 14 (M11 is needed only by 15b) · Tyler-dependent: no

Split: the PLAN.md row for M15 is two subsystems in two languages. This brief is the Rust core, proven natively by a byte-level loopback. `15b-ring-connection-and-replica-rendering.md` adds the in-browser `Connection`, the worker plumbing and the renderer hand-off. M16 follows 15b.

## Goal
A native `Host<G>` turns camera reports into per-connection subscription sets and builds one frame per tick per connection (Global, OwnPlayer, chunk enter pristine / snapshot / leave, deltas). A native `ClientCore<G>` applies frames atomically into a `Replica<G>` and serves `View` reads that are `Unknown` outside the subscription. After any scripted camera path, the replica's hash equals the host's hash of that connection's subscribed region.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0010-rates-and-subscriptions.md` ("Camera report", "Subscription set", "Untrusted-view clamps")
3. `docs/decisions/0011-wire-format-and-deltas.md` ("Scopes", "Chunk enter", "Versions instead of acks")
4. `docs/decisions/0007-world-model.md` (§1 `Unknown` on a replica, §5 multi-chunk relevance)

Also open `crates/engine/src/wire/CLAUDE.md` (M14's id tables). Mine from spikes: `spikes/prediction-api/engine/src/harness.rs` (in-process loop with per-client delay), `lib.rs` `Client::on_frame` steps 1 only. Rules: `determinism.md` (host-side code is *outside* the core but must still be reproducible under test), `hot-paths.md`.

## Scope
- `host::Host<G>` (created in M13 as `Sim<G>` + warm list) gains a fixed table of connection slots (`ConnId = u32 < maxPlayers`), and per slot: `PlayerId`, latest `CameraReport`, `SubscriptionSet`, "needs Global/OwnPlayer snapshot" flag. API: `connect(conn) -> PlayerId`, `disconnect(conn)`, `on_uplink(conn, &[u8])`, `seal()`, `tick()`, `build_frame(conn, out) -> usize`.
- **Implicit accept (until M28):** `connect` assigns `PlayerId = conn`, queues `Record::Player { Joined }` on first sight then `Connected` into the frame for T+1; `disconnect` queues `Disconnected` immediately (grace: M28).
- `host::subs::SubscriptionSet`: clamp the report; subscribe ring 1 + look-ahead; unsubscribe beyond ring 3 after the hold time; cap with the priority order of 0010. Uses M08b's `engine::view::lookahead_chunks`, the function the generation queue uses, so the generation set stays a superset of the subscription set (0008 §5). Output per update: `entered`, `left` lists (fixed capacity).
- `build_frame`: header (`tick`, `ack_seq = last_seq`); Global + OwnPlayer in full on the first frame, then on change; for each entered chunk a `ChunkEnterPristine` entry if it has no overlay and no overlapping entity, else a snapshot as of the end of this tick; leaves; `ChangeLog` deltas routed to subscribers by `Scopes`, entity ops deduplicated by id; an entity put whose scope the client newly lost becomes `Gone`. Returns 0 when there is nothing to say (heartbeat timing: M31). Pushes each subscribed view rect to `host::warm::set_view`.
- Per-chunk version (tick of last replicated change) stored with the chunk on both sides.
- `client::Replica<G>`: a `Store<G>` whose `TerrainStore` is the client's pristine cache from M08b (snapshots use `replace_overlay`, leaves `clear_overlay`; cached pristine tiles survive) + held-chunk set + versions; `client::ClientCore<G>::{on_frame(&[u8]) -> Result<FrameSummary, WireError>, view(), set_camera(CameraReport, t_ms), poll_uplink(t_ms, out) -> usize, drain_dirty(f)}`. `on_frame` validates the whole frame before mutating, then applies every section (atomic, 0011). Leave frees the chunk's overlay and entities no longer overlapping a held chunk. `drain_dirty` reports chunks whose effective tiles changed (for 15b's texel path).
- Uplink pacing in `poll_uplink` per 0010 "Rates" (batch spacing, camera on change with leading and trailing sends, keep-alive batch).
- `region_hash`: M05 state hash over `encode_chunk_snapshot` of each held chunk, ordered by coord + Global + OwnPlayer; the coord is the ordering key only, not part of the hashed bytes (`encode_chunk_snapshot` writes version/overlay-runs/entities only -- M14 Deviations, "Chunk snapshot coordinate"). `Host::region_hash(conn)` and `Replica::region_hash()`.
- `testkit::Loopback<G>`: one `Host`, K `ClientCore`s, byte buffers, per-client delay in ticks, scripted camera paths.

## Non-scope
Token bucket, visible-first pacing, soft cap, degrade, action rate limit: **M31**; heartbeat: **M28**; desync `Hashes`, `ResyncChunk`: **M31b**. Stated because the task brief asked: none is trivial enough to take here. Every enter is sent in the tick it happens, unpaced; the counters below show what M31 has to pace. Actions and acks (M16; `ack_seq` is carried but always the stored `last_seq`). Presence relay (M19). `Hello`/`Welcome` (M28); resume hints, epochs, disconnect grace (M28b). ABI exports, rings, TS (15b). Prediction overlay (M25).

## Files, packages and crates touched
`packages/engine/crates/engine` (`host/`, `client/`, `testkit/`), `packages/engine/fixtures/puts`, `packages/engine/budgets.json`.

## Seams
**Provides:** `Host<G>::{connect, disconnect, on_uplink, seal, tick, build_frame, region_hash}`, `ConnId`, `SubscriptionSet`, `ClientCore<G>`, `Replica<G>`, `FrameSummary` (`tick`, `ack_seq`, counts), `drain_dirty`, `region_hash`, `testkit::Loopback`; counters `bytes_down`, `frames`, `chunk_enters_pristine`, `chunk_snapshots`, `chunk_leaves`, `bytes_up` per connection per tick.
**Consumes:** M14 `wire::*`; M12b `Sim`, `ChangeLog`, `Scopes`, `View`, `Record`; M13 `Host<G>`, `host::warm::set_view`; M08b `view::lookahead_chunks`, the client `TerrainStore`; M07 `TerrainStore::{overlay, replace_overlay, clear_overlay}`, `ChunkRect`; M05 `StateHash`, goldens.

## Planning decisions
- **The subscription set is computed in Rust inside the sim-role instance,** not in TS, although PRE-PLAN §2 draws "subscriptions" in the TS host box: `sim_build_frame(conn)` (0014) needs the set to route deltas, and the sim worker isolate has an 8 B/frame budget. TS owns connection objects and timing only.
- **Hold time is counted in ticks** (`G::TICK_RATE.secs(..)` of the 0010 value), so subscription behaviour is exact under `stepTick`; a paused world has no clients, so wall time and tick time cannot diverge while it matters.
- **Coalescing:** within one tick a frame carries the last value per key (puts are whole-value and idempotent); a spawn and despawn in the same tick still emits `Gone` (harmless if unknown).
- **Real frame sizes against the bandwidth budget (PRE-PLAN §10, 2→3):** this milestone lands the counters and fixture-level ceilings in `budgets.json`. **M31** owns the assertion against the 0010 budget rows under pacing; **M36** owns the busy-furnace-field measurement on the reference game and with it the **byte-diffing decision**. Question M36 must answer: "with 200 active machines in view, is steady-state downlink per client above the 0010 soft cap, or above the typical range by more than 2×? If yes, open a byte-diffing milestone before M39; if no, close the 0011 deferral as not needed."
- **`encode_chunk_snapshot`'s cost per chunk is O(all entities in `Store`), twice** (M14 Deviations: an additive `Store::entities()` iterator, filtered by anchor chunk, walked once to count and once to write). Correct and allocation-free, but not indexed by chunk, so a frame builder emitting many chunk snapshots in one frame is doing work quadratic in (chunks × entities). Flag this as a known cost to measure under `build_frame`'s real workloads, not a defect to fix blind.
- **`Delta`'s 7th variant, `Ack { who, seq }`, never reaches `wire/`** (nothing there matches on `Delta` at all: M14 Deviations, "`Delta`'s 7th variant... is not this module's concern"). It is this milestone's to honour: the match this brief's frame builder writes over a `ChangeLog`'s `(Scopes, Delta<G>)` pairs on the way to wire calls must account for the `Ack` arm deliberately, with a stated reason (`Authority::record_ack` applies it straight to `Store`, bypassing the `ChangeLog`, per M12b Deviations), not fold it into a catch-all.
- **`UplinkReader::read` carries no `G` type parameter.** It hands back raw `(seq, &[u8])` action bytes and never decodes `G::Action` (M14 Deviations); this milestone's uplink handling decodes actions itself where it needs them.

## Order of work
1. `SubscriptionSet` + unit tests. 2. `Replica` + `on_frame` for Global/OwnPlayer. 3. enter pristine / snapshot / leave. 4. delta routing, dedup, `Gone` on scope loss. 5. uplink pacing. 6. `Loopback`, hashes, counters, goldens.

## Tests added
Rust native: `subs_ring1_plus_lookahead`, `subs_hysteresis_no_traffic_on_small_pan`, `subs_unsubscribe_after_hold`, `subs_cap_evicts_farthest_first`, `subs_clamps_oversized_and_zero_views`; `first_frame_has_global_and_own_player`; `pristine_chunk_enters_as_coord_only`; `modified_chunk_enters_as_snapshot_then_deltas_from_next_tick`; `leave_frees_overlay_keeps_pristine`; `entity_straddling_subscribed_and_unsubscribed_chunks_delivered_once`; `frame_is_atomic_on_malformed_tail`; `view_unknown_outside_subscription`; `idle_tick_builds_no_frame`; `replica_hash_equals_host_region_hash` (3 clients, seeded camera walk, 600 ticks, delays 0/2/5); `golden_frame_bytes_join_wilderness`; `uplink_at_most_one_batch_per_interval`; `uplink_keepalive_batch_every_1s` (0010 Rates: a client with no camera change and nothing queued emits exactly one batch per second of `t_ms`, carrying `last_received_tick`); `camera_report_on_change_leading_and_trailing` (0010 Rates: motion below the report quantum sends nothing, the start of motion sends at once, and coming to rest sends one final report with zero velocity); `camera_walk_changes_no_state` (spec overview, "The camera never mutates the world": two `Loopback` runs with the same action script and seed but different seeded camera walks, one of them with no camera traffic at all, give equal `Sim::state_hash()` at every checkpoint, while their subscription sets differ; the log half of that Requirement is M22's); `host_and_client_steady_state_no_alloc`.

## Exit criteria
- [ ] All tests above pass; `budgets.json` holds ceilings for the counters on `join_wilderness` and `join_modified` scenarios.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t subs` · `pnpm test rust -t replica` · `pnpm test rust -t golden_frame` · `pnpm lint`.

## Budgets
Bandwidth steady/burst rows: counters only, exact values in `budgets.json` (join in wilderness below the 0010 worked number). Memory: replica for the chunk cap fits the client arena share of 0015 §5 (assert computed size at init).

## Context artifacts
Crate `CLAUDE.md`: "host/ and client/ are outside the deterministic core: they may read subscriptions and cameras, `sim/` may not import them" (enforce with a module-visibility test if cheap).

## Manual device checks
none

## Deviations
(filled in during Phase 3)
