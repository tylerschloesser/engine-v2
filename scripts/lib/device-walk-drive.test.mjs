// M39j: the device person and its backends (docs/plan/39j-device-driver.md). No phone: a fake backend records
// the calls, and the Android backend's adb and CDP are injected. The real-phone runs are evidence in the
// milestone report, not tests.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { cameraStorageKey } from '../../packages/engine/src/camera/persistence.ts'
import { screenToWorld } from '../../packages/engine/src/camera/transform.ts'
import { applyRound } from './device-walk/apply.mjs'
import { CHECKS, evaluate, MP_SCENARIOS } from './device-walk/checks.mjs'
import {
  createAndroidBackend,
  offsetsFor,
  pickSerial,
  toScreen,
  touchScript,
} from './device-walk/drive/android.mjs'
import { assertBackend, NotDrivable } from './device-walk/drive/backend.mjs'
import { bestEffort, withDeadline } from './device-walk/drive/deadline.mjs'
import { createFakeBackend } from './device-walk/drive/fake-backend.mjs'
import {
  abortAll,
  appiumCall,
  createIosBackend,
  pointerActions,
  tapActions,
} from './device-walk/drive/ios.mjs'
import { judgeEvent } from './device-walk/drive/judge.mjs'
import { answeredInLog, passRunner, startDrive } from './device-walk/drive/loop.mjs'
import { ACT_COVERAGE, devicePerson, HANDLERS } from './device-walk/drive/person.mjs'
import { parseChecks } from './device-walk/parse.mjs'
import { appendEvent, readEvents, replay } from './device-walk/rounds.mjs'
import { fullStatus } from './device-walk/status.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const AGENT = join(REPO, 'scripts/lib/device-walk/agent')
const act = (text, id = 'M11-gestures', n = 1) => ({ id, n, kind: 'act', text })
const person = (b, ctx = {}) => devicePerson(b, { returnLagMs: 0, sleep: async () => {}, ...ctx })

describe('device-walk drive: coverage of every act prompt', () => {
  test('device-walk drive: every act string of checks.mjs is handled or listed NotDrivable, and nothing stale', () => {
    const names = new Set(HANDLERS.map((h) => h.name))
    const missing = []
    for (const [id, entry] of Object.entries(CHECKS))
      for (const a of entry.acts ?? []) {
        const rec = ACT_COVERAGE[id]?.find((r) => r.act === a)
        if (!rec) missing.push(`${id}: ${a}`)
        else {
          const ok = rec.handlers !== undefined || rec.notDrivable !== undefined
          if (!ok) missing.push(`${id}: ${a} (neither handlers nor notDrivable)`)
        }
      }
    expect(missing, 'acts the device person neither handles nor lists as NotDrivable').toEqual([])
    for (const [id, recs] of Object.entries(ACT_COVERAGE))
      for (const r of recs) {
        expect(CHECKS[id]?.acts, `${id} is a check with acts`).toContain(r.act)
        for (const h of r.handlers ?? []) expect(names.has(h), `${id}: handler ${h}`).toBe(true)
        for (const n of [r.notDrivable ?? []].flat())
          expect(
            typeof n === 'string' ? n : n.reason,
            `${id}: a NotDrivable has its reason`,
          ).toMatch(/\S{3}/)
      }
  })

  test('device-walk drive: every prompt text the agent can show is answered by a handler (or is not a phone prompt)', () => {
    // Static prefixes of the prompts in agent/*.js (each must still be in the source: a reworded prompt is red
    // here before it is a phone that waits for nobody) with a sample of the full text.
    const src = readdirSync(AGENT)
      .map((f) => readFileSync(join(AGENT, f), 'utf8'))
      .join('\n')
    const s = (n) => MP_SCENARIOS.find((x) => x.key === n).text.replace('{s}', '30')
    const prompts = [
      ['Pan with one finger for about', 'Pan with one finger for about 10 seconds.', 'pan'],
      ['Flick the world and let it glide', 'Flick the world and let it glide to a stop.', 'flick'],
      [
        'Pinch out to the furthest zoom',
        'Pinch out to the furthest zoom, then in to the closest.',
        'pinch',
      ],
      ["'Tap a tile.'", 'Tap a tile.', 'tap-tile'],
      [
        'Pull down from the very top edge',
        'Pull down from the very top edge of the page, then let go.',
        'pull-down',
      ],
      ['Double-tap anywhere', 'Double-tap anywhere.', 'double-tap'],
      ['Rotate the phone to ${want}', 'Rotate the phone to landscape.', 'rotate'],
      ['tap the highlighted ring', 'Zoom 2 of 3: tap the highlighted ring (1 of 3).', 'tap-ring'],
      ['Tap the highlighted button', 'Tap the highlighted button (it is numbered 26).', 'tap-ring'],
      [
        'Tap a tile (away from the little buttons)',
        'Tap a tile (away from the little buttons).',
        'tap-tile',
      ],
      ['Now drag the map with one finger', 'Now drag the map with one finger.', 'drag'],
      [
        'Turn Low Power Mode on',
        'Turn Low Power Mode on (Settings, Battery), then come back to this page.',
        'low-power',
      ],
      [
        'Low Power Mode looks on',
        'Low Power Mode looks on. Turn it off (Settings, Battery), then come back to this page.',
        'low-power-off',
      ],
      [
        'Swipe Safari away',
        'Swipe Safari away in the app switcher (close it), then open Safari again. If this tab is gone, scan the QR code on the Mac again.',
        'relaunch',
      ],
      [
        'Tap "Open second tab"',
        'Tap "Open second tab", look at the new tab, then come back to this one.',
        'second-tab',
      ],
      [
        'Open this link in a Private tab',
        'Open this link in a Private tab: http://x/world.html',
        'private-tab',
      ],
      [
        'Tap Export on the page',
        'Tap Export on the page (the file w.world downloads; check that it arrives in Files).',
        'file-picker',
      ],
      [
        'Now choose the downloaded file',
        'Now choose the downloaded file in Import, type the id walk-import, tap Import, then tap "Open the imported world".',
        'file-picker',
      ],
      [
        'Switch the phone off Wi-Fi now',
        'Switch the phone off Wi-Fi now (cellular, or a throttled link), keep this page in front, then tap the button.',
        'wifi',
      ],
      [
        'put this tab in the background under memory pressure',
        'Run 2 of 3: put this tab in the background under memory pressure (open the camera and a few heavy pages) for about 180 seconds, then come back to it.',
        'background',
      ],
      [
        'In ${browserName(item)}: pinch in and out',
        'In Safari: pinch in and out with the trackpad, over a landmark tile.',
        'mac-prompt',
      ],
      [
        'In ${b}: open ${tool}',
        'In Firefox: open the Profiler, start recording, press Run on the page, and stop the recording after the page prints its result.',
        'mac-prompt',
      ],
      // The leave and drop prompts come from checks.mjs (`plan.leaves`, MP_SCENARIOS), wrapped by the page.
      ['Drop ${next.run} of ${next.of}', `Drop 1 of 3 (app-30s): ${s('app-30s')}`, 'leave-app'],
      ['Drop ${next.run} of ${next.of}', `Drop 1 of 3 (lock-60s): ${s('lock-60s')}`, 'lock'],
      [
        'Drop ${next.run} of ${next.of}',
        `Drop 1 of 3 (wifi-cellular): ${s('wifi-cellular')}`,
        'wifi',
      ],
      [
        'Drop ${next.run} of ${next.of}',
        `Drop 1 of 3 (airplane-15s): ${s('airplane-15s')}`,
        'airplane',
      ],
    ]
    for (const [prefix, text, handler] of prompts) {
      expect(src, `agent source still says: ${prefix}`).toContain(prefix)
      const hit = HANDLERS.filter((h) => h.match.test(text)).map((h) => h.name)
      expect(hit[0], text).toBe(handler)
    }
    for (const id of ['M16-background', 'M23-hidden-pause'])
      for (const L of CHECKS[id].plan.leaves) {
        const text = L.text.replace('{s}', '30')
        expect(
          HANDLERS.some((h) => h.match.test(text)),
          `${id}: ${text}`,
        ).toBe(true)
      }
  })
})

