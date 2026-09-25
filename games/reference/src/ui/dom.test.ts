// `diffKeyed` (docs/plan/20b-reference-player-and-collect-ui.md Provides): pure reconciliation
// logic, tested here with plain objects (never `HTMLElement`, `E` is unconstrained) so this suite
// needs no DOM environment (`vitest.config.ts`'s `unit` project runs `environment: 'node'`).
import { expect, test } from 'vitest'
import { diffKeyed } from './dom.js'

type Item = { id: string; n: number }

test('diffKeyed creates once per new key, then only updates', () => {
  const live = new Map<string, { n: number; created: number; updated: number }>()
  let created = 0

  function run(items: Item[]): void {
    diffKeyed(live, items, (i) => i.id, {
      create: (i) => {
        created++
        return { n: i.n, created, updated: 0 }
      },
      update: (e, i) => {
        e.n = i.n
        e.updated++
      },
    })
  }

  run([{ id: 'a', n: 1 }])
  expect(created).toBe(1)
  expect(live.get('a')?.n).toBe(1)
  expect(live.get('a')?.updated).toBe(1)

  // Same key again: no new `create`, but `update` still runs (carries the new value across).
  run([{ id: 'a', n: 2 }])
  expect(created).toBe(1)
  expect(live.get('a')?.n).toBe(2)
  expect(live.get('a')?.updated).toBe(2)
})

test('diffKeyed removes a key that drops out of the item list', () => {
  const live = new Map<string, { removed: boolean }>()
  const removed: string[] = []

  function run(items: Item[]): void {
    diffKeyed(live, items, (i) => i.id, {
      create: () => ({ removed: false }),
      update: () => {},
      remove: (e) => {
        e.removed = true
      },
    })
  }

  run([
    { id: 'a', n: 1 },
    { id: 'b', n: 2 },
  ])
  expect([...live.keys()].sort()).toEqual(['a', 'b'])

  const bBefore = live.get('b')
  run([{ id: 'a', n: 1 }])
  expect([...live.keys()]).toEqual(['a'])
  expect(bBefore?.removed).toBe(true)
  removed.push('b')
  expect(removed).toEqual(['b'])
})

test('diffKeyed with no remove handler still drops the key from `live`', () => {
  const live = new Map<string, { n: number }>()
  function run(items: Item[]): void {
    diffKeyed(live, items, (i) => i.id, {
      create: (i) => ({ n: i.n }),
      update: (e, i) => {
        e.n = i.n
      },
    })
  }
  run([{ id: 'a', n: 1 }])
  run([])
  expect(live.size).toBe(0)
})
