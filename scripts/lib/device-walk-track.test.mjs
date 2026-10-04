// M39f step 13: the tracker side of the auto runner: the state word of a running round (live.mjs), `--wait`
// and `--status --json` for another session, the Mac monitor (monitor.mjs) and the Mac browser launcher.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { createLive, openPrompts, readLive, roundState, waitRound } from './device-walk/live.mjs'
import { openArgs, openMacBrowser } from './device-walk/mac-browser.mjs'
import { createMonitor } from './device-walk/monitor.mjs'
import { parseChecks } from './device-walk/parse.mjs'
import { appendEvent, readEvents } from './device-walk/rounds.mjs'
import { fullStatus } from './device-walk/status.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const REAL = join(REPO, 'docs/plan/device-checks.md')
const { items } = parseChecks(readFileSync(REAL, 'utf8'))
const IDS = ['M03-determinism', 'M08-worldgen-ms-per-chunk']
const NOW = 1_000_000_000
const live = (extra = {}) => ({
  pid: 4242,
  phase: 'serving',
  joinUrl: 'https://x.example/__walk/runner.html?walk=t',
  phone: { lastSeen: NOW - 2000 },
  ...extra,
})
const state = (events, l = live(), o = {}) =>
  roundState({ events, ids: IDS, live: l, now: NOW, alive: true, ...o })
const start = { type: 'walk', phase: 'start' }
const open = (id, n = 1) => ({ type: 'attempt', id, n, variant: 'fixture', page: 'p', rung: 0 })
const done = (id, n, outcome) => ({ type: 'attempt', id, n, status: 'done', outcome })
const result = (id, r = 'pass') => ({ type: 'result', id, result: r, by: 'auto' })

describe('device-walk track: the state word', () => {
  test('device-walk track: starting, waiting-for-phone, running', () => {
    expect(state([], live({ joinUrl: null })).state).toBe('starting')
    expect(state([]).state).toBe('waiting-for-phone')
    const r = state([start, open('M03-determinism')])
    expect(r).toMatchObject({ state: 'running', current: { id: 'M03-determinism', n: 1 } })
    expect(r.phone).toMatchObject({ connected: true, secondsSince: 2 })
  })

  test('device-walk track: a phone silent for 90 s with nothing open is waiting-for-phone, with the age', () => {
    const r = state([start, open('M03-determinism')], live({ phone: { lastSeen: NOW - 120_000 } }))
    expect(r.state).toBe('waiting-for-phone')
    expect(r.reason).toMatch(/120 s ago/)
  })

  test('device-walk track: an open act prompt or judge sheet is waiting-for-human and names the check', () => {
    const act = state([
      start,
      open('M03-determinism'),
      {
        type: 'prompt',
        id: 'M03-determinism',
        n: 1,
        kind: 'act',
        text: 'Rotate the phone to landscape.',
      },
    ])
    expect(act).toMatchObject({ state: 'waiting-for-human', humanPending: ['M03-determinism'] })
    expect(act.reason).toContain('Rotate the phone')
    // The page moved on (a reading after the prompt): the prompt is closed.
    const moved = state([
      start,
      open('M03-determinism'),
      { type: 'prompt', id: 'M03-determinism', n: 1, kind: 'act', text: 'Rotate the phone.' },
      { type: 'reading', id: 'M03-determinism', n: 1, key: 'k', data: 1 },
    ])
    expect(moved.state).toBe('running')
    const judge = state([
      start,
      open('M03-determinism'),
      done('M03-determinism', 1, 'judge'),
      { type: 'prompt', id: 'M03-determinism', n: 1, kind: 'judge', text: 'Does it glide?' },
    ])
    expect(judge).toMatchObject({ state: 'waiting-for-human' })
    expect(judge.prompts[0]).toMatchObject({ kind: 'judge', text: 'Does it glide?' })
    // Answered: nothing is waiting on the person any more.
    const answered = state([
      start,
      open('M03-determinism'),
      done('M03-determinism', 1, 'judge'),
      { type: 'answer', id: 'M03-determinism', n: 1, value: 'pass' },
    ])
    expect(answered.humanPending).toEqual([])
    expect(
      openPrompts(
        [
          start,
          open('M03-determinism'),
          { type: 'attempt', id: 'M03-determinism', n: 1, status: 'interrupted', reason: 'hidden' },
        ],
        IDS,
      )[0],
    ).toMatchObject({ kind: 'redo' })
  })

  test('device-walk track: a dead process is stalled, a finished round is done with or without one', () => {
    const r = state([start, open('M03-determinism')], live(), { alive: false })
    expect(r).toMatchObject({ state: 'stalled' })
    expect(r.reason).toMatch(/pid 4242\) is gone/)
    expect(state([], null, { alive: false }).reason).toMatch(/no running device:walk/)
    const all = [start, result('M03-determinism'), result('M08-worldgen-ms-per-chunk', 'fail')]
    expect(state(all, null, { alive: false }).state).toBe('done')
  })

  test('device-walk track: Pause with nothing since is paused', () => {
    expect(
      state([start, open('M03-determinism'), { type: 'pause', id: 'M03-determinism', n: 1 }]).state,
    ).toBe('paused')
  })
})

