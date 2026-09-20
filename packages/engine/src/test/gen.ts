// `engine/test`'s `gen` namespace (docs/plan/08b-gen-workers-and-queue.md, Seams: `gen.stats`,
// `gen.idle`, `gen.chunkHash`), built on `callParked` (orchestrator decision 1 at the step-5
// boundary): the client instance recomputes `GenStats` and answers `client_chunk_hash` inside its
// own non-shared WASM memory (0015 §4: no shared WASM memory, ever), unreachable from main except
// through the parked-only test-call channel.
import { Status } from '../abi.js'
import type { Client } from '../client.js'
import { clientTestHandle } from '../client.js'
import { W_PARKED, workerWord } from '../sab/control.js'
import { callParked, parkWorkers, resumeWorkers, stepFrame, untilQuiescent } from './client.js'

/** `GenStats`' own field order (`engine::gen_queue::GenStats`, `crates/engine/src/gen_queue.rs`):
 * `client_gen_stats` writes these seven `u32`s into `Result` in exactly this order. */
export type GenStats = {
  requested: number
  dispatched: number
  delivered: number
  cancelled: number
  requeued: number
  pending: number
  inFlight: number
}

const GEN_STATS_BYTES = 28
const CHUNK_HASH_BYTES = 8
const CLIENT_ISOLATE = 'client'
const FRAME_MS = 1000 / 60

function readU32LE(u8: Uint8Array, off: number): number {
  return (
    ((u8[off] as number) |
      ((u8[off + 1] as number) << 8) |
      ((u8[off + 2] as number) << 16) |
      ((u8[off + 3] as number) << 24)) >>>
    0
  )
}

function decodeStats(result: Uint8Array): GenStats {
  return {
    requested: readU32LE(result, 0),
    dispatched: readU32LE(result, 4),
    delivered: readU32LE(result, 8),
    cancelled: readU32LE(result, 12),
    requeued: readU32LE(result, 16),
    pending: readU32LE(result, 20),
    inFlight: readU32LE(result, 24),
  }
}

/** 16 lowercase hex digits from an 8-byte little-endian u64 (lo, hi `u32`): the same convention
 * `EngineInstance.readU64Hex` uses in-process, replicated here since a `callParked` reply is a
 * plain `Uint8Array` copy, not a live region. */
function hex64LE(u8: Uint8Array): string {
  let hex = ''
  for (let i = 7; i >= 0; i--) hex += (u8[i] as number).toString(16).padStart(2, '0')
  return hex
}

function isFullyParked(client: Client): boolean {
  const h = clientTestHandle(client)
  for (const w of h.workers) {
    if (Atomics.load(h.control.words, workerWord(w.index, W_PARKED)) !== 1) return false
  }
  return true
}

/** Parks every worker only when at least one is not already parked, runs `fn`, and resumes only
 * when this call did the parking (Seams: "park the workers if they are not parked ... resume only
 * if they parked them"). */
async function withParked<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  const already = isFullyParked(client)
  if (!already) await parkWorkers(client)
  try {
    return await fn()
  } finally {
    if (!already) await resumeWorkers(client)
  }
}

/** `GenStats` freshly recomputed by the client instance (Seams). */
export async function stats(client: Client): Promise<GenStats> {
  return withParked(client, async () => {
    const { result } = await callParked(
      client,
      CLIENT_ISOLATE,
      'client_gen_stats',
      [],
      GEN_STATS_BYTES,
    )
    return decodeStats(result)
  })
}

/** The FNV hash of a cached chunk's effective slab, or `null` when it is not resident (Seams). */
export async function chunkHash(client: Client, cx: number, cy: number): Promise<string | null> {
  return withParked(client, async () => {
    const { value, result } = await callParked(
      client,
      CLIENT_ISOLATE,
      'client_chunk_hash',
      [cx, cy],
      CHUNK_HASH_BYTES,
    )
    if (value === Status.NotCached) return null
    return hex64LE(result)
  })
}

/** Steps frames until the queue is both empty and idle (`pending == 0 && in_flight == 0`), then
 * waits for every ring to drain (Seams). */
export async function idle(client: Client): Promise<void> {
  for (;;) {
    stepFrame(client, FRAME_MS)
    const s = await stats(client)
    if (s.pending === 0 && s.inFlight === 0) break
  }
  await untilQuiescent(client)
}
