// The length of a bar for a timer the local player owns (collect, craft): ADR 0064 §2 "stretch". The bar
// starts at the tap and runs over `duration + lead`, so it is full when the host's result can arrive: it
// ends when the *authoritative* clock reaches `done_at` (the end point of the engine's `own_progress`).
// `done_at - predicted` (what both bars used until 2026-10-10) ends `lead` ticks early and leaves a full
// bar waiting for the result (measured on desktop Chrome: full 300-350 ms before it).
import type { ClockSnapshot } from 'engine'

/** Milliseconds from now until the authoritative clock reaches `doneAt`; `0` when it already has. */
export function ownTimerMs(doneAt: number, clock: ClockSnapshot): number {
  const ticks = doneAt - clock.authoritative - clock.tickFraction
  return Math.max(0, (ticks / Math.max(1, clock.ticksPerSecond)) * 1000)
}
