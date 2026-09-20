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

**Consumes:** M06: `RingProducer`/`RingConsumer` (`tryClaim`, `slotView`, `commit`, `peek`, `popInto`, `release`, `stats`), `SabSet.genRequest[i]`, `SabSet.genResult[i]` and their capacities, `ControlBlock` words `W_WAKE`, `W_ACK` (gen: jobs finished), `WORKER_GEN0/1`, `WORKER_CLIENT`. M06b: `run()` kinds with the `gen` stub, `runBlockingLoop`, `shell.fatal`, the setup message (`kind`, `index`, `sabs`, `config`), `ClientOptions.genWorkers`, `engine::client::CameraBlock`, `RegionId::Camera`, the client-role `frame(t_ms)` export and the client kind body that copies the camera block in, `setCamera`, `untilQuiescent`, `parkWorkers`. M08: `Worldgen`, `Pristine<W>`, `GenCore`, `gen_chunk`, `RegionId::GenOut`, `fx-worldgen`, config keys `seed`/`params`. M07: `TerrainStore` (`insert_pristine`, `touch`, `is_cached`, `slot_of`, `copy_chunk`), `ChunkRect`, `ChunkDims`, `WorldPos`. M02: `Instance`, the ABI rule, `Result` region, `EngineInstance.call1/call2`, `region()`. M03/M04: fixture-app page pattern, `stepFrame`, the zero-GC assertion and isolate names, `budgets.json`. M06b also owes: the `gen` stub's `W_ACK`-on-every-wake store to keep (or replace with an equivalent) once real work fills `body()`, that a wake during `park()` is not replayed on `resume()`, `lastSeen` from `Shell.observeWake()` on any re-entry to `runBlockingLoop`, and `parkWorkers` before `__pageReady` on a new zero-GC page (`docs/plan/06b-workers-and-spawn.md`, Deviations "Notes for later briefs").

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

### Orchestrator decisions before the start (2026-09-20)

- **`W_ACK` on a gen worker keeps M06b's meaning, not "jobs finished".** Consumes and Order of work step 3 read `W_ACK` as a finished-jobs counter, but M06b's `asHarness(client).stepTick` wakes every `sim`/`gen` worker and spins until each worker's `W_ACK` equals the wake value it issued, and the `topology` and `echo` zero-GC pages run on that. The gen body therefore still ends every pass with the stub's `W_ACK = wokenBy` store (after any job work of that pass). Finished jobs are counted where they are consumed: `GenStats.delivered` through `client_gen_stats`, and the `genResult` ring's own counters. "Bump `W_ACK`" in step 3 means that store.
- **`ABI_VERSION` goes 3 → 4** (M08 made it 3).
- **The pump runs on every client wake of every page,** including `topology` and `echo` over `fx-hash`, whose client role has no `TerrainFeed`: `gen_take` must cost nothing and return 0 there, and those pages' budgets (strict 8 B/frame on `client` and `gen0`) do not move.

### Steps 1-5 (this session)

