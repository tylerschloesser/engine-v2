// `bench: a shipped build ignores ?bench=large-save @slow` (docs/plan/36-slow-tier-and-benchmarks.md
// step 6): the bench page and its HUD exist only in the bench build (`vite build --mode bench`,
// `__BENCH__`). The production `dist/` has no trace of it in any script, and the page it serves
// shows no HUD and exposes no `window.__bench` when asked for `?bench=large-save`.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { openGame } from '../helpers/game.js'

const DIST = fileURLToPath(new URL('../../dist/assets/', import.meta.url))

test('bench: a shipped build ignores ?bench=large-save @slow', async ({ page }) => {
  const scripts = readdirSync(DIST).filter((f) => f.endsWith('.js'))
  expect(scripts.length, 'dist/assets has scripts').toBeGreaterThan(0)
  for (const f of scripts) {
    const text = readFileSync(join(DIST, f), 'utf8')
    expect(text, `${f} carries the bench page`).not.toContain('large-save')
    expect(text, `${f} carries the bench HUD`).not.toContain('bench-hud')
  }

  await openGame(page, { path: '/index.html?bench=large-save' })
  expect(await page.locator('#bench-hud').count(), 'no HUD element').toBe(0)
  const bench = await page.evaluate(() => (window as unknown as { __bench?: unknown }).__bench)
  expect(bench, 'no window.__bench').toBeUndefined()
})
