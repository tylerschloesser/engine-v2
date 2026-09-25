# M22: Persistence: containers, write-ahead log, snapshots (write side)

Status: not started · After: 21b · Tyler-dependent: no

Split: the PLAN row "22" was too big for one session (formats + write path + load path + two adapters + heavy mode ≈ 2,500 lines). This brief is the formats, the write side and native replay/heavy mode. `22b-persistence-load-and-fs.md` is the load path, the `node:fs` adapter and heavy mode through `engine/test`. Nothing is scheduled between them.

## Goal
The engine containers of 0005 exist in Rust (identity, snapshot, segment header, log frame), and the TS sim host writes them: every frame is appended to a segmented log before it is applied, the `sync` barrier and the 60 s snapshot cadence run between ticks, all through the `Storage` interface with a memory adapter. Natively, a log replays from genesis and from any snapshot to identical checkpoint hashes, and heavy mode passes on a fixture game.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0005-persistence-and-recovery.md` (Formats, Cadence, Loss windows, Storage: interface + the paragraph under it + the Memory row)
3. `docs/decisions/0014-js-wasm-boundary.md` (§2 numbers only, §4 regions and copy-out)
4. `docs/decisions/0002-determinism-same-wasm-everywhere.md` (Heavy mode bullet; ordered-container rule)
Mine from spikes: `spikes/prediction-api` (`host_replay_from_genesis_*` test shape: replay including rejected actions reproduces the hash; a truncated log does not). Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md`.

## Scope
- Rust module `persist` in the engine crate: `Identity`, snapshot writer/reader, `SegmentHeader`, log frame writer/reader, `RecordKind`, table-driven `crc32` (hand-written; no new crate, 0017 crate policy). Field order exactly as 0005 Formats. Game-typed values go through `Codec` (M05); tile overlays as raw little-endian arrays (0005 Formats).
- Streaming snapshot encode and decode (see Planning decisions 1) and the sim-role ABI exports that expose encode.
- Log frame bytes for the pending frame of tick T+1, produced before `apply` (0004 pipeline step 3): M13's `sim_seal_frame()` starts returning real bytes.
- The `Storage` type (declared, unused, by M13) becomes real: `memoryStorage`, a storage conformance helper, and the host module `Persistence` (write side only): create world (manifest + segment 0), write-ahead append, `sync` at most once per second when dirty, snapshot every 1,200 ticks if dirty (numbers: 0005 Cadence), `flush()`.
- Native replay (`engine::testing::replay`) with checkpoint hashes, and native heavy mode (`engine::testing::heavy`).

## Non-scope
- Loading a stored world, torn-frame truncation, segment rolling, snapshot pruning, `node:fs` adapter, restore/replay ABI exports, heavy mode under Node: **M22b**.
- OPFS, Web Lock, export/import, browser events: **M23**. `Skip` semantics and panic recovery: **M24** (this milestone reserves the `Skip` record kind and decodes it as a no-op). Identity mismatch handling and `migrate`: **M24b**. Session table key `sessions`: **M28**.
- gzip of sealed segments (0005 says "may"): not built; export (M23) compresses the whole archive instead.

## Files, packages and crates touched
- `packages/engine/crates/engine/src/persist/` (new), `.../src/abi/sim.rs` (exports), `.../src/testing.rs`
- `packages/engine/src/storage/{types,memory,conformance}.ts`, `packages/engine/src/host/persistence.ts`, `packages/engine/src/test.ts` (re-exports)
- `packages/engine/fixtures/persist/` (fixture game: one entity type with a timer, one player field, a global counter, one RNG-using action, tile depletion)

