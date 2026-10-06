// M39n step 3: the tunnel warm-up, the websocket preflight, and the bot that waits for it.
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createBots } from './device-walk/bot.mjs'
import { CHECKS, MP_TILES } from './device-walk/checks.mjs'
import { appendEvent, readEvents } from './device-walk/rounds.mjs'
import { pagePaths, warmTunnel, wsHandshake } from './device-walk/warm.mjs'

const res = (status, headers) => ({
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  arrayBuffer: async () => new ArrayBuffer(0),
})
const isolated = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
}

describe('device-walk warm', () => {
  test('device-walk warm: the tunnel is polled until every path carries COOP and COEP; a cold name that lacks them keeps it waiting', async () => {
    const calls = []
    // The worker script is served without COEP for its first three requests (a cold edge).
    let worker = 0
    const fetch = async (url) => {
      calls.push(url)
      if (url.endsWith('/assets/w.js')) return res(200, ++worker > 3 ? isolated : {})
      return res(200, isolated)
    }
    let clock = 0
    const logs = []
    const out = await warmTunnel({
      origin: 'https://x.trycloudflare.com',
      paths: ['/', '/assets/w.js', '/assets/g.wasm'],
      fetch,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      pollMs: 1000,
      timeoutMs: 60_000,
      log: (l) => logs.push(l),
    })
    expect(out).toMatchObject({ ok: true, rounds: 4, missing: [], waitedMs: 3000 })
    expect(worker).toBe(4) // it did not stop at the first answer
    expect(logs[0]).toMatch(/tunnel warm: 3 path\(s\) carry COOP\/COEP after 4 round\(s\)/)
  })

  test('device-walk warm: a tunnel that never gets there is reported with what is missing, within the bound', async () => {
    let clock = 0
    const out = await warmTunnel({
      origin: 'https://x.trycloudflare.com',
      paths: ['/', '/assets/g.wasm'],
      fetch: async (url) => {
        if (url.endsWith('.wasm')) throw new Error('no route to the name yet')
        return res(200, isolated)
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      pollMs: 2000,
      timeoutMs: 10_000,
    })
    expect(out.ok).toBe(false)
    expect(out.missing).toEqual([{ path: '/assets/g.wasm', status: null, coop: null, coep: null }])
    expect(out.waitedMs).toBeLessThanOrEqual(10_000)
  })

  test('device-walk warm: the paths are the page, and every script and module of the build output', () => {
    const ls = () => ['worker-auto-1.js', 'game-2.wasm', 'budgets-3.json', 'main-4.js']
    expect(pagePaths('/dist', ls)).toEqual([
      '/',
      '/assets/game-2.wasm',
      '/assets/main-4.js',
      '/assets/worker-auto-1.js',
    ])
    expect(
      pagePaths('/nowhere', () => {
        throw new Error('ENOENT')
      }),
    ).toEqual(['/'])
  })

  test('device-walk warm: a websocket handshake is answered by a server that upgrades, and refused by one that does not or is not there', async () => {
    const up = createServer()
    up.on('upgrade', (req, socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      )
      socket.on('error', () => {})
    })
    const plain = createServer((_q, r) => r.end('hello'))
    for (const s of [up, plain]) await new Promise((r) => s.listen(0, '127.0.0.1', r))
    const o = (s) => `http://127.0.0.1:${s.address().port}`
    try {
      expect(await wsHandshake({ origin: o(up) })).toBe(true)
      expect(await wsHandshake({ origin: o(plain) })).toBe(false)
      const dead = o(plain)
      await new Promise((r) => plain.close(r))
      expect(await wsHandshake({ origin: dead, timeoutMs: 500 })).toBe(false)
    } finally {
      up.close()
    }
  })

  /** A Playwright stand-in whose page joins at once. */
  const launch = (joined) => async () => ({
    newContext: async () => ({
      newPage: async () => ({
        goto: async () => {},
        waitForFunction: async () => {},
        evaluate: async (_fn, arg) =>
          Array.isArray(arg)
            ? undefined
            : {
                link: 'online',
                ui_seen: true,
                spawn_x: 1,
                spawn_y: 2,
                roster: [],
                remote_circles: 0,
              },
        close: async () => {},
        on: () => {},
        url: () => 'u',
      }),
    }),
    close: async () => {
      joined.closed = true
    },
  })
  const waitFor = async (fn) => {
    for (let i = 0; i < 300 && !fn(); i++) await new Promise((r) => setTimeout(r, 10))
  }

  test('device-walk warm: the bot opens no page before the server answers a handshake, and says so when it never does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'walk-bot-'))
    const file = join(dir, 'r.jsonl')
    const state = { closed: false }
    let asked = 0
    const phases = () =>
      readEvents(file)
        .filter((e) => e.key === 'bot')
        .map((e) => e.data)
    const bots = createBots({
      file,
      append: (e) => appendEvent(file, e),
      origin: 'http://127.0.0.1:1',
      tiles: MP_TILES,
      launch: launch(state),
      timings: { pollMs: 5, handshakeMs: 2000 },
      handshake: async () => ++asked > 3,
    })
    bots.start({ id: 'M34-remote-motion', n: 1, plan: CHECKS['M34-remote-motion'].plan })
    await waitFor(() => phases().length > 0)
    expect(phases()[0]).toEqual({ phase: 'joined' })
    expect(asked).toBe(4)
    await bots.stop()

    const file2 = join(dir, 'r2.jsonl')
    const never = createBots({
      file: file2,
      append: (e) => appendEvent(file2, e),
      origin: 'http://127.0.0.1:1',
      tiles: MP_TILES,
      launch: launch({}),
      timings: { pollMs: 5, handshakeMs: 60 },
      handshake: async () => false,
      serverLog: () => ['[reference-server] boom'],
    })
    never.start({ id: 'M34-remote-motion', n: 1, plan: CHECKS['M34-remote-motion'].plan })
    await waitFor(() => readEvents(file2).some((e) => e.key === 'bot'))
    await never.stop()
    const failed = readEvents(file2).find((e) => e.key === 'bot').data
    expect(failed).toMatchObject({
      phase: 'failed',
      error: 'the server did not answer a websocket handshake',
      diag: { step: 'ws handshake', server: ['[reference-server] boom'] },
    })
  })
})
