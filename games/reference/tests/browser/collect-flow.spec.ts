// `reference_collect_flow`/`reference_several_buttons`/`reference_pan_out_cancels` (docs/plan/
// 20b-reference-player-and-collect-ui.md Tests added, step 6): the scripted end-to-end passes this
// milestone's own Goal describes -- a button anchored on its tile, a real fill animation, an item
// landing in the inventory and the tile depleting, two buttons at once, and a collect cancelled by
// panning away. `tests/helpers/game.ts`'s own `panTo`/`uiState`/`clickCollect` (Seams, Provides) do
// the stepped-frame/tick choreography every existing spec in this directory already needed by hand
// (`ui-smoke.spec.ts`'s own precedent: settle the camera, `__stepTick` for the replica to see a
// tile, `__stepFrame` to flush the uplink).
import { expect, test } from '@playwright/test'
import { clickCollect, openGame, panTo, pumpUntil, uiState } from '../helpers/game.js'

declare global {
  interface Window {
    __cameraState?: () => { x: number; y: number; tilesAcross: number }
    __stepFrame?: (dtMs: number) => Promise<void>
    __stepTick?: (n: number) => Promise<void>
    __clock?: () => { authoritative: number; predicted: number; ticksPerSecond: number }
  }
}

// `tests/fixtures/landmarks.json` (`TEST_SEED`): the nearest stone tile to the origin.
const STONE = { x: -1, y: 2 }

// `content::COLLECT` (`sim/src/content.rs`) is `TICK_RATE.secs(2)` at this crate's own 20 Hz
// `TICK_RATE` = 40 ticks; `+ 1` is the host's own "tick T+1" queuing (0004), the same reasoning
// `depletion.spec.ts`/`ui-smoke.spec.ts` already document and rely on.
const COLLECT_TICKS = 40 + 1

async function anchoredScreenPoint(
  page: import('@playwright/test').Page,
  tile: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const canvasBox = await page.locator('#game').boundingBox()
  const camera = await page.evaluate(() => window.__cameraState?.())
  if (!canvasBox || !camera) throw new Error('missing canvas bounding box or camera state')
  const ppt = Math.max(canvasBox.width, canvasBox.height) / camera.tilesAcross
  return {
    x: canvasBox.x + canvasBox.width / 2 + (tile.x + 0.5 - camera.x) * ppt,
    y: canvasBox.y + canvasBox.height / 2 + (tile.y + 0.5 - camera.y) * ppt,
  }
}

