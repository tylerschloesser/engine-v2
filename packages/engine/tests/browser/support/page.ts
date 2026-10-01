// The page contract every browser spec uses (docs/plan/03-browser-harness.md, Seams): navigate,
// assert cross-origin isolation, and fail the test on any page error or console error. A worker's
// own JS errors reach here through the page's `pageerror`/`console` events too (an unhandled
// rejection or exception inside a module worker surfaces the same way as on the page); the harness
// additionally wires `worker.onerror` itself (`src/test/harness.ts`) so a worker construction
// failure rejects the caller directly instead of only firing an event.
//
// `page.goto`'s `load` event is not a reliable signal that a page's top-level `await` chain (the
// fetch + `compileStreaming` + `instantiate` every page here does) has finished: measured under
// three parallel Playwright workers, the first tests to run sometimes read `window.__*` before the
// module script reached its last line. Every page's script therefore ends with
// `window.__pageReady = true`, and this is what `openPage` actually waits for.
import { expect, type Page } from '@playwright/test'

declare global {
  interface Window {
    __pageReady?: true
  }
}

const lossAllowed = new WeakSet<Page>()
const gpuErrorsAllowed = new WeakSet<Page>()

/** Opts one test out of "every browser test fails on `uncapturederror`" (0020 §6): only for a test
 * that provokes a validation error on purpose. */
export function allowGpuErrors(page: Page): void {
  gpuErrorsAllowed.add(page)
}

/** M37b (docs/decisions/0020-testing-strategy.md §6): opts one test out of "every browser test fails
 * on a device loss". Only a test that loses the device on purpose (`engine/test`'s `loseDevice`)
 * calls this; any other loss still turns the test red. Call before or after `openPage`. */
export function allowDeviceLoss(page: Page): void {
  lossAllowed.add(page)
}

export interface OpenPageOptions {
  /** docs/plan/24-recovery-and-migration.md: a page that deliberately traps a WASM instance (a real
   * panic recovery test) triggers the loader's own default `onPanic` (`console.error`, `loader.ts`)
   * on purpose -- this predicate, matched against `msg.text()`, is the one, narrow way to keep that
   * expected line from failing the test while every *unexpected* console error still does. Omitted
   * (the default, every other spec) keeps the strict "no console error at all" rule unchanged. */
  allowConsoleError?: (text: string) => boolean
}

export async function openPage(
  page: Page,
  path: string,
  opts: OpenPageOptions = {},
): Promise<void> {
  page.on('pageerror', (error) => {
    expect(error.message, `${path}: page error`).toBe('')
  })
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !opts.allowConsoleError?.(msg.text())) {
      expect(msg.text(), `${path}: console.error`).toBe('')
    }
  })

  page.on('console', (msg) => {
    if (
      msg.type() === 'warning' &&
      msg.text().startsWith('GPU device lost') &&
      !lossAllowed.has(page)
    ) {
      expect(msg.text(), `${path}: unexpected device loss (use allowDeviceLoss(page))`).toBe('')
    }
  })

  page.on('console', (msg) => {
    if (
      msg.type() === 'warning' &&
      msg.text().startsWith('GPU uncapturederror') &&
      !gpuErrorsAllowed.has(page)
    ) {
      expect(msg.text(), `${path}: uncapturederror (0020 §6)`).toBe('')
    }
  })

  await page.goto(path)
  await page.waitForFunction(() => window.__pageReady === true)
  const isolated = await page.evaluate(() => window.crossOriginIsolated)
  expect(isolated, `${path}: crossOriginIsolated`).toBe(true)
}
