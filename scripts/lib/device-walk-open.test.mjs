// M39ad: the iPhone's driverless round: the runner path warms before the join URL is printed, the opener, the
// WDA guard and the act prompts of a round with no hands.
import { describe, expect, test } from 'vitest'
import { assertRunnerWarm } from './device-walk/auto-cli.mjs'
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
