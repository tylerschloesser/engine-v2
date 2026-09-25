// The OPFS `Storage` adapter (docs/decisions/0005-persistence-and-recovery.md Storage table:
// "Browser OPFS" row; docs/plan/23-persistence-opfs-and-lifecycle.md steps 1-2). Runs inside the
// sim worker only (0015 §1 "sim worker": "OPFS handles and the Web Lock"), opened through
// `shell.runAsync` (Seams: "internal to the worker kind `sim`").
//
// Decision 3 (this milestone's own Deviations, step 1): rename (`FileSystemFileHandle.move()`), not
// slot files -- probed available in Chromium 153, WebKit 26.6 and Firefox 155 (Playwright, a
// persistent browser context -- WebKit's OPFS needs one), always called with the 2-arg form
// (`move(directory, name)`; the 1-arg form throws in WebKit). No adapter header, no slot reuse.
//
// Keys map onto nested OPFS directories one-for-one on `/` (`worlds/<id>/manifest` becomes a file
// named `manifest` inside directories `worlds` then `<id>`); `worldKeys()`'s own zero-padded
// `segment`/`tick` convention (`types.ts`) is what keeps a lexicographic directory listing numeric
// too, the same property `list()` relies on for every other adapter.
import type { Storage } from './types.js'

/** Thrown by `opfsStorage()` when OPFS cannot be used at all here (0005 "Browser": "No OPFS (Safari
 * private mode): an in-memory adapter and `durable: false`" -- the caller's own fallback, built by a
 * later step, not here). `reason` is the first failing call's own message. */
export class OpfsUnavailable extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(`OpfsUnavailable: ${reason}`)
    this.name = 'OpfsUnavailable'
    this.reason = reason
  }
}

/** The extra surface this adapter exposes beyond the plain `Storage` contract (Seams for step 3,
 * recorded under this milestone's own Deviations): still assignable wherever a `Storage` is
 * expected, so this is additive, not a renamed `Storage` seam. */
export interface OpfsStorage extends Storage {
  /**
   * The sim worker body's own hook (step 3, not wired yet): the one queued promise-only
   * continuation a `write()` call leaves behind (closing the scratch handle, renaming it onto the
   * real key, opening the next scratch handle -- Planning decision 2), to be run through M06b's
   * `shell.runAsync` in the gap after a tick pass. Returns (and clears) it, or `null` when nothing
   * is queued -- a worker body can poll this every wake, cheaply, with no allocation on a `null`
   * read. At most one continuation is ever queued at a time (0005 Cadence writes are already
   * serialized); a `write()` that arrives before the previous one drains chains behind it instead of
   * replacing it (`#queueRename`'s own `previous` capture).
   */
  pendingAsync(): (() => Promise<void>) | null
  /** Whether `write()`'s synchronous fast path (already-open scratch handle) is available right
   * now. A future `Persistence` (step 3) reads this before a periodic snapshot to decide whether to
   * take it or skip the snapshot and retry a tick later, counting `snapshotDeferred`. */
  scratchReady(): boolean
  /** Planning decision 2's own counter, "expected 0": nothing in this file increments it, since
   * this adapter's own `write()` never itself skips a write (it always either takes the fast path or
   * falls onto a slower, still-correct, promise-returning one). It exists here for that future
   * caller to drive and for a test to move directly (`storage-opfs.spec.ts`'s
   * `storage_opfs_pending_async_hook`). */
  snapshotDeferred: number
}

function isNotFound(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'NotFoundError'
}

interface LogHandle {
  handle: FileSystemSyncAccessHandle
}

interface Scratch {
  syncHandle: FileSystemSyncAccessHandle
  fileHandle: FileSystemFileHandle
}

const SCRATCH_NAME = '.scratch'

/** `.claude/rules/hot-paths.md`: reused across every `append` call on this adapter (Planning
 * decision 4), never allocated per call -- `append`'s own one-time seek at open. */
const APPEND_SEEK = { at: 0 }
/** `write()`'s own seek: always to 0 (a full replace of the scratch file), a distinct reused object
 * from `APPEND_SEEK` since the two are never the same value. */
const WRITE_AT_ZERO = { at: 0 }
const EMPTY = new Uint8Array(0)

class OpfsStorageAdapter implements OpfsStorage {
  onError: ((err: unknown) => void) | null = null
  snapshotDeferred = 0

  readonly #root: FileSystemDirectoryHandle
  readonly #worldId: string
  readonly #logHandles = new Map<string, LogHandle>()
  /** Keys written through `write()` but not yet confirmed renamed onto their real name (or written
   * directly, on the slow path): `read()`/`list()` consult this first, so a caller sees its own
   * write immediately regardless of which path handled it or whether the rename has landed yet. */
  readonly #writtenPending = new Map<string, Uint8Array>()
  #scratch: Scratch | null = null
  #pendingAsync: (() => Promise<void>) | null = null

