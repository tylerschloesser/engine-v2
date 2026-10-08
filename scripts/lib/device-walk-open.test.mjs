// M39ad: the iPhone's driverless round: the runner path warms before the join URL is printed, the opener, the
// WDA guard and the act prompts of a round with no hands.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { assertRunnerWarm } from './device-walk/auto-cli.mjs'
import { createFakePage } from './device-walk/fake-agent-page.mjs'
import { createIosOpener, openerArgs, startDriverless } from './device-walk/open-ios.mjs'
import { appendEvent, readEvents, replay } from './device-walk/rounds.mjs'
import { runnerPaths, warmTunnel } from './device-walk/warm.mjs'

const res = (status, headers, body = '') => ({
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  arrayBuffer: async () => new TextEncoder().encode(body).buffer,
})

describe('device-walk open: the tunnel warm-up covers the runner (step 2)', () => {
  const origin = 'https://x.trycloudflare.com'
  const html = { 'content-type': 'text/html; charset=utf-8' }
  const js = { 'content-type': 'text/javascript; charset=utf-8' }

  test('device-walk open: warm-up keeps waiting until the runner page and the agent script answer 200', async () => {
    let clock = 0
    let runner = 0
    const urls = []
    const fetch = async (url) => {
      urls.push(url)
      if (url.includes('/__walk/runner.html')) return runner++ < 3 ? res(404, {}) : res(200, html)
      return res(200, js)
    }
    const out = await warmTunnel({
      origin,
      paths: runnerPaths('tok'),
      fetch,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      pollMs: 1000,
      timeoutMs: 60_000,
    })
    expect(out).toMatchObject({ ok: true, rounds: 4 })
    expect(urls.some((u) => u.includes('/__walk/runner.html?walk=tok&warm=1'))).toBe(true)
    expect(urls.some((u) => u.endsWith('/__walk/agent.js'))).toBe(true)
  })

  test('device-walk open: a runner path that never answers 200 is not ok, within the bound', async () => {
    let clock = 0
    const out = await warmTunnel({
      origin,
      paths: runnerPaths('tok'),
      fetch: async (url) => (url.includes('runner.html') ? res(530, {}) : res(200, js)),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      pollMs: 2000,
      timeoutMs: 10_000,
    })
    expect(out.ok).toBe(false)
    expect(out.missing.map((m) => m.status)).toEqual([530])
    expect(out.waitedMs).toBeLessThanOrEqual(10_000)
  })

  test('device-walk open: a start whose tunnel never served the runner fails loudly; COOP-only gaps do not', () => {
    const dead = {
      origin: 'https://t1.trycloudflare.com',
      r: { runnerMissing: [{ path: '/__walk/runner.html?walk=tok&warm=1', status: 530 }] },
    }
    expect(() => assertRunnerWarm([{ origin: 'o', r: { runnerMissing: [] } }, dead])).toThrow(
      /never served the runner page: https:\/\/t1\.trycloudflare\.com \(\/__walk\/runner\.html 530\); no join URL printed/,
    )
    expect(() =>
      assertRunnerWarm([null, { origin: 'o', r: { ok: false, runnerMissing: [] } }]),
    ).not.toThrow()
  })
})

/** The runner page's inline script on the fake page, over a small element table (no DOM, no tap). */
async function runner(search) {
  const page = createFakePage({ search })
  const els = new Map()
  const el = (id) => {
    if (!els.has(id))
      els.set(id, {
        id,
        hidden: id !== 'idle',
        disabled: false,
        textContent: '',
        className: '',
        onclick: null,
        closest: () => ({ hidden: false }),
      })
    return els.get(id)
  }
  page.document.getElementById = el
  page.document.querySelector = () => ({ textContent: '' })
  page.window.__walkAgent.start = async () => {
    starts.n++
  }
  const starts = { n: 0 }
  const html = readFileSync(new URL('./device-walk/runner.html', import.meta.url), 'utf8')
  const inline = html.split('<script>')[1].split('</script>')[0]
  page.runSource(`var sessionStorage = window.sessionStorage;${inline}`)
  await page.connect()
  const sent = () => page.frames.map((f) => f.msg)
  const stepWalk = async () => {
    page.sockets[0].receive({
      type: 'step',
      step: {
        kind: 'walk',
        phase: 'idle',
        params: { probeMs: 2000 },
        progress: { done: 0, total: 1 },
      },
    })
    await page.advance(10)
  }
  return { page, el, sent, stepWalk, starts }
}

describe('device-walk open: autostart=1 (step 3)', () => {
  test('device-walk open: autostart sends walk start after the idle probe with no tap and no wake-lock request', async () => {
    const r = await runner('?walk=tok&run=r1&tab=t1&autostart=1')
    await r.stepWalk()
    expect(r.sent().some((m) => m.type === 'walk')).toBe(false) // not before the probe has passed
    await r.page.advance(2500)
    const walks = r.sent().filter((m) => m.type === 'walk')
    expect(walks).toHaveLength(1)
    expect(walks[0]).toMatchObject({ phase: 'start' })
    expect(r.sent().find((m) => m.type === 'selftest')).toMatchObject({
      phase: 'preflight',
      ok: true,
    })
    expect(r.sent().find((m) => m.type === 'env' && m.partial)).toMatchObject({
      wakeLock: 'skipped (autostart)',
    })
    expect(r.starts.n).toBe(0)
    expect(r.el('autolock').onclick).not.toBe(null) // still there for a person; just never needed
  })

  test('device-walk open: without autostart the page waits for the taps', async () => {
    const r = await runner('?walk=tok&run=r1&tab=t1')
    await r.stepWalk()
    await r.page.advance(5000)
    expect(r.sent().some((m) => m.type === 'walk')).toBe(false)
  })
})

