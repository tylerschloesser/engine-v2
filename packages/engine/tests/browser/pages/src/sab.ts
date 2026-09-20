// `sab.html`: `sab.ring_both_directions` (docs/plan/06-sab-primitives-and-workers.md, Tests added).
// Main pushes an independently sequenced stream to a worker over one ring (`toWorker`) and drains
// the worker's own independently sequenced stream over a second ring (`fromWorker`), so both
// directions are exercised for real -- the spike only measured worker -> main (0015 §2).
import { createRing, RingConsumer, RingProducer, type RingStats } from '../../../../src/sab/ring.ts'

declare global {
  interface Window {
    __sabRing?: {
      seqErrorsToWorker: number
      seqErrorsFromWorker: number
      dropsToWorker: number
      dropsFromWorker: number
      receivedToWorker: number
      receivedFromWorker: number
      count: number
    }
    __pageReady?: true
  }
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

const COUNT = 2000
const toWorkerSab = createRing(64, 64)
const fromWorkerSab = createRing(64, 64)

const producer = new RingProducer(toWorkerSab)
const consumer = new RingConsumer(fromWorkerSab)

type FromWorker = {
  type: 'done'
  seqErrorsToWorker: number
  receivedToWorker: number
  dropsFromWorker: number
}

const worker = new Worker(new URL('./sab-worker.js', import.meta.url), { type: 'module' })
const workerDone = new Promise<FromWorker>((resolve, reject) => {
  worker.onmessage = (ev: MessageEvent<FromWorker>) => resolve(ev.data)
  worker.onerror = (e) => reject(new Error(`sab worker error: ${e.message}`))
})
worker.postMessage({ toWorker: toWorkerSab, fromWorker: fromWorkerSab, count: COUNT })

const dst = new Uint8Array(256)
let sent = 0
let received = 0
let expectedFromWorker = 0
let seqErrorsFromWorker = 0

function pump(): void {
  while (sent < COUNT) {
    const msg = encode(sent)
    if (!producer.tryPush(msg, msg.length)) break
    sent++
  }
  for (;;) {
    const len = consumer.popInto(dst, 0)
    if (len < 0) break
    const seq = decodeSeq(dst)
    if (seq !== expectedFromWorker) seqErrorsFromWorker++
    expectedFromWorker = seq + 1
    received++
  }
  if (sent < COUNT || received < COUNT) {
    requestAnimationFrame(pump)
  }
}
pump()

const workerResult = await workerDone
// Both directions may finish their own draining slightly before the other side notices; pump once
// more so a straggling `fromWorker` message published just before `pump` last exited is not missed.
while (received < COUNT) {
  const len = consumer.popInto(dst, 0)
  if (len < 0) break
  const seq = decodeSeq(dst)
  if (seq !== expectedFromWorker) seqErrorsFromWorker++
  expectedFromWorker = seq + 1
  received++
}

const producerStats: RingStats = { drops: -1, pushed: -1, popped: -1 }
producer.stats(producerStats)

window.__sabRing = {
  seqErrorsToWorker: workerResult.seqErrorsToWorker,
  seqErrorsFromWorker,
  dropsToWorker: producerStats.drops,
  dropsFromWorker: workerResult.dropsFromWorker,
  receivedToWorker: workerResult.receivedToWorker,
  receivedFromWorker: received,
  count: COUNT,
}

const result = document.getElementById('result')
if (result) result.textContent = JSON.stringify(window.__sabRing)

window.__pageReady = true