describe('device-walk drive: the device person on a recording backend', () => {
  const run = async (text, o = {}, ctx = {}) => {
    const b = createFakeBackend(o)
    const out = await person(b, ctx).answer(act(text))
    return { b, out }
  }

  test('device-walk drive: "Rotate the phone to landscape." is rotate("landscape")', async () => {
    const { b, out } = await run('Rotate the phone to landscape.')
    expect(out.status).toBe('done')
    expect(b.calls.filter((c) => c.m !== 'readPage')).toEqual([
      { m: 'rotate', args: ['landscape'] },
    ])
  })

  test('device-walk drive: pan is one slow drag of the stated time, flick a fast short one, from the page size', async () => {
    const pan = (
      await run('Pan with one finger for about 10 seconds.', { view: { w: 400, h: 800 } })
    ).b.calls.find((c) => c.m === 'swipe')
    expect(pan.args[4]).toBe(11_500)
    expect(pan.args.slice(0, 4)).toEqual([340, 560, 60, 240])
    const flick = (
      await run('Flick the world and let it glide to a stop.', { view: { w: 400, h: 800 } })
    ).b.calls.find((c) => c.m === 'swipe')
    expect(flick.args).toEqual([300, 400, 100, 400, 80])
    const land = (
      await run('Flick the world and let it glide to a stop.', { view: { w: 851, h: 284 } })
    ).b.calls.find((c) => c.m === 'swipe')
    expect(land.args).toEqual([638.25, 142, 212.75, 142, 80])
  })

  test('device-walk drive: pinch goes together until the limit, then apart, two fingers each time', async () => {
    const { b } = await run('Pinch out to the furthest zoom, then in to the closest.', {
      tiles: [12, 40, 130, 262, 100, 30, 12],
    })
    const touches = b.calls.filter((c) => c.m === 'touch')
    expect(touches.length).toBeGreaterThanOrEqual(6)
    for (const t of touches) expect(t.args[0]).toHaveLength(2)
    const gap = (t) =>
      Math.abs(t.args[0][0].to.x - t.args[0][1].to.x) -
      Math.abs(t.args[0][0].from.x - t.args[0][1].from.x)
    expect(gap(touches[0])).toBeLessThan(0) // together first (the page opens at its closest zoom)
    expect(gap(touches.at(-1))).toBeGreaterThan(0) // apart at the end
  })

  test('device-walk drive: tap, double-tap, pull-down, drag and the ring come from the page, not constants', async () => {
    const c = (r) => r.b.calls.filter((x) => x.m !== 'readPage')
    expect(c(await run('Tap a tile.'))).toEqual([{ m: 'tap', args: [200, 400] }])
    expect(c(await run('Double-tap anywhere.'))).toEqual([
      { m: 'tap', args: [200, 400, { count: 2 }] },
    ])
    expect(c(await run('Pull down from the very top edge of the page, then let go.'))[0]).toEqual({
      m: 'swipe',
      args: [200, 6, 200, 300, 500],
    })
    expect(c(await run('Now drag the map with one finger.'))[0].args).toEqual([
      280, 400, 120, 400, 600,
    ])
    expect(c(await run('Zoom 1 of 3: tap the highlighted ring (1 of 3).'))).toEqual([
      { m: 'tap', args: [123, 234] },
    ])
    expect(
      c(await run('Tap "Open second tab", look at the new tab, then come back to this one.')),
    ).toEqual([
      { m: 'tap', args: [50, 700] },
      { m: 'returnToBrowser', args: [] },
    ])
  })

  test('device-walk drive: a ring under its own button is tapped just below the button, the button itself at its centre', async () => {
    const o = {
      pages: { "of document.querySelectorAll('button')": () => ({ bottom: 250, cx: 120 }) },
    }
    const ring = await run('Zoom 1 of 3: tap the highlighted ring (1 of 3).', o)
    expect(ring.b.calls.find((c) => c.m === 'tap').args).toEqual([120, 254])
    const button = await run('Tap the highlighted button (it is numbered 26).', o)
    expect(button.b.calls.find((c) => c.m === 'tap').args).toEqual([123, 234])
  })

  test('device-walk drive: leaving the app is Home, the wait, the way back; airplane is on, wait, off', async () => {
    const { b } = await run(
      'Drop 1 of 3 (app-5s): Switch to another app for 0.2 seconds, then come back to this page.',
    )
    expect(b.names().filter((n) => n !== 'readPage')).toEqual(['home', 'returnToBrowser'])
    const a = await run('Turn airplane mode on for 0.1 seconds, then off, with this page in front.')
    expect(a.b.calls.filter((x) => x.m === 'setAirplane').map((x) => x.args[0])).toEqual([
      true,
      false,
    ])
  })

  test('device-walk drive: the absence is counted from the hidden beacon: Home, poll the page for hidden, then the way back', async () => {
    let polls = 0
    const b = createFakeBackend({
      pages: { visibilityState: () => (++polls < 3 ? 'visible' : 'hidden') },
    })
    await person(b).answer(
      act(
        'Drop 1 of 3 (app-5s): Switch to another app for 0.1 seconds, then come back to this page.',
      ),
    )
    const seq = b.calls.map((c) => (c.m === 'readPage' ? 'poll' : c.m)).join(',')
    expect(seq).toBe('home,poll,poll,poll,returnToBrowser')
  })

  test("device-walk drive: a hidden page that never answers does not hold the walk: the backend's hide lag stands in", async () => {
    const b = createFakeBackend({ pages: { visibilityState: () => new Promise(() => {}) } })
    const t0 = Date.now()
    await person(b, { pollMs: 5 }).answer(
      act(
        'Drop 1 of 3 (app-5s): Switch to another app for 0.05 seconds, then come back to this page.',
      ),
    )
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(b.calls.map((c) => c.m).filter((m) => m !== 'readPage')).toEqual([
      'home',
      'returnToBrowser',
    ])
  })

  test('device-walk drive: what a phone cannot do is NotDrivable with its reason, never a pass', async () => {
    const lock = await run(
      'Lock the screen for 60 seconds, then unlock the phone and come back to this page.',
    )
    expect(lock.out).toMatchObject({ status: 'notDrivable', handler: 'lock' })
    expect(lock.out.reason).toMatch(/never/)
    expect(lock.b.names()).toEqual([])
    const low = await run(
      'Turn Low Power Mode on (Settings, Battery), then come back to this page.',
      { lowPower: 'notDrivable' },
    )
    expect(low.out).toMatchObject({
      status: 'notDrivable',
      reason: 'the fake phone has no Low Power Mode',
    })
    expect((await run('Open this link in a Private tab: http://x/')).out.status).toBe('notDrivable')
    expect((await run('A prompt nobody wrote a handler for.')).out).toEqual({ status: 'unmatched' })
  })

  test('device-walk drive: a judge sheet is a screenshot and a pending answer, nothing tapped', async () => {
    const b = createFakeBackend()
    const out = await person(b, { shotPath: (p) => `/x/${p.id}-${p.n}-judge.png` }).answer({
      id: 'M11-gestures',
      n: 2,
      kind: 'judge',
      text: 'the flick glides',
    })
    expect(out).toEqual({ status: 'pending', shot: '/x/M11-gestures-2-judge.png' })
    // The sheet is looked for first (a page read), then the picture; nothing is tapped.
    expect(b.calls.filter((c) => c.m !== 'readPage')).toEqual([
      { m: 'screenshot', args: ['/x/M11-gestures-2-judge.png'] },
    ])
  })

  test('device-walk drive: the fake backend and the Android backend both implement the interface', () => {
    assertBackend(createFakeBackend())
    assertBackend(createAndroidBackend({ run: () => '', serial: 'x' }))
    expect(() => assertBackend({ open() {} })).toThrow(/lacks: readPage/)
  })
})