## Seams
**Provides**
- TS: `memoryStorage(): MemoryStorage` (exported from `engine/server`; the name M27 already uses) with `crashClone(opts?: { dropTailBytes?: Record<string, number> }): MemoryStorage` (a copy as a crashed process would leave it; consumed by M22b, M24); `runStorageConformance(make: () => Storage): Promise<string[]>` (no test-runner imports, so M23 can run it in a page); `worldKeys(worldId)` → `{ manifest, log(segment), snap(tick), sessions }` with zero-padded decimal `segment` (6 digits) and `tick` (10 digits) so `list()` sorts.
- TS: `class Persistence` with `static create(storage, cfg: WorldConfig, sim: EngineInstance): Persistence`, `appendFrame(bytes: Uint8Array)` (what `SimHost.logSink` is pointed at), `afterTick(tick)`, `snapshotNow(): void`, `flush(): Promise<void>`, counters `{ logBytes, frames, snapshots, lastSnapshotBytes, syncs }`. `ManifestV1` (Planning decision 3).
- ABI (sim role; `len` exports follow M02's convention, negative = `-(status)`; at most two arguments because the loader has `call0/1/2`): `sim_seal_frame() -> len` (M13's export, now writing the 0005 frame container into the `Persist` region; 0 = no records, nothing to append), `sim_segment_header(segment: u32, base_tick: u32) -> len` (`base_tick = 0xFFFF_FFFF` means genesis), `sim_snapshot_begin(segment: u32, offset: u32) -> status`, `sim_snapshot_next() -> len` (0 = done; last block ends with `state_hash | crc32`), `sim_dirty() -> u32` (1 if any put or logged record since the last snapshot). Region: `RegionId` 6 `Persist` (reserved by M02; the "log/snapshot output" region of 0014 §4), sized here at 256 KiB.
- Rust: `persist::{Identity, SnapshotWriter, SnapshotReader, SegmentHeader, FrameWriter, FrameReader, RecordKind::{Action, Connection, Skip}, PersistError}`; `SnapshotReader::push(&mut self, block: &[u8]) -> Result<Progress, PersistError>` and `FrameReader::push` accept arbitrary block splits; `testing::replay::<G>(base: Base, log: &[u8], checkpoints: &[Tick]) -> Vec<(Tick, u64)>`; `testing::heavy::<G>(log, every_n) -> Result<(), FirstDivergence { tick }>`.

