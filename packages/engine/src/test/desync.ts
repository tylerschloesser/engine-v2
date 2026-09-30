// Reading the desync report rings (docs/plan/31b-desync-hashes.md): `sim_desync(index)` and
// `client_desync(index)` each write 40 little-endian bytes into `Result`: `count u32` (total ever
// recorded), `retained u32`, then the `index`th retained report, oldest first: `tick u32`,
// `scope u32` (0 Chunk, 1 Global, 2 OwnPlayer), `cx i32`, `cy i32`, `host_hash u64`, `client_hash
// u64`. `engine/test` only.
import { RegionId, Status } from '../abi.js'
import type { EngineInstance } from '../loader.js'

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

export interface DesyncLog {
  /** Reports ever recorded. */
  count: number
  /** The last (at most 16) reports, oldest first. */
  reports: DesyncReport[]
}

const SCOPES: DesyncScope[] = ['chunk', 'global', 'ownPlayer']

export function readDesyncLog(
  inst: EngineInstance,
  fn: (index: number) => number,
  label: string,
): DesyncLog {
  const out: DesyncLog = { count: 0, reports: [] }
  let retained = 1
  for (let index = 0; index < retained; index++) {
    const status = inst.call1(fn, index)
    if (status !== Status.Ok) throw new Error(`${label}: status ${status}`)
    const region = inst.region(RegionId.Result)
    if (!region) throw new Error(`${label}: no Result region`)
    const v = new DataView(region.u8.buffer, region.u8.byteOffset, 40)
    out.count = v.getUint32(0, true)
    retained = v.getUint32(4, true)
    if (index >= retained) break
    out.reports.push({
      tick: v.getUint32(8, true),
      scope: SCOPES[v.getUint32(12, true)] ?? 'chunk',
      cx: v.getInt32(16, true),
      cy: v.getInt32(20, true),
      hostHash: inst.readU64Hex(RegionId.Result, 24),
      clientHash: inst.readU64Hex(RegionId.Result, 32),
    })
  }
  return out
}