describe('device-walk open: env facts (step 3, 5)', () => {
  test('device-walk open: a partial env adds opener, driver and wakeLock and survives a later full env', () => {
    const full = (ua) => ({ type: 'env', src: { tab: 't', seq: 1 }, ua, cores: 6 })
    const note = (o) => ({ type: 'env', partial: true, ...o })
    const st = replay(
      [
        full('A'),
        note({ opener: 'devicectl', driver: 'none' }),
        note({ wakeLock: 'skipped (autostart)' }),
        full('B'),
      ],
      [],
    )
    expect(st.env).toEqual({
      ua: 'B',
      cores: 6,
      opener: 'devicectl',
      driver: 'none',
      wakeLock: 'skipped (autostart)',
    })
  })
})

describe('device-walk open: --open ios (step 5)', () => {
  const ID = 'M29-net-heap'
  const URL_ = 'https://t1.trycloudflare.com/__walk/runner.html?walk=abc&run=r'
  const rig = (extra = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'walk-open-'))
    const file = join(dir, 'r.jsonl')
    const opened = []
    const opener = {
      name: 'devicectl',
      open: async (u) => void opened.push(u),
      screenshot: async () => false,
    }
    let over = false
    let windowFn = () => {}
    const d = startDriverless({
      opener,
      joinUrl: URL_,
      file,
      ids: [ID],
      seriesDir: dir,
      append: (e) => appendEvent(file, e),
      settle: () => {},
      isDone: () => over,
      lastSeen: () => extra.seen?.() ?? 0,
      onWindow: (fn) => {
        windowFn = fn
      },
      driverProcesses: () => [],
      pollMs: 5,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
      log: () => {},
      ...extra.o,
    })
    return { d, file, opened, finish: () => (over = true), window: (e) => windowFn(e) }
  }

  test('device-walk open: the opener is devicectl --payload-url into Safari, never WDA', async () => {
    expect(openerArgs({ udid: 'U', url: 'https://x/y?a=1' })).toEqual([
      'xcrun',
      'devicectl',
      'device',
      'process',
      'launch',
      '--device',
      'U',
      '--payload-url',
      'https://x/y?a=1',
      'com.apple.mobilesafari',
    ])
    const ran = []
    const o = createIosOpener({
      udid: 'U',
      run: async (argv) => (ran.push(argv), { code: 0, out: 'Launched application.' }),
    })
    await o.open('https://x/y')
    expect(ran[0].slice(0, 3)).toEqual(['xcrun', 'devicectl', 'device'])
    const bad = createIosOpener({ run: async () => ({ code: 1, out: 'device is locked' }) })
    await expect(bad.open('https://x')).rejects.toThrow(/could not open the URL.*locked/)
  })

  test('device-walk open: the URL is opened with autostart=1 after a clean process check, env records opener and driver none', async () => {
    const r = rig()
    await new Promise((x) => setTimeout(x, 30))
    r.finish()
    await r.d.finished
    expect(r.opened).toEqual([`${URL_}&autostart=1`])
    expect(replay(readEvents(r.file), []).env).toBeNull() // only partial facts so far: no full env yet
    expect(readEvents(r.file).find((e) => e.type === 'env')).toMatchObject({
      partial: true,
      opener: 'devicectl',
      driver: 'none',
    })
  })

  test('device-walk open: a live WDA process before the first window fails the round and nothing is opened', async () => {
    const r = rig({ o: { driverProcesses: () => ['4242 node appium --port 4723'] } })
    await expect(r.d.finished).rejects.toThrow(
      /driver process is alive before the first measuring window: 4242 node appium/,
    )
    expect(r.opened).toEqual([])
    expect(readEvents(r.file).find((e) => e.action === 'refused')).toBeTruthy()
  })

  test('device-walk open: a WDA process that appears is caught at the next window start', async () => {
    let alive = []
    const r = rig({ o: { driverProcesses: () => alive, guardEveryMs: 1e9 } })
    await new Promise((x) => setTimeout(x, 30))
    alive = ['7 xcodebuild -project WebDriverAgent.xcodeproj APPIUM_XCODEBUILD_WDA_MARKER']
    r.window({ phase: 'start', id: ID })
    await expect(r.d.finished).rejects.toThrow(/at a measuring window start/)
  })

  test('device-walk open: an act prompt ends as the NotDrivable skip by device, never a hang', async () => {
    const r = rig()
    appendEvent(r.file, { type: 'attempt', id: ID, n: 1, variant: 'fixture', page: 'p', rung: 0 })
    appendEvent(r.file, {
      type: 'prompt',
      id: ID,
      n: 1,
      kind: 'act',
      text: 'Turn airplane mode on for 10 seconds',
    })
    await new Promise((x) => setTimeout(x, 60))
    r.finish()
    await r.d.finished
    const res = readEvents(r.file).filter((e) => e.type === 'result')
    expect(res).toHaveLength(1)
    expect(res[0]).toMatchObject({
      id: ID,
      result: 'skip',
      by: 'device',
      notes: 'NotDrivable: driverless open has no hands (Turn airplane mode on for 10 seconds)',
    })
  })

  test('device-walk open: a phone not seen within the bound gets one more open, logged', async () => {
    const logs = []
    const r = rig({ o: { seenTimeoutMs: 20, log: (l) => logs.push(l) } })
    await new Promise((x) => setTimeout(x, 120))
    r.finish()
    await r.d.finished
    expect(r.opened).toHaveLength(2)
    expect(logs.some((l) => /not been seen.*opening the URL again/.test(l))).toBe(true)
  })
})
