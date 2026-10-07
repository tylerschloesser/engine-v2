// M39f steps 10-12: the service side of the reference game's checks (checks.mjs entries and auto-round.mjs):
// M35 and M37b on the release build (DOM only), M39-large-save and M39-frame-shares on the bench build, M34
// against the bot partner. Criteria evaluation at, above and below each limit; the Mac-row rule.
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, test } from 'vitest'
import { applyRound } from './device-walk/apply.mjs'
import { createAutoRound } from './device-walk/auto-round.mjs'
import { createBots, phoneSeen } from './device-walk/bot.mjs'
import { analyseFade, analyseMotion, CHECKS, evaluate, MP_TILES } from './device-walk/checks.mjs'
import { parseChecks } from './device-walk/parse.mjs'
import { appendEvent, readEvents, replay } from './device-walk/rounds.mjs'

const { items } = parseChecks(
  readFileSync(new URL('../../docs/plan/device-checks.md', import.meta.url), 'utf8'),
)
const ok = (r, name) => r.criteria.find((c) => c.name === name)?.ok

const dom = (over = {}) => ({
  capability: false,
  fatal: false,
  canvas: true,
  canvas_w: 1170,
  canvas_h: 2532,
  delivery_line: false,
  ...over,
})
const m35 = (over = {}, gpu = {}, extra = {}) => ({
  ready: true,
  dom: dom(over),
  raf: { p50: 16.7, p95: 16.9, max: 20, long25: 0, frames: 480 },
  gpu: { devices: 1, errors: 0, lost: 0, ...gpu },
  reloads: 0,
  ...extra,
})

