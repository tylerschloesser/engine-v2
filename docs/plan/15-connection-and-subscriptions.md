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
- **`AtomicsTimer.poll()` now fires a tick on *every* wake, unconditionally** (M13b, ADR 0030: the per-wake `due` check read the wall clock, which is what allocated). That is correct only while nothing but the timer itself ever wakes a production sim worker. **If this milestone wires a genuine external wake into the sim worker, it must revisit `poll()` first** — otherwise every external wake runs a spurious tick. Flagged by M13b as the one thing its fix is not future-proof against, and this is the first milestone in a position to break it.
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

**Seam shapes as landed** (all in `packages/engine/crates/engine/src/`):
- `host::ConnId = u32`, `host::MAX_CONNS = host::warm::MAX_VIEWS` (8, one cap reused, not two).
  `Host<G>::{connect(conn: ConnId) -> PlayerId, disconnect(conn), on_uplink(conn, bytes: &[u8]),
  tick(&mut self), seal(&mut self), build_frame(conn, out: &mut [u8]) -> usize, region_hash(conn) ->
  u64}`. Per-tick call order this milestone establishes (Scope names the methods, not an order):
  `tick()` once (delivers queued `Record::Player`s, steps `Sim`, stamps `chunk_versions`, refreshes
  every connection's `SubscriptionSet` from its last camera report) -- `build_frame(conn, ..)` once
  per connection -- `seal()` once (clears the tick's `ChangeLog`). `testkit::Loopback::step` is the
  reference caller.
- `host::subs::SubscriptionSet::{new(dims, tick_rate), update(&mut self, report: CameraReport, tick:
  Tick), entered() -> &[ChunkCoord], left() -> &[ChunkCoord], is_subscribed, chunks, warm_rect}`;
  `clamp_report`, `CAP_CHUNKS = 128`, `MAX_HALF_TILES = 128`, `MIN_HALF_TILES = 1` (0010 names no
  minimum for a zero/degenerate view -- "clamped about the centre, never rejected" -- 1 tile is this
  milestone's own reading, same footing as `view::lookahead_chunks`'s own algorithm reading of
  0008 §5). `warm_rect() = visible.expanded(2)`: exactly contains ring 1 and every look-ahead chunk
  (`lookahead_chunks` places one at `visible.expanded(1)`'s edge plus one more chunk), so the
  generation set `Host::build_frame` feeds `host::warm::set_view` stays a superset of the
  subscription target (0008 §5), satisfying this milestone's Deviations item 1.
- `client::Replica<G>::{new(dims, source, cache: CacheCapacity, own_player: PlayerId), is_held,
  held_chunks, drain_dirty, region_hash}`, plus `pub(crate)` `apply_*` methods `ClientCore` drives.
  Implements `WorldRead<G>` directly (not `world_access::View`, whose borrowed-`dyn Fn` held
  predicate cannot outlive a method that returns a fresh `View`): `tile`/`traits_at` are `Unknown`
  outside the held set; `entity`/`player`/`global` total, matching `View`'s own precedent.
- `client::ClientCore<G>::{new(replica), view() -> &Replica<G>, on_frame(&[u8]) ->
  Result<FrameSummary, WireError>, set_camera(CameraReport, t_ms: u32), poll_uplink(t_ms, out) ->
  usize, drain_dirty, region_hash}`. `FrameSummary { tick, ack_seq, chunk_enters_pristine,
  chunk_snapshots, chunk_leaves, tile_deltas, entity_ops }`.
- `testing::testkit::Loopback<G>::{new(WorldParams<G>), add_client(delay_ticks, dims, source,
  cache) -> (usize, PlayerId), client/client_mut/conn(i), set_camera(i, report), action(who,
  action), step(), run(n), last_built_frame/last_build_frame_len(i)}`. `testing::budgets::{budget,
  expect_within_budget}` -- this crate's first native reader of `budgets.json`.

**PlayerId = conn + 1, not conn.** The brief's "`connect` assigns `PlayerId = conn`" is read loosely:
`PlayerId(0)` is reserved ("none", `game::PlayerId`'s own doc comment), so conn 0 cannot map to it
literally. `Host::connect` uses `PlayerId(conn + 1)`.

**Chunk version default is 0 on both sides**, for a chunk never touched by a replicated write:
absent from `Host`'s `chunk_versions: BTreeMap<ChunkCoord, u32>` (queried with
`.unwrap_or(0)`), and inserted at `0` by `Replica::apply_enter_pristine`. Consistent by construction
(never separately reasoned about per chunk), and exercised by every pristine chunk in
`replica_hash_equals_host_region_hash`'s 600-tick run.

**`ChunkDeltas` is hand-written from a flat buffer, not `wire::write_chunk_deltas`.** That function's
signature takes `tile_groups: &[(ChunkCoord, &[(u16, Tile)])]` -- a slice-of-slices that cannot be a
reused `Host` struct field (a self-referential lifetime) without either reallocating a
`Vec<(ChunkCoord, Vec<(u16, Tile)>)>`'s inner `Vec`s every call or building the outer slice fresh
every call. `Host::scratch_tile_flat: Vec<(ChunkCoord, u16, Tile)>` is gathered flat, deduplicated by
`(chunk, index)` (last write wins) as `ChangeLog` entries are scanned, insertion-sorted by
`(cy, cx, index)`, and `write_chunk_deltas_flat` (module-private, `host/mod.rs`) writes the identical
wire bytes directly from it -- proven identical by every round-trip through the standard
`read_chunk_deltas` reader in every test that exercises a `ChunkDeltas` section, and by
`replica_hash_equals_host_region_hash`. Entity ops use the same flat-buffer trick
(`scratch_entity_ops: Vec<(EntityId, EntityOpKind)>`); a `Put` re-reads the entity's current value
from `Store` at write time rather than storing an owned clone, since the store already holds exactly
the coalesced last-write value (0011 "puts are whole-value and idempotent").

**Chunk-coordinate sorting never uses `ChunkCoord`'s derived `Ord`.** It compares `(x, y)` (field
declaration order); the wire's own convention (`ChunkCoordListWriter`'s doc comment) is `(cy, cx)`.
Every sort site here (`Host::region_hash`, `build_frame`'s entered/left/tile-group ordering,
`SubscriptionSet`'s cap eviction) uses an explicit `(c.y, c.x)` key. **This was a real, caught bug**:
`Replica::region_hash` first iterated its `held: BTreeMap<ChunkCoord, u32>` in the map's own
(x, y)-derived order while `Host::region_hash` sorted (cy, cx) -- same chunk set, same per-chunk
bytes, different `Fnv64` hash, since order feeds a sequential hash. Found by
`replica_hash_equals_host_region_hash` failing after the 600-tick walk; a debug pass (chunk-set
diff, then per-chunk version diff) narrowed it to ordering, not content, before the fix (an explicit
sort in `Replica::region_hash`) landed.

**Insertion sort, not `[T]::sort_by_key`, for every per-tick scratch buffer.** `Host`'s own
buffers (entered/left/tile-flat) and `region_hash`'s chunk list use a hand-written, allocation-free,
stable insertion sort (`host::insertion_sort_by_key`): `[T]::sort_by_key`'s standard-library
implementation is not guaranteed allocation-free for larger inputs, which would have put
`host_and_client_steady_state_no_alloc`'s claim on uncertain footing. Per-tick counts here are small
(a connection's own touched-chunk/tile/entity count), so O(n²) is cheap.

**`Delta::Roster` has no producer this milestone.** `0024 §8`/`delta.rs`'s own doc comment: "the
roster changes only through logged connection events" -- but `Sim::step`'s `Record::Player` handling
is M12b's, unchanged here (only `G::on_player` runs); nothing calls `Authority::write` with
`Delta::Roster`. Wiring `Connected`/`Disconnected` to a `Roster` delta would mean adding write
behaviour to `sim.rs`'s deterministic-state production, which is outside this brief's file list
(`host/`, `client/`, `testkit/`) and changes hashed state -- a decision left to the orchestrator, not
taken unilaterally. Consequence: `Global`'s roster half is built and wire-tested (M14 already
covered it) but never actually populated by any of this milestone's own `Loopback` scenarios; a
first frame's `Global` section carries `roster = []` (mask bit 0 clear) even though a player has
joined, until some later milestone adds the producer. Not silently masked: flagged here, and
`ConnCounters`/`PlayerSlot.online` are otherwise already correctly plumbed to receive it.

**`Delta::Ack` gets its own explicit, empty match arm** in `build_frame`'s scan of `ChangeLog`
entries, per this milestone's own instruction. In practice unreachable: `Authority::record_ack`
applies it straight to `Store`, bypassing the `ChangeLog` (M12b Deviations), so no `Ack` ever
appears in `sim.authority().changes()`. Not folded into a catch-all `_ => {}` regardless, so a
future change that *did* start pushing `Ack` onto the log would not silently vanish into an
unrelated wildcard.

**Anchor-only entity delivery, not footprint overlap**, per M14's own precedent (`encode_chunk_
snapshot`'s doc comment) and `Authority`'s scope derivation (`authority.rs`'s `Scopes` doc comment):
both stay anchor-chunk-only until M21 widens them together (widening one alone would desync host and
replica). `entity_straddling_subscribed_and_unsubscribed_chunks_delivered_once` is written and named
against today's semantics; it does not test a footprint straddling two chunks (no such footprint
exists in the M08b/M12b entity model this milestone builds on), only an entity whose *anchor* moves
from a subscribed to an unsubscribed chunk, which the client must see leave (`Gone`) exactly once.

**Testkit-only additions beyond the brief's own Provides list** (all `#[cfg(any(test, feature =
"testing"))]`, `host/mod.rs`): `Host::genesis_for_test(WorldParams<G>) -> Self` (bypasses
`Instance::init`'s JSON config parsing -- ABI wiring is 15b's, Non-scope here -- for `Loopback`'s own
constructor and `tests/no_alloc_connection.rs`'s direct `Host` construction);
`Host::queue_action_for_test(who, seq, action)` (a backdoor straight onto the same `pending_records`
queue `connect`/`disconnect` use, delivered through the *existing, unchanged* `Sim::step`
`Record::Action` path -- M16's own uplink admission pipeline, decode/admit/apply/`ActionResults`,
does not exist yet, but this milestone's own frame-building tests need *some* way to change world
state through a real `Sim::step` call); `Host::debug_subscribed`/`debug_version`,
`Replica::debug_version` (equality-diagnostic accessors used once while debugging the region_hash
bug above, kept since they are cheap and reusable). `Store::terrain_mut(&mut self) -> &mut
TerrainStore` and `Sim::authority_mut(&mut self) -> &mut Authority<G>` are non-test, minimal,
additive accessors: `Replica` needs `TerrainStore::{replace_overlay, clear_overlay, set_tile}`
directly (none of those is a `Delta<G>` variant, so `Store::apply` is not the seam), and
`Host::seal` needs `Authority::clear_changes` from outside `authority.rs`.

**Memory budget (Budgets: "replica for the chunk cap fits the client arena share of 0015 §5"),
addressed by two asserts in `Replica::new`**: the given `CacheCapacity` must cover at least
`CAP_CHUNKS` (128, 0010) chunks, and `TerrainStore::memory_bytes()` (deterministic:
`capacity_slots * dims.slab_bytes()`, reserved eagerly at construction, so this is checkable
immediately) must not exceed `CLIENT_CACHE_BUDGET_BYTES = 4 MiB` (0015 §5's "4 MiB dense cache" line
of the client role's 48 MiB share). 128 chunks at the default chunk edge (32) is 512 KiB, well under
budget; this milestone's own test fixtures originally asked for 4096 chunks (16 MiB, over budget) and
were changed to 1024 (0007 §8's own default, exactly 4 MiB) once the assert caught it. Three unit
tests (`client/replica.rs`) prove both panics fire and the boundary (exactly 128 chunks) does not.

**Measured, not fixed: `encode_chunk_snapshot`'s O(all entities), twice, per chunk**
(`measure_join_cost_many_chunks_many_entities`). 2,000 entities spread across a 121-chunk view
(0010's own worked "ring1 is 11x11=121" at the view clamp), one connection joining at once: **10.3 ms,
11,131 bytes**. That single join alone exceeds 0010's entire 10 ms tick-CPU budget (which also has to
cover every other connection's frame plus `apply`/`tick`/the log append) -- a concrete number for
M31 (pacing) and M36 (the busy-furnace-field byte-diffing decision) to work from, not a defect fixed
here (Planning decisions: "flag this as a known cost to measure ... not a defect to fix blind").

**`budgets.json`: `counters.subscription.{joinWildernessBytesDown, joinModifiedBytesDown}`** = 63,
90 (measured 55 B / 82 B for a one-client, 16-chunk join in wilderness and with 5 pre-painted tiles,
+ 8 B margin, the same fixed-margin convention `gc.pages.*.isolates.*.bytesPerFrame` already uses in
this file). Both are far under 0010's own worked "< 0.2 KB" (200 B) phone-join figure, though at a
smaller (16-chunk) view than 0010's 35-chunk phone clamp -- the claim carried is the same shape
(bytes-per-chunk in the low single digits wilderness, still tiny with a few overlaid chunks), not a
literal reproduction of 0010's number. `golden_frame_bytes_join_wilderness` pins the exact bytes.

**`host_and_client_steady_state_no_alloc` (own binary, `tests/no_alloc_connection.rs`, drives
`Host`/`ClientCore` directly -- `testkit::Loopback::step` itself allocates a `Vec<u8>` per client per
call by design, so it cannot be the harness for a no-alloc claim) covers**: `Host::tick`,
`Host::build_frame`'s `ChunkDeltas` routing (tile writes and entity moves), `Host::seal`,
`host::subs::SubscriptionSet::update` (unchanged camera), `ClientCore::on_frame`'s validate-then-
apply and `poll_uplink`, `Replica::apply_tile_delta`/`apply_entity_put`. **Does not cover**:
`ChunkEnterPristine`, `ChunkSnapshots`, `ChunkLeaves`, `Global`/`OwnPlayer` (roster/value/player
changes), or `EntityGone` -- none of those fire in the 300-tick measured window (stated in the
file's own doc comment, not left implicit). A too-short warm-up (5 join ticks) was itself an early
false failure here: several scratch buffers only reach steady-state capacity a few iterations into
the *steady* workload's own shape, not the join's; fixed with a second, 40-iteration warm-up phase
running the identical steady-state body before `live_bytes()` is first sampled.

Inject-fail-revert proofs (8 B leaked per call via `Vec::with_capacity(8)` + `mem::forget`, then
reverted), each confirming the no-alloc test actually fails when that path allocates:
| Path | Passing `live_bytes()` delta | Failing delta | Per-call cost implied |
|---|---|---|---|
| `host::Host::build_frame` | 2400 B (300 ticks) | 4800 B | +8 B/call, exact |
| `host::subs::SubscriptionSet::update` | 2400 B | 4800 B | +8 B/call, exact |
| `client::ClientCore::apply` (the `on_frame` apply pass) | 2400 B | 4800 B | +8 B/call, exact |
| `client::Replica::apply_tile_delta` | 2400 B | 4800 B | +8 B/call, exact |

Same-suspicion checks on the other listed tests (not `Vec` injections; each breaks the specific
property the test name claims and confirms the test catches it, then reverts):
- `idle_tick_builds_no_frame`: forcing `build_frame`'s "nothing to say" early return to never fire
  turned a passing `0 == 0` into a failing `10 == 0` (the 10-byte heartbeat header) on the very next
  idle tick.
- `view_unknown_outside_subscription`: forcing `Replica::tile` to always return `Err(Unknown)` failed
  the test's own positive assertion (`.tile(held tile).is_ok()`), catching the "everything is always
  Unknown" vacuous case the brief singled out.

**`tests/module_layering.rs`** enforces the new crate `CLAUDE.md` line via a source scan (`host/`,
`client/`, `abi/`, `testing/` directories and `client.rs`/`game_instance.rs`/`game.rs` files excluded
as legitimate cross-boundary callers; a second test proves the scanner itself reaches a real,
permitted `host::` reference in `game_instance.rs`, so an empty result above can't just mean the scan
is broken).

**ADR 0030 (`AtomicsTimer.poll()`'s unconditional per-wake tick) is unaffected, not acted on.** This
milestone is native Rust only and wires no external wake into the sim worker -- `sim_admit`/
`sim_build_frame`'s ABI wiring, the ring buffers, and the TS `Connection` are all 15b's (Non-scope
here). `poll()`'s "correct only while nothing but the timer itself wakes a production sim worker"
assumption is therefore still exactly as true as M13b left it; 15b is the milestone that has to
revisit it, if 15b's own ring-wake design ends up waking the sim worker from outside the timer.

**Commit-history note.** Steps 2-4 (Replica/`on_frame` for Global/OwnPlayer; enter/snapshot/leave;
delta routing/dedup/`Gone` on scope loss) landed in one commit: `build_frame` and `on_frame` are two
halves of one wire contract, and neither side is meaningfully testable alone. Step 5 (uplink pacing)
landed in the same commit, already tested by the three uplink tests. Steps 1 and 6 are separate
commits, plus three small follow-up commits (the entities-cost measurement, the `Replica` memory
budget, and this Deviations write-up). One earlier commit's `git add` named the `src/client/`
directory but not the sibling `src/client.rs` file it needed too (`pub mod core;`/`pub mod
replica;`); that commit's tree is incomplete in isolation, fixed forward (staged into the next
commit) rather than amended, per the no-amend rule.

## Fix round 1

**`chunksWarmed` is confirmed still structurally 0, and 15b is the milestone that makes it live.**
`build_frame` (`host/mod.rs`) does call `Warm::set_view` with a real subscribed rect every time it
runs, and `chunks_warmed_becomes_live` proves `Instance::sim_warm_one` then generates -- but that
whole path is reachable only through `Host<G>`'s *native* Rust methods (`connect`, `on_uplink`,
`tick`, `build_frame`), never through the ABI. `sim_admit`/`sim_build_frame` (the ABI exports
`chunksWarmed`'s TS counter would need a real connection to reach through) are still at `Instance`'s
defaults (`Status::Unsupported`) on `Host<G>`: this milestone's own Non-scope leaves them untouched,
per the brief ("ABI exports, rings, TS (15b)"). No connection can reach the host through the ABI
until 15b wires `sim_admit`/`sim_build_frame` to this milestone's native methods and something (a
real `Connection`, or `tests/browser/sim-worker.spec.ts`'s own harness) actually calls `connect`
through it. `tests/browser/sim-worker.spec.ts` asserting `chunksWarmed: 0` today is therefore still
correct, not stale -- **15b is what makes this counter live**, not this milestone.

**The `tests/module_layering.rs` scanner has a known blind spot, on record rather than rediscovered
later**: it greps for `crate::host`/`crate::client` *references*, so it cannot catch a future same-
file call to `Store::terrain_mut`/`Sim::authority_mut` written *inside* `store.rs`/`sim.rs`
themselves -- those two accessors return `&mut TerrainStore`/`&mut Authority<G>` and are plain
methods on types the deterministic core already owns, so a caller inside the core never has to name
`host`/`client` at all to reach them. Nothing exploits this today (both accessors are called only
from `client/replica.rs` and `host/mod.rs`, both outside the core, both already covered). It is a
gap in the *enforcement*, not a violation: recorded so a future change that adds core-side logic
behind one of these accessors is a deliberate review decision, not something that has to be
rediscovered from scratch.

**`host_and_client_steady_state_no_alloc`'s coverage gap (fixed-camera only) is closed** by a second
measured workload, `host_and_client_panning_no_alloc`, in the same binary: a camera panning one
full chunk edge per tick, an entity spawned at the leading edge and despawned one tick later (once
its chunk is held and no longer entering, so the despawn routes as a wire `EntityGone`), a tile
painted ahead of the pan path every other tick (so some entered chunks arrive as `ChunkSnapshots`,
not just `ChunkEnterPristine`), and a `Global`/`OwnPlayer` change every 50/70 ticks. Two-phase
warm-up: first past the 5 s (100-tick) unsubscribe hold so leaves actually reach their own steady
rate, not just the join/pan-start transient, then 40 more iterations of the exact measured body (the
same discipline the fixed-camera test already needed, for the same reason: buffer shapes specific to
*this* workload, not the join's).

**This test does not pass, and was not made to.** It measures a real, reproducible allocation:
**90.72 B/tick average (27,216 B over the 300-tick measured window, exact given the fixed seeds and
workload)**, from two calls, both triggered by a brand-new `BTreeMap` key every time (this workload
pans forever in one direction, so every entered/snapshotted chunk this replica has never held
before, every single tick -- unlike a real client, which turns around, oscillates, or is bounded):
- `TerrainStore::replace_overlay` (`world/overlay.rs`'s `Overlays::load_chunk` ->
  `BTreeMap<u64, ChunkOverlay>::entry(..).or_default()`), reached from `Replica::apply_snapshot_overlay`
  (`client/replica.rs`) via `Store::terrain_mut`: **~48 B per `ChunkSnapshots` entry**.
- `Replica::held: BTreeMap<ChunkCoord, u32>::insert` (`client/replica.rs`, both
  `apply_enter_pristine` and `apply_snapshot_overlay`), for the same never-seen-before-key reason:
  **~144 B per chunk entered**.

Both were isolated by temporary `live_bytes()` probes bracketing each call (removed before
committing): every section-level delta the coarse probe first reported was fully accounted for by
these two calls, with `ChunkLeaves` showing a net *negative* delta (removal frees more than it costs)
that does not fully offset the entries, hence net growth over the run.

**This is `.claude/rules/hot-paths.md`'s own named exception, half of it.** That rule already says,
verbatim, for `world/cache.rs`: "overlay growth (writes, world state) is the one allowed exception."
`TerrainStore::replace_overlay`'s cost is exactly that exception, now measured for the connection/
subscription path rather than just asserted. `Replica::held`'s growth is the same *kind* of thing --
subscription bookkeeping tracking genuinely new world state, not per-frame garbage -- but that
sentence names only `TerrainStore`, not `Replica::held`, so it is reported rather than assumed
covered. Whether to extend the exception's wording, bound `held`'s growth some other way, or accept
it as isolate as-is is not this milestone's decision (fix-round instruction: "that is my decision to
make").

Three inject-fail-revert sensitivity proofs (8 B/call injected via `Vec::with_capacity(8)` +
`mem::forget`, then reverted; the test was already failing, so each proof reports the *increase*
over the 27,216 B baseline, not a pass-to-fail transition) confirm the *other* new paths this
workload exercises are genuinely measured, not accidentally skipped:

| Path (file) | Baseline (300 ticks) | With injection | Increase | Calls implied |
|---|---|---|---|---|
| `host::Host::build_frame` (`host/mod.rs`) | 27,216 B | 29,616 B | +2,400 B | 300 (once per measured tick, exact) |
| `client::ClientCore::apply` (`client/core.rs`) | 27,216 B | 29,616 B | +2,400 B | 300 (once per measured tick, exact) |
| `client::Replica::apply_leave` (`client/replica.rs`) | 27,216 B | 36,816 B | +9,600 B | 1,200 (once per `ChunkLeaves` entry in the window, exact -- ~4/tick, matching ring 1's column height) |

**`frame_is_atomic_on_malformed_tail`'s dead `bad` binding is now a real assertion**, not discarded:
an append-corrupted frame (a valid frame plus one trailing `0xFF` byte -- `FrameReader` treats any
unconsumed tail as another section header, and `0xFF` is not a valid `SectionId`, so this is
guaranteed malformed, a different corruption shape than truncation) is now actually sent through
`on_frame` and asserted rejected-and-non-mutating, alongside the existing truncation case.

## Fix round 2: does the panning allocation scale, or plateau?

`host_and_client_panning_no_alloc`'s measured window run at 300, 600 and 1,200 ticks (warm-up
unchanged: join burst, then past the 5 s/100-tick unsubscribe hold, then 40 more iterations of the
exact measured body -- each window a fresh `Host`/`ClientCore` from the same warm-up, not an
extension of a shared run):

| Measured ticks | Total allocated | B/tick |
|---|---|---|
| 300 | 27,216 B | 90.720 |
| 600 | 55,744 B | 92.907 |
| 1,200 | 114,320 B | 95.267 |

`Replica::held_count()` and the new `Replica::debug_overlay_chunk_count()`, at the start and end of
the 1,200-tick window: **`held` 128 -> 128; overlay 16 -> 16.** Both flat. The cap is working:
neither map is growing past its bound, at any window length tested.

**This is neither of the two anticipated readings, and is reported as such rather than forced into
one.** It is not "constant because something grows without bound" -- `held`/the overlay map's own
*sizes* do not grow at all, ruling out an unenforced cap or an unbounded `Overlays` map as the
mechanism. It is not "falls ~1/ticks" either -- 90.72 -> 92.91 -> 95.27 is flat (a mild ~5% rise
across 4x the ticks, not the ~2x/~4x drop a one-off warm-up shortfall would produce). The rate is a
genuine per-tick constant, at a *bounded* map size: every measured tick, `Replica::held` and the
overlay `Overlays` map each remove one key at the trailing edge and insert one brand-new key at the
leading edge (continuous one-direction panning never revisits a freed key), and `BTreeMap`'s
node-level insert/remove is not zero-sum in *bytes* even when it is zero-sum in *entry count*: a
freed leaf node is deallocated, not pooled for reuse by the next insert at a completely different
key range, so each tick's insert+remove pair costs a real alloc/free pair regardless of how long the
map has been running or how stable its size is. Bounded state, unbounded (constant-rate) allocator
churn -- a real property of this access pattern against `BTreeMap`, not a warm-up artifact and not
an unenforced cap.

## Open gate failures (written by the orchestrator at M15's gate, for the next implementer)

**Fix round 2's stated explanation is wrong, and the wrong part is the part a later session would
act on.** The three measured numbers are sound and stand (90.7 / 92.9 / 95.3 B/tick at 300 / 600 /
1200 ticks; `held.len()` 128 -> 128; overlay entries 16 -> 16). The *reasoning* attached to them --
"bounded state, constant-rate `BTreeMap` node churn ... each tick's insert+remove pair costs a real
alloc/free pair" -- cannot produce that measurement, because `abi::arena::live_bytes()` is **live
bytes, allocated minus freed** (`src/abi/arena.rs`: "Bytes currently allocated through `Arena`",
`LIVE` incremented on alloc and decremented on dealloc). An alloc/free pair nets to **zero** in that
counter by construction. A flat, run-length-independent rise in *live* bytes is therefore not churn:
something's live footprint is growing without bound, and it is not `Replica::held` or the overlay
map, whose sizes the same run proved constant.

**One confirmed grower, found at the gate:** `Host::chunk_versions: BTreeMap<ChunkCoord, u32>`
(`host/mod.rs:135`) is inserted into at `host/mod.rs:335` and **never** removed, retained or
cleared (`grep` for `chunk_versions.remove|retain|clear` returns nothing). It gains a permanent
entry for every chunk ever touched by a replicated write, so a long-running host's memory grows with
the number of distinct chunks ever modified, without bound. This is also a deviation from the
brief's own Scope wording, which says the per-chunk version is "stored **with the chunk** on both
sides" -- the replica side honours that (`held`, bounded and pruned on leave); the host side does
not.

**What the next implementer owes this gate, in order:**
1. Account for the **whole** measured rate, not just the first cause found. `chunk_versions` at
   roughly one new chunk every other tick does not obviously add up to ~90 B/tick on its own.
   Instrument every candidate container's live size (not its `len()`) at window start and end and
   attribute the bytes, the same way fix round 1 correctly attributed `replace_overlay` and
   `held::insert` with bracketing probes. Report the attribution table; if a remainder is left,
   say so rather than rounding it into a named cause.
2. Separate **`Host`** from **`ClientCore`** in the measurement. They are measured together today,
   which is why a host-side grower could hide behind a client-side explanation.
3. Then stop and report. Whether `chunk_versions` moves into the chunk (the brief's wording),
   is pruned on some rule, or is accepted as unbounded with a recorded reason is the orchestrator's
   decision, not the implementer's -- as is whether the panning test asserts zero, asserts a
   measured ceiling, or stays red pending a follow-up milestone. Do not make the test pass by
   widening a budget, shortening the window, weakening an assertion or marking anything `#[ignore]`.

