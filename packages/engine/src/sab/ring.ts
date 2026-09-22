// SPSC ring over one SAB (docs/decisions/0015-threads-memory-and-topology.md §2; docs/plan/06-sab-
// primitives-and-workers.md, Planning decisions "Ring SAB layout"). Physical layout: a 32-byte
// control block (`Int32Array[8]`), then `slots` fixed-size slots. Every slot starts with an 8-byte
// header (`msg_len: u32`, `part: u16`, `parts: u16`); `msg_len` is non-zero only in part 0. `HEAD`
// and `TAIL` are unbounded slot-claim counts (physical index `count % slots`), so occupancy is a
// plain subtraction and full/empty are never ambiguous.
//
// Two levels share this one layout: slot level (`tryClaim`/`commit`, `peek`/`release`) always
// claims exactly one slot and is for fixed-record rings; message level (`tryPush`, `peekLen`,
// `popInto`) spans slots for larger messages, all-or-nothing. `commit()` writes a one-part header
// so a slot-level ring is a valid (degenerate) message-level stream too.
import { at, copyBytes } from './bytes.js'
import type { ControlBlock } from './control.js'

const RING_CONTROL_INT32S = 8
const RING_CONTROL_BYTES = RING_CONTROL_INT32S * 4
const RING_SLOT_HEADER_BYTES = 8

const RING_HEAD = 0
const RING_TAIL = 1
const RING_DROPS = 2
const RING_PUSHED = 3
const RING_POPPED = 4
const RING_SLOT_BYTES = 5
const RING_SLOTS = 6

export type RingStats = {
  drops: number
  pushed: number
  popped: number
}

export function createRing(slotBytes: number, slots: number): SharedArrayBuffer {
  if (slotBytes % 4 !== 0)
    throw new Error(`sab/ring: slotBytes ${slotBytes} must be a multiple of 4`)
  if (slotBytes <= RING_SLOT_HEADER_BYTES) {
    throw new Error(
      `sab/ring: slotBytes ${slotBytes} must exceed the ${RING_SLOT_HEADER_BYTES}-byte slot header`,
    )
  }
  const sab = new SharedArrayBuffer(RING_CONTROL_BYTES + slotBytes * slots)
  const control = new Int32Array(sab, 0, RING_CONTROL_INT32S)
  control[RING_SLOT_BYTES] = slotBytes
  control[RING_SLOTS] = slots
  return sab
}

/** Shared view/layout setup, built once by both `RingProducer` and `RingConsumer` constructors.
 * Named `create*` like every other one-time-allocation factory here (`sab.no_alloc_syntax`
 * treats a `constructor` and a top-level `create*` function the same: allowed to allocate,
 * because both run once at setup, never per frame/tick/message). */
function createRingViews(sab: SharedArrayBuffer) {
  const control = new Int32Array(sab, 0, RING_CONTROL_INT32S)
  const slotBytes = at(control, RING_SLOT_BYTES)
  const slots = at(control, RING_SLOTS)
  const payloadBytes = slotBytes - RING_SLOT_HEADER_BYTES
  const headerLen: Uint32Array[] = []
  const headerPart: Uint16Array[] = []
  const payload: Uint8Array[] = []
  for (let i = 0; i < slots; i++) {
    const off = RING_CONTROL_BYTES + i * slotBytes
    headerLen.push(new Uint32Array(sab, off, 1))
    headerPart.push(new Uint16Array(sab, off + 4, 2))
    payload.push(new Uint8Array(sab, off + RING_SLOT_HEADER_BYTES, payloadBytes))
  }
  return { control, slots, payloadBytes, headerLen, headerPart, payload }
}

export class RingProducer {
  private readonly control: Int32Array
  private readonly slots: number
  private readonly payloadBytes: number
  private readonly headerLen: Uint32Array[]
  private readonly headerPart: Uint16Array[]
  private readonly payload: Uint8Array[]
  private readonly wakeControl: ControlBlock | null
  private readonly wakeIndex: number
  private head: number
  private claimed: number

