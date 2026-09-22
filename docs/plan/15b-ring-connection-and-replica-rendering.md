# M15b: In-browser `Connection`, worker plumbing, replica to renderer

Status: done (two deliverables split to M15c) · After: 11, 15 · Tyler-dependent: no

Split from M15 (see that brief). M16 depends on this milestone.

## Goal
In a single-player page the sim worker and the client worker exchange the M14 bytes over the uplink/downlink ring pair through a `Connection`-shaped adapter. Panning the camera changes the subscription; overlay tiles written by the sim appear on screen through the existing chunk-upload path; nothing allocates in steady state in either worker.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0015-threads-memory-and-topology.md` (§1 table, §2 ring shape, backpressure, wake-ups)
3. `docs/decisions/0009-transport-and-hosting.md` (`Connection`, "Single-player")
4. `docs/decisions/0014-js-wasm-boundary.md` (§4 regions, copy-in/copy-out discipline, role table)

Mine from spikes: `spikes/cross-origin-sab` (ring drain into a non-shared memory with preallocated slot views). Rules: `.claude/rules/hot-paths.md`.

## Scope
- **ABI** (rows in M02's `abi::registry`, `ABI_VERSION` bumped). Sim role: new `sim_connect(conn) -> status`, `sim_disconnect(conn) -> status`; M02's `sim_admit(conn, len)` (one whole uplink batch from `RegionId::Rx`: camera report now, actions in M16, presence in M19) and `sim_build_frame(conn) -> len` (into `RegionId::Tx`) become real on `Host<G>`. Client role: `on_frame(ptr, len) -> status` (0014), new `client_poll_uplink(t_ms: f64) -> len`; M06b's `CameraBlock` in `RegionId::Camera` feeds `ClientCore::set_camera` inside the existing `frame(t_ms)`.
- **`RingConnection`** (`packages/engine/src/`): implements 0009 `Connection` over `SabSet.uplink` (`RingConsumer`) and `SabSet.downlink` (`RingProducer`), `datagrams: false`, no `bufferedAmount`. `send` copies the engine-owned view into ring slots; a full ring keeps the frame and retries next tick (0015 backpressure), counted in `downlinkRetries`; `drops` stays 0.
- **`SimHost.accept(connection)`**: allocates a `ConnId`, calls `sim_connect`, routes `onMessage` bytes → receive region → `sim_admit`, and after each tick `sim_build_frame(conn)` → `connection.send(MsgClass.ReliableOrdered, view)` when `len > 0`. `onClose` → `sim_disconnect`. The sim worker creates one `RingConnection` at startup and accepts it; its `Atomics.wait` loop also wakes on the uplink ring's wake word.
- **Client worker loop** (extends the frame loop from M09/M11): on wake, drain the downlink ring: each message → receive region → `on_frame`; copy the camera block; `frame(t_ms)`; `client_poll_uplink(t_ms)` → uplink ring + `Atomics.notify` of the sim worker. Messages larger than one slot span slots (0015); reassembly uses one preallocated buffer.
- **Hidden tab (0019 §2):** while M09b's frame loop is paused on `hidden`, `client_poll_uplink` emits no camera report, and the host keeps the connection's subscription set as last reported; the first frame after `visible` reports again.
- **Replica → renderer.** After `on_frame`, `ClientCore::drain_dirty` reports tile changes and whole-chunk changes; a tile delta becomes M09 `Uploader::patch_tile(pos: TilePos, tile: Tile)` (M09's real signature takes the tile's own global position and its new value — not a separate chunk-coord/local-index pair; check the current signature in `crates/engine/src/client/upload.rs` before matching this brief's shape literally), a snapshot or a leave becomes `Uploader::enqueue_chunk(coord: ChunkCoord)` with the effective slab (`TerrainStore::copy_chunk`); a chunk generated after its snapshot arrived is enqueued with the overlay already applied. Non-resident chunks need nothing: they are converted when they become resident. This milestone is `patch_tile`/`enqueue_chunk`'s first production caller (M09 Deviations "Notes for later briefs": until now only `client/upload.rs`'s own `#[cfg(test)]` module calls them) — the evicted-slot staging-order fix (M09 Deviations "Gate fix round 1" item 4: an evicted slot's `INDIR` none is staged before any `CHUNK` that reuses that slot) already covers a dirty-chunk re-enqueue racing eviction the same way it covers panning; nothing extra to build here for that case.
- **`engine/test`:** `netCounters(client)` (M15 counters + `downlinkRetries`), `replicaHash(client)`, `hostRegionHash(client, conn)`; M06b's `untilQuiescent` already covers both rings, extend it with "the client has applied the host's latest tick".

