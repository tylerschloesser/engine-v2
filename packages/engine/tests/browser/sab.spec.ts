// SPSC ring, proven cross-thread in a real browser, both directions (docs/plan/06-sab-primitives-
// and-workers.md, Tests added; the spike measured worker -> main only, docs/decisions/0015 §2).
// `@engines` also runs this in WebKit and Firefox.
import { expect, test } from '@playwright/test'
import { openPage } from './support/page.js'

declare global {
  interface Window {
    __sabRing?: {
      seqErrorsToWorker: number
      seqErrorsFromWorker: number
      dropsToWorker: number
      dropsFromWorker: number
      receivedToWorker: number
      receivedFromWorker: number
      count: number
    }
  }
}

test('sab.ring_both_directions @engines', async ({ page }) => {
  await openPage(page, '/sab.html')
  const result = await page.evaluate(() => window.__sabRing)
  if (!result) throw new Error('window.__sabRing missing')

  expect(result.receivedToWorker).toBe(result.count)
  expect(result.receivedFromWorker).toBe(result.count)
  expect(result.seqErrorsToWorker).toBe(0)
  expect(result.seqErrorsFromWorker).toBe(0)
  expect(result.dropsToWorker).toBe(0)
  expect(result.dropsFromWorker).toBe(0)
})