  constructor(sab: SharedArrayBuffer, wake?: { control: ControlBlock; index: number }) {
    const v = createRingViews(sab)
    this.control = v.control
    this.slots = v.slots
    this.payloadBytes = v.payloadBytes
    this.headerLen = v.headerLen
    this.headerPart = v.headerPart
    this.payload = v.payload
    this.wakeControl = wake ? wake.control : null
    this.wakeIndex = wake ? wake.index : 0
    this.head = Atomics.load(this.control, RING_HEAD)
    this.claimed = -1
  }

  /** The maximum payload bytes a single slot holds (this ring's own `slotBytes` minus its 8-byte
   * slot header): what a caller that writes a whole record into one claimed slot (never spanning,
   * `docs/plan/08b-gen-workers-and-queue.md`'s `genRequest`/`genResult`) must check a record
   * against, since `slotBytes`/`slots` are internal to `createRing` and the SAB's own `byteLength`
   * is the whole ring, not one slot. */
  slotPayloadBytes(): number {
    return this.payloadBytes
  }

  /** Claims exactly one slot; -1 if the ring is full. */
  tryClaim(): number {
    const tail = Atomics.load(this.control, RING_TAIL)
    if (this.head - tail >= this.slots) return -1
    const idx = this.head % this.slots
    this.claimed = idx
    return idx
  }

  /** Slots free to claim right now (docs/plan/09-renderer-terrain.md Planning decisions:
   * "`upload_stage` is called with `min(ring free slots, 16)`", so the worker's own conversion
   * burst never exceeds what the ring can currently accept -- no bytes staged and then dropped for
   * lack of a slot). A plain load and subtraction, no allocation. */
  freeSlots(): number {
    const tail = Atomics.load(this.control, RING_TAIL)
    return this.slots - (this.head - tail)
  }

  slotView(i: number): Uint8Array {
    return at(this.payload, i)
  }

  /** Publishes the slot claimed by the last `tryClaim()`, as a one-part message. */
  commit(): void {
    const idx = this.claimed
    at(this.headerLen, idx)[0] = this.payloadBytes
    const part = at(this.headerPart, idx)
    part[0] = 0
    part[1] = 1
    this.claimed = -1
    this.head += 1
    Atomics.store(this.control, RING_HEAD, this.head)
    Atomics.add(this.control, RING_PUSHED, 1)
    if (this.wakeControl) this.wakeControl.wake(this.wakeIndex)
  }

  /** All-or-nothing: `src[0..len)`, spanning slots if `len` exceeds one slot's payload. */
  tryPush(src: Uint8Array, len: number): boolean {
    const parts = Math.max(1, Math.ceil(len / this.payloadBytes))
    const tail = Atomics.load(this.control, RING_TAIL)
    if (this.head - tail + parts > this.slots) return false
    let remaining = len
    let srcOff = 0
    for (let p = 0; p < parts; p++) {
      const idx = (this.head + p) % this.slots
      const chunk = remaining < this.payloadBytes ? remaining : this.payloadBytes
      copyBytes(at(this.payload, idx), 0, src, srcOff, chunk)
      at(this.headerLen, idx)[0] = p === 0 ? len : 0
      const part = at(this.headerPart, idx)
      part[0] = p
      part[1] = parts
      srcOff += chunk
      remaining -= chunk
    }
    this.head += parts
    Atomics.store(this.control, RING_HEAD, this.head) // published once, after every part is written
    Atomics.add(this.control, RING_PUSHED, 1)
    if (this.wakeControl) this.wakeControl.wake(this.wakeIndex)
    return true
  }

  stats(out: RingStats): void {
    out.drops = Atomics.load(this.control, RING_DROPS)
    out.pushed = Atomics.load(this.control, RING_PUSHED)
    out.popped = Atomics.load(this.control, RING_POPPED)
  }

  /** Explicit drop accounting for a producer whose own policy is "drop the newest event, never
   * block or retry" (docs/plan/11-camera-and-input.md Planning decisions "Full `inputRing`: drop
   * and count"). Unlike `tryClaim`/`tryPush` returning `-1`/`false`, which is backpressure for a
   * producer that itself retries or waits (`ring.full_is_backpressure`: a failed claim there is
   * not by itself a loss), so the generic ring never assumes a failed claim is a drop on its own --
   * only a producer that has *decided* to drop calls this. */
  recordDrop(): void {
    Atomics.add(this.control, RING_DROPS, 1)
  }
}

