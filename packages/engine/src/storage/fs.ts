// The Node `fs` adapter (docs/decisions/0005-persistence-and-recovery.md Storage table, `fs` row;
// docs/plan/22b-persistence-load-and-fs.md Planning decisions 6): built-in `node:fs` only, zero npm
// dependencies (0005 "Server"). Exported from `engine/server/node` only (`server-node.ts`) -- the
// name M27/M35b use.
//
// Planning decisions 6: "one preallocated 1 MiB append buffer per open log key; `sync` or a full
// buffer starts `fs.write` + `fdatasync` and swaps to a second preallocated buffer (two buffers, no
// per-call allocation); a third pending flush while both are in flight copies into a grown buffer
// and counts `fsBufferGrows` (expected 0)." Modelled here as a two-slot pool: `append` always
// copies into whichever buffer is "front"; a flush hands the filled buffer to an async write chain
// and checks a fresh one out of the pool -- when the pool is empty (both slots mid-flush), a grown,
// one-off buffer is allocated instead and `fsBufferGrows` counts it. Snapshot/manifest/session
// writes (`Storage.write`, "atomic replace") are a separate path: temp file, `datasync`, `rename`
// (0005 table's own "fs" row, `write` column).
import { type FileHandle, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Storage } from './types.js'

/** Test-only (`createFsStorageDebug`, below): one preallocated buffer's own byte capacity, exported
 * so a test can genuinely fill and rotate both pooled buffers without guessing the constant. */
export const FS_BUFFER_BYTES = 1024 * 1024
const BUFFER_BYTES = FS_BUFFER_BYTES

/** A per-process counter for temp-file uniqueness (`write`'s own atomic-replace path): no ambient
 * randomness or time outside `src/clock.ts`/`src/test/**` (`.claude/rules` via `lint.no_ambient_
 * random`) -- `process.pid` plus a monotonic counter is already unique within and across processes
 * writing to the same directory. */
let tmpCounter = 0

/** One open log key's write-ahead state (Planning decisions 6). Never shipped to the browser
 * (0005: "the engine ships a Node `fs` adapter"; `.claude/rules/hot-paths.md` binds the browser
 * only) -- allocation here is counted, not forbidden, and only the *steady-state* count matters
 * (`fsBufferGrows` "expected 0"). */
class LogAppender {
  private readonly pooled: [Buffer, Buffer]
  private free: Buffer[]
  private front: Buffer
  private frontLen = 0
  private chain: Promise<void> = Promise.resolve()
  private handle: FileHandle | null = null
  private opening: Promise<FileHandle> | null = null
  /** Planning decisions 6's own counter: incremented only when both pooled buffers are mid-flush
   * (or a single `append` exceeds a whole buffer, never true for a real log frame -- 0005's own
   * `MAX_FRAME_BYTES` is 64 KiB, well under this module's 1 MiB). Expected `0` in steady state. */
  fsBufferGrows = 0
  private readonly path: string
  private readonly onErr: (e: unknown) => void
  private readonly debug: FsStorageDebug | undefined

  constructor(path: string, onErr: (e: unknown) => void, debug: FsStorageDebug | undefined) {
    this.path = path
    this.onErr = onErr
    this.debug = debug
    this.pooled = [Buffer.allocUnsafe(BUFFER_BYTES), Buffer.allocUnsafe(BUFFER_BYTES)]
    this.free = [this.pooled[1]]
    this.front = this.pooled[0]
  }

  /** Copies `bytes` into the current front buffer (0005: "`bytes` is an engine-owned view valid
   * only during the call" -- the caller must not retain it, and this class never does either).
   * Synchronous: the actual `fs.write`/`fdatasync` only starts from `rotate()` (a full buffer or an
   * explicit `sync()`), matching the 0005 table's own "returns `void`". */
  append(bytes: Uint8Array): void {
    if (this.frontLen > 0 && this.frontLen + bytes.length > this.front.length) this.rotate()
    if (bytes.length > this.front.length) {
      this.rotate()
      this.front = Buffer.allocUnsafe(bytes.length)
      this.fsBufferGrows++
    }
    this.front.set(bytes, this.frontLen)
    this.frontLen += bytes.length
  }

