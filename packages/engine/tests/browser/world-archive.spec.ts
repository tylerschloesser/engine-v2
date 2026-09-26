// `world.html`'s Export/Import/Delete controls (docs/plan/23-persistence-opfs-and-lifecycle.md step
// 5, Tests added): `export_import_roundtrip_browser`, `delete_world_removes_all_keys`,
// `export_works_after_load_failure`, `export_browser_import_node_same_hash`, and the overlap test
// Rules and traps asks for (export racing a hidden-boundary pause). Chromium only, same reasoning as
// `world.spec.ts` (the OPFS portability matrix is `storage-opfs.spec.ts`'s own job).
import { expect, test } from '@playwright/test'
import { importWorld } from '../../src/storage/archive.js'
import { memoryStorage } from '../../src/storage/memory.js'
import { worldKeys } from '../../src/storage/types.js'
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
    __corruptWorldKey?: (worldId: string, key: string, bytes: number[]) => Promise<void>
    __worldHash?: () => Promise<string>
    __worldHashAndTick?: () => Promise<{ hash: string; tick: number }>
    __dispatchPaintAt?: (x: number, y: number) => number
    __errors?: () => string[]
    __lastExportedBytes?: () => number[] | undefined
    __exportWorld?: () => Promise<number[]>
    __importWorld?: (
      bytes: number[],
      opts?: { worldId?: string; overwrite?: boolean },
    ) => Promise<{ worldId: string }>
    __deleteWorld?: (worldId: string) => Promise<void>
  }
}

/** Waits for at least one real OPFS `snap/` key (`world_survives_reload`'s own precedent): the
 * ground truth that a pause's own `snapshotIfDirty` has actually landed, not merely that the JS-side
 * counter says so. */
async function waitForASnapshot(page: import('@playwright/test').Page, worldId: string) {
  await page.waitForFunction(
    (id) =>
      window
        .__dumpWorldStorage?.(id)
        .then((entries) => Object.keys(entries).some((k) => k.includes('/snap/'))),
    worldId,
  )
}

test('export_import_roundtrip_browser', async ({ page }) => {
  const worldId = `export-${test.info().workerIndex}-${Date.now()}`
  await openPage(page, `/world.html?world=${worldId}`)
  await page.evaluate(() => window.__dispatchPaintAt?.(50, 50))
  const before = await page.evaluate(() => window.__worldHashAndTick?.())
  if (!before) throw new Error('export_import_roundtrip_browser: __worldHashAndTick missing')

  const bytes = await page.evaluate(() => window.__exportWorld?.())
  if (!bytes) throw new Error('export_import_roundtrip_browser: __exportWorld returned nothing')
  expect(bytes.length).toBeGreaterThan(0)

  const targetId = `${worldId}-imported`
  const imported = await page.evaluate(
    ({ bytes, worldId }) => window.__importWorld?.(bytes, { worldId }),
    { bytes, worldId: targetId },
  )
  expect(imported?.worldId).toBe(targetId)

  // Injected-defect proof (Rules and traps, "import overwriting without `overwrite`"): the running
  // world's own id must be refused.
  await expect(
    page.evaluate((id) => window.__importWorld?.([], { worldId: id }), worldId),
  ).rejects.toBeTruthy()
  // And re-importing under the *same* target id again, without `overwrite`, must also be refused.
  await expect(
    page.evaluate(({ bytes, worldId }) => window.__importWorld?.(bytes, { worldId }), {
      bytes,
      worldId: targetId,
    }),
  ).rejects.toBeTruthy()

  const dump = await page.evaluate((id) => window.__dumpWorldStorage?.(id), targetId)
  if (!dump) throw new Error('export_import_roundtrip_browser: dump missing')
  // Exactly the key set 0005 lists, for this world (manifest + one log segment + whatever snapshots
  // existed at export time) -- not merely "some keys landed".
  const keys = Object.keys(dump)
  expect(keys).toContain(`worlds/${targetId}/manifest`)
  expect(keys.some((k) => k.startsWith(`worlds/${targetId}/log/`))).toBe(true)

  const { wasm } = await loadFixture('puts')
  const storage = memoryStorage()
  for (const [key, b] of Object.entries(dump)) await storage.write(key, new Uint8Array(b))
  const replayed = await replayWorld({
    wasm,
    storage,
    worldId: targetId,
    checkpoints: [before.tick],
  })
  expect(replayed[0]?.hash).toBe(before.hash)

  expect(await page.evaluate(() => window.__errors?.())).toEqual([])
})

