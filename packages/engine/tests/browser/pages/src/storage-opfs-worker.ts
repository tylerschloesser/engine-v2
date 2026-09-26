// `storage-opfs.html`'s own worker (docs/plan/23-persistence-opfs-and-lifecycle.md step 2, Tests
// added: `storage_conformance_opfs`): the OPFS adapter (0015 "sim worker: OPFS handles") only runs
// inside a dedicated Worker in every browser this repo probed (step 1, Deviations), so the
// conformance run and the pending-async hook test both happen here, posted back as one result.
import { runStorageConformance } from '../../../../src/storage/conformance.ts'
import { type OpfsStorage, opfsStorage } from '../../../../src/storage/opfs.ts'
import type { Storage } from '../../../../src/storage/types.ts'

type Result = {
  conformance: string[] | { error: string }
  pendingAsyncHook: Record<string, boolean> | { error: string }
  flushWaitsForInFlightRename: Record<string, boolean> | { error: string }
}

/** Playwright WebKit's OPFS is not isolated per `launchPersistentContext` profile directory --
 * measured (docs/plan/23-persistence-opfs-and-lifecycle.md step 2, Deviations): a bare-key write
 * from one test run was still readable from a brand-new temp profile in a wholly separate process.
 * Chromium and Firefox do not have this problem, but wiping unconditionally keeps this page's own
 * result independent of run history on every browser, not just the one that needs it. Real
 * production code never does this: only a test page, and only before it starts using OPFS at all. */
async function wipeOpfsRoot(): Promise<void> {
  const root = await navigator.storage.getDirectory()
  const names: string[] = []
  for await (const name of root.keys()) names.push(name)
  for (const name of names) await root.removeEntry(name, { recursive: true }).catch(() => {})
}

async function runConformance(): Promise<string[]> {
  // `runStorageConformance`'s own `make: () => Storage` is synchronous and expects a fresh, isolated
  // store per call (the same way `memoryStorage()` gives one) -- but `opfsStorage()` is async, and a
  // *shared* worldId across instances would deadlock the second instance's own `.scratch` open (an
  // OPFS sync access handle is exclusive; the first instance's handle from its own `write()` call
  // stays open until that instance's `flush()` runs, which this helper never calls). Prebuilding one
  // instance per prefix, each its own worldId, sidesteps both problems. `conformance.ts` calls
  // `make()` exactly 8 times today; 10 is a small buffer.
  const PREBUILT = 10
  const instances: Storage[] = []
  for (let i = 0; i < PREBUILT; i++) {
    instances.push(await opfsStorage(`conformance-${i}`))
  }
  let idx = 0
  return runStorageConformance(() => {
    const s = instances[idx++]
    if (!s) throw new Error('storage-opfs-worker: ran out of prebuilt instances')
    return s
  })
}

async function runPendingAsyncHook(): Promise<Record<string, boolean>> {
  const enc = new TextEncoder()
  const s: OpfsStorage = await opfsStorage('pending-async-hook')
  const out: Record<string, boolean> = {}

  out.scratchReadyAfterOpen = s.scratchReady()
  out.pendingAsyncNullBeforeAnyWrite = s.pendingAsync() === null

  const bytes1 = enc.encode('first')
  const ret1 = s.write('k1', bytes1)
  out.writeReturnsVoidOnFastPath = ret1 === undefined
  out.scratchNotReadyRightAfterFastWrite = !s.scratchReady()

  const readBeforeDrain = await s.read('k1')
  out.readsOwnWriteBeforeRenameLands =
    readBeforeDrain !== null && new TextDecoder().decode(readBeforeDrain) === 'first'

  // Grab (and clear) the queued continuation *before* the second write below, which would otherwise
  // drain it inline itself (`#writeViaFreshHandle`'s own same-slot chaining, Planning decision 2:
  // "at most one at a time") -- this is what lets this test observe the hook's own state directly,
  // one `write()` at a time, rather than an internal implementation detail of a second write.
  const fn = s.pendingAsync()
  out.pendingAsyncNonNullAfterFastWrite = fn !== null
  out.pendingAsyncClearsOnRead = s.pendingAsync() === null

  // A second `write()` (unrelated key), with the slot now empty, takes the slow path (Seams):
  // returns a real Promise, not `undefined`, and does not itself try to reopen the one `.scratch`
  // file (avoiding a lock race with the first write's own, still-open, not-yet-drained handle).
  const bytes2 = enc.encode('second')
  const ret2 = s.write('k2', bytes2)
  out.secondWriteReturnsPromiseOnSlowPath = ret2 instanceof Promise
  if (ret2 instanceof Promise) await ret2
  const readK2 = await s.read('k2')
  out.slowPathWriteReadableImmediately =
    readK2 !== null && new TextDecoder().decode(readK2) === 'second'

  s.snapshotDeferred++
  out.snapshotDeferredIsWritable = s.snapshotDeferred === 1

  // The sim worker's own future hook (step 3, not wired yet): run the saved continuation through
  // whatever it would hand `shell.runAsync` -- here, directly.
  if (fn) await fn()
  out.scratchReadyAfterDrain = s.scratchReady()

  const readAfterDrain = await s.read('k1')
  out.readsSameValueAfterRename =
    readAfterDrain !== null && new TextDecoder().decode(readAfterDrain) === 'first'

  await s.flush()
  return out
}