## Fix round 3: full attribution of the panning allocation, host and client measured separately

Method (the gate's own instruction, and round 1's technique reused): the panning workload of
`host_and_client_panning_no_alloc` was replayed byte-identically in a throwaway test binary with
`live_bytes()` brackets (a) around each of the eight calls in `run_panning_tick`, and (b) inside
`Host::tick`, `Sim::step`, `Authority::write`, `Store::apply` and `TerrainStore::set_tile`, feeding
a temporary `crate::probe` counter array; plus start/end sizes of every candidate container. All
instrumentation is reverted -- nothing here changed a source file, a test, an assertion, a window or
a budget. The 300-tick window reproduces the committed number exactly (27,216 B), so the brackets
are measuring the same thing the failing test measures. **Every table below sums to the measured
total with a remainder of exactly 0 B**, at every window length.

**Host/client split: the entire rate is host-side. The client allocates exactly zero.**

| Call site (per `run_panning_tick`) | 300 ticks | 1,200 ticks | 4,800 ticks |
|---|---|---|---|
| `host.on_uplink` | 0 | 0 | 0 |
| `host.queue_action_for_test` (`pending_records` `Vec` capacity) | 96 | 96 | 96 |
| `host.tick` | 27,120 | 114,224 | 457,792 |
| `host.build_frame` | **0** | **0** | **0** |
| `client.on_frame` | **0** | **0** | **0** |
| `host.seal` | 0 | 0 | 0 |
| `client.drain_dirty` | **0** | **0** | **0** |
| `client.poll_uplink` | **0** | **0** | **0** |
| **HOST total** | 27,216 | 114,320 | 457,888 |
| **CLIENT total** | **0** | **0** | **0** |
| B/tick | 90.720 | 95.267 | 95.393 |

