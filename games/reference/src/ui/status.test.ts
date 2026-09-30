// `statusText` (docs/plan/34-reference-multiplayer.md Scope: link status): pure mapping, no DOM.
import { expect, test } from 'vitest'
import { statusText } from './status.js'

test('statusText: nothing when online, a line for every other state and refusal', () => {
  expect(statusText('online')).toBeNull()
  for (const state of ['connecting', 'reconnecting', 'updating', 'superseded'] as const) {
    expect(statusText(state)).toEqual(expect.any(String))
  }
  const refused = (['BadKey', 'Full', 'WorldMismatch'] as const).map((r) =>
    statusText('rejected', r),
  )
  expect(new Set(refused).size).toBe(3)
  expect(refused.every((t) => typeof t === 'string')).toBe(true)
})
