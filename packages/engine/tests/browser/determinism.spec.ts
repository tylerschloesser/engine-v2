// The cross-engine golden hash (docs/decisions/0002 §3 "Cross-engine golden hashes"; 0020 §5, §6):
// the same scenario, same driver (`tests/support/scenario.ts`) as the native, Node and Bun legs,
// this time run from a worker in Chromium, WebKit and Firefox, for every fixture `determinism.html`
// lists (`hash`, `worldgen`, docs/plan/08-worldgen-and-gen-worker.md). `@engines` runs it in all
// three (Planning decisions, "Browsers and projects"); it needs no GPU, so headless Firefox and
// WebKit's JavaScriptCore both qualify (0020 §6).
import { expect, test } from '@playwright/test'
import { readGolden } from '../support/fixtures.js'
import { diffCheckpoints, type Golden } from '../support/scenario.js'
import { openPage } from './support/page.js'

declare global {
  interface Window {
    __determinism?: {
      fixtures: Record<string, { checkpoints: string[]; pass: boolean }>
      userAgent: string
      crossOriginIsolated: boolean
    }
  }
}

test('determinism: golden reproduced in the browser @engines', async ({ page }) => {
  // Read in Node, not trusted from the page (Tests added): the page's own bundled copies of
  // `golden.json` are for the human-facing PASS/FAIL banner only.
  const goldens = {
    hash: readGolden<Golden>('hash', 'golden.json'),
    worldgen: readGolden<Golden>('worldgen', 'golden.json'),
  }
  for (const golden of Object.values(goldens)) {
    expect(golden.checkpoints.length).toBeGreaterThanOrEqual(1)
  }

  await openPage(page, '/determinism.html')
  const result = await page.evaluate(() => window.__determinism)
  if (!result) throw new Error('window.__determinism missing')

  for (const [name, golden] of Object.entries(goldens)) {
    const fixture = result.fixtures[name]
    if (!fixture) throw new Error(`window.__determinism.fixtures has no entry for ${name}`)
    // The first divergent checkpoint, if any, is the whole point of the message on failure.
    expect(diffCheckpoints(fixture.checkpoints, golden.checkpoints), name).toBeNull()
  }
  expect(result.crossOriginIsolated).toBe(true)
  expect(result.userAgent.length).toBeGreaterThan(0)
})
