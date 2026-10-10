// `zoomout/*` (M31 step 6, PRE-PLAN §9 risk 3): the 128-chunk cap
// measured at full zoom-out (a 256-tile view, 9 x 9 visible chunks, ring 1 = 121) over a dense
// `fx-busy-field` region, panning at one and two view-widths per second and oscillating under 64
// tiles. One world is built once (a 25 x 11 block of dense chunks, about 55,000 entities) and every
// scenario adds its own client to it, so the file pays for the fill once.
//
// Every scenario starts in wilderness west of the block (pristine enters, nothing queued) and pans
// into it, so `lateVisibleTicks` and the enter bytes are the pan's own. The results are recorded as
// `counters.net.zoomout*` rows and in the brief's Deviations, with the risk-3 rule's outcome.
import { afterAll, beforeAll, expect, test } from 'vitest'
import { assertBudget } from '../../src/test/budget.js'
import type { NetHarness } from '../../src/test/net-harness.js'
import { denseWorld, worstSecondAfter } from './support.js'

const TICK_HZ = 20
const REGION = { cx0: 40, cx1: 64, cy0: 40, cy1: 50 }
const ROW_Y = 45 * 32 + 16
const START_X = 34 * 32 + 16
const REFILL = 48_000
const BURST = 128_000

function measure(name: string, counters: object) {
  if (process.env.MEASURE) console.log(`MEASURE ${name} ${JSON.stringify(counters)}`)
}

const worlds = new Map<number, Promise<NetHarness>>()
const nextClient = new Map<number, number>()
/** One dense world per subscription cap (the old 128 default, kept as the risk-3 baseline since ADR 0059 made 144 the default; 144 is the new default). Client 0
 * fills; clients 1.. are the scenarios', parked far away by `denseWorld` until each takes its turn. */
function shared(cap = 128): Promise<NetHarness> {
  let w = worlds.get(cap)
  if (!w) {
    w = denseWorld(3301 + cap, 6, REGION, cap)
    worlds.set(cap, w)
  }
  return w
}
function takeClient(cap: number): number {
  const i = nextClient.get(cap) ?? 1
  nextClient.set(cap, i + 1)
  return i
}
// The ~55,000-entity fill is shared fixture setup, not a scenario: built here it is no single test's
// time (it used to land on whichever test ran first, `baseline-256x144`, and the first cap-144 test).
beforeAll(async () => {
  await shared()
  await shared(144)
}, 120_000)
afterAll(async () => {
  for (const w of worlds.values()) await (await w).dispose()
})

function enterBytes(c: { sections: Record<string, number> }): number {
  return (c.sections.ChunkEnterPristine ?? 0) + (c.sections.ChunkSnapshots ?? 0)
}

async function pan(opts: {
  cap?: number
  halfH: number
  viewWidthsPerS: number
  seconds: number
  oscillate?: number
}) {
  const h = await shared(opts.cap)
  const i = takeClient(opts.cap ?? 128)
  const c = h.clients[i]
  if (!c) throw new Error('no client')
  c.setView({ x: START_X, y: ROW_Y, halfW: 128, halfH: opts.halfH })
  await h.advanceTicks(30) // wilderness join: pristine enters, instant
  const base = h.counters(i)
  const tokensAtStart = base.bucketTokens
  let maxQueued = 0
  let burstSpentAt = -1
  const ticks = Math.round(opts.seconds * TICK_HZ)
  const speed = opts.viewWidthsPerS * 256
  if (opts.oscillate === undefined) {
    c.panTo(START_X + speed * opts.seconds, ROW_Y, speed)
    for (let t = 0; t < ticks; t++) {
      await h.advanceTicks(1)
      const now = h.counters(i)
      maxQueued = Math.max(maxQueued, now.queuedEnters)
      if (burstSpentAt < 0 && now.bucketTokens < 3000) burstSpentAt = h.hostTick()
    }
  } else {
    // Back and forth over `oscillate` tiles, starting inside the block.
    const mid = 46 * 32 + 16
    c.setView({ x: mid, y: ROW_Y, halfW: 128, halfH: opts.halfH })
    await h.advanceTicks(200) // let that join drain first
    const settled = h.counters(i)
    let dir = 1
    for (let leg = 0; leg < Math.round(opts.seconds); leg++) {
      c.panTo(mid + dir * (opts.oscillate / 2), ROW_Y, speed)
      for (let t = 0; t < TICK_HZ; t++) await h.advanceTicks(1)
      dir = -dir
    }
    const end = h.counters(i)
    return { h, i, base: settled, end, maxQueued, ticks, tokensAtStart, burstSpentAt }
  }
  const end = h.counters(i)
  return { h, i, base, end, maxQueued, ticks, tokensAtStart, burstSpentAt }
}

