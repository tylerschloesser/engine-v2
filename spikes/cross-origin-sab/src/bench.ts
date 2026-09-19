// Main-thread consumer. Everything used on the hot path is allocated up front.
import { SLOT_BYTES, SLOTS, MASK, HEAD, TAIL, DROPS } from './ring'

const variant = new URLSearchParams(location.search).get('variant') ?? 'sab'

// stats live in a typed array so counters never become heap numbers
const FRAMES = 0, MSGS = 1, SEQ_ERRORS = 2, EXPECT = 3, MAX_DRAIN = 4, WAKES = 5, DEST = 6
const stats = new Int32Array(8)
;(window as any).__stats = stats
;(window as any).__variant = variant

// Stand-in for the client's (non-shared) WASM linear memory: the copy destination.
const wasmMem = new WebAssembly.Memory({ initial: 1 })
const wasmU8 = new Uint8Array(wasmMem.buffer)
const wasmI32 = new Int32Array(wasmMem.buffer)

function checkSeq(seq: number) {
  if (seq !== stats[EXPECT]) stats[SEQ_ERRORS]++
  stats[EXPECT] = seq + 1
  stats[MSGS]++
}
function nextDestOffset(): number {
  const i = (stats[DEST] + 1) & 31
  stats[DEST] = i
  return i << 10
}

function frameCountOnly() {
  stats[FRAMES]++
  requestAnimationFrame(frameCountOnly)
}

const needsWorker = !['none', 'raf', 'timer', 'garbage'].includes(variant)
const worker = needsWorker ? new Worker(new URL('./bench-worker.ts', import.meta.url), { type: 'module' }) : null

if (variant === 'none') {
  // control: no rAF loop, no worker. Measures background noise of an idle page.
} else if (variant === 'raf') {
  requestAnimationFrame(frameCountOnly)
} else if (variant === 'timer') {
  // control for the rAF control: same counter, driven by setInterval (callback receives no timestamp double)
  setInterval(() => {
    stats[FRAMES]++
  }, 16)
} else if (variant === 'garbage') {
  // positive control: proves the GC detector sees main-thread GCs
  let sink: unknown = null
  const frame = () => {
    stats[FRAMES]++
    sink = new Array(12500).fill(1.5) // ~100 KB/frame
    requestAnimationFrame(frame)
  }
  void sink
  requestAnimationFrame(frame)
} else if (variant === 'sab' || variant === 'waitasync') {
  if (!crossOriginIsolated) throw new Error('not crossOriginIsolated')
  const ctrlSab = new SharedArrayBuffer(16)
  const payloadSab = new SharedArrayBuffer(SLOTS * SLOT_BYTES)
  const ctrl = new Int32Array(ctrlSab)
  ;(window as any).__ctrl = ctrl
  // one preallocated view per slot: `subarray()` on the hot path would allocate
  const slotViews: Uint8Array[] = []
  for (let i = 0; i < SLOTS; i++) slotViews.push(new Uint8Array(payloadSab, i * SLOT_BYTES, SLOT_BYTES))

  const drain = () => {
    const head = Atomics.load(ctrl, HEAD)
    let tail = Atomics.load(ctrl, TAIL)
    let n = 0
    while (tail !== head) {
      const off = nextDestOffset()
      wasmU8.set(slotViews[tail], off) // SAB slot -> non-shared wasm memory
      checkSeq(wasmI32[off >> 2])
      tail = (tail + 1) & MASK
      n++
    }
    Atomics.store(ctrl, TAIL, tail)
    if (n > stats[MAX_DRAIN]) stats[MAX_DRAIN] = n
  }

  worker!.postMessage({ type: 'init', variant, ctrl: ctrlSab, payload: payloadSab })
  if (variant === 'sab') {
    const frame = () => {
      stats[FRAMES]++
      drain()
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  } else {
    // Atomics.waitAsync instead of polling; no rAF loop at all, so its cost is isolated
    const onWake = () => {
      stats[WAKES]++
      drain()
      arm()
    }
    const arm = () => {
      const r = (Atomics as any).waitAsync(ctrl, HEAD, Atomics.load(ctrl, HEAD))
      if (r.async) r.value.then(onWake)
      else setTimeout(onWake, 0)
    }
    arm()
  }
} else if (variant === 'pm-object') {
  worker!.onmessage = (e: MessageEvent) => {
    const d = e.data
    const off = nextDestOffset()
    wasmI32[off >> 2] = d.seq
    checkSeq(d.seq)
  }
  worker!.postMessage({ type: 'init', variant })
  requestAnimationFrame(frameCountOnly)
} else if (variant === 'pm-transfer' || variant === 'pm-transfer-pool') {
  const giveBack = variant === 'pm-transfer-pool'
  worker!.onmessage = (e: MessageEvent) => {
    const buf: ArrayBuffer = e.data
    const off = nextDestOffset()
    wasmU8.set(new Uint8Array(buf), off) // a view is unavoidable: the ArrayBuffer is new every message
    checkSeq(wasmI32[off >> 2])
    if (giveBack) worker!.postMessage({ type: 'return', buf }, [buf])
  }
  worker!.postMessage({ type: 'init', variant })
  requestAnimationFrame(frameCountOnly)
} else {
  throw new Error('unknown variant ' + variant)
}
