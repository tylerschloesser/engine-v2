import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import {
  analyseTrace,
  attributedBytes,
  lowerWindow,
  MEASURED_FRAMES,
  measuredWindows,
  sumProfile,
  tracingStallWarning,
  verdict,
  WARMUP,
  WARMUP_PASSES,
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

test('gc verdict: software mode uses attributed bytes on main only', () => {
  const page = {
    isolates: {
      main: {
        class: 'strict' as const,
        bytesPerFrame: 8,
        formula: 'measured',
        attributionRoots: ['drive'],
      },
    },
    software: { isolates: { main: { attributedBytesPerFrame: 10 } } },
  }
  const passing = verdict(
    { frames: 100, gc: {}, totalBytes: { main: 100_000 }, attributedBytesTotal: { main: 900 } },
    page,
    'software',
  )
  // Hardware total (100000/100=1000) would fail 8 B/frame; software mode ignores it and uses
  // attributedBytesTotal (900/100=9 <= 10) instead.
  expect(passing).toEqual({ pass: true, A: { main: true }, B: { main: true } })

  const failing = verdict(
    { frames: 100, gc: {}, totalBytes: { main: 0 }, attributedBytesTotal: { main: 1_100 } },
    page,
    'software',
  )
  expect(failing.B.main).toBe(false)
  expect(failing.pass).toBe(false)
})

test('gc verdict: software mode uses raw bytes on every isolate but main (orchestrator decision, docs/plan/10-ci-workflow.md)', () => {
  const page = {
    isolates: {
      main: {
        class: 'strict' as const,
        bytesPerFrame: 200,
        formula: 'measured',
        attributionRoots: ['drive'],
      },
      client: {
        class: 'strict' as const,
        bytesPerFrame: 8,
        formula: 'measured',
        attributionRoots: ['body'],
      },
    },
    software: { isolates: { main: { attributedBytesPerFrame: 10 } } },
  }
  // `client`'s attributedBytesTotal is deliberately 0 (the exact `topology client` inlining
  // finding: a control's real allocation not landing under the named root) -- if software mode
  // read attribution for `client`, this would incorrectly pass. It must instead compare the raw
  // total (1000/100=10) against `client`'s own hardware budget (8) and fail.
  const result = verdict(
    {
      frames: 100,
      gc: {},
      totalBytes: { main: 900, client: 1_000 },
      attributedBytesTotal: { main: 900, client: 0 },
    },
    page,
    'software',
  )
  expect(result.B).toEqual({ main: true, client: false })
  expect(result.pass).toBe(false)

  // No `software.isolates.client` entry exists at all above, and no error was thrown for it:
  // proof the worker path never consults `page.software`.
})

test('gc verdict: a non-main isolate can get its own raw software-mode ceiling (M29b fix round 4)', () => {
  const page = {
    isolates: {
      main: {
        class: 'strict' as const,
        bytesPerFrame: 200,
        formula: 'measured',
        attributionRoots: ['drive'],
      },
      net: {
        class: 'budgeted' as const,
        bytesPerFrame: 226,
        formula: 'measured',
        attributionRoots: ['linkControl'],
      },
    },
    software: {
      isolates: {
        main: { attributedBytesPerFrame: 10 },
        net: { bytesPerFrame: 400 },
      },
    },
  }
  // `net`'s raw total (243.47*100=24347/100=243.47) exceeds the shared hardware ceiling (226) but
  // is within its own, wider software-mode row (400) -- the exact CI shape this test pins.
  const passing = verdict(
    {
      frames: 100,
      gc: {},
      totalBytes: { main: 900, net: 24_347 },
      attributedBytesTotal: { main: 900 },
    },
    page,
    'software',
  )
  expect(passing.B).toEqual({ main: true, net: true })
  expect(passing.pass).toBe(true)

  // Still trips above its own software ceiling, not just above the hardware one.
  const failing = verdict(
    {
      frames: 100,
      gc: {},
      totalBytes: { main: 900, net: 40_001 },
      attributedBytesTotal: { main: 900 },
    },
    page,
    'software',
  )
  expect(failing.B.net).toBe(false)

  // Hardware mode is unaffected: `net`'s own software row is never consulted, the shared 226
  // ceiling applies exactly as it always has.
  const hardware = verdict(
    { frames: 100, gc: {}, totalBytes: { main: 100, net: 24_347 } },
    page,
    'hardware',
  )
  expect(hardware.B.net).toBe(false) // 243.47 > 226, the hardware ceiling, unchanged
})

test('gc verdict: a wide software-mode ceiling never applies to the isolate a control is actually targeting (M29b fix round 4, regression)', () => {
  // The exact bug found live: giving `net` a wide 660 B/frame software row with no `verdictIsolate`
  // awareness made `gc/net-negative-control` (whose own real defect measures ~238 B/frame under
  // forced software mode, comfortably above the 226 hardware ceiling but well under 660) silently
  // stop tripping -- `pnpm exec playwright test --grep net-negative-control` failed 5/5 under forced
  // `GC_MODE=software` before `verdictIsolate` existed.
  const page = {
    isolates: {
      net: {
        class: 'budgeted' as const,
        bytesPerFrame: 226,
        formula: 'measured',
        attributionRoots: ['linkControl'],
      },
    },
    software: { isolates: { net: { bytesPerFrame: 660 } } },
  }
  // 238 B/frame: over the hardware ceiling (226), comfortably under the wide software one (660).
  const input = { frames: 100, gc: {}, totalBytes: { net: 23_800 } }

  // No `verdictIsolate` (a sibling's own control, or a clean run): the wide ceiling applies, and
  // this reading -- net's own *real* defect magnitude -- would incorrectly pass if it ever showed
  // up here instead of under `net`'s own control.
  const collateral = verdict(input, page, 'software', null)
  expect(collateral.B.net).toBe(true)

  // `verdictIsolate: 'net'` (net's own control, `gc/net-negative-control`'s own real shape): falls
  // back to the tight hardware ceiling, and the same reading correctly trips.
  const ownControl = verdict(input, page, 'software', 'net')
  expect(ownControl.B.net).toBe(false)
})

test('gc verdict: tracing stall is a warning', () => {
  expect(tracingStallWarning(2500)).toBe('gc-tracing-start-stall 2500ms')
  expect(tracingStallWarning(1999)).toBeNull()
})

// 0016 §3 step 5 and 0028 §3: N is 600 frames in each of two consecutive windows, and only window 2
// is marked (assertion A counts GC events over exactly one window). `instrument.ts` drives both
// `run()` calls from this plan, which the source assertion pins.
test('gc analyse: two measured windows of 600 frames, only the second marked', () => {
  expect(MEASURED_FRAMES).toBe(600)
  expect(measuredWindows(MEASURED_FRAMES)).toEqual([
    { frames: 600, marks: false },
    { frames: 600, marks: true },
  ])
  const instrument = readFileSync(new URL('./instrument.ts', import.meta.url), 'utf8')
  expect(instrument).toContain('const [window1, window2] = measuredWindows(frames)')
  expect(instrument.match(/window\.__gc\?\.run\(w\.frames, w\.marks\), window1\)/g)).toHaveLength(1)
  expect(instrument.match(/window\.__gc\?\.run\(w\.frames, w\.marks\), window2\)/g)).toHaveLength(1)
})

