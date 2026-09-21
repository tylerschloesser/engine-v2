// The `SabSet` every later milestone posts to its workers (docs/decisions/0015 §2, §5; docs/plan/
// 06-sab-primitives-and-workers.md, Planning decisions "Ring capacities"). Ring sizes here are
// internal constants, not game config; an owning milestone may revise its own row in its
// Deviations. `sabBytesTotal()` assumes the worst case, two gen workers (docs/decisions/
// 0008-chunk-generation.md), which is what the whole-tab budget must hold under.
import { CAMERA_BLOCK_BYTES, createCameraBlock } from '../camera/block.js'
import { CONTROL_BLOCK_BYTES, createControlBlock } from './control.js'
import { createRing } from './ring.js'
import { createSeqlock } from './seqlock.js'
import { createTriple } from './triple.js'

// Worker indexes are named in this milestone's Seams under both control.ts (word layout) and
// layout.ts (Scope); control.ts is the one definition, re-exported here so a `SabSet` caller needs
// only this module.
export { WORKER_CLIENT, WORKER_GEN0, WORKER_GEN1, WORKER_HOST } from './control.js'

export const MAX_GEN_WORKERS = 2

/** `Int32Array[8]` control words per ring (docs/plan/06-sab-primitives-and-workers.md, ring.ts). */
const RING_CONTROL_BYTES = 32

/** 0015 §2 "clocks": `authoritative_tick, predicted_tick, ticks_per_second, session_state,
 * seq_seed, ack_seq` (M16), plus `revealed` (M28) and `tick_fraction` (M26) — 8 `u32` fields.
 * M06 only sizes the seqlock; M16 owns the field layout. */
const CLOCK_BLOCK_DATA_BYTES = 32

/** M17 (0015 §5, 0018 §"why 0018's 256 does not fit"): 1,024 B header, 2 MiB body. */
const DRAWLIST_HEADER_BYTES = 1024
const DRAWLIST_BODY_BYTES = 2 * 1024 * 1024

export const RING_DEFAULTS = {
  downlink: { slotBytes: 1024, slots: 512 },
  uplink: { slotBytes: 1024, slots: 64 },
  actionRing: { slotBytes: 1024, slots: 64 },
  // docs/plan/11-camera-and-input.md (M11, steps 4-5): `slotBytes` is the ring's own per-slot size
  // (its own 8-byte header, `sab/ring.ts`, plus payload), and the payload must hold a whole
  // `inputRing` record -- 32 bytes (Seams: `input/record.ts`'s `INPUT_RECORD_BYTES`). This was
  // `{ slotBytes: 32, slots: 256 }` (a 32-byte *slot*, leaving only 24 payload bytes -- 8 short),
  // the same defect `uploadRing` hit and was corrected for (M09's own comment on that row, "M06's
  // own value here predated the record layout"); the previous range's Deviations flagged it and
  // left the fix for this one. 32 + 8 = 40.
  inputRing: { slotBytes: 40, slots: 256 },
  uiRing: { slotBytes: 1024, slots: 256 },
  // docs/plan/09-renderer-terrain.md, Planning decisions "Upload-ring record layout": one fixed
  // 4,112-byte record (16-byte header + 4,096-byte payload) per ring slot, never spanning -- the
  // ring's own 8-byte slot header (`sab/ring.ts`) is on top of that, so `slotBytes` must be
  // 4,112 + 8 = 4,120, not 4,112 (M06's own value here predated the record layout; this is the
  // "an owning milestone may revise its own row" case its comment names).
  uploadRing: { slotBytes: 4120, slots: 256 },
  // Revised by docs/plan/08b-gen-workers-and-queue.md (M06's own allowance: "an owning milestone
  // may revise its row in its Deviations"). M06 sized these before the record shapes existed;
  // `slotBytes` here is the *ring's* total per-slot size (its own 8-byte header + payload,
  // `sab/ring.ts`), and the payload must hold a whole record: 16 bytes for a request, `16 +
  // 4,096` for a result at the default chunk size (0008 §2's own "4,096-byte result slabs"). Slot
  // counts are generous relative to the in-flight cap of 2/worker (0008 §4), never a bottleneck.
  genRequest: { slotBytes: 24, slots: 8 },
  genResult: { slotBytes: 4120, slots: 8 },
} as const