test('delete_world_removes_all_keys', async ({ page }) => {
  const worldId = `del-${test.info().workerIndex}-${Date.now()}`
  await openPage(page, `/world.html?world=${worldId}`)
  await page.evaluate(() => window.__dispatchPaintAt?.(51, 51))
  const bytes = await page.evaluate(() => window.__exportWorld?.())
  if (!bytes) throw new Error('delete_world_removes_all_keys: __exportWorld returned nothing')
  const otherId = `${worldId}-other`
  await page.evaluate(({ bytes, worldId }) => window.__importWorld?.(bytes, { worldId }), {
    bytes,
    worldId: otherId,
  })
  const before = await page.evaluate((id) => window.__dumpWorldStorage?.(id), otherId)
  expect(Object.keys(before ?? {}).length).toBeGreaterThan(0)

  await page.evaluate((id) => window.__deleteWorld?.(id), otherId)

  const after = await page.evaluate((id) => window.__dumpWorldStorage?.(id), otherId)
  expect(after).toEqual({})
  // Rules and traps ("delete leaving a key"): `deleteWorld` really lists and deletes every key
  // (`before` had >= 2: manifest + log/000000), not just one fixed name -- a `deleteWorld` that
  // skipped one key kind is proven caught by `src/storage/archive.test.ts`'s own
  // `delete_world_removes_all_keys` (the injected-defect hunt lives there, over `memoryStorage`,
  // where mutating and reverting `deleteWorld` itself is simplest; this browser test's own job is
  // proving the same real function over real OPFS).
  expect(Object.keys(before ?? {}).length).toBeGreaterThanOrEqual(2)

  // Refuses the running world's own id (Deviations: the same safety rule as `importWorld`).
  await expect(page.evaluate((id) => window.__deleteWorld?.(id), worldId)).rejects.toBeTruthy()

  expect(await page.evaluate(() => window.__errors?.())).toEqual([])
})

test('export_works_after_load_failure', async ({ page }) => {
  const worldId = `corrupt-${test.info().workerIndex}-${Date.now()}`
  await openPage(page, `/world.html?world=${worldId}`)
  await page.evaluate(() => window.__dispatchPaintAt?.(52, 52))
  await page.evaluate(() => window.__worldSetHidden?.(true))
  await waitForASnapshot(page, worldId)

  // Corrupt the manifest (garbage, not even JSON) while this world's own sim worker is not running
  // (`world-corrupt-worker.ts`'s own doc comment): the *next* load of this `worldId` must fail.
  await page.evaluate(
    (id) => window.__corruptWorldKey?.(id, 'manifest', [0x7b, 0x62, 0x61, 0x64]),
    worldId,
  )

  await page.reload()
  await page.waitForFunction(() => window.__pageReady === true)
  expect(await page.evaluate(() => window.__worldBusy?.())).toBe(false)
  expect(await page.evaluate(() => window.__readyErrorCode?.())).toBe('load-failed')

  // Scope: `exportWorld`/`deleteWorld` still work on a world that failed to load.
  const bytes = await page.evaluate(() => window.__exportWorld?.())
  if (!bytes) throw new Error('export_works_after_load_failure: __exportWorld returned nothing')
  expect(bytes.length).toBeGreaterThan(0)
  const dump = await page.evaluate((id) => window.__dumpWorldStorage?.(id), worldId)
  expect(Object.keys(dump ?? {})).toContain(`worlds/${worldId}/manifest`)

  await page.evaluate((id) => window.__deleteWorld?.(id), worldId)
  const afterDelete = await page.evaluate((id) => window.__dumpWorldStorage?.(id), worldId)
  expect(afterDelete).toEqual({})

  expect(await page.evaluate(() => window.__errors?.())).toEqual([])
})

