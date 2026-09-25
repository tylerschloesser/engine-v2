// A `test` fixture for any spec that touches OPFS (docs/plan/23-persistence-opfs-and-lifecycle.md
// step 1, Deviations): WebKit's OPFS only works under a real, on-disk browser profile
// (`browserType.launchPersistentContext`), not Playwright's default ephemeral `browser.newContext()`
// -- under the default context, `navigator.storage.getDirectory()` itself throws `UnknownError` in
// WebKit, on the main thread and inside a worker, before `move()`/`createSyncAccessHandle`/locks are
// ever reached. Chromium and Firefox work under the default context too, so using a persistent one
// for all three keeps this file's own code path the same across `playwright.config.ts`'s projects.
// Scoped to specs that `import` this file; every other spec's `context`/`page` fixtures (and their
// shared `browser` instance) are unaffected.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type BrowserContext, test as base, type Page } from '@playwright/test'

export const test = base.extend<{ opfsContext: BrowserContext; opfsPage: Page }>({
  opfsContext: async ({ playwright, browserName, baseURL }, use) => {
    const dir = await mkdtemp(join(tmpdir(), `opfs-${browserName}-`))
    const browserType = playwright[browserName]
    const context = await browserType.launchPersistentContext(dir, {
      headless: true,
      ...(baseURL ? { baseURL } : {}),
    })
    await use(context)
    await context.close()
    await rm(dir, { recursive: true, force: true })
  },
  opfsPage: async ({ opfsContext }, use) => {
    const page = await opfsContext.newPage()
    await use(page)
  },
})

export { expect } from '@playwright/test'
