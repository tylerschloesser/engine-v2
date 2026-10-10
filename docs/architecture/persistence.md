# Persistence

A world persists as periodic snapshots plus an append-only action log, in a handful of keys under `worlds/<id>/`. The same code recovers from a crash, a WASM trap or a rebuild of the game. Rust owns the byte containers and the decisions (`packages/engine/crates/engine/src/persist/`, `migrate.rs`, the `sim_snapshot_*` / `sim_restore_*` / `sim_upgrade_*` / `sim_replay_*` exports in `host/mod.rs`). TypeScript owns storage and sequencing: `packages/engine/src/host/persistence.ts` (`Persistence`), `host/upgrade.ts`, `host/recovery.ts`, the adapters in `src/storage/`, and `src/world-lock.ts`. The sim worker (`worker/sim.ts`) and the server (`createWorldServer` in `server.ts`) are the two callers. Rationale: [0005](../decisions/0005-persistence-and-recovery.md), amended by [0024](../decisions/0024-planning-amendments.md) §2-4, [0038](../decisions/0038-persistence-container-additions.md) and [0065](../decisions/0065-phase-3-decisions-persistence.md). Conventions per directory: `crates/engine/src/persist/CLAUDE.md`, `src/storage/CLAUDE.md`, `src/host/CLAUDE.md`.

## What is stored

Keys come from `worldKeys(worldId)` (`storage/types.ts`); segment and tick are zero-padded so a lexicographic `list` sorts numerically.

- `manifest`: `ManifestV1` as JSON (`worldId`, `epoch`, `params` plus `chunkBits`, `created` identity, `segments[]` with `base`, `sealed`, `tailReexecuted`). Host metadata only; load never trusts it for segment discovery.
- `log/<segment>`: a segment header (`persist::SegmentHeader`, carries the identity and names the base), then one frame per tick that had records: `len | tick_delta | count | records | crc32`. A record is `kind u8 | player_slot u8 | payload`; kinds are game action (payload `seq varint | write_sized(G::Action)`, length-prefixed per 0038), connection event, or `Skip { segment, offset }`. Readers reject a frame over `MAX_FRAME_BYTES` (64 KiB, `persist/frame.rs`) and a snapshot over `MAX_SNAPSHOT_BYTES` (64 MiB, `persist/snapshot.rs`) as corrupt. Ticks without records are implied by `tick_delta` and not logged. The log is never compacted.
- `snap/<tick>`: `PSN1` magic, `container_version`, `total_len`, identity, tick, log position (`segment`, `offset`), `log_ref_tick`, `SimRng`, the `Store` in canonical order, `state_hash`, `crc32` (`persist/snapshot.rs`; additions beyond 0005 in 0038). Field order is owned by 0005; a byte change invalidates the checked-in goldens and bumps `container_version`.
- `sessions`: the session table (`host/sessions.ts`, [0013](../decisions/0013-sessions-and-integrity.md)).

Identity (`persist::Identity`): first 128 bits of the build hash (SHA-256 of the `.wasm`), `engine_version`, `game_version`, `SCHEMA_VERSION`, `tick_rate_hz`, worldgen stamp. Formats are postcard inside hand-written containers; tile overlays are raw little-endian arrays.

## Write side

`Persistence.create` writes the manifest and segment 0's header. `appendFrame` is `SimHost.logSink`: a fixed arrow-property, called write-ahead before a frame is applied. `afterTick(tick)` runs after every `sim_tick` and drives the cadence:

- `Storage.sync` at most once a second (`ticksPerSecond` ticks) and only if something was appended.
- A snapshot every `SNAPSHOT_EVERY_TICKS` = 1,200 ticks (a tick count, not scaled to the tick rate), only if `sim_dirty()`. `snapshotNow` streams `sim_snapshot_begin` / `sim_snapshot_next` through the Persist region into one reused `SnapshotBuffer` and hands the bytes to `Storage.write(snap/<tick>)`. The Rust writer builds the whole snapshot in its arena in `begin` and wasm memory never shrinks, so the arena peak is permanent ([0065](../decisions/0065-phase-3-decisions-persistence.md) §11; budget in [0062](../decisions/0062-budgets-as-measured-at-phase-3-exit.md)). The write is a budgeted event, not inside the strict zero-GC window ([0039](../decisions/0039-snapshot-write-is-a-budgeted-event.md)).
- Segment roll: at a snapshot, if the open segment is at least `SEGMENT_ROLL_BYTES` (4 MiB), the segment is sealed, the new segment's header is appended and the snapshot becomes its base. Order: header, snapshot, then manifest, so a crash between them leaves self-describing data.
- Clean boundaries: `SimHost.pause()` / `stop()` (async) call `snapshotIfDirty`, `pruneSnapshots`, then `flush()`; the main thread listens for `visibilitychange -> hidden` and `pagehide` (`client.ts`) and asks the sim worker to pause, the server on zero players and on its idle timer. Pruning keeps every segment's base snapshot plus the newest two, and only runs off the tick path (`Storage.list`).
- `Storage.onError` is set by `Persistence`; once it fires, `appendFrame` and `afterTick` throw and `SimHost` raises `onFatal` (a failed write is fatal to the world; files stay untouched).
- `bumpEpoch()` rewrites the manifest's `epoch`; the host calls it after every trap recovery (`onRecovered`) and once at start whenever `open` did not return `created` (`server.ts`), so clients drop predicted state and resync.

Loss windows: after a tab close or WASM panic no admitted action is lost; after an OS crash on a local-disk adapter up to about 1 s of actions; action-free progress since the last snapshot (up to 60 s) is always lost. The persisted log lags the world by 1-2 s of idle ticks after an unclean close, so compare against the last admitted action's tick, not the world tick at kill time ([0065](../decisions/0065-phase-3-decisions-persistence.md) §9). The 1 s `sync` interval was measured on iPhone and Pixel and stays (§8, with the retune thresholds).

## Load: `Persistence.open`

`open(storage, cfg, newInstance)` is create-or-load. No manifest: `newInstance()`, `create`, outcome `'created'`. A manifest: compare `chunkBits` with the running build (mismatch throws `WorldLoadError('incompatible', ..., 'ChunkSize')` before any write), then `loadLatest`, then `healManifest` (rewrites a manifest a crash left behind a roll), then `pruneSnapshots`. Outcomes: `created`, `loaded`, `recovered` (a candidate was skipped or a torn tail truncated), `upgraded`.

`loadLatest` (static, also used by `recover()`):

1. List `snap/` keys newest first. Each candidate gets a fresh `newInstance()` and goes through `runUpgradeCandidate` (`sim_upgrade_begin/push/end`, which also covers the same-build case). A bad CRC, a bad container, or a log offset beyond its segment's stored bytes falls back to the next older candidate. `Incompatible` throws at once with no fallback (every snapshot of a segment shares the identity).
2. No usable snapshot: genesis replay of segment 0. The stored identity is segment 0's header, compared by `sim_identity_compare`; an undecodable non-empty header is `WorldLoadError('corrupt')`. A world with no snapshot can only be `Same` or `Direct`, never migrated ([0065](../decisions/0065-phase-3-decisions-persistence.md) §3, §4).
3. Replay the chosen tail in two passes: `sim_replay_scan_*` collects `Skip` targets (a `Skip` points at an earlier frame), then `sim_replay_begin/push/end` applies. Replay stops at the first torn or CRC-failing frame; the log is truncated with `Storage.write(log, validPrefix)` (`Storage` has no truncate; every adapter must accept `append` after `write` on the same key).
4. If the identity changed, `openNewSegmentAfterUpgrade` (`host/upgrade.ts`): write the new snapshot, `flush()`, write the manifest (old segment sealed, `tailReexecuted` set), append the new header.

`WorldLoadError.kind` is `'corrupt' | 'container' | 'incompatible'`; `'identity'` exists in the type but nothing throws it, and `'container'` is not raised either (a bad container version falls back like a bad CRC). A load failure leaves every stored byte untouched. The client sees it as `save-incompatible` rejecting `client.ready`; a busy lock is `world-busy` ([0050](../decisions/0050-engine-failure-surface.md)).

## Upgrades and migration