## Non-scope
Net worker and sockets (M29). `createWorldServer` (M27). Handshake (M28). Pacing (M31), heartbeat (M28), hashes (M31b). Actions (M16). DrawList, entities on screen (M17): only tiles are visible here. "Reveal when visible chunks are received and generated" (M28 builds `ClientCore::revealed()`; M29 gates the first draw on it).

## Files, packages and crates touched
`packages/engine/src` (`server.ts`, `worker.ts`, `ring-connection.ts`, `abi.ts`, `test.ts`), `packages/engine/crates/engine` (`abi/registry.rs`, `host/`, `client/`), `packages/engine/fixtures/puts` (test page).

## Seams
**Provides:** exports above; `RingConnection`; `SimHost.accept`; `engine/test` `netCounters`/`replicaHash`/`hostRegionHash`. The visible overlay comes from the `puts` tick rule's once-per-second `set_tile` (M12b); do not change the fixture's rules here, its goldens are fixed.
**Consumes:** M15 `Host`, `ClientCore`, `drain_dirty`, `region_hash`; M13 `SimHost`, sim worker kind, `stepTick`; M11 `injectPointer`/`injectWheel`; M09b `setVisibility`, `FrameLoop.pause()`/`resume()`; M09 `Uploader::{patch_tile, enqueue_chunk}`, `renderTo`/`readPixels`/`expectPixel`, `uploadBytes` counter (M09's Deviations, Steps 5-7: `renderTo`/`readPixels` are overloaded — the renderer-only shape from steps 2-4 and a `renderTo(client, opts)`/`readPixels(client)` pair that drains a real `client.uploadRing` and remembers the target in a `WeakMap<Client, RenderTarget>`; a browser test against a real client here should use the `client`-shaped overload), `Client.{cameraState, uploadRing, writeCameraAndWake}`; M08b `TerrainFeed` beside the client `TerrainStore`, `GenView`; M06 `RingProducer`/`RingConsumer`, `SabSet`; M06b `CameraBlock`, `setCamera`, `untilQuiescent`, worker shell; M04 zero-GC harness.

**M15's native `Host`/`ClientCore`/`Replica` shapes, as landed (copied verbatim from `docs/plan/15-connection-and-subscriptions.md`'s Deviations, "Seam shapes as landed" — 15b drives these through the ABI, so match them exactly rather than paraphrasing):**
- `host::ConnId = u32`, `host::MAX_CONNS = host::warm::MAX_VIEWS` (8, one cap reused, not two). `Host<G>::{connect(conn: ConnId) -> PlayerId, disconnect(conn), on_uplink(conn, bytes: &[u8]), tick(&mut self), seal(&mut self), build_frame(conn, out: &mut [u8]) -> usize, region_hash(conn) -> u64}`. Per-tick call order M15 establishes: `tick()` once (delivers queued `Record::Player`s, steps `Sim`, stamps `chunk_versions`, refreshes every connection's `SubscriptionSet` from its last camera report) — `build_frame(conn, ..)` once per connection — `seal()` once (clears the tick's `ChangeLog`). `testkit::Loopback::step` is the reference caller.
- `client::Replica<G>::{new(dims, source, cache: CacheCapacity, own_player: PlayerId), is_held, held_chunks, drain_dirty, region_hash}`, plus `pub(crate)` `apply_*` methods `ClientCore` drives.
- `client::ClientCore<G>::{new(replica), view() -> &Replica<G>, on_frame(&[u8]) -> Result<FrameSummary, WireError>, set_camera(CameraReport, t_ms: u32), poll_uplink(t_ms, out) -> usize, drain_dirty, region_hash}`. `FrameSummary { tick, ack_seq, chunk_enters_pristine, chunk_snapshots, chunk_leaves, tile_deltas, entity_ops }`.