describe('device-walk drive: the drive loop over a round log', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'drive-'))
    const file = join(dir, 'r.jsonl')
    for (const e of [
      { type: 'start', only: null, mode: 'auto' },
      { type: 'walk', phase: 'start' },
      { type: 'attempt', id: 'M09b-fill-rate', n: 1, variant: 'fixture', page: 'p', rung: 0 },
    ])
      appendEvent(file, e)
    const b = createFakeBackend({ pages: { autolock: { runner: false } } })
    return { dir, file, b }
  }
  const drive = async (o) => {
    let done = false
    const d = startDrive({
      backend: o.b,
      person: person(o.b),
      file: o.file,
      ids: ['M09b-fill-rate', 'M16-low-power'],
      joinUrl: 'http://127.0.0.1:1/__walk/runner.html?walk=t',
      seriesDir: o.dir,
      append: (e) => appendEvent(o.file, e),
      settle: () => {},
      isDone: () => done,
      pollMs: 10,
    })
    await d.ready
    await o.until()
    done = true
    await d.stop()
  }

  test('device-walk drive: an open act prompt is answered once, however often the log is read', async () => {
    const { dir, file, b } = setup()
    appendEvent(file, {
      type: 'prompt',
      id: 'M09b-fill-rate',
      n: 1,
      kind: 'act',
      text: 'Rotate the phone to landscape.',
    })
    await drive({ b, dir, file, until: () => new Promise((r) => setTimeout(r, 150)) })
    expect(b.calls.filter((c) => c.m === 'rotate')).toHaveLength(1)
    expect(b.calls[0]).toMatchObject({ m: 'open' })
    expect(readEvents(file).find((e) => e.type === 'drive')).toMatchObject({
      id: 'M09b-fill-rate',
      action: 'done',
      handler: 'rotate',
    })
  })

  test('device-walk drive: NotDrivable ends the row as a skip with its reason', async () => {
    const { dir, file, b } = setup()
    appendEvent(file, {
      type: 'attempt',
      id: 'M16-low-power',
      n: 1,
      variant: 'fixture',
      page: 'p',
      rung: 0,
    })
    appendEvent(file, {
      type: 'prompt',
      id: 'M16-low-power',
      n: 1,
      kind: 'act',
      text: 'Lock the screen for 60 seconds, then unlock the phone and come back to this page.',
    })
    await drive({ b, dir, file, until: () => new Promise((r) => setTimeout(r, 150)) })
    const row = readEvents(file).find((e) => e.type === 'result')
    expect(row).toMatchObject({ id: 'M16-low-power', result: 'skip', by: 'device' })
    expect(row.notes).toMatch(/^NotDrivable: .*never/)
  })

  test('device-walk drive: a judge sheet gets a screenshot logged as evidence and stays open', async () => {
    const { dir, file, b } = setup()
    appendEvent(file, {
      type: 'attempt',
      id: 'M09b-fill-rate',
      n: 1,
      status: 'done',
      outcome: 'judge',
      criteria: [],
    })
    appendEvent(file, {
      type: 'prompt',
      id: 'M09b-fill-rate',
      n: 1,
      kind: 'judge',
      text: 'no visible hitch',
    })
    await drive({ b, dir, file, until: () => new Promise((r) => setTimeout(r, 150)) })
    expect(b.calls.filter((c) => c.m === 'screenshot').map((c) => c.args[0])).toEqual([
      join(dir, 'M09b-fill-rate-1-judge.png'),
    ])
    const ev = readEvents(file)
    expect(ev.find((e) => e.type === 'shot')).toMatchObject({
      id: 'M09b-fill-rate',
      n: 1,
      path: join(dir, 'M09b-fill-rate-1-judge.png'),
    })
    expect(ev.some((e) => e.type === 'result')).toBe(false)
    expect(replay(ev, [{ id: 'M09b-fill-rate' }]).items.get('M09b-fill-rate').shots).toHaveLength(1)
  })
})

