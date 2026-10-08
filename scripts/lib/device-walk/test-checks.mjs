// A pristine copy of docs/plan/device-checks.md for tests (M39ad): every ticked item unticked and each section's
// Run on lines collapsed to the one placeholder line. Real `--apply` rounds tick the live file and add Run on
// lines; the tests that apply a synthetic round to a copy must not depend on that state. The item text and the
// pass hashes stay the file's own, so the tests stay live against the real checklist.
import { readFileSync, writeFileSync } from 'node:fs'

const PLACEHOLDER =
  '**Run on:** <device, OS, date>; **result:** <PASS / FAIL, notes, plan edit link>'

/** `text` of device-checks.md with ticks removed and the Run on lines of each section collapsed to a placeholder. */
export function pristineChecks(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (line.startsWith('**Run on:**')) {
      if (!out.length || out[out.length - 1] !== PLACEHOLDER) out.push(PLACEHOLDER)
      continue
    }
    out.push(line.replace(/^(\s*- )\[[xX]\]/, '$1[ ]'))
  }
  return out.join('\n')
}

export const readPristineChecks = (path) => pristineChecks(readFileSync(path, 'utf8'))

/** Write the pristine copy of `from` to `to`. */
export function copyPristineChecks(from, to) {
  writeFileSync(to, readPristineChecks(from))
}
