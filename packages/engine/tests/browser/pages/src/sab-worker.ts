// `sab.html`'s worker half of `sab.ring_both_directions` (docs/plan/06-sab-primitives-and-workers.md,
// Tests added): drains `toWorker` (main -> worker), checking its own sequence, and independently
// produces `fromWorker` (worker -> main) traffic, so both directions carry real, separately
// sequenced messages rather than an echo of one.
import { RingConsumer, RingProducer, type RingStats } from '../../../../src/sab/ring.ts'

type ToWorker = { toWorker: SharedArrayBuffer; fromWorker: SharedArrayBuffer; count: number }
type FromWorker = {
  type: 'done'
  seqErrorsToWorker: number
  receivedToWorker: number
  dropsFromWorker: number
}

const scope = self as unknown as {
  postMessage(m: FromWorker): void
  onmessage: ((ev: MessageEvent<ToWorker>) => void) | null
}

function encode(seq: number): Uint8Array {
  const buf = new Uint8Array(4 + (seq % 40))
  buf[0] = seq & 0xff
  buf[1] = (seq >>> 8) & 0xff
  buf[2] = (seq >>> 16) & 0xff
  buf[3] = (seq >>> 24) & 0xff
  for (let b = 4; b < buf.length; b++) buf[b] = (seq + b) & 0xff
  return buf
}

function decodeSeq(dst: Uint8Array): number {
  return (
    (dst[0] as number) |
    ((dst[1] as number) << 8) |
    ((dst[2] as number) << 16) |
    ((dst[3] as number) << 24)
  )
}

scope.onmessage = (ev) => {
  const { toWorker, fromWorker, count } = ev.data
  const consumer = new RingConsumer(toWorker)
  const producer = new RingProducer(fromWorker)
  const dst = new Uint8Array(256)

  let expected = 0
  let seqErrorsToWorker = 0
  let received = 0
  let sent = 0

  const pump = () => {
    for (;;) {
      const len = consumer.popInto(dst, 0)
      if (len < 0) break
      const seq = decodeSeq(dst)
      if (seq !== expected) seqErrorsToWorker++
      expected = seq + 1
      received++
    }
    while (sent < count) {
      const msg = encode(sent)
      if (!producer.tryPush(msg, msg.length)) break
      sent++
    }
    if (received < count || sent < count) {
      setTimeout(pump, 0)
      return
    }
    const stats: RingStats = { drops: -1, pushed: -1, popped: -1 }
    producer.stats(stats)
    scope.postMessage({
      type: 'done',
      seqErrorsToWorker,
      receivedToWorker: received,
      dropsFromWorker: stats.drops,
    })
  }
  pump()
}
