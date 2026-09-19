// The cross-engine golden hash (docs/decisions/0002 §3 "Cross-engine golden hashes"; 0020 §5, §6):
// the same scenario, same driver (`tests/support/scenario.ts`) as the native, Node and Bun legs,
// this time run from a worker in Chromium, WebKit and Firefox. `@engines` runs it in all three
// (Planning decisions, "Browsers and projects"); it needs no GPU, so headless Firefox and WebKit's
// JavaScriptCore both qualify (0020 §6).
import { expect, test } from '@playwright/test'
import { readGolden } from '../support/fixtures.js'
import { diffCheckpoints, type Golden } from '../support/scenario.js'
import { openPage } from './support/page.js'

declare global {
  interface Window {
    __determinism?: { checkpoints: string[]; userAgent: string; crossOriginIsolated: boolean }
  }
}

test('determinism: golden reproduced in the browser @engines', async ({ page }) => {
  // Read in Node, not trusted from the page (Tests added): the page's own bundled copy of
  // `golden.json` is for the human-facing PASS/FAIL banner only.
  const golden = readGolden<Golden>('hash', 'golden.json')
  expect(golden.checkpoints.length).toBeGreaterThanOrEqual(10)

  await openPage(page, '/determinism.html')
  const result = await page.evaluate(() => window.__determinism)
  if (!result) throw new Error('window.__determinism missing')

  // The first divergent checkpoint, if any, is the whole point of the message on failure.
  expect(diffCheckpoints(result.checkpoints, golden.checkpoints)).toBeNull()
  expect(result.crossOriginIsolated).toBe(true)
  expect(result.userAgent.length).toBeGreaterThan(0)
})
