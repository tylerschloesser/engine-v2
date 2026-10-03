// M39f step 3: the self-test state machine and its judge (pure parts), and the `--selftest` bookkeeping.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { readEvents, replay } from './device-walk/rounds.mjs'
import {
  createSelftest,
  evaluate,
  formatSelftest,
  LIMITS,
  SELFTEST_ID,
  stepFor,
} from './device-walk/selftest.mjs'

const P = { holdMs: 360_000, dropAtMs: 150_000, dropMs: 20_000 }
const origins = ['https://a.example', 'https://b.example']
const cfg = { origins, params: P }
const T0 = Date.parse('2026-10-03T10:00:00.000Z')
const iso = (ms) => new Date(T0 + ms).toISOString()
const st = (ms, phase, more = {}) => ({ t: iso(ms), type: 'selftest', phase, ...more })

/** A clean, passing run's log. */
function goodLog() {
  return [
    st(0, 'start', { origin: origins[0] }),
    st(2_000, 'hop-arrive', { origin: origins[1], wake: 'denied' }),
    st(4_000, 'hop-arrive', { origin: origins[0], wake: 'held' }),
    { t: iso(4_100), type: 'wake', event: 'granted' },
    st(154_000, 'drop-begin'),
    st(174_000, 'drop-end', { by: 'service' }),
    st(175_000, 'tap', { n: 1 }),
    st(175_100, 'tap', { n: 2 }),
    st(175_200, 'tap', { n: 3 }),
    st(176_000, 'drop-report', { tapsSent: 3, reconnects: 4 }),
    st(364_100, 'hold-end', { rafMax: 41, rafFrames: 20000 }),
  ]
}
const MEM = { maxPingGapMs: 2500, recoveryMs: 1800 }

