// M39r: the driver's tap on a ring keeps its distance from every button box (Chrome Android snaps a tap near a
// <button> onto it: measured on the Pixel 5, a pointerdown 9 px under a button's edge targeted the button), and a
// layout with no such point is NotDrivable at once, not a five-minute wait.
import { describe, expect, test } from 'vitest'
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

  test('device-walk ring tap: chooseRingTap returns the point with the most clearance, and no buttons means the ring centre', () => {
    expect(chooseRingTap(ring, [])).toMatchObject({ x: ring.x, y: ring.y })
    const far = box(ring.x - 40, ring.y - 7)
    const best = chooseRingTap(ring, [far])
    expect(gap(best, far)).toBeGreaterThan(gap(ring, far))
    expect(best.clearance).toBeCloseTo(gap(best, far), 3)
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
