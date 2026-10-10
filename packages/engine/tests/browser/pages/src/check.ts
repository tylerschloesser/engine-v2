// `window.__check`: the reporter the phone-round tool read (M39f, "The check reporter contract"; the
// tool was deleted in Phase 4, ADR 0070). Fixture pages only: this file is imported by pages under
// `tests/browser/pages/`, never by `src/` or a game, so no release build contains `__check` (the netcode
// test `check-reporter-absent` reads the built output).
//
// A page only reports numbers; the reader decides pass or fail. `readings()` is flat and JSON-safe, called at most once a second by a human-rate caller, so it
// may allocate: a diagnostic page is outside `.claude/rules/hot-paths.md`, as `device.ts`'s header says.
export type CheckReading = number | string | boolean | null | string[]

export type CheckReporter = {
  /** Same moment as `window.__pageReady`. */
  ready: boolean
  /** `'device'`, `'slice'`, `'world'`, `'mp'`, ... */
  page: string
  readings(): Record<string, CheckReading>
  /** The page's own error channel (`device.errors()`). */
  errors(): string[]
  /** Scripted drivers a collector calls (`paint`, `flick`, a sweep): the brief's `act`, one async function each. */
  act?: Record<string, (arg?: unknown) => Promise<unknown>>
}

declare global {
  interface Window {
    __check?: CheckReporter
  }
}

/** Install `window.__check` for `page`; the page fills `readings`/`errors` and sets `ready` last. */
export function installCheck(page: string): CheckReporter {
  const check: CheckReporter = { ready: false, page, readings: () => ({}), errors: () => [] }
  window.__check = check
  return check
}

/** Three decimals: readings are numbers for a table, not for arithmetic. */
export const r3 = (n: number): number => Math.round(n * 1000) / 1000
