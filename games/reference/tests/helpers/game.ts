// `tests/helpers/game.ts::openGame(page, opts)` (docs/plan/20-reference-game-v0.md Provides):
// the reference game's own page contract, mirroring `packages/engine/tests/browser/support/
// page.ts::openPage` (navigate, assert cross-origin isolation, fail the test on any page error or
// console error) -- duplicated in full rather than imported across the package boundary (this
// package depends only on `engine`, `reference_package_depends_only_on_engine`), waiting on the
// same `window.__pageReady` convention `src/main.ts` sets.
import { expect, type Page } from '@playwright/test'

declare global {
  interface Window {
    __pageReady?: true
  }
}

export type OpenGameOptions = {
  /** Default `/index.html`. */
  path?: string
}

export async function openGame(page: Page, opts: OpenGameOptions = {}): Promise<void> {
  const path = opts.path ?? '/index.html'
  page.on('pageerror', (error) => {
    expect(error.message, `${path}: page error`).toBe('')
  })
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      expect(msg.text(), `${path}: console.error`).toBe('')
    }
  })

  await page.goto(path)
  await page.waitForFunction(() => window.__pageReady === true)
  const isolated = await page.evaluate(() => window.crossOriginIsolated)
  expect(isolated, `${path}: crossOriginIsolated`).toBe(true)
}
