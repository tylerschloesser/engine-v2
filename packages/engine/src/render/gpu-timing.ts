// Opt-in GPU execution timing (M39k: the main render pass of a frame gets
// `timestampWrites`, resolved into a small ring of mappable buffers and read back after the writing
// frame, never on it. This is the pass's own begin-to-end time on the GPU, not the submit-to-done latency
// of a vsync-paced queue (which on a phone reads about 0.8 of a frame interval whatever the pass costs).
//
// Off (`ClientOptions.render.gpuTiming` unset), nothing in this file runs and no descriptor changes. On,
// everything is built once here: the query set, the resolve buffer, the read buffers, one writes object
// and one pair of callbacks per slot. What is left per sampled frame is the browser's own: the
// `mapAsync` promise and the mapped range's `ArrayBuffer`. `sampleEvery` bounds that (default one frame
// in 4); a zero-GC page runs with the option off.

// Numeric usage flags, so a unit test needs no WebGPU globals.
const BUF_MAP_READ = 0x1
const BUF_COPY_SRC = 0x4
const BUF_COPY_DST = 0x8
const BUF_QUERY_RESOLVE = 0x200
const MAP_MODE_READ = 0x1
/** `resolveQuerySet`'s destination offset must be a multiple of 256. */
const RESOLVE_STRIDE = 256

export const GPU_TIMING_FEATURE = 'timestamp-query'

export type GpuTimingOptions = {
  /** Slots in the ring (frames that may await a readback at once). Default 3. */
  slots?: number
  /** One frame in this many is timed. Default 4. */
  sampleEvery?: number
}

type Slot = {
  readonly writes: GPURenderPassTimestampWrites
  readonly readBuf: GPUBuffer
  busy: boolean
  readonly onMapped: () => void
  readonly onFailed: (e: unknown) => void
}

export interface GpuTimer {
  /** `null` while timing works; otherwise why it does not (feature missing, readback failed). */
  readonly unavailable: string | null
  /** Latest main-pass GPU time in ms (`NaN` before the first sample). */
  readonly lastMs: number
  /** Samples delivered since creation. */
  readonly count: number
  /** The most recent durations in ms, oldest overwritten first: slot `i % ring.length` holds sample `i`. */
  readonly ring: Float64Array
  /** Called once per delivered sample (a closure the caller owns; never allocated here). */
  onSample: ((ms: number) => void) | null
  /** Before `beginRenderPass`: arms `desc.timestampWrites` for this frame, or clears it. */
  begin(desc: GPURenderPassDescriptor): void
  /** After `pass.end()`, on the same encoder. */
  resolve(encoder: GPUCommandEncoder): void
  /** After `queue.submit`: starts the readback of this frame's slot; it lands on a later task. */
  afterSubmit(): void
}

export const GPU_TIMING_RING = 64

export function createGpuTimer(
  device: GPUDevice,
  opts: GpuTimingOptions = {},
  feature = device.features.has(GPU_TIMING_FEATURE),
): GpuTimer {
  const slotCount = opts.slots ?? 3
  const every = opts.sampleEvery ?? 4
  const ring = new Float64Array(GPU_TIMING_RING)
  const t: {
    -readonly [K in keyof GpuTimer]: GpuTimer[K]
  } = {
    unavailable: feature ? null : `${GPU_TIMING_FEATURE} is not supported by this adapter`,
    lastMs: Number.NaN,
    count: 0,
    ring,
    onSample: null,
    begin: () => {},
    resolve: () => {},
    afterSubmit: () => {},
  }
  if (!feature) return t

  const querySet = device.createQuerySet({ type: 'timestamp', count: slotCount * 2 })
  const resolveBuf = device.createBuffer({
    size: slotCount * RESOLVE_STRIDE,
    usage: BUF_QUERY_RESOLVE | BUF_COPY_SRC,
  })
  const slots: Slot[] = []
  for (let i = 0; i < slotCount; i++) {
    const readBuf = device.createBuffer({ size: 16, usage: BUF_MAP_READ | BUF_COPY_DST })
    const slot: Slot = {
      writes: { querySet, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 },
      readBuf,
      busy: false,
      onMapped: () => {
        const v = new BigUint64Array(readBuf.getMappedRange())
        const begin = v[0] as bigint
        const end = v[1] as bigint
        readBuf.unmap()
        slot.busy = false
        if (end < begin) return // a timestamp counter that wrapped or is not monotonic: no sample
        const ms = Number(end - begin) / 1e6
        t.lastMs = ms
        ring[t.count % ring.length] = ms
        t.count += 1
        if (t.onSample) t.onSample(ms)
      },
      onFailed: (e) => {
        slot.busy = false
        t.unavailable = `readback failed: ${e instanceof Error ? e.message : String(e)}`
      },
    }
    slots.push(slot)
  }

  let frame = 0
  let current: Slot | null = null
  let currentIndex = 0

  t.begin = (desc) => {
    current = null
    frame += 1
    if (t.unavailable === null && frame % every === 0) {
      for (let i = 0; i < slotCount; i++) {
        const s = slots[i] as Slot
        if (!s.busy) {
          current = s
          currentIndex = i
          break
        }
      }
    }
    if (current) desc.timestampWrites = current.writes
    else delete desc.timestampWrites
  }
  t.resolve = (encoder) => {
    if (!current) return
    encoder.resolveQuerySet(
      querySet,
      currentIndex * 2,
      2,
      resolveBuf,
      currentIndex * RESOLVE_STRIDE,
    )
    encoder.copyBufferToBuffer(resolveBuf, currentIndex * RESOLVE_STRIDE, current.readBuf, 0, 16)
  }
  t.afterSubmit = () => {
    const s = current
    if (!s) return
    current = null
    s.busy = true
    s.readBuf.mapAsync(MAP_MODE_READ).then(s.onMapped, s.onFailed)
  }
  return t
}
