import { expect, test } from 'vitest'
import { ownTimerMs } from './own-timer.js'

test('own_timer_bar_ends_on_the_authoritative_clock', () => {
  // A collect (40 ticks at 20 Hz) predicted at tick 108 with a lead of 8: `done_at` 148. Read on the first
  // Ui after the tap, the authoritative clock is at 100.5, so the bar runs 47.5 ticks (duration + lead,
  // less the half tick already gone), not the 40 that `done_at - predicted` gives.
  const clock = { authoritative: 100, predicted: 108, tickFraction: 0.5, ticksPerSecond: 20 }
  expect(ownTimerMs(148, clock)).toBe(2375)
})

test('own_timer_bar_is_zero_once_done', () => {
  const clock = { authoritative: 150, predicted: 158, tickFraction: 0.25, ticksPerSecond: 20 }
  expect(ownTimerMs(148, clock)).toBe(0)
})
