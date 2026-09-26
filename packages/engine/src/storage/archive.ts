// World archive: `exportWorld`/`importWorld`/`deleteWorld` (docs/plan/
// 23-persistence-opfs-and-lifecycle.md step 5, Seams "Provides"): plain functions over any `Storage`
// (usable by a server, `engine/server`, and by the sim worker's own request handler,
// `worker/sim.ts`). No DOM here (`gzip`/`gunzip` use the Streams-API `CompressionStream`/
// `DecompressionStream`, available in every runtime this engine targets -- browsers and Node >=22,
// 0005 "Sealed segments may be gzip-compressed with `CompressionStream`").
//
// Format (Seams: "archive = gzip of `magic | version u16 | count | (key, bytes)*` holding exactly
// the key set 0005 lists"): a gzip stream wrapping
//   magic (4 bytes, ASCII "EWA1") | version u16 LE
//   | worldIdLen u16 LE | worldId (UTF-8) -- the archive's own id, independent of where it lands
//   | count u32 LE
//   | (keyLen u16 LE | key (UTF-8, *relative* to `worlds/<id>/`) | dataLen u32 LE | data)*
// Keys are stored relative to the world's own namespace so `importWorld` can re-root them under a
// different id (`opts.worldId`) without string surgery on absolute keys.
import type { Storage } from './types.js'
import { worldKeys } from './types.js'

const MAGIC = new Uint8Array([0x45, 0x57, 0x41, 0x31]) // "EWA1"
const VERSION = 1

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/** Thrown by `unpackArchive`/`importWorld` on a bad magic, an unsupported version, or truncated
 * bytes -- distinct from `WorldExistsError` (a refusal, not a format problem). */
export class ArchiveFormatError extends Error {
  constructor(reason: string) {
    super(`ArchiveFormatError: ${reason}`)
    this.name = 'ArchiveFormatError'
  }
}

/** Thrown by `importWorld` when the target world id already has a manifest and `opts.overwrite`
 * is not `true` (Planning decision 6: "refuses an existing id without `overwrite`"). */
export class WorldExistsError extends Error {
  readonly worldId: string
  constructor(worldId: string) {
    super(`WorldExistsError: a world already exists at id ${worldId}`)
    this.name = 'WorldExistsError'
    this.worldId = worldId
  }
}

export interface ArchiveEntry {
  key: string
  bytes: Uint8Array
}

function u16(n: number): Uint8Array {
  const b = new Uint8Array(2)
  new DataView(b.buffer).setUint16(0, n, true)
  return b
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, true)
  return b
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** The pre-gzip container layout, exported only for `archive_golden_bytes` (a gzip stream is not
 * guaranteed byte-identical across implementations/timestamps even for identical input, so the pinned
 * byte layout this test protects is the container, not the compressed wrapper `packArchive` adds). */
export function encodeContainer(worldId: string, entries: ArchiveEntry[]): Uint8Array {
  const worldIdBytes = textEncoder.encode(worldId)
  const parts: Uint8Array[] = [MAGIC, u16(VERSION), u16(worldIdBytes.length), worldIdBytes]
  parts.push(u32(entries.length))
  for (const e of entries) {
    const keyBytes = textEncoder.encode(e.key)
    parts.push(u16(keyBytes.length), keyBytes, u32(e.bytes.length), e.bytes)
  }
  return concat(parts)
}

class Reader {
  #bytes: Uint8Array
  #pos = 0
  constructor(bytes: Uint8Array) {
    this.#bytes = bytes
  }
  #need(n: number): void {
    if (this.#pos + n > this.#bytes.length) {
      throw new ArchiveFormatError(`truncated archive (need ${n} bytes at offset ${this.#pos})`)
    }
  }
  u16(): number {
    this.#need(2)
    const v = new DataView(this.#bytes.buffer, this.#bytes.byteOffset + this.#pos, 2).getUint16(
      0,
      true,
    )
    this.#pos += 2
    return v
  }
  u32(): number {
    this.#need(4)
    const v = new DataView(this.#bytes.buffer, this.#bytes.byteOffset + this.#pos, 4).getUint32(
      0,
      true,
    )
    this.#pos += 4
    return v
  }
  bytes(n: number): Uint8Array {
    this.#need(n)
    const out = this.#bytes.slice(this.#pos, this.#pos + n)
    this.#pos += n
    return out
  }
  string(n: number): string {
    return textDecoder.decode(this.bytes(n))
  }
}

/** The container layout's own decoder, exported alongside `encodeContainer` for the same reason. */
export function decodeContainer(bytes: Uint8Array): { worldId: string; entries: ArchiveEntry[] } {
  if (bytes.length < MAGIC.length) throw new ArchiveFormatError('truncated archive (no magic)')
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new ArchiveFormatError('bad magic')
  }
  const r = new Reader(bytes)
  r.bytes(MAGIC.length)
  const version = r.u16()
  if (version !== VERSION) throw new ArchiveFormatError(`unsupported version ${version}`)
  const worldId = r.string(r.u16())
  const count = r.u32()
  const entries: ArchiveEntry[] = []
  for (let i = 0; i < count; i++) {
    const key = r.string(r.u16())
    const data = r.bytes(r.u32())
    entries.push({ key, bytes: data })
  }
  return { worldId, entries }
}