  private rotate(): void {
    if (this.frontLen === 0) return
    const flushBuf = this.front
    const flushLen = this.frontLen
    const wasPooled = flushBuf === this.pooled[0] || flushBuf === this.pooled[1]
    const next = this.free.pop()
    if (next) {
      this.front = next
    } else {
      // Both pooled buffers are already mid-flush: the "third pending flush" case (Planning
      // decisions 6). A one-off buffer, never returned to the pool.
      this.front = Buffer.allocUnsafe(BUFFER_BYTES)
      this.fsBufferGrows++
    }
    this.frontLen = 0
    this.chain = this.chain.then(async () => {
      try {
        await this.writeToDisk(flushBuf, flushLen)
      } catch (e) {
        this.onErr(e)
      } finally {
        if (wasPooled) this.free.push(flushBuf)
      }
    })
  }

  /** The durability barrier (0005: "may be a no-op" for an adapter that is already durable per
   * `append`; here it starts the real `fs.write` + `fdatasync`). Returns the chain of every flush
   * scheduled so far, including ones already in flight -- `flush()`'s own "resolves when everything
   * handed over so far is durable". */
  sync(): Promise<void> {
    this.rotate()
    return this.chain
  }

  private async ensureOpen(): Promise<FileHandle> {
    if (this.handle) return this.handle
    if (!this.opening) {
      this.opening = (async () => {
        await mkdir(dirname(this.path), { recursive: true })
        const h = await open(this.path, 'a')
        this.handle = h
        return h
      })()
    }
    return this.opening
  }

  private async writeToDisk(buf: Buffer, len: number): Promise<void> {
    // Test-only: a caller can hold this write pending (`FsStorageDebug.gate`) to force two flushes
    // genuinely in flight at once, so `fs_pool_exhaustion_forces_a_grown_buffer` exercises the real
    // exhaustion branch instead of only asserting a counter that never had a chance to move.
    if (this.debug) await this.debug.gate
    const handle = await this.ensureOpen()
    await handle.write(buf, 0, len)
    await handle.datasync()
  }

  /** Flushes and closes the underlying file handle: called before `Storage.write`/`delete` replace
   * or remove this key out from under an open append handle (Planning decisions 1 of docs/plan/
   * 22b-persistence-load-and-fs.md: "adapters must accept `append` after `write` on one key" --
   * the next `append` on this key opens a brand new handle against the file `write`/`delete` just
   * replaced). */
  async close(): Promise<void> {
    this.rotate()
    await this.chain
    if (this.handle) {
      await this.handle.close()
      this.handle = null
    }
    this.opening = null
  }
}

async function readIfExists(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** A full recursive walk from `dir` (tmpdir/test scale, per this milestone's own scope -- a real
 * deployment's key layout is shallow and bounded, but no index is built here). Temp files a
 * `write()` in flight leaves behind (`.tmp-*`) are never a real key. */
async function listKeys(dir: string, prefix: string): Promise<string[]> {
  const out: string[] = []
  async function walk(current: string, relPrefix: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      throw e
    }
    for (const entry of entries) {
      if (entry.name.includes('.tmp-')) continue
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full, relPath)
      else out.push(relPath)
    }
  }
  await walk(dir, '')
  return out.filter((k) => k.startsWith(prefix)).sort()
}

/** Test-only (`fs_append_allocates_no_buffers`): every open key's own `fsBufferGrows` counter,
 * summed. Not part of the `Storage` interface (0005's own shape), so this reads the adapter's
 * private state through a side channel `fsStorage` registers only when asked -- `createFsStorage`'s
 * own `debug` option, below. */
