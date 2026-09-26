// `world.html`'s own tests (docs/plan/23-persistence-opfs-and-lifecycle.md steps 3-4): the sim
// worker's real OPFS-backed startup order (Web Lock -> OPFS probe -> `Persistence.open` -> tick
// loop), `WorldBusy`, `durable: false`, `client.onStorage`, `navigator.storage.persist()` (Planning
// decision 5), and the hidden/visible clean boundary. Chromium only (no `@engines`): the OPFS
// portability matrix itself is `storage-opfs.spec.ts`'s own job (step 2); this file's own job is the
// lifecycle wiring on top of it, which needs no second engine.
//
// `world_survives_reload` compares the resumed world's own hash against `replayWorld` run, in this
// spec file's own Node process, over a *copy* of the stored bytes pulled out of the browser's OPFS
// through `world-dump-worker.ts` (a test-only debug worker, `world.ts`'s own `__dumpWorldStorage`) --
// `exportWorld` is step 5's; this is a deliberate, documented stand-in (Deviations).
import { expect, test } from '@playwright/test'
import { memoryStorage } from '../../src/storage/memory.js'
import { replayWorld } from '../../src/test.js'
import { loadFixture } from '../support/fixtures.js'
import { openPage } from './support/page.js'

type StorageStatus = { durable: boolean; persisted: boolean; usage: number; quota: number }

declare global {
  interface Window {
    __worldBusy?: () => boolean
    __readyErrorCode?: () => string | undefined
    __storageStatuses?: () => StorageStatus[]
    __worldSetHidden?: (hidden: boolean | undefined) => void
    __dumpWorldStorage?: (worldId: string) => Promise<Record<string, number[]>>
    __worldHash?: () => Promise<string>
    __worldHashAndTick?: () => Promise<{ hash: string; tick: number }>
    __simTicksRun?: () => number
    __dispatchPaintAt?: (x: number, y: number) => number
    __hudText?: () => string
    __errors?: () => string[]
  }
}

test('second_tab_gets_world_busy', async ({ page, context }) => {
  const worldId = `busy-${test.info().workerIndex}-${Date.now()}`
  await openPage(page, `/world.html?world=${worldId}`)
  expect(await page.evaluate(() => window.__worldBusy?.())).toBe(false)

  const page2 = await context.newPage()
  await openPage(page2, `/world.html?world=${worldId}`)
  expect(await page2.evaluate(() => window.__worldBusy?.())).toBe(true)
  expect(await page2.evaluate(() => window.__readyErrorCode?.())).toBe('world-busy')
  await expect(page2.locator('#world-busy')).toBeVisible()
  expect(await page2.evaluate(() => window.__errors?.())).toEqual([])

  await page2.close()
})

test('no_opfs_falls_back_durable_false', async ({ page }) => {
  // `?noOpfs=1` (Deviations: not the brief's own suggested "OPFS stubbed out by an init script" --
  // measured that stubbing `navigator.storage.getDirectory` via `page.addInitScript` only reaches
  // the page's own `navigator`, not the sim worker's separate global scope's `navigator`, where
  // `opfsStorage()` actually calls it -- `world.ts`'s own `TestFlags.noOpfs` switch is deterministic
  // regardless).
  const worldId = `no-opfs-${test.info().workerIndex}-${Date.now()}`
  await openPage(page, `/world.html?world=${worldId}&noOpfs=1`)
  expect(await page.evaluate(() => window.__worldBusy?.())).toBe(false)

  const statuses = await page.evaluate(() => window.__storageStatuses?.())
  expect(statuses?.length ?? 0).toBeGreaterThan(0)
  expect(statuses?.[0]?.durable).toBe(false)
})