**Consumes**
- M05 `Codec`, `StateHash`. M12 `Store::{encode, decode, state_hash}`, `Game::SCHEMA_VERSION`, `TICK_RATE`. M21b timer wheel, active lists, the `woken_next` wake queue and id counters appended to `Store::encode` in canonical iteration order (0007: "serialize in canonical order"; exact section order in M21b's Deviations). The wake queue is sim state: a snapshot taken between ticks must carry it. M08 `worldgen_fingerprint` + `WorldgenStamp { version, fingerprint }` (0007 §9). M13 `WorldConfig.buildHash` reaching the instance through M02's `InstanceConfig` in the `engine_init` config (0014 §4); M02 `engine_region`. M12b's `Delta::Ack` bumps `last_seq` through `Store::apply` directly, bypassing the `ChangeLog` (M12b Deviations); that note is about the client-facing `ChangeLog`, not this write-ahead log, and does not say whether `Ack` needs its own persisted record here — `replay_rebuilds_last_seq` should confirm against 0004's "written in each logged action record" rather than assume either answer.
- M13 `createSimHost(cfg, services)`, `SimHost.stepTick`, the tick procedure `sim_seal_frame()` → `logSink(view)` → `sim_tick()` (the write-ahead seam; M16 fills the pending frame with real records), `sim_genesis()`, the `Storage` / `HostServices` / `WorldConfig` types. M02 `EngineInstance` (`call0/1/2`, `region(id)`), `Result` region for multi-word outputs.
- M15 `testkit::Loopback` (scripted camera paths) and `Host::seal`, for `camera_walk_changes_no_log`.

## Planning decisions
1. **Snapshots stream through the fixed region in blocks; 0014's single `sim_snapshot() -> len` is replaced by `sim_snapshot_begin` / `sim_snapshot_next` (0024 §1, which also names `sim_seal_frame`).** A full state budget serialises to roughly 15 MiB (0020 §9 large save), which cannot fit a fixed region inside a 96 MiB arena that also holds the world. The writer is a resumable cursor (section index + last key) over ordered containers; the host drains it in one loop between two ticks, so the cursor never sees a mutation. The host copies blocks into one JS-side `SnapshotBuffer` (an `ArrayBuffer` that doubles when too small, a rare discontinuity under 0016 §2) and then makes the single `Storage.write(key, bytes)` that 0005 specifies. 0014 defers the final export list to Phase 2, so this needs no ADR; the memory cost (one snapshot's size in the host isolate) is recorded in Budgets.
2. **The snapshot is taken in one inter-tick gap, not incrementally.** Copy-on-write state would be a second store implementation. The stall is absorbed by the catch-up rule (0005 Idle pause). Whether the stall on the standard large save is acceptable is a measurement: **M36 must answer "does `sim_snapshot_*` on the standard large save finish within the 5-tick catch-up window on the desktop proxy?"**; if not, that is a new ADR, not a tweak here. This milestone adds the deterministic counter `lastSnapshotBytes` so M36 has the size.
3. **The manifest is host metadata, UTF-8 JSON, written with `Storage.write`.** `ManifestV1 = { v: 1, worldId, epoch: 0 (reserved; M28b owns and increments it), params (the WorldConfig.params block, verbatim), created: IdentityJson, segments: [{ index, identity: IdentityJson, base: 'genesis' | tick, sealed, tailReexecuted }] }`. It is outside sim state (like the session table, 0013), is rewritten only when the segment set changes, and lets the TS host choose keys without parsing Rust containers. Snapshots are not listed in it; they are found with `list()` and validated by CRC (0005 Recovery).
4. **The host owns the log position.** It knows every appended length, so `(segment, offset)` is passed into `sim_snapshot_begin` rather than tracked in WASM.
5. **Pending-frame capacity is fixed** at what the rate limit allows for `maxPlayers` in one tick (0004 rate limit x 0009 `maxPlayers`), well under the region size; `sim_admit` answers `Rejected(Engine(RateLimited))` if it would overflow. No frame can exceed the `Persist` region.
6. **Heavy mode is replay-driven.** Input is a recorded log; run A replays it uninterrupted recording the hash each tick; run B replays it but every N ticks snapshots, drops the `Sim`, restores into a fresh one and continues. First differing tick is reported. Fast tier: N = 25 on the `persist` fixture (~300 ticks). N = 1 is tagged `slow` (M36).
7. **Dirty means "a put happened or a record was logged since the last snapshot"** (one flag set in `Authority`'s write path); timers merely advancing do not dirty the world, matching 0005's "if anything changed".
8. **Overlay-driven cache eviction is now observable (M15c).** `TerrainStore::replace_overlay`/`clear_overlay` evict the affected chunk from the dense cache; as of `docs/plan/15c-terrain-visibility-and-cache-invalidation.md` that eviction emits a `CacheEvent` rather than staying silent. Anything here that replays or restores overlays in bulk (a snapshot decode driving repeated `replace_overlay` calls) should expect those events to fire rather than assume the cache is untouched underneath it.

## Order of work
1. `crc32`, `Identity`, `SegmentHeader`, frame writer/reader with golden-bytes tests (pattern from M05).
2. Snapshot writer/reader as resumable block cursors; round-trip test with random block splits; `Store::state_hash` equal before/after.
3. `testing::replay` and `testing::heavy`; record the `persist` fixture log by a scripted native run and check it in with its checkpoint hashes (regenerated only by an explicit command, 0020 §5).
4. ABI exports + the `Persist` region; extend the ABI export-list test (0014 allowlist test).
5. TS `Storage` types, memory adapter, conformance helper.
6. `Persistence` write side wired into `SimHost` (`logSink = persistence.appendFrame`, `afterTick` from the tick procedure); Vitest under Node with the built fixture `.wasm`.

## Tests added
- Rust native: `persist_frame_golden_bytes`, `persist_snapshot_golden_bytes`, `snapshot_roundtrip_random_blocks`, `snapshot_excludes_dense_cache` (hash and bytes equal at cache capacity 1 and default), `replay_from_genesis_checkpoints`, `replay_from_snapshot_matches_genesis_replay`, `replay_includes_rejected_actions`, `replay_rebuilds_last_seq`, `truncated_log_changes_hash`, `heavy_mode_fixture_n25`, `heavy_mode_fixture_n1` (slow), `skip_kind_decodes_as_noop`, `camera_walk_changes_no_log` (two `testkit::Loopback` runs of one `persist` action script under different scripted camera paths seal byte-identical log frames: camera reports are never logged, spec `simulation.md`; the state-hash half is M15's).
- Vitest (WASM under Node): `storage_conformance_memory`, `write_ahead_order` (memory storage records call order: `append` of frame T+1 precedes the `sim_tick` that applies it), `sync_at_most_once_per_second` (virtual clock), `snapshot_every_1200_ticks_if_dirty`, `no_snapshot_when_clean`, `tick_path_never_awaits` (an adapter whose methods return never-resolving promises does not stall `stepTick`), `storage_onError_is_fatal`, `bytes_per_logged_action` (counter vs budgets file).

## Exit criteria
- [ ] All tests above pass by name under `pnpm test`.
- [ ] The native log written by step 3 and the log written by the Node host for the same script are byte-identical (`log_bytes_native_equals_wasm`).
- [ ] M02's ABI registry test includes the four new exports; import allowlist unchanged.
- [ ] `packages/engine/budgets.json` has `logBytesPerAction` with the measured value and ceiling.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t persist` · `pnpm test rust -t heavy_mode` · `pnpm test wasm -t write_ahead` · `pnpm test` · `pnpm lint`

## Budgets
- Action rate / log row (owner 0004): `bytes_per_logged_action` counter test.
- Latency row, "snapshot every 60 s; log sync ≤ 1 s" (owner 0005): `snapshot_every_1200_ticks_if_dirty`, `sync_at_most_once_per_second`.
- Memory per instance: the `Persist` region inside the sim arena; host-side `SnapshotBuffer` high-water mark exposed as a counter.
- Test suite row: every new fast test within the 0020 §4 p95 limits.

## Context artifacts
- New nested `packages/engine/crates/engine/src/persist/CLAUDE.md` (≤ 20 lines): container field order is owned by 0005; any byte change regenerates goldens by the explicit command and bumps `container_version`; never iterate an unordered container here.
- Extend `.claude/rules/determinism.md` globs to cover `src/persist/**`.

## Manual device checks
none

## Deviations

**Scope actually landed: steps 1-3 only** (base `8c9717e`, commits `3d3d86c`, `c84ae51`, `9b74706`,
`14e404c`). Steps 4-6 (ABI exports, TS `Storage`, `Persistence`) are a second implementer's, per
the delegation prompt. Everything below is native Rust: `packages/engine/crates/engine/src/persist/`
(new), `crates/engine/src/testing/replay.rs` (new), `crates/engine/src/authority.rs`/`sim/mod.rs`
(small additive seams), `packages/engine/fixtures/persist/` (new fixture). No TS file touched.

### Seam shapes for the second half (record verbatim, per the delegation prompt)

- `pub fn crc32(bytes: &[u8]) -> u32` (`persist::crc32`, re-exported at `persist::crc32`):
  table-driven CRC-32/ISO-HDLC, `crc32(b"123456789") == 0xCBF43926`.
- `pub struct Identity { build_hash: [u8; 16], engine_version: String, game_version: String,
  schema_version: u32, tick_rate_hz: u32, worldgen: WorldgenStamp }`, `Identity::write(&self, sink:
  &mut impl ByteSink)` / `Identity::read(reader: &mut ByteReader) -> Result<Self, PersistError>`.
  Wire shape: `build_hash` (16 raw bytes) | `engine_version`/`game_version` (varint len + UTF-8,
  each) | `schema_version` u32 | `tick_rate_hz` u32 | `worldgen.version` u32 |
  `worldgen.fingerprint` u64. Nothing yet *populates* this from a real build hash/`SimConfig` --
  that plumbing (`WorldConfig.buildHash` through `engine_init`, `engine_version`/`game_version`
  strings) does not exist anywhere in the Rust crate today; steps 4-6 (or M22b) wire it. Every
  native test here builds a placeholder `Identity` by hand; nothing validates one against another
  (Non-scope: identity mismatch handling is M24b's).
- `pub enum SegmentBase { Genesis, Snapshot(Tick) }`, `pub struct SegmentHeader { identity:
  Identity, base: SegmentBase }`, `write`/`read` (same `ByteSink`/`ByteReader` pattern, tag byte 0/1
  then `Tick` u32 for `Snapshot`). No CRC of its own (0005 does not specify one for the header).
- `pub enum RecordKind { Action = 0, Connection = 1, Skip = 2 }` (u8 discriminants, part of the wire
  format, not just an internal tag). `pub enum FrameRecord<G: Game> { Action { who: PlayerId, seq:
  u32, action: G::Action }, Connection { who: PlayerId, ev: PlayerEvent }, Skip { segment: u32,
  offset: u32 } }` -- the wire-facing sibling of `crate::sim::Record<G>` (which has no `Skip`).
- `pub struct FrameWriter<G: Game>`: `new()`, `push_action(who, seq, action)`,
  `push_connection(who, ev)`, `push_skip(segment, offset)`, `is_empty()`/`len()`,
  `finish(&self, tick_delta: u32, sink: &mut impl ByteSink)` -- encodes `len varint | tick_delta
  varint | count varint | records | crc32` in one call (builds the body into a local `Vec<u8>`
  first, not zero-alloc; that is steps 4-6's problem if the ABI wiring needs it to be, since
  `sim_seal_frame` writing straight into the fixed `Persist` region is explicitly Non-scope here).
- `pub struct FrameReader<G: Game>`: `new()`, `push(&mut self, block: &[u8]) -> Result<FrameProgress<G>,
  PersistError>` where `enum FrameProgress<G: Game> { NeedMore, Frame(DecodedFrame<G>) }` and
  `struct DecodedFrame<G: Game> { tick_delta: u32, records: Vec<FrameRecord<G>> }`. Resumable: feeds
  bytes in any split, returns at most one decoded frame per call, extra already-buffered bytes wait
  for the next call (an empty slice drains them). `MAX_FRAME_BYTES = 64 KiB` bounds a corrupt `len`.
- `pub struct SnapshotWriter`: `SnapshotWriter::begin<G: Game>(store: &Store<G>, tick: Tick, rng:
  &SimRng, log_segment: u32, log_offset: u32, identity: &Identity) -> Self`, `next(&mut self, out:
  &mut [u8]) -> usize` (bytes copied, 0 = done), `total_len(&self) -> usize`. **Builds the whole
  encoded buffer in `begin`, not a genuine incremental per-section cursor** -- see the "Snapshot
  format" note below; this is the one place this brief's own Planning decisions 1 wording ("section
  index + last key") is not what landed, flagged for the orchestrator.
- `pub struct SnapshotReader<G: Game>`: `SnapshotReader::new(shell: Store<G>) -> Self` (caller
  supplies an empty `Store<G>` already constructed with the right terrain pristine
  source/dims/cache capacity, exactly `Store::decode`'s own precondition), `push(&mut self, block:
  &[u8]) -> Result<SnapshotProgress, PersistError>` where `enum SnapshotProgress { NeedMore,
  Done(SnapshotInfo) }` and `struct SnapshotInfo { identity: Identity, tick: Tick, log_segment: u32,
  log_offset: u32, rng: SimRng, state_hash: u64 }`; `into_store(self) -> Store<G>` after `Done`.
- `pub enum PersistError { Malformed, Crc }`, `impl From<CodecError> for PersistError` (maps to
  `Malformed`).
- `pub(crate) fn write_sized`/`read_sized` in `persist::mod` (duplicated from `crate::store`'s own
  private copy, not shared -- that one is private to `store`).
- `sim_dirty`'s flag (Planning decision 7) was **not** built in steps 1-3: it names `Authority`'s
  write path (`Authority::write`, the one function every `WorldWrite` put funnels through), which is
  existing M12b code this brief's Files list does not include, and the ABI export itself is
  explicitly step 4's. Left for the second implementer: add a `dirty: bool` field to `Authority`,
  set to `true` in `Authority::write` (covers "a put happened"), and decide how "or a record was
  logged" (an admitted action/connection event whose `apply` was a no-op, e.g. a rejected action)
  also sets it -- `Authority::record_ack` is the natural place, since every admitted record reaches
  it. Expose `dirty()`/a reset method (called after a snapshot) the same way `entities_visited_per_
  tick`/`apply_rollbacks` are exposed today.
- **The pending frame of tick T+1** (Consumes: "who appends records, when it is cleared"): already
  exists, unchanged by this brief. `Host<G>.pending_records: Vec<Record<G>>` (`host/mod.rs`) is
  appended to by `Host::connect`/`disconnect` (`Record::Player`) and `Host::on_uplink`'s admitted
  actions (`Record::Action`); `Host::tick()` reads it, hands it to `Sim::step`, then clears it
  (`pending_records.clear()`, right after the `sim.step(pending_records, outcomes)` call). The ABI
  order (`sim_seal_frame()` -> `logSink(view)` -> `sim_tick()`) means step 4's real `sim_seal_frame`
  must read (not yet clear) `pending_records` *before* `Host::tick()` runs -- a new accessor is
  needed (`Host` has no read-only borrow of it today, only the test-only `queue_action_for_test`
  push). `Host::sim_seal_frame` itself is still the M13 stub (`host/mod.rs`, "always 0 until M22" --
  now specifically "until step 4").
- **256 KiB `Persist` region vs. block size**: not exercised here (no ABI in steps 1-3). `FrameWriter`/
  `SnapshotWriter` both build into ordinary heap `Vec<u8>`s; step 4 decides how that maps onto a
  fixed-size region copy-out (`SnapshotWriter::next(&mut [u8])`'s block-draining shape already
  matches "the host drains it in one loop between two ticks" -- just call it with a
  region-sized slice repeatedly).

### Snapshot format deviations from 0005's literal grammar

0005 lists "magic | container_version u16 | identity | tick u32 | log position | engine section
(tick, SimRng, player table, id counters, overlays, entities, active lists and timers in canonical
order) | state_hash u64 | crc32" -- `tick` twice. Landed: `identity`, `tick` u32 (once), `log_segment`
u32, `log_offset` u32, `SimRng` (length-prefixed `Codec`), then `Store::encode`'s own bytes (already
player table onward, M21b's canonical order), `state_hash` u64, `crc32` u32 (over everything from
`identity` through `state_hash`). **A `total_len` varint was added** right after `container_version`
(byte length of `identity..crc32` inclusive) -- not in 0005's grammar, needed so `SnapshotReader`
can tell "not enough bytes buffered yet" apart from "corrupt" while decoding a compound,
variable-length body across arbitrary `push` splits, the same way the log frame's own leading `len`
varint already does. Magic is `b"PSN1"`, `container_version = 1`.

**`SnapshotWriter` is not a genuine incremental per-section cursor.** It encodes the whole snapshot
into one `Vec<u8>` in `begin`, then `next` drains it in blocks. Planning decisions 1 frames the
resumable-cursor design as avoiding "a fixed region inside a 96 MiB arena that also holds the
world" -- but that constraint is about the ABI's *256 KiB region*, not the Rust heap: a ~15 MiB
`Vec<u8>` fits the 96 MiB arena easily, and Planning decisions 1's own next sentence already accepts
one snapshot's bytes living in memory at once (the host's own `SnapshotBuffer`, "the memory cost ...
is recorded in Budgets"). Building it once, in the same process, is behaviourally identical to a
true incremental cursor for every test here (`snapshot_roundtrip_random_blocks`,
`snapshot_excludes_dense_cache`, `replay_from_snapshot_matches_genesis_replay`, both `heavy_mode_
fixture_*`) and avoids a substantially larger amount of code (pausing and resuming mid-`BTreeMap`
for players/entities/timers/active-lists/wake-queue at an arbitrary block boundary). Flagged for the
orchestrator: if M36's own stall measurement (Planning decisions 2) later needs the *encode itself*
to be interruptible (not just the copy-out), this is the place to revisit.

**Each log-frame action payload is length-prefixed** (`seq varint | write_sized(G::Action)`), not
0005's bare `seq varint | G::Action`: matches `Store::write_canonical`'s own convention for every
game-typed value, so `read_sized` always runs `decode_canonical` over an exact, pre-sliced span
(`.claude/rules/determinism.md`: "untrusted bytes go through `decode_canonical`") instead of a
self-delimiting decode that consumes "as much as it needs" from an unverified tail.

### A real, pre-existing bug found and fixed (not this milestone's own code)

`TerrainStore::set_tile` -> `Overlays::get_or_create` always inserted a default (empty)
`ChunkOverlay` before the write ran; a write that reverted a tile all the way back to pristine
(`ChunkOverlay::write`'s `new == pristine` branch removes the entry) left that now-empty
`ChunkOverlay` registered forever. `write_canonical`'s chunk count walks every *registered* chunk,
so two stores with identical effective tiles could serialize/hash differently depending on write
history, and `encode` -> `decode` -> `encode` was not idempotent (measured: 130 bytes -> 118 bytes,
first differing offset 21 -- a phantom 12-byte zero-entry chunk header). Found by `fx-persist`'s own
`heavy_mode_fixture_n25`/`n1` (`Harvest` runs a tile's resource to exactly zero, i.e. back to
pristine) and confirmed with a plain `Store::encode`/`decode` round trip, no snapshot machinery
involved. Pre-existing (M07-era `world/overlay.rs`/`terrain.rs`), outside this brief's Files list --
fixed here rather than escalated, per the M21b precedent (a milestone implementer fixing a real bug
in a related area its own testing found). Fix: `Overlays::prune_if_empty(chunk)`, called from
`TerrainStore::set_tile` after every write. Regression test: `reverting_a_tile_to_pristine_leaves_
no_phantom_chunk_entry` (`crates/engine/tests/world_terrain.rs`). **No existing golden moved**:
`cargo nextest run --workspace --features engine/testing,testing` is 510/510 passed (2 skipped)
with the fix in place; `puts_*`/`machines_*`/reference-sim/wire goldens all unchanged (checked, the
full suite run, not assumed).

### Anti-vacuity (inject/fail/revert, per test; fail lines pasted verbatim)

- `truncated_log_changes_hash`: disabled `FrameReader`'s CRC check (`if false && crc32(body) !=
  want_crc`) -> `"a corrupted trailing frame must not silently reproduce the untouched hash"`
  panicked. Reverted, green.
- `replay_includes_rejected_actions`: made `to_record` drop every `FrameRecord::Action` like `Skip`
  -> `assertion left == right failed\n  left: [(Tick(5), 10562995635270236117)]\n right: [(Tick(5),
  18143478537945809152)]`. Reverted, green.
- `replay_from_snapshot_matches_genesis_replay`: commented out `SnapshotReader::push`'s
  `self.store.decode(&mut reader)` call (the store section dropped, as if a reader forgot the last
  section) -> `assertion left == right failed\n  left: [(Tick(5), 17230440382609520458)]\n right:
  [(Tick(5), 18143478537945809152)]`. Reverted, green.
- `snapshot_excludes_dense_cache`: first tried injecting a cache-derived byte into
  `TerrainStore::write_canonical` (`self.cache.borrow().pool_bytes()`) against the test's *original*
  warm-up (8 tiles inside one chunk) -- passed vacuously, because `CacheCapacity::Chunks(1)` and
  `CacheCapacity::Unlimited` end up with the exact same one-chunk pool size when only one chunk is
  ever touched. Fixed the test itself first (tiles spread across 8 chunks, so the two cache
  policies' *occupancy* genuinely differs), then re-ran the same injection -> real byte-level
  `assertion left == right failed` (full 179-byte vectors differing at the `pool_bytes` field).
  Reverted, green with the strengthened test.
- `heavy_mode_fixture_n25` / `slow_heavy_mode_fixture_n1`: injected "restore silently reuses the old
  `Sim`" (`Authority::from_snapshot`'s result computed but never assigned back) -- **passed
  vacuously**, both tiers: with no hidden/lossy state in `fx-persist`'s own design, a skipped restore
  is behaviourally identical to a real one, so this specific defect class cannot be caught by
  hash comparison alone regardless of `every_n`. Reverted (no fix possible without adding
  deliberately-hidden state to the fixture, which would defeat its own purpose as a *positive*
  example). Tried instead the defect heavy mode is actually for -- dropping the restored `SimRng`
  (`Authority::from_snapshot` ignoring its `rng` parameter, seeding `SimRng::new(0)` instead) --
  `slow_heavy_mode_fixture_n1` failed (`FirstDivergence { tick: Tick(8) }`, the fixture's first
  `Roll`) but `heavy_mode_fixture_n25` stayed green: that `Roll` runs at tick ~8, before the first
  N=25 restore boundary, so both runs process it identically before any restore happens -- a real
  vacuity gap in the fast tier alone. Fixed by adding a second `Roll` well past several 25-tick
  boundaries (`tests/support/mod.rs`), re-blessed the golden; re-ran the same RNG-drop injection ->
  both `heavy_mode_fixture_n25` (`FirstDivergence { tick: Tick(79) }`) and `slow_heavy_mode_fixture_
  n1` (`Tick(8)`) now fail. Reverted, green.
- `skip_kind_decodes_as_noop`, `persist_frame_golden_bytes`, `persist_snapshot_golden_bytes`,
  `replay_rebuilds_last_seq`, `replay_from_genesis_checkpoints`: not independently anti-vacuity-
  tested beyond the above (golden tests fail on any byte drift by construction; `replay_rebuilds_
  last_seq` and `_from_genesis_checkpoints` are covered transitively by the same injections above,
  since they replay the identical script).

### Measured

`cargo nextest run --workspace --features engine/testing,testing`: 510 tests run, 510 passed, 2
skipped (`slow_heavy_mode_fixture_n1`, `slow_apply_journal_overhead`, correctly filtered by the fast
profile). `cargo nextest run --workspace --features engine/testing,testing -P slow`: 2 passed (both
slow tests, including `slow_heavy_mode_fixture_n1`). `pnpm test`: `rust pass 510 tests`, `unit pass
232 tests`, `wasm pass 63 tests` (60 base + 3: `fx-persist`'s own import-allowlist/ABI-registry
tests, iterated automatically over every fixture directory per `packages/engine/CLAUDE.md`), browser
185 tests, all green. `pnpm lint`: biome/rustfmt/clippy/tsc all green.

### Context artifacts

- `packages/engine/crates/engine/src/persist/CLAUDE.md` (new, 19 lines).
- `.claude/rules/determinism.md`'s existing globs (`packages/engine/crates/**`,
  `packages/engine/fixtures/*/src/**`) already cover `src/persist/**` and
  `fixtures/persist/src/**` -- checked, not assumed; no edit needed.

### Exit criteria (steps 1-3 subset; steps 4-6's own criteria are the second implementer's)

- All Rust tests named in Tests added pass by name under `pnpm test` (verified above), except
  `camera_walk_changes_no_log`, which needs `Host::seal`/`sim_seal_frame` wired for real (step 4) --
  not attempted here; the seam it would exercise (`Host.pending_records`) is documented above for
  whoever builds it.
- `pnpm test` and `pnpm lint` are green (pasted above).
- The ABI registry test, the `Persist` region, and `budgets.json`'s `logBytesPerAction` are steps
  4-6's; not applicable to steps 1-3.

### Notes for the next implementer (steps 4-6)

- `sim_dirty`'s flag needs building (see Seams above): add it to `Authority`, not to `persist`.
- `Host` needs a read accessor for `pending_records` reachable before `tick()` clears it, for
  `sim_seal_frame`'s real body.
- `SnapshotWriter::begin` takes `&Store<G>` + `Tick` + `&SimRng` + log position + `&Identity`
  directly; the ABI export (`sim_snapshot_begin(segment, offset)`) will need to source `Identity`
  from wherever step 4 first makes it real (see Seams above -- nothing does yet), and `SimRng`/`Tick`
  from `Sim`/`Authority` (both already reachable via `Host`).
- `fx-persist`'s `cdylib` builds and passes the existing wasm import-allowlist/registry tests
  automatically (it has no `golden/scenario.json` of its own yet); a real ABI-driven scenario test
  for it is steps 4-6's, if wanted.
