// docs/plan/23-persistence-opfs-and-lifecycle.md step 2, Tests added: `storage_conformance_opfs`
// (also WebKit, Firefox -- `@engines`, `pnpm test:slow` for the latter two, `playwright.config.ts`'s
// own convention). Uses `./support/opfs-context.ts`'s persistent-context `test`/`opfsPage` (step 1,
// Deviations: WebKit's OPFS needs one), not the default `page` fixture every other spec here uses.

import { expect, test } from './support/opfs-context.js'
import { openPage } from './support/page.js'

interface StorageOpfsResult {
  conformance: string[] | { error: string }
  pendingAsyncHook: Record<string, boolean> | { error: string }
  flushWaitsForInFlightRename: Record<string, boolean> | { error: string }
}

test('storage_conformance_opfs @engines', async ({ opfsPage }) => {
  await openPage(opfsPage, '/storage-opfs.html')
  const result = await opfsPage.evaluate(
    () => (window as unknown as { __storageOpfs: StorageOpfsResult }).__storageOpfs,
  )

  expect(result.conformance).toEqual([
    'write_then_read',
    'read_missing_key_is_null',
    'append_accumulates_in_call_order',
    'write_after_append_then_append_lands_after',
    'write_after_append_survives_sync_and_flush',
    'delete_removes_the_key',
    'list_returns_matching_keys_sorted',
    'sync_never_throws_on_an_unknown_key',
    'flush_resolves',
  ])

  // Seams for step 3 ("test it at the adapter level"): `OpfsStorage.pendingAsync`/`scratchReady`/
  // `snapshotDeferred`, exercised directly against the adapter (not yet wired into the sim worker).
  expect(result.pendingAsyncHook).toEqual({
    scratchReadyAfterOpen: true,
    pendingAsyncNullBeforeAnyWrite: true,
    writeReturnsVoidOnFastPath: true,
    scratchNotReadyRightAfterFastWrite: true,
    readsOwnWriteBeforeRenameLands: true,
    secondWriteReturnsPromiseOnSlowPath: true,
    slowPathWriteReadableImmediately: true,
    snapshotDeferredIsWritable: true,
    pendingAsyncNonNullAfterFastWrite: true,
    pendingAsyncClearsOnRead: true,
    scratchReadyAfterDrain: true,
    readsSameValueAfterRename: true,
  })

  // Gate fix (docs/plan/23-persistence-opfs-and-lifecycle.md, "Open gate failures" 1): `flush()` must
  // wait for a rename `pendingAsync()` already handed out and running elsewhere, not just one still
  // sitting untaken in the slot.
  expect(result.flushWaitsForInFlightRename).toEqual({
    writeReturnsVoidWhileScratchOpen: true,
    pendingAsyncNonNullAfterWrite: true,
    flushNotResolvedWhileRenameHeld: true,
    flushResolvedAfterRenameReleased: true,
    snapshotKeyReadableAfterFlush: true,
  })
})