## Planning decisions
- **`PlayerId = conn + 1`, not `conn`.** `PlayerId(0)` is reserved as "none" (`game::PlayerId`'s own doc comment), so M15's `Host::connect` assigns `PlayerId(conn + 1)`; `SimHost.accept`'s `ConnId` allocation must line up with that offset, not with M15's brief text (which said `PlayerId = conn`). See `docs/plan/15-connection-and-subscriptions.md`'s Deviations.
- **Trap: any store paired with an `Uploader` must call `TerrainStore::enable_cache_events()`.** M15 made cache-event recording opt-in, off by default (`Cache::events` grew without bound on the undrained host path). The two enable points today are `game_instance.rs`'s `ClientInstance::new` and `fixtures/terrain`'s `Role::Client` arm. If this milestone's replica → renderer path constructs or reaches a client `TerrainStore` some other way, and that store is not enabled, `Uploader::on_frame`'s drain silently sees nothing — the renderer gets no terrain updates and there is no error. Check this first if `overlay_tile_reaches_screen` or `pan_changes_subscription` shows tiles not updating. See `docs/plan/15-connection-and-subscriptions.md`'s Deviations, "Fix round 3b" item 1.
- **The client-side cache-event queue is never drained.** `ClientCore`/`Replica` have no drain call for it; latent and unexercised in M15 only because its tests never read a replica tile through the upload path. Once this milestone enables cache events on a client-side store (per the trap above), something on the client worker loop must also drain that queue, or it reintroduces the same unbounded growth M15 fixed on the host. See `docs/plan/15-connection-and-subscriptions.md`'s Deviations, "Fix round 3" item 3.
- **`chunksWarmed` becomes live here, not in M15.** M15 wires `Warm::set_view` from `build_frame`, but `sim_admit`/`sim_build_frame` are still at `Instance`'s `Status::Unsupported` defaults until this milestone's ABI work lands — no connection could reach the host through the ABI before now. `tests/browser/sim-worker.spec.ts` asserts `chunksWarmed: 0` today; it will need updating once `sim_admit`/`sim_build_frame` are wired. See `docs/plan/15-connection-and-subscriptions.md`'s Deviations, "Fix round 1".
- **Revisit ADR 0030's `AtomicsTimer.poll()` before wiring the ring wake into `SimHost.accept`'s `Atomics.wait` loop.** `poll()` firing a tick on every wake is correct only while nothing but the timer itself wakes a production sim worker (M13b's assumption, left unaffected by M15's native-only work). This milestone is the first to wire a genuine external wake — the uplink ring's wake word — into that loop, so `poll()` must be revisited first or every external wake runs a spurious tick.
- **Patch per tile, slab per snapshot.** M09 already has both records; a snapshot with a handful of overlay entries still re-enqueues the slab because the chunk's previous overlay is unknown to the uploader. The 0018 per-frame upload budget paces a burst of snapshots exactly like a burst of generated chunks.
- **The camera report is built in Rust from the camera-block copy,** not in TS: M06b already copies the block into `RegionId::Camera` each frame, and quantisation plus on-change logic then has one native-tested home (`ClientCore::set_camera`).
- **`sim_admit` keeps its ADR name** even though it now carries camera reports too: one uplink message, one export.
- **Ring capacities (0015 deferral, this link only):** downlink sized for one maximum-view join burst, uplink for 64 batches; exact numbers go in M06's capacity table, asserted by `join_at_max_zoom_out_never_drops`.

## Order of work
1. exports + native smoke through the C ABI. 2. `RingConnection` + Vitest with real SAB rings in one thread. 3. `SimHost.accept` under Node with an in-thread ring pair. 4. client worker loop. 5. dirty-chunk texel path. 6. Playwright tests, then the zero-GC window with panning.

## Tests added
TS unit: `ring_connection_roundtrip`, `ring_connection_backpressure_retries_not_drops`, `ring_connection_spans_slots`. WASM under Node: `host_accepts_ring_connection_and_hashes_match`. Browser: `pan_changes_subscription` (inject pan; `netCounters` show enters then, after the hold, leaves), `overlay_tile_reaches_screen` (readback probe of the fixture's ticking tile: pristine colour before, overlay colour after), `replica_hash_equals_host_in_browser`, `join_at_max_zoom_out_never_drops`, `hidden_tab_sends_no_camera_report` (after M09b's `setVisibility(client, 'hidden')`, a `setCamera` to a far position and 100 `stepTick`s, `netCounters` show no uplink camera bytes and no enters or leaves; after `'visible'` and one frame the report goes out and the enters follow), zero-GC test extended: 600 frames with panning, sim + client isolates within budget, ring `drops === 0`.

`tests/browser/sim-worker.spec.ts`'s existing `chunksWarmed: 0` assertion needs updating here: it is correct through M15 (see Planning decisions, "`chunksWarmed` becomes live here") and goes live once `sim_admit`/`sim_build_frame` are wired.

## Exit criteria
- [x] All tests above pass, **except `overlay_tile_reaches_screen` and the zero-GC panning window, which moved to `docs/plan/15c-terrain-visibility-and-cache-invalidation.md`** — both were blocked by a pre-existing M07/M08b cache-invalidation bug confirmed in source at this gate, not by anything this milestone built. Everything else listed passes.
- [x] No `subarray`/`new Uint8Array` on the per-message or per-frame paths of both workers (the M04 assertion is the proof; a grep is the hint).
- [x] `pnpm test` and `pnpm lint` are green (orchestrator-run: rust 267, unit 157, wasm 43, browser 103 at 22 s; biome/rustfmt/clippy/tsc clean).

## Verification commands
`pnpm test unit -t ring_connection` · `pnpm test wasm -t ring_connection` · `pnpm test browser -t subscription` · `pnpm test browser -t zero_gc` · `pnpm lint`.

## Budgets
Allocation per isolate (client, sim rows): M04 harness. GPU upload row: M09's `uploadBytes` counter ≤ the 0018 figure while panning with dirty chunks. Bandwidth: M15 counters re-asserted in the browser scenario.

**The `browser` suite trip-wire is armed, with no headroom left**: at M15's gate it sat at 19–20 s of a 25 s budget. This milestone adds browser tests to that suite, so per `docs/decisions/0020`'s §4 it must take the next rung before the suite is accepted, not after.

## Context artifacts
`packages/engine/src/CLAUDE.md`: copy discipline for ring ↔ region transfers. ABI table update.

## Manual device checks
none (first device run is M16's)

## Deviations

**Steps 4-6, seam shapes as landed.**

- **ABI** (`ABI_VERSION` 9 -> 10): `on_frame(len) -> status` (client role; `len` bytes of the new
  `RegionId::Downlink` are one whole host frame, applied atomically via `ClientCore::on_frame`, then
  `Replica`'s dirty queue is drained straight into `Uploader::enqueue_chunk`/`patch_tile`).
  `client_poll_uplink(t_ms: f64) -> len` (client role; the raw `t_ms` argument is ignored, same shape
  as `frame`'s own `_raw_t_ms` -- the real value is `camera.frame_time_ms`, already copied into the
  `Camera` region by the same worker pass that calls `frame` right before this). `RegionId::Downlink
  = 10` is the client's own inbound host-frame buffer; `Rx` stays input-only (M11), and the client's
  own `Tx` region (unclaimed by that role until now) carries `client_poll_uplink`'s output --
  `host::mod`'s own `SIM_RX_BYTES`/`SIM_TX_BYTES` (private consts) are mirrored as `CLIENT_UPLINK_
  BYTES`/`CLIENT_DOWNLINK_BYTES` in `game_instance.rs` rather than shared, since keeping the two
  pairs in step is already `host::mod`'s own Deviations to track. Three test-only exports (never a
  production caller, `engine/test` only): `sim_region_hash(conn) -> status`, `client_region_hash()
  -> status` (both two LE `u32` into `Result`, `sim_hash`'s own crossing shape), `sim_conn_counters
  (conn) -> status` (`host::ConnCounters`, six LE `u64` into `Result`, field order `bytes_down,
  frames, chunk_enters_pristine, chunk_snapshots, chunk_leaves, bytes_up`).
- **`ClientInstance<G>`** (`game_instance.rs`) now holds a boxed `client::ClientCore<G>` in place of
  its own standalone `TerrainStore`: `Replica<G>`'s own store (built with `own_player: PlayerId(1)`
  unconditionally -- this milestone's topology never has more than one client link, always `conn ==
  0`, matching the Planning decision) is the *one* store `TerrainFeed`/`Uploader` now share too, via
  two new `pub(crate)` accessors, `Replica::terrain`/`terrain_mut` and `ClientCore::replica_mut`.
  `frame()`'s dispatch feeds `CameraBlock::to_report()` (a new method, `client/camera.rs`: `f64`/
  `f32::round` then a saturating `as` cast, tile-unit quantisation ahead of `host::subs::
  clamp_report`'s own untrusted-input clamp) into `ClientCore::set_camera`.
- **Replica's dirty queue is one `Vec<DirtyEvent>`, not two.** `Uploader::patch_tile` needs a tile
  delta's own `(TilePos, Tile)`; `enqueue_chunk` needs a whole-chunk change's `ChunkCoord` -- the
  first attempt gave `Replica` two parallel queues for these, populated at the same four call sites
  as the existing `dirty: Vec<ChunkCoord>` `drain_dirty` already drains. That reintroduced the exact
  unbounded-growth bug M15 fixed for cache events: `host_and_client_bounded_camera_no_alloc`/
  `host_and_client_steady_state_no_alloc` (`no_alloc_connection.rs`) call `client.drain_dirty(|_|
  {})` alone to keep memory bounded, and the second queue was never drained by that call, so it just
  grew (measured ~3.4 B/tick of persistent growth, not a one-off ramp). Fixed by merging into one
  queue (`client::DirtyEvent::{Whole(ChunkCoord), Tile(TilePos, Tile)}`, `pub(crate)`, re-exported
  from `client.rs`): `drain_dirty` (the fixed, `ChunkCoord`-only seam) and the new `drain_dirty_for_
  upload` (`game_instance.rs`'s `on_frame`, one closure over `DirtyEvent` since two `FnMut`s cannot
  both borrow the same `Uploader`) both drain the *same* `Vec`, so whichever one a caller actually
  uses keeps memory bounded. `Replica::apply_leave` now also pushes `DirtyEvent::Whole` (closing the
  "not a plain leave" gap M15 Deviations deferred to this milestone: a leave clears the overlay, so
  a still-GPU-resident chunk needs re-staging pristine).
- **Topology (Orchestrator ruling 1).** `ClientOptions.host` (local variant) gains `connect?:
  boolean`, default `false`/unset. `client.ts`'s `start()` computes `linked = host.kind === 'local'
  && host.connect === true` and threads it to both the `sim` and `client` setup messages as
  `SetupMessage.link` (a new field, real production config -- not under `TestFlags`, which is
  explicitly test-only). `worker/sim.ts` creates and `SimHost.accept()`s a `RingConnection` only
  when `message.link === true`, sized from `simInstance.rxBytes()`/`txBytes()` (the real region
  capacities, not a duplicated magic number); every existing `sim`-kind test page never sets `host.
  connect`, so `puts_idle_100`'s zero-connection topology holds by construction. The connected
  golden lives beside it: `scripts/golden.mjs` (was hardcoded to exactly one `scenario.json`/
  `golden.json` pair) now writes one `golden<suffix>.json` per `scenario<suffix>.json` file in a
  fixture's `golden/` dir; `SimScenario` (`tests/support/scenario.ts`) gained `connect?: boolean`
  (calls `sim_connect(0)` once, same "once, before the loop" shape `genesis` already has); `fixtures/
  puts/golden/scenario-connected.json` is `puts_idle_100`'s own scenario plus `connect: true`.
  `pnpm golden puts` confirmed `golden.json` byte-identical (`195e71ef0defbf7a`, not re-blessed) and
  wrote `golden-connected.json` (`df47fa55da493c78`, genuinely different, `wasm_connected_100_
  matches_its_own_golden` is its own spec assertion).
- **Ruling 2 (no per-tick `subarray`)** needed a second pass: step 4's own commit left `server.ts`'s
  two `region.u8.subarray(0, raw)` calls in place (an oversight, caught re-reading the brief at the
  step 6 gate, not by a test -- neither call is covered by any zero-GC page yet, see "Zero-GC window"
  below). Fixed the same way `simAdmit` already does it on the way in: `simBuildFrame`/`simSealFrame`
  now hand the whole persistent `Tx`/`Persist` region view, with `.len` carrying the real count
  alongside. `Connection.send`'s own 0009 shape is fixed at `(cls, bytes)`, so the real length has
  nowhere to travel on that path; `RingConnection.send` gained an optional third `len` parameter
  (defaulting to `bytes.length`, so every existing unit test that already hands a correctly-sized
  view is unaffected), and `server.ts`'s `runOneTick` passes `frame.len` through it via the same
  optional-property cast pattern `pumpRetries`/`lastMessageLength` already use for a `RingConnection`
  -specific member a generic `Connection` doesn't carry. `tests/wasm/puts.test.ts`'s own fake
  `Connection` (the A/B byte-for-byte comparison test) updated to respect the same parameter.
  Verified: `pnpm test unit -t ring_connection`, `pnpm test wasm` (`host_accepts_ring_connection_
  and_hashes_match` included) and every `connected*.spec.ts` browser test still pass with the real
  production path exercising both branches every tick.
- **`worker/client-net.ts`** (new file): the client worker's net pump, built only when linked, run
  from `body()` *before* `uploadPump.pump()` (not after, where `genPump`/`uploadPump`/`inputPump`
  already sat) -- `on_frame` (inside the net pump) enqueues a newly dirty chunk into `Uploader`'s own
  pending queues, and this ordering stages it onto the upload ring the same wake it arrived, not one
  wake later (found by `untilQuiescent` otherwise declaring the upload ring "drained" -- nothing
  pushed *yet* -- before `uploadPump` had a chance to try).

**Newly discovered bug, not fixed here (Decision needed).** Building `overlay_tile_reaches_screen`
(a GPU readback probe of `fx-puts`'s own once-per-second ticking tile, `PutsClient::tile_visual`
swapping the resource layer on `aux != 0`, `fixtures/puts/src/lib.rs`) found a real, reproducible bug
in pre-existing M07/M08b code, not something this milestone's own new code got wrong: a chunk the
client has already pristine-generated (`client::TerrainFeed`, independent of host subscription),
then receives a host **snapshot** for (`Replica::apply_snapshot_overlay` -> `TerrainStore::
replace_overlay`), is correctly evicted from the cache (`replace_overlay`'s own doc comment: "the
next read regenerates and re-applies, which is always correct") -- but nothing ever triggers that
next read while the camera holds still: `Cache::evict_if_present` (the path `replace_overlay`/
`clear_overlay` use) never calls `push_event`, unlike `materialize`'s own LRU-eviction path, so no
`CacheEvent::Evicted` exists for `Uploader::on_frame`'s "changed" check to see; `GenQueue::set_view`
(`gen_queue.rs`) is gated even harder, on `self.last_visible == Some(view.visible)` alone, with no
cache-event consultation at all. Reproduced with `connected-terrain.html` + a real `fx-puts` client:
camera fixed at `(0, 0)`, tile `(0, 0)` (`WALK[0]`) pristine-generates, its host snapshot then
evicts it (`chunkSnapshots: 1` in `netCounters`), and `client_chunk_hash(0, 0)` reads `NotCached`
forever after even though `client::gen`'s own `GenStats` shows `requested: 25, delivered: 25,
pending: 0, inFlight: 0` (every *other* chunk in a 5x5 grid around it materialized and stayed
resident; `(0, 0)` alone never came back). The race that exposes it is real and not a test artifact:
`TerrainFeed::on_frame`'s own pristine-generation scan is independent of and typically faster than
the host round trip (camera send -> sim admit -> tick -> downlink -> apply), so a chunk entering
subscription with real overlay content is *likely*, not merely possible, to already be resident
client-side by the time its snapshot arrives. First exercised by this milestone's own wiring: M15's
`Replica`/`ClientCore` and M08b's `TerrainFeed` never shared one `TerrainStore` before `game_
instance.rs`'s restructuring above. Candidate fix shape (not attempted -- cross-cutting, touches
`world/cache.rs`/`world/terrain.rs`/`gen_queue.rs`/`client/terrain_feed.rs`, all outside this
milestone's own Files touched, each with its own extensive existing test suite this range did not
have budget to re-verify against): make `replace_overlay`'s eviction push a `CacheEvent` too, and
give `GenQueue::set_view` (or `TerrainFeed::on_frame`) a way to bypass its own `last_visible`
shortcut when a chunk it cares about was evicted since the last call, the same way `Uploader::
on_frame`'s `changed` flag already does for staging. `overlay_tile_reaches_screen` and the zero-GC
panning window below both need this fixed first. Left for the orchestrator; not attempted.

**Not done, and why (this range's own cut line).**

- **`overlay_tile_reaches_screen`**: blocked by the bug above. `connected-terrain.html` (real
  `TerrainRenderer`/`FrameLoop`, `/terrain/tiles.json`'s existing art, `fx-puts`'s new `PutsClient`)
  is built and works for everything except reading back the specific tile the bug prevents from ever
  reaching the GPU; kept in the tree (`hidden_tab_sends_no_camera_report` already uses it) rather
  than discarded, since a real renderer/art pipeline over a connected `fx-puts` client is exactly
  what this test will need once the blocking bug has a fix.
- **The zero-GC panning window** (Tests added: "zero-GC test extended: 600 frames with panning, sim
  + client isolates within budget, ring `drops === 0`") is not built. It needs the same pristine-
  generate-then-evict path a real panning scenario exercises constantly (every newly entered chunk
  with any overlay content is a candidate), so it would either measure allocation with the bug's own
  symptom baked in (chunks silently never converging) or need the fix above first to mean what it
  says. Not attempted, for the same reason `overlay_tile_reaches_screen` isn't.
- **`join_at_max_zoom_out_never_drops`** does not depend on the bug (it asserts ring `drops`/entry
  counts, never pixel or cache-residency content) and is built: `connected.spec.ts`, a shrunk
  fast-tier variant (10 ticks) plus the full scenario `@slow` (200 ticks) per the browser suite
  trip-wire (0020 §4 rung 3).
- **The browser suite's measured line** could not be taken: the delegation prompt's own Constraints
  ("Do not run `pnpm test`, `pnpm lint` or the full browser suite. I am the gate.") sit above this
  brief's own "report the measured `browser` line" ask, and this range followed the more specific,
  more recent instruction. Every new fast-tier test here was measured individually and in small
  combined groups instead (`pnpm test browser -t connected`: 5 tests, ~3.5 s; the pre-existing `sim_
  worker|workers|gc-topology|gc_sim|gc_echo|terrain` group: 46 tests, ~13 s, unchanged) -- the actual
  full-suite total against the 20 s rung-3 budget is Tyler's own measurement to take. If it is over
  budget, `poll_skips_a_spurious_tick_on_a_ring_wake` (~3.3 s alone, real time by design: it exists
  to observe real-time pacing) is the most likely single test to reconsider shortening, though doing
  so trades away some of its own discriminating margin (Deviations, next item).
- **`sim-worker.spec.ts`'s `chunksWarmed: 0` assertion needs no change.** The Planning decision that
  named it ("becomes live here, not in M15") is about `sim_admit`/`sim_build_frame` being wired at
  all (done, step 1) -- `sim-worker.html` itself never sets `host.connect`, so it still has zero
  connections and the warmer still finds nothing to warm, by the same construction that protects
  `puts_idle_100`. Verified unchanged, `pnpm test browser -t sim_worker`.

**`poll_skips_a_spurious_tick_on_a_ring_wake`'s own calibration** (Orchestrator ruling 3): pokes the
client with a fresh camera position every 15 ms for 1.5 s (`client_poll_uplink`'s own 50 ms rate
limit throttles most away, but still forces a real uplink push -- and hence a real external wake of
the sim worker -- roughly every 50 ms) and asserts `ticksRun` stays in `[0.5x, 1.35x]` of the ~30
ticks 20 Hz pacing alone would produce over that window. Calibrated by fault injection at the gate:
replacing `worker/sim.ts`'s `wokenBy === lastWokenBy` guard with an unconditional `true` measured
`ticksRun` = 47 against the correct fix's own 25-26 across three repeats (the bound's own margin,
`[15, 40.5]`, was widened from an initial `[15, 48]` that the broken version slipped under once, at
47); restoring the guard was stable across 3 further repeats. A real-time test by nature -- flagged
per this milestone's own instructions rather than silently trusted.

**Test-timing margin, not a correctness bug**: `hidden_tab_sends_no_camera_report`'s own "resume,
pan far, rejoin" phase originally used 20 `stepTick`s after `setVisibility(client, 'visible')`;
under normal load that is not always enough real ticks for a full camera-report -> admit ->
subscribe -> build_frame -> downlink round trip to land a new pristine enter, and the test was seen
to fail about 1 run in 3 at that count. Widened to 40; stable across 10 repeats after.

**Notes for later briefs.** `Replica::own_player` is hardcoded `PlayerId(1)` in `ClientInstance::
init` (single-connection assumption, Planning decisions): M28's real handshake will need to learn it
from `Host::connect`'s own return value instead, once more than one connection can exist.
`client_poll_uplink`'s own drop policy (a full uplink ring silently drops the batch, counted via
`RingProducer.recordDrop()`, never retried) is Deviations-flagged as this milestone's own reading,
not 0010's; M31's real backpressure/pacing budget may revisit it.

## Orchestrator rulings (written at the steps 1-3 gate)

**1. `puts_idle_100` is not re-blessed, and the sim worker's connection is conditional on topology,
not on a test flag.** Steps 1-3 correctly stopped rather than wire `worker/sim.ts` to accept a
connection unconditionally: `Host::connect` queues `Record::Player{Joined}`, `fx-puts::on_player`
writes real state, and `sim_hash()` would then diverge from `puts_idle_100`, which
`sim-worker.spec.ts`'s `sim_worker_steps_and_hashes` compares bit-for-bit. That golden is
**`.wasm`-authoritative and read by the native Rust test from the same file** (M13), which makes it
the repo's one continuous native-vs-wasm equality check. Re-blessing it would delete that evidence
to buy a convenience. Not done.

Instead: **the sim worker accepts a connection when the SAB set it boots with actually carries a
client link, and not otherwise.** Existing `sim`-kind pages drive ticks through `CB_SIM_STEP_REQ`
and never create a client, so they carry no link, accept no connection, and keep
`puts_idle_100`'s zero-connection topology **by construction** rather than by a flag someone has to
remember not to set. This is a topology fact, not a test gate: a real single-player page has a
client link and therefore a connection, which is exactly the production behaviour this milestone is
meant to land.

**The connected scenario gets its own new golden** (a new scenario name beside `puts_idle_100`, not
a change to it), generated by `pnpm golden` -- the only writer -- with its own spec assertion.
Adding a golden is authorised here; changing one is still mine.

**2. Two per-tick `subarray` allocations must go, and the exit criterion already requires it.**
`wrapEngineInstance.simBuildFrame`'s `raw > 0` branch allocates one `subarray` per tick per
connection, and `simSealFrame` has the same shape from M06b-era code (found at M13, never fixed).
Both are unexercised today only because no real connection exists; step 4 makes them live, and this
brief's own exit criterion is "no `subarray`/`new Uint8Array` on the per-message or per-frame paths
of both workers". Preallocate the views. The zero-GC panning window in step 6 is what proves it.

**3. The ADR 0030 `poll()` fix landed in steps 1-3 is currently inert and must not stay that way.**
`worker/sim.ts`'s `body()` distinguishes a timer wake from a ring wake by comparing each wake's
`wokenBy` against the previous call. Steps 1-3 could only prove it inert, because nothing yet wakes
that worker from outside. **Step 4 is what makes it live, so it must gain a test that fails if the
fix is removed** -- otherwise the project carries a correctness fix that nothing exercises, which is
this repo's most-repeated defect (five times: `docs/plan/14-wire-framing.md`, ADR 0029, M13's dead
counters, M09b's probe grid).
