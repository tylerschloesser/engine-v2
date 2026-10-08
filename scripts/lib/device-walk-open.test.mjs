// M39ad: the iPhone's driverless round: the runner path warms before the join URL is printed, the opener, the
// WDA guard and the act prompts of a round with no hands.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { assertRunnerWarm } from './device-walk/auto-cli.mjs'
import { createFakePage } from './device-walk/fake-agent-page.mjs'
import { replay } from './device-walk/rounds.mjs'
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
