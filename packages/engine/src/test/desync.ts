// Reading the desync report rings (docs/plan/31b-desync-hashes.md): `sim_desync(index)` and
// `client_desync(index)` each write 40 little-endian bytes into `Result`: `count u32` (total ever
// recorded), `retained u32`, then the `index`th retained report, oldest first: `tick u32`,
// `scope u32` (0 Chunk, 1 Global, 2 OwnPlayer), `cx i32`, `cy i32`, `host_hash u64`, `client_hash
// u64`. `engine/test` only.
import { RegionId, Status } from '../abi.js'
import { DESYNC_SCOPES, type DesyncReport } from '../desync.js'
import type { EngineInstance } from '../loader.js'

export type { DesyncReport, DesyncScope } from '../desync.js'

export interface DesyncLog {
  /** Reports ever recorded. */
  count: number
  /** The last (at most 16) reports, oldest first. */
  reports: DesyncReport[]
}

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
      scope: DESYNC_SCOPES[v.getUint32(12, true)] ?? 'chunk',
      cx: v.getInt32(16, true),
      cy: v.getInt32(20, true),
      hostHash: inst.readU64Hex(RegionId.Result, 24),
      clientHash: inst.readU64Hex(RegionId.Result, 32),
    })
  }
  return out
}

/** One hash-all dump (docs/plan/31b-desync-hashes.md): both encodings of a chunk whose hash
 * mismatched. `client` is the replica's bytes when the mismatched `Hashes` entry was checked;
 * `host` is the replica's bytes after the host's resync snapshot replaced them, i.e. the host's
 * encoding when it answered. Both are `integrity::encode_chunk` bytes (snapshot version written 0). */
export interface DesyncDump {
  tick: number
  cx: number
  cy: number
  client: Uint8Array
  host: Uint8Array
  /** The first offset at which the two differ, or -1 when they are the same bytes (the chunk
   * changed again between the mismatch and the answer) or -2 when one is a prefix of the other. */
  firstDiff: number
}

/** Drains every completed dump of one client (`client_desync_dump`, parts 0-3). */
export function takeDesyncDumps(inst: EngineInstance): DesyncDump[] {
  const out: DesyncDump[] = []
  const call = inst.x.client_desync_dump
  for (;;) {
    const headLen = inst.call1(call, 0)
    if (headLen <= 0) return out
    const tx = inst.region(RegionId.Tx)
    if (!tx) throw new Error('takeDesyncDumps: no Tx region')
    const v = new DataView(tx.u8.buffer, tx.u8.byteOffset, 16)
    const tick = v.getUint32(0, true)
    const cx = v.getInt32(4, true)
    const cy = v.getInt32(8, true)
    const clientLen = inst.call1(call, 1)
    const client = tx.u8.slice(0, Math.max(clientLen, 0))
    const hostLen = inst.call1(call, 2)
    const host = tx.u8.slice(0, Math.max(hostLen, 0))
    inst.call1(call, 3)
    let firstDiff = -1
    const n = Math.min(client.length, host.length)
    for (let i = 0; i < n; i++) {
      if (client[i] !== host[i]) {
        firstDiff = i
        break
      }
    }
    if (firstDiff < 0 && client.length !== host.length) firstDiff = -2
    out.push({ tick, cx, cy, client, host, firstDiff })
  }
}
