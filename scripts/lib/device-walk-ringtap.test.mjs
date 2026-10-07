// M39r: the driver's tap on a ring keeps its distance from every button box (Chrome Android snaps a tap near a
// <button> onto it: measured on the Pixel 5, a pointerdown 9 px under a button's edge targeted the button), and a
// layout with no such point is NotDrivable at once, not a five-minute wait.
import { describe, expect, test } from 'vitest'
import { calibrationFrom, offsetsFor, toScreen } from './device-walk/drive/android.mjs'
import { createFakeBackend } from './device-walk/drive/fake-backend.mjs'
import { chooseRingTap, devicePerson } from './device-walk/drive/person.mjs'

const PPT = 9.8 // 40 tiles across 392 px
const R = 0.6 * PPT
const ring = { x: 196.5, y: 345.45, r: R }
const box = (left, top, w = 14, h = 14) => ({ left, top, right: left + w, bottom: top + h })
const gap = (p, b) =>
  Math.hypot(Math.max(b.left - p.x, 0, p.x - b.right), Math.max(b.top - p.y, 0, p.y - b.bottom))
const KEY = "of document.querySelectorAll('button')"
const PROMPT = {
  id: 'M18-pick',
  n: 1,
  kind: 'act',
  text: 'Zoom 1 of 3: tap the highlighted ring (1 of 3).',
}

async function tapFor(boxes) {
  const b = createFakeBackend({
    pages: { '#walk-ring': { x: ring.x, y: ring.y }, [KEY]: { r: ring.r, boxes } },
  })
  const out = await devicePerson(b).answer(PROMPT)
  return { out, tap: b.calls.find((c) => c.m === 'tap')?.args }
}

describe('device-walk ring tap: the tap point keeps its clearance from every button box', () => {
  test("device-walk ring tap: with the ring button 4.8 px above it (today's page at 9.8 px per tile) there is no point 12 px clear: NotDrivable at once, no tap", async () => {
    const { out, tap } = await tapFor([box(189.38, 326.64)]) // bottom 340.64, gap to the ring centre 4.8
    expect(out.status).toBe('notDrivable')
    expect(out.reason).toMatch(/ring too close to a button at this zoom/)
    expect(tap).toBeUndefined()
  })

  test('device-walk ring tap: the point is inside the ring and at least 12 px from every button box (a neighbour 12 px to the right pushes it left)', async () => {
    const boxes = [box(189.38, 290), box(ring.x + 16, ring.y - 7)]
    const { out, tap } = await tapFor(boxes)
    expect(out.status).toBe('done')
    const p = { x: tap[0], y: tap[1] }
    expect(Math.hypot(p.x - ring.x, p.y - ring.y)).toBeLessThanOrEqual(ring.r)
    for (const b of boxes) expect(gap(p, b)).toBeGreaterThanOrEqual(12)
  })

  test('device-walk ring tap: chooseRingTap returns the clear point nearest the centre: no buttons, or one far enough, means the centre', () => {
    expect(chooseRingTap(ring, [])).toMatchObject({ x: ring.x, y: ring.y })
    const far = box(ring.x - 40, ring.y - 7)
    const best = chooseRingTap(ring, [far])
    expect(best).toMatchObject({ x: ring.x, y: ring.y })
    expect(best.clearance).toBeCloseTo(gap(best, far), 3)
    // A box 6 px left of the centre: the point moves right only as far as 12 px clearance needs.
    const near = box(ring.x - 20, ring.y - 7)
    const p = chooseRingTap({ ...ring, r: 20 }, [near])
    expect(p.clearance).toBeGreaterThanOrEqual(12)
    expect(Math.hypot(p.x - ring.x, p.y - ring.y)).toBeLessThanOrEqual(0.3 * 20 + 1e-9)
  })

  test('device-walk ring tap: with the only button lifted 26 px clear of the ring (ringPhase, zoom 40 on the Pixel 5) the tap is the ring centre, not its edge', () => {
    // M39r round m39r-pixel-2: the most-clearance rule tapped 0.85 r below the centre (+9.5 px at 40 tiles,
    // +23 at 20, +35.5 at 12), and with the 4 px highlight offset every tap missed.
    const big = { x: 196.52, y: 345.45, r: 0.6 * (745 / 40) }
    const lifted = box(big.x - 7, big.y - big.r - 26 - 14)
    const bar = { left: 0, top: 655, right: 392, bottom: 745 }
    expect(chooseRingTap(big, [lifted], undefined, [bar])).toMatchObject({ x: big.x, y: big.y })
  })

  test('device-walk ring tap: the button step still taps the button centre', async () => {
    const b = createFakeBackend({ pages: { '#walk-ring': { x: 120, y: 230 } } })
    const out = await devicePerson(b).answer({
      ...PROMPT,
      text: 'Tap the highlighted button (it is numbered 26).',
    })
    expect(out.status).toBe('done')
    expect(b.calls.find((c) => c.m === 'tap').args).toEqual([120, 230])
  })
})

