// Readable start-up errors (docs/decisions/0015-threads-memory-and-topology.md §3; docs/plan/
// 06b-workers-and-spawn.md, Tests added). `start.arena_config_rejected` only: `not_isolated_error`
// and `worker_blocked_error` need a page served without the engine's own COOP/COEP (0015 §3's own
// "the worker script response itself needs COEP"), which needs a dedicated header-free route this
// milestone did not build (Deviations records this as not done).
import { expect, test } from '@playwright/test'
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
    }) => void
    __clientReady?: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>
  }
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