// 0028 §1: the lower of the two windows' totals wins; its profile is what is read afterwards.
test('gc analyse: the lower of the two windows is selected per isolate', () => {
  const w1 = { name: 'window 1' }
  const w2 = { name: 'window 2' }
  expect(lowerWindow([100, 200], w1, w2)).toBe(w1)
  expect(lowerWindow([300, 200], w1, w2)).toBe(w2)
  expect(lowerWindow([200, 200], w1, w2)).toBe(w1) // a tie keeps the first
  const instrument = readFileSync(new URL('./instrument.ts', import.meta.url), 'utf8')
  expect(instrument).toContain('rawProfiles[name] = lowerWindow(totals, first, second)')
})

// M39ah: software-mode attribution takes the 0028 minimum over the attributed bytes themselves, not
// over the raw totals (a one-off first-window `Atomics.load` allocation under `drive` flipped
// `sim neg object sim`'s `main` verdict on CI whenever that window's raw total was the lower one).
test('gc analyse: attributed bytes are the lower of the two windows (M39ah)', () => {
  const instrument = readFileSync(new URL('./instrument.ts', import.meta.url), 'utf8')
  expect(instrument).toContain('attributedWindows[name] = [attributedBytes(first, roots)')
  expect(instrument).toContain('Math.min(attributedFirst, attributedSecond)')
})

// 0016 §3 step 3 as amended by ADR 0052: 4000 warm-up frames in 8 passes (500 each), then the
// 600-frame windows pinned above. Literals, so a shortened warm-up fails here.
test('gc analyse: warm-up is 4000 frames in 8 passes (ADR 0052)', () => {
  expect(WARMUP).toBe(4000)
  expect(WARMUP_PASSES).toBe(8)
  const instrument = readFileSync(new URL('./instrument.ts', import.meta.url), 'utf8')
  expect(instrument).toContain('WARMUP / WARMUP_PASSES')
})