describe('device-walk track: --wait', () => {
  const rig = (states, step = 1000) => {
    let t = 0
    let i = 0
    return {
      read: () => ({ ...states[Math.min(i++, states.length - 1)] }),
      clock: () => t,
      sleep: async () => {
        t += step
      },
      seen: [],
    }
  }
  test('device-walk track: wait returns 0 with the final state when the round is done', async () => {
    const r = rig([
      { state: 'running' },
      { state: 'waiting-for-human', humanPending: ['a'] },
      { state: 'done' },
    ])
    const seen = []
    const out = await waitRound({ ...r, onChange: (s) => seen.push(s.state) })
    expect(out).toMatchObject({ code: 0, timedOut: false, final: { state: 'done' } })
    expect(seen).toEqual(['running', 'waiting-for-human', 'done'])
  })

  test('device-walk track: wait exits 2 for a stall (after its grace) and for the timeout', async () => {
    const stalled = await waitRound({ ...rig([{ state: 'stalled' }]), stalledGraceMs: 3000 })
    expect(stalled).toMatchObject({ code: 2, timedOut: false, final: { state: 'stalled' } })
    // A restart inside the grace is not a stall.
    const back = await waitRound({
      ...rig([{ state: 'stalled' }, { state: 'running' }, { state: 'done' }]),
      stalledGraceMs: 3000,
    })
    expect(back.code).toBe(0)
    const slow = await waitRound({ ...rig([{ state: 'running' }]), timeoutMs: 5000 })
    expect(slow).toMatchObject({ code: 2, timedOut: true })
  })
})

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'dwt-'))
  const checks = join(dir, 'device-checks.md')
  copyFileSync(REAL, checks)
  const rounds = join(dir, 'rounds')
  mkdirSync(rounds)
  return {
    dir,
    checks,
    rounds,
    series: join(dir, 'series'),
    log: (r) => join(rounds, `${r}.jsonl`),
  }
}
const walk = (s, ...args) =>
  spawnSync(
    process.execPath,
    [
      join(REPO, 'scripts/device-walk.mjs'),
      '--checks',
      s.checks,
      '--rounds-dir',
      s.rounds,
      '--series-dir',
      s.series,
      ...args,
    ],
    { encoding: 'utf8' },
  )
const seedAuto = (s, evs) => {
  const file = s.log('t')
  appendEvent(file, { type: 'start', only: IDS, mode: 'auto' })
  for (const e of evs) appendEvent(file, e)
  return file
}

describe('device-walk track: --status --json and --wait from another process', () => {
  test('device-walk track: --status --json of an auto round carries state, joinUrl, phone.lastSeen and per item by, attempts, criteria, evidence', () => {
    const s = scratch()
    const crit = [{ name: 'pass', value: true, limit: true, ok: true }]
    seedAuto(s, [
      start,
      open('M03-determinism'),
      {
        type: 'attempt',
        id: 'M03-determinism',
        n: 1,
        status: 'done',
        outcome: 'pass',
        criteria: crit,
        evidence: 'test-results/x/M03-1.json',
      },
      {
        type: 'result',
        id: 'M03-determinism',
        result: 'pass',
        by: 'auto',
        attempt: 1,
        criteria: crit,
        metrics: { n: 3 },
        evidence: 'test-results/x/M03-1.json',
      },
      open('M08-worldgen-ms-per-chunk'),
    ])
    createLive({ path: join(s.series, 'state.json'), round: 't', pid: process.pid }).set({
      joinUrl: 'https://x.example/__walk/runner.html?walk=abc',
      monitorUrl: 'http://127.0.0.1:1/',
      phone: { lastSeen: Date.now() - 3000 },
    })
    const out = JSON.parse(walk(s, '--status', 't', '--json').stdout)
    expect(out).toMatchObject({
      mode: 'auto',
      state: 'running',
      joinUrl: 'https://x.example/__walk/runner.html?walk=abc',
      phone: { connected: true },
      current: { id: 'M08-worldgen-ms-per-chunk', n: 1 },
      humanPending: [],
      remaining: ['M08-worldgen-ms-per-chunk'],
    })
    expect(typeof out.phone.lastSeen).toBe('string')
    const m03 = out.items.find((i) => i.id === 'M03-determinism')
    expect(m03).toMatchObject({
      result: 'pass',
      by: 'auto',
      evidence: 'test-results/x/M03-1.json',
      criteria: crit,
    })
    expect(m03.attempts).toEqual([
      {
        n: 1,
        status: 'done',
        outcome: 'pass',
        criteria: crit,
        evidence: 'test-results/x/M03-1.json',
      },
    ])
    expect(readLive(join(s.series, 'state.json')).pid).toBe(process.pid)
  })

  test('device-walk track: --wait exits 0 for a done round (final status printed) and 2 for a stalled one', () => {
    const s = scratch()
    seedAuto(s, [start, result('M03-determinism'), result('M08-worldgen-ms-per-chunk', 'fail')])
    const ok = walk(s, '--wait', 't', '--timeout', '5', '--json')
    expect(ok.status).toBe(0)
    expect(JSON.parse(ok.stdout.slice(ok.stdout.indexOf('{'))).state).toBe('done')
    const s2 = scratch()
    seedAuto(s2, [start, open('M03-determinism')])
    const bad = walk(s2, '--wait', 't', '--timeout', '0.2')
    expect(bad.status).toBe(2)
    expect(bad.stdout).toMatch(/state: stalled/)
    expect(walk(s2, '--wait', 'nope').status).toBe(1)
  })

  test('device-walk track: a manual round is mode manual and done once every item has a result', () => {
    const s = scratch()
    appendEvent(s.log('t'), { type: 'start', only: IDS })
    expect(JSON.parse(walk(s, '--status', 't', '--json').stdout)).toMatchObject({
      mode: 'manual',
      state: 'manual',
    })
  })
})

