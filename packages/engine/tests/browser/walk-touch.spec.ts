// `pnpm device:walk --auto`'s pointer checks (docs/plan/39f-device-auto-runner.md step 9 and M11-gestures)
// end to end in headless Chromium and WebKit: the fake phone's fingers are mouse drags, clicks and the wheel
// (`fake-phone-touch.mjs`), the rest is the real round (`support/walk-rig.ts`). Not touch events: what a real
// finger does is the device check. All `@slow @webkit-gpu`.
import { expect, test } from '@playwright/test'
import { openPage } from './support/page.js'
import { finalOf, type Handler, start } from './support/walk-rig.js'

const crit = (
  e: { criteria: { name: string; value: unknown; limit?: unknown; ok: boolean | null }[] },
  n: string,
) => e.criteria.find((c) => c.name === n)

type Touch = { gestureHandlers(o?: { panMs?: number }): Handler[]; anchorHandlers(): Handler[] }
const touch = async (): Promise<Touch> =>
  (await import(
    new URL('../../../../scripts/lib/device-walk/fake-phone-touch.mjs', import.meta.url).href
  )) as Touch

declare global {
  interface Window {
    __check?: {
      ready: boolean
      readings(): Record<string, number | string | boolean | null>
      act?: Record<string, (arg?: unknown) => Promise<unknown>>
    }
  }
}

test('walk-touch: M11-gestures: seven gestures, each with its own detected ticks, the tapped tile against the tile under the finger, one judge prompt @slow @webkit-gpu', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const t = await touch()
  const r = await start(['M11-gestures'], { panMs: 1500, actTimeoutMs: 30_000 }, 16400)
  try {
    const seen = await r.phone(page, { timeoutMs: 170_000, handlers: t.gestureHandlers() })
    expect(seen.judged, 'the world point and the flick: one question').toBe(1)
    const g = finalOf(r, 'M11-gestures')
    expect(g, JSON.stringify(g)).toMatchObject({ result: 'pass', by: 'mixed' })
    expect(crit(g, 'gestures_done')).toMatchObject({ value: 7, ok: true })
    expect(crit(g, 'page_scrolled')).toMatchObject({ value: false, ok: true })
    expect(crit(g, 'page_zoomed')).toMatchObject({ value: false, ok: true })
    expect(crit(g, 'page_reloaded')).toMatchObject({ value: 0, ok: true })
    expect(crit(g, 'cursor_tile_after_tap')).toMatchObject({ value: true, ok: true })
    expect(String(crit(g, 'rotation_keeps_centre')?.value)).toMatch(/tiles \(.* px\)/) // tiles and px, shown to the judge
    expect(crit(g, 'world_point_drift_tiles')?.limit).toBe(1) // the drag's world point is measured, not judged
    // The zoom went out and back: both ends of the range were seen.
    expect(Number(g.metrics.tiles_max)).toBeGreaterThan(Number(g.metrics.tiles_min) * 3)
    expect(Number(g.metrics.flick_speed_px_ms)).toBeGreaterThan(0.8)
    // Every gesture was asked for on its own sheet, the rotation answered by the built-in rotate.
    const sheets = (seen.sheets as string[]).join('\n')
    for (const s of [
      /^Pan with one finger/m,
      /^Flick the world/m,
      /^Pinch out to the furthest zoom/m,
      /^Tap a tile/m,
      /^Pull down from the very top edge/m,
      /^Double-tap/m,
      /^Rotate the phone/m,
    ])
      expect(sheets).toMatch(s)
    expect(r.events().find((e) => e.type === 'attempt' && e.status === 'done')?.outcome).toBe(
      'judge',
    )
  } finally {
    await r.stop()
  }
})

test('walk-touch: M18 on device.html?anchors=50: the swim probe in both orientations, the rings the bar highlights, the button tap, the ghost tile and the fill-rate sweep @slow @webkit-gpu', async ({
  page,
}) => {
  test.setTimeout(300_000)
  const t = await touch()
  const ids = ['M18-anchors', 'M18-pick', 'M18-touch-ghost', 'M18-fill-rate-with-anchors']
  const r = await start(ids, { windowMs: 2500, warmupMs: 0, actTimeoutMs: 30_000 }, 16500)
  try {
    const seen = await r.phone(page, { timeoutMs: 290_000, handlers: t.anchorHandlers() })
    for (const id of ids) expect(['auto', 'mixed'], id).toContain(finalOf(r, id).by)

    // A software WebGPU adapter (WebKit here) may miss the 17.5 ms rAF p95: that is a hardware number, the
    // flow is what is asserted; Chromium has the headroom and passes for real.
    const swim = finalOf(r, 'M18-anchors')
    expect(['pass', 'fail']).toContain(swim.result)
    if (test.info().project.name === 'chromium') {
      expect(swim).toMatchObject({ result: 'pass', by: 'mixed' })
      expect(crit(swim, 'raf_p95_ms')?.ok).toBe(true)
    }
    expect(typeof crit(swim, 'anchor_max_error_px')?.value).toBe('number')
    expect(Number(swim.metrics.anchor_probe_frames)).toBeGreaterThan(20)
    expect(seen.rotated, 'a rotate prompt in the swim and in the fill-rate').toBeGreaterThanOrEqual(
      2,
    )

    const pick = finalOf(r, 'M18-pick')
    expect(pick, JSON.stringify(pick)).toMatchObject({ result: 'pass', by: 'auto' })
    expect(crit(pick, 'pick_misses')).toMatchObject({ value: 0, ok: true })
    expect(crit(pick, 'button_tap_changed_pick')).toMatchObject({ value: false, ok: true })
    expect(pick.metrics.rings_tapped).toBe(9) // three rings at each of three zoom levels

    const ghost = finalOf(r, 'M18-touch-ghost')
    expect(ghost, JSON.stringify(ghost)).toMatchObject({ result: 'pass', by: 'mixed' })
    expect(crit(ghost, 'cursor_tile_matches_tap')).toMatchObject({ value: true, ok: true })
    expect(crit(ghost, 'drag_pans')).toMatchObject({ value: true, ok: true })

    const fill = finalOf(r, 'M18-fill-rate-with-anchors')
    expect(['pass', 'fail']).toContain(fill.result)
    expect(fill.criteria.map((c) => c.name)).toContain('raf_p95_ms')
  } finally {
    await r.stop()
  }
})

test('walk-touch: the anchor probe sees a button that is not where its ring is, and reads zero for the real overlay @slow @webkit-gpu', async ({
  page,
}) => {
  await openPage(page, '/device.html?anchors=50&tiles=20')
  await page.waitForFunction(() => window.__check?.ready)
  const probe = async (shiftPx: number) => {
    await page.evaluate((px) => {
      // Ring 26 is the one at the middle of the screen: a button whose ring is in view is probed.
      const b = [...document.querySelectorAll('button')].find(
        (x) => x.textContent === '26',
      ) as HTMLButtonElement
      b.style.marginLeft = `${px}px`
    }, shiftPx)
    await page.evaluate(() => window.__check?.act?.probe?.({ on: true, reset: true }))
    await page.waitForTimeout(600)
    await page.evaluate(() => window.__check?.act?.probe?.({ on: false }))
    return page.evaluate(() => Number(window.__check?.readings().anchor_err_max_px))
  }
  expect(await probe(0)).toBeLessThan(0.75)
  expect(await probe(8)).toBeGreaterThan(5)
})
