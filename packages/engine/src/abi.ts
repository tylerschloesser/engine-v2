// Mirror of the ABI registry. The owner is `crates/engine/src/abi/registry.rs`, which also holds
// the rule for adding to the ABI; `tests/wasm/abi-registry.test.ts` fails when the two differ.
// No imports: test drivers under Node, Bun and the browser load this file as it is.

export const ABI_VERSION = 23

/** Size of the static boot region: config JSON in at offset 0, panic text out in the tail. */
export const BOOT_BYTES = 65536
/** Bytes at the end of the boot region kept for panic text; the config may use the rest. */
export const BOOT_TEXT_BYTES = 4096
/** Capacity of the `Result` region that every role has. */
export const RESULT_BYTES = 64

export const Role = { Sim: 0, Client: 1, Gen: 2 } as const
export type Role = (typeof Role)[keyof typeof Role]

export const Status = {
  Ok: 0,
  WrongRole: 1,
  NotInitialised: 2,
  AlreadyInitialised: 3,
  BadConfig: 4,
  BadLength: 5,
  Decode: 6,
  OutOfMemory: 7,
  Unsupported: 8,
  NotCached: 9,
  BudgetExceedsArena: 10,
  // docs/plan/22b-persistence-load-and-fs.md: `sim_restore_end` -- the decoded snapshot's own
  // `Identity.buildHash` differs from this running build's. Reported, not handled (M24b's own
  // migrate path); `Persistence.open` throws `WorldLoadError { kind: 'identity' }`.
  IdentityMismatch: 11,
  // docs/plan/22b-persistence-load-and-fs.md: `sim_restore_begin`/`sim_restore_push`/
  // `sim_restore_end` -- the pushed bytes did not decode as a valid snapshot (a bad CRC, or still
  // `NeedMore` at `sim_restore_end`, i.e. a torn snapshot). `Persistence.open` falls back to the
  // next older snapshot.
  Corrupt: 12,
  // docs/plan/22b-persistence-load-and-fs.md: `sim_restore_begin`/`sim_restore_push` -- the pushed
  // bytes' `container_version` does not match this build's own.
  ContainerVersion: 13,
  // docs/plan/22b-persistence-load-and-fs.md: `sim_replay_push`/`sim_replay_end` -- a pushed block
  // failed to decode as a whole, CRC-valid frame. Not an error for the last (currently open)
  // segment: that is how recovery finds the torn tail to truncate (`sim_replay_valid_end`).
  TornTail: 14,
  // docs/plan/24b-upgrade-and-migration.md: `sim_upgrade_end` -- the load takes the `Game::migrate`
  // path (identity/schema/tick-rate/worldgen mismatch) and either `Game::migrate` itself declined
  // or the old-schema bytes failed to decode. A reason byte (`IncompatReason` in host/upgrade.ts)
  // is written to `Result[0]`; every stored byte stays untouched on this path (0005 Upgrades).
  SaveIncompatible: 15,
} as const
export type Status = (typeof Status)[keyof typeof Status]

export const RegionId = {
  Rx: 0,
  Tx: 1,
  Result: 2,
  DrawList: 3,
  ChunkTexels: 4,
  Ui: 5,
  Persist: 6,
  Camera: 7,
  GenOut: 8,
  GenIn: 9,
  // docs/plan/15b-ring-connection-and-replica-rendering.md: the client role's own inbound buffer
  // for one whole host frame (`on_frame`'s `len` bytes), distinct from `Rx` (already the client
  // role's input-record buffer, M11). The client's own outbound uplink batch reuses `Tx`,
  // unclaimed by the client role until now.
  Downlink: 10,
  // docs/plan/24-recovery-and-migration.md: `ProgressCursor` (`phase u32 | tick u32 | record u32`,
  // 12 B, sim role) -- written by Rust before each phase, readable from a *dead* instance with no
  // export call at all (0014 §6: `inst.region(id).u8` / `inst.mem`). Not sim state (never hashed,
  // snapshotted or logged).
  Progress: 11,
} as const
export type RegionId = (typeof RegionId)[keyof typeof RegionId]

