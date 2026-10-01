// The desync report as games see it (docs/plan/37-robustness-events.md step 4, `client.onDesync`):
// the TS mirror of M31b's `integrity::DesyncReport`, read from the client instance's ring
// (`client_desync(index)`, 40 little-endian bytes into `Result`: `count u32` (total ever), `retained
// u32`, then the `index`th retained report, oldest first: `tick u32`, `scope u32` (0 Chunk, 1
// Global, 2 OwnPlayer), `cx i32`, `cy i32`, `host_hash u64`, `client_hash u64`). Shared by the
// client worker (production) and `engine/test` (`test/desync.ts`).
import { RegionId, Status } from './abi.js'
import type { EngineInstance } from './loader.js'

export type DesyncScope = 'chunk' | 'global' | 'ownPlayer'

export interface DesyncReport {
  tick: number
  scope: DesyncScope
  /** The chunk; `(-2147483648, -2147483648)` for `global`/`ownPlayer`. */
  cx: number
  cy: number
  /** 16-digit lowercase hex. */
  hostHash: string
  /** 16-digit lowercase hex; all zero on the host side (`ResyncChunk` carries only the coord). */
  clientHash: string
}

export const DESYNC_SCOPES: readonly DesyncScope[] = ['chunk', 'global', 'ownPlayer']

/** The ring's counters into `out`: `count` reports ever recorded, `retained` still in the ring (at
 * most 16). `false` when the call is not answered. Allocation-free: the client worker calls this
 * after every applied frame. */
export function readDesyncCounts(
  inst: EngineInstance,
  fn: (index: number) => number,
  out: { count: number; retained: number },
): boolean {
  if (inst.call1(fn, 0) !== Status.Ok) return false
  const region = inst.region(RegionId.Result)
  if (!region) return false
  const u8 = region.u8
  out.count =
    ((u8[0] ?? 0) | ((u8[1] ?? 0) << 8) | ((u8[2] ?? 0) << 16) | ((u8[3] ?? 0) << 24)) >>> 0
  out.retained =
    ((u8[4] ?? 0) | ((u8[5] ?? 0) << 8) | ((u8[6] ?? 0) << 16) | ((u8[7] ?? 0) << 24)) >>> 0
  return true
}

/** The `index`th retained report, oldest first; `null` past the end. Allocates (a report is a
 * rare event). */
export function readDesyncReport(
  inst: EngineInstance,
  fn: (index: number) => number,
  index: number,
): DesyncReport | null {
  if (inst.call1(fn, index) !== Status.Ok) return null
  const region = inst.region(RegionId.Result)
  if (!region) return null
  const v = new DataView(region.u8.buffer, region.u8.byteOffset, 40)
  if (index >= v.getUint32(4, true)) return null
  return {
    tick: v.getUint32(8, true),
    scope: DESYNC_SCOPES[v.getUint32(12, true)] ?? 'chunk',
    cx: v.getInt32(16, true),
    cy: v.getInt32(20, true),
    hostHash: inst.readU64Hex(RegionId.Result, 24),
    clientHash: inst.readU64Hex(RegionId.Result, 32),
  }
}
