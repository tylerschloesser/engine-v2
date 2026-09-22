# M15b: In-browser `Connection`, worker plumbing, replica to renderer

Status: not started · After: 11, 15 · Tyler-dependent: no

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
- [ ] All tests above pass.
- [ ] No `subarray`/`new Uint8Array` on the per-message or per-frame paths of both workers (the M04 assertion is the proof; a grep is the hint).
- [ ] `pnpm test` and `pnpm lint` are green.

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
(filled in during Phase 3)