export interface FsStorageDebug {
  fsBufferGrows(): number
  /** Test-only: every real `fs.write`/`fdatasync` awaits this before starting. Defaults to an
   * already-resolved promise (no delay); a test swaps in its own pending promise to hold one or more
   * flushes in flight deterministically (`fs_pool_exhaustion_forces_a_grown_buffer`), then resolves
   * it to let them proceed. Read fresh on every write, not captured once. */
  gate: Promise<void>
}

/** A placeholder `fsStorage` fills in once it knows its own appenders (test-only helper, so a
 * caller need not hand-write the placeholder's own body). */
export function createFsStorageDebug(): FsStorageDebug {
  return { fsBufferGrows: () => 0, gate: Promise.resolve() }
}

/** `engine/server/node`'s own `Storage` adapter (Seams: `fsStorage(dir: string): Storage`). One
 * instance per world directory is the normal shape, but nothing here assumes it -- keys are
 * self-namespaced (`worldKeys`) and this adapter never reads outside `dir`. `debug`, when given,
 * is filled with a live counter reader (test-only; production callers never pass it). */
export function fsStorage(dir: string, debug?: FsStorageDebug): Storage {
  const appenders = new Map<string, LogAppender>()
  if (debug) {
    debug.fsBufferGrows = () => {
      let total = 0
      for (const a of appenders.values()) total += a.fsBufferGrows
      return total
    }
  }
  let onErrorHandler: ((err: unknown) => void) | null = null
  const reportError = (e: unknown): void => {
    onErrorHandler?.(e)
  }
  const keyPath = (key: string): string => join(dir, ...key.split('/'))

  const appenderFor = (key: string): LogAppender => {
    let a = appenders.get(key)
    if (!a) {
      a = new LogAppender(keyPath(key), reportError, debug)
      appenders.set(key, a)
    }
    return a
  }

  const dropAppender = async (key: string): Promise<void> => {
    const existing = appenders.get(key)
    if (existing) {
      await existing.close()
      appenders.delete(key)
    }
  }

  const storage: Storage = {
    get onError() {
      return onErrorHandler
    },
    set onError(v) {
      onErrorHandler = v
    },
    append(key, bytes) {
      // `bytes` is only valid during the call (0005 Storage): copy now, not later.
      appenderFor(key).append(bytes.slice())
    },
    sync(key) {
      const a = appenders.get(key)
      return a ? a.sync() : undefined
    },
    async write(key, bytes) {
      await dropAppender(key)
      const path = keyPath(key)
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`
      const handle = await open(tmp, 'w')
      try {
        await handle.write(bytes, 0, bytes.length)
        await handle.datasync()
      } finally {
        await handle.close()
      }
      await rename(tmp, path)
    },
    async delete(key) {
      await dropAppender(key)
      await rm(keyPath(key), { force: true })
    },
    async flush() {
      await Promise.all([...appenders.values()].map((a) => a.sync()))
    },
    async read(key) {
      // `read` is off the tick path only (0005 Storage: grouped with `flush`/`list`), so it may
      // freely await a live appender's own `sync()` first -- otherwise a key just `append`ed to
      // (never yet synced) would read back `null`/stale bytes purely because nothing forced the
      // buffered-but-undurable copy to disk yet (`append_accumulates_in_call_order`'s own read-
      // right-after-append shape, and `Persistence.loadLatest`'s real load path, both rely on this).
      const appender = appenders.get(key)
      if (appender) await appender.sync()
      return readIfExists(keyPath(key))
    },
    async list(prefix) {
      // Same reasoning as `read` above: a key `append`ed to but never yet `sync`ed must still show
      // up (`list` is off the tick path only, 0005 Storage).
      await Promise.all([...appenders.values()].map((a) => a.sync()))
      return listKeys(dir, prefix)
    },
  }
  return storage
}
