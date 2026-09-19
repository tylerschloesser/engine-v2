# M08b: Gen workers and the client generation queue

Status: not started · After: 06b, 08 · Tyler-dependent: no

Split out of M08 (see its header). M09 waits on this brief.

## Goal
In a cross-origin-isolated page, the client worker owns a prioritised generation queue feeding its pristine cache (M07's `TerrainStore`), and one or two `gen`-role workers serve it over `genRequest`/`genResult` with no `postMessage` and no allocation in steady state. Driven by the camera block, generation fills visible chunks first, then ring 1, then ring 2; results are identical with one or two workers; the gen and client isolates pass the zero-GC assertion.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0008-chunk-generation.md` (§2 first two table rows, §3 last two sentences, §4, §5)
3. `docs/decisions/0015-threads-memory-and-topology.md` (§1 client and worldgen rows, §2 ring shape and wake-ups, §5 gen arena)
4. `docs/decisions/0014-js-wasm-boundary.md` (§4 copy-in/copy-out rules, §6 gen-role panic)

Mine from spikes: `spikes/cross-origin-sab/src/bench-worker.ts` (`wasmU8.set(slotView, off)` drain through per-slot views), `spikes/zero-gc-webgpu/public/worker.js` (`Atomics.wait` loop). Rules that apply: `.claude/rules/hot-paths.md`, `.claude/rules/determinism.md`.

## Scope
- Rust `GenQueue`: ring classes, distance-to-look-ahead ordering, re-sort triggers, in-flight cap, cancellation, retention touches, all in preallocated storage (0008 §4–5).
- `view::lookahead_chunks` (the look-ahead function 0008 §5 says generation shares with 0010 subscriptions), `view::visible_rect`, `view::nearest_first`.
- `client::TerrainFeed`: queue + record encode/decode, operating on a borrowed `TerrainStore`; client-role exports `gen_take`, `gen_deliver`, `client_gen_stats`, `client_chunk_hash`; the queue step inside client-role `frame`.
- Record layouts of `genRequest` and `genResult`.
- TypeScript: the `gen` worker kind body, the client worker's gen pump, the `genWorkers` default rule (0008 §2).
- `engine/test` hooks; browser tests including the zero-GC assertion over the gen and client isolates.

## Non-scope
- Camera integration and input: M11 (tests drive the block with M06b's `setCamera`). Texel conversion and the upload ring: M09 (it consumes `CacheEvent`s, `slot_of`, `copy_chunk`). Subscriptions, chunk enter/leave, overlays arriving before generation: M15. The host warmer: M13.
- Gen-instance re-instantiation after a trap (0014 §6): M37; this brief supplies `GenQueue::requeue_in_flight(worker)` and nothing else.
- Headless clients under Node (M27) have no gen workers; their client instance generates synchronously on miss (0008 §2 second row) through M07.
- Chunk sizes other than the default in the browser topology (Planning decisions 6).

## Files, packages and crates touched
- `packages/engine/crates/engine/`: `src/gen_queue.rs`, `src/view.rs`, `src/client/terrain_feed.rs`, `src/abi/registry.rs` (four exports, `RegionId::GenIn`), `tests/gen_queue.rs`.
- `packages/engine/` TS: `src/worker/gen.ts` (fills M06b's stub), `src/worker/client-gen.ts` (called from `worker/client.ts`), `src/abi.ts`, `src/test.ts`, `tests/unit/gen-record.test.ts`, `tests/browser/gen.spec.ts`, `tests/browser/pages/{gen.html, src/gen.ts}`, `budgets.json` keys.
- `packages/engine/fixtures/worldgen/`: client-role arm of its `Instance` (a `TerrainStore` over `Pristine<FixtureGen>` + `TerrainFeed`).

## Seams
**Provides:**
- Rust: `engine::gen_queue::{GenView { visible: ChunkRect, center: WorldPos, velocity: (i32, i32) /* Q24.8 per second */ }, GenQueue}` with `GenQueue::new(ChunkDims, workers: u32)`, `set_view(&GenView, &TerrainStore) -> bool` (true when it re-sorted), `take(worker: u32) -> Option<ChunkCoord>`, `complete(worker: u32, ChunkCoord)`, `requeue_in_flight(worker: u32)`, `pending()`, `in_flight()`, `stats() -> GenStats { requested, dispatched, delivered, cancelled, requeued, pending, in_flight }`.
- `engine::view::visible_rect(center: (f64, f64), half_extent_tiles: (f32, f32), ChunkDims) -> ChunkRect`; `view::lookahead_chunks(visible: ChunkRect, velocity: (i32, i32), ChunkDims, out: &mut [ChunkCoord; 2]) -> usize` (M15 uses it for subscriptions); `view::nearest_first(ChunkRect, center: TilePos, out: &mut [ChunkCoord]) -> usize` (offered to M13's `host::warm`).
- `engine::client::TerrainFeed`: `new(ChunkDims, workers)`, `on_frame(&CameraBlock, &TerrainStore)`, `take(worker, out: &mut [u8; 16]) -> bool`, `deliver(worker, record: &[u8], &mut TerrainStore) -> Status`, `stats()`. M15's client core embeds it beside the replica's `TerrainStore`.
- ABI, role `client` (added by M02's rule; `ABI_VERSION` bumped once): `gen_take(worker: u32) -> u32` (1 = a 16-byte request record is at offset 0 of `Result`, 0 = nothing to dispatch), `gen_deliver(worker: u32, len: u32) -> status` (the result record is in `GenIn`), `client_gen_stats() -> status` (seven `u32` into `Result`), `client_chunk_hash(cx: i32, cy: i32) -> status` (FNV of the cached effective slab as lo, hi `u32` in `Result`; returns the new appended code `Status::NotCached` when the chunk is not resident). `RegionId::GenIn` (appended id; `16 + slab_bytes`).
- Records (little-endian): request, 16 bytes `[cx i32][cy i32][0 u32][0 u32]`; result, `16 + slab_bytes`: the same header followed by the tile bytes of `GenOut`.
- TS: `genWorkerCount(hardwareConcurrency: number, requested?: number): number`; `engine/test`: `gen.stats(client)`, `gen.idle(client): Promise<void>` (steps frames until `pending == 0 && in_flight == 0`, then `untilQuiescent`), `gen.chunkHash(client, cx, cy): Promise<string | null>`.

**Consumes:** M06: `RingProducer`/`RingConsumer` (`tryClaim`, `slotView`, `commit`, `peek`, `popInto`, `release`, `stats`), `SabSet.genRequest[i]`, `SabSet.genResult[i]` and their capacities, `ControlBlock` words `W_WAKE`, `W_ACK` (gen: jobs finished), `WORKER_GEN0/1`, `WORKER_CLIENT`. M06b: `run()` kinds with the `gen` stub, `runBlockingLoop`, `shell.fatal`, the setup message (`kind`, `index`, `sabs`, `config`), `ClientOptions.genWorkers`, `engine::client::CameraBlock`, `RegionId::Camera`, the client-role `frame(t_ms)` export and the client kind body that copies the camera block in, `setCamera`, `untilQuiescent`, `parkWorkers`. M08: `Worldgen`, `Pristine<W>`, `GenCore`, `gen_chunk`, `RegionId::GenOut`, `fx-worldgen`, config keys `seed`/`params`. M07: `TerrainStore` (`insert_pristine`, `touch`, `is_cached`, `slot_of`, `copy_chunk`), `ChunkRect`, `ChunkDims`, `WorldPos`. M02: `Instance`, the ABI rule, `Result` region, `EngineInstance.call1/call2`, `region()`. M03/M04: fixture-app page pattern, `stepFrame`, the zero-GC assertion and isolate names, `budgets.json`.

## Planning decisions
1. **Record layouts** (M06 sized the rings and left the records to this brief): as under Provides. The slab travels inside the `genResult` record, so there is no separate slab pool, no slab index and no allocator on either side. The 16-byte header keeps the tile bytes 8-aligned and leaves two reserved words.
2. **The queue is Rust in the client instance; the pump is TypeScript.** Priority needs `TerrainStore` (what is cached) and later the replica (M15), both in WASM; rings are SABs, which only JS can touch (0015 §4). Per client wake, after `frame`: for each worker, drain `genResult[i]` (`popInto` the `GenIn` view, `gen_deliver(i, len)`), then while `tryClaim()` succeeds and `gen_take(i)` returns 1 (in that order, see 5), copy 16 bytes from `Result` into the slot, `commit()` (which wakes the gen worker through its `W_WAKE`). The gen worker's producer on `genResult[i]` is constructed with the client's wake word, so a finished chunk wakes the client (0015 §2).
3. **The view comes from the camera block inside `frame`,** which M06b already delivers to the client instance: `visible_rect(centre, half_extent_tiles)`, velocity converted once to Q24.8. No extra export is needed and M11 changes nothing here. Float use is confined to `view::visible_rect`; the queue itself is integer-only.
4. **Retention is LRU plus `touch`.** On every re-sort the queue touches each cached chunk inside ring 3, so LRU order evicts only beyond the retention bound of 0008 §5 without a second mechanism, and a visible chunk's GPU page slot (0018: slot = slab index) is never evicted under it.
5. **A full `genRequest` is backpressure** (0015 §2): the pump asks `gen_take` for a job only once it holds a free slot (claim first, take second; an uncommitted claim reserves nothing in M06's ring, and if that turns out false use its `pushed − popped` counters instead), so a job is never popped without a slot; `drops` stays 0 and the test asserts it. A gen worker that finds `genResult` full retries on its next wake and does not start another job.
6. **Default chunk size only, in the browser topology (0024 §9).** `SabSet` is created on main before any instance exists, with M06's fixed `genResult` slot of 16 + 4,096 bytes. The gen worker checks `region(GenOut).len + 16 <= slotBytes` at setup and calls `shell.fatal` with a readable message otherwise. Carrying `chunkBits` in `game.json` so main can size the ring is left to the first game that changes `CHUNK_BITS`; the Rust side is already size-agnostic.
7. **Worker count cannot change results** (0008 §2): asserted by comparing `client_chunk_hash` over the whole generated set with 1 and 2 workers.
8. **`stats` exact values are budgets.** For the scripted join at the view clamp and a scripted pan, `GenStats.requested`/`delivered`/`cancelled` are asserted exactly against `budgets.json` (`genJoinChunks`, `genPanChunks`): deterministic counters in the fast tier, per 0020 §9.

## Order of work
1. `view.rs` and `gen_queue.rs` natively, with all queue tests. 2. `TerrainFeed`, the four exports and `GenIn` by the ABI rule; `fx-worldgen` client arm; `frame` calls `on_frame`. 3. `worker/gen.ts`: build views once (`GenOut` view, per-slot views come from M06), loop = wait on `W_WAKE` → pop request → `gen_chunk` → claim result slot → header + `slotView.set(genOutU8, 16)` → commit → bump `W_ACK`; honour yield/park via `runBlockingLoop`. 4. `worker/client-gen.ts` pump, called from the client kind body after `frame`. 5. `genWorkerCount` wired to `ClientOptions.genWorkers`. 6. `engine/test` hooks and `gen.html`. 7. Browser tests, then the zero-GC test. 8. `packages/engine/CLAUDE.md`: gen link in five lines (who owns which end, record layout, where the pump runs); extend `hot-paths.md` globs with `crates/engine/src/{gen_queue,view}.rs` and `src/client/**`.

## Tests added
Rust: `queue_orders_ring_class_then_distance`, `queue_resorts_only_on_chunk_or_zoom_change`, `queue_in_flight_cap_per_worker`, `queue_cancels_undispatched_beyond_ring3`, `queue_keeps_late_results`, `queue_generation_superset_of_lookahead`, `queue_counts_at_view_bound` (generated and retained set sizes derived from the view clamp, 0008 §5), `queue_requeue_in_flight`, `queue_touches_retained`, `no_alloc_gen_queue`, `lookahead_caps_extra_chunks`, `visible_rect_negative_and_edge`, `nearest_first_order`, `feed_record_roundtrip`, `feed_rejects_bad_len`. TS unit: `gen record layout`, `genWorkerCount rule`. Browser (`fx-worldgen`, `gen.html`): `gen: visible before ring 1 before ring 2` (delivery order observed through `stats` between single stepped frames with the gen worker parked and resumed), `gen: one and two workers give equal chunk hashes`, `gen: drops 0, mem_grows 0, stats exact`, `gen: oversize slab is a readable fatal`, `gen: zero-GC over a scripted pan` (gen and client isolates, M04 assertion).

## Exit criteria
- [ ] All tests above pass by name.
- [ ] `gen: zero-GC over a scripted pan` holds the gen-worker and client-worker budgets of 0016 with no `MinorGC`/`MajorGC` in the window and `memGrows() == 0` for both instances.
- [ ] `grep -n "subarray\|new Uint8Array\|new Int32Array\|postMessage" packages/engine/src/worker/gen.ts packages/engine/src/worker/client-gen.ts` shows only setup-time code.
- [ ] `abi registry`, import-allowlist and target-feature tests pass for every fixture.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t queue` · `pnpm test rust -t feed` · `pnpm test unit -t gen` · `pnpm test browser -t "gen:"` · `pnpm test && pnpm lint`.

## Budgets
`PRE-PLAN.md` §7 rows: allocation per isolate (gen and client workers; the zero-GC test); memory per instance (gen arena of 0015 §5, `W_MEM_GROWS == 0`); chunk generation, join case (`genJoinChunks` exact in `budgets.json`). Wall-clock ms per chunk stays with M08's benchmark.

## Context artifacts
Updates `packages/engine/CLAUDE.md`; extends `hot-paths.md` globs (created by M02) with `packages/engine/crates/engine/src/gen_queue.rs` and `packages/engine/crates/engine/src/client/**`, both of which exist after this milestone (M01's `context-artifacts` test fails on a glob that matches no file). No skill.

## Manual device checks
none here; the first on-device run of a worker/SAB page is M11's checklist, over M03's `pnpm device:serve --tunnel`.

## Deviations
(filled in during Phase 3)