export const LogLevel = { Error: 0, Warn: 1, Info: 2, Debug: 3 } as const
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel]

export type ExportSpec = {
  /** Which role may call it; every module carries every export whatever its role. */
  role: 'all' | 'sim' | 'client' | 'gen'
  /** Number of parameters, all numbers (0014 §2). */
  params: 0 | 1 | 2
  /** `len` is an i32 where a negative value is `-(status)`. */
  result: 'status' | 'len' | 'ptr' | 'u32' | 'void'
}

export const ABI_EXPORTS = {
  engine_abi_version: { role: 'all', params: 0, result: 'u32' },
  engine_boot: { role: 'all', params: 0, result: 'ptr' },
  engine_init: { role: 'all', params: 2, result: 'status' },
  engine_region: { role: 'all', params: 1, result: 'ptr' },
  engine_region_len: { role: 'all', params: 1, result: 'u32' },
  engine_mem_grows: { role: 'all', params: 0, result: 'u32' },
  sim_admit: { role: 'sim', params: 2, result: 'status' },
  // docs/plan/15b-ring-connection-and-replica-rendering.md: admits `conn` into the sim role's
  // connection table (`host::Host::connect`). The caller (`SimHost.accept`) picks `conn`.
  sim_connect: { role: 'sim', params: 1, result: 'status' },
  // docs/plan/24-recovery-and-migration.md, Traps ("Connections stay open across recovery"):
  // re-attaches `conn` with the same deterministic `PlayerId` a live `sim_connect` would assign,
  // but queues no `Record::Player` event and touches no game state (`host::Host::reattach`'s own
  // doc comment). Recovery's own re-attach call site, distinct from `sim_connect`.
  sim_reattach: { role: 'sim', params: 1, result: 'status' },
  // docs/plan/24-recovery-and-migration.md fix round 1 (Planning decisions 2): queues
  // `Rejected(Engine(EngineFault))` for `seq` directly onto `conn`'s own (already-reattached)
  // connection, and raises its dedup floor so a resend of that exact `seq` is dropped rather than
  // re-admitted (and, for a deterministically-panicking action, re-trapped). `host::Host::
  // fault_ack`'s own doc comment has the full reasoning.
  sim_fault_ack: { role: 'sim', params: 2, result: 'status' },
  // docs/plan/15b-ring-connection-and-replica-rendering.md: frees `conn`'s slot (`host::Host::
  // disconnect`). An unknown/already-disconnected `conn` is a tolerated no-op, not an error.
  sim_disconnect: { role: 'sim', params: 1, result: 'status' },
  sim_tick: { role: 'sim', params: 0, result: 'status' },
  sim_build_frame: { role: 'sim', params: 1, result: 'len' },
  sim_hash: { role: 'sim', params: 0, result: 'status' },
  // docs/plan/13-sim-host-tick-loop.md: creates the world from the init config (`Sim::genesis`
  // for a real `Game`). M22b adds the load-from-storage path.
  sim_genesis: { role: 'sim', params: 0, result: 'status' },
  // docs/plan/13-sim-host-tick-loop.md: write-ahead log bytes for the frame about to be applied
  // (0024 §1), written into `RegionId.Persist`. Real since docs/plan/
  // 22-persistence-log-and-snapshots.md steps 4-6 (0 = nothing to log this tick).
  sim_seal_frame: { role: 'sim', params: 0, result: 'len' },
  // docs/plan/13-sim-host-tick-loop.md: generates at most one uncached chunk from the warm list
  // (`host::warm`), nearest-to-view-centre first. `1`/`0` (not a `Status`: costs nothing, always
  // answers), the same shape as `gen_take`/`upload_stage`.
  sim_warm_one: { role: 'sim', params: 0, result: 'u32' },
  // docs/plan/13-sim-host-tick-loop.md ("20 Hz is hardcoded" gap): the game's own tick rate
  // (`u32`, e.g. `20`), read once by `SimHost` at construction. `20` (the `Instance` trait
  // default) on any instance that never overrides it; not a `Status`, same shape as
  // `sim_warm_one`. `role: 'all'` (docs/plan/16-action-round-trip.md, broadened from `'sim'`): the
  // answer is role-independent (a game-level constant), and the client worker now also reads its
  // own instance's rate once, at setup, for the clock block's `ticks_per_second`.
  tick_hz: { role: 'all', params: 0, result: 'u32' },
  // docs/plan/24b-upgrade-and-migration.md Scope: `G::CHUNK_BITS`, read once by `Persistence.
  // create`/`Persistence.open` to stamp/compare `ManifestV1.params.chunkBits`. Same "any
  // initialised role, cost nothing" shape as `tick_hz`.
  chunk_bits: { role: 'all', params: 0, result: 'u32' },
  // `t_ms: f64` (0014 §4's client hot-export table; docs/plan/06b-workers-and-spawn.md): called
  // only when `CB_FRAME_REQ` has advanced since the last call (Planning decisions "Worker frame
  // clock"). `params: 1` here means "one number", whatever its wasm type (0014 §2).
  frame: { role: 'client', params: 1, result: 'status' },
  // `gen_chunk(cx, cy)` (docs/decisions/0008-chunk-generation.md §1, §2 table): writes
  // `region(RegionId.GenOut).len` bytes, little-endian tiles, row-major.
  gen_chunk: { role: 'gen', params: 2, result: 'status' },
  // docs/plan/08b-gen-workers-and-queue.md: `1` when a 16-byte genRequest record now sits at
  // offset 0 of `Result`, `0` otherwise (not a `Status`: costs nothing, always answers, even with
  // no `client::TerrainFeed`).
  gen_take: { role: 'client', params: 1, result: 'u32' },
  // `gen_deliver(worker, len)`: `len` bytes of `GenIn` are the genResult record.
  gen_deliver: { role: 'client', params: 2, result: 'status' },
  // Seven `u32`s (`GenStats`' fields) into `Result`.
  client_gen_stats: { role: 'client', params: 0, result: 'status' },
  // `client_chunk_hash(cx, cy)`: lo, hi `u32` of an FNV hash into `Result`, or `Status.NotCached`.
  client_chunk_hash: { role: 'client', params: 2, result: 'status' },
  // docs/plan/09-renderer-terrain.md: stages up to `max_records` upload-ring records into
  // `RegionId.ChunkTexels`; returns the count actually staged (not a `Status`: costs nothing and
  // always answers, even with no `client::Uploader`, the same shape as `gen_take`).
  upload_stage: { role: 'client', params: 1, result: 'u32' },
  // docs/plan/11-camera-and-input.md: decodes `len` bytes of `Rx` as whole `inputRing` records
  // (32 bytes each) into whatever `InputQueue` the instance owns.
  on_input: { role: 'client', params: 1, result: 'status' },
  // docs/plan/15b-ring-connection-and-replica-rendering.md: `len` bytes of `RegionId.Downlink`
  // are one whole host frame (0011), applied atomically into the client role's own replica.
  on_frame: { role: 'client', params: 1, result: 'status' },
  // docs/plan/15b-ring-connection-and-replica-rendering.md: writes at most one uplink batch into
  // `RegionId.Tx`, returning its length (`0` = nothing due yet, 0010 "Rates"). `t_ms: f64` is
  // ignored (same shape as `frame`'s own raw argument): the real value is read from the
  // just-copied `CameraBlock.frame_time_ms`.
  client_poll_uplink: { role: 'client', params: 1, result: 'len' },
  // docs/plan/15b-ring-connection-and-replica-rendering.md, `engine/test` only: `host::Host::
  // region_hash(conn)`, two LE `u32` into `Result` (`sim_hash`'s own crossing shape).
  sim_region_hash: { role: 'sim', params: 1, result: 'status' },
  // docs/plan/15b-ring-connection-and-replica-rendering.md, `engine/test` only:
  // `client::Replica::region_hash()`, same crossing shape as `sim_region_hash`.
  client_region_hash: { role: 'client', params: 0, result: 'status' },
  // docs/plan/15b-ring-connection-and-replica-rendering.md, `engine/test` only: `host::
  // ConnCounters` for `conn`, little-endian into `Result` (56 bytes: seven `u64` fields,
  // `bytes_down, frames, chunk_enters_pristine, chunk_snapshots, chunk_leaves, bytes_up,
  // presence_bytes_up` -- docs/plan/19-presence-channel.md steps 4-6 appended the 7th field).
  sim_conn_counters: { role: 'sim', params: 1, result: 'status' },
  // docs/plan/16-action-round-trip.md: parses one action-ring record (`[seq u32 LE][len u32
  // LE][UTF-8 JSON]`) out of `len` bytes of `RegionId.Rx` (shared with `on_input`'s own,
  // differently-shaped records) into the game's `Action`, queues it for the next uplink batch.
  // `Status.Decode` on a malformed record, `Status.OutOfMemory` when the outbox is already full.
  on_action: { role: 'client', params: 1, result: 'status' },
  // docs/plan/16-action-round-trip.md: copies at most one batch of UI-ring records (kind 2,
  // `ActionResults` turned into JSON) into `RegionId.Ui`, returning the byte count (`0` = nothing
  // new; not a `Status`, same shape as `client_poll_uplink`/`upload_stage`).
  client_poll_ui: { role: 'client', params: 0, result: 'u32' },
  // docs/plan/16-action-round-trip.md (`ABI_VERSION` 11 -> 12): `authoritative_tick`, `ack_seq`
  // (`ClientCore::last_summary()`) as two LE `u32` into `Result` -- the client worker's own source
  // for the clock block's `authoritative_tick`/`ack_seq` fields, same crossing shape as
  // `sim_region_hash`/`client_region_hash`.
  client_clock_stats: { role: 'client', params: 0, result: 'status' },
  // docs/plan/16b-ui-observation-and-clock.md (`ABI_VERSION` 12 -> 13), `engine/test` only: forces
  // `UiObserver::mark_dirty()` (0024 §7d's dirty flag). No production caller exists yet (M18's
  // `FrameCx.uiDirty()` is the real one); reached only through `engine/test.markUiDirty`, the same
  // "test-only export, reached by name through `callParked`" shape as `sim_region_hash`/
  // `client_region_hash`/`sim_conn_counters`. No region crosses either way.
  client_ui_mark_dirty: { role: 'client', params: 0, result: 'status' },
  // docs/plan/16b-ui-observation-and-clock.md (`ABI_VERSION` 13 -> 14), `engine/test` only:
  // `UiObserver::{calls, records}` as two LE `u32` into `Result` -- proves "ui ran" and "zero
  // records written" as an assertion (coordinator gate, M16b cut 2), same crossing shape as
  // `sim_region_hash`/`client_region_hash`/`client_clock_stats`.
  client_ui_stats: { role: 'client', params: 0, result: 'status' },
  // docs/plan/17-drawlist-and-sprites.md (`ABI_VERSION` 14 -> 15): how many `Draw` records the
  // last `frame()` call's own counting sort wrote into `RegionId.DrawList` (`0` on a wrong role or
  // before the first `frame()` call; not a `Status`, same "always answer, cost nothing" shape as
  // `sim_warm_one`/`upload_stage`). The client worker reads this every wake it calls `frame()`, to
  // know how many `RegionId.DrawList` body blocks to copy into the `drawList` triple buffer
  // (`worker/client-drawlist.ts`).
  drawlist_len: { role: 'client', params: 0, result: 'u32' },
  // docs/plan/22-persistence-log-and-snapshots.md (`ABI_VERSION` 15 -> 16), sim role: encodes a
  // `SegmentHeader` (identity + base) into `RegionId.Persist`. `baseTick = 0xFFFF_FFFF` means
  // genesis; any other value is `Snapshot(Tick(baseTick))`.
  sim_segment_header: { role: 'sim', params: 2, result: 'len' },
  // docs/plan/22-persistence-log-and-snapshots.md (`ABI_VERSION` 15 -> 16), sim role: starts a
  // streaming snapshot of the current state at `(logSegment, logOffset)` -- the host owns the log
  // position (Planning decisions 4). `sim_snapshot_next` drains it afterward.
  sim_snapshot_begin: { role: 'sim', params: 2, result: 'status' },
  // docs/plan/22-persistence-log-and-snapshots.md (`ABI_VERSION` 15 -> 16), sim role: copies the
  // next block of the snapshot `sim_snapshot_begin` started into `RegionId.Persist`, `0` meaning
  // fully drained.
  sim_snapshot_next: { role: 'sim', params: 0, result: 'len' },
  // docs/plan/22-persistence-log-and-snapshots.md (`ABI_VERSION` 15 -> 16), sim role: `1` if any
  // put or logged record has happened since the last snapshot began draining, `0` otherwise (not a
  // `Status`: costs nothing, always answers, same shape as `sim_warm_one`/`drawlist_len`).
  sim_dirty: { role: 'sim', params: 0, result: 'u32' },
  // docs/plan/22b-persistence-load-and-fs.md (`ABI_VERSION` 16 -> 17), sim role: begins decoding a
  // snapshot of `totalLen` bytes fed in blocks by `sim_restore_push`. Does not require
  // `sim_genesis` to have run (the whole point: this replaces it for a loaded world).
  sim_restore_begin: { role: 'sim', params: 1, result: 'status' },
  // docs/plan/22b-persistence-load-and-fs.md: feeds the next `len` bytes of `RegionId.Persist`
  // (reused as a receive region) into the snapshot decode `sim_restore_begin` started.
  sim_restore_push: { role: 'sim', params: 1, result: 'status' },
  // docs/plan/22b-persistence-load-and-fs.md: finishes a restore. `Status.Ok` writes `logSegment`/
  // `logOffset` (two LE `u32`) into `RegionId.Result`; `Status.Corrupt` if the snapshot never
  // finished decoding or its CRC failed; `Status.IdentityMismatch` if its identity differs.
  sim_restore_end: { role: 'sim', params: 0, result: 'status' },
  // docs/plan/24b-upgrade-and-migration.md, sim role: begins the 0005 Upgrades sequence -- same
  // block protocol as `sim_restore_begin`, but never requires the decoded identity to match this
  // build's own.
  sim_upgrade_begin: { role: 'sim', params: 1, result: 'status' },
  // Feeds the next `len` bytes of `RegionId.Persist` (reused as a receive region, same shape as
  // `sim_restore_push`).
  sim_upgrade_push: { role: 'sim', params: 1, result: 'status' },
  // Finishes the upgrade: `Status.Ok` writes a direct(0)/migrated(1) tag byte plus `logSegment`/
  // `logOffset` (two LE `u32` at `Result[1..9]`) -- the *old* segment's own position, present
  // regardless of outcome; `Status.SaveIncompatible` writes an `IncompatReason` byte at `Result[0]`
  // and leaves every stored byte untouched (Planning decisions 7).
  sim_upgrade_end: { role: 'sim', params: 0, result: 'status' },
  // docs/plan/24b-upgrade-and-migration.md gate fix round 2 (`ABI_VERSION` 22 -> 23), sim role:
  // `persist::Identity::compare` for the genesis-replay fallback, which has no snapshot container
  // to feed `sim_upgrade_begin`/`push`/`end` at all (no snapshot has ever been written yet).
  // Reads `len` bytes of `RegionId.Persist` (reused as a receive region, same shape as
  // `sim_restore_push`) -- exactly `Identity::write`'s own wire shape, no envelope -- and writes
  // the verdict to `RegionId.Result`: `[0]` `0` = Same, `1` = Direct, `2` = NeedsMigrate (`[1]`
  // then `MismatchReason as u8`: Schema=0/TickRate=1/Worldgen=2). `Status.Decode` if `stored`
  // fails to parse as an `Identity` at all.
  sim_identity_compare: { role: 'sim', params: 1, result: 'status' },
  // docs/plan/22b-persistence-load-and-fs.md: begins replaying a segment's log tail from byte
  // `offset` (a `Sim` must already exist, from `sim_restore_end` or `sim_genesis`).
  sim_replay_begin: { role: 'sim', params: 2, result: 'status' },
  // docs/plan/22b-persistence-load-and-fs.md: feeds the next `len` bytes of `RegionId.Persist`
  // (reused as a receive region), applying every whole, CRC-valid frame it completes.
  // `Status.TornTail` once a block fails to decode -- not fatal for the currently open segment.
  sim_replay_push: { role: 'sim', params: 1, result: 'status' },
  // docs/plan/22b-persistence-load-and-fs.md: finishes a replay (`Status.Ok`, or `Status.TornTail`
  // if any push hit a bad block).
  sim_replay_end: { role: 'sim', params: 0, result: 'status' },
  // docs/plan/22b-persistence-load-and-fs.md: the byte offset, within the segment `sim_replay_begin`
  // named, just after the last frame whose CRC verified (not a `Status`: costs nothing, always
  // answers, same shape as `sim_dirty`).
  sim_replay_valid_end: { role: 'sim', params: 0, result: 'u32' },
  // docs/plan/22b-persistence-load-and-fs.md: the sim's current tick, read after a restore/replay
  // (or a live `sim_genesis`) to learn the resume tick (0005 Loss windows). Same shape as
  // `sim_dirty`.
  sim_tick_now: { role: 'sim', params: 0, result: 'u32' },
  // docs/plan/24-recovery-and-migration.md (`ABI_VERSION` 17 -> 18), sim role: begins the scan
  // pass -- decodes a segment tail purely to collect `Skip { segment, offset }` targets, over the
  // same bytes a caller then feeds again to `sim_replay_begin`/`push`/`end` (the real apply pass).
  sim_replay_scan_begin: { role: 'sim', params: 1, result: 'status' },
  // docs/plan/24-recovery-and-migration.md: feeds the next `len` bytes of `RegionId.Persist`
  // (reused as a receive region, same shape as `sim_replay_push`) into the scan pass.
  sim_replay_scan_push: { role: 'sim', params: 1, result: 'status' },
  // docs/plan/24-recovery-and-migration.md: finishes the scan pass; its own targets stay collected
  // for the `sim_replay_*` calls that follow.
  sim_replay_scan_end: { role: 'sim', params: 0, result: 'status' },
  // docs/plan/24-recovery-and-migration.md (`ABI_VERSION` 17 -> 18), sim role: encodes one frame
  // holding a single `Skip { segment, offset }` record (`tick_delta = 0`, never a real elapsed
  // tick) into `RegionId.Persist`, the same "bytes written, or `-(status)`" shape as
  // `sim_seal_frame`/`sim_segment_header`. Needs no live `Sim`.
  sim_log_skip: { role: 'sim', params: 2, result: 'len' },
  // docs/plan/24-recovery-and-migration.md, `engine/test` only: panics in whatever `Phase` the
  // previous, successfully-completed export left the `Progress` region in (`Phase.Idle` after any
  // ordinary call, since this writes nothing of its own before panicking). Test-only by
  // convention: reached only through `engine/test`'s `trapSim`.
  sim_test_trap: { role: 'sim', params: 0, result: 'status' },
} as const satisfies Record<string, ExportSpec>

export function statusName(n: number): string {
  for (const [name, value] of Object.entries(Status)) if (value === n) return name
  return `Status(${n})`
}
