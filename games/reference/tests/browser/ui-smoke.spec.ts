// `reference_ui_smoke_collect_and_inventory` (docs/plan/20b-reference-player-and-collect-ui.md
// steps 3-4, this cut's own short check -- Verification: "add at most a short check of your own if
// a step needs one"): a minimal end-to-end pass through the new DOM wiring (`game.ts`'s own
// `createCollectUi`/`createInventoryUi`), not the scripted `reference_collect_flow`/
// `reference_several_buttons`/`reference_pan_out_cancels`/`reference_new_player_spawns_on_land`
// this brief reserves for step 6's own implementer.
//
// Found live, worth keeping for step 5/6: `Ui.in_range` is read off `FrameView::world()`, the
// client's *own* replica (`client.rs`'s `ui()`) -- unlike `__dispatchStartCollect` (host-validated
// directly against the host's own authoritative world) or `__probeTile` (renders whatever the
// client has locally generated, which needs no host round trip for pristine terrain), a tile only
// becomes readable through the replica's `WorldRead` once the *host* has actually included it in a
// downlink frame, which requires at least one real sim tick to have been driven with
// `__stepTick` -- `__setCamera`/`__stepFrame` alone (this package's other stepped specs' own
// precedent, e.g. `depletion.spec.ts`'s presence-sample loop) never trigger that. A handful of
// `__stepTick` calls after the camera settles is enough.
import { expect, test } from '@playwright/test'
import { openGame } from '../helpers/game.js'

declare global {
  interface Window {
    __setCamera?: (x: number, y: number, tilesAcross: number) => Promise<void>
    __stepFrame?: (dtMs: number) => Promise<void>
    __stepTick?: (n: number) => Promise<void>
  }
}

// `content::collect_ticks` at 20 Hz = 40 ticks, `+ 1` for the host's own "tick T+1" queuing
// (`depletion.spec.ts`'s own precedent and reasoning).
const COLLECT_TICKS = 40 + 1

test('reference_ui_smoke_collect_and_inventory', async ({ page }) => {
  await openGame(page, { path: '/test.html' })

  // The iron landmark at `(0, 0)` (`tests/fixtures/landmarks.json`, `TEST_SEED`): settle the camera
  // and spring there (`in_range`/a presence sample both need it), then a few real sim ticks so the
  // host's own downlink actually reaches the client's replica (module doc comment, above).
  await page.evaluate(() => window.__setCamera?.(0, 0, 20))
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.__stepFrame?.(50))
  }
  await page.evaluate((n) => window.__stepTick?.(n), 5)
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.__stepFrame?.(50))
  }

  const button = page.locator('[data-collect-tile="0,0"]')
  await expect(button).toBeVisible({ timeout: 5_000 })

  await button.click()
  // A dispatched action sits in the client's own action ring until a `stepFrame` call flushes the
  // uplink (`depletion.spec.ts`'s own precedent) -- one before stepping ticks, so this collect is
  // admitted before the ticks meant to complete it run.
  await page.evaluate((dtMs) => window.__stepFrame?.(dtMs), 16)
  await page.evaluate((n) => window.__stepTick?.(n), 3)
  await page.evaluate(() => window.__stepFrame?.(16))
  await expect(button).toBeDisabled({ timeout: 5_000 })
  await expect(button).toHaveClass(/is-filling/, { timeout: 5_000 })

  await page.evaluate((n) => window.__stepTick?.(n), COLLECT_TICKS)
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.__stepFrame?.(50))
  }

  const inventory = page.locator('.inventory')
  await expect(inventory).toContainText('Iron: 1', { timeout: 5_000 })
  await expect(button).not.toBeDisabled({ timeout: 5_000 })
  await expect(button).not.toHaveClass(/is-filling/, { timeout: 5_000 })
})