function summarize(r: Awaited<ReturnType<typeof pan>>) {
  const { base, end } = r
  return {
    enterBytes: enterBytes(end) - enterBytes(base),
    chunkLeaves: end.chunkLeaves - base.chunkLeaves,
    lateVisibleTicksP95: end.lateVisibleTicksP95,
    lateVisibleTicksMax: end.lateVisibleTicksMax,
    droppedVisible: end.droppedVisible - base.droppedVisible,
    capEvictions: end.capEvictions - base.capEvictions,
    reentersWithin5s: end.reentersWithin5s - base.reentersWithin5s,
    reenterBytes: end.reenterBytes - base.reenterBytes,
    maxQueued: r.maxQueued,
    orderViolations: end.orderViolations,
    heldChunks: end.heldChunks,
  }
}

test('zoomout/baseline-256x144', async () => {
  const h = await shared()
  const i = takeClient(128)
  const c = h.clients[i]
  if (!c) throw new Error('no client')
  // 256 x 144 tiles (a wide phone or desktop): 0010 says 88 chunks, inside the cap with room to spare.
  c.setView({ x: 45 * 32 + 16 + 32, y: ROW_Y, halfW: 128, halfH: 72 })
  let drained = -1
  for (let t = 1; t <= 200; t++) {
    await h.advanceTicks(1)
    if (drained < 0 && t > 3 && h.counters(i).queuedEnters === 0) drained = t
  }
  const end = h.counters(i)
  const result = {
    heldChunks: end.heldChunks,
    capEvictions: end.capEvictions,
    ticksToDrain: drained,
  }
  measure('baseline', { ...result, enterBytes: enterBytes(end) })
  assertBudget(result, 'net.zoomoutBaseline256x144HeldChunks')
  expect(end.capEvictions, 'the 256 x 144 view fits the 128-chunk cap').toBe(0)
})

test('zoomout/pan-1vw', async () => {
  const r = await pan({ halfH: 128, viewWidthsPerS: 1, seconds: 3 })
  const s = summarize(r)
  measure('pan1', s)
  assertBudget({ enterBytes: s.enterBytes }, 'net.zoomoutPan1vwEnterBytes')
  assertBudget(s, 'net.zoomoutPan1vwLateVisibleP95')
  r.h.assertConverged()
}, 120_000)

test('zoomout/pan-2vw', async () => {
  const r = await pan({ halfH: 128, viewWidthsPerS: 2, seconds: 1.5 })
  const s = summarize(r)
  measure('pan2', s)
  assertBudget({ enterBytes: s.enterBytes }, 'net.zoomoutPan2vwEnterBytes')
  assertBudget(s, 'net.zoomoutPan2vwLateVisibleP95')
  r.h.assertConverged()
}, 120_000)

test('zoomout/oscillate-48-tiles', async () => {
  const r = await pan({ halfH: 128, viewWidthsPerS: 0.375, seconds: 10, oscillate: 48 })
  const s = summarize(r)
  measure('osc', s)
  // Under 64 tiles the hysteresis holds every chunk: nothing leaves, nothing re-enters.
  assertBudget(s, 'net.zoomoutOscillateReenterBytes')
  r.h.assertConverged()
}, 120_000)

test('zoomout/oscillate-48-tiles-cap144', async () => {
  // The risk-3 candidate (PRE-PLAN section 11 item 8): a 144-chunk cap, ring 1 of the maximum view
  // plus one entering and one retained column.
  const r = await pan({ cap: 144, halfH: 128, viewWidthsPerS: 0.375, seconds: 10, oscillate: 48 })
  const s = summarize(r)
  measure('osc144', s)
  assertBudget(s, 'net.zoomoutOscillateCap144ReenterBytes')
  r.h.assertConverged()
}, 120_000)

test('zoomout/pan-1vw-cap144', async () => {
  const r = await pan({ cap: 144, halfH: 128, viewWidthsPerS: 1, seconds: 3 })
  const s = summarize(r)
  measure('pan1cap144', s)
  assertBudget(s, 'net.zoomoutPan1vwCap144LateVisibleP95')
}, 120_000)

test('rates/hard-ceiling', async () => {
  // 0010's 64 KB/s hard ceiling is structural (16 KB/s soft cap + 48 KB/s refill): once the burst is
  // spent, the worst 1 s of a maximum-zoom pan through dense chunks stays under it.
  const r = await pan({ halfH: 128, viewWidthsPerS: 1, seconds: 3 })
  expect(r.burstSpentAt, 'the burst was spent').toBeGreaterThan(0)
  const worst = worstSecondAfter(r.h, r.i, r.burstSpentAt)
  measure('hardCeilingPan', { worstSecondBytesDown: worst })
  assertBudget({ worstSecondBytesDown: worst }, 'net.hardCeilingBytesPerSPan')
}, 120_000)
