// M46 (docs/decisions/0078 §1): `engine/test`'s view of a client's replicated line structures, read
// through the test-only `client_line_structures` export (shape: `crates/engine/src/abi/registry.rs`),
// and the `client_corrupt_line` fault. Test-only: allocates freely.
import { RegionId, Status } from '../abi.js'
import type { EngineInstance } from '../loader.js'

/** A line's output as the replica holds it (0076 §1; a fork's toggle is item state, not here). */
export type LineOutput =
  | { kind: 'DeadEnd' }
  | { kind: 'Sink' }
  | { kind: 'Next'; line: number }
  | { kind: 'Merge'; line: number; at: number }
  | { kind: 'Fork'; a: number; b: number }

/** One registered segment of a line's path (0076 §4; positions and points in 1/256 tile). */
export type LineSegment =
  | { len: number; kind: 'Straight'; from: [number, number]; to: [number, number] }
  | {
      len: number
      kind: 'Arc'
      centre: [number, number]
      radiusQ8: number
      startTurnQ8: number
      sweepQ8: number
    }

/** A held line's structure: what `LineStructs` replicates. */
export interface LineStructure {
  id: number
  len: number
  speed: number
  out: LineOutput
  segments: LineSegment[]
}

export interface LineStructuresDump {
  /** `transport.structsDropped`: puts the replica could not hold. */
  structsDropped: number
  /** Ascending by id. */
  lines: LineStructure[]
}

const decoder = new TextDecoder()

/** Reads `client_line_structures` from a client instance. */
export function readLineStructures(inst: EngineInstance): LineStructuresDump {
  const len = inst.call0(inst.x.client_line_structures)
  if (len <= 0)
    throw new Error(`client_line_structures: ${len === 0 ? 'Tx too small' : `status ${-len}`}`)
  const tx = inst.region(RegionId.Tx)
  if (!tx) throw new Error('client_line_structures: no Tx region')
  return JSON.parse(decoder.decode(tx.u8.slice(0, len))) as LineStructuresDump
}

/** `client_corrupt_line`: flips bit 0 of a held line's `speed` in the replica. Throws when the line
 * is not held. */
export function corruptLine(inst: EngineInstance, id: number): void {
  const status = inst.call1(inst.x.client_corrupt_line, id)
  if (status !== Status.Ok) throw new Error(`corruptLineStructure(${id}): status ${status}`)
}

/** What a client holds: `HeadlessClient` implements it. */
export interface HasLineStructures {
  lineStructures(): LineStructuresDump
  corruptLineStructure(id: number): void
}

/** The line structures `client`'s replica holds, ascending by id (M46). */
export function lineStructures(client: HasLineStructures): LineStructure[] {
  return client.lineStructures().lines
}

/** `transport.structsDropped` of `client`: `LineStructs` puts its replica could not hold. */
export function structsDropped(client: HasLineStructures): number {
  return client.lineStructures().structsDropped
}

/** Fault injection (M46): flips `speed` of held line `id` in `client`'s replica, so the line's anchor
 * chunk hash mismatches until the host's resync snapshot (and its `LineStructs` puts) repair it. */
export function corruptLineStructure(client: HasLineStructures, id: number): void {
  client.corruptLineStructure(id)
}
