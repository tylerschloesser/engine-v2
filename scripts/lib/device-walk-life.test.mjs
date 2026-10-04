// M39f steps 7-8: the service side of the lifecycle and choreography checks (auto-round.mjs and checks.mjs):
// state kept on the service for a check that spans documents and tabs, what a check inherits from the round,
// the drop choreographer (+-30% of a stated time, repeat, discards), runs shared between two checks.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createAutoRound, mpProgress, readingsOf } from './device-walk/auto-round.mjs'
import { CHECKS, evaluate, MP_SCENARIOS } from './device-walk/checks.mjs'
import { parseChecks } from './device-walk/parse.mjs'
import { appendEvent, readEvents } from './device-walk/rounds.mjs'

const { items } = parseChecks(
  readFileSync(new URL('../../docs/plan/device-checks.md', import.meta.url), 'utf8'),
)
const origins = { fixture: 'http://127.0.0.1:1', 'fixture-ws': 'http://127.0.0.1:11' }

function rig(ids, params = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'walk-life-'))
  const file = join(dir, 'r.jsonl')
  mkdirSync(join(dir, 's'))
  const m = createAutoRound({
    file,
    items: items.filter((i) => ids.includes(i.id)),
    origins,
    params,
  })
  m.attach({ append: (e) => appendEvent(file, e) })
  let seq = 0
  const phone = (type, body = {}) => {
    const e = appendEvent(file, { type, src: { tab: 't', seq: ++seq }, ...body })
    m.react(e)
    return e
  }
  const series = (id, n, data) => {
    const path = join(dir, 's', `${id}-${n}.json`)
    writeFileSync(path, JSON.stringify(data))
    return phone('series', { id, n, path })
  }
  const events = () => readEvents(file)
  return {
    m,
    phone,
    series,
    events,
    step: () => m.stepFor(events(), Date.now()),
    results: () => events().filter((e) => e.type === 'result'),
    start: () => phone('walk', { phase: 'start' }),
  }
}

