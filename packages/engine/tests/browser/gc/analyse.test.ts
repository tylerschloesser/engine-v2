import { expect, test } from 'vitest'
import {
  analyseTrace,
  attributedBytes,
  sumProfile,
  tracingStallWarning,
  verdict,
} from './analyse.ts'
import { profileSample, traceSample } from './fixtures.ts'

test('gc analyse: sums selfSize exactly', () => {
  const { total, byFn } = sumProfile(profileSample())
  expect(total).toBe(22) // 10 (idle) + 5 (harnessWorkerStep) + 7 (inner)
  expect(byFn['idle@harness.js:4']).toBe(10)
  expect(byFn['harnessWorkerStep@harness-worker.js:13']).toBe(5)
  expect(byFn['inner@loader.js:41']).toBe(7)
})

// docs/decisions/0028-zero-gc-two-measured-windows.md, superseding 0027: no call frame is exempt
// from the byte total -- not `waitForWake`, which 0027 briefly excluded by name, and not any other.
// The one-off V8 tier-up burst 0027 was written to remove is billed to an arbitrary frame (measured
// on seven different ones), so it is separated by the two-window minimum in `measure()` instead.
// This test is what keeps a name-based exemption from coming back into `sumProfile`.
test('gc analyse: no call frame is exempt from the total, waitForWake included', () => {
  const profile = {
    head: {
      selfSize: 0,
      callFrame: { functionName: '(root)', url: '', lineNumber: 0 },
      children: [
        {
          selfSize: 100,
          callFrame: { functionName: 'drive', url: 'gc-input.js', lineNumber: 60 },
        },
        {
          selfSize: 13544,
          callFrame: { functionName: 'waitForWake', url: 'worker-auto.js', lineNumber: 42 },
        },
      ],
    },
  }
  const { total, byFn } = sumProfile(profile)
  expect(total).toBe(13644) // every sampled byte counts, waitForWake's 13544 included
  expect(byFn['waitForWake@worker-auto.js:43']).toBe(13544)
  expect(byFn['drive@gc-input.js:61']).toBe(100)
})

test('gc analyse: inclusive attribution under roots', () => {
  const total = attributedBytes(profileSample(), ['harnessWorkerStep'])
  // harnessWorkerStep (5) + its child inner (7); idle (10) is not under the root.
  expect(total).toBe(12)
  expect(attributedBytes(profileSample(), [])).toBe(0)
})

test('gc analyse: GC events outside the marks are ignored', () => {
  const { outside } = analyseTrace(traceSample())
  // The MajorGC at ts=500 (before window-start) counts as outside; the one on a different pid
  // (999) is a different renderer process entirely and is not counted at all.
  expect(outside).toEqual({ MinorGC: 0, MajorGC: 1 })
})

test('gc analyse: events are attributed to named isolates', () => {
  const { gc, windowMs, traceEvents } = analyseTrace(traceSample())
  // The in-window MinorGC (ts=1500) is on tid=2, named 'sim' by its gc-isolate mark; its
  // matching 'E'-phase duplicate (ts=1501) is not double-counted.
  expect(gc.sim).toEqual({ MinorGC: 1, MajorGC: 0 })
  expect(gc.main).toBeUndefined()
  expect(windowMs).toBe(1)
  expect(traceEvents).toBe(traceSample().length)
})

test('gc analyse: presentIsolates finds every named thread, even one marked before window-start', () => {
  // trace-sample.json's own gc-isolate marks (ts 998/999) both precede window-start (ts 1000) --
  // the real shape (gate round 3, docs/plan/09-renderer-terrain.md Deviations): a worker's naming
  // mark is always sent before `window.__gc.run`'s own window-start mark.
  const { presentIsolates } = analyseTrace(traceSample())
  expect(presentIsolates).toEqual(new Set(['main', 'sim']))
})

test('gc verdict: software mode uses attributed bytes', () => {
  const page = {
    isolates: {
      sim: {
        class: 'strict' as const,
        bytesPerFrame: 8,
        formula: 'measured',
        attributionRoots: ['tick'],
      },
    },
    software: { isolates: { sim: { attributedBytesPerFrame: 10 } } },
  }
  const passing = verdict(
    { frames: 100, gc: {}, totalBytes: { sim: 100_000 }, attributedBytesTotal: { sim: 900 } },
    page,
    'software',
  )
  // Hardware total (100000/100=1000) would fail 8 B/frame; software mode ignores it and uses
  // attributedBytesTotal (900/100=9 <= 10) instead.
  expect(passing).toEqual({ pass: true, A: { sim: true }, B: { sim: true } })

  const failing = verdict(
    { frames: 100, gc: {}, totalBytes: { sim: 0 }, attributedBytesTotal: { sim: 1_100 } },
    page,
    'software',
  )
  expect(failing.B.sim).toBe(false)
  expect(failing.pass).toBe(false)
})

test('gc verdict: tracing stall is a warning', () => {
  expect(tracingStallWarning(2500)).toBe('gc-tracing-start-stall 2500ms')
  expect(tracingStallWarning(1999)).toBeNull()
})
