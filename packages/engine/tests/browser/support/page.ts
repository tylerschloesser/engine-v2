// The page contract every browser spec uses (docs/plan/03-browser-harness.md, Seams): navigate,
// assert cross-origin isolation, and fail the test on any page error or console error. A worker's
// own JS errors reach here through the page's `pageerror`/`console` events too (an unhandled
// rejection or exception inside a module worker surfaces the same way as on the page); the harness
// additionally wires `worker.onerror` itself (`src/test/harness.ts`) so a worker construction
// failure rejects the caller directly instead of only firing an event.
import { expect, type Page } from '@playwright/test'

export async function openPage(page: Page, path: string): Promise<void> {
  page.on('pageerror', (error) => {
    expect(error.message, `${path}: page error`).toBe('')
  })
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      expect(msg.text(), `${path}: console.error`).toBe('')
    }
  })

  await page.goto(path)
  const isolated = await page.evaluate(() => window.crossOriginIsolated)
  expect(isolated, `${path}: crossOriginIsolated`).toBe(true)
}
