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
- M05 `Codec`, `StateHash`. M12 `Store::{encode, decode, state_hash}`, `Game::SCHEMA_VERSION`, `TICK_RATE`. M21b timer wheel, active lists and id counters appended to `Store::encode` in canonical iteration order (0007: "serialize in canonical order"). M08 `worldgen_fingerprint` + `WorldgenStamp { version, fingerprint }` (0007 §9). M13 `WorldConfig.buildHash` reaching the instance through M02's `InstanceConfig` in the `engine_init` config (0014 §4); M02 `engine_region`. M12b's `Delta::Ack` bumps `last_seq` through `Store::apply` directly, bypassing the `ChangeLog` (M12b Deviations); that note is about the client-facing `ChangeLog`, not this write-ahead log, and does not say whether `Ack` needs its own persisted record here — `replay_rebuilds_last_seq` should confirm against 0004's "written in each logged action record" rather than assume either answer.
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
(filled in during Phase 3)