Split at the step-5 boundary the brief names ("stop at a step boundary (after step 2, 5 or 6)"):
much done (the whole Rust core, the ABI, and the TS worker plumbing, all green), and step 6 turned
out to need a real architectural decision (below) rather than a wire-up, so it is left for a fresh
session with full context rather than rushed. Commits `2c0d915`..`3f7b381`, one per step, `pnpm
format` before each. `pnpm test && pnpm lint` green at `3f7b381`: `rust pass 128 tests 0.4s/10s`,
`unit pass 86 tests 1.3s/3s`, `wasm pass 32 tests 1.3s/7s`, `browser pass 52 tests 17s/25s`
(unchanged from `e5bbc10`'s baseline: nothing in steps 1-5 touches a browser page yet); `biome`/
`rustfmt`/`clippy`/`tsc` all pass.

**Step 1 (`2c0d915`): `view.rs`, `gen_queue.rs`, all queue tests.**
- `engine::view::{visible_rect, lookahead_chunks, nearest_first}` exactly as Seams, with one
  clarification each, both because 0008 §5 does not pin the algorithm down further and a concrete
  one was needed to write a passing test: `lookahead_chunks` returns one chunk per axis with
  nonzero velocity, at `visible.expanded(1)`'s own mid row/column, just past that ring's edge on
  that axis (never more than 2, matching "at most 2 extra chunks in the direction of travel"
  literally). `nearest_first(rect, center: TilePos, out)` treats `center` as already being in the
  same coordinate space as `ChunkCoord` (both are plain `i32` pairs with no inherent scale): a
  caller holding a genuine tile-space position must convert with `dims.chunk_of(..)` first. Neither
  reading renames a seam (signatures are exactly as specified); flagged here since M13's `host::
  warm` and M10's subscriptions are the real consumers and neither exists yet to confirm the choice
  against.
- `engine::gen_queue::GenQueue` exactly as Seams (`GenView`, `new`, `set_view`, `take`, `complete`,
  `requeue_in_flight`, `pending`, `in_flight`, `stats` -> `GenStats`). Internals: `pending: Vec<Entry>`
  reserved to 512 at `new` (never reallocated after: `Entry { chunk, ring: u8, dist: u64 }`, ring
  0/1/2), `in_flight: Vec<[Option<ChunkCoord>; 2]>` sized to `workers`. `set_view` re-sorts only when
  `view.visible` differs from the last call (velocity alone never re-sorts, matching the brief's own
  "crosses a chunk boundary or a zoom change" wording); on a re-sort it cancels pending entries
  outside `visible.expanded(3)`, reclassifies and re-distances survivors, enqueues newly-entering
  chunks from `visible.expanded(2)` plus up to 2 look-ahead chunks (treated as ring 1, per 0008 §5),
  and touches every still-cached chunk within `visible.expanded(3)` to protect it from the cache's
  own LRU. `take`/`complete`/`requeue_in_flight` are plain Vec operations (`remove(0)`/`insert(0,
  ..)`), never reallocating past the reserved capacities. `GenStats` fields are cumulative counters
  (`requested`/`dispatched`/`delivered`/`cancelled`/`requeued`, matching `RingStats`' `pushed`/
  `popped`/`drops` convention) plus a `pending`/`in_flight` snapshot.
- **Tests**: all 9 names under Tests added live in `tests/gen_queue.rs` (public-API integration
  tests: a test-only `drain_all` helper repeatedly `take`s and immediately `complete`s to inspect
  the queue without a private-field accessor, since the in-flight cap never blocks a paired
  take/complete cycle). `no_alloc_gen_queue` lives in its own binary, `tests/no_alloc_gen_queue.rs`
  (mirrors `tests/no_alloc_terrain.rs`'s own reasoning: a `#[global_allocator]` only counts
  allocations in the binary that installs it, and inline unit tests share the crate's lib test
  binary, which installs none) -- an inline version in `gen_queue.rs` would have silently measured
  nothing. `view.rs`'s 3 tests are inline (`visible_rect_negative_and_edge`, `lookahead_caps_extra_
  chunks`, `nearest_first_order`), matching the file layout of every other small Rust module here.
  `queue_counts_at_view_bound` also asserts the closed-form retention count (225 = 15x15) directly
  via `ChunkRect::iter().count()`, not just the queue's own `pending()`. `rust` suite: 112 -> 125.

**Step 2 (`ef786dd`): `TerrainFeed`, the four client ABI exports, `fx-worldgen`'s client arm.**
- `engine::client::TerrainFeed` exactly as Seams (`new`, `on_frame`, `take`, `deliver`, `stats`),
  plus `chunk_hash(&self, store: &TerrainStore, chunk) -> Option<u64>` (not named by Seams' one-line
  list, but needed by both `client_chunk_hash` and `gen: one and two workers give equal chunk
  hashes`; `None` when the chunk is not resident, never materializes it) and `const fn gen_in_bytes
  (dims) -> usize` (the `GenIn` region size every client-role `init` must declare: `16 +
  dims.slab_bytes()`). A `RefCell<Vec<Tile>>` scratch slab, reserved once in `new`, backs both
  `deliver`'s decode and `chunk_hash`'s read (`.claude/rules/hot-paths.md`'s glob now covers
  `src/client/**`, Order of work 8 -- extended in step 1's commit message but the glob line itself
  is step 8's, still open, see below).
- Q24.8 conversion (Planning decisions 3): `center`/`velocity` are converted once per `on_frame`
  call from the camera block's `f64`/`f32` units (`round()` then a saturating `as i64`/`as i32`
  cast, both allowed float ops under `.claude/rules/determinism.md`); the queue itself never touches
  a float, matching the brief's "Float use is confined to `view::visible_rect`" -- true of
  `TerrainFeed`'s own Q24.8 helpers too, which are one `round()` each, not `visible_rect` itself.
- ABI: `Instance::{gen_take, gen_deliver, client_gen_stats, client_chunk_hash}` added with the
  defaults Seams specifies (`gen_take` -> `false`, the rest -> `Status::Unsupported`); `RegionId::
  GenIn = 9` (`REGION_COUNT` 9 -> 10); `Status::NotCached = 9` (appended after `Unsupported = 8`);
  `ABI_VERSION` 3 -> 4 in both `registry.rs` and `abi.ts`. `abi::gen_take` never returns a `Status`
  (its own return type is `u32`, 0 or 1 only): a wrong-role or uninitialised instance also answers
  0, matching "gen_take must cost nothing and always answer" from the orchestrator's own decision.
  `client_gen_stats` writes exactly 28 bytes (7 `u32`, declaration order of `GenStats`) into
  `Result`; `client_chunk_hash` writes 8 bytes (lo, hi of the FNV hash) or returns `Status::
  NotCached`.
- `CameraBlock::for_test(centre, velocity, half_extent_tiles)`, gated `#[cfg(any(test, feature =
  "testing"))]`, added to `client/camera.rs`: its `_reserved0`/`_reserved1` fields are private to
  that module, so a sibling module's test (`terrain_feed.rs`'s `feed_record_roundtrip` et al.)
  cannot build a `CameraBlock` literal any other way. Not named by Seams; a small, test-only,
  feature-gated addition.
- `feed_record_roundtrip`/`feed_rejects_bad_len` (named by Tests added) plus one more,
  `feed_chunk_hash_none_until_cached` (not named, added because `chunk_hash` itself is not named by
  Seams either), all inline in `terrain_feed.rs`. `rust` suite: 125 -> 128.
- `fx-worldgen`'s `FixtureGen` is now `{ role: FixtureRole }`, `FixtureRole::{Gen(GenCore<Self>),
  Client { terrain: Box<TerrainStore>, feed: TerrainFeed }}` (boxed: `clippy::large_enum_variant`,
  `TerrainStore` is 352 B). `Instance::init` matches on `role` instead of the old unconditional
  `if role != Role::Gen { return Err(BadConfig) }`; `Role::Sim` still rejected. `Config` gained
  `gen_workers: u32` (`#[serde(default = "default_gen_workers")]`, default 1), read only by the
  client arm, to drive `gen: one and two workers give equal chunk hashes` (step 7, not yet written).
  Client-role cache capacity is `CacheCapacity::Chunks(1024)` (0007 §8's own default client cache
  size). `frame`/`gen_take`/`gen_deliver`/`client_gen_stats`/`client_chunk_hash` all match on
  `self.role`, `Status::Unsupported`/`false` on the wrong arm (never reached through the ABI, which
  role-checks first, but required for the match to be exhaustive).

**Step 3 (`78f0876`): `worker/gen.ts`.**
- Built once at setup: the `GenOut` region (`inst.region(RegionId.GenOut)`, **nullable** -- see
  below), a `RingConsumer` over `sabs.genRequest[ordinal]`, a `RingProducer` over `sabs.genResult
  [ordinal]` woken with `{ control: shell.control, index: WORKER_CLIENT }` (Planning decisions 2:
  "the gen worker's producer on `genResult[i]` is constructed with the client's wake word").
  `ordinal = shell.index - WORKER_GEN0` (0 or 1): the control-block worker index is not the array
  index into `sabs.genRequest`/`genResult`, not stated explicitly anywhere in Seams/Consumes.
  `readI32LE`/`writeI32LE`: top-level named functions (not closures), since the 16-byte header is
  read/written by hand rather than through a second, redundant `Int32Array` view over the same ring
  slot (the existing `Uint8Array` `slotView` is enough and needs no new view type).
  **Loop order, per pass**: claim a genResult slot *before* touching a request (`results.tryClaim()`
  first; abandoning an unused claim is free, M06 Deviations: "an uncommitted claim reserves nothing
  in M06's ring") -- this is what actually implements Planning decisions 5's "a gen worker that
  finds `genResult` full retries on its next wake and does not start another job", even though the
  Order-of-work bullet's own step list reads "pop request -> gen_chunk -> claim result slot" (which
  would start a job before knowing there is anywhere to put its result). Read the prose requirement
  as authoritative over the step list's ordering.
  **`GenOut` is `null`-safe, not `requireRegion`-guarded**: `fx-hash`'s gen role never declares
  `GenOut` (it has no `Worldgen`), and `gc-topology`/`gc-echo` still spawn a `gen0` worker over it by
  default (0008 §2's "1 worker by default"). A `requireRegion`-style unconditional throw here broke
  those two existing zero-GC pages outright (`gen worker: GenOut region required...` as a page
  error) -- caught by the *existing* `pnpm test` browser suite, not a new test of this brief's own;
  fixed by making the whole ring loop conditional on `genOut !== null`, which is always correct
  there since the client's own `gen_take` always answers 0 without a `TerrainFeed`, so no request
  (hence no result) can ever exist to process. An oversize `GenOut` vs. the configured `genResult`
  slot is a **thrown `Error` in `setup()`**, not `shell.fatal(...)`: a live `Shell` that calls
  `fatal()` and then still returns a `{ body, timeoutMs }` would still enter `runBlockingLoop`, whose
  first `Atomics.wait` runs *before* it checks `shell.stopped()` -- with `timeoutMs = Infinity`, that
  blocks forever waiting for a wake that will never come from a worker main already considers dead.
  Throwing lets `worker.ts`'s existing `.then(resolveOnReady, rejectCallsFatal)` handle it the safe
  way (no loop ever starts), the same pattern `requireRegion` (a missing-region setup error) already
  used in every other kind file.
- Revises `sab/layout.ts`'s `RING_DEFAULTS.genRequest`/`genResult` (M06's own allowance, "an owning
  milestone may revise its row"): `slotBytes` is the *ring's own* total per-slot size (`sab/ring.ts`'s
  8-byte header + payload), and the payload must hold a whole record in **one slot** (the client
  pump and the gen worker both use the slot-level `tryClaim`/`commit`/`peek`/`slotView` API, never
  `tryPush`/`popInto`'s spanning form, for the request/result records themselves -- `popInto` is
  still used to *drain* a result into the `GenIn` region, since that is a message-level read of
  whatever the gen worker's `commit()` published as a one-part message). `genRequest`: `slotBytes:
  24` (8 + 16-byte record). `genResult`: `slotBytes: 4120` (8 + 16 + 4,096-byte record at the
  default chunk size). Both `slots: 8` (M06 had 64; the in-flight cap is 2/worker, so 8 is generous
  headroom, not a bottleneck, and shrinks `sabBytesTotal()` back down after the payload growth).
  `layout.sab_total_under_budget` (M06's own test) still passes unchanged -- not re-measured exactly
  in this session; left for step 8's CLAUDE.md/budgets pass or the next session to record the new
  number, since nothing here changed the *assertion*, only the bytes it measures.

**Step 4 (`9afbd32`): `worker/client-gen.ts` pump, wired into `worker/client.ts`'s `body()`.**
- `createGenPump(inst, control, sabs, genIn, result)` builds one `{ requests: RingProducer, results:
  RingConsumer }` pair per **configured** gen worker (`sabs.genRequest.length`, which is 0, 1 or 2
  depending on `genWorkers` -- zero gen workers makes `pump()` a 0-iteration no-op, handled for
  free, not specially). `pump()` itself: per worker, drain `genResult[i]` into `genIn.u8` via
  `popInto` and `gen_deliver(i, len)` (skipped entirely when `genIn` is `null` -- see below), then
  claim a `genRequest[i]` slot, `gen_take(i)`, copy the 16-byte answer out of `Result` with `sab/
  bytes.ts`'s `copyBytes` (not `.set()`: `Result` is 64 bytes, the record is a 16-byte sub-range,
  and `TypedArray.set` cannot express a source-side sub-range without `subarray()`, which is banned
  on a hot path -- the exact reasoning `sab/bytes.ts`'s own doc comment already gives for why it
  exists), and `commit()`.
- **Called unconditionally every wake**, not gated by `frameReq !== lastFrameReq` the way `frame()`
  itself is: the orchestrator's own decision ("the pump runs on every client wake of every page")
  requires this, since a `genResult` producer wakes the client independently of a new frame request
  (Planning decisions 2), and `gc-topology`/`gc-echo`'s own budgets must not move regardless.
- **`genIn: RegionView | null`**, read once at setup via `inst.region(RegionId.GenIn)` (no
  `requireRegion`): `fx-hash`'s client role never declares it either (same reasoning as step 3's
  `GenOut`). When `null`, only the drain half of `pump()` is skipped; the take half still runs every
  worker (`gen_take` answers 0, the claim is abandoned) -- this is the concrete shape of "`gen_take`
  must cost nothing and return 0 there" from the orchestrator's decision.
- `worker/client.ts`'s `body()` gained one `requireRegion(inst, RegionId.Result, 'Result')` call at
  setup (Result is unconditionally declared for every role by `try_init`, so this never actually
  throws; kept only so `genPump`'s constructor gets a non-nullable `RegionView`, matching `gen.ts`'s
  own `EngineInstance`/`RegionView` null-safety discipline) and one `genPump.pump()` call at the end
  of `body()`.

**Step 5 (`3f7b381`): `genWorkerCount` wired to `ClientOptions.genWorkers`.**
- `export function genWorkerCount(hardwareConcurrency: number, requested?: number): number` in
  `client.ts`, replacing the previous private `defaultGenWorkers()` (which read `navigator.
  hardwareConcurrency` directly and took no override -- `createClient` already did `options.
  genWorkers ?? defaultGenWorkers()` inline, effectively half of this seam, before this milestone).
  `requested`, when given, **overrides the hardware-based default entirely** (not additive/capped
  against it) and is clamped to `[1, MAX_GEN_WORKERS]` (`sab/layout.ts`'s own constant, 2): a
  `genWorkers: 0` or a negative value would otherwise silently build a `TerrainFeed`-less client
  (`sabs.genRequest.length === 0`) with no readable error, and a `genWorkers` above 2 would ask for
  more workers than `createSabSet`'s own worst-case sizing (and therefore the whole-tab SAB budget)
  assumes. Test: `genWorkerCount rule`, `src/gen-worker-count.test.ts` (`unit` 85 -> 86).

### What remains (steps 6-8), and why this session stopped here

**Step 6 (`engine/test` hooks, `gen.html`) needs an architectural decision this session did not
make, not a wire-up.** `gen.stats(client)`, `gen.idle(client)` and `gen.chunkHash(client, cx, cy)`
(Seams, under "TS: ... `engine/test`") must run in the **page's own main-thread JS** (`engine/test`
is bundled into and executed by a browser page via `page.evaluate`, per `packages/engine/CLAUDE.md`'s
own description of the seam and every existing `engine/test` function's shape: `parkWorkers`,
`stepFrame`, `asHarness`, all pure main-thread `Atomics`/SAB-only code, since main never
instantiates WASM, `main.no_wasm_instantiate`). But `client_gen_stats`/`client_chunk_hash` are ABI
exports whose *answers* land in the **client worker's own non-shared WASM memory** (0015 §4: no
shared WASM memory, ever) -- main cannot call them and cannot read that `Result` region directly, by
construction, the same way it cannot read any WASM region. Existing debug tooling
(`self.__engineInstance`, M06b) sidesteps this only via Playwright's `worker.evaluate()` (a Node/CDP
API, unusable from inside `engine/test`'s own browser-side code) and is gated behind
`message.test`, i.e. explicitly not a production-shaped channel `engine/test` could piggyback on
for a real answer.

The two seams need different fixes and neither is a small wire-up:
- `gen.stats`/`gen.idle` want a value the client worker **already recomputes every wake** (`GenStats`
  is 28 bytes) -- the natural fix follows the existing `W_MEM_PAGES`/`W_MEM_GROWS` precedent
  (`worker/instantiate.ts`'s `publishMemory`: the worker `Atomics.store`s a small published copy
  into shared memory after every relevant call, main reads it with a plain load, no message). That
  means a **new small shared region**: either widen `SabSet` with a `genStats: SharedArrayBuffer`
  (a real, if small, seam addition -- `sab/layout.ts`, `sabBytesTotal()`, `budgets.json`'s SAB-total
  key all move) or reuse control-block words (there are only 3 global reserved words left, `CB_TEST_
  CONTROL` having taken the 4th in M06b, and 28 bytes needs 7; per-worker reserved words are all
  spoken for). Either is a real Planning decision with a measured-bytes consequence, not a
  five-minute change.
- `gen.chunkHash(client, cx, cy)` is worse: it needs a **request/response round trip** for an
  arbitrary `(cx, cy)` chosen by the test, and no such channel exists anywhere in the codebase --
  production `postMessage` is strictly setup/fatal/resume/stop (0015 §2, held to exactly that by
  `main.no_wasm_instantiate`'s sibling scan and this brief's own exit criterion grepping `gen.ts`/
  `client-gen.ts` for `postMessage`). A worker cannot process an incoming message while blocked in
  `Atomics.wait` (0015 §2: "a blocked worker receives no events"), so even a new message type would
  need the worker parked first -- at which point it is arguably cheaper and more consistent with
  existing test-only tooling (`resumeWorkers`/`parkWorkers` already use real `postMessage` from test
  code) to add one more test-only message pair (`{ type: 'query-chunk-hash', cx, cy }` / a reply)
  than to build a general polling channel for one query shape.

Neither path was started; inventing either unilaterally this late in a large session risked a
rushed, under-verified answer to exactly the kind of "exact seam shape" this brief's own Deviations
discipline asks to be pinned down carefully. Flagged as a **decision needed** below rather than
guessed at.

Steps 6 (the rest: `worker/gen.ts`'s own zero-GC discipline is already in place from step 3, but
`gen.html`/`src/gen.ts` were not started), 7 (all of `tests/browser/gen.spec.ts`, including the
zero-GC test -- `docs/plan/06b-workers-and-spawn.md`'s own Deviations record this class of test as
needing multiple fix rounds even with full context) and 8 (`packages/engine/CLAUDE.md`, `hot-
paths.md`'s globs: `crates/engine/src/{gen_queue,view}.rs` and `src/client/**` still need adding,
mentioned in step 2 above but not yet done) are entirely unstarted. `budgets.json` gained no keys
yet (`genJoinChunks`, `genPanChunks`, the allocation-per-isolate rows for `gen0`/`gen1`/`client`
under real gen traffic): none of the browser tests that would measure them exist.

### Decisions needed

1. **The `gen.stats`/`gen.idle`/`gen.chunkHash` channel** (above): a new small `SabSet` field
   published every client wake, versus a test-only request/response `postMessage` pair for the
   chunk-hash query specifically, versus some other shape entirely. Blocks step 6 and everything
   after it.
2. Everything else in Planning decisions and Seams was followed as written; no accepted decision
   changed and no seam under **Provides** already committed (steps 1-5) was renamed.

### Notes for the next session

- Start at step 6 with the decision above resolved first (or escalated again if the orchestrator
  wants a different shape); `gen.html`/`src/gen.ts` follow the existing page-script pattern
  (`tests/browser/pages/<name>.html` + `src/<name>.ts`, `window.__pageReady = true` at the end,
  `fixtureWasm('worldgen')` since this is the first browser page over `fx-worldgen` rather than
  `fx-hash`).
- `worker/gen.ts` and `worker/client-gen.ts` are already written to the hot-paths discipline the
  zero-GC test (step 7) will check: no `subarray`/`new Uint8Array`/`new Int32Array`/`postMessage` in
  either file outside setup (grepped by hand this session; the exit criterion's own grep line should
  still be run once `gen.html` exists to be measured against).
- `fx-worldgen`'s client-role cache is `CacheCapacity::Chunks(1024)`; a browser test driving it
  through the full view-bound generation set (169 chunks) plus a pan has ample headroom before any
  eviction pressure would even begin to interact with `queue_touches_retained`'s own logic in a
  visible way.
- `RING_DEFAULTS.genRequest`/`genResult`'s new sizes (24 B x 8 slots, 4,120 B x 8 slots) are sized
  for the **default chunk size only** (0024 §9, this brief's own Non-scope): a game with a different
  `CHUNK_BITS` needs a different `genResult` slot, which `sab/layout.ts`'s own doc comment already
  flags as "left to the first game that changes `CHUNK_BITS`" (M06 Planning decisions 6, unchanged
  by this session).