describe('device-walk drive: the runner page behind a tunnel that does not resolve yet', () => {
  test('device-walk drive: an error page is opened again until the runner shows, then the pre-flight is tapped', async () => {
    let n = 0
    const b = createFakeBackend({
      pages: {
        autolock: () =>
          ++n < 3
            ? { runner: false, href: 'chrome-error://chromewebdata/' }
            : n === 3
              ? { runner: true, autolock: true, href: 'https://x/__walk/runner.html' }
              : { runner: false, walking: false, href: 'https://x/device.html' },
        'getElementById("autolock")': { x: 5, y: 6 },
      },
    })
    const log = []
    await passRunner(b, {
      joinUrl: 'https://x/__walk/runner.html',
      wait: async () => {},
      log: (l) => log.push(l),
    })
    expect(b.calls.filter((c) => c.m === 'open')).toHaveLength(2)
    expect(log.filter((l) => /opening it again/.test(l))).toHaveLength(2)
  })
})

describe('device-walk drive: a phone that went silent', () => {
  test('device-walk drive: a phone not heard from for idleMs is sent back to the join URL, at most three times', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drive-'))
    const file = join(dir, 'r.jsonl')
    for (const e of [
      { type: 'start', only: null, mode: 'auto' },
      { type: 'walk', phase: 'start' },
      { type: 'attempt', id: 'M09b-fill-rate', n: 1, variant: 'fixture', page: 'p', rung: 0 },
    ])
      appendEvent(file, e)
    const b = createFakeBackend({ pages: { autolock: { runner: false } } })
    let done = false
    const d = startDrive({
      backend: b,
      person: person(b),
      file,
      ids: ['M09b-fill-rate'],
      joinUrl: 'http://127.0.0.1:1/__walk/runner.html?walk=t',
      seriesDir: dir,
      append: (e) => appendEvent(file, e),
      settle: () => {},
      isDone: () => done,
      lastSeen: () => Date.now() - 10_000, // always 10 s ago
      idleMs: 30,
      pollMs: 5,
    })
    await d.ready
    await new Promise((r) => setTimeout(r, 400))
    done = true
    await d.stop()
    expect(b.calls.filter((c) => c.m === 'open')).toHaveLength(1 + 3)
    expect(readEvents(file).filter((e) => e.action === 'reopened')).toHaveLength(3)
  })

  test('device-walk drive: a phone heard from recently is left alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drive-'))
    const file = join(dir, 'r.jsonl')
    appendEvent(file, { type: 'start', only: null, mode: 'auto' })
    const b = createFakeBackend({ pages: { autolock: { runner: false } } })
    let done = false
    const d = startDrive({
      backend: b,
      person: person(b),
      file,
      ids: ['M09b-fill-rate'],
      joinUrl: 'http://127.0.0.1:1/__walk/runner.html?walk=t',
      seriesDir: dir,
      append: (e) => appendEvent(file, e),
      settle: () => {},
      isDone: () => done,
      lastSeen: () => Date.now(),
      idleMs: 30,
      pollMs: 5,
    })
    await d.ready
    await new Promise((r) => setTimeout(r, 200))
    done = true
    await d.stop()
    expect(b.calls.filter((c) => c.m === 'open')).toHaveLength(1)
  })
})

describe('device-walk drive: a resumed round does not answer twice', () => {
  const P = (kind, text, extra = {}) => ({
    type: 'prompt',
    id: 'M18-anchors',
    n: 1,
    kind,
    text,
    ...extra,
  })
  const p = (kind, text) => ({ id: 'M18-anchors', n: 1, kind, text })

  test('device-walk drive: an act or a judge sheet an earlier process answered is skipped; one asked again is not', () => {
    const act = 'Rotate the phone to landscape.'
    const ev = [P('act', act), { type: 'drive', id: 'M18-anchors', n: 1, kind: 'act', text: act }]
    expect(answeredInLog(ev, p('act', act))).toBe(true)
    // asked again after the answer (the page restarted): open again
    expect(answeredInLog([...ev, P('act', act)], p('act', act))).toBe(false)
    const judge = [P('judge', 'no swim'), { type: 'defer', id: 'M18-anchors', n: 1 }]
    expect(answeredInLog(judge, p('judge', 'no swim'))).toBe(true)
    expect(answeredInLog([P('judge', 'no swim')], p('judge', 'no swim'))).toBe(false)
  })

  test('device-walk drive: a judge sheet that is not on the phone yet is waited for; the shot says when it never showed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drive-'))
    const file = join(dir, 'r.jsonl')
    for (const e of [
      { type: 'start', only: null, mode: 'auto' },
      { type: 'walk', phase: 'start' },
      { type: 'attempt', id: 'M09b-fill-rate', n: 1, variant: 'fixture', page: 'p', rung: 0 },
      {
        type: 'attempt',
        id: 'M09b-fill-rate',
        n: 1,
        status: 'done',
        outcome: 'judge',
        criteria: [],
      },
      { type: 'prompt', id: 'M09b-fill-rate', n: 1, kind: 'judge', text: 'no visible hitch' },
    ])
      appendEvent(file, e)
    const b = createFakeBackend({ judgeShown: false, pages: { autolock: { runner: false } } })
    let done = false
    const d = startDrive({
      backend: b,
      person: person(b),
      file,
      ids: ['M09b-fill-rate'],
      joinUrl: 'http://127.0.0.1:1/__walk/runner.html?walk=t',
      seriesDir: dir,
      append: (e) => appendEvent(file, e),
      settle: () => {},
      isDone: () => done,
      pollMs: 10,
    })
    await d.ready
    await new Promise((r) => setTimeout(r, 200))
    done = true
    await d.stop()
    expect(readEvents(file).find((e) => e.type === 'shot')).toMatchObject({ unverified: true })
    expect(readEvents(file).some((e) => e.type === 'defer')).toBe(true)
  })
})

