import { SLOT_BYTES, MASK, HEAD, TAIL, DROPS, PER_TICK, TICK_MS } from './ring'

let seq = 0
self.onmessage = (e: MessageEvent) => {
  const d = e.data
  if (d.type === 'return') return void pool.push(d.buf) // pm-transfer-pool: main hands the buffer back
  if (d.type !== 'init') return
  const variant: string = d.variant
  if (variant === 'sab' || variant === 'waitasync') {
    const ctrl = new Int32Array(d.ctrl)
    const payloadI32 = new Int32Array(d.payload)
    const payloadU8 = new Uint8Array(d.payload)
    const notify = variant === 'waitasync'
    setInterval(() => {
      let head = Atomics.load(ctrl, HEAD)
      for (let i = 0; i < PER_TICK; i++) {
        const next = (head + 1) & MASK
        if (next === Atomics.load(ctrl, TAIL)) {
          Atomics.add(ctrl, DROPS, 1)
          break
        }
        const off = head * SLOT_BYTES
        payloadI32[off >> 2] = seq
        payloadU8[off + SLOT_BYTES - 1] = seq & 0xff
        seq = (seq + 1) | 0
        head = next
        Atomics.store(ctrl, HEAD, head) // publish after the slot is fully written
      }
      if (notify) Atomics.notify(ctrl, HEAD)
    }, TICK_MS)
  } else if (variant === 'pm-object') {
    setInterval(() => {
      for (let i = 0; i < PER_TICK; i++) {
        self.postMessage({ t: 1, seq, x: seq * 0.5, y: 7 })
        seq = (seq + 1) | 0
      }
    }, TICK_MS)
  } else if (variant === 'pm-transfer' || variant === 'pm-transfer-pool') {
    const usePool = variant === 'pm-transfer-pool'
    setInterval(() => {
      for (let i = 0; i < PER_TICK; i++) {
        const buf: ArrayBuffer = (usePool && pool.pop()) || new ArrayBuffer(SLOT_BYTES)
        new Int32Array(buf)[0] = seq
        seq = (seq + 1) | 0
        ;(self as any).postMessage(buf, [buf])
      }
    }, TICK_MS)
  }
}
const pool: ArrayBuffer[] = []
