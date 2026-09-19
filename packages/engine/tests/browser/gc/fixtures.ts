// Small canned CDP captures for `analyse.test.ts`: real shapes (HeapProfiler sampling profile,
// Tracing.dataCollected events), trimmed to a handful of nodes/events. Not related to
// `tests/support/fixtures.ts` (engine fixture *crates*); this is gc-specific.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Profile, TraceEvent } from './analyse.ts'

const dataDir = fileURLToPath(new URL('./data/', import.meta.url))

export function profileSample(): Profile {
  return JSON.parse(readFileSync(`${dataDir}profile-sample.json`, 'utf8')) as Profile
}

export function traceSample(): TraceEvent[] {
  return JSON.parse(readFileSync(`${dataDir}trace-sample.json`, 'utf8')) as TraceEvent[]
}