describe('device-walk reference', () => {
  test('device-walk reference: M35 passes only on a clean DOM and device, and always asks for the confirm tap', () => {
    for (const id of ['M35-safari-build-mac', 'M35-safari-build-iphone']) {
      const clean = evaluate(CHECKS[id], m35())
      expect(clean.verdict, id).toBe('judge') // every hard row ok, "world drawn" is the person's
      expect(clean.criteria.filter((c) => c.ok === false)).toEqual([])
      expect(ok(clean, 'world_drawn')).toBe(null)
      expect(clean.metrics.raf_p95_ms).toBe(16.9)
    }
    const e = CHECKS['M35-safari-build-iphone']
    expect(ok(evaluate(e, m35({ capability: true })), 'capability_screen')).toBe(false)
    expect(ok(evaluate(e, m35({ fatal: true })), 'fatal_screen')).toBe(false)
    expect(ok(evaluate(e, m35({ canvas: false })), 'canvas_present')).toBe(false)
    expect(ok(evaluate(e, m35({ delivery_line: true })), 'delivery_line_absent')).toBe(false)
    expect(ok(evaluate(e, m35({}, { errors: 1 })), 'gpu_errors')).toBe(false)
    expect(ok(evaluate(e, m35({}, { lost: 1 })), 'device_lost')).toBe(false)
    expect(evaluate(e, m35({}, {}, { reloads: 1 })).verdict).toBe('fail')
    expect(evaluate(e, { ready: false }).verdict).toBe('fail') // no data at all is a failure, never a pass
  })

  const run = (over = {}) => ({
    run: 1,
    ms: 180_000,
    deviceLost: 1,
    gpuErrors: 0,
    rendererLost: false,
    rafResumed: true,
    frozen: false,
    ...over,
  })
  test('device-walk reference: M37b needs three runs, none frozen or black, no reload; the banner is allowed', () => {
    const e = CHECKS['M37b-ios-background']
    const three = [run(), run({ run: 2 }), run({ run: 3, rendererLost: true })]
    const good = evaluate(e, { runs: three, reloads: 0 })
    expect(good.verdict).toBe('judge') // drawn-again is the person's, per run
    expect(good.criteria.filter((c) => c.ok === false)).toEqual([])
    expect(good.metrics).toMatchObject({ device_lost_total: 3, renderer_lost_banners: 1 })
    expect(ok(evaluate(e, { runs: three.slice(0, 2), reloads: 0 }), 'runs_done')).toBe(false)
    const frozen = [...three.slice(0, 2), run({ run: 3, frozen: true })]
    expect(ok(evaluate(e, { runs: frozen, reloads: 0 }), 'black_or_frozen_runs')).toBe(false)
    // A tab Safari discarded: the reload report carries the runs that finished, and it is the failure.
    const killed = evaluate(e, {
      ready: false,
      reloaded: true,
      reloads: 1,
      runs: three.slice(0, 1),
    })
    expect(killed.verdict).toBe('fail')
    expect(ok(killed, 'reloads')).toBe(false)
  })

  const hud = (over = {}) => ({
    engine_mem_grows_sim: 0,
    engine_mem_grows_client: 0,
    tick_p95_ms: 4.2,
    main_p95_ms: 1.1,
    frame_p95_ms: 2.9,
    ...over,
  })
  const bench = (steady, final = steady.at(-1)) => ({
    ready: true,
    steady,
    final,
    windows: [{ raf: { long25: 0, max: 17, frames: 600 } }],
    reloads: 0,
  })
  test('device-walk reference: bench limits at, above and below (tick 10 ms; main 4 ms; client frame 8 ms) and the memory counters', () => {
    const large = CHECKS['M39-large-save']
    const shares = CHECKS['M39-frame-shares']
    expect(evaluate(large, bench([hud({ tick_p95_ms: 10 })])).verdict).toBe('pass')
    expect(ok(evaluate(large, bench([hud({ tick_p95_ms: 10.01 })])), 'tick_p95_ms')).toBe(false)
    // The worst steady window is read, not the last one.
    expect(
      ok(
        evaluate(large, bench([hud({ tick_p95_ms: 11 }), hud({ tick_p95_ms: 3 })])),
        'tick_p95_ms',
      ),
    ).toBe(false)
    const grew = hud({ engine_mem_grows_client: 1 })
    expect(ok(evaluate(large, bench([grew])), 'engine_mem_grows_client')).toBe(false)
    expect(ok(evaluate(large, bench([hud()])), 'engine_mem_grows_sim')).toBe(true)
    expect(evaluate(large, { ...bench([hud()]), reloads: 1 }).verdict).toBe('fail')
    expect(evaluate(large, { ready: false, steady: [], windows: [] }).verdict).toBe('fail')
    expect(evaluate(shares, bench([hud({ main_p95_ms: 4, frame_p95_ms: 8 })])).verdict).toBe('pass')
    expect(ok(evaluate(shares, bench([hud({ main_p95_ms: 4.01 })])), 'main_p95_ms')).toBe(false)
    expect(ok(evaluate(shares, bench([hud({ frame_p95_ms: 8.01 })])), 'frame_p95_ms')).toBe(false)
  })

  test('device-walk reference: the Run on numbers of the two bench rows are the ones the acceptance rows cite', () => {
    const r = evaluate(
      CHECKS['M39-large-save'],
      bench([hud({ tick_p95_ms: 6 }), hud({ tick_p95_ms: 5 })], hud({ tick_p95_ms: 5 })),
    )
    // `tick p95` (Tick time: phone sim worker), the memory counters of the Pass text, in HUD names.
    expect(r.metrics).toMatchObject({
      tick_p95_ms: 6,
      tick_p95_ms_last: 5,
      engine_mem_grows_sim: 0,
      engine_mem_grows_client: 0,
    })
    const f = evaluate(
      CHECKS['M39-frame-shares'],
      bench([hud({ main_p95_ms: 2, frame_p95_ms: 3 })]),
    )
    expect(f.metrics).toMatchObject({ main_p95_ms: 2, frame_p95_ms: 3 })
  })

  test('device-walk reference: --apply writes the numbers the phone Frame time and Tick time rows will cite into Run on', () => {
    const text = readFileSync(new URL('../../docs/plan/device-checks.md', import.meta.url), 'utf8')
    const ids = ['M39-large-save', 'M39-frame-shares']
    const sel = parseChecks(text).items.filter((i) => ids.includes(i.id))
    const large = evaluate(CHECKS['M39-large-save'], bench([hud({ tick_p95_ms: 6.5 })]))
    const shares = evaluate(
      CHECKS['M39-frame-shares'],
      bench([hud({ main_p95_ms: 1.25, frame_p95_ms: 3.5 })]),
    )
    const events = [
      { type: 'start', only: ids, mode: 'auto' },
      { type: 'result', id: 'M39-large-save', result: 'pass', by: 'auto', metrics: large.metrics },
      {
        type: 'result',
        id: 'M39-frame-shares',
        result: 'pass',
        by: 'auto',
        metrics: shares.metrics,
      },
    ]
    const { text: out } = applyRound(text, replay(events, sel), { round: 'demo', overrides: {} })
    const line = out
      .split('\n')
      .find((l) => l.startsWith('**Run on:**') && l.includes('M39-large-save PASS'))
    // Tick time: phone sim worker <- tick p95; Frame time: main rAF callback / client-worker frame <- main p95, frame p95.
    expect(line).toContain('M39-large-save PASS (numbers: tick_p95_ms_last=')
    expect(line).toMatch(/M39-large-save PASS \(numbers: [^)]*\btick_p95_ms=6\.5\b/)
    expect(line).toMatch(/engine_mem_grows_sim=0, engine_mem_grows_client=0/)
    expect(line).toMatch(/M39-frame-shares PASS \(numbers: [^)]*\bmain_p95_ms=1\.25\b/)
    expect(line).toMatch(/M39-frame-shares PASS \(numbers: [^)]*\bframe_p95_ms=3\.5\b/)
  })
})