describe('device-walk drive: --judge', () => {
  const REAL = join(REPO, 'docs/plan/device-checks.md')
  const text = readFileSync(REAL, 'utf8')
  const { items } = parseChecks(text)
  const ids = ['M11-gestures']
  const log = [
    { type: 'start', only: ['M11-gestures'], mode: 'auto' },
    { type: 'attempt', id: 'M11-gestures', n: 1, variant: 'fixture', page: 'p', rung: 0 },
    {
      type: 'attempt',
      id: 'M11-gestures',
      n: 1,
      status: 'done',
      outcome: 'judge',
      criteria: [
        { name: 'steps', value: 7, limit: 7, ok: true },
        { name: 'world point under finger', value: null, limit: null, ok: null },
      ],
      metrics: { glide: 4.2 },
      evidence: join(REPO, 'test-results/device-walk/x/M11-gestures-1.json'),
    },
  ]

  test('device-walk drive: the verdict is a result row (by: orchestrator) that status, replay and apply read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'judge-'))
    const file = join(dir, 'r.jsonl')
    for (const e of log) appendEvent(file, e)
    const ev = judgeEvent({
      events: readEvents(file),
      ids,
      id: 'M11-gestures',
      value: 'pass',
      note: 'glides, stops',
      base: REPO,
    })
    expect(ev).toMatchObject({
      type: 'result',
      result: 'pass',
      by: 'orchestrator',
      attempt: 1,
      notes: 'glides, stops',
      evidence: 'test-results/device-walk/x/M11-gestures-1.json',
    })
    expect(ev.criteria[1]).toMatchObject({ ok: true, by: 'orchestrator' })
    appendEvent(file, ev)
    const sel = items.filter((i) => ids.includes(i.id))
    const state = replay(readEvents(file), sel)
    expect(state.items.get('M11-gestures')).toMatchObject({
      result: 'pass',
      by: 'orchestrator',
      notes: 'glides, stops',
    })
    const full = fullStatus({
      round: 'r',
      file,
      items: sel,
      events: readEvents(file),
      overrides: {},
      live: null,
    })
    expect(full.items[0]).toMatchObject({ id: 'M11-gestures', result: 'pass', by: 'orchestrator' })
    expect(full.remaining).toEqual([])
    const { changes } = applyRound(text, state, { round: 'r', overrides: {} })
    expect(changes.join('\n')).toMatch(/M11-gestures/)
  })

  test('device-walk drive: nothing to judge, a bad value and a second verdict are refused', () => {
    const open = log.slice(0, 2)
    expect(() => judgeEvent({ events: open, ids, id: 'M11-gestures', value: 'pass' })).toThrow(
      /no judge sheet open/,
    )
    expect(() => judgeEvent({ events: log, ids, id: 'M11-gestures', value: 'maybe' })).toThrow(
      /pass, fail or skip/,
    )
    expect(() => judgeEvent({ events: log, ids, id: 'M99-x', value: 'pass' })).toThrow(
      /not an item/,
    )
    const done = [
      ...log,
      { type: 'result', id: 'M11-gestures', result: 'pass', by: 'orchestrator' },
    ]
    expect(() => judgeEvent({ events: done, ids, id: 'M11-gestures', value: 'fail' })).toThrow(
      /already has a result/,
    )
  })
})

describe('device-walk drive: the Android backend without a phone', () => {
  const pageOf = (url) => ({ id: 'T1', type: 'page', url, webSocketDebuggerUrl: 'ws://x' })
  const make = (o = {}) => {
    const adb = []
    const m = { innerWidth: 392, innerHeight: 721, outerWidth: 393, outerHeight: 851, dpr: 2.75 }
    const b = createAndroidBackend({
      serial: 'S',
      sleep: async () => {},
      run: (args) => {
        adb.push(args.join(' '))
        if (args[0] === 'forward') return '41234\n'
        if (args[1]?.startsWith('dumpsys power')) return 'mWakefulness=Awake'
        if (args[1]?.startsWith('settings get system accelerometer_rotation')) return '1'
        if (args[1]?.startsWith('settings get system user_rotation')) return '0'
        return ''
      },
      fetchJson: async () => [pageOf('http://127.0.0.1:4173/__walk/runner.html')],
      connect: async () => ({
        send: async () => ({}),
        evaluate: async (js) => (/outerWidth/.test(js) ? m : undefined),
        close() {},
      }),
      ...o,
    })
    return { b, adb }
  }

  test('device-walk drive: the serial is the one attached, or the one asked for', () => {
    const out = 'List of devices attached\n13061FDD4002VN\tdevice\n\n'
    expect(pickSerial(out)).toBe('13061FDD4002VN')
    expect(() => pickSerial('List of devices attached\n')).toThrow(/0 devices/)
    expect(() => pickSerial(`${out}ZZ\tdevice\n`)).toThrow(/2 devices/)
    expect(() => pickSerial(out, 'nope')).toThrow(/no device nope/)
    expect(pickSerial(`${out}ZZ\tdevice\n`, 'ZZ')).toBe('ZZ')
  })

  test('device-walk drive: CSS px become screen px through the page offset and the pixel ratio (numbers measured on the Pixel 5)', () => {
    // Portrait: the page's top is 105.45 CSS px down (status bar and toolbar), the chin 24 below.
    const off = offsetsFor(
      { innerWidth: 392, innerHeight: 721.45, outerWidth: 393, outerHeight: 851, dpr: 2.75 },
      24.1,
    )
    expect(off.offY).toBeCloseTo(105.45, 1)
    expect(toScreen({ ...off, offX: 0 }, 196.36, 330.91)).toEqual({ x: 540, y: 1200 })
    // Landscape: the camera cutout puts 49.45 CSS px beside the page.
    const land = offsetsFor(
      { innerWidth: 801, innerHeight: 284.7, outerWidth: 851, outerHeight: 393, dpr: 2.75 },
      24.1,
    )
    expect(land.offX).toBeCloseTo(50, 0)
    expect(toScreen({ offX: 49.45, offY: 84, dpr: 2.75 }, 376, 112.36)).toEqual({ x: 1170, y: 540 })
  })

  test('device-walk drive: two-finger touch is start, equal moves, end, both fingers at every step', () => {
    const s = touchScript(
      [
        { from: { x: 100, y: 200 }, to: { x: 150, y: 200 } },
        { from: { x: 300, y: 200 }, to: { x: 250, y: 200 } },
      ],
      5,
    )
    expect(s.map((e) => e.type)).toEqual([
      'touchStart',
      'touchMove',
      'touchMove',
      'touchMove',
      'touchMove',
      'touchMove',
      'touchEnd',
    ])
    expect(s[0].touchPoints.map((p) => [p.id, p.x])).toEqual([
      [0, 100],
      [1, 300],
    ])
    expect(s[5].touchPoints.map((p) => p.x)).toEqual([150, 250])
    expect(s[6].touchPoints).toEqual([])
  })

  test('device-walk drive: rotation, Home, airplane and the way back are plain adb; cleanup restores what it changed', async () => {
    const { b, adb } = make()
    await b.rotate('landscape')
    await b.home()
    await b.setAirplane(true)
    await b.reverse([4173])
    await b.cleanup()
    expect(adb).toContain('shell settings put system user_rotation 1')
    expect(adb).toContain('shell input keyevent KEYCODE_HOME')
    expect(adb).toContain('shell cmd connectivity airplane-mode enable')
    expect(adb).toContain('shell cmd connectivity airplane-mode disable')
    expect(adb).toContain('shell settings put system user_rotation 0')
    expect(adb).toContain('shell settings put system accelerometer_rotation 1')
    expect(adb).toContain('reverse --remove tcp:4173')
    expect(adb.filter((c) => /KEYCODE_(SLEEP|POWER)|unplug|input keyevent 26/.test(c))).toEqual([])
  })

  test('device-walk drive: a handler still running after cleanup cannot set an adb forward up again', async () => {
    const { b, adb } = make()
    await b.readPage('1').catch(() => {})
    await b.cleanup()
    const before = adb.filter((c) => c.startsWith('forward ')).length
    await expect(b.readPage('1')).rejects.toThrow(/shut down/)
    expect(adb.filter((c) => c.startsWith('forward ')).length).toBe(before)
  })

  test('device-walk drive: Low Power Mode is NotDrivable on a charging Pixel, and the screen is only ever woken', async () => {
    const { b } = make()
    await expect(b.setLowPower(true)).rejects.toBeInstanceOf(NotDrivable)
    const asleep = []
    const c = createAndroidBackend({
      serial: 'S',
      run: (args) => {
        asleep.push(args.join(' '))
        return args[1]?.startsWith('dumpsys power') ? 'mWakefulness=Asleep' : ''
      },
    })
    await c.cleanup()
    expect(asleep).toContain('shell input keyevent KEYCODE_WAKEUP')
  })
})