`Identity::compare` (`persist/identity.rs`) returns `Same` (build hash equal), `Direct` (hash differs, `SCHEMA_VERSION`, tick rate and worldgen stamp equal) or `NeedsMigrate(Schema | TickRate | Worldgen)`; there is no incompatible outcome. Any schema difference, older or newer, goes to `Game::migrate` ([0065](../decisions/0065-phase-3-decisions-persistence.md) §2). The default `migrate` returns `SaveIncompatible`, reported as `MigrateDeclined`.

- `Direct`: restore the snapshot, re-execute the log tail under the new code, drop (count, warn) any record that no longer decodes. The old segment is sealed with `tailReexecuted: true`. `SCHEMA_VERSION` also covers the encoded layout of `G::Action`, because postcard is not self-describing ([0024](../decisions/0024-planning-amendments.md) §3).
- `NeedsMigrate`: `migrate.rs` decodes the old `Store` into `OldStore` (a byte-for-byte reader of `Store::write_canonical`; change both together or old saves misparse), the game's `migrate` writes through `Migrating` (a `WorldWrite` with no state-budget checks), and engine timers are rescaled with `Rescale` when the tick rate changed ([0006](../decisions/0006-time-units.md)). The tail is dropped, not re-executed; the dropped count is in the result (`upgrade.droppedTailRecords`).
- The identity is compared per snapshot candidate against its own decoded identity, never against `manifest.created`, which would retrigger the upgrade on every reload ([0065](../decisions/0065-phase-3-decisions-persistence.md) §5).
- Every upgrade starts a new segment, even a rules-only one. Old segments stay replayable only by rebuilding the binary their header names. Old binaries are not archived.
- A hosted server with a schema bump and the default `migrate` exits 1 (`incompatible (MigrateDeclined)`); the stored world must be moved aside by hand ([0065](../decisions/0065-phase-3-decisions-persistence.md) §6, `games/reference-server/README.md`).

## Recovery from traps