export class RingConsumer {
  private readonly control: Int32Array
  private readonly slots: number
  private readonly payloadBytes: number
  private readonly headerLen: Uint32Array[]
  private readonly headerPart: Uint16Array[]
  private readonly payload: Uint8Array[]
  private tail: number

  constructor(sab: SharedArrayBuffer) {
    const v = createRingViews(sab)
    this.control = v.control
    this.slots = v.slots
    this.payloadBytes = v.payloadBytes
    this.headerLen = v.headerLen
    this.headerPart = v.headerPart
    this.payload = v.payload
    this.tail = Atomics.load(this.control, RING_TAIL)
  }

  /** Slot index of the oldest unread slot, or -1 if empty. */
  peek(): number {
    const head = Atomics.load(this.control, RING_HEAD)
    if (this.tail >= head) return -1
    return this.tail % this.slots
  }

  slotView(i: number): Uint8Array {
    return at(this.payload, i)
  }

  /** Total slot count (docs/plan/09-renderer-terrain.md, Deviations "Steps 5-7"): lets a caller
   * (`render/upload.ts`) precompute one derived view per slot up front, at setup, instead of
   * risking a first-sight allocation deep into a measured window. */
  slotCount(): number {
    return this.slots
  }

  /** Releases the slot returned by the last `peek()`. */
  release(): void {
    this.tail += 1
    Atomics.store(this.control, RING_TAIL, this.tail)
    Atomics.add(this.control, RING_POPPED, 1)
  }

  /** Byte length of the pending message at the tail, or -1 if empty. */
  peekLen(): number {
    const head = Atomics.load(this.control, RING_HEAD)
    if (this.tail >= head) return -1
    return at(at(this.headerLen, this.tail % this.slots), 0)
  }

  /** Copies the pending message into `dst[dstOffset..)` and releases every slot it spanned.
   * Returns its byte length, or -1 if empty. */
  popInto(dst: Uint8Array, dstOffset: number): number {
    const head = Atomics.load(this.control, RING_HEAD)
    if (this.tail >= head) return -1
    const idx0 = this.tail % this.slots
    const len = at(at(this.headerLen, idx0), 0)
    const parts = at(at(this.headerPart, idx0), 1)
    let remaining = len
    let dstOff = dstOffset
    for (let p = 0; p < parts; p++) {
      const idx = (this.tail + p) % this.slots
      const chunk = remaining < this.payloadBytes ? remaining : this.payloadBytes
      copyBytes(dst, dstOff, at(this.payload, idx), 0, chunk)
      dstOff += chunk
      remaining -= chunk
    }
    this.tail += parts
    Atomics.store(this.control, RING_TAIL, this.tail)
    Atomics.add(this.control, RING_POPPED, 1)
    return len
  }

  stats(out: RingStats): void {
    out.drops = Atomics.load(this.control, RING_DROPS)
    out.pushed = Atomics.load(this.control, RING_PUSHED)
    out.popped = Atomics.load(this.control, RING_POPPED)
  }

  /** The consumer-side counterpart of `RingProducer.recordDrop()`, same counter, same policy
   * ("drop the newest event, never block or retry"): for a message this ring successfully
   * delivered, but whose *consumer* then rejected on its own terms after popping it -- not a ring
   * failure (docs/plan/16-action-round-trip.md gate item 3: `worker/client-action.ts`'s `on_action`
   * call returning anything but `Status.Ok`, a locally-dropped action main's own `dispatch()` has
   * already handed a `seq` for). Shares `RING_DROPS` with the producer's own drops rather than a
   * second counter, since both answer the same question a caller of `stats()` actually has: "how
   * many messages sent into this ring never had any further effect". */
  recordDrop(): void {
    Atomics.add(this.control, RING_DROPS, 1)
  }
}
