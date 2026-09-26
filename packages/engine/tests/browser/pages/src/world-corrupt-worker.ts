// `world.html`'s test-only debug worker (docs/plan/23-persistence-opfs-and-lifecycle.md step 5,
// `export_works_after_load_failure`): overwrites one key of a *not-currently-open* world's OPFS
// storage with arbitrary bytes, via `createWritable()` (a plain File System Access API write, not
// `createSyncAccessHandle()` -- a manifest key has no persistently-open sync handle of its own,
// `opfs.ts`'s own `write()`/`#logHandles` split, so this never races the sim worker over an
// exclusive handle the way `world-dump-worker.ts`'s own doc comment describes for `.scratch`). Used
// only between page loads (the world's own sim worker is not running when this corrupts it), then a
// fresh `world.html?world=<id>` load hits the corrupted key for real.
type Request = { worldId: string; key: string; bytes: number[] }
type Response = { done: true }

self.onmessage = async (ev: MessageEvent<Request>) => {
  try {
    const { worldId, key, bytes } = ev.data
    let dir: FileSystemDirectoryHandle = await navigator.storage.getDirectory()
    const parts = `worlds/${worldId}/${key}`.split('/')
    const name = parts.pop()
    if (name === undefined) throw new Error('world-corrupt-worker: empty key')
    for (const seg of parts) dir = await dir.getDirectoryHandle(seg, { create: true })
    const fileHandle = await dir.getFileHandle(name, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(new Uint8Array(bytes))
    await writable.close()
    const response: Response = { done: true }
    ;(self as unknown as { postMessage(m: Response): void }).postMessage(response)
  } catch (e) {
    ;(self as unknown as { postMessage(m: { done: true; error: string }): void }).postMessage({
      done: true,
      error: String(e),
    })
  }
}