test('storage_status_reports_estimate', async ({ page }) => {
  await page.addInitScript(() => {
    const storage = (navigator as unknown as { storage: StorageManager }).storage
    const original = storage.persist.bind(storage)
    ;(window as unknown as { __persistCalls: number }).__persistCalls = 0
    storage.persist = () => {
      ;(window as unknown as { __persistCalls: number }).__persistCalls++
      return original()
    }
  })
  const worldId = `status-${test.info().workerIndex}-${Date.now()}`
  await openPage(page, `/world.html?world=${worldId}`)

  const first = await page.evaluate(() => window.__storageStatuses?.()[0])
  expect(first).toBeTruthy()
  expect(typeof first?.durable).toBe('boolean')
  expect(typeof first?.persisted).toBe('boolean')
  expect(typeof first?.usage).toBe('number')
  expect(typeof first?.quota).toBe('number')

  // Not called before the gesture (Planning decision 5).
  expect(
    await page.evaluate(() => (window as unknown as { __persistCalls: number }).__persistCalls),
  ).toBe(0)

  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown')))
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __persistCalls: number }).__persistCalls),
    )
    .toBe(1)

  // A second gesture must not call it again.
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown')))
  await page.waitForTimeout(200)
  expect(
    await page.evaluate(() => (window as unknown as { __persistCalls: number }).__persistCalls),
  ).toBe(1)

  // A reopened world (reload, same worldId) never calls `persist()` even after a fresh gesture.
  // A clean pause first (Deviations, `world_survives_reload`'s own comment): the manifest's own
  // write goes through OPFS's async scratch-rename, with no guaranteed time to land before a real
  // `pagehide` tear-down -- pausing first (awaited via the storage ack) makes the reload
  // deterministically see the same, already-durable world instead of racing that rename.
  await page.evaluate(() => window.__worldSetHidden?.(true))
  await page.waitForFunction(
    (id) =>
      window
        .__dumpWorldStorage?.(id)
        .then((entries) => Object.keys(entries).some((k) => k.includes('/snap/'))),
    worldId,
  )
  await page.reload()
  await page.waitForFunction(() => window.__pageReady === true)
  expect(await page.evaluate(() => window.__worldBusy?.())).toBe(false)
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown')))
  await page.waitForTimeout(300)
  expect(
    await page.evaluate(() => (window as unknown as { __persistCalls: number }).__persistCalls),
  ).toBe(0)
})

test('hidden_pauses_and_snapshots', async ({ page }) => {
  const worldId = `hidden-${test.info().workerIndex}-${Date.now()}`
  await openPage(page, `/world.html?world=${worldId}`)

  // Dirty the world (Authority::write, `Paint`) so the pause's own `snapshotIfDirty` has something
  // real to snapshot -- without this the assertion below would pass vacuously on a clean world that
  // never snapshots at all. `(50, 50)`, not `(0, 0)`: `fx-puts`'s own tick rule already writes one
  // of 8 fixed tiles *near the origin* once a second, independent of any action
  // (`vertical-slice.spec.ts`'s own "probe a tile the tick rule never touches" precedent) -- Paint
  // at a WALK tile would be indistinguishable from what ticking alone already does.
  await page.evaluate(() => window.__dispatchPaintAt?.(50, 50))
  await expect.poll(() => page.evaluate(() => window.__simTicksRun?.() ?? 0)).toBeGreaterThan(0)

  const beforeDump = await page.evaluate((id) => window.__dumpWorldStorage?.(id), worldId)
  const snapKeysBefore = Object.keys(beforeDump ?? {}).filter((k) => k.includes('/snap/'))

  await page.evaluate(() => window.__worldSetHidden?.(true))
  // A quick hidden -> visible -> hidden sequence (Rules and traps): must not interleave two pauses
  // or resume before the first one settles.
  await page.evaluate(() => window.__worldSetHidden?.(false))
  await page.evaluate(() => window.__worldSetHidden?.(true))

  await expect
    .poll(async () => {
      const dump = await page.evaluate((id) => window.__dumpWorldStorage?.(id), worldId)
      return Object.keys(dump ?? {}).filter((k) => k.includes('/snap/')).length
    })
    .toBeGreaterThan(snapKeysBefore.length)

  const ticksWhileHidden = await page.evaluate(() => window.__simTicksRun?.() ?? -1)
  await page.waitForTimeout(300)
  expect(await page.evaluate(() => window.__simTicksRun?.() ?? -1)).toBe(ticksWhileHidden)

  await page.evaluate(() => window.__worldSetHidden?.(false))
  await expect
    .poll(() => page.evaluate(() => window.__simTicksRun?.() ?? 0))
    .toBeGreaterThan(ticksWhileHidden)

  expect(await page.evaluate(() => window.__errors?.())).toEqual([])
})