test('reference_collect_flow', async ({ page }) => {
  await openGame(page, { path: '/test.html' })
  // `uiState`/`window.__uiState` (`engine/test.lastUi`) subscribes to `client.onUi` lazily, on its
  // own first call (`framecx.spec.ts`'s own precedent, `packages/engine/CLAUDE.md`): primed here,
  // before anything else runs, so no delivery is ever missed.
  await uiState(page)
  await panTo(page, STONE)

  const ui = await uiState(page)
  expect(
    ui?.in_range.some((e) => e.tile.x === STONE.x && e.tile.y === STONE.y),
    'the stone tile must be in range once the camera has settled on it',
  ).toBe(true)

  const button = page.locator(`[data-collect-tile="${STONE.x},${STONE.y}"]`)
  await expect(button).toBeVisible()

  // Anchored within 1 CSS px of the tile's own centre (0019 §5: `client.overlay.anchor`'s default
  // `align: 'bottom'` puts an anchored element's own bottom-centre point on its world position --
  // `collect.ts` anchors at `tile.x + 0.5, tile.y + 0.5`, the tile's centre).
  const expected = await anchoredScreenPoint(page, STONE)
  const buttonBox = await button.boundingBox()
  if (!buttonBox) throw new Error('collect button has no bounding box')
  const actualX = buttonBox.x + buttonBox.width / 2
  const actualY = buttonBox.y + buttonBox.height
  expect(
    Math.abs(actualX - expected.x),
    'anchored x within 1 CSS px of the tile centre',
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(actualY - expected.y),
    'anchored y within 1 CSS px of the tile centre',
  ).toBeLessThanOrEqual(1)

  await clickCollect(page, STONE)
  // `apply` needs a couple of ticks plus a further `stepFrame` for the client's own replica/onUi
  // drain to see `collecting` set (`ui-smoke.spec.ts`'s own precedent, same reasoning) -- polled,
  // not a fixed count (`pumpUntil`'s own doc comment).
  const withCollecting = await pumpUntil(
    page,
    (ui) => ui?.collecting !== null && ui?.collecting !== undefined,
  )
  await expect(button).toBeDisabled()

  const collecting = withCollecting?.collecting
  expect(
    collecting,
    'collecting must be set after StartCollect is admitted and applied',
  ).not.toBeNull()
  const clock = await page.evaluate(() => window.__clock?.())
  if (!collecting || !clock) throw new Error('missing collecting/clock state')

  await expect(button).toHaveClass(/is-filling/)
  // The animation itself starts on the browser's own next style/rendering pass, not synchronously
  // with the class add (`startFilling`, `collect.ts`) -- one real animation frame gives it that
  // pass before `getAnimations()` is asked to report it as `running`.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))),
  )

  // The Scope formula, verbatim: `(done_at - clock().predicted) / ticksPerSecond`, in ms -- read
  // back from the real CSS animation `collect.ts` started, not merely asserted in the abstract.
  const expectedDurationMs = ((collecting.done_at - clock.predicted) / clock.ticksPerSecond) * 1000
  // The animation targets `.collect-fill`, a child `<span>` of the button (`collect.ts`'s own CSS:
  // `.collect-button.is-filling .collect-fill`), not the button element itself -- `{ subtree: true }`
  // reaches it.
  const animations = await button.evaluate((el) =>
    el
      .getAnimations({ subtree: true })
      .filter((a) => a.playState === 'running')
      .map((a) => (a.effect as KeyframeEffect | null)?.getTiming().duration ?? null),
  )
  expect(animations.length, 'exactly one running fill animation').toBe(1)
  expect(typeof animations[0]).toBe('number')
  expect(Math.abs((animations[0] as number) - expectedDurationMs)).toBeLessThan(1)

  const finalUi = await pumpUntil(page, (ui) => ui?.collecting === null, {
    maxSteps: COLLECT_TICKS + 20,
  })
  expect(finalUi?.inventory.stone).toBe(1)
  expect(finalUi?.collecting).toBeNull()
  await expect(button).not.toBeDisabled()
  const animationsAfter = await button.evaluate((el) => el.getAnimations({ subtree: true }).length)
  expect(animationsAfter, 'the fill animation is gone once the collect completes').toBe(0)
})

// `sim/examples`'s own throwaway scan (this cut, deleted after use -- Deviations): two wood tiles,
// `(58, 55)` and `(57, 56)`, under `TEST_SEED`, isolated (the next-nearest resource is over 9 tiles
// from their midpoint) so exactly two buttons -- never a third -- can appear from one camera
// position.
const WOOD_A = { x: 58, y: 55 }
const WOOD_B = { x: 57, y: 56 }

test('reference_several_buttons', async ({ page }) => {
  await openGame(page, { path: '/test.html' })
  await uiState(page) // primes the `lastUi` subscription (see `reference_collect_flow`'s comment).
  await panTo(page, { x: 58, y: 56 })

  await expect(page.locator(`[data-collect-tile="${WOOD_A.x},${WOOD_A.y}"]`)).toBeVisible()
  await expect(page.locator(`[data-collect-tile="${WOOD_B.x},${WOOD_B.y}"]`)).toBeVisible()
  await expect(page.locator('[data-collect-tile]')).toHaveCount(2)
})

test('reference_pan_out_cancels', async ({ page }) => {
  await openGame(page, { path: '/test.html' })
  await uiState(page) // primes the `lastUi` subscription (see `reference_collect_flow`'s comment).
  await panTo(page, STONE)

  await clickCollect(page, STONE)
  await pumpUntil(page, (ui) => ui?.collecting !== null && ui?.collecting !== undefined)
  await expect(page.locator(`[data-collect-tile="${STONE.x},${STONE.y}"]`)).toBeDisabled()

  // Pan far enough away that the stone tile drops out of `RANGE` (3 tiles): `CancelCollect` fires
  // once `Ui.in_range` no longer names it (`collect.ts`'s own pan-out rule).
  await panTo(page, { x: STONE.x + 50, y: STONE.y + 50 })
  const afterPanOut = await pumpUntil(page, (ui) => ui?.collecting === null)
  expect(afterPanOut?.collecting, 'panning out of range cancels the collect').toBeNull()
  expect(afterPanOut?.inventory.stone, 'no item lands from a cancelled collect').toBe(0)
})
