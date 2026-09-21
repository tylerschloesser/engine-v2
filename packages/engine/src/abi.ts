// Mirror of the ABI registry. The owner is `crates/engine/src/abi/registry.rs`, which also holds
// the rule for adding to the ABI; `tests/wasm/abi-registry.test.ts` fails when the two differ.
// No imports: test drivers under Node, Bun and the browser load this file as it is.

export const ABI_VERSION = 7

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
  sim_tick: { role: 'sim', params: 0, result: 'status' },
  sim_build_frame: { role: 'sim', params: 1, result: 'len' },
  sim_hash: { role: 'sim', params: 0, result: 'status' },
  // docs/plan/13-sim-host-tick-loop.md: creates the world from the init config (`Sim::genesis`
  // for a real `Game`). M22b adds the load-from-storage path.
  sim_genesis: { role: 'sim', params: 0, result: 'status' },
  // docs/plan/13-sim-host-tick-loop.md: write-ahead log bytes for the frame about to be applied
  // (0024 §1), written into `RegionId.Persist`. Always 0 until M22 (Non-scope here).
  sim_seal_frame: { role: 'sim', params: 0, result: 'len' },
  // docs/plan/13-sim-host-tick-loop.md: generates at most one uncached chunk from the warm list
  // (`host::warm`), nearest-to-view-centre first. `1`/`0` (not a `Status`: costs nothing, always
  // answers), the same shape as `gen_take`/`upload_stage`.
  sim_warm_one: { role: 'sim', params: 0, result: 'u32' },
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
} as const satisfies Record<string, ExportSpec>

export function statusName(n: number): string {
  for (const [name, value] of Object.entries(Status)) if (value === n) return name
  return `Status(${n})`
}