  private constructor(root: FileSystemDirectoryHandle, worldId: string) {
    this.#root = root
    this.#worldId = worldId
  }

  static async open(worldId: string): Promise<OpfsStorageAdapter> {
    let root: FileSystemDirectoryHandle
    try {
      if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
        throw new Error('navigator.storage.getDirectory is not a function')
      }
      root = await navigator.storage.getDirectory()
    } catch (e) {
      throw new OpfsUnavailable(`getDirectory: ${String(e)}`)
    }
    const adapter = new OpfsStorageAdapter(root, worldId)
    try {
      await adapter.#openScratch()
    } catch (e) {
      throw new OpfsUnavailable(`createSyncAccessHandle: ${String(e)}`)
    }
    return adapter
  }

  scratchReady(): boolean {
    return this.#scratch !== null
  }

  pendingAsync(): (() => Promise<void>) | null {
    const fn = this.#pendingAsync
    this.#pendingAsync = null
    return fn
  }

  // -- path resolution ----------------------------------------------------------------------------

  async #resolveDir(path: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
    let dir = this.#root
    if (path.length === 0) return dir
    for (const seg of path.split('/')) {
      try {
        dir = await dir.getDirectoryHandle(seg, { create })
      } catch (e) {
        if (isNotFound(e)) return null
        throw e
      }
    }
    return dir
  }

  async #resolve(
    key: string,
    create: boolean,
  ): Promise<{ dir: FileSystemDirectoryHandle; name: string } | null> {
    const slash = key.lastIndexOf('/')
    const dirPath = slash < 0 ? '' : key.slice(0, slash)
    const name = slash < 0 ? key : key.slice(slash + 1)
    const dir = await this.#resolveDir(dirPath, create)
    if (!dir) return null
    return { dir, name }
  }

  // -- append/sync: the tick path (hot-paths.md: no allocation, no options object in steady state) -

  append(key: string, bytes: Uint8Array): void | Promise<void> {
    const state = this.#logHandles.get(key)
    if (state) {
      // Decision 4: no options object here -- the cursor was already seeked once, at open.
      state.handle.write(bytes)
      return
    }
    return this.#openLogHandleThenAppend(key, bytes)
  }

  async #openLogHandleThenAppend(key: string, bytes: Uint8Array): Promise<void> {
    // Off the fast path (the first `append` to this key only): `bytes` is only valid for the
    // synchronous part of this call (0005 Storage), and this continuation runs later.
    const copy = bytes.slice()
    const resolved = await this.#resolve(key, true)
    if (!resolved) throw new Error(`opfsStorage: cannot resolve key ${key}`)
    const fileHandle = await resolved.dir.getFileHandle(resolved.name, { create: true })
    const handle = await fileHandle.createSyncAccessHandle()
    const size = handle.getSize()
    // The one seek, at open (Decision 4): a zero-length write at the file's current end moves the
    // handle's own cursor there without touching any bytes; every `append` after this is a bare
    // `write(view)`, cursor auto-advancing. `APPEND_SEEK` is reused, not a fresh literal, so this
    // still costs nothing beyond a field write even though the value itself differs per key.
    APPEND_SEEK.at = size
    handle.write(EMPTY, APPEND_SEEK)
    this.#logHandles.set(key, { handle })
    handle.write(copy)
  }

  sync(key: string): void | Promise<void> {
    const state = this.#logHandles.get(key)
    if (state) state.handle.flush()
  }

  // -- write: scratch + queued rename (Planning decision 2) ----------------------------------------

  write(key: string, bytes: Uint8Array): void | Promise<void> {
    // Copied regardless of path: kept in `#writtenPending` until the rename lands (or, on the slow
    // path, until the direct write finishes), so a `read()` arriving in between sees the new value.
    const copy = bytes.slice()
    this.#writtenPending.set(key, copy)
    const scratch = this.#scratch
    if (!scratch) return this.#writeViaFreshHandle(key, copy)
    this.#scratch = null
    scratch.syncHandle.truncate(copy.length)
    scratch.syncHandle.write(copy, WRITE_AT_ZERO)
    scratch.syncHandle.flush()
    this.#queueRename(scratch, key, copy)
    return undefined
  }

  #queueRename(scratch: Scratch, key: string, copy: Uint8Array): void {
    // Planning decision 2: "at most one at a time" -- a single slot, not a queue. Any *other*
    // `write()` that arrives before this one drains (fast or slow path) chains behind it first
    // (`previous`, below and in `#writeViaFreshHandle`), so calls take effect in call order (0005
    // Storage) regardless of which key each one targets.
    const previous = this.#pendingAsync
    this.#pendingAsync = async () => {
      try {
        if (previous) await previous()
        const resolved = await this.#resolve(key, true)
        if (!resolved) throw new Error(`opfsStorage: cannot resolve key ${key}`)
        scratch.syncHandle.close()
        await scratch.fileHandle.move(resolved.dir, resolved.name)
        if (this.#writtenPending.get(key) === copy) this.#writtenPending.delete(key)
      } catch (e) {
        this.onError?.(e)
      } finally {
        await this.#openScratch().catch((e: unknown) => this.onError?.(e))
      }
    }
  }

  /** The slow path: no scratch handle is ready right now (the very first `write()` ever, or a
   * previous rename+reopen is still in flight). Writes directly to the real key's own file --
   * correct, just not allocation-free -- and chains behind whatever was already queued so calls take
   * effect in call order (0005 Storage) regardless of key. Never itself tries to open a fresh scratch
   * handle: only `#queueRename`'s own continuation does that, so two write calls on the same instance
   * before a `flush()` never race for the one `.scratch` file. */
  async #writeViaFreshHandle(key: string, copy: Uint8Array): Promise<void> {
    const previous = this.#pendingAsync
    this.#pendingAsync = null
    if (previous) await previous()
    const resolved = await this.#resolve(key, true)
    if (!resolved) throw new Error(`opfsStorage: cannot resolve key ${key}`)
    const fileHandle = await resolved.dir.getFileHandle(resolved.name, { create: true })
    const handle = await fileHandle.createSyncAccessHandle()
    handle.truncate(copy.length)
    handle.write(copy, WRITE_AT_ZERO)
    handle.flush()
    handle.close()
    if (this.#writtenPending.get(key) === copy) this.#writtenPending.delete(key)
  }

  async #openScratch(): Promise<void> {
    const dir = await this.#resolveDir(`worlds/${this.#worldId}`, true)
    if (!dir) throw new Error('opfsStorage: cannot create the world directory')
    const fileHandle = await dir.getFileHandle(SCRATCH_NAME, { create: true })
    const syncHandle = await fileHandle.createSyncAccessHandle()
    // A stale scratch file can survive a crash between "write+flush" and "close+move" (a previous
    // process's own unfinished rename); its bytes were never linked under a real key, so discarding
    // them is safe (0005 Recovery never reads `.scratch`).
    syncHandle.truncate(0)
    this.#scratch = { syncHandle, fileHandle }
  }

  // -- delete ---------------------------------------------------------------------------------------

  async delete(key: string): Promise<void> {
    this.#writtenPending.delete(key)
    const state = this.#logHandles.get(key)
    if (state) {
      state.handle.close()
      this.#logHandles.delete(key)
    }
    const resolved = await this.#resolve(key, false)
    if (!resolved) return
    try {
      await resolved.dir.removeEntry(resolved.name)
    } catch (e) {
      if (!isNotFound(e)) throw e
    }
  }

  // -- off the tick path only: flush/read/list -------------------------------------------------------

  async flush(): Promise<void> {
    for (;;) {
      const fn = this.pendingAsync()
      if (!fn) break
      await fn()
    }
    for (const state of this.#logHandles.values()) state.handle.flush()
  }

  async read(key: string): Promise<Uint8Array | null> {
    const pending = this.#writtenPending.get(key)
    if (pending !== undefined) return pending.slice()
    const state = this.#logHandles.get(key)
    if (state) {
      const size = state.handle.getSize()
      const buf = new Uint8Array(size)
      state.handle.read(buf, { at: 0 })
      return buf
    }
    const resolved = await this.#resolve(key, false)
    if (!resolved) return null
    try {
      const fileHandle = await resolved.dir.getFileHandle(resolved.name)
      const file = await fileHandle.getFile()
      return new Uint8Array(await file.arrayBuffer())
    } catch (e) {
      if (isNotFound(e)) return null
      throw e
    }
  }

  async list(prefix: string): Promise<string[]> {
    const out = new Set<string>()
    for (const k of this.#writtenPending.keys()) {
      if (k.startsWith(prefix)) out.add(k)
    }
    const dirPath = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
    const walkPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`
    const dir = await this.#resolveDir(dirPath, false)
    if (dir) await this.#walk(dir, walkPrefix, out)
    return [...out].sort()
  }

  async #walk(dir: FileSystemDirectoryHandle, prefixPath: string, out: Set<string>): Promise<void> {
    for await (const [name, handle] of dir.entries()) {
      if (name === SCRATCH_NAME) continue
      const full = prefixPath + name
      if (handle.kind === 'file') out.add(full)
      else await this.#walk(handle, `${full}/`, out)
    }
  }
}

export async function opfsStorage(worldId: string): Promise<OpfsStorage> {
  return OpfsStorageAdapter.open(worldId)
}