describe("device-walk ring tap: the driver's own placement is not where the offset came from", () => {
  test('device-walk ring tap: toScreen is within half a physical pixel of the asked point at the Pixel 5 dpr (rounding is at most 0.19 CSS px)', async () => {
    const { toScreen } = await import('./device-walk/drive/android.mjs')
    const cal = { offX: 0.7, offY: 56.35, dpr: 2.75 }
    let worst = 0
    for (let x = 0; x < 392; x += 7.31)
      for (let y = 0; y < 745; y += 11.17) {
        const s = toScreen(cal, x, y)
        worst = Math.max(
          worst,
          Math.abs(s.x / cal.dpr - cal.offX - x),
          Math.abs(s.y / cal.dpr - cal.offY - y),
        )
      }
    expect(worst).toBeLessThanOrEqual(0.5 / cal.dpr + 1e-9)
  })
})

describe('device-walk ring tap: the page x offset is measured by the calibration tap (M39r Pixel rounds)', () => {
  // The Pixel 5 measure: inner 392 x 745, outer 393 x 851, dpr 2.75. The pointerdown of every tap landed at
  // x 201.45 for an aim of 196.38 (formula offset 1 css px): the page's true x offset there is -4.0 css px.
  const m = { innerWidth: 392, innerHeight: 745, outerWidth: 393, outerHeight: 851, dpr: 2.75 }
  const TRUE = { x: -4.0, y: 105.45 } // client = physical / dpr - TRUE
  const lands = (s) => ({ x: s.x / m.dpr - TRUE.x, y: s.y / m.dpr - TRUE.y })

  test('device-walk ring tap: an aim at (196.38, 344.64) lands within 0.2 px once the calibration tap has taught the x offset', () => {
    const px = Math.round((m.outerWidth * m.dpr) / 2)
    const py = Math.round((m.outerHeight * m.dpr) / 2)
    const hit = lands({ x: px, y: py })
    const cal = calibrationFrom(m, hit, px, py)
    const got = lands(toScreen(offsetsFor(m, cal.chin, cal.xBias), 196.38, 344.64))
    expect(Math.abs(got.x - 196.38)).toBeLessThan(0.2)
    expect(Math.abs(got.y - 344.64)).toBeLessThan(0.2)
    // The formula alone (what the rounds ran) lands 4 px right of the aim.
    const old = lands(toScreen(offsetsFor(m, cal.chin), 196.38, 344.64))
    expect(old.x - 196.38).toBeGreaterThan(4)
  })

  test('device-walk ring tap: the learned x bias follows the page to the other orientation (the formula still carries a cutout)', () => {
    const cal = calibrationFrom(m, { x: 200.36, y: 313 }, 540, 1170)
    const land = { ...m, innerWidth: 800, innerHeight: 392, outerWidth: 851, outerHeight: 393 }
    expect(offsetsFor(land, 0.5, cal.xBias).offX).toBeCloseTo(851 - 800 - 4 - 1, 1)
  })
})

describe('device-walk ring tap: the walk bar is not tapped (M39r Pixel round: ring 36 at 12 tiles landed on the bar)', () => {
  // Ring 36 at 12 tiles across a 392 x 745 page: centre (196.89, 617.83), pick radius 0.6 x 62 = 37 px.
  const big = { x: 196.89, y: 617.83, r: 37.2 }
  const bar = { left: 0, top: 655, right: 392, bottom: 745 }
  const lifted = box(190, 538, 14, 14)

  async function tapWith(covers) {
    const b = createFakeBackend({
      pages: {
        '#walk-ring': { x: big.x, y: big.y },
        [KEY]: { r: big.r, boxes: [lifted], covers },
      },
    })
    const out = await devicePerson(b).answer(PROMPT)
    return { out, tap: b.calls.find((c) => c.m === 'tap')?.args }
  }

  test('device-walk ring tap: the chosen point stays 8 px clear of the bar even when the farthest point from the button is under it', async () => {
    const { out, tap } = await tapWith([bar])
    expect(out.status).toBe('done')
    expect(gap({ x: tap[0], y: tap[1] }, bar)).toBeGreaterThanOrEqual(8)
    expect(gap({ x: tap[0], y: tap[1] }, lifted)).toBeGreaterThanOrEqual(12)
  })

  test('device-walk ring tap: a ring wholly under the bar is NotDrivable at once, no tap', async () => {
    const { out, tap } = await tapWith([{ left: 0, top: 500, right: 392, bottom: 745 }])
    expect(out.status).toBe('notDrivable')
    expect(out.reason).toMatch(/under the walk bar/)
    expect(tap).toBeUndefined()
  })
})
