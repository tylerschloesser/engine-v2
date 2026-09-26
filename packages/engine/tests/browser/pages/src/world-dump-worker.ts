// `world.html`'s test-only debug worker (docs/plan/23-persistence-opfs-and-lifecycle.md steps 3-4,
// `world_survives_reload`/`hidden_pauses_and_snapshots`): reads a persisted world's own OPFS files
// back to whoever spawned it, *without* going through `opfsStorage()` -- that constructor eagerly
// opens an exclusive sync access handle on the world's own `.scratch` file (Planning decision 2), so
// a second instance opened here while the production sim worker's own instance is still alive would
// throw `NoModificationAllowedError` (measured: exactly this, mid-test) rather than dump anything.
// This worker instead walks the OPFS tree directly with `FileSystemFileHandle.getFile()` (a
// read-only snapshot the spec says is compatible with another context's open sync access handle,
// unlike a second `createSyncAccessHandle()`/`createWritable()`), skipping `.scratch` itself (never
// a real key `worldKeys()` produces).
//
// Test-only infrastructure, not production (`storage-opfs-worker.ts`'s own precedent): the sim
// worker (`worker/sim.ts`) is the one production reader/writer of a world's OPFS storage. Until step
// 5 gives `client.exportWorld()` a real archive format, this is how `world_survives_reload` gets an
// independent copy of the stored log/manifest/snapshot bytes to replay against
// (`engine/test.replayWorld`, run from the spec's own Node process -- see that spec file's own
// comment for exactly how). Step 5 should delete this file once `exportWorld` covers the same need.

type Request = { worldId: string }
/** Plain number arrays, not `Uint8Array` (Playwright's `page.evaluate` return value goes through
 * ordinary JSON-shaped serialization -- `slice.ts`'s own `__probeTile` precedent, `Array.from`). */
type Response = { entries: Record<string, number[]> }

async function walk(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: Record<string, number[]>,
): Promise<void> {
  for await (const [name, handle] of dir.entries()) {
    if (name === '.scratch') continue
    const full = prefix + name
    if (handle.kind === 'file') {
      const file = await (handle as FileSystemFileHandle).getFile()
      out[full] = Array.from(new Uint8Array(await file.arrayBuffer()))
    } else {
      await walk(handle as FileSystemDirectoryHandle, `${full}/`, out)
    }
  }
}

self.onmessage = async (ev: MessageEvent<Request>) => {
  const { worldId } = ev.data
  const root = await navigator.storage.getDirectory()
  let dir: FileSystemDirectoryHandle | null = root
  for (const seg of `worlds/${worldId}`.split('/')) {
    if (!dir) break
    try {
      dir = await dir.getDirectoryHandle(seg)
    } catch {
      dir = null
    }
  }
  const entries: Record<string, number[]> = {}
  if (dir) await walk(dir, `worlds/${worldId}/`, entries)
  const response: Response = { entries }
  ;(self as unknown as { postMessage(m: Response): void }).postMessage(response)
}
