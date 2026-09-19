import { expect, test } from 'vitest'
import { createManualClock } from './manual-clock.js'

test('manual clock: timers fire in deadline order', () => {
  const clock = createManualClock()
  const order: string[] = []
  clock.setTimer(() => order.push('b'), 20)
  clock.setTimer(() => order.push('a'), 10)
  clock.setTimer(() => order.push('c'), 20) // same deadline as b, registered after: fires after b
  clock.setTimer(() => order.push('late'), 30)

  clock.advance(20)

  expect(order).toEqual(['a', 'b', 'c'])
  expect(clock.now()).toBe(20)
})

test('manual clock: frame runs callbacks once', () => {
  const clock = createManualClock()
  let calls = 0
  let reregistered = 0
  const requestNext = (): void => {
    clock.requestFrame(() => {
      reregistered++
    })
  }
  clock.requestFrame((tMs) => {
    calls++
    expect(tMs).toBe(16)
    requestNext()
  })

  clock.frame(16)
  expect(calls).toBe(1)
  expect(reregistered).toBe(0) // registered during the frame: not this frame's callback

  clock.frame(16)
  expect(calls).toBe(1)
  expect(reregistered).toBe(1)
  expect(clock.now()).toBe(32)
})

test('manual clock: cancel', () => {
  const clock = createManualClock()
  let timerFired = false
  let frameFired = false
  const timerId = clock.setTimer(() => {
    timerFired = true
  }, 10)
  const frameId = clock.requestFrame(() => {
    frameFired = true
  })

  clock.clearTimer(timerId)
  clock.cancelFrame(frameId)

  clock.advance(20)
  clock.frame(0)

  expect(timerFired).toBe(false)
  expect(frameFired).toBe(false)
})
