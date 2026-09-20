// Readable start-up errors (docs/decisions/0015-threads-memory-and-topology.md §3; docs/plan/
// 06b-workers-and-spawn.md, Tests added). `not_isolated_error`/`worker_blocked_error` navigate to
// routes `fixturesPlugin()` adds under `tests/browser/pages/` (Deviations: `/__no-isolation__/*`
// serves a built page with no COOP/COEP at all; `/__no-coep-worker__.js` serves the built worker
// script with COOP but no COEP), since `vite preview`'s normal routes always carry both (0015 §3).
import { expect, type Page, test } from '@playwright/test'
import { openPage } from './support/page.js'

// `topology.ts` (its own compiled program) declares the same augmentation; kept identical to
// `workers.spec.ts`'s so `tsc` type-checks both against one shape.
declare global {
  interface Window {
    __createClient?: (opts?: {
      host?: { kind: 'local'; world: { game: unknown } } | { kind: 'remote'; url: string }
      arenas?: { sim?: number; client?: number; gen?: number }
      genWorkers?: number
      test?: { game?: unknown; flags?: { postModule?: boolean } }
      createWorker?: () => Worker
    }) => void
    __clientReady?: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>
  }
}

/** `openPage`'s own console-error/pageerror assertions do not fit here: `not_isolated_error`'s page
 * is deliberately not cross-origin isolated (its own `crossOriginIsolated` assertion would fail
 * immediately) and `worker_blocked_error`'s blocked worker script reports through the same channels
 * `EngineStartError` already surfaces as a rejection, not a bare page error. Bare navigation plus
 * the `__pageReady` wait (`support/page.ts`'s own reasoning: `load` does not wait out the module's
 * top-level `await` chain) is what is left. */
async function openWithoutIsolationChecks(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await page.waitForFunction(() => window.__pageReady === true)
}

test('start.arena_config_rejected', async ({ page }) => {
  await openPage(page, '/topology.html')
  // Comfortably past the ~224 MiB left after the ~8 MiB SAB share and the 20 MiB GPU share are
  // taken out of the 256 MiB whole-tab target (0015 §5).
  const bigArena = 250 * 1024 * 1024
  await page.evaluate(
    (bytes) =>
      window.__createClient?.({
        genWorkers: 1,
        arenas: { sim: bytes, client: bytes, gen: bytes },
      }),
    bigArena,
  )
  const r = await page.evaluate(() => window.__clientReady?.())
  expect(r?.ok).toBe(false)
  expect(r && !r.ok ? r.code : undefined).toBe('arena-config')
})

test('start.not_isolated_error', async ({ page }) => {
  // The exact built `topology.html`, served with no COOP/COEP at all (`fixturesPlugin()`'s
  // `/__no-isolation__/` route, Deviations): `crossOriginIsolated` reads `false` on this document
  // regardless of what its sub-resources (`/assets/*.js`, the wasm) carry, since that is decided by
  // the top document's own response alone (0015 §3).
  await openWithoutIsolationChecks(page, '/__no-isolation__/topology.html')
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(false)

  await page.evaluate(() => window.__createClient?.({ genWorkers: 1 }))
  const r = await page.evaluate(() => window.__clientReady?.())
  expect(r?.ok).toBe(false)
  expect(r && !r.ok ? r.code : undefined).toBe('not-isolated')
  // Readable (0015 §3): not empty, and names the fix.
  expect(r && !r.ok ? r.message : '').toMatch(/checkSupport/)
})

test('start.worker_blocked_error', async ({ page }) => {
  // The normal, fully-isolated page (pattern A's own worker is unused here): pattern B
  // (`ClientOptions.createWorker`) points every spawned worker at `/__no-coep-worker__.js`
  // (Deviations) instead, the same built `worker-auto-*.js` chunk served with COOP but no COEP.
  await openWithoutIsolationChecks(page, '/topology.html')
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true)

  await page.evaluate(() =>
    window.__createClient?.({
      genWorkers: 1,
      createWorker: () => new Worker('/__no-coep-worker__.js', { type: 'module' }),
    }),
  )
  const r = await page.evaluate(() => window.__clientReady?.())
  expect(r?.ok).toBe(false)
  expect(r && !r.ok ? r.code : undefined).toBe('worker-blocked')
  expect(r && !r.ok ? r.message : '').toMatch(/COEP/)
})
