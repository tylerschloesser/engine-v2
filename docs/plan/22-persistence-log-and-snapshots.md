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

## Steps 4-6 (second implementer)

Base `68c4b35` (steps 1-3's own head). Commits: `d41aa6e` (step 4: ABI exports + `Persist` region +
`sim_dirty`), `557e395` (step 5: `Storage`/`memoryStorage`/`runStorageConformance`), `9f2931c`
(step 6: `Persistence` wired into `SimHost`), `d383d46` (accepted-first-half fix: `SnapshotWriter`
buffer sizing, see below).

### Seam shapes actually landed

- `ABI_VERSION` 15 -> 16. Four new sim-role exports, all forwarded through `GameInstance<G>` (which
  steps 1-3 could not have wired, since `Host<G>` didn't have them yet -- **this dispatch was
  missing on the first pass here too**, found by the very first Vitest run against `fx-persist`'s
  real `.wasm`: every call returned `Status::WrongRole`/`Unsupported` until `game_instance.rs` grew
  the four match arms alongside `sim_seal_frame`'s own):
  - `sim_segment_header(segment: u32, base_tick: u32) -> len`: `_segment` is accepted but unused --
    a segment's own index lives in its storage key (Planning decisions 3/4), never in the header
    bytes (0005 Formats: `identity | base` only). `base_tick = 0xFFFF_FFFF` (`GENESIS_BASE_TICK`,
    mirrored as a plain `const` on both sides, not a registry constant) means `SegmentBase::Genesis`.
    **Does not require genesis to have run** (deliberately, unlike every other real sim export): its
    body reads only `Host::identity()` (build hash/versions/schema/tick-rate/worldgen fingerprint,
    all known at `Host::init` time), which is exactly what `Persistence.create` needs *before* the
    world exists, to build segment 0's header as part of "create world".
  - `sim_snapshot_begin(log_segment: u32, log_offset: u32) -> status` / `sim_snapshot_next() -> len`:
    thin wrappers over `SnapshotWriter::begin`/`next`, sourcing `Identity` from `Host::identity()`
    and `SimRng`/`Tick` from `Sim`/`Authority` (both reachable via `Host`, as steps 1-3's own notes
    expected). `sim_snapshot_begin` also calls `Authority::clear_dirty()` (see below).
  - `sim_dirty() -> u32`: `Authority::dirty()`, `0`/`1`.
  - `Host::identity()` (new, private): assembles `persist::Identity` from `self.build_hash` (parsed
    once at `Host::init` from a new `SimConfig::build_hash: String`, plain lowercase hex,
    `#[serde(default)]` so every existing config keeps working), `engine::ENGINE_VERSION` (new,
    `env!("CARGO_PKG_VERSION")` in `lib.rs`), `G::GAME_VERSION` (new defaulted assoc const on `Game`,
    `"0.0.0"` unless a game overrides it with its *own* `env!` -- `fx-persist` does), `G::
    SCHEMA_VERSION`, `G::TICK_RATE.hz_value()`, and `self.worldgen_fingerprint` (computed once, at
    `Host::init`/`genesis_for_test`, via a new private `compute_worldgen_fingerprint` that borrows
    the worldgen params rather than cloning them -- `Worldgen::Params` carries no `Clone` bound).
  - `RegionId::Persist` is now actually declared by `Host::init` (`layout.region(RegionId::Persist,
    PERSIST_BYTES)`, 256 KiB) -- **steps 1-3 could not have caught this: nothing before this half
    ever called a sim-role export that reads or writes that region.** Its absence was the very first
    real failure (`sim_seal_frame` returning `-(BadLength)` the moment it had non-empty bytes to
    write), found the same way as the `GameInstance` dispatch gap above.
  - `Host::sim_seal_frame` is real: reads (never drains) `self.pending_records`, encoding the exact
    `len | tick_delta | count | records | crc32` container `persist::FrameWriter::finish` produces,
    but **by hand, over borrowed records**, not via `FrameWriter::push_action` (which takes `G::
    Action` by value). `pending_records: &[Record<G>]` only ever hands out `&G::Action`, and adding
    a `G::Action: Clone` bound to reach `.push_action` would have landed on the whole `impl Instance
    for Host<G>` block -- forcing it onto `GameInstance<G>`'s own generic dispatch, i.e. every game,
    not just this one method. `crate::persist::write_sized`/`crc32`/`RecordKind` (all `pub(crate)`/
    `pub`) are reused directly; the wire bytes are proven byte-identical to `FrameWriter::finish`'s
    own output by `log_bytes_native_equals_wasm` (below), not merely asserted.
  - `Authority::dirty: bool`, set in `Authority::write` (every `WorldWrite` put), in `Authority::
    record_ack` (every admitted action, applied or rejected), and (fix round 1, gap 2) in
    `Host::sim_seal_frame` itself, via a new `Authority::mark_dirty()`, whenever it actually produces
    a non-empty frame. The third setter is what closes the real gap fix round 1 named: a *reconnect*
    (`Host::connect` on an already-`ever_joined` slot) pushes only `Record::Player{Connected}` -- no
    `on_player` write (`Persist::on_player`'s own `Joined`-only arm) and no `record_ack` call
    (admitted-action-only) -- so `sim_dirty()` stayed `0` after a real, non-empty logged frame.
    Setting it in `sim_seal_frame` on any non-empty output covers every record kind uniformly rather
    than chasing each one's own write path; `connect_only_tick_dirties_the_world`
    (`fixtures/persist/tests/dirty_flag.rs`) proves it, injection-tested (below). Reset by
    `Authority::clear_dirty()`, called from `sim_snapshot_begin` once the writer already holds a
    self-consistent copy of the state that flag described. `Authority::rng()` (existing, from steps
    1-3) is un-gated from `#[cfg(test, feature="testing")]` to plain `pub`, since `sim_snapshot_begin`
    is a genuine production caller now.

### TS Provides, as built

- `packages/engine/src/storage/{types,memory,conformance}.ts`: `Storage` (moved out of `server.ts`'s
  own inline declaration, re-exported unchanged), `worldKeys(worldId)` (`worlds/<id>/{manifest,
  log/<6-digit>, snap/<10-digit>, sessions}`), `memoryStorage()`/`MemoryStorage.crashClone(opts)`,
  `runStorageConformance(make)` (7 named checks, no test-runner import).
- `packages/engine/src/host/persistence.ts`: `Persistence.create(storage, cfg: WorldConfig, sim:
  EngineInstance)` (the *raw* `EngineInstance`, not `server.ts`'s `SimInstance` -- calls
  `sim_dirty`/`sim_segment_header`/`sim_snapshot_begin`/`sim_snapshot_next`/`tick_hz` directly),
  `appendFrame` (a fixed arrow-function class field, `SimHost.logSink`'s own target),
  `afterTick(tick: number)`, `snapshotNow()`, `flush()`, `counters: { logBytes, frames, snapshots,
  lastSnapshotBytes, syncs }` (exactly Seams' shape) plus one addition beyond it, a
  `snapshotBufferHighWaterBytes` getter (Budgets: "host-side `SnapshotBuffer` high-water mark
  exposed as a counter" -- kept off the fixed `counters` object rather than added to it). `ManifestV1`/
  `IdentityJson`/`ManifestSegment` are new exported types: `IdentityJson` decodes `persist::
  Identity`'s own wire bytes (build hash as hex, `worldgen.fingerprint` as decimal text, a `u64`
  not always fitting a JS number) -- the one place this module parses a Rust container, right after
  `sim_segment_header` produces it, so the manifest can carry the result as plain JSON afterward.
- **Two separate "dirty" concepts, deliberately**: `sim_dirty()` (Rust, world-state-changed, gates
  the snapshot cadence) and a JS-only `appendedSinceSync` flag (gates the sync cadence: "has
  anything been appended since the last sync", set in `appendFrame`, cleared in `sync()`). 0005
  discusses these as separate cadences with separate meanings of "dirty"; conflating them would
  make `sync()` never fire on a tick that only queued a connection event with no state write.
- **Snapshot/sync cadence is tick-counted, not wall-clock**: `SNAPSHOT_EVERY_TICKS = 1200` (a literal
  tick count, not scaled by the game's real Hz -- Scope's own wording), and the "one second" sync
  barrier is `ticksPerSecond` (`tick_hz()`, read once) ticks, not a `Clock` reading. No ambient time
  import exists in this file at all. The Tests added name for the sync test, `sync_at_most_once_per_
  second (virtual clock)`, is satisfied by this design's own determinism (ticks *are* the sim's
  clock) rather than by injecting a `Clock` double; `tests/wasm/persistence.test.ts`'s own tests
  drive ticks synchronously via `SimHost.stepTick`, never a real timer.
- **`SimHost.logSink`'s call site needs a `subarray()`** (`server.ts`'s `runOneTick`): `seal.bytes`
  is the whole persistent `Persist` region view (Orchestrator ruling 2, unchanged), but `logSink`'s
  own fixed one-argument shape (`(bytes: Uint8Array) => void`, unlike `simBuildFrame`'s `bytes` +
  separate `.len`) has no way to carry "exactly `len` bytes" except by slicing at the call site --
  exactly what the pre-existing M13 comment on this line anticipated ("its own 'exactly `len` bytes'
  contract is M22's to give a real shape"). This is a `.claude/rules/hot-paths.md` tension flagged,
  not resolved: it only runs on a tick that actually logged something, and no zero-GC page wires a
  real `Storage` through this milestone (`worker/sim.ts` is untouched -- `createSimHostFromInstance`'s
  new `persistence` parameter is optional precisely so its existing two-argument call keeps working).
  Whichever milestone first arms `Persistence` inside the sim worker needs to measure this and either
  accept the allocation into that page's own budget or find another shape.
- `createSimHostFromInstance(sim, services, persistence?)`: additive, optional third parameter, not
  a renamed seam -- every existing call site (`worker/sim.ts`, `tests/wasm/puts.test.ts`,
  `server.test.ts`) is unchanged. `createSimHost(cfg, services)` now builds one `Persistence` from
  `services.storage` and passes it through; this is the only place `HostServices.storage` is read.
- `sim-config.ts`'s `buildSimInstanceConfig` now forwards `cfg.buildHash` into the `game` config
  object as camelCase `buildHash` (`SimConfig::build_hash` on the Rust side, via `rename_all =
  "camelCase"`).

### `log_bytes_native_equals_wasm`: a new golden, not the old one

Exit criterion wording ("The native log written by step 3 ... byte-identical") names step 3's own
recorded log, `fixtures/persist/tests/golden/persist_fixture_log.hex`. That golden cannot be the
baseline here: it was built by `support::record()` pushing a hand-picked `Record::Player{Joined}`
directly through testkit, bypassing `Host::connect`'s real admit pipeline entirely -- which always
queues *both* `Joined` and `Connected` on a first connect (`Host::connect`'s own body, unchanged
since M15). No real `.wasm` build can reach that testkit-only shape (`queue_action_for_test` and
friends are `#[cfg(feature = "testing")]`), so a comparison against it would not be testing what the
criterion asks for -- whether native and ABI-driven Rust agree on wire bytes for the *same real
script*. Built a new golden instead, driven through the real admit pipeline on both sides:
`fixtures/persist/tests/abi_log_parity.rs` (native, `testkit::Loopback::add_client`/`action`, blesses
`persist_abi_log_parity.hex`) and `tests/wasm/persist-log-parity.test.ts` (the identical script,
replayed over the real `.wasm` through `sim_connect`/`sim_admit` with a real client-role instance
turning each action into real wire bytes -- no hand-encoded postcard). Byte-identical, confirmed
(`pnpm test wasm -t log_bytes_native_equals_wasm`). Flagged for the orchestrator: the exit criterion
is met in spirit (native vs WASM parity for a real script) but not literally (not the step-3 golden).

### Anti-vacuity (inject/fail/revert; fail lines pasted verbatim)

- `write_ahead_order`: moved the `logSink` call in `server.ts`'s `runOneTick` to *after* `sim_tick()`
  -> `AssertionError: expected [ 'tick', 'append' ] to deeply equal [ 'append', 'tick' ]`. Reverted,
  green. Without the order assertion, this test would still pass if `logSink` were never called at
  all.
- `sync_at_most_once_per_second`: dropped the `ticksSinceSync >= this.ticksPerSecond` half of the
  throttle (kept only "if appended") -> `AssertionError: expected 1 to be +0` (synced on the very
  first tick). Reverted, green. Without asserting `syncs === 0` *before* the boundary, this would
  pass vacuously.
- `no_snapshot_when_clean`: replaced `if (this.isDirty()) this.snapshotNow()` with an unconditional
  `this.snapshotNow()` -> `AssertionError: expected 2 to be 1` (a second snapshot at the second
  1,200-tick boundary, with nothing dirtied in between). Reverted, green. The test's own first
  boundary already snapshots once (`Sim::genesis`'s own `put_global`/`set_tile` calls dirty the
  world through `Authority::write`, same as any other put) -- without a *second* boundary asserted
  to stay at 1, this would pass vacuously (dirty always true is indistinguishable from dirty
  correctly true-once here).
- `storage_onError_is_fatal`: removed both `this.checkFatal()` calls (`appendFrame`/`afterTick`) ->
  `AssertionError: expected [Function] to throw an error`. Reverted, green. Without actually invoking
  `storage.onError` and then ticking again, this would pass on a `Persistence` that never wired
  `onError` to anything at all.
- `tick_path_never_awaits`: **first version of this test passed vacuously** even with a genuine
  defect injected (`appendFrame` made `async`, `await`-ing a never-resolving `storage.append`) --
  `stepTick`'s own `ticksRun` counter still reached 1,300 synchronously, because nothing in
  `runOneTick` ever awaits `logSink`'s return value either way, so an internally-`await`-ing
  `appendFrame` is invisible to that assertion alone. Strengthened: also assert `persistence.
  counters.frames/snapshots/syncs > 0` (only reachable if the code *after* each storage call in
  `appendFrame`/`snapshotNow` actually ran, which cannot happen synchronously past a hung `await`).
  Re-ran the same injection -> `AssertionError: expected 0 to be greater than 0` (frames stayed 0).
  Reverted, green.
- `bytes_per_logged_action`: not independently injection-tested (a golden-shaped exact-byte-count
  assertion fails on any drift by construction, same reasoning steps 1-3 gave for their own golden
  tests) -- drives one real `Roll` action through a real client-role encoder instance (`on_action` +
  `client_poll_uplink`) into `sim_admit`, exactly `tests/support/scenario.ts`'s own technique, so the
  measured 12 B is a real wire-driven number, not a hand-typed one.

### Measured

`cargo nextest run --workspace --features engine/testing,testing`: 512 tests, 512 passed, 2 skipped
(unchanged slow tests). `pnpm test`: `rust pass 512 tests`, `unit pass 233 tests`, `wasm pass 72
tests`, `browser pass 185 tests` (browser suite untouched by this half -- no sim-worker file was
edited, so nothing there needed re-running beyond the standard full pass). `pnpm lint`: biome/
rustfmt/clippy/tsc all green. `budgets.json`'s new `counters.action.logBytesPerAction = 12` (exact,
not measured-plus-margin: `len varint(1) + tick_delta varint(1) + count varint(1) + record(kind(1) +
player_slot(1) + seq varint(1) + write_sized(Action::Roll): len varint(1) + 1 postcard byte) +
crc32(4) = 12`).

### Context artifacts

- `packages/engine/src/storage/CLAUDE.md` (new, 19 lines) and `packages/engine/src/host/CLAUDE.md`
  (new, 25 lines): `packages/engine/src/CLAUDE.md` itself was already at the 60-line cap
  (`scripts/lib/context-artifacts.test.mjs`'s own hard limit), so new nested files rather than an
  addition to it.
- `packages/engine/crates/engine/CLAUDE.md`: patched its pre-existing, already-stale `sim_seal_frame`
  ("always 0 until M22") and `ABI_VERSION is 10` lines (stale since well before this milestone --
  M16-M21b never updated them either) to name this half's four new exports and the real version.
  Did not attempt a full reconciliation of that file's older drift beyond what this milestone itself
  touched.

### Deferred / flagged for the orchestrator

- Identity is real but unvalidated end to end: nothing compares a loaded segment's `Identity`
  against the running build's own (M22b/M24b's own Non-scope, unchanged), and `G::GAME_VERSION`
  defaults to `"0.0.0"` for any game that doesn't override it (only `fx-persist` does, here).
- `Authority::dirty` not being set by a connection-only frame is fixed, fix round 1 (below).
- The `logSink` `subarray()` tension (above) is real but inert until some later milestone wires a
  live `Storage` into `worker/sim.ts` itself; flagged there for whoever does.

## Fix round 1

Two gaps closed per the coordinator's own message.

### Gap 1: replay/heavy against a real host's log

New `fixtures/persist/tests/replay_real_host_log.rs`, `replay_real_host_log_matches_live`: a
`testkit::Loopback<Persist>` script (real `Host::connect`/`Host::on_uplink`, not a hand-built
`FrameWriter` log) with a self-rearming `PlaceTimer`, a mid-run snapshot (taken through the real
`Host::sim_snapshot_begin`/`sim_snapshot_next` ABI methods, not a bare `SnapshotWriter::begin`
call), a *second* connection after `testing::heavy`'s own first `N=25` restore boundary, and a
final anchoring action. Checks `testing::replay` from genesis, `testing::replay` from the mid-run
snapshot, and `testing::heavy(N=25)` all reproduce the live run's own checkpoint hashes exactly --
all three pass.

**A real architectural gap found, not fixed (escalated instead of patched under time pressure):**
the snapshot in this test is deliberately taken *immediately* after a logged frame, not after a
run of idle ticks. Taking it after an idle gap (e.g. snapshot at tick 10, last real frame at tick
2) breaks `testing::replay`-from-that-snapshot: the *next* real frame's `tick_delta` is computed by
`Host::sim_seal_frame` relative to `last_logged_tick` (tick 2), which is unknown to anyone resuming
from the snapshot at tick 10 (0005 Formats' own snapshot grammar carries only `identity`, `tick`
and `log position`, not this reference tick) -- resuming replay misplaces that frame by exactly the
length of the idle gap before the snapshot. Tried the obvious fix (reset `last_logged_tick` to the
snapshot's own tick in `sim_snapshot_begin`): it broke `replay_from_genesis_checkpoints` and this
same test's own from-genesis leg, because a **full-log genesis replay has no way to know a snapshot
ever happened partway through** (nothing is recorded in the log itself), so it cannot apply the same
reset -- and 0002 "Replay equality"/"Cross-engine golden hashes" require genesis replay of the *same*
log to always reproduce the live hash regardless of any snapshot cadence. Reverted. This is a real
production scenario (Persistence's own 1,200-tick dirty check can fire long after the last real
frame, once fix round 1's own gap 2 makes a stale-but-still-set dirty flag common), not a contrived
one, and needs either a format addition (an ADR amendment, risking the accepted `persist_snapshot_
golden_bytes` golden) or a different recovery algorithm (M22b's own "loading a stored world" is the
natural owner) -- flagged for the orchestrator, not decided here.

Anti-vacuity: disabled `to_record`'s own `FrameRecord::Connection -> Record::Player` mapping
(treated it as a no-op, like `Skip`) -> `assertion left == right failed` (`replay from genesis must
match the live run exactly`; every checkpoint from tick 1 onward differed). Reverted, green.

### Gap 2: dirty flag on any logged record

`Authority::mark_dirty()` (new), called from `Host::sim_seal_frame` whenever it actually produces a
non-empty frame -- closing the exact gap Deviations flagged: a reconnect (`Host::connect` on an
already-`ever_joined` slot) pushes only `Record::Player{Connected}`, reaching neither `Authority::
write` (no state write) nor `Authority::record_ack` (admitted-action-only). New `fixtures/persist/
tests/dirty_flag.rs`, `connect_only_tick_dirties_the_world`: connect (dirty, real write), snapshot
(clears dirty), reconnect the same connection (`Connected` only) -> `sim_dirty() == 1`.

Anti-vacuity: removed the `mark_dirty()` call from `sim_seal_frame` -> `assertion left == right
failed` (`left: 0, right: 1`, the reconnect-only case). Reverted, green.

### Measured (fix round 1)

`cargo nextest run --workspace --features engine/testing,testing`: 514 tests, 514 passed, 2 skipped
(unchanged). `pnpm test`: `rust pass 514 tests`, `unit pass 233 tests`, `wasm pass 72 tests`,
`browser pass 185 tests`. `pnpm lint`: biome/rustfmt/clippy/tsc all green. No existing golden moved.