describe('device-walk life', () => {
  test('device-walk life: readings are state kept on the service: the step of the open attempt carries them to any tab', () => {
    const r = rig(['M23-kill-resume'])
    r.start()
    expect(r.step().item.state).toEqual({})
    r.phone('reading', { id: 'M23-kill-resume', n: 1, key: 'before', data: { tick: 100 } })
    r.phone('reading', { id: 'M23-kill-resume', n: 1, key: 'before', data: { tick: 120 } })
    r.phone('reading', { id: 'M23-kill-resume', n: 2, key: 'before', data: { tick: 999 } })
    // A new tab (the QR scanned again) is told the same attempt and what the old page left behind.
    expect(r.step()).toMatchObject({
      phase: 'run',
      item: {
        id: 'M23-kill-resume',
        n: 1,
        page: 'world.html?world=walk-kill',
        state: { before: { tick: 120 } },
        plan: { mode: 'kill', resumable: true },
      },
    })
    expect(readingsOf(r.events(), 'M23-kill-resume', 1)).toEqual({ before: { tick: 120 } })
  })

  test('device-walk life: M16-slice-boot inherits M03 from the round; absent from it the criterion is a judge prompt, not a failure', () => {
    const boot = {
      final: { isolated: true, adapter: 'a', workers_ready: true, terrain_drawn: true },
      gestures: 'see M11-gestures',
    }
    const withM03 = rig(['M03-determinism', 'M16-slice-boot'])
    withM03.start()
    withM03.series('M03-determinism', 1, {
      dom: { banner: 'PASS' },
      g: { __determinism: { fixtures: { a: { pass: true } }, crossOriginIsolated: true } },
    })
    withM03.series('M16-slice-boot', 1, boot)
    const att = withM03.events().findLast((e) => e.type === 'attempt' && e.status === 'done')
    expect(att.criteria.find((c) => c.name === 'm03_criterion')).toMatchObject({
      value: true,
      ok: true,
    })
    expect(withM03.step()).toMatchObject({ phase: 'judge' }) // the one confirm tap (pan and pinch)

    const alone = rig(['M16-slice-boot'])
    alone.start()
    alone.series('M16-slice-boot', 1, boot)
    const a2 = alone.events().findLast((e) => e.type === 'attempt' && e.status === 'done')
    expect(a2.criteria.find((c) => c.name === 'm03_criterion')).toMatchObject({
      value: null,
      ok: null,
    })
    expect(a2.outcome).toBe('judge')

    // M03 failed in this round: the inherited criterion fails, whatever the person taps.
    const failed = rig(['M03-determinism', 'M16-slice-boot'])
    failed.start()
    failed.series('M03-determinism', 1, { dom: { banner: 'FAIL' }, g: {} })
    failed.series('M16-slice-boot', 1, boot)
    const a3 = failed.events().findLast((e) => e.type === 'attempt' && e.status === 'done')
    expect(a3.criteria.find((c) => c.name === 'm03_criterion')).toMatchObject({ ok: false })
    expect(a3.outcome).toBe('fail')
  })

  test('device-walk life: nullIs judge asks, max-known skips readings not taken yet, a missing reading still fails', () => {
    const co = CHECKS['M16-coexist']
    const ok = evaluate(co, {
      reloads: 0,
      steady: [{ engine_mem_grows: null }, { engine_mem_grows: 0 }],
      windows: [{ raf: { long25: 0, max: 17 } }],
    })
    expect(ok.verdict).toBe('pass')
    const grew = evaluate(co, {
      reloads: 0,
      steady: [{ engine_mem_grows: 0 }, { engine_mem_grows: 2 }],
      windows: [{ raf: { long25: 0 } }],
    })
    expect(grew.criteria.find((c) => c.name === 'engine_mem_grows')).toMatchObject({
      value: 2,
      ok: false,
    })
    expect(grew.verdict).toBe('fail')
    const never = evaluate(co, { reloads: 0, steady: [{ engine_mem_grows: null }], windows: [] })
    expect(never.criteria.find((c) => c.name === 'engine_mem_grows').ok).toBe(false)
  })

  test('device-walk life: the drop choreographer holds a run to +-30% of its time, repeats a miss, accepts a discard, then finishes', () => {
    const plan = { scenarios: MP_SCENARIOS, runsEach: 2 }
    const run = (scenario, ms, extra = {}) => ({
      type: 'reading',
      id: 'x',
      n: 1,
      key: 'run',
      data: { scenario, ms, dropped: true, ...extra },
    })
    const p = (evs, o) => mpProgress(evs, 'x', 1, plan, o)
    expect(p([]).next).toMatchObject({ scenario: 'app-5s', run: 1, of: 2, targetMs: 5000 })
    // 3.4 s of 5 s is outside (-32%); 3.6 s is inside (-28%).
    let ev = [run('app-5s', 3400)]
    expect(p(ev).next).toMatchObject({ scenario: 'app-5s', run: 1 })
    expect(p(ev).lastRejected).toEqual({ scenario: 'app-5s', ms: 3400, target: 5000 })
    ev = [...ev, run('app-5s', 3600), run('app-5s', 6500), run('app-5s', 6600)]
    // 6.5 s is +30%: inside. 6.6 s would be a third run of a scenario that has its two.
    expect(p(ev).next).toMatchObject({ scenario: 'app-30s', run: 1 })
    expect(p(ev).accepted).toHaveLength(2)
    // A page the browser discarded cannot be timed: it counts. A net scenario with no stated time counts
    // when the link dropped, not when it did not.
    const rest = [
      run('app-30s', null, { discarded: true }),
      run('app-30s', 31000),
      run('app-5min', 290000),
      run('app-5min', 310000),
      run('lock-60s', 61000),
      run('lock-60s', 59000),
      run('wifi-cellular', null, { dropped: false }),
    ]
    const sofar = p([...ev, ...rest])
    expect(sofar.next).toMatchObject({ scenario: 'wifi-cellular', run: 1 })
    const fin = p([
      ...ev,
      ...rest,
      run('wifi-cellular', null, { dropped: true }),
      run('wifi-cellular', null, { dropped: true }),
      run('airplane-15s', 15000),
      run('airplane-15s', 14000),
    ])
    expect(fin.next).toBeNull()
    expect(fin).toMatchObject({ done: 12, total: 12 })
    // The test knob: stated times replaced, the window follows.
    expect(p([run('app-5s', 1200)], { scenarioMs: { 'app-5s': 1200 } }).accepted).toHaveLength(1)
  })

  test('device-walk life: M29-play-through-drop reads the runs of M29-socket-resume instead of asking for the drops again', () => {
    const r = rig(['M29-socket-resume', 'M29-play-through-drop'], { runsEach: 1 })
    r.start()
    const runs = MP_SCENARIOS.map((s) => ({
      scenario: s.key,
      ms: s.ms ?? 1000,
      dropped: true,
      welcomeMs: 800,
      interactive: true,
      dialog: false,
    }))
    r.series('M29-socket-resume', 1, { ready: true, runs })
    const res = r.results()
    expect(res.map((e) => [e.id, e.result, e.by])).toEqual([
      ['M29-socket-resume', 'pass', 'auto'],
      ['M29-play-through-drop', 'pass', 'auto'],
    ])
    expect(res[1].notes).toBe('the same runs as M29-socket-resume')
    expect(res[1].evidence).toBe(res[0].evidence)
    expect(
      r
        .events()
        .filter((e) => e.type === 'attempt' && e.id === 'M29-play-through-drop' && !e.status),
    ).toHaveLength(1) // an attempt record, but the phone was never sent to do it
    expect(r.step().phase).toBe('done')
    // One interactive failure in the shared runs fails play-through-drop, and not socket-resume.
    const r2 = rig(['M29-socket-resume', 'M29-play-through-drop'])
    r2.start()
    r2.series('M29-socket-resume', 1, {
      ready: true,
      runs: [{ ...runs[0], interactive: false }, runs[1]],
    })
    expect(r2.results().map((e) => [e.id, e.result])).toEqual([
      ['M29-socket-resume', 'pass'],
      ['M29-play-through-drop', 'fail'],
    ])
  })

  test('device-walk life: a socket-resume with no reconnect to time (every run survived) is a judge prompt, never a pass by silence', () => {
    const e = evaluate(CHECKS['M29-socket-resume'], {
      runs: [
        { welcomeMs: null, survived: true },
        { welcomeMs: null, survived: true },
      ],
    })
    expect(e.verdict).toBe('judge')
    const slow = evaluate(CHECKS['M29-socket-resume'], {
      runs: [{ welcomeMs: 900 }, { welcomeMs: null }, { welcomeMs: 1400 }, { welcomeMs: 4100 }],
    })
    expect(slow.criteria.map((c) => [c.name, c.value, c.ok])).toEqual([
      ['visible_to_welcome_median_ms', 1400, true],
      ['visible_to_welcome_max_ms', 4100, false],
    ])
  })

  test('device-walk life: the lifecycle pages carry their own world, so two checks never share one', () => {
    const r = rig(['M23-world-busy', 'M23-private', 'M16-coexist', 'M29-net-heap'])
    r.start()
    for (const id of ['M16-coexist', 'M23-world-busy', 'M23-private', 'M29-net-heap']) {
      const a = r.events().findLast((e) => e.type === 'attempt' && e.id === id)
      if (a) r.series(id, a.n, { reloaded: true })
    }
    expect(
      r
        .events()
        .filter((e) => e.type === 'attempt' && !e.status)
        .map((e) => e.page),
    ).toEqual([
      'slice.html?autopan=1',
      'world.html?world=walk-busy',
      'world.html?world=walk-private',
      'mp.html?linklog=1',
    ])
  })
})
