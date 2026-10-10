// `vite preview` answers a revalidation with a bare 304 that lacked COOP/COEP; WebKit then refused the worker
// script of a page it loaded a second time ("Worker load was blocked by Cross-Origin-Embedder-Policy"; found
// by `walk-auto` on `worldgen-bench.html`, reproduced by a plain `page.reload()` with no agent at all).
// The browser project's own `webServer` is a plain `vite preview` of the fixture app, no `--walk`: this is
// what `pnpm device:serve` serves a phone. `preview-headers.test.ts` (`netcode`) covers both apps' headers.
import { expect, test } from '@playwright/test'
import { openPage } from './support/page.js'

declare global {
  interface Window {
    __worldgenBench?: { pass: boolean; medianMs: number }
  }
}

test('preview-revalidation: a page loaded a second time is still cross-origin isolated and its worker runs @slow @webkit-gpu', async ({
  page,
}) => {
  await openPage(page, '/worldgen-bench.html')
  const first = await page.evaluate(() => window.__worldgenBench?.pass)
  expect(first).toBe(true)
  for (let load = 2; load <= 3; load++) {
    await page.reload()
    await page.waitForFunction(() => window.__pageReady === true, undefined, { timeout: 30_000 })
    expect(await page.evaluate(() => window.crossOriginIsolated), `load ${load}`).toBe(true)
    // The page's worker ran (a blocked worker script would leave `__pageReady` unset and throw above).
    expect(await page.evaluate(() => window.__worldgenBench?.pass), `load ${load}`).toBe(true)
  }
})
