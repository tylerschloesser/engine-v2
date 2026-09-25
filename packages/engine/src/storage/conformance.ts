// The 0005 `Storage` contract's own behavioural conformance checks (docs/plan/
// 22-persistence-log-and-snapshots.md Seams: `runStorageConformance(make): Promise<string[]>`, "no
// test-runner imports, so M23 can run it in a page"). Every check builds a fresh instance from
// `make()`, throws with a descriptive message on the first failure, and otherwise pushes its own
// name onto the result -- a plain array a caller (a Vitest test today, a browser page's own
// assertion later) can inspect however it likes, with no `expect`/`assert` import here.
import type { Storage } from './types.js'

const enc = new TextEncoder()

function bytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export async function runStorageConformance(make: () => Storage): Promise<string[]> {
  const passed: string[] = []

  {
    const s = make()
    await s.write('k', enc.encode('hello'))
    const back = await s.read('k')
    if (!bytesEqual(back, enc.encode('hello'))) {
      throw new Error(`write_then_read: expected 'hello', got ${back ? [...back] : back}`)
    }
    passed.push('write_then_read')
  }

  {
    const s = make()
    const back = await s.read('never-written')
    if (back !== null) throw new Error(`read_missing_key_is_null: expected null, got ${back}`)
    passed.push('read_missing_key_is_null')
  }

  {
    const s = make()
    await s.append('log', enc.encode('a'))
    await s.append('log', enc.encode('b'))
    const back = await s.read('log')
    if (!bytesEqual(back, enc.encode('ab'))) {
      throw new Error(
        `append_accumulates_in_call_order: expected 'ab', got ${back ? [...back] : back}`,
      )
    }
    passed.push('append_accumulates_in_call_order')
  }

  {
    // docs/plan/22b-persistence-load-and-fs.md Planning decision 1: "adapters must accept `append`
    // after `write` on one key" -- and the reverse, `append` then `write` then `append` again, is
    // exactly the torn-tail-truncation shape (`Persistence.loadLatest`: `storage.write(keys.log(seg),
    // logBytes.subarray(0, validEnd))` truncates a segment's log, and the tick path keeps appending
    // to that same segment key afterward). `write` must replace *everything* appended so far
    // (including bytes shorter than what was appended, the truncation case), and a later `append`
    // must land after the written bytes, not after the pre-write appended ones.
    const s = make()
    await s.append('mixed', enc.encode('aaaa'))
    await s.append('mixed', enc.encode('bbbb')) // 8 bytes appended so far
    await s.write('mixed', enc.encode('xx')) // shorter than the 8 appended: replaces all of it
    await s.append('mixed', enc.encode('yyy')) // lands after the written bytes, not the old 8
    const back = await s.read('mixed')
    if (!bytesEqual(back, enc.encode('xxyyy'))) {
      throw new Error(
        `write_after_append_then_append_lands_after: expected 'xxyyy', got ${back ? [...back] : back}`,
      )
    }
    passed.push('write_after_append_then_append_lands_after')
  }

  {
    // Same call order, with a `sync()`/`flush()` durability barrier between each call -- an adapter
    // that buffers appends and only applies them to the real backing store at the next barrier must
    // not let a barrier after `write` resurrect or reorder anything from before it.
    const s = make()
    await s.append('mixed2', enc.encode('cccc'))
    await s.sync('mixed2')
    await s.append('mixed2', enc.encode('dddd')) // 8 bytes appended, only the first 4 synced
    await s.write('mixed2', enc.encode('z')) // 1 byte: shorter than either half
    await s.flush()
    await s.append('mixed2', enc.encode('ee'))
    const back = await s.read('mixed2')
    if (!bytesEqual(back, enc.encode('zee'))) {
      throw new Error(
        `write_after_append_survives_sync_and_flush: expected 'zee', got ${back ? [...back] : back}`,
      )
    }
    passed.push('write_after_append_survives_sync_and_flush')
  }

  {
    const s = make()
    await s.write('k', enc.encode('x'))
    await s.delete('k')
    const back = await s.read('k')
    if (back !== null) throw new Error(`delete_removes_the_key: still readable (${[...back]})`)
    passed.push('delete_removes_the_key')
  }

  {
    const s = make()
    await s.write('worlds/a/manifest', enc.encode('1'))
    await s.write('worlds/a/log/000000', enc.encode('2'))
    await s.write('worlds/b/manifest', enc.encode('3'))
    const listed = await s.list('worlds/a/')
    const want = ['worlds/a/log/000000', 'worlds/a/manifest']
    const same = listed.length === want.length && listed.every((k, i) => k === want[i])
    if (!same) {
      throw new Error(
        `list_returns_matching_keys_sorted: expected ${JSON.stringify(want)}, got ${JSON.stringify(listed)}`,
      )
    }
    passed.push('list_returns_matching_keys_sorted')
  }

  {
    const s = make()
    await s.sync('never-written') // must not throw, even for a key that was never appended to
    passed.push('sync_never_throws_on_an_unknown_key')
    await s.flush()
    passed.push('flush_resolves')
  }

  return passed
}