Round 1's client-side attribution was therefore measuring **gross bytes allocated at those call
sites, not net live bytes**: `Replica::held::insert` and `TerrainStore::replace_overlay` do allocate
on a new key, but the matching `held.remove`/`clear_overlay` on the trailing-edge leave frees the
same amount in the same tick, so `on_frame`'s net contribution to `live_bytes()` is 0 over 4,800
ticks with `held` pinned at 128 and the overlay map at 16. Round 2 then reasoned about those two
(correctly measured, wrongly signed) numbers as if they were live growth. Both are dismissed.

**Attribution inside `Host::tick`** (4,800-tick window, the asymptotic rate; the 300-tick column is
the number the committed test prints):

| Site | 4,800 ticks | B/tick | 300 ticks | Unit cost, and what the unit is |
|---|---|---|---|---|
| `Overlays::get_or_create` -- `BTreeMap<u64, ChunkOverlay>` node growth, via `Store::apply(Delta::Tile)` -> `TerrainStore::set_tile` | 152,672 | 31.807 | 9,952 | ~63.6 B per chunk newly given an overlay (2,400 such chunks in the window) |
| `ChunkOverlay::write` -- the chunk's first `Vec<Entry>` push, same path | 115,200 | 24.000 | 7,200 | **48 B exactly** per chunk newly given an overlay (consistent with a min-capacity-4 `Vec` of 12 B `Entry`) |
| `TerrainStore::materialize` -> `Cache::push_event` -- the `Vec<CacheEvent>` queue, same path | 63,488 | 13.227 | 2,048 | ~16 B per queued load/evict event (3,856 events in the window); appears in a short window as a single `Vec` doubling, hence 6.8 B/tick at 300 ticks rising to 13.2 at 4,800 |
| `Host::chunk_versions.insert` -- `BTreeMap<ChunkCoord, u32>` node growth (`tick()`'s scope loop) | 126,144 | 26.280 | 7,632 | ~26.3 B per chunk key newly inserted (4,800 keys, exactly one per tick) |
| `Authority`'s `ChangeLog` `Vec` capacity (`changes.push`) | 256 | 0.053 | 256 | one-off capacity step, not growth |
| `Sim::step`'s `outcomes` `Vec` capacity (`out.push`) | 32 | 0.007 | 32 | one-off capacity step |
| `Host::pending_records` `Vec` capacity (`queue_action_for_test`) | 96 | 0.020 | 96 | one-off, test-harness path only |
| **Total** | **457,888** | **95.393** | **27,216** | **remainder 0 B** |

`SubscriptionSet::update`, `build_frame` (every section: enters, snapshots, leaves, deltas, entity
ops, `Global`/`OwnPlayer`), `seal`, `on_uplink` and the whole client side contribute **0 B**.

**Three unbounded growers, all `Host`-side, and one control that proves they are the whole story.**
Rerunning the identical body with the camera *oscillating* over a 16-chunk band instead of panning
forever (`bounded=true`: same actions, same rates, same warm-up, only the territory bounded) gives
**384 B total at 300, 1,200 and 4,800 ticks alike** -- the three one-off `Vec` capacity steps and
nothing else; 0.080 B/tick at 4,800 and still falling as 1/ticks. Host containers are flat across
that whole run (overlay chunks 8 -> 8, `chunk_versions` 20 -> 20, cache events 8 -> 8). So there is
**no time-proportional leak in the tick loop**: every byte of the ~95 B/tick is proportional to
*newly reached territory*, which this workload manufactures forever by design.

1. **`TerrainStore`'s overlay map + per-chunk overlay `Vec`** (~111.6 B per chunk first written to,
   63.6 + 48). This is `.claude/rules/hot-paths.md`'s named exception verbatim ("overlay growth
   (writes, world state) is the one allowed exception"), and it is genuine world state.