describe('device-walk drive: a fresh camera per attempt, and the world point under the finger (M39j delegation 2)', () => {
  const agentSrc = readFileSync(join(AGENT, 'agent.js'), 'utf8')
  const driverSrc = readFileSync(join(AGENT, 'driver.js'), 'utf8')

  test('device-walk drive: the agent clears the key prefix the engine saves its camera under', () => {
    const prefix = cameraStorageKey('anything').slice(0, -'anything'.length)
    expect(prefix).toMatch(/^engine:camera:v\d+:$/)
    expect(agentSrc, 'agent.js CAMERA_PREFIX follows persistence.ts').toContain(
      `const CAMERA_PREFIX = '${prefix}'`,
    )
    expect(cameraStorageKey()).toBe(`${prefix}default`)
  })

  test('device-walk drive: a collector that gives up with no interruption is a result (actTimedOut), not an endless wait', () => {
    expect(driverSrc).toContain('actTimedOut: true')
    expect(driverSrc).toMatch(/if \(A\.measure\(\)\.interrupted\) return/)
    expect(driverSrc).not.toMatch(/if \(data === null\) return/)
  })

  test('device-walk drive: every navigation to an attempt asks for a fresh camera unless the check keeps it', () => {
    expect(driverSrc).toContain('_fresh')
    expect((driverSrc.match(/freshUrl\(/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(driverSrc).toContain("item.plan.keepCamera ? {} : { _fresh: '1' }")
    expect(CHECKS['M23-kill-resume'].plan.keepCamera).toBe(true)
    const keeps = Object.entries(CHECKS)
      .filter(([, e]) => e.plan.keepCamera)
      .map(([id]) => id)
    expect(keeps).toEqual(['M23-kill-resume'])
  })

  test("device-walk drive: the pointer log's world point is the engine's screenToWorld", () => {
    const src = readFileSync(join(AGENT, 'collect-touch.js'), 'utf8')
    const fn = /function worldUnder\(r, x, y\) \{[\s\S]*?\n {2}\}\n/.exec(src)?.[0]
    expect(fn).toBeTruthy()
    const make = (w, h) =>
      new Function('document', `${fn}; return worldUnder`)({
        querySelector: () => ({
          getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
        }),
      })
    for (const [w, h, st, x, y] of [
      [392, 745, { centreX: 3.5, centreY: -7.25, tilesAcross: 12 }, 100, 600],
      [801, 308, { centreX: -40, centreY: 12, tilesAcross: 256 }, 700, 20],
    ]) {
      const out = { x: 0, y: 0 }
      screenToWorld(st, { widthPx: w, heightPx: h }, x, y, out)
      const got = make(w, h)(
        { centre_x: st.centreX, centre_y: st.centreY, tiles_across: st.tilesAcross },
        x,
        y,
      )
      expect(got.x).toBeCloseTo(out.x, 9)
      expect(got.y).toBeCloseTo(out.y, 9)
    }
  })

  test('device-walk drive: M11 fails past one tile of drift, passes within it, and shows the rotation with its units', () => {
    const data = (drift) => ({
      steps_done: 7,
      pointer: { pageScrolled: false, pageZoomed: false, worldPointDriftTiles: drift },
      reloads: 0,
      final: { cursor_valid: true },
      rotation: {
        centreShiftPx: 17.9,
        centreShiftTiles: 0.27,
        shown: 'the centre moved 0.27 tiles (17.9 px) across the rotation',
      },
      camera: { judged: 'zoom 12 to 256 tiles across; flick glided 7.2 tiles' },
    })
    const ok = evaluate(CHECKS['M11-gestures'], data(0.4))
    expect(ok.verdict).toBe('judge')
    expect(ok.criteria.find((c) => c.name === 'world_point_drift_tiles')).toMatchObject({
      value: 0.4,
      limit: 1,
      ok: true,
    })
    expect(ok.criteria.find((c) => c.name === 'rotation_keeps_centre').value).toMatch(
      /0\.27 tiles \(17\.9 px\)/,
    )
    expect(evaluate(CHECKS['M11-gestures'], data(1.4)).verdict).toBe('fail')
    expect(evaluate(CHECKS['M11-gestures'], data(null)).verdict).toBe('fail') // never measured
    expect(
      CHECKS['M11-gestures'].criteria.find((c) => c.name === 'world_point_drift_tiles').ref,
    ).toMatch(/^0019 §3/)
  })
})

describe('device-walk drive: the iOS backend without a phone', () => {
  const make = (answers = {}) => {
    const calls = []
    const call = async (method, path, body) => {
      calls.push([method, path, body])
      for (const [re, v] of Object.entries(answers))
        if (new RegExp(re).test(`${method} ${path}`)) return typeof v === 'function' ? v(body) : v
      if (path === '/session') return { sessionId: 'SID' }
      if (path.endsWith('/contexts')) return ['NATIVE_APP', 'WEBVIEW_1']
      if (path.endsWith('/execute/sync')) {
        if (body.script === 'mobile: getContexts')
          return [
            { id: 'NATIVE_APP' },
            { id: 'WEBVIEW_1', title: 'device', url: 'https://x.example/device.html' },
          ]
        return body.script === 'return location.href' ? 'https://x.example/device.html' : null
      }
      return null
    }
    const b = createIosBackend({ call, sleep: async () => {}, log: () => {} })
    return { b, calls, paths: () => calls.map((c) => `${c[0]} ${c[1]}`) }
  }

  test('device-walk drive: W3C actions are two touch pointers moving together; a tap is down, pause, up', () => {
    const [a, b] = pointerActions(
      [
        { from: { x: 10, y: 20 }, to: { x: 110, y: 20 } },
        { from: { x: 300, y: 20 }, to: { x: 200, y: 20 } },
      ],
      600,
    )
    expect([a.id, b.id]).toEqual(['finger1', 'finger2'])
    expect(a.parameters.pointerType).toBe('touch')
    expect(a.actions.map((x) => x.type)).toEqual([
      'pointerMove',
      'pointerDown',
      'pointerMove',
      'pointerUp',
    ])
    expect(b.actions[2]).toMatchObject({ x: 200, duration: 600 })
    const [t] = tapActions(5, 6, 2)
    expect(t.actions.filter((x) => x.type === 'pointerDown')).toHaveLength(2)
  })

  test('device-walk drive: rotation, Home and the way back are the WDA calls the spike measured', async () => {
    const { b, paths, calls } = make()
    await b.open('https://x.example/device.html')
    await b.rotate('landscape')
    await b.home()
    await b.returnToBrowser()
    expect(calls.find((c) => c[1] === '/session/SID/orientation')[2]).toEqual({
      orientation: 'LANDSCAPE',
    })
    const scripts = calls.filter((c) => c[1].endsWith('/execute/sync')).map((c) => c[2].script)
    expect(scripts).toContain('mobile: deepLink')
    expect(scripts).toContain('mobile: pressButton')
    expect(scripts).toContain('mobile: activateApp')
    expect(paths()[0]).toBe('POST /session')
  })

  test('device-walk drive: a tap is placed through the offset one swallowed calibration tap taught', async () => {
    let cal = null
    const { b, calls } = make({
      'execute/sync': (body) => {
        if (body.script === 'mobile: getContexts')
          return [{ id: 'WEBVIEW_1', title: 'device', url: 'https://x.example/device.html' }]
        if (body.script === 'return location.href') return 'https://x.example/device.html'
        if (/innerWidth/.test(body.script) && /screen\.width/.test(body.script))
          return { w: 390, h: 664, sw: 390, sh: 844, s: 1 }
        if (/__driveCal\)$/.test(body.script)) return cal
        return null
      },
      'POST /session/SID/actions': (body) => {
        cal = [195 - 0, 422 - 100] // a page that starts 100 points down
        return null
      },
    })
    await b.open('https://x.example/device.html')
    await b.tap(50, 60)
    const actions = calls
      .filter((c) => c[1].endsWith('/actions'))
      .map((c) => c[2].actions[0].actions)
    expect(actions).toHaveLength(2) // the calibration tap, then ours
    expect(actions[0][0]).toMatchObject({ x: 195, y: 422 })
    expect(actions[1][0]).toMatchObject({ x: 50, y: 160 })
    await b.tap(10, 10)
    expect(calls.filter((c) => c[1].endsWith('/actions'))).toHaveLength(3) // learned once per page size
  })

  test('device-walk drive: Low Power and Airplane go back off in cleanup, then the session ends; the screen is never locked', async () => {
    const { b, calls } = make({
      'attribute/name': () => 'LOW_POWER_MODE_IDENTIFIER_SWITCH',
      'attribute/value': () => '1',
      '/element$': () => ({ 'element-6066-11e4-a52e-4f735466cecf': 'E1' }),
    })
    await b.open('https://x.example/device.html')
    await b.setLowPower(true)
    await b.setAirplane(true)
    await b.cleanup()
    const off = calls.filter(
      (c) =>
        c[1].endsWith('/click') || c[1].endsWith('/tap') || /airplane/i.test(JSON.stringify(c[2])),
    )
    expect(off.length).toBeGreaterThan(2)
    expect(calls.at(-1)).toEqual(['DELETE', '/session/SID', undefined])
    expect(JSON.stringify(calls)).not.toMatch(/lock|sleep|screenOff/i)
  })

  test('device-walk drive: a stale Low Power switch is found again and clicked, not given up on', async () => {
    let clicks = 0
    let value = '0'
    const { b } = make({
      'attribute/name': () => 'LOW_POWER_MODE_IDENTIFIER_SWITCH',
      '/element$': (body) => ({
        'element-6066-11e4-a52e-4f735466cecf':
          body.value === 'BATTERY_PERCENTAGE_IDENTIFIER_SWITCH' ? 'BP' : 'E1',
      }),
      '/element/BP/attribute/value': () => '0',
      '/element/E1/attribute/value': () => value,
      '/element/E1/click$': () => {
        if (++clicks === 1) throw new Error('POST /element/E1/click: stale element reference: gone')
        value = '1'
        return null
      },
    })
    await b.open('https://x.example/device.html')
    await b.setLowPower(true)
    expect(clicks).toBe(2)
    expect(value).toBe('1')
  })

  test('device-walk drive: a switch that is not Low Power is never clicked, and "Battery Percentage" is put back if it moved', async () => {
    // Every element answers with another switch's name: nothing may be clicked.
    const wrong = make({
      'attribute/name': () => 'BATTERY_PERCENTAGE_IDENTIFIER_SWITCH',
      'attribute/value': () => '0',
      '/element$': () => ({ 'element-6066-11e4-a52e-4f735466cecf': 'E1' }),
    })
    await wrong.b.open('https://x.example/device.html')
    const before = wrong.calls.length
    await expect(wrong.b.setLowPower(true)).rejects.toThrow(/not the Low Power switch/)
    expect(wrong.calls.slice(before).filter((c) => c[1].endsWith('/click'))).toHaveLength(0)
    // A click that also moved Battery Percentage: put back (a second click on it).
    let bp = '0'
    let lp = '0'
    const moved = make({
      'attribute/name': () => 'LOW_POWER_MODE_IDENTIFIER_SWITCH',
      '/element$': (body) => ({
        'element-6066-11e4-a52e-4f735466cecf':
          body.value === 'BATTERY_PERCENTAGE_IDENTIFIER_SWITCH' ? 'BP' : 'LP',
      }),
      '/element/LP/attribute/value': () => lp,
      '/element/BP/attribute/value': () => bp,
      '/element/LP/click': () => {
        lp = '1'
        bp = '1' // the same click moved the other switch too
        return null
      },
      '/element/BP/click': () => {
        bp = '0'
        return null
      },
    })
    await moved.b.open('https://x.example/device.html')
    bp = '0' // (opening Safari clicked the same fake element)
    lp = '0'
    await moved.b.setLowPower(true)
    expect(bp).toBe('0')
    expect(lp).toBe('1')
  })

  test('device-walk drive: when the Low Power flow fails Settings is not left in front (the check page is frozen behind it)', async () => {
    const { b, calls } = make({
      '/element$': () => {
        throw new Error('no such element')
      },
    })
    await b.open('https://x.example/device.html')
    await expect(b.setLowPower(true)).rejects.toThrow(/no Battery row|no Low Power/)
    const acts = calls
      .filter((c) => c[2]?.script === 'mobile: activateApp')
      .map((c) => c[2].args[0].bundleId)
    expect(acts.at(-1)).toBe('com.apple.mobilesafari')
  })

  test('device-walk drive: one WDA session for the whole round, logged with its number and time', async () => {
    const logs = []
    const calls = []
    const call = async (method, path, body) => {
      calls.push(`${method} ${path}`)
      if (path === '/session') return { sessionId: 'SID' }
      if (body?.script === 'mobile: getContexts')
        return [{ id: 'WEBVIEW_1', title: '', url: 'https://x.example/device.html' }]
      return null
    }
    const b = createIosBackend({ call, sleep: async () => {}, log: (l) => logs.push(l) })
    await b.open('https://x.example/device.html')
    await b.readPage('1')
    await b.rotate('landscape')
    await b.screenshot('/dev/null').catch(() => {})
    expect(calls.filter((c) => c === 'POST /session')).toHaveLength(1)
    expect(b.sessionCount()).toBe(1)
    expect(logs.filter((l) => /^ios: WDA session #\d+/.test(l))).toEqual([
      expect.stringMatching(
        /^ios: WDA session #1 \(start\): starting \(xcodebuild\) at \d{4}-\d\d-\d\dT/,
      ),
    ])
  })

  test('device-walk drive: a session Appium dropped is replaced by one that reuses the running WDA, and the call goes on', async () => {
    const logs = []
    const posts = []
    let dropped = false
    const call = async (method, path, body) => {
      if (path === '/session') {
        posts.push(body.capabilities.alwaysMatch)
        return { sessionId: posts.length === 1 ? 'S1' : 'S2' }
      }
      if (path === '/session/S1/orientation' && !dropped) {
        dropped = true
        throw new Error(
          'POST /session/S1/orientation: invalid session id: A session is either terminated or not started',
        )
      }
      return null
    }
    const b = createIosBackend({ call, sleep: async () => {}, log: (l) => logs.push(l) })
    await b.start()
    await b.rotate('landscape')
    expect(posts).toHaveLength(2)
    expect(posts[1]['appium:useNewWDA']).toBe(false)
    expect(b.sessionCount()).toBe(2)
    expect(b.sessions().map((x) => x.why)).toEqual(['start', 'reconnect'])
    expect(logs.some((l) => /reconnecting to the running WDA \(no new xcodebuild\)/.test(l))).toBe(
      true,
    )
  })

  test('device-walk drive: the passcode sheet (WDA code 65) is one clear line and one pause, then the tool stops; no loop', async () => {
    process.env.IOS_SHEET_PAUSE_S = '0'
    try {
      const logs = []
      let posts = 0
      const call = async (method, path) => {
        if (path === '/session') {
          posts++
          throw new Error(
            'POST /session: unknown error: Unable to launch WebDriverAgent. Original error: xcodebuild failed with code 65.',
          )
        }
        return null
      }
      const b = createIosBackend({ call, sleep: async () => {}, log: (l) => logs.push(l) })
      await expect(b.start()).rejects.toThrow(
        /passcode sheet.*Tyler must enter the passcode or turn the passcode off/,
      )
      expect(posts).toBe(2)
      expect(logs.filter((l) => /passcode sheet/.test(l))).toHaveLength(1)
    } finally {
      delete process.env.IOS_SHEET_PAUSE_S
    }
  })

  test('device-walk drive: only a webview showing one of our pages is ever entered (extension, about:blank and error pages are not)', async () => {
    const { b, calls } = make({
      'execute/sync': (body) =>
        body.script === 'mobile: getContexts'
          ? [
              { id: 'NATIVE_APP' },
              { id: 'WEBVIEW_1', title: '', url: 'data:text/html,' },
              { id: 'WEBVIEW_2', title: '', url: 'safari-web-extension://ABC/_background.html' },
              { id: 'WEBVIEW_3', title: '', url: 'about:blank' },
              { id: 'WEBVIEW_4', title: 'device', url: 'https://x.example/device.html' },
            ]
          : body.script === 'return document.visibilityState'
            ? 'visible'
            : null,
    })
    await b.open('https://x.example/device.html')
    const entered = calls.filter((c) => c[1].endsWith('/context')).map((c) => c[2].name)
    expect(entered).not.toContain('WEBVIEW_1')
    expect(entered).not.toContain('WEBVIEW_2')
    expect(entered).not.toContain('WEBVIEW_3')
    expect(entered).toContain('WEBVIEW_4')
  })

  test('device-walk drive: Safari that never shows the page is asked once more, then the round fails with a message (no silent loop)', async () => {
    const logs = []
    const calls = []
    const call = async (method, path, body) => {
      calls.push(body?.script ?? path)
      if (path === '/session') return { sessionId: 'SID' }
      if (body?.script === 'mobile: getContexts')
        return [{ id: 'WEBVIEW_1', title: '', url: 'data:text/html,' }]
      return null
    }
    const b = createIosBackend({ call, sleep: async () => {}, log: (l) => logs.push(l) })
    await expect(b.open('https://x.example/device.html')).rejects.toThrow(
      /did not load https:\/\/x\.example\/device\.html in two minutes \(it shows: data:text\/html,\)/,
    )
    expect(calls.filter((c) => c === 'mobile: deepLink')).toHaveLength(2)
    // One line when the pages change, not one per poll.
    expect(logs.filter((l) => /^ios: Safari shows/.test(l))).toHaveLength(1)
  })

  test('device-walk drive: abortAll ends a call to a hung Appium at once', async () => {
    const { createServer } = await import('node:http')
    const srv = createServer(() => {}) // never answers
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const pending = appiumCall(
      `http://127.0.0.1:${srv.address().port}`,
      'GET',
      '/x',
      undefined,
      60_000,
    )
    const t0 = Date.now()
    setTimeout(abortAll, 50)
    await expect(pending).rejects.toThrow(/aborted/)
    expect(Date.now() - t0).toBeLessThan(2000)
    srv.close()
    srv.closeAllConnections?.()
  })

  test('device-walk drive: a step that never answers is given up after its deadline and the rest goes on', async () => {
    const t0 = Date.now()
    await expect(withDeadline(new Promise(() => {}), 40, 'restore')).rejects.toThrow(
      /restore timed out after 40 ms/,
    )
    const logs = []
    expect(
      await bestEffort(new Promise(() => {}), 30, 'cleanup', (l) => logs.push(l)),
    ).toBeUndefined()
    expect(await bestEffort(Promise.resolve(7), 30, 'ok')).toBe(7)
    expect(logs[0]).toMatch(/cleanup: cleanup timed out/)
    expect(Date.now() - t0).toBeLessThan(1500)
  })

  test('device-walk drive: appiumCall rejects a WebDriver error with its message', async () => {
    const { createServer } = await import('node:http')
    const srv = createServer((_, res) =>
      res.end(JSON.stringify({ value: { error: 'no such element', message: 'gone' } })),
    )
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    await expect(appiumCall(`http://127.0.0.1:${srv.address().port}`, 'GET', '/x')).rejects.toThrow(
      /no such element: gone/,
    )
    srv.close()
  })
})
