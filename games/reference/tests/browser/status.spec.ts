// `reference: status walks every event` (docs/plan/37-robustness-events.md step 6): every engine-to-game
// event the audit lists (`packages/engine/src/engine-events.test.ts`) has a distinct, visible state in
// `ui/status.ts`, on one page (`/test.html?persist=...&flags=...`) driven by `TestFlags`, `engine/test`
// helpers and the page's manual clock -- no real waiting. Real engine events: the not-durable storage
// notice and storage line (`noOpfs`), a desync (`client_corrupt_chunk` on a held chunk), the client
// resyncing after a trap (`trapClientAtFrame`), `rendererLost` (two device losses within the 10 s window
// on the manual clock), `onFatal` (a second trap inside 10 s). Fed straight into the game's `StatusUi`,
// because they need a server or a build this page does not have: the link states `reconnecting`,
// `updating`, `superseded`, `rejected` (`mp/*` in the engine package and `multiplayer.spec.ts` prove
// the wiring), `rendererLost`'s `no-adapter` reason (M37b's `null adapter raises rendererLost`), and the
// `world-busy` / `save-incompatible` screens (`reference_world_busy_second_tab`; the browser path of
// `save-incompatible` needs the `test-hooks` build, `reference_save_incompatible_leaves_files @slow`).
import { expect, test } from '@playwright/test'
import { openGame } from '../helpers/game.js'

declare global {
  interface Window {
    __setCamera?: (x: number, y: number, tilesAcross: number) => Promise<void>
    __stepFrame?: (dtMs: number) => Promise<void>
    __stepTick?: (n: number) => Promise<void>
    __loseDevice?: () => Promise<void>
    __failNextAdapter?: () => void
    __advanceClock?: (ms: number) => void
    __corruptChunk?: (cx: number, cy: number) => Promise<number>
    __statusLink?: (state: string, reason?: string) => void
    __statusRendererLost?: (reason: 'no-adapter' | 'repeated-loss') => void
    __showStartFailure?: (code: string) => boolean
    __startFailureOps?: () => { exports: number; deletes: number }
  }
}

/** The client instance traps at its 30th and 36th `frame()` (`TestFlags.trapClientAtFrame`): after the
 * camera and the desync below have taken their frames, 6 frames apart (well inside the 10 s guard
 * window of the manual clock). The test steps frames until each trap shows. */
const FLAGS = { noOpfs: true, trapClientAtFrame: [30, 36] }

