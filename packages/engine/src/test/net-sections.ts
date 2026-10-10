// Per-section wire accounting for the netcode harness (M31 step 1).
// Pure functions over delivered downlink messages: no clock, no host state, so every number here is a
// function of `(seed, scenario)` and `trace()` stays deterministic.

/** `wire/mod.rs` `SectionId`, by wire id. */
export const SECTION_NAMES: Record<number, string> = {
  1: 'ActionResults',
  2: 'Global',
  3: 'OwnPlayer',
  4: 'ChunkEnterPristine',
  5: 'ChunkSnapshots',
  6: 'ChunkLeaves',
  7: 'ChunkDeltas',
  8: 'Presence',
  9: 'Hashes',
  10: 'ChunkTiles',
  11: 'ChunkKeeps',
}

const MSG_TYPE_FRAME = 0x01
const MSG_TYPE_FRAME_BUNDLE = 0x06
const FRAME_HEADER_BYTES = 10

export interface ParsedFrame {
  tick: number
  /** Section id -> the section's whole wire bytes (`[id][len varint][body]`). */
  sectionBytes: Map<number, number>
  /** Section id -> body, for the sections the counters decode (enter and leave lists). */
  bodies: Map<number, Uint8Array>
}

function readVarint(buf: Uint8Array, at: number): { value: number; next: number } | null {
  let value = 0
  let shift = 0
  let i = at
  while (i < buf.length) {
    const b = buf[i++] as number
    value += (b & 0x7f) * 2 ** shift
    if ((b & 0x80) === 0) return { value, next: i }
    shift += 7
    if (shift > 35) return null
  }
  return null
}

/** Parses one whole `Frame` message; `null` for any other message type or a malformed body. */
export function parseFrame(bytes: Uint8Array): ParsedFrame | null {
  if (bytes.length < FRAME_HEADER_BYTES || bytes[0] !== MSG_TYPE_FRAME) return null
  const tick =
    ((bytes[2] as number) |
      ((bytes[3] as number) << 8) |
      ((bytes[4] as number) << 16) |
      ((bytes[5] as number) << 24)) >>>
    0
  const sectionBytes = new Map<number, number>()
  const bodies = new Map<number, Uint8Array>()
  let at = FRAME_HEADER_BYTES
  while (at < bytes.length) {
    const id = bytes[at] as number
    const len = readVarint(bytes, at + 1)
    if (!len || len.next + len.value > bytes.length) return null
    sectionBytes.set(id, len.next + len.value - at)
    bodies.set(id, bytes.subarray(len.next, len.next + len.value))
    at = len.next + len.value
  }
  return { tick, sectionBytes, bodies }
}

/** Number of chunk coordinates in a flat coordinate-list body (`ChunkEnterPristine`,
 * `ChunkLeaves`): two varints per entry, to the end of the body. */
export function coordListLength(body: Uint8Array): number {
  let at = 0
  let varints = 0
  while (at < body.length) {
    const v = readVarint(body, at)
    if (!v) break
    at = v.next
    varints++
  }
  return varints >> 1
}

export interface SectionTotals {
  /** Bytes of every `Frame` message's fixed header. */
  header: number
  /** Whole-section wire bytes by section name (id + length varint + body). */
  sections: Record<string, number>
  frames: number
  /** Frames with no sections: the 10-byte heartbeat (0011). */
  heartbeats: number
  chunkEnters: number
  chunkLeaves: number
}

export function emptyTotals(): SectionTotals {
  return { header: 0, sections: {}, frames: 0, heartbeats: 0, chunkEnters: 0, chunkLeaves: 0 }
}

export function addFrame(totals: SectionTotals, frame: ParsedFrame): void {
  totals.frames++
  totals.header += FRAME_HEADER_BYTES
  if (frame.sectionBytes.size === 0) totals.heartbeats++
  for (const [id, n] of frame.sectionBytes) {
    const name = SECTION_NAMES[id] ?? `Section${id}`
    totals.sections[name] = (totals.sections[name] ?? 0) + n
  }
  const enters = frame.bodies.get(4)
  if (enters) totals.chunkEnters += coordListLength(enters)
  const leaves = frame.bodies.get(6)
  if (leaves) totals.chunkLeaves += coordListLength(leaves)
}

/** Largest byte total any 1 s (`windowMs`) span of virtual time holds, over `(t, bytes)` samples in
 * time order. */
export function worstWindowBytes(
  samples: { t: number; bytes: number }[],
  windowMs: number,
): number {
  let worst = 0
  let sum = 0
  let lo = 0
  for (let hi = 0; hi < samples.length; hi++) {
    sum += (samples[hi] as { bytes: number }).bytes
    while ((samples[hi] as { t: number }).t - (samples[lo] as { t: number }).t >= windowMs) {
      sum -= (samples[lo] as { bytes: number }).bytes
      lo++
    }
    if (sum > worst) worst = sum
  }
  return worst
}

/** Every whole frame a downlink message carries: a `Frame` is one, a `FrameBundle` (`wire/bundle.rs`:
 * `[0x06][n varint]` then `n` x `[len varint][frame]`) is `n`; anything else, or a malformed body,
 * is none. */
export function parseMessage(bytes: Uint8Array): ParsedFrame[] {
  if (bytes[0] === MSG_TYPE_FRAME) {
    const f = parseFrame(bytes)
    return f ? [f] : []
  }
  if (bytes[0] !== MSG_TYPE_FRAME_BUNDLE) return []
  const count = readVarint(bytes, 1)
  if (!count) return []
  const out: ParsedFrame[] = []
  let at = count.next
  for (let i = 0; i < count.value; i++) {
    const len = readVarint(bytes, at)
    if (!len) return out
    const f = parseFrame(bytes.subarray(len.next, len.next + len.value))
    if (f) out.push(f)
    at = len.next + len.value
  }
  return out
}