/**
 * Gate fix (docs/plan/23-persistence-opfs-and-lifecycle.md, "Open gate failures" 1, the real defect):
 * `OpfsStorageAdapter.pendingAsync()` is a *take* -- `worker/sim.ts`'s body() hands the taken closure
 * to `shell.runAsync` and moves on, without itself awaiting it. The old `flush()` called
 * `pendingAsync()` a second time here, saw `null` (already taken), and resolved immediately while the
 * rename it should have waited for was still running elsewhere -- so a `sim-pause`'s own `storage` ack
 * (Planning decision 5, gated on `persistence.flush()` -> `storage.flush()`) could fire before the
 * rename was durable. Reproduced directly at the adapter level: `move()` is held open by a gate this
 * test controls, `pendingAsync()`'s own closure is taken and started *without being awaited here*
 * (the exact "take and forget" shape `shell.runAsync` gives it), and `flush()` is raced against the
 * still-open gate.
 */
async function runFlushWaitsForInFlightRename(): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {}
  const s: OpfsStorage = await opfsStorage('flush-inflight-rename')
  const enc = new TextEncoder()

  const proto = FileSystemFileHandle.prototype
  const originalMove = proto.move
  let releaseMove: () => void = () => {}
  const moveGate = new Promise<void>((resolve) => {
    releaseMove = resolve
  })
  proto.move = async function (
    this: FileSystemFileHandle,
    dir: FileSystemDirectoryHandle,
    name: string,
  ): Promise<void> {
    await moveGate
    return originalMove.call(this, dir, name)
  }

  try {
    const ret = s.write('k1', enc.encode('first'))
    out.writeReturnsVoidWhileScratchOpen = ret === undefined

    const fn = s.pendingAsync()
    out.pendingAsyncNonNullAfterWrite = fn !== null
    // Deliberately not awaited here -- `shell.runAsync` in production never awaits it either; the
    // bug this proves against is exactly a caller (`flush()`) that also does not wait for *this*.
    const inFlight = fn ? fn() : Promise.resolve()

    let flushResolved = false
    const flushPromise = s.flush().then(() => {
      flushResolved = true
    })

    // Several microtask turns: with the old take-and-forget `flush()`, nothing keeps it open and it
    // would already have resolved by now.
    for (let i = 0; i < 5; i++) await Promise.resolve()
    out.flushNotResolvedWhileRenameHeld = !flushResolved

    releaseMove()
    await inFlight
    await flushPromise
    out.flushResolvedAfterRenameReleased = flushResolved

    const read = await s.read('k1')
    out.snapshotKeyReadableAfterFlush = read !== null && new TextDecoder().decode(read) === 'first'
  } finally {
    proto.move = originalMove
  }

  return out
}

const result: Result = { conformance: [], pendingAsyncHook: {}, flushWaitsForInFlightRename: {} }
await wipeOpfsRoot()
try {
  result.conformance = await runConformance()
} catch (e) {
  result.conformance = { error: String(e) }
}
try {
  result.pendingAsyncHook = await runPendingAsyncHook()
} catch (e) {
  result.pendingAsyncHook = { error: String(e) }
}
try {
  result.flushWaitsForInFlightRename = await runFlushWaitsForInFlightRename()
} catch (e) {
  result.flushWaitsForInFlightRename = { error: String(e) }
}
self.postMessage(result)