test('world_survives_reload', async ({ page }) => {
  const worldId = `reload-${test.info().workerIndex}-${Date.now()}`
  await openPage(page, `/world.html?world=${worldId}`)

  // `(50, 50)`, not `(0, 0)`: `fx-puts`'s own tick rule already writes one of 8 fixed tiles *near
  // the origin* once a second, independent of any action (`vertical-slice.spec.ts`'s own "probe a
  // tile the tick rule never touches" precedent).
  await page.evaluate(() => window.__dispatchPaintAt?.(50, 50))
  await expect.poll(() => page.evaluate(() => window.__simTicksRun?.() ?? 0)).toBeGreaterThan(3)
  const beforeReload = await page.evaluate(() => window.__worldHashAndTick?.())
  if (!beforeReload) throw new Error('world_survives_reload: __worldHashAndTick missing')

  // A clean hidden-boundary pause first (Deviations): `pagehide`'s own async `SimHost.pause()`/
  // `flush()` has no guaranteed time to finish before a real browser discards the page (no
  // `event.waitUntil()`-style extension exists for `pagehide`) -- 0005's crash recovery is what
  // covers an unclean stop instead (M22b), not this test's own job. A real hidden->reload sequence
  // (backgrounding a tab before it closes, the ordinary case) is what this test proves durable:
  // pause the world explicitly and await its own completion ack before reloading.
  await page.evaluate(() => window.__worldSetHidden?.(true))
  await page.waitForFunction(
    (id) =>
      window
        .__dumpWorldStorage?.(id)
        .then((entries) => Object.keys(entries).some((k) => k.includes('/snap/'))),
    worldId,
  )

  await page.reload()
  await page.waitForFunction(() => window.__pageReady === true)
  expect(await page.evaluate(() => window.__worldBusy?.())).toBe(false)

  const resumed = await page.evaluate(() => window.__worldHashAndTick?.())
  if (!resumed) throw new Error('world_survives_reload: __worldHashAndTick missing')
  // The load-bearing check: a reload that silently created a fresh world instead of loading the
  // stored one restarts `ticksRun` near 0, which is *less* than the tick already reached before
  // reload (> 3) -- a fresh world could never legitimately report a tick this high the instant it
  // starts. (Comparing hashes alone is not enough here: a fresh-vs-loaded pair can coincide on
  // hash at a small, shared tick count, measured while developing this test.)
  expect(resumed.tick).toBeGreaterThanOrEqual(beforeReload.tick)

  const dump = await page.evaluate((id) => window.__dumpWorldStorage?.(id), worldId)
  if (!dump) throw new Error('world_survives_reload: __dumpWorldStorage returned nothing')

  const storage = memoryStorage()
  for (const [key, bytes] of Object.entries(dump)) {
    await storage.write(key, new Uint8Array(bytes))
  }
  const { wasm } = await loadFixture('puts')
  const replayed = await replayWorld({ wasm, storage, worldId, checkpoints: [resumed.tick] })
  expect(replayed).toHaveLength(1)
  expect(replayed[0]?.hash).toBe(resumed.hash)

  expect(await page.evaluate(() => window.__errors?.())).toEqual([])
})