async function collect(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const reader = readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  return concat(chunks)
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip')
  const writer = cs.writable.getWriter()
  // `bytes` is this module's own freshly-built container, never a caller-owned view (0005's "valid
  // only during the call" rule is about `Storage`, not this): no copy needed before handing it off.
  // The cast is TS's generic-typed-array widening only (`Uint8Array` bare = `ArrayBufferLike`,
  // `CompressionStream`'s `BufferSource` wants `ArrayBuffer` specifically); every byte array this
  // module builds is a plain `new Uint8Array(n)`, never `SharedArrayBuffer`-backed.
  void writer.write(bytes as Uint8Array<ArrayBuffer>).then(() => writer.close())
  return collect(cs.readable)
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip')
  const writer = ds.writable.getWriter()
  void writer
    .write(bytes as Uint8Array<ArrayBuffer>)
    .then(() => writer.close())
    .catch(() => {
      // A bad gzip stream surfaces through the *reader* side below (`collect`'s own `read()`
      // rejects); swallow the writer-side rejection so it does not also become an unhandled one.
    })
  return collect(ds.readable)
}

/** Packs `entries` (relative keys) under `worldId` into a gzip archive. Exported for a test that
 * wants the container bytes without a real `Storage` (`archive_golden_bytes`). */
export async function packArchive(worldId: string, entries: ArchiveEntry[]): Promise<Uint8Array> {
  return gzip(encodeContainer(worldId, entries))
}

/** Unpacks a gzip archive into its own `worldId` and relative-key entries. Exported for the same
 * reason as `packArchive`. */
export async function unpackArchive(
  archiveBytes: Uint8Array,
): Promise<{ worldId: string; entries: ArchiveEntry[] }> {
  let container: Uint8Array
  try {
    container = await gunzip(archiveBytes)
  } catch (e) {
    throw new ArchiveFormatError(`not a valid gzip stream: ${String(e)}`)
  }
  return decodeContainer(container)
}

/**
 * Streams one world's whole key set (0005 Storage: "keys: `worlds/<id>/manifest`, `log/<segment>`,
 * `snap/<tick>`, `sessions`" -- exactly whatever of those actually exists, via `Storage.list`, never
 * a hard-coded guess) into one gzip archive (0005 Export/import). Reads every key back with
 * `Storage.read`, so a caller wanting a fully durable export awaits `Storage.flush()` first (the sim
 * worker's own request handler does; a server caller decides for itself).
 */
export async function exportWorld(storage: Storage, worldId: string): Promise<Uint8Array> {
  const prefix = `worlds/${worldId}/`
  const keys = [...(await storage.list(prefix))].sort()
  const entries: ArchiveEntry[] = []
  for (const key of keys) {
    const bytes = await storage.read(key)
    if (bytes) entries.push({ key: key.slice(prefix.length), bytes })
  }
  return packArchive(worldId, entries)
}

/**
 * Writes an archive's entries back through `storage`, under `opts.worldId` when given, else the
 * archive's own `worldId` (Planning decision 6). Refuses an id that already has a manifest unless
 * `opts.overwrite` is `true` (`WorldExistsError`). Never loads the world afterward (Planning decision
 * 6: "the normal load path ... runs at that next start").
 */
export async function importWorld(
  storage: Storage,
  archiveBytes: Uint8Array,
  opts: { worldId?: string; overwrite?: boolean } = {},
): Promise<{ worldId: string }> {
  const { worldId: sourceWorldId, entries } = await unpackArchive(archiveBytes)
  const targetWorldId = opts.worldId ?? sourceWorldId
  const keys = worldKeys(targetWorldId)
  const existing = await storage.read(keys.manifest)
  if (existing !== null && opts.overwrite !== true) {
    throw new WorldExistsError(targetWorldId)
  }
  const prefix = `worlds/${targetWorldId}/`
  for (const { key, bytes } of entries) {
    await storage.write(prefix + key, bytes)
  }
  return { worldId: targetWorldId }
}

/** Deletes every key under `worlds/<worldId>/` (Scope: "World archive format, `exportWorld`/
 * `importWorld`/`deleteWorld`, in the sim worker and as plain functions over any `Storage` for
 * servers"). Never throws on a world that does not exist (an empty key list deletes nothing). */
export async function deleteWorld(storage: Storage, worldId: string): Promise<void> {
  const prefix = `worlds/${worldId}/`
  const keys = await storage.list(prefix)
  for (const key of keys) await storage.delete(key)
}
