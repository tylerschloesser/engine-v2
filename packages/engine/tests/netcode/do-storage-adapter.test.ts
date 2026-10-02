// `do/storage-adapter` (docs/plan/38-hosting-checks.md Scope A): the Durable Object `Storage` adapter
// of `games/reference-server-do/src/storage.mjs` (numbered part objects over DO storage, 0005's
// adapter table) against `runStorageConformance`, on a double of `ctx.storage`'s KV API
// (`get`/`put`/`delete` with structured-clone semantics), plus the part-splitting paths conformance
// cannot see: a write of several parts, appends past the cut threshold, a replace that drops the old
// generation's parts, and a reopen over the same backing store.
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { runStorageConformance } from '../../src/storage/conformance.js'
import type { Storage } from '../../src/storage/types.js'

const adapterPath = fileURLToPath(
  new URL('../../../../games/reference-server-do/src/storage.mjs', import.meta.url),
)
const { doStorage, PART_BYTES } = (await import(adapterPath)) as {
  doStorage: (ds: unknown) => Storage
  PART_BYTES: number
}

/** `DurableObjectStorage`'s KV surface the adapter uses: values are structured-cloned on the way in
 * and out; `get`/`delete` take one key or an array (at most 128). */
function fakeDoStorage(backing: Map<string, unknown> = new Map()) {
  const limit = (keys: string[]) => {
    if (keys.length > 128) throw new Error('DO storage: more than 128 keys in one call')
  }
  return {
    backing,
    async get(k: string | string[]) {
      await Promise.resolve()
      if (typeof k === 'string') return structuredClone(backing.get(k))
      limit(k)
      return new Map(
        k.filter((x) => backing.has(x)).map((x) => [x, structuredClone(backing.get(x))]),
      )
    },
    async put(k: string | Record<string, unknown>, v?: unknown) {
      await Promise.resolve()
      if (typeof k === 'string') backing.set(k, structuredClone(v))
      else {
        limit(Object.keys(k))
        for (const [key, val] of Object.entries(k)) backing.set(key, structuredClone(val))
      }
    },
    async delete(k: string | string[]) {
      await Promise.resolve()
      const keys = typeof k === 'string' ? [k] : k
      limit(keys)
      for (const key of keys) backing.delete(key)
    },
  }
}

test('do/storage-adapter: passes runStorageConformance', async () => {
  const backing = new Map<string, unknown>()
  const passed = await runStorageConformance(() => doStorage(fakeDoStorage(backing)))
  expect(passed.length).toBeGreaterThanOrEqual(10)
})

test('do/storage-adapter: parts, cuts, replace and reopen', async () => {
  const backing = new Map<string, unknown>()
  const s = doStorage(fakeDoStorage(backing))
  const big = new Uint8Array(PART_BYTES * 3 + 123).map((_, i) => i % 251)
  await s.write('snap', big)
  await s.flush()
  const partKeys = () => [...backing.keys()].filter((k) => k.startsWith('p/snap/'))
  expect(partKeys()).toHaveLength(4)
  expect(await s.read('snap')).toEqual(big)

  // Replacing drops the old generation's parts.
  await s.write('snap', new Uint8Array([1, 2, 3]))
  await s.flush()
  expect(partKeys()).toHaveLength(1)
  expect(await s.read('snap')).toEqual(new Uint8Array([1, 2, 3]))

  // Appends past the cut threshold become parts without a `sync`; a reopen sees all of them.
  const frame = new Uint8Array(100_000).fill(7)
  for (let i = 0; i < 12; i++) void s.append('log', frame)
  await s.flush()
  const again = doStorage(fakeDoStorage(backing))
  const back = await again.read('log')
  expect(back?.length).toBe(1_200_000)
  expect(await again.list('')).toEqual(['log', 'snap'])
  await again.delete('log')
  expect([...backing.keys()].some((k) => k.startsWith('p/log/'))).toBe(false)
})