describe('device-walk reference: which client walks a row', () => {
  function rig(ids, params = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'walk-ref-'))
    const file = join(dir, 'r.jsonl')
    mkdirSync(join(dir, 's'))
    const origins = { reference: 'http://127.0.0.1:1' }
    const m = createAutoRound({
      file,
      items: items.filter((i) => ids.includes(i.id)),
      origins,
      params,
    })
    m.attach({ append: (e) => appendEvent(file, e) })
    const events = () => readEvents(file)
    appendEvent(file, { type: 'walk', phase: 'start', src: { tab: 't', seq: 1 } })
    m.settle()
    return { m, events, results: () => events().filter((e) => e.type === 'result') }
  }

  test('device-walk reference: a Mac row is skipped on a phone with its reason, and walked by a Mac client', () => {
    const phone = rig(['M35-safari-build-mac', 'M35-safari-build-iphone'])
    expect(phone.m.variants()).toEqual(['reference'])
    const mac = phone.results().find((e) => e.id === 'M35-safari-build-mac')
    expect(mac).toMatchObject({ result: 'skip', by: 'auto' })
    expect(mac.notes).toMatch(/Mac browser row/)
    expect(
      phone.events().find((e) => e.type === 'attempt' && e.id === 'M35-safari-build-iphone'),
    ).toMatchObject({ n: 1, page: '', variant: 'reference' })

    const onMac = rig(['M35-safari-build-mac'], { client: 'mac' })
    expect(onMac.results()).toEqual([])
    expect(onMac.events().find((e) => e.type === 'attempt')).toMatchObject({
      id: 'M35-safari-build-mac',
      n: 1,
    })
  })
})

