import { expect, test } from 'vitest'
import { createVirtualClock } from './virtual-clock.js'

test('virtual-clock: releases due deliveries in (deliverAt, link, seq) order', async () => {
  const clock = createVirtualClock()
  const order: string[] = []
  const link = clock.nextLinkId()

  // Pushed deliberately out of `seq` order, so a sort that merely trusted insertion order (Array
  // sort's own stability) would not, by accident, happen to already agree with the real order --
  // proving the explicit `(deliverAt, link, seq)` comparator is what decides this, not incidental
  // push order.
  clock.scheduleDelivery({
    deliverAt: 10,
    link,
    seq: 2,
    run: () => {
      order.push('c')
    },
  })
  clock.scheduleDelivery({
    deliverAt: 10,
    link,
    seq: 0,
    run: () => {
      order.push('a')
    },
  })
  clock.scheduleDelivery({
    deliverAt: 5,
    link,
    seq: 5,
    run: () => {
      order.push('first')
    },
  })
  clock.scheduleDelivery({
    deliverAt: 10,
    link,
    seq: 1,
    run: () => {
      order.push('b')
    },
  })

  await clock.advanceTo(10)

  expect(order).toEqual(['first', 'a', 'b', 'c'])
  expect(clock.now()).toBe(10)
})

test('virtual-clock: two links with colliding deliverAt sort by link', async () => {
  const clock = createVirtualClock()
  const order: string[] = []
  const linkA = clock.nextLinkId()
  const linkB = clock.nextLinkId()
  expect(linkA).toBe(0)
  expect(linkB).toBe(1)

  clock.scheduleDelivery({
    deliverAt: 10,
    link: linkB,
    seq: 0,
    run: () => {
      order.push('B')
    },
  })
  clock.scheduleDelivery({
    deliverAt: 10,
    link: linkA,
    seq: 0,
    run: () => {
      order.push('A')
    },
  })

  await clock.advanceTo(10)
  expect(order).toEqual(['A', 'B'])
})

test('virtual-clock: a delivery scheduled from inside a release still settles by the same advanceTo', async () => {
  const clock = createVirtualClock()
  const order: string[] = []
  const link = clock.nextLinkId()

  clock.scheduleDelivery({
    deliverAt: 5,
    link,
    seq: 0,
    run: () => {
      order.push('first')
      clock.scheduleDelivery({
        deliverAt: 8,
        link,
        seq: 0,
        run: () => {
          order.push('chained')
        },
      })
    },
  })

  await clock.advanceTo(10)
  expect(order).toEqual(['first', 'chained'])
})

test('virtual-clock: advanceBy is relative to now()', async () => {
  const clock = createVirtualClock(100)
  const order: number[] = []
  const link = clock.nextLinkId()
  clock.scheduleDelivery({
    deliverAt: 140,
    link,
    seq: 0,
    run: () => {
      order.push(clock.now())
    },
  })

  await clock.advanceBy(50)
  expect(clock.now()).toBe(150)
  expect(order).toEqual([140])
})

test('virtual-clock: still a ManualClock -- setTimer fires through advanceTo', async () => {
  const clock = createVirtualClock()
  let fired = false
  clock.setTimer(() => {
    fired = true
  }, 10)
  await clock.advanceTo(10)
  expect(fired).toBe(true)
})

test('virtual-clock: refuses to advance backward', async () => {
  const clock = createVirtualClock(50)
  await expect(clock.advanceTo(10)).rejects.toThrow()
})

test('virtual-clock: awaits an async run() before releasing the next entry', async () => {
  const clock = createVirtualClock()
  const order: string[] = []
  const link = clock.nextLinkId()
  const resolver: { fn: (() => void) | null } = { fn: null }

  clock.scheduleDelivery({
    deliverAt: 5,
    link,
    seq: 0,
    run: () =>
      new Promise<void>((resolve) => {
        resolver.fn = () => {
          order.push('first')
          resolve()
        }
      }),
  })
  clock.scheduleDelivery({
    deliverAt: 5,
    link,
    seq: 1,
    run: () => {
      order.push('second')
    },
  })

  const done = clock.advanceTo(5)
  // Give the microtask queue a turn: `second` must not have run yet, since `first`'s own promise
  // has not resolved.
  await Promise.resolve()
  expect(order).toEqual([])

  resolver.fn?.()
  await done
  expect(order).toEqual(['first', 'second'])
})