describe('device-walk track: the Mac monitor and the Mac browser launcher', () => {
  test('device-walk track: the monitor serves the status, takes a redo and a result, refuses a foreign Host and a bad result', async () => {
    const got = []
    const m = createMonitor({ status: () => ({ state: 'running' }), event: (e) => got.push(e) })
    const port = await m.listen(0)
    try {
      const base = `http://127.0.0.1:${port}`
      expect(await (await fetch(`${base}/api/status`)).json()).toEqual({ state: 'running' })
      const post = (b) =>
        fetch(`${base}/api/event`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(b),
        })
      expect((await post({ type: 'redo', id: 'M03-determinism' })).status).toBe(200)
      expect((await post({ type: 'result', id: 'M03-determinism', result: 'bogus' })).status).toBe(
        400,
      )
      expect(got).toEqual([{ type: 'redo', id: 'M03-determinism' }])
      const foreign = await new Promise((resolve) => {
        import('node:http').then(({ request }) => {
          const r = request(
            { host: '127.0.0.1', port, path: '/api/status', headers: { host: 'evil.example' } },
            (res) => resolve(res.statusCode),
          )
          r.end()
        })
      })
      expect(foreign).toBe(403)
      expect((await fetch(`${base}/`)).headers.get('content-type')).toMatch(/html/)
    } finally {
      await m.close()
    }
  })

  test('device-walk track: open -a Safari or Firefox with the URL; DEVICE_WALK_OPEN replaces the command', () => {
    expect(openArgs('safari', 'http://x/')).toEqual(['-a', 'Safari', 'http://x/'])
    expect(openArgs('firefox', 'http://x/')).toEqual(['-a', 'Firefox', 'http://x/'])
    expect(() => openArgs('edge', 'http://x/')).toThrow(/no Mac browser/)
    const calls = []
    const run = (cmd, args, o) => (
      calls.push([cmd, args, o.shell === true]), { unref() {}, on() {} }
    )
    expect(openMacBrowser('safari', 'http://x/', { env: {}, run })).toEqual({ command: 'open' })
    expect(
      openMacBrowser('firefox', 'http://x/', { env: { DEVICE_WALK_OPEN: 'node fake.mjs' }, run }),
    ).toEqual({ command: 'node fake.mjs' })
    expect(calls).toEqual([
      ['open', ['-a', 'Safari', 'http://x/'], false],
      ["node fake.mjs firefox 'http://x/'", [], true],
    ])
  })
})

// The unused-import guard for fullStatus: the CLI test above goes through it; this pins its manual branch.
test('device-walk track: fullStatus of a round with no live record is stalled, not an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwt-'))
  const file = join(dir, 'r.jsonl')
  writeFileSync(file, '')
  appendEvent(file, { type: 'start', only: IDS, mode: 'auto' })
  const sel = items.filter((i) => IDS.includes(i.id))
  const s = fullStatus({
    round: 'r',
    file,
    items: sel,
    events: readEvents(file),
    overrides: {},
    live: null,
  })
  expect(s).toMatchObject({ mode: 'auto', state: 'stalled', joinUrl: null, humanPending: [] })
})