describe('device-walk reference: M34 (the bot partner)', () => {
  const snap = CHECKS['M34-remote-motion'].plan.snap
  // A circle walking at a steady 0.1 tile a frame.
  const smooth = Array.from({ length: 60 }, (_, i) => [i * 16, i * 0.1, 0])

  test('device-walk reference: a steady walk has no snap, a hold-then-jump walk and a teleport do', () => {
    expect(analyseMotion(smooth, snap)).toMatchObject({ frames: 60, snaps: 0, travelTiles: 5.9 })
    // A fast steady walk (0.5 tile a frame, above the floor) is not a snap either: the step is what is expected.
    const fast = smooth.map(([t], i) => [t, i * 0.5, 0])
    expect(analyseMotion(fast, snap)).toMatchObject({ snaps: 0, maxJumpTiles: 0.5 })
    // The same distance in steps every six frames (a circle that only moves when a sample arrives).
    const steps = smooth.map(([t, x], i) => [t, Math.floor(i / 6) * 0.6, 0].slice(0, 3))
    expect(analyseMotion(steps, snap).snaps).toBeGreaterThan(5)
    const teleport = smooth.map(([t, x], i) => [t, i < 30 ? x : x + 4, 0])
    expect(analyseMotion(teleport, snap)).toMatchObject({ snaps: 1, maxJumpTiles: 4.1 })
    // A circle at rest is not a snap (its median step is 0: the floor), and nothing drawn is nothing moved.
    expect(
      analyseMotion(
        smooth.map(([t]) => [t, 3, 3]),
        snap,
      ),
    ).toMatchObject({ snaps: 0 })
    expect(analyseMotion([], snap)).toMatchObject({ frames: 0, snaps: 0, travelTiles: 0 })
  })

  // 39l: a 60 Hz series at 12 tiles/s (a sweep of +-6 tiles) is drawn every frame; the same path sampled at
  // each 10 Hz presence sample is a staircase. `seq` (the fourth column) is the DrawList's frame_seq.
  const sweep = (hold) =>
    Array.from({ length: 360 }, (_, i) => {
      const at = hold ? Math.floor(i / 6) * 6 : i
      return [Math.round(i * 16.667), +(6 * Math.sin((2 * at) / 60)).toFixed(3), 0, i]
    })

  test('device-walk reference: a smooth 12 tiles/s series moves on every frame; a 10 Hz staircase and the real m39j series do not', () => {
    expect(analyseMotion(sweep(false), snap)).toMatchObject({
      movingFramesChangedRatio: 1,
      maxStillMs: 0,
      repeatedFrames: 0,
    })
    const stairs = analyseMotion(sweep(true), snap)
    expect(stairs.movingFramesChangedRatio).toBeLessThan(0.25)
    expect(stairs.maxStillMs).toBeGreaterThanOrEqual(83)
    const real = JSON.parse(
      readFileSync(new URL('./fixtures/m39j-remote-motion-frames.json', import.meta.url), 'utf8'),
    )
    const m = analyseMotion(real.motionFrames, snap)
    expect(m.movingFramesChangedRatio).toBeLessThan(0.2)
    expect(m.maxStillMs).toBeGreaterThan(80)
    expect(m.snaps).toBe(46)
    // The criteria turn the same series into a failure; the smooth one passes them.
    const e = CHECKS['M34-remote-motion']
    const crit = (r, n) => r.criteria.find((c) => c.name === n)
    const bad = evaluate(e, { motionFrames: real.motionFrames, fadeFrames: real.fadeFrames })
    expect(crit(bad, 'moving_frames_changed_ratio').ok).toBe(false)
    expect(crit(bad, 'max_still_ms').ok).toBe(false)
    expect(bad.verdict).toBe('fail')
    const good = evaluate(e, { motionFrames: sweep(false), fadeFrames: [] })
    expect(crit(good, 'moving_frames_changed_ratio').ok).toBe(true)
    expect(crit(good, 'max_still_ms').ok).toBe(true)
  })

  // M39aa (b1): the Pixel round's first frame was 64.000 tiles from the second while the remote stood still. A
  // recorder reporting that is a snap (the origin fix lives in check.ts, proven by window-origin.test.ts), but the
  // jump must not make the circle at rest look stuck inside a stretch of motion.
  test('device-walk reference: a 64.000 jump at frame 1 is a snap, and does not make the rest after it a still stretch', () => {
    const series = Array.from({ length: 90 }, (_, i) => {
      const x = i < 3 ? 0.52 : 0.52 + (i - 3) * 0.2
      return [1018 + Math.round(i * 16.7), +(i === 0 ? x + 64 : x).toFixed(3), 0.52, 18 + i]
    })
    const m = analyseMotion(series, snap)
    expect(m.snaps).toBeGreaterThanOrEqual(1)
    expect(m.maxJumpTiles).toBe(64)
    expect(m.maxStillMs).toBeLessThan(50)
  })

  test('device-walk reference: a repeated DrawList (same frame_seq) is not a frame the circle failed to move on', () => {
    // Every fourth rAF repeats the previous picture, the rest move: the ratio is over new pictures only.
    const jittery = sweep(false).map((f, i) => [f[0], f[1], f[2], i - Math.floor(i / 4)])
    const m = analyseMotion(jittery, snap)
    expect(m.movingFramesChangedRatio).toBeLessThan(1.01)
    expect(m.repeatedFrames).toBeGreaterThan(80)
    // A series that never carried a seq (an older record) still counts each frame.
    expect(
      analyseMotion(
        sweep(false).map((f) => f.slice(0, 3)),
        snap,
      ).repeatedFrames,
    ).toBe(0)
    // Nothing moved in a stretch: no ratio to judge (null), which the criterion fails.
    expect(
      analyseMotion(
        sweep(false).map((f) => [f[0], 3, 3, f[3]]),
        snap,
      ).movingFramesChangedRatio,
    ).toBeNull()
  })

  test('device-walk reference: a fade is an alpha under 255 while the circle is drawn; vanishing at once is not one', () => {
    const fade = [
      [0, 1, 255],
      [16, 1, 200],
      [32, 1, 90],
      [48, 0, null],
    ]
    expect(analyseFade(fade)).toMatchObject({
      vanishMs: 48,
      fades: true,
      fadeMissing: 0,
      minAlpha: 90,
      vanished: true,
    })
    const gone = [
      [0, 1, 255],
      [16, 1, 255],
      [32, 0, null],
    ]
    expect(analyseFade(gone)).toMatchObject({
      fades: false,
      fadeMissing: 1,
      vanished: true,
      vanishMs: 32,
    })
    expect(analyseFade([])).toMatchObject({
      fades: false,
      fadeMissing: 1,
      minAlpha: null,
      vanishMs: null,
    })
  })

  const motion = (over = {}) => ({
    motionFrames: Array.from({ length: 60 }, (_, i) => [i * 16, i * 0.1, 0]),
    fadeFrames: [
      [0, 1, 255],
      [16, 1, 128],
      [32, 0, null],
    ],
    ...over,
  })
  test('device-walk reference: M34-remote-motion asks the person for a snap, fails a circle that lingers after the bot left, fails a circle that never moved', () => {
    const e = CHECKS['M34-remote-motion']
    const clean = evaluate(e, motion())
    expect(clean.criteria.map((c) => [c.name, c.ok])).toEqual([
      ['remote_moved', true],
      ['moving_frames_changed_ratio', true],
      ['max_still_ms', true],
      ['snaps', true],
      ['vanished_at_once', true],
      ['no_snap_and_fades', null], // always the person's tap
    ])
    expect(clean.verdict).toBe('judge')
    const snappy = evaluate(
      e,
      motion({
        motionFrames: motion().motionFrames.map(([t, x], i) => [t, i < 30 ? x : x + 4, 0]),
      }),
    )
    expect(snappy.criteria.find((c) => c.name === 'snaps')).toMatchObject({ value: 1, ok: null })
    // 39l: the bot closing its page is a clean close (0013: `Gone`), so the circle must be absent within 1 s;
    // that it was never drawn with an alpha under 255 is a metric, not a failure.
    const gone = evaluate(
      e,
      motion({
        fadeFrames: [
          [100, 1, 255],
          [116, 1, 255],
          [133, 0, null],
        ],
      }),
    )
    expect(gone.criteria.find((c) => c.name === 'vanished_at_once')).toMatchObject({
      value: 33,
      ok: true,
    })
    expect(gone.metrics).toMatchObject({ vanish_ms: 33, fade_missing: 1 })
    expect(gone.verdict).toBe('judge')
    const lingers = (ms) => [
      [0, 1, 255],
      [ms - 16, 1, 255],
      [ms, 0, null],
    ]
    for (const [ms, ok] of [
      [1000, true],
      [1017, false],
    ])
      expect(
        evaluate(e, motion({ fadeFrames: lingers(ms) })).criteria.find(
          (c) => c.name === 'vanished_at_once',
        ),
        `vanish at ${ms} ms`,
      ).toMatchObject({ ok })
    // Still drawn when the window ended: it never vanished.
    const stays = evaluate(
      e,
      motion({
        fadeFrames: [
          [0, 1, 255],
          [16, 1, 255],
        ],
      }),
    )
    expect(stays.criteria.find((c) => c.name === 'vanished_at_once')).toMatchObject({
      value: null,
      ok: false,
    })
    expect(stays.verdict).toBe('fail')
    const still = evaluate(e, motion({ motionFrames: [[0, 1, 1]] }))
    expect(still.verdict).toBe('fail')
    expect(still.criteria.find((c) => c.name === 'remote_moved')).toMatchObject({
      value: 0,
      ok: false,
    })
  })

  const timer = (over = {}) => ({
    link: 'wifi',
    ok: true,
    durationMs: 1500,
    gapMs: 20,
    resultBeforeFull: false,
    fullWaiting: false,
    ...over,
  })
  test('device-walk reference: M34-own-timer-bar passes in tolerance on two links; a result before the bar or a full bar left waiting fails', () => {
    const e = CHECKS['M34-own-timer-bar']
    const run = (timers) =>
      evaluate(e, { timers, links: [...new Set(timers.filter((t) => t.ok).map((t) => t.link))] })
    const ok = run([timer(), timer({ link: 'cellular', gapMs: -30 })])
    expect(ok.verdict).toBe('pass')
    expect(ok.metrics).toMatchObject({
      runs: 2,
      gap_ms_min: -30,
      gap_ms_max: 20,
      bar_ms_median: 1500,
    })
    expect(run([timer()]).criteria.find((c) => c.name === 'links_measured')).toMatchObject({
      value: 1,
      ok: false,
    })
    expect(run([timer(), timer({ link: 'cellular', resultBeforeFull: true })]).verdict).toBe('fail')
    expect(run([timer(), timer({ link: 'cellular', fullWaiting: true })]).verdict).toBe('fail')
    expect(run([timer(), timer({ link: 'cellular', ok: false })]).criteria[1]).toMatchObject({
      name: 'timers_completed',
      ok: false,
    })
  })

  test('device-walk reference: M34 tiles are the stone landmark and the free 2x2 the scripted play places on', async () => {
    const script = await import('../../games/reference/tests/helpers/script.ts')
    expect(MP_TILES.furnace).toEqual(script.FURNACE_A)
    expect(MP_TILES.stone).toEqual(script.LANDMARKS.resources.stone)
  })

  /** A Playwright stand-in: `evaluate` answers `readings()` (no argument) and records `act` calls. */
  function fakeLaunch() {
    const calls = []
    const log = { closed: 0, pages: 0 }
    const page = () => ({
      goto: async () => {},
      waitForFunction: async () => {},
      evaluate: async (_fn, arg) => {
        if (Array.isArray(arg)) {
          calls.push(arg)
          return undefined
        }
        return {
          link: 'online',
          ui_seen: true,
          spawn_x: 10,
          spawn_y: 20,
          roster_n: 2,
          remote_circles: 1,
        }
      },
      close: async () => {
        log.closed++
      },
    })
    return {
      calls,
      log,
      launch: async () => ({
        newContext: async () => ({ newPage: async () => (log.pages++, page()) }),
        close: async () => {
          log.browserClosed = true
        },
      }),
    }
  }

  test('device-walk reference: the motion bot walks when the phone is ready, says moved, goes when the phone has seen it, and goes home on finish', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'walk-bot-'))
    const file = join(dir, 'r.jsonl')
    const fake = fakeLaunch()
    const bots = createBots({
      file,
      append: (e) => appendEvent(file, e),
      origin: 'http://127.0.0.1:1',
      tiles: MP_TILES,
      launch: fake.launch,
      timings: { stepMs: 10, walkMs: 60, settleMs: 5, pollMs: 10 },
    })
    const phase = () =>
      readEvents(file)
        .filter((e) => e.key === 'bot')
        .map((e) => e.data.phase)
    const says = (p) =>
      appendEvent(file, {
        type: 'reading',
        id: 'M34-remote-motion',
        n: 1,
        key: 'phone',
        data: { phase: p },
      })
    const until = async (fn) => {
      for (let i = 0; i < 300 && !fn(); i++) await new Promise((r) => setTimeout(r, 10))
      expect(fn()).toBe(true)
    }
    bots.start({ id: 'M34-remote-motion', n: 1, plan: CHECKS['M34-remote-motion'].plan })
    expect(bots.active()).toEqual(['M34-remote-motion'])
    await until(() => phase().includes('joined'))
    expect(phase()).toEqual(['joined']) // it waits for the phone
    says('ready')
    await until(() => phase().includes('moved'))
    expect(phase()).toEqual(['joined', 'moved'])
    const xs = fake.calls.filter(([k]) => k === 'moveTo').map(([, a]) => a.x)
    expect([...new Set(xs)].sort((a, b) => a - b)).toEqual([10, 16]) // the spawn, and 6 tiles on: back and forth, not one move
    expect(xs.length).toBeGreaterThan(3)
    says('moved-seen')
    await until(() => phase().includes('gone'))
    expect(fake.log.closed).toBe(1)
    await bots.stop()
    expect(fake.log.browserClosed).toBe(true)
    expect(bots.active()).toEqual([])
    // A check without a partner starts none.
    bots.start({ id: 'M34-own-timer-bar', n: 1, plan: CHECKS['M34-own-timer-bar'].plan })
    expect(bots.active()).toEqual([])
  })
  /** collect-ref.js in a sandbox with a stand-in kit: `page` is the fake `window.__check`, `store` the sessionStorage. */
  function sandbox(page, store = new Map()) {
    const assigned = []
    const K = {
      collectors: {},
      A: { send() {} },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      waitFor: async (fn, ms, every = 5) => {
        const t0 = Date.now()
        while (Date.now() - t0 < ms) {
          if (fn()) return true
          await new Promise((r) => setTimeout(r, every))
        }
        return false
      },
      readings: () => page.readings(),
      check: () => ({ act: { moveTo: async () => {} }, ...page }),
      get: (k) => store.get(k) ?? null,
      set: (k, v) => store.set(k, v),
      live: () => ({ state: {} }),
      json: (v, d) => v ?? d,
      clone: (v) => JSON.parse(JSON.stringify(v)),
    }
    const entry = (name, ok, status, size) => ({
      name,
      responseStatus: status,
      transferSize: size,
      decodedBodySize: size,
      initiatorType: 'fetch',
      ok,
    })
    runInNewContext(
      readFileSync(new URL('./device-walk/agent/collect-ref.js', import.meta.url), 'utf8'),
      {
        window: { __walkKit: K },
        document: { readyState: 'loading' },
        location: {
          href: 'https://x.trycloudflare.com/index.html',
          assign: (u) => assigned.push(u),
        },
        performance: {
          getEntriesByType: () => [
            entry('https://x/ok.js', 1, 200, 10),
            entry('https://x/a.wasm', 0, 0, 0),
          ],
        },
        URL,
        Date,
        setTimeout,
        getComputedStyle: () => ({}),
      },
    )
    const item = (opts) => ({
      id: 'M34-two-devices',
      n: 1,
      plan: { mode: 'two' },
      opts: { timeoutMs: 40, reloadWaitMs: 1, ...opts },
    })
    return {
      run: (opts) => K.collectors['reference-mp'](item(opts)),
      joined: (item) => K.refFacts.joined(item),
      assigned,
      store,
    }
  }

  test('device-walk reference: a join that times out says which condition failed and why; the page is reloaded once, then it fails', async () => {
    const page = {
      ready: false,
      readings: () => ({ link: 'connecting', ui_seen: false }),
      errors: () => ['engine fatal: worker script blocked'],
    }
    const sb = sandbox(page)
    const first = await sb.run()
    expect(first.ready).toBe(false)
    expect(first.why).toMatchObject({
      ready: false,
      link: 'connecting',
      ui_seen: false,
      errors: ['engine fatal: worker script blocked'],
      url: 'https://x.trycloudflare.com/index.html',
      readyState: 'loading',
      failedResources: [{ name: 'https://x/a.wasm', status: 0, type: 'fetch' }],
    })
    expect(sb.assigned).toHaveLength(1) // reloaded once (fresh URL)
    expect(sb.assigned[0]).toContain('_retry=')
    const second = await sb.run() // the next document of the same check: the retry is spent
    expect(second.why.ready).toBe(false)
    expect(sb.assigned).toHaveLength(1)
    // A page that joins is not reloaded and says nothing.
    const good = sandbox({
      ready: true,
      readings: () => ({ link: 'online', ui_seen: true }),
      errors: () => [],
    })
    expect(await good.joined({ id: 'x', opts: { timeoutMs: 20 } })).toEqual({ ok: true })
    expect(good.assigned).toHaveLength(0)
  })

  test('device-walk reference: a bot that cannot join posts why: the page url, its console tail, its readings and the server log tail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'walk-bot-'))
    const file = join(dir, 'r.jsonl')
    const page = () => ({
      goto: async () => {},
      on: (ev, fn) => {
        if (ev === 'console') fn({ type: () => 'error', text: () => 'worker script blocked' })
      },
      url: () => 'http://127.0.0.1:4183/#k=',
      waitForFunction: async () => {
        throw new Error('page.waitForFunction: Timeout 60000ms exceeded.\nCall log: ...')
      },
      evaluate: async () => ({ link: 'connecting', ui_seen: false }),
      close: async () => {},
    })
    const bots = createBots({
      file,
      append: (e) => appendEvent(file, e),
      origin: 'http://127.0.0.1:1',
      tiles: MP_TILES,
      launch: async () => ({
        newContext: async () => ({ newPage: async () => page() }),
        close: async () => {},
      }),
      serverLog: () => [
        '[reference-server] listening: 4184',
        '[reference-server] Reject VersionMismatch',
      ],
    })
    bots.start({ id: 'M34-two-devices', n: 1, plan: CHECKS['M34-two-devices'].plan })
    for (let i = 0; i < 300 && !readEvents(file).some((e) => e.key === 'bot'); i++)
      await new Promise((r) => setTimeout(r, 10))
    await bots.stop()
    const failed = readEvents(file).find((e) => e.key === 'bot').data
    expect(failed.phase).toBe('failed')
    expect(failed.error).toMatch(/Timeout 60000ms/)
    expect(failed.diag).toMatchObject({
      url: 'http://127.0.0.1:4183/#k=',
      console: ['error: worker script blocked'],
      readings: { link: 'connecting', ui_seen: false },
      server: ['[reference-server] listening: 4184', '[reference-server] Reject VersionMismatch'],
    })
  })
  test('device-walk reference: the bot sees the phone only when the phone said it joined, an online other player is on the roster and a circle that is not its own is drawn', () => {
    const view = (over = {}) => ({
      roster: ['1:online:other', '2:online:me'],
      roster_n: 2,
      remote_circles: 1,
      own_xy: '0.11,0.11',
      ...over,
    })
    expect(phoneSeen(view(), true)).toBe(true)
    // The only remote circle is the bot's own (no range ring to tell it by) and the one other roster entry
    // is an offline leftover: the old count (roster >= 2 and a circle) said yes.
    const ghost = view({ roster: ['1:offline:other', '2:online:me'], own_xy: null })
    expect(ghost.roster_n >= 2 && ghost.remote_circles >= 1).toBe(true)
    expect(phoneSeen(ghost, true)).toBe(false)
    // An online other player and its circle, but the phone has not said it joined: not the phone.
    expect(phoneSeen(view(), false)).toBe(false)
    // With no ring a second circle is the other player's.
    expect(phoneSeen(view({ own_xy: null, remote_circles: 2 }), true)).toBe(true)
    // A roster with only the bot (alone on a fresh server).
    expect(phoneSeen(view({ roster: ['1:online:me'], roster_n: 1, remote_circles: 0 }), true)).toBe(
      false,
    )
  })
})