export type SabSet = {
  control: SharedArrayBuffer
  cameraBlock: SharedArrayBuffer
  clockBlock: SharedArrayBuffer
  drawList: SharedArrayBuffer
  uploadRing: SharedArrayBuffer
  actionRing: SharedArrayBuffer
  inputRing: SharedArrayBuffer
  uiRing: SharedArrayBuffer
  uplink: SharedArrayBuffer
  downlink: SharedArrayBuffer
  genRequest: SharedArrayBuffer[]
  genResult: SharedArrayBuffer[]
}

function ringBytes(spec: { slotBytes: number; slots: number }): number {
  return RING_CONTROL_BYTES + spec.slotBytes * spec.slots
}

/** Allocates every SAB a topology needs. `hostKind` (single-player `sim`, multiplayer `net`) is
 * carried for M06b's spawn logic; it does not currently change what is allocated here, since
 * `uplink`/`downlink` are the same shape either way (docs/plan/06-sab-primitives-and-workers.md
 * Consumes; recorded in this milestone's Deviations). */
export function createSabSet(hostKind: 'sim' | 'net', genWorkers: number): SabSet {
  void hostKind
  const genRequest: SharedArrayBuffer[] = []
  const genResult: SharedArrayBuffer[] = []
  for (let i = 0; i < genWorkers; i++) {
    genRequest.push(createRing(RING_DEFAULTS.genRequest.slotBytes, RING_DEFAULTS.genRequest.slots))
    genResult.push(createRing(RING_DEFAULTS.genResult.slotBytes, RING_DEFAULTS.genResult.slots))
  }
  return {
    control: createControlBlock(),
    cameraBlock: createCameraBlock(),
    clockBlock: createSeqlock(CLOCK_BLOCK_DATA_BYTES),
    drawList: createTriple(DRAWLIST_HEADER_BYTES, DRAWLIST_BODY_BYTES),
    uploadRing: createRing(RING_DEFAULTS.uploadRing.slotBytes, RING_DEFAULTS.uploadRing.slots),
    actionRing: createRing(RING_DEFAULTS.actionRing.slotBytes, RING_DEFAULTS.actionRing.slots),
    inputRing: createRing(RING_DEFAULTS.inputRing.slotBytes, RING_DEFAULTS.inputRing.slots),
    uiRing: createRing(RING_DEFAULTS.uiRing.slotBytes, RING_DEFAULTS.uiRing.slots),
    uplink: createRing(RING_DEFAULTS.uplink.slotBytes, RING_DEFAULTS.uplink.slots),
    downlink: createRing(RING_DEFAULTS.downlink.slotBytes, RING_DEFAULTS.downlink.slots),
    genRequest,
    genResult,
  }
}

/** Total SAB bytes for the worst-case topology (two gen workers), against the ~12 MiB budget of
 * docs/decisions/0015-threads-memory-and-topology.md §5. */
export function sabBytesTotal(): number {
  let total = CONTROL_BLOCK_BYTES + CAMERA_BLOCK_BYTES + (4 + CLOCK_BLOCK_DATA_BYTES)
  total += 3 * (DRAWLIST_HEADER_BYTES + DRAWLIST_BODY_BYTES)
  total += ringBytes(RING_DEFAULTS.downlink)
  total += ringBytes(RING_DEFAULTS.uplink)
  total += ringBytes(RING_DEFAULTS.actionRing)
  total += ringBytes(RING_DEFAULTS.inputRing)
  total += ringBytes(RING_DEFAULTS.uiRing)
  total += ringBytes(RING_DEFAULTS.uploadRing)
  total +=
    MAX_GEN_WORKERS * (ringBytes(RING_DEFAULTS.genRequest) + ringBytes(RING_DEFAULTS.genResult))
  return total
}