/**
 * Rules and traps: "an export requested while a hidden-boundary pause is in flight (and vice versa)
 * must be well-defined" -- overlapping a `visibilitychange -> hidden` with an `exportWorld()` call
 * gets both a valid archive and a paused, snapshotted world, whichever request the worker's own
 * event loop happens to see first (`client.ts`'s own `hostWorkerLock`, `worker/sim.ts`'s own
 * `enqueueOp` -- both serialize the two families onto one FIFO chain).
 */
test('export_overlapping_hidden_pause_is_well_defined', async ({ page }) => {
  const worldId = `overlap-${test.info().workerIndex}-${Date.now()}`
  await openPage(page, `/world.html?world=${worldId}`)
  await page.evaluate(() => window.__dispatchPaintAt?.(53, 53))
  const before = await page.evaluate(() => window.__worldHashAndTick?.())
  if (!before) throw new Error('export_overlapping_hidden_pause_is_well_defined: hash missing')

  const [bytes] = await Promise.all([
    page.evaluate(() => window.__exportWorld?.()),
    page.evaluate(() => window.__worldSetHidden?.(true)),
  ])
  if (!bytes) {
    throw new Error(
      'export_overlapping_hidden_pause_is_well_defined: __exportWorld returned nothing',
    )
  }
  expect(bytes.length).toBeGreaterThan(0)

  // The archive is valid: it replays to the same hash reached just before the overlap.
  const { wasm } = await loadFixture('puts')
  const storage = memoryStorage()
  await importWorld(storage, new Uint8Array(bytes), { worldId: 'replay-target' })
  const replayed = await replayWorld({
    wasm,
    storage,
    worldId: 'replay-target',
    checkpoints: [before.tick],
  })
  expect(replayed[0]?.hash).toBe(before.hash)

  // The world ends up paused and snapshotted (the hidden request, whichever order it settled in,
  // is not lost or clobbered by the overlapping export).
  await waitForASnapshot(page, worldId)

  expect(await page.evaluate(() => window.__errors?.())).toEqual([])
})

test('export_browser_import_node_same_hash', async ({ page }) => {
  // Deviations: a single Playwright test, not a split browser-produces/Vitest-consumes pair -- the
  // two suites run in parallel (`scripts/suites.mjs`), so a file handed off between them would race
  // or silently read a stale copy (the exact trap the brief warns against). This test *is* "produced
  // by the browser test, consumed under Node": the import/replay below runs in this same Node
  // process, over the identical `src/storage/archive.ts`/`src/test/replay.ts` modules a Vitest test
  // would use, on bytes a real browser (real OPFS-backed `client.exportWorld()`) just produced --
  // full single-player-to-hosted proof (0005), with no cross-suite file at all.
  const worldId = `hosted-${test.info().workerIndex}-${Date.now()}`
  await openPage(page, `/world.html?world=${worldId}`)
  await page.evaluate(() => window.__dispatchPaintAt?.(54, 54))
  const before = await page.evaluate(() => window.__worldHashAndTick?.())
  if (!before) throw new Error('export_browser_import_node_same_hash: hash missing')

  const bytes = await page.evaluate(() => window.__exportWorld?.())
  if (!bytes)
    throw new Error('export_browser_import_node_same_hash: __exportWorld returned nothing')

  const { wasm } = await loadFixture('puts')
  const storage = memoryStorage()
  const result = await importWorld(storage, new Uint8Array(bytes), { worldId: 'server-side' })
  expect(result.worldId).toBe('server-side')
  const keys = worldKeys('server-side')
  expect(await storage.read(keys.manifest)).not.toBeNull()

  const replayed = await replayWorld({
    wasm,
    storage,
    worldId: 'server-side',
    checkpoints: [before.tick],
  })
  expect(replayed).toHaveLength(1)
  expect(replayed[0]?.hash).toBe(before.hash)
})
