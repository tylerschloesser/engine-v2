# M08b: Gen workers and the client generation queue

Status: done · After: 06b, 08 · Tyler-dependent: no

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
- [x] All tests above pass by name.
- [x] `gen: zero-GC over a scripted pan` holds the gen-worker and client-worker budgets of 0016 with no `MinorGC`/`MajorGC` in the window and `memGrows() == 0` for both instances.
- [x] `grep -n "subarray\|new Uint8Array\|new Int32Array\|postMessage" packages/engine/src/worker/gen.ts packages/engine/src/worker/client-gen.ts` shows only setup-time code.
- [x] `abi registry`, import-allowlist and target-feature tests pass for every fixture.
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t queue` · `pnpm test rust -t feed` · `pnpm test unit -t gen` · `pnpm test browser -t "gen:"` · `pnpm test && pnpm lint`.

## Budgets
`PRE-PLAN.md` §7 rows: allocation per isolate (gen and client workers; the zero-GC test); memory per instance (gen arena of 0015 §5, `W_MEM_GROWS == 0`); chunk generation, join case (`genJoinChunks` exact in `budgets.json`). Wall-clock ms per chunk stays with M08's benchmark.

## Context artifacts
Updates `packages/engine/CLAUDE.md`; extends `hot-paths.md` globs (created by M02) with `packages/engine/crates/engine/src/gen_queue.rs` and `packages/engine/crates/engine/src/client/**`, both of which exist after this milestone (M01's `context-artifacts` test fails on a glob that matches no file). No skill.

## Manual device checks
none here; the first on-device run of a worker/SAB page is M11's checklist, over M03's `pnpm device:serve --tunnel`.

## Deviations

### Orchestrator decisions

Before the start (2026-09-20):
- **`W_ACK` on a gen worker keeps M06b's meaning, not "jobs finished".**
  `asHarness(client).stepTick` spins until a worker's `W_ACK` equals the wake value it issued;
  the gen body still ends every pass with `W_ACK = wokenBy` (after any job work). Finished jobs
  are counted where consumed: `GenStats.delivered` via `client_gen_stats`, and the `genResult`
  ring's own counters.
- **`ABI_VERSION` goes 3 → 4** (M08 made it 3).
- **The pump runs on every client wake of every page**, including `topology`/`echo` over
  `fx-hash` (no `TerrainFeed`): `gen_take` must cost nothing and return 0 there; those pages'
  strict 8 B/frame budgets on `client`/`gen0` do not move.

At the step-5 boundary (2026-09-20):
- **Test reads of worker-side WASM state go through one generic, test-gated, parked-only call
  channel**, not a new `SabSet` field and not a query-specific message. Main → worker: `{ type:
  'test-call', id, name, a?, b?, resultBytes? }`; worker → main: `{ type: 'test-result', id,
  value, result: Uint8Array }` or `{ type: 'test-error', id, message }`. Installed only when the
  setup message carried `test`; lives in its own production-side file (`src/worker/test-call.ts`,
  production cannot import `src/test/**`); reachable only while the worker is parked.
- **A ring-driven loop drains on (re-)entry before its first wait**, so a request pushed while a
  worker is parked is not stranded. `runBlockingLoop` runs `body(lastSeen)` once on every entry,
  before the first `Atomics.wait`, in `worker/shell.ts`. A no-op pass must stay allocation-free
  and not disturb the `W_ACK` lockstep.

### Seam shapes as built

**Rust** (`packages/engine/crates/engine/`):
- `view.rs`: `visible_rect(center, half_extent_tiles, ChunkDims) -> ChunkRect`,
  `lookahead_chunks(visible, velocity, ChunkDims, out: &mut [ChunkCoord; 2]) -> usize`,
  `nearest_first(ChunkRect, center: TilePos, out: &mut [ChunkCoord]) -> usize`, exactly as Seams.
  `lookahead_chunks` returns one chunk per axis with nonzero velocity, at `visible.expanded(1)`'s
  own mid row/column just past that ring's edge (never more than 2). `nearest_first` treats
  `center` as already in `ChunkCoord`'s plain-`i32` space; a caller with a tile-space position
  converts with `dims.chunk_of(..)` first.
- `gen_queue.rs`: `GenQueue::{new(ChunkDims, workers: u32), set_view(&GenView, &TerrainStore) ->
  bool, take(worker) -> Option<ChunkCoord>, complete(worker, ChunkCoord),
  requeue_in_flight(worker), pending(), in_flight(), stats() -> GenStats}`, `GenView { visible,
  center, velocity }`, exactly as Seams. `pending: Vec<Entry>` reserved to 512 at `new`, never
  reallocated (`Entry { chunk, ring: u8, dist: u64 }`); `in_flight: Vec<[Option<ChunkCoord>; 2]>`
  sized to `workers`. `set_view` re-sorts only when `view.visible` differs from the last call; on
  a re-sort it cancels pending entries outside `visible.expanded(3)`, reclassifies/re-distances
  survivors, enqueues newly-entering chunks from `visible.expanded(2)` plus up to 2 look-ahead
  chunks (ring 1), and touches every still-cached chunk within `visible.expanded(3)`. `GenStats`
  fields (`requested`/`dispatched`/`delivered`/`cancelled`/`requeued`) are cumulative counters
  plus a `pending`/`in_flight` snapshot. Sort ties break on `ChunkCoord::key()` (fix round 2;
  `queue_ties_break_by_chunk_key`).
- `client/terrain_feed.rs`: `TerrainFeed::{new(ChunkDims, workers), on_frame(&CameraBlock,
  &TerrainStore), take(worker, out: &mut [u8; 16]) -> bool, deliver(worker, record: &[u8], &mut
  TerrainStore) -> Status, stats()}` exactly as Seams, plus `chunk_hash(&self, store:
  &TerrainStore, chunk) -> Option<u64>` (`None` until resident) and `const fn gen_in_bytes(dims)
  -> usize = 16 + dims.slab_bytes()`. A `RefCell<Vec<Tile>>` scratch slab, reserved once in
  `new`, backs `deliver` and `chunk_hash`. `center`/`velocity` convert to Q24.8 once per
  `on_frame` (`round()` then a saturating cast); the queue itself stays integer-only.
  `CameraBlock::for_test(centre, velocity, half_extent_tiles)` added, gated `#[cfg(any(test,
  feature = "testing"))]`.
- `fx-worldgen`: `FixtureGen { role: FixtureRole }`, `FixtureRole::{Gen(GenCore<Self>), Client {
  terrain: Box<TerrainStore>, feed: TerrainFeed }}` (boxed: `TerrainStore` is 352 B). `Config`
  gained `gen_workers: u32` (default 1) and `chunk_bits: u32` (default 5; `EDGE = 32` unchanged
  everywhere else). Client-role cache is `CacheCapacity::Chunks(1024)`.

**ABI** (`abi/registry.rs`, `ABI_VERSION` 3 → 4): `gen_take(worker: u32) -> u32` (1/0, never a
`Status`, costs nothing on the wrong role), `gen_deliver(worker: u32, len: u32) -> status`,
`client_gen_stats() -> status` (writes 28 bytes / 7 `u32` into `Result`), `client_chunk_hash(cx:
i32, cy: i32) -> status` (writes lo,hi `u32` of an FNV hash into `Result`, or
`Status::NotCached`). `RegionId::GenIn = 9` (`REGION_COUNT` 9 → 10). `Status::NotCached = 9`
(after `Unsupported = 8`). Records: request 16 bytes `[cx i32][cy i32][0 u32][0 u32]`; result `16
+ slab_bytes`.

**TypeScript** (`packages/engine/src/`):
- `worker/gen.ts`: built once at setup — `GenOut` region (**nullable**, not
  `requireRegion`-guarded), a `RingConsumer` over `sabs.genRequest[ordinal]`, a `RingProducer`
  over `sabs.genResult[ordinal]` woken with `{ control: shell.control, index: WORKER_CLIENT }`;
  `ordinal = shell.index - WORKER_GEN0`. Per pass: claim a `genResult` slot *before* touching a
  request. An oversize `GenOut` vs. the configured slot throws a plain `Error` in `setup()` (not
  `shell.fatal`, which would still enter `runBlockingLoop` and hang on its first wait). Header
  read/write extracted to `worker/gen-record.ts`: `readI32LE`/`writeI32LE`/`writeGenHeader`, all
  allocation-free, tested by `gen-record.test.ts` beside its source (not under `tests/unit/`).
- `sab/ring.ts` gained `RingProducer.slotPayloadBytes()`, used by the oversize check.
- `sab/layout.ts`'s `RING_DEFAULTS`: `genRequest` `{ slotBytes: 24, slots: 8 }` (8-byte ring
  header + 16-byte record), `genResult` `{ slotBytes: 4120, slots: 8 }` (8 + 16 + 4,096), both
  down from 64 slots.
- `worker/client-gen.ts`: `createGenPump(inst, control, sabs, genIn, result, fatal)` builds one
  `{ requests: RingProducer, results: RingConsumer }` pair per **configured** gen worker
  (`sabs.genRequest.length`). `pump()`: drain `genResult[i]` via `popInto` into `genIn.u8` then
  `gen_deliver(i, len)` (skipped when `genIn` is `null`), then claim `genRequest[i]`,
  `gen_take(i)`, copy the 16-byte answer out of `Result` with `sab/bytes.ts`'s `copyBytes`,
  `commit()`. Called unconditionally every wake, not gated on a new frame. `genIn: RegionView |
  null`, read once at setup. `gen_deliver`'s status is checked against `Status.Ok`; a bad status
  calls `fatal(...)` (the callback, wired from `worker/client.ts` as `(msg) => shell.fatal(msg)`)
  with worker index/len/status.
- `worker/client.ts`'s `body()` gained a `requireRegion(inst, RegionId.Result, 'Result')` call at
  setup and one `genPump.pump()` call at the end of `body()`.
- `client.ts`: `genWorkerCount(hardwareConcurrency: number, requested?: number): number`,
  replacing the old private `defaultGenWorkers()`. `requested`, when given, overrides the
  hardware default entirely and clamps to `[1, MAX_GEN_WORKERS]` (`sab/layout.ts`'s constant, 2).
- `worker/shell.ts`: `runBlockingLoop` drains on entry via a shared `runBodyOnce` helper (also
  used by each loop iteration), turning a thrown error into `shell.fatal` the same way both
  places already did.
- `worker/test-call.ts`: `handleTestCall(inst, m)` picks `call0`/`call1`/`call2` by whether
  `m.a`/`m.b` are present; `resultBytes` bytes are copied from `region(RegionId.Result)`. Wired
  into `worker.ts` as a module-level `testCall` closure set once setup resolves, routed only when
  setup carried `test`. Wired into `worker/client.ts` only — `gen.ts`/`sim.ts` untouched.
- `engine/test`: `callParked(client, isolate: string, name: string, args?: number[],
  resultBytes?: number): Promise<{ value: number; result: Uint8Array }>` (rejects with a readable
  error when that worker's `W_PARKED` is not 1); `gen.stats(client)`, `gen.idle(client,
  framesPerCheck = 16)` (steps frames until `pending == 0 && in_flight == 0`, then
  `untilQuiescent`), `gen.chunkHash(client, cx, cy)`, via a local `withParked` helper (parks all
  only if not already fully parked, resumes only if it did the parking).

**`engine/test` / fixture app**: `tests/browser/pages/gen.html` + `src/gen.ts` (imperative debug
page, `window.__gen*`-prefixed globals, `host: { kind: 'remote', url: 'ws://unused.invalid' }`
since `fx-worldgen` has no `Sim` role); `tests/browser/pages/gc-gen.html` + `src/gc-gen.ts`
(auto-creates its client at load, camera pans 8 tiles/second). `budgets.json`:
`counters.gen.genJoinChunks = 169`, `genPanChunks = 13`; `gc.pages.gen.isolates`: `main` 48,
`client` 8, `gen0` 8 (`net` deliberately unbudgeted — never ticked, never enters
`runBlockingLoop`).

### Differences from the brief

- Zero-GC tests are named by `zeroGcSuite` for page id `gen`, not literally "gen: zero-GC over a
  scripted pan" (Tests added's own name is the suite description, not a test title).
- Two pages, not one: `gen.html` (imperative debug/assertion page) and `gc-gen.html`
  (auto-created zero-GC page), matching M06b's `topology`/`gc-topology` split.
- `RING_DEFAULTS.genRequest`/`genResult` revised (M06's own allowance) to fit one record per slot
  and shrink `slots` from 64 to 8, as above.
- `fixtures/worldgen`'s `Config` gained a `chunk_bits` fixture knob (default 5) solely to drive
  `gen: oversize slab is a readable fatal`; the fixture's own `generate()` still uses `EDGE =
  32`.
- `RingProducer.slotPayloadBytes()` added to `sab/ring.ts` after the oversize-`GenOut` check was
  found comparing against the whole ring's byte length instead of one slot's payload capacity —
  fixed to check against the new method.
- Three `test/client.ts` harness fixes surfaced building `gc-gen.html`: `resumeWorkers`'s
  `allEqual` poll never completes for `net` (no loop, `W_PARKED` stays 1 by design) — fixed with
  a `net`-skipping `allResumed`; `resumeWorkers` sent `resume` to already-running workers, racing
  a worker's next park — fixed by skipping any worker whose `W_PARKED` isn't currently 1;
  `asHarness.stepTick()`'s poll was `!== want`, which spins forever once a real independent wake
  (gen traffic) makes `W_ACK` overshoot — changed to `< want`.
- `runBlockingLoop` drains on entry (decided at the step-5 boundary, above); implemented as a
  shared `runBodyOnce` helper in `worker/shell.ts`.
- The parked `test-call` channel and `callParked` (decided at the step-5 boundary, above) are
  wired into the `client` kind only; `gen.ts`/`sim.ts` have no `testCall` handler yet.
- `client-gen.ts`'s pump gained a `fatal` callback and checks `gen_deliver`'s status (fix round
  2), not specified by the brief's own pump description.
- `gen_queue.rs`'s sort breaks ties on `ChunkCoord::key()` (fix round 2, code-review finding),
  not specified by Planning decisions.

### Measured

Zero-GC (`gc.pages.gen`, `pnpm gc -t "gen "`: 7/7 clean + every object/burst control on
`main`/`client`/`gen0`): `main` constant 39.4467 B/frame across 8 clean runs (budget 48 =
`ceil(39.4467) + 8`); `client` constant 5.2867 B/frame (budget 8, strict); `gen0` constant 2.5067
B/frame (budget 8, strict); `net` unbudgeted (never ticked, no mechanism for a negative control
to reach it).

`genJoinChunks = 169`, `genPanChunks = 13`: a scripted join at the view clamp of 0008 §5 (camera
(0,0), half-extent (128,128) tiles) gives `visible.expanded(2)` = 13×13 = 169 chunks; a +32-tile
(one chunk edge) pan in x overlaps 156 of the new 169, leaving 13 new.

Suites at acceptance (`d5921da`): `rust 129`, `unit 90`, `wasm 32`, `browser 63` (19 s/25 s
quiet, 20 s at load 6, 25 s at load 2.5).

`client`'s ~1,660 B excess in `waitForWake@sab/control.ts` over the 600-frame window (5.2867 vs.
the 2.5067 baseline) is identical at 7 and 14 gen deliveries per window and absent entirely with
no gen traffic (pan rate 0) — a one-off (V8 warming the first genuinely-asynchronous wait on this
worker), not per-pass or per-delivery.

### Gate history

- **Stop at the step-5 boundary (`3f7b381`).** Steps 1–5 (the Rust core, ABI, TS worker plumbing)
  landed green; step 6 (`engine/test` hooks reading worker-side WASM state) needed a real
  architectural decision — no existing channel lets main read a worker's WASM `Result` region or
  round-trip an arbitrary query — so the session stopped rather than invent one unilaterally.
  Resolved by the two step-5-boundary decisions above.
- **Fix round 1 (`7e84a8c`): the join was scripted at a reduced 2×2/36-chunk view, not the 0008
  §5 view clamp** — coordinator finding. Rescripted to join at the view clamp (169/13, above);
  `gen: one and two workers give equal chunk hashes` keeps its own separate, smaller 2×2 geometry
  since nothing requires it match. Also evidenced (`2d48d2e`, no code change): `client`'s 5.2867
  B/frame is a one-off, not per-pass or per-delivery — bisected by pan rate and recorded in
  `budgets.json`'s own formula.
- **Fix round 2 (`d5921da`): total-order queue sort (ties broken on `ChunkCoord::key()`), fatal
  on a failed `gen_deliver`** — both code-review findings. `genJoinChunks`/`genPanChunks`
  unchanged (169/13); `client`'s reading re-measured unchanged at 5.2867 B/frame.

Orchestrator acceptance at `d5921da` (2026-09-20): `pnpm gate 498b02f` clean (no goldens changed,
no markers, no existing budget moved); `rust 129`, `unit 90`, `wasm 32`, `browser 63` (19 s/25 s
at load 2.5, 20 s at load 6), lint green; every name under Tests added and Provides found by
`grep`; exit-criterion grep over `gen.ts`/`client-gen.ts` empty; read-only Sonnet review of the
production diff found no lost wake, per-pass allocation or determinism issue. `browser` repeats:
33/33 as the machine was (15 before fix round 2, 18 after; slowest 21 s) and 26/26 with `--load
10` (1-minute load 27–37; slowest 25 s, which is the suite budget), 0 hangs.

### Notes for later briefs

- `callParked` is how a page reads worker-side WASM state and is wired into `client` only; adding
  it to `gen`/`sim` is one line (`testCall: (m) => handleTestCall(inst, m)` in that kind's
  returned `LoopState`).
- `net` keeps `W_PARKED = 1` by design (it never enters `runBlockingLoop`); `resumeWorkers`'s
  `allResumed` already treats it as always-resumed, and it stays out of every
  `gc.pages.*.isolates` map it is spawned under.
- M09 and M13's zero-GC pages should watch the `client` isolate's `waitForWake` figure: if it
  grows with traffic (rather than staying flat like the 1,660 B one-off here) it is not a
  one-off.
- The `browser` suite is at 19 s quiet and 25 s saturated, so the next milestone that adds
  browser tests trips the 20 s wire in `docs/plan/deferred-ledger.md` and demotes multi-engine
  repeats per ADR 0020 §4 before acceptance.
- `fixtures/worldgen`'s `chunkBits` config key exists only for the oversize-fatal test; a real
  game changing `CHUNK_BITS` still needs `sab/layout.ts`'s `RING_DEFAULTS.genResult`/`genRequest`
  resized to match (M06 Planning decisions 6, still open).
