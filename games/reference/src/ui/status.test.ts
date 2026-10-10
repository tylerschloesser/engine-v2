// `statusText` (M34 Scope: link status): pure mapping, no DOM.
import { expect, test } from 'vitest'
import { linkLogRow, startFailureText, statusText } from './status.js'

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

test('startFailureText: a line for the two refused starts, nothing for other codes', () => {
  expect(startFailureText('world-busy')).toMatch(/another tab/)
  expect(startFailureText('save-incompatible')).toMatch(/Export/)
  expect(startFailureText('worker-fatal')).toBeNull()
})

test('linkLogRow: the columns of mp.html?linklog=1 (event, state, code, ms since visible)', () => {
  expect(linkLogRow('link', 'online', 1234.6)).toBe(
    'link       online       code=- sinceVisible=1235ms',
  )
})
