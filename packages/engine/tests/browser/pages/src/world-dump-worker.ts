// `world.html`'s test-only debug worker (docs/plan/23-persistence-opfs-and-lifecycle.md steps 3-4,
// `world_survives_reload`): `opfsStorage`'s own OPFS backing (`createSyncAccessHandle`) only works
// inside a dedicated Worker (step 2, Deviations), so a Playwright spec cannot read a persisted
// world's stored bytes directly from the page or from Node -- this worker opens the *same* world's
// storage (a fresh, independent `OpfsStorage` instance, OPFS itself is the shared, durable state,
// not this instance) and dumps every key under `worlds/<id>/` back to whoever spawned it.
//
// Test-only infrastructure, not production (`storage-opfs-worker.ts`'s own precedent): the sim
// worker (`worker/sim.ts`) is the one production reader/writer of a world's OPFS storage. Until step
// 5 gives `client.exportWorld()` a real archive format, this is how `world_survives_reload` gets an
// independent copy of the stored log/manifest/snapshot bytes to replay against
// (`engine/test.replayWorld`, run from the spec's own Node process -- see that spec file's own
// comment for exactly how). Step 5 should delete this file once `exportWorld` covers the same need.
import { opfsStorage } from '../../../../src/storage/opfs.ts'

type Request = { worldId: string }
/** Plain number arrays, not `Uint8Array` (Playwright's `page.evaluate` return value goes through
 * ordinary JSON-shaped serialization -- `slice.ts`'s own `__probeTile` precedent, `Array.from`). */
type Response = { entries: Record<string, number[]> }

self.onmessage = async (ev: MessageEvent<Request>) => {
  const { worldId } = ev.data
  const storage = await opfsStorage(worldId)
  const keys = await storage.list(`worlds/${worldId}/`)
  const entries: Record<string, number[]> = {}
  for (const key of keys) {
    const bytes = await storage.read(key)
    if (bytes) entries[key] = Array.from(bytes)
  }
  const response: Response = { entries }
  ;(self as unknown as { postMessage(m: Response): void }).postMessage(response)
}
