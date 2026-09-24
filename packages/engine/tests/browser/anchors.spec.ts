// docs/plan/18-picking-and-overlay.md Exit criteria: "In desktop Chrome `device.html?anchors=50`
// shows `pick_id` on the HUD: a click on a ring sets it to that ring's id, a click on empty ground
// to `-`, a click on an anchored button leaves it unchanged (asserted by the `anchors` browser test
// reading the HUD text)." Also the device page half of `docs/plan/device-checks.md`'s M18 section.
//
// Viewport fixed at 800x600 (`device.html`'s own canvas fills `100vw`/`100vh`) so the screen math is
// exact: `tilesAcross=20` -> `pxPerTile = max(800, 600) / 20 = 40`. Ring `pickId=26` (grid index 25,
// `fixtures/overlay/src/lib.rs`'s own `RING_COLS=10`/`RING_ROWS=5`/`RING_SPACING_TILES=3`: `col=5,
// row=2` -> `tx=0, ty=0` -> world tile-centre `(0.5, 0.5)`) sits at screen `(420, 320)` with the
// camera centred at `(0, 0)` (`device.html`'s own default `x`/`y`).
import { expect, type Page, test } from '@playwright/test'
import { openPage } from './support/page.ts'

const VIEWPORT = { width: 800, height: 600 }
// pickId 26, world tile-centre (0.5, 0.5) -> screen (420, 320) with the camera centred (0, 0); `y`
// is offset 10px *below* that (the button's own box sits entirely *above* its anchor point,
// `translate(-50%, -100%)`, so its bottom edge is exactly `y=320` -- clicking exactly on that
// boundary pixel is ambiguous and measurably missed the ring in an early draft of this test; well
// inside the ring's own 24px screen pick radius (`0.6` tile * `40` px/tile) either way).
const RING_SCREEN = { x: 420, y: 330 }
const GROUND_SCREEN = { x: 480, y: 320 } // 60px from both ring 26 and ring 27: outside either radius

async function openAnchors(page: Page, extra = ''): Promise<void> {
  await page.setViewportSize(VIEWPORT)
  await openPage(page, `/device.html?anchors=50&tiles=20${extra}`)
  // Real rAF pacing (`createRealFrameLoop`, `systemScheduler`): the layer's own `transform`/`--z`
  // (properties mode) or each anchor's own `transform` (translate mode) is written by the first
  // `onOverlay` call, not by `client.overlay.anchor()` itself -- give a few real frames to land
  // before reading positions or clicking.
  await page.waitForTimeout(300)
}

/** A real tap needs down and up to straddle at least one real animation frame: `input/semantic.ts`'s
 * recognizer only samples `PointerSlots.active` once per rAF (its own doc comment: "Runs once per
 * rAF"), so a synthetic `page.mouse.click()` -- down and up dispatched in the same JS task, under
 * 1 ms apart -- never registers `wasActive` at all (found running this test's own first draft: `page
 * .mouse.click()` left `pick_id` at `-` even directly over a ring, `page.locator(...).boundingBox()`
 * confirming the button sat exactly where expected). A short real delay between down and up (a real
 * human tap is easily this slow) gives the frame loop's own real rAF a chance to observe the press. */
async function tap(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.waitForTimeout(50)
  await page.mouse.up()
}

function pickIdFromHud(hud: string): string {
  const m = /pick_id: (\S+)/.exec(hud)
  expect(m, hud).not.toBeNull()
  return (m as RegExpExecArray)[1] as string
}

test('anchors: pick_id on the HUD (ring, ground, button)', async ({ page }) => {
  await openAnchors(page)

  const before = pickIdFromHud((await page.locator('#hud').textContent()) ?? '')
  expect(before).toBe('-')

  // A click on empty ground: `pick_id` stays `-`.
  await tap(page, GROUND_SCREEN.x, GROUND_SCREEN.y)
  await expect
    .poll(async () => pickIdFromHud((await page.locator('#hud').textContent()) ?? ''))
    .toBe('-')

  // A click on the ring itself (`align: 'bottom'`'s own button sits entirely *above* this point --
  // device.ts's own module doc comment): `pick_id` becomes that ring's id, 26.
  await tap(page, RING_SCREEN.x, RING_SCREEN.y)
  await expect
    .poll(async () => pickIdFromHud((await page.locator('#hud').textContent()) ?? ''))
    .toBe('26')

  // A click on empty ground again, to have a known, different `pick_id` (`-`) right before the
  // button click below -- so "unchanged" is unambiguous either way it could have gone wrong.
  await tap(page, GROUND_SCREEN.x, GROUND_SCREEN.y)
  await expect
    .poll(async () => pickIdFromHud((await page.locator('#hud').textContent()) ?? ''))
    .toBe('-')

  // A click on the anchored button (`pointer-events: auto`, 0019 §4's own "Input over DOM UI"
  // shape): the browser's own hit testing keeps it off the canvas entirely, so no `tap` ever
  // reaches `client.input.on('tap', ...)` -- `pick_id` stays exactly what it already was.
  await page.locator('button', { hasText: '26' }).click()
  await page.waitForTimeout(200) // nothing should happen; give a real tap every chance to land late
  const afterButton = pickIdFromHud((await page.locator('#hud').textContent()) ?? '')
  expect(afterButton).toBe('-')
})

test('anchors: anchorMode=translate reaches the same HUD picking behaviour', async ({ page }) => {
  await openAnchors(page, '&anchorMode=translate')
  await expect(page.locator('#hud')).toContainText('anchorMode=translate')

  await tap(page, RING_SCREEN.x, RING_SCREEN.y)
  await expect
    .poll(async () => pickIdFromHud((await page.locator('#hud').textContent()) ?? ''))
    .toBe('26')
})
