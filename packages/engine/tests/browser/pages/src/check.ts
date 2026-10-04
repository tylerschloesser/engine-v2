// `window.__check`: the reporter `pnpm device:walk --auto` reads (docs/plan/39f-device-auto-runner.md,
// "The check reporter contract"). Fixture pages only: this file is imported by pages under
// `tests/browser/pages/`, never by `src/` or a game, so no release build contains `__check` (the netcode
// test `walk-preview: no production output contains the check reporter` reads the built output).
//
// The service decides pass or fail from `scripts/lib/device-walk/checks.mjs`; a page only reports
// numbers. `readings()` is flat and JSON-safe, called at most once a second by a human-rate caller, so it
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
