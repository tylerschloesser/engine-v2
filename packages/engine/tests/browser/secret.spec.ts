// `secret/persists-across-reload` (M28, Tests added): a real
// single-player page (`connected.html`, `host.connect: true`) mints a device secret through
// `loadOrMintSecret()` (`src/client/secret.ts`) on its very first load and keeps it in
// `localStorage` under `engine.playerSecret`, one per origin (0013 Identity) -- a page reload must
// see the *same* secret, not mint a fresh one.
import { expect, test } from '@playwright/test'
import { openPage } from './support/page.js'

const SECRET_KEY = 'engine.playerSecret'

test('secret: persists across reload', async ({ page }) => {
  await openPage(page, '/connected.html')

  const first = await page.evaluate((key) => localStorage.getItem(key), SECRET_KEY)
  expect(first).not.toBeNull()
  expect(first).toMatch(/^[0-9a-f]{32}$/) // 16 bytes, lowercase hex (`loadOrMintSecret`'s own shape)

  await page.reload()
  await page.waitForFunction(() => window.__pageReady === true)

  const second = await page.evaluate((key) => localStorage.getItem(key), SECRET_KEY)
  expect(second).toBe(first)
})