test('reference: status walks every event', async ({ page }) => {
  await openGame(page, {
    path: `/test.html?persist=status-walk&flags=${encodeURIComponent(JSON.stringify(FLAGS))}`,
  })
  const line = page.locator('.link-status')
  const frame = (n = 1) =>
    page.evaluate(async (count) => {
      for (let i = 0; i < count; i++) await window.__stepFrame?.(50)
    }, n)

  // Storage (0005): the world is not durable (`noOpfs`), and the storage line says what is used.
  await expect(page.locator('.durable-notice')).toBeVisible()
  await expect(page.locator('.durable-notice')).toContainText('cannot save your world')
  await expect(page.locator('.storage-line')).toHaveAttribute('data-durable', 'false')
  await expect(page.locator('.storage-line')).toContainText(/Storage: .+ of .+ used/)
  await expect(line).toBeHidden() // a local world has no link line

  // Link states (M29): each its own text; `online` shows nothing.
  const links: Array<[string, string | undefined, RegExp]> = [
    ['reconnecting', undefined, /reconnecting/],
    ['updating', undefined, /Updating/],
    ['superseded', undefined, /another tab/],
    ['rejected', 'BadKey', /not valid/],
    ['rejected', 'Full', /full/],
  ]
  for (const [state, reason, text] of links) {
    await page.evaluate(([s, r]) => window.__statusLink?.(s as string, r), [state, reason])
    await expect(line).toBeVisible()
    await expect(line).toHaveAttribute('data-state', state as string)
    await expect(line).toContainText(text)
  }
  await page.evaluate(() => window.__statusLink?.('online'))
  await expect(line).toBeHidden()

  // Desync (0013, M31b): flip one replica byte of a held chunk; the sweep reports it, the dev counter
  // shows it. Ticks, not time.
  await page.evaluate(() => window.__setCamera?.(0, 0, 32))
  await frame(8) // 50 ms each: the camera report goes out (paced) and the host subscribes the chunks
  await page.evaluate(() => window.__stepTick?.(8))
  expect(await page.evaluate(() => window.__corruptChunk?.(0, 0)), 'chunk (0,0) is held').toBe(0)
  const counter = page.locator('.desync-counter')
  for (let i = 0; i < 40 && !(await counter.isVisible()); i++) {
    await page.evaluate(() => window.__stepTick?.(8))
  }
  await expect(counter).toBeVisible()
  await expect(counter).toHaveAttribute('data-count', '1')
  await expect(counter).toContainText('chunk 0,0')

  // Resyncing (0005 Panic recovery): the client instance traps at its third frame and asks for the
  // full resync; the notice goes by itself (the injected scheduler), the link line returns to nothing.
  for (let i = 0; i < 30 && (await line.getAttribute('data-state')) !== 'resyncing'; i++) {
    await frame()
  }
  await expect(line).toHaveAttribute('data-state', 'resyncing')
  await expect(line).toContainText('Resyncing')
  await page.evaluate(() => window.__advanceClock?.(2000))
  await expect(line).toBeHidden()

  // rendererLost (0018 §8, M37b): the first loss recovers, a second within 10 s of the manual clock
  // does not. A prompt with one button; the reason has its own text.
  await page.evaluate(() => window.__loseDevice?.())
  await expect(page.locator('.renderer-lost')).toBeHidden()
  await page.evaluate(() => window.__advanceClock?.(1000))
  await page.evaluate(() => window.__loseDevice?.())
  const lost = page.locator('.renderer-lost')
  await expect(lost).toBeVisible()
  await expect(lost).toHaveAttribute('data-reason', 'repeated-loss')
  // `rendererLost` is not `onFatal` (0050 §3): the world is intact and the sim keeps ticking, so the
  // fatal screen stays away.
  await expect(page.locator('.engine-fatal')).toBeHidden()
  await expect(lost.locator('[data-reload]')).toHaveCount(1)
  await page.evaluate(() => window.__statusRendererLost?.('no-adapter'))
  await expect(lost).toHaveAttribute('data-reason', 'no-adapter')
  await expect(lost).toContainText('No graphics adapter')

  // Refused starts (M23, M24b): `world-busy` is text only; `save-incompatible` offers Export and
  // Delete (Delete asks twice).
  await page.evaluate(() => window.__showStartFailure?.('world-busy'))
  const busy = page.locator('.start-failure[data-code="world-busy"]')
  await expect(busy).toContainText('already open in another tab')
  await expect(busy.locator('button')).toHaveCount(0)
  await page.evaluate(() => window.__showStartFailure?.('save-incompatible'))
  const incompatible = page.locator('.start-failure[data-code="save-incompatible"]')
  await expect(incompatible).toContainText('different version')
  await incompatible.locator('[data-export-world]').click()
  await expect(incompatible.locator('.start-failure-note')).toHaveAttribute(
    'data-state',
    'exported',
  )
  await incompatible.locator('[data-delete-world]').click()
  expect((await page.evaluate(() => window.__startFailureOps?.()))?.deletes).toBe(0)
  await incompatible.locator('[data-delete-world]').click()
  await expect(incompatible.locator('.start-failure-note')).toHaveAttribute('data-state', 'deleted')
  expect(await page.evaluate(() => window.__startFailureOps?.())).toEqual({
    exports: 1,
    deletes: 1,
  })

  // onFatal (0005, 0015 §5): the second trap inside 10 s of the manual clock ends the engine: a screen
  // with the engine's message and one button.
  const fatal = page.locator('.engine-fatal')
  for (let i = 0; i < 30 && !(await fatal.isVisible()); i++) await frame()
  await expect(fatal).toBeVisible()
  await expect(fatal.locator('.engine-fatal-message')).toContainText('trapped twice within 10 s')
  await expect(fatal.locator('[data-reload]')).toHaveCount(1)
})
