// `Storage` (docs/decisions/0005, the adapter table's "Object store, Durable Object" row) over a
// Durable Object's `ctx.storage` KV API: a deployer-written adapter that emulates `append` with
// numbered part objects. One logical key is `{ gen, parts }` in the small index object `idx`;
// its bytes are `p/<key>/<gen>/<seq>` part objects of at most `PART_BYTES` each.
//
// - `append` copies into a per-key buffer; a part is cut at `sync`/`flush` (the engine calls `sync`
//   at most once per second) or when the buffer reaches `CUT_BYTES`. One cut = one part + the index,
//   in a single `put` (atomic).
// - `write` (atomic replace) puts the new generation's parts, swaps the index in one `put`, then
//   deletes the old generation: a crash between leaves unreferenced parts, never a mixed key.
// - Every operation runs on one promise chain, so the order the engine issued them is the order
//   they take effect. A failed operation calls `onError` (fatal to the world, 0004).
// No imports: the DO runtime or a test double supplies `ds` (get/put/delete with the DO shapes).

const IDX = 'idx'
export const PART_BYTES = 1024 * 1024
const CUT_BYTES = 512 * 1024
// Parts per `put`/`get` (keeps a snapshot write's in-flight copies to a few MiB; the DO limit is
// 128 keys per call).
const BATCH = 8

const partKey = (key, gen, seq) => `p/${key}/${gen}/${String(seq).padStart(6, '0')}`

export function doStorage(ds) {
  let idx = null // Map<key, { gen, parts }>
  const buf = new Map() // key -> { chunks: Uint8Array[], bytes }
  let queue = Promise.resolve()

  const enqueue = (op) => {
    const p = queue.then(op)
    queue = p.then(
      () => {},
      () => {},
    )
    p.catch((e) => {
      storage.onError?.(e)
    })
    return p
  }

  async function loadIdx() {
    if (idx === null) idx = new Map(Object.entries((await ds.get(IDX)) ?? {}))
    return idx
  }
  const idxObject = () => Object.fromEntries(idx)

  async function deleteParts(key, e) {
    const keys = []
    for (let i = 0; i < e.parts; i++) keys.push(partKey(key, e.gen, i))
    for (let i = 0; i < keys.length; i += 128) await ds.delete(keys.slice(i, i + 128))
  }

  /** Puts `bytes` as parts `startSeq...` of `key`/`gen`; the index swap is the caller's. */
  async function putParts(key, gen, startSeq, bytes) {
    let seq = startSeq
    for (let at = 0; at < bytes.length; ) {
      const entries = {}
      for (let n = 0; n < BATCH && at < bytes.length; n++) {
        entries[partKey(key, gen, seq++)] = bytes.slice(at, at + PART_BYTES)
        at += PART_BYTES
      }
      await ds.put(entries)
    }
    return seq
  }

  async function cut(key) {
    const b = buf.get(key)
    if (!b || b.bytes === 0) return
    buf.delete(key)
    await loadIdx()
    const whole = new Uint8Array(b.bytes)
    let at = 0
    for (const c of b.chunks) {
      whole.set(c, at)
      at += c.length
    }
    const e = idx.get(key) ?? { gen: 1, parts: 0 }
    const parts = await putParts(key, e.gen, e.parts, whole)
    idx.set(key, { gen: e.gen, parts })
    await ds.put({ [IDX]: idxObject() })
  }

  const storage = {
    onError: null,
    append(key, bytes) {
      const copy = bytes.slice()
      return enqueue(async () => {
        let b = buf.get(key)
        if (!b) {
          b = { chunks: [], bytes: 0 }
          buf.set(key, b)
        }
        b.chunks.push(copy)
        b.bytes += copy.length
        if (b.bytes >= CUT_BYTES) await cut(key)
      })
    },
    sync(key) {
      return enqueue(() => cut(key))
    },
    write(key, bytes) {
      return enqueue(async () => {
        buf.delete(key)
        await loadIdx()
        const old = idx.get(key)
        const gen = (old?.gen ?? 0) + 1
        const parts = await putParts(key, gen, 0, bytes)
        idx.set(key, { gen, parts })
        await ds.put({ [IDX]: idxObject() })
        if (old) await deleteParts(key, old)
      })
    },
    delete(key) {
      return enqueue(async () => {
        buf.delete(key)
        await loadIdx()
        const old = idx.get(key)
        if (!old) return
        idx.delete(key)
        await ds.put({ [IDX]: idxObject() })
        await deleteParts(key, old)
      })
    },
    flush() {
      return enqueue(async () => {
        for (const key of [...buf.keys()]) await cut(key)
      })
    },
    read(key) {
      return enqueue(async () => {
        await loadIdx()
        const e = idx.get(key)
        const b = buf.get(key)
        if (!e && !b) return null
        const chunks = []
        let total = 0
        if (e) {
          for (let i = 0; i < e.parts; i += BATCH) {
            const keys = []
            for (let j = i; j < Math.min(e.parts, i + BATCH); j++) keys.push(partKey(key, e.gen, j))
            const got = await ds.get(keys)
            for (const k of keys) {
              const part = got.get(k)
              if (!part) throw new Error(`doStorage: part ${k} is missing`)
              chunks.push(part)
              total += part.length
            }
          }
        }
        for (const c of b?.chunks ?? []) {
          chunks.push(c)
          total += c.length
        }
        const out = new Uint8Array(total)
        let at = 0
        for (const c of chunks) {
          out.set(c, at)
          at += c.length
        }
        return out
      })
    },
    /** Diagnostics: the index (`key -> { gen, parts }`) as stored. */
    index() {
      return enqueue(async () => {
        await loadIdx()
        return idxObject()
      })
    },
    list(prefix) {
      return enqueue(async () => {
        await loadIdx()
        const keys = new Set([...idx.keys(), ...buf.keys()])
        return [...keys].filter((k) => k.startsWith(prefix)).sort()
      })
    },
  }
  return storage
}