A WASM trap poisons the instance; a dead instance is only read, never called. `SimHost.recover()` guards (more than `RECOVERY_LOOP_LIMIT` = 3 recoveries without `RECOVERY_GOOD_TICKS_RESET` = 1,200 good ticks is fatal) and calls `runPanicRecovery` (`host/recovery.ts`), which calls `persistence.recover(newInstance)` (= `loadLatest` on the live `Persistence`'s storage, then rebinds its `sim`, `segment`, `logOffset`). If replay traps again, the `ProgressCursor` (`RegionId.Progress`, written by `Host` around risky calls) says where: in `ApplyRecord`, `appendSkip` writes a `Skip { segment, offset }` frame to that segment and recovery restarts honoring it; in any other phase the world is wedged and `onFatal` fires with all files untouched. An `Admit` trap is never logged; it is answered `Rejected(Engine(EngineFault))` through `sim_fault_ack(conn, seq)` and the server tracks `inFlightAdmitConn` ([0065](../decisions/0065-phase-3-decisions-persistence.md) §1). After a successful recovery the epoch is bumped.

## Storage backends

`Storage` (`storage/types.ts`, re-exported from `server.ts`): `append`, `sync`, `write` (atomic replace), `delete`, `onError` on the tick side; `flush`, `read`, `list` off it. The tick path never awaits storage; adapters copy `bytes` before returning. Calls on a key take effect in call order, and `flush` / `read` / `list` must await the write and delete path as well as the appender ([0065](../decisions/0065-phase-3-decisions-persistence.md) §7: a reopen right after `stop()` once raced the manifest rename). `runStorageConformance` (`storage/conformance.ts`) is the shared contract test.

- `memoryStorage()` (`memory.ts`): never durable; the fallback when OPFS is missing (Safari private mode), reported as `durable: false`; `crashClone` simulates torn writes in tests.
- `opfsStorage(worldId)` (`opfs.ts`): sim worker only, sync access handles; throws `OpfsUnavailable` when OPFS fails. `append` / `sync` are plain methods that allocate no promise; `write` is scratch file plus `move()` rename, finished by promise-only work that `worker/sim.ts` polls via `pendingAsync()` between passes. Every instance shares the origin-wide root, so the running world's storage reaches other worlds' keys.
- `fsStorage(dir)` (`fs.ts`, exported from `engine/server/node`, Bun and Deno re-export it): `node:fs/promises` only; two preallocated 1 MiB append buffers per log key, `fdatasync`; `write` is temp file, datasync, rename.
- Hosts without files supply their own adapter. Durable Objects are not a target ([0051](../decisions/0051-durable-objects-no-go.md)).

`navigator.storage.persist()` is called once from the main thread, on the first gesture or `dispatch`, only after a world was `created`; `client.onStorage` reports `{ durable, persisted, usage, quota }`.

## World lock

Two Web Locks (`world-lock.ts`, [0050](../decisions/0050-engine-failure-surface.md) §6): the main thread takes `world-owner:<id>` for its client's lifetime and waits `WORLD_OWNER_WAIT_MS` (300 ms); a held lock means a live second tab and the start is refused with `world-busy`. The sim worker takes `world:<id>` (`requestWorldLock` in `worker/sim.ts`, an exclusive request that never settles) with a wait of at most `WORLD_LOCK_WAIT_MS` (3,000 ms, a ceiling: `pagehide` wakes a worker blocked in `Atomics.wait` so the browser ends it and frees the lock). Import and delete of another world take that world's `world:<id>` lock; both refuse the running world's id. The exclusive OPFS handle is the backstop.

## Export and import

`storage/archive.ts`: `exportWorld(storage, id)`, `importWorld(storage, bytes, { worldId?, overwrite? })`, `deleteWorld(storage, id)`, plain functions over any `Storage`, re-exported from `server.ts`. The archive is gzip of magic, version, world id, then every key relative to `worlds/<id>/`, so import can re-root under another id; an existing target throws `WorldExistsError` unless `overwrite`. Import writes keys only; the normal load path (including upgrade) runs on the next `Persistence.open`. The browser client exposes `client.exportWorld()` / `importWorld()` / `deleteWorld()`, serialized with pause/resume on one queue in the sim worker (`makeWorldOpHandler`); they keep working after a failed load. `games/reference-server --import <archive>` is the single-player-to-hosted path: same `.wasm`, same containers, same keys, and the browser secret reclaims the same player ([0013](../decisions/0013-sessions-and-integrity.md)). This is the only protection against Safari's storage eviction.

## Gotchas

- Instantiate cost on restore: `Persistence.open` creates a probe instance for the `chunk_bits` check and `loadLatest` creates a second for the restore, neither released before the first GC. Peak is two arenas. It is the cause of the Durable Object no-go and a startup memory spike on tight hosts; diagnosis and fix owed ([0065](../decisions/0065-phase-3-decisions-persistence.md) §14).
- No byte golden pins a log that crosses two segments; the tick-reference reset in `sim_segment_header` is required but untestable by hash (§12).
- Presence is not logged or replayable; nothing is reserved for it (§13).
- Untrusted stored bytes go through `decode_canonical` (`persist::read_sized`), never `decode`. Never iterate an unordered container in a writer ([determinism](../../.claude/rules/determinism.md)). `appendFrame`, `afterTick` and OPFS `append` are tick path: [hot-paths](../../.claude/rules/hot-paths.md).
- The snapshot cadence and the sync interval count ticks, so they follow the game's tick rate rather than wall time.

## Tests

- Rust: unit tests beside `persist/*.rs` and `migrate.rs`, byte goldens `persist_frame_golden_bytes` and `persist_snapshot_golden_bytes` (regenerate only with `GOLDEN_BLESS=1`); suite `rust`.
- `packages/engine/tests/wasm/` (suite `wasm`, also a Bun leg): `persistence`, `persist-open`, `persist-restore`, `persist-rolling`, `persist-log-parity`, `upgrade`, `panicky-recovery`, `storage-fs`, `server`, `replay-world`.
- `src/storage/conformance.test.ts` and `src/storage/archive.test.ts` (suite `unit`): memory-adapter conformance, archive round trip.
- `packages/engine/tests/browser/` (suite `browser`): `storage-opfs.spec.ts`, `world-archive.spec.ts`, `world.spec.ts` (world-busy, durable false), `sim-panicky.spec.ts`; the reference project covers export/import and world-busy. On-device OPFS latency and lock checks: the [device-check skill](../../.claude/skills/device-check/SKILL.md).
