// M46 (docs/decisions/0078 §1): `engine/test`'s view of a client's replicated line structures, read
// through the test-only `client_line_structures` export (shape: `crates/engine/src/abi/registry.rs`),
// and the `client_corrupt_line` fault; M47's forecast counters come through `client_forecast_counters`.
// Test-only: allocates freely.
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

/** M47: the replica's forecast counters (`transport::ForecastCounters`, 0078 A3). */
export interface ForecastCounters {
  /** Run lists applied (a line's whole list: with its first put, or resent). */
  forecastsApplied: number
  /** State messages applied (a correction of a held line's stops). */
  stateMessagesApplied: number
  /** Arrivals applied (an item entering a held line by a route the client does not follow). */
  arrivalsApplied: number
  /** Corrections applied for a tick the client had already rendered (0078 §5). */
  forecastSeenLate: number
  /** States, and run lists for lines held before their frame: M47b's `transport.correctionsPerSec`. */
  corrections: number
  /** `unknown` lists applied (a line's list larger than a frame: its items are not held). */
  listsUnknown: number
  /** Records for lines the replica does not hold (dropped). */
  recordsUnheld: number
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

/** Reads `client_forecast_counters` (M47, `ABI_VERSION` 42) from a client instance. */
export function readForecastCounters(inst: EngineInstance): ForecastCounters {
  const len = inst.call0(inst.x.client_forecast_counters)
  if (len <= 0)
    throw new Error(`client_forecast_counters: ${len === 0 ? 'Tx too small' : `status ${-len}`}`)
  const tx = inst.region(RegionId.Tx)
  if (!tx) throw new Error('client_forecast_counters: no Tx region')
  return JSON.parse(decoder.decode(tx.u8.slice(0, len))) as ForecastCounters
}

/** What a client holds: `HeadlessClient` implements it. */
export interface HasForecastCounters {
  forecastCounters(): ForecastCounters
}

/** The replica's forecast counters of `client` (M47, 0078 A3): what M47b's scenarios read. */
export function forecastCounters(client: HasForecastCounters): ForecastCounters {
  return client.forecastCounters()
}

/** Fault injection (M46): flips `speed` of held line `id` in `client`'s replica, so the line's anchor
 * chunk hash mismatches until the host's resync snapshot (and its `LineStructs` puts) repair it. */
export function corruptLineStructure(client: HasLineStructures, id: number): void {
  client.corruptLineStructure(id)
}