describe('device-walk selftest', () => {
  test('device-walk selftest: the step follows the log (idle, hop-b, hop-a, hold, drop, hold, done)', () => {
    const at = (n) => stepFor(goodLog().slice(0, n), T0 + 200_000, cfg)
    expect(stepFor([], T0, cfg)).toMatchObject({ phase: 'idle', id: SELFTEST_ID, origins })
    expect(at(1)).toMatchObject({ phase: 'hop-b', expectOrigin: origins[1] })
    expect(at(2)).toMatchObject({ phase: 'hop-a', expectOrigin: origins[0] })
    expect(at(3)).toMatchObject({ phase: 'hold', holdStartedAt: T0 + 4_000, dropBeginAt: null })
    expect(at(5)).toMatchObject({ phase: 'drop', dropBeginAt: T0 + 154_000 })
    expect(at(9)).toMatchObject({ phase: 'drop', taps: 3 })
    expect(at(10)).toMatchObject({ phase: 'hold', dropReported: true })
    const done = [...goodLog(), { type: 'result', id: SELFTEST_ID, result: 'pass' }]
    expect(stepFor(done, T0, cfg)).toMatchObject({ phase: 'done', result: { result: 'pass' } })
  })

  test('device-walk selftest: a clean run passes every criterion', () => {
    const { criteria, ok, metrics } = evaluate(goodLog(), P, MEM)
    expect(criteria.filter((c) => !c.ok)).toEqual([])
    expect(ok).toBe(true)
    expect(metrics).toMatchObject({ hold_ms: 360_100, taps: 3, wake_after_hops: 'denied held' })
  })

  test('device-walk selftest: each criterion fails on its own, at and beyond its limit', () => {
    const bad = (log, mem = MEM) =>
      evaluate(log, P, mem)
        .criteria.filter((c) => !c.ok)
        .map((c) => c.name)
    const edit = (fn) => goodLog().flatMap(fn)
    // Screen locked: a hidden event inside the hold.
    const hid = goodLog()
    hid.splice(5, 0, { t: iso(60_000), type: 'visibility', state: 'hidden' })
    expect(bad(hid)).toEqual(['hidden_events_in_hold'])
    // A visible release of the wake lock fails; a release while hidden (a hop) is not counted.
    const rel = goodLog()
    rel.splice(5, 0, { t: iso(70_000), type: 'wake', event: 'released', visible: true })
    expect(bad(rel)).toEqual(['wake_lock_releases_while_visible'])
    const relHidden = goodLog()
    relHidden.splice(5, 0, { t: iso(70_000), type: 'wake', event: 'released', visible: false })
    expect(bad(relHidden)).toEqual([])
    // Held one ms short of the hold.
    expect(
      bad(edit((e) => (e.phase === 'hold-end' ? [{ ...e, t: iso(364_000 - 1) }] : [e]))),
    ).toEqual(['hold_ms'])
    expect(bad(edit((e) => (e.phase === 'hold-end' ? [{ ...e, t: iso(364_000) }] : [e])))).toEqual(
      [],
    )
    // Ping gap and rAF gap at the limit pass, one over fails.
    expect(bad(goodLog(), { ...MEM, maxPingGapMs: LIMITS.maxPingGapMs })).toEqual([])
    expect(bad(goodLog(), { ...MEM, maxPingGapMs: LIMITS.maxPingGapMs + 1 })).toEqual([
      'max_ping_gap_ms',
    ])
    expect(
      bad(edit((e) => (e.phase === 'hold-end' ? [{ ...e, rafMax: LIMITS.maxRafGapMs + 1 }] : [e]))),
    ).toEqual(['max_raf_gap_ms'])
    // The phone never came back, or came back late.
    expect(bad(goodLog(), { ...MEM, recoveryMs: null })).toEqual(['recovery_ms'])
    expect(bad(goodLog(), { ...MEM, recoveryMs: LIMITS.recoveryMs + 1 })).toEqual(['recovery_ms'])
    // A tap lost in the drop, out of order, or none at all.
    expect(bad(goodLog().filter((e) => !(e.phase === 'tap' && e.n === 2)))).toEqual([
      'taps_received_of_sent',
      'taps_in_order',
    ])
    expect(bad(edit((e) => (e.phase === 'tap' ? [{ ...e, n: 4 - e.n }] : [e])))).toEqual([
      'taps_in_order',
    ])
    expect(
      bad(
        goodLog()
          .filter((e) => e.phase !== 'tap')
          .map((e) => (e.phase === 'drop-report' ? { ...e, tapsSent: 0 } : e)),
      ),
    ).toEqual(['taps_received_of_sent', 'taps_in_order'])
    // Both hops on one origin do not count as two origins.
    expect(
      bad(edit((e) => (e.phase === 'hop-arrive' ? [{ ...e, origin: origins[0] }] : [e]))),
    ).toEqual(['origins_visited'])
  })

  test('device-walk selftest: react cuts the link on drop-begin and appends a service result on hold-end', () => {
    const cuts = []
    const appended = []
    const api = {
      cut: (ms) => cuts.push(ms),
      cutWindow: () => ({ from: 0, until: 0 }),
      append: (e) => appended.push(e),
    }
    const s = createSelftest({ origins, params: { ...P, dropMs: 5 } })
    const log = goodLog()
    const at = (phase) => log.find((e) => e.phase === phase)
    expect(s.react(at('hop-arrive'), { api, events: log.slice(0, 2) })).toEqual([])
    expect(s.mem.holding).toBe(false) // only the second arrival starts the hold
    s.react(log[2], { api, events: log.slice(0, 3) })
    expect(s.mem.holding).toBe(true)
    s.react(at('drop-begin'), { api, events: log.slice(0, 5) })
    expect(cuts).toEqual([5])
    expect(s.mem.waitingRecovery).toBe(true)
    const [res] = s.react(at('hold-end'), { api, events: log })
    expect(res).toMatchObject({ type: 'result', id: SELFTEST_ID, by: 'auto' })
    expect(s.mem.holding).toBe(false)
    // This log has no recovery measurement, so the judge refuses to pass it.
    expect(res.result).toBe('fail')
    expect(res.criteria.find((c) => c.name === 'recovery_ms').ok).toBe(false)
  })

  test('device-walk selftest: observe measures the recovery time and the ping gap without the refused window', () => {
    const s = createSelftest({ origins, params: P })
    s.mem.holding = true
    s.mem.lastPing = 1000
    s.mem.waitingRecovery = true
    const w = { from: 2000, until: 22_000 }
    const api = { cutWindow: () => w }
    s.observe({ type: 'ping' }, 23_500, api)
    expect(s.mem.recoveryMs).toBe(1500)
    // 22.5 s between pings, 20 s of it refused by the service: a 2.5 s gap.
    expect(s.mem.maxPingGapMs).toBe(2500)
  })

  test('device-walk selftest: the verdict text and the round replay carry the result', () => {
    const { criteria } = evaluate(goodLog(), P, MEM)
    const row = { result: 'fail', criteria: [{ ...criteria[0], ok: false }], numbers: 'hold_ms=1' }
    expect(formatSelftest(row)).toMatch(
      /^M39f-selftest: FAIL\n {2}FAIL origins_visited: 2 \(limit 2\)\n {2}hold_ms=1$/,
    )
    expect(formatSelftest(null)).toMatch(/not finished/)
    const dir = mkdtempSync(join(tmpdir(), 'dwst-'))
    expect(replay(readEvents(join(dir, 'none.jsonl')), []).others.size).toBe(0)
  })
})

describe('device-walk selftest cli', () => {
  test('device-walk selftest cli: --status prints the verdict of a self-test round (text and --json)', async () => {
    const { execFileSync } = await import('node:child_process')
    const { writeFileSync } = await import('node:fs')
    const dir = mkdtempSync(join(tmpdir(), 'dwcli-'))
    const lines = [
      { t: iso(0), type: 'start', only: [SELFTEST_ID], mode: 'selftest' },
      {
        t: iso(1),
        type: 'result',
        id: SELFTEST_ID,
        result: 'pass',
        by: 'auto',
        criteria: [{ name: 'hold_ms', value: 360100, limit: 360000, ok: true }],
        metrics: { hold_ms: 360100 },
      },
    ]
    writeFileSync(join(dir, 'st.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
    const run = (...a) =>
      execFileSync(
        'node',
        ['scripts/device-walk.mjs', '--rounds-dir', dir, '--status', 'st', ...a],
        {
          cwd: new URL('../../', import.meta.url),
          encoding: 'utf8',
        },
      )
    expect(run()).toMatch(
      /^M39f-selftest: PASS\n {2}ok {3}hold_ms: 360100 \(limit 360000\)\n {2}hold_ms=360100\n$/,
    )
    expect(JSON.parse(run('--json')).selftest).toMatchObject({ result: 'pass', by: 'auto' })
  })
})