2. **`Host::chunk_versions`** (~26.3 B per distinct chunk ever touched by a replicated change), the
   grower the gate found. Confirmed unpruned, and confirmed to grow *faster than world state does*:
   in the 300-tick window it gained 300 keys while the overlay map gained 150 chunks, because a
   chunk gets a permanent version entry from an entity that merely passed through it. **Half the
   keys in this workload belong to chunks whose replicated state is empty** -- never painted, entity
   spawned and despawned again, back to pristine, version entry retained forever.
3. **`Cache::events`, the host's undrained cache-event queue** (~16 B per load/evict event) --
   **not anticipated by the gate or by either earlier round**. `TerrainStore::drain_cache_events`
   has exactly one non-test caller in the crate, `client::upload` (M09's texel path). Nothing on the
   host path ever drains it, so every `materialize` on the host pushes a `CacheEvent::Loaded` (and,
   once the cache is full, an `Evicted`) onto a `Vec` that only ever grows. Unlike (1) and (2) this
   one is **not bounded by world size**: a host whose cache churns (any camera that revisits more
   chunks than the cache holds) queues events forever for a consumer that does not exist in the
   sim role. In the 4,800-tick pan the queue reached 3,936 entries from 80.
   The same latent hole exists on the client (`ClientCore`/`Replica` never drain either; only
   `client::upload` does), it is simply not exercised here because this test never reads a replica
   tile -- the client queue sat at 0 for the whole pan and 6 for the whole oscillation.

Not decided here, per the gate's instruction: whether `chunk_versions` moves into the chunk (the
brief's Scope wording), gets pruned, or is accepted; whether the host should drain or not queue
cache events at all; and whether `host_and_client_panning_no_alloc` asserts zero, asserts a ceiling,
or stays red. Reproduction, if it is wanted again: bracket the eight calls in `run_panning_tick`
with `live_bytes()`, and place probes at `Host::tick`'s three stages, `Authority::write`'s
`store.apply`/`changes.push`, and `TerrainStore::set_tile`'s `materialize` /
`overlays.get_or_create` / `overlay.write` -- those seven sites account for 100% of it.
