// M39f step 1: the phone API (envelope, dedupe, token and Origin/Host gates) and the round-log replay of
// the events it appends.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { createPhoneApi } from './device-walk/phone-api.mjs'
import { appendEvent, checkRoundName, readEvents, replay } from './device-walk/rounds.mjs'

const TOKEN = 'a'.repeat(32)
let open = []
afterEach(async () => {
  for (const a of open) await a.close()
  open = []
})

async function boot(file, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dwp-'))
  file ??= join(dir, 'r.jsonl')
  writeFileSync(join(dir, 'agent.js'), '// agent')
  writeFileSync(join(dir, 'runner.html'), '<title>runner</title>')
  const api = createPhoneApi({
    file,
    round: 'r',
    token: TOKEN,
    seriesDir: join(dir, 'series'),
    agentPath: join(dir, 'agent.js'),
    runnerPath: join(dir, 'runner.html'),
    ...extra,
  })
  const port = await api.listen(0)
  open.push(api)
  const base = `http://127.0.0.1:${port}`
  const origin = base
  const post = (msgs, { token = TOKEN, headers = {} } = {}) =>
    fetch(`${base}/__walk/msg?walk=${token}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'text/plain', ...headers },
      body: JSON.stringify(msgs),
    })
  return { api, base, origin, port, post, file, dir }
}

const msg = (seq, type = 'visibility', more = {}) => ({
  run: 'r',
  tab: 't1',
  seq,
  t: 1000 + seq,
  type,
  ...more,
})

describe('device-walk phone api', () => {
  test('device-walk phone: seq is acked, a resend is ignored, src is stored and survives a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dwp-'))
    const file = join(dir, 'r.jsonl')
    const a = await boot(file)
    const r1 = await (await a.post([msg(1, 'visibility', { state: 'hidden' }), msg(2)])).json()
    expect(r1.replies.map((r) => [r.type, r.seq])).toEqual([
      ['ack', 1],
      ['ack', 2],
    ])
    const dup = await (await a.post([msg(2), msg(1)])).json()
    expect(dup.replies.every((r) => r.type === 'ack' && r.dup)).toBe(true)
    const ev = readEvents(file)
    expect(ev.map((e) => e.src)).toEqual([
      { tab: 't1', seq: 1 },
      { tab: 't1', seq: 2 },
    ])
    expect(ev[0]).toMatchObject({ type: 'visibility', state: 'hidden', pt: 1001 })
    // A new service on the same log rebuilds its table: seq 1 and 2 stay duplicates, 3 is new.
    await a.api.close()
    open = []
    const b = await boot(file)
    expect(b.api.lastSeq('t1')).toBe(2)
    const r = await (await b.post([msg(2), msg(3)])).json()
    expect(r.replies.map((x) => !!x.dup)).toEqual([true, false])
    expect(readEvents(file)).toHaveLength(3)
  })

  test('device-walk phone: hello answers with lastSeq and the step; ping and hello are not logged', async () => {
    const { post, file } = await boot(undefined, {
      stepFor: (events) => ({ events: events.length }),
    })
    await post([msg(1)])
    const [w, p] = (
      await (
        await post([
          { tab: 't1', type: 'hello' },
          { tab: 't1', type: 'ping' },
        ])
      ).json()
    ).replies
    expect(w).toMatchObject({ type: 'welcome', lastSeq: 1, step: { events: 1 } })
    expect(p.type).toBe('pong')
    expect(readEvents(file)).toHaveLength(1)
  })

  test('device-walk phone: bad envelopes and types are refused and never logged', async () => {
    const { post, file } = await boot()
    const rs = (
      await (
        await post([
          msg(1, 'rm-rf'),
          { ...msg(2), run: 'other' },
          { ...msg(3), tab: '../x' },
          msg(0),
          { ...msg(4), seq: 'x' },
          msg(1, 'visibility', { src: { tab: 'x', seq: 99 }, t: 5 }),
        ])
      ).json()
    ).replies
    expect(rs.map((r) => r.error ?? r.type)).toEqual(['type', 'run', 'tab', 'seq', 'seq', 'ack'])
    // Reserved fields cannot be overridden by the body: the type stays `visibility`, src stays ours.
    expect(readEvents(file)).toEqual([
      expect.objectContaining({ type: 'visibility', src: { tab: 't1', seq: 1 } }),
    ])
  })

  test("device-walk phone: a 10 minute window's series (600 readings, over 200 KB) is accepted over POST and over the socket", async () => {
    const a = await boot()
    const sample = { t: 1, isolated: true, adapter: 'qualcomm/adreno-6xx', note: 'x'.repeat(300) }
    const data = { windows: [{ samples: Array.from({ length: 700 }, () => sample) }] }
    expect(JSON.stringify(data).length).toBeGreaterThan(200_000)
    const r = await (await a.post([msg(1, 'series', { id: 'M16-coexist', n: 1, data })])).json()
    expect(r.replies[0]).toMatchObject({ type: 'ack', seq: 1 })
    const ws = new WebSocket(`${a.base.replace('http', 'ws')}/__walk/ws?walk=${TOKEN}&tab=t2`, {
      headers: { origin: a.origin },
    })
    await new Promise((res, rej) => {
      ws.on('open', res)
      ws.on('error', rej)
    })
    const ack = new Promise((res) =>
      ws.on('message', (m) => JSON.parse(String(m)).type === 'ack' && res(true)),
    )
    ws.send(JSON.stringify({ ...msg(1, 'series', { id: 'M16-coexist', n: 2, data }), tab: 't2' }))
    expect(await ack).toBe(true)
    ws.close()
  })

  test('device-walk phone: a series is written beside the log and referenced by path', async () => {
    const { post, file, dir } = await boot()
    await post([msg(1, 'series', { id: 'M03', n: 1, data: [1, 2, 3] })])
    const e = readEvents(file)[0]
    expect(e).toMatchObject({ type: 'series', id: 'M03', n: 1 })
    expect(JSON.parse(readFileSync(join(dir, 'series', 'M03-1.json'), 'utf8'))).toEqual([1, 2, 3])
    const bad = await (await post([msg(2, 'series', { id: '../escape', n: 1, data: 1 })])).json()
    expect(bad.replies[0].error).toBe('series')
  })

  test('device-walk phone: no token, a wrong token, a foreign Host or a foreign Origin is refused; /api/* does not exist', async () => {
    const { base, post, port, file, origin } = await boot()
    expect((await post([msg(1)], { token: 'b'.repeat(32) })).status).toBe(403)
    expect((await post([msg(1)], { token: '' })).status).toBe(403)
    expect((await fetch(`${base}/__walk/runner.html`)).status).toBe(403)
    expect((await fetch(`${base}/__walk/runner.html?walk=${TOKEN}`)).status).toBe(200)
    expect((await post([msg(1)], { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect((await post([msg(1)], { headers: { origin: '' } })).status).toBe(403)
    expect((await fetch(`${base}/api/state`)).status).toBe(404)
    expect((await fetch(`${base}/api/event`, { method: 'POST', body: '{}' })).status).toBe(404)
    // A Host that was never registered (a tunnel name nobody told us about) is refused, even with the token.
    const { request } = await import('node:http')
    const status = await new Promise((resolve, reject) => {
      const r = request(
        {
          port,
          host: '127.0.0.1',
          path: `/__walk/runner.html?walk=${TOKEN}`,
          headers: { host: 'evil.trycloudflare.com' },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode)
        },
      )
      r.on('error', reject)
      r.end()
    })
    expect(status).toBe(403)
    expect(readEvents(file)).toEqual([]) // nothing above reached the log
    // The agent script itself is public code; it is the one thing served without the token.
    expect((await fetch(`${base}/__walk/agent.js`)).status).toBe(200)
    expect(origin).toBe(base)
  })

  test('device-walk phone: the WebSocket needs the token and an allowed Origin; messages flow when it has both', async () => {
    const { port, file } = await boot()
    const tryWs = (qs, headers) =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/__walk/ws${qs}`, { headers })
        ws.on('open', () => resolve({ ws, ok: true }))
        ws.on('unexpected-response', (_q, res) => resolve({ ok: false, status: res.statusCode }))
        ws.on('error', () => {})
      })
    const origin = `http://127.0.0.1:${port}`
    expect(await tryWs('', { origin })).toMatchObject({ ok: false, status: 403 })
    expect(await tryWs(`?walk=${'c'.repeat(32)}`, { origin })).toMatchObject({
      ok: false,
      status: 403,
    })
    expect(await tryWs(`?walk=${TOKEN}`, { origin: 'https://evil.example' })).toMatchObject({
      ok: false,
      status: 403,
    })
    expect(await tryWs(`?walk=${TOKEN}`, {})).toMatchObject({ ok: false, status: 403 })
    const { ws, ok } = await tryWs(`?walk=${TOKEN}`, { origin })
    expect(ok).toBe(true)
    const got = new Promise((r) => ws.once('message', (d) => r(JSON.parse(String(d)))))
    ws.send(JSON.stringify(msg(1)))
    expect(await got).toMatchObject({ type: 'ack', seq: 1 })
    ws.close()
    expect(readEvents(file)).toHaveLength(1)
  })

  test('device-walk phone: cut(ms) refuses requests and closes the socket, then lets them through', async () => {
    let t = 1_000_000
    const { api, base, post, port } = await boot(undefined, { clock: () => t })
    const closed = new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/__walk/ws?walk=${TOKEN}`, {
        headers: { origin: base },
      })
      ws.on('open', () => api.cut(20_000))
      ws.on('close', () => resolve(true))
      ws.on('error', () => {})
    })
    expect(await closed).toBe(true)
    expect((await post([msg(1)])).status).toBe(503)
    t += 20_001
    expect((await post([msg(1)])).status).toBe(200)
  })
})

describe('device-walk round log, phone events', () => {
  const items = [{ id: 'M03-determinism' }, { id: 'M08-x' }]
  const log = (events) => {
    const file = join(mkdtempSync(join(tmpdir(), 'dwr-')), 'r.jsonl')
    for (const e of events) appendEvent(file, e, () => '2026-10-03T10:00:00.000Z')
    return readEvents(file)
  }

  test('device-walk replay: env, attempt, prompt and an extended result are read; numbers come from metrics', () => {
    const s = replay(
      log([
        { type: 'start', only: null },
        { type: 'env', ua: 'UA', src: { tab: 't', seq: 1 } },
        {
          type: 'attempt',
          id: 'M03-determinism',
          n: 1,
          variant: 'fixture',
          page: 'determinism.html',
        },
        { type: 'prompt', id: 'M03-determinism', n: 1, kind: 'act', text: 'rotate' },
        { type: 'attempt', id: 'M03-determinism', n: 1, status: 'interrupted' },
        {
          type: 'attempt',
          id: 'M03-determinism',
          n: 2,
          variant: 'fixture',
          page: 'determinism.html',
        },
        {
          type: 'result',
          id: 'M03-determinism',
          result: 'pass',
          by: 'auto',
          attempt: 2,
          criteria: [{ name: 'fixtures', value: 3, limit: 3, ok: true }],
          metrics: { p95_ms: 4.25, isolated: true },
          evidence: 'x.json',
        },
        { type: 'result', id: 'M39f-selftest', result: 'pass', metrics: { hold_ms: 360000 } },
      ]),
      items,
    )
    const it = s.items.get('M03-determinism')
    expect(s.env).toEqual({ ua: 'UA' })
    expect(it.attempts.map((a) => [a.n, a.status])).toEqual([
      [1, 'interrupted'],
      [2, 'open'],
    ])
    expect(it.prompts).toHaveLength(1)
    expect(it).toMatchObject({ result: 'pass', by: 'auto', numbers: 'p95_ms=4.25, isolated=true' })
    expect(it.criteria[0].ok).toBe(true)
    expect(s.others.get('M39f-selftest')).toMatchObject({
      result: 'pass',
      numbers: 'hold_ms=360000',
    })
  })

  test('device-walk replay: an M39e-shaped log replays as before (old result rows have no new fields)', () => {
    const s = replay(
      log([
        { type: 'result', id: 'M08-x', result: 'fail', notes: 'slow', numbers: '3 ms' },
        { type: 'result', id: 'M08-x', result: 'pass', notes: '', numbers: '' },
        { type: 'redo', id: 'M08-x' },
        { type: 'phone-future-event', id: 'M08-x' },
      ]),
      items,
    )
    const it = s.items.get('M08-x')
    expect(it.result).toBeNull()
    expect(it.history).toEqual([
      { t: expect.any(String), result: 'fail', notes: 'slow', numbers: '3 ms' },
      { t: expect.any(String), result: 'pass', notes: '', numbers: '' },
      { t: expect.any(String), result: null, redo: true },
    ])
  })
})

describe('device-walk round names', () => {
  test('device-walk round names: lower-case letters, digits and dashes only; the error names the bad character', () => {
    for (const ok of ['m39', 'selftest-2026-10-03', 'round-1', '0a'])
      expect(checkRoundName(ok), ok).toBeNull()
    expect(checkRoundName('selftest-2026-10-03.')).toMatch(/character "\." at position 20/)
    expect(checkRoundName('Demo')).toMatch(/character "D" at position 1/)
    expect(checkRoundName('a_b')).toMatch(/character "_" at position 2/)
    expect(checkRoundName('-x')).toMatch(/character "-" at position 1/)
    expect(checkRoundName('a b')).toMatch(/character " " at position 2/)
    for (const empty of ['', undefined, '--json']) expect(checkRoundName(empty)).toMatch(/required/)
  })

  test('device-walk round names: the CLI refuses a bad name for walk, selftest, status and apply, and an unknown round', async () => {
    const { spawnSync } = await import('node:child_process')
    const cwd = new URL('../../', import.meta.url)
    const run = (...a) =>
      spawnSync(
        'node',
        ['scripts/device-walk.mjs', '--rounds-dir', mkdtempSync(join(tmpdir(), 'dwn-')), ...a],
        {
          cwd,
          encoding: 'utf8',
        },
      )
    for (const args of [
      ['--round', 'x.', '--only', 'M03'],
      ['--selftest', '--round', 'x.'],
      ['--status', 'x.'],
      ['--apply', 'x.'],
    ]) {
      const r = run(...args)
      expect(r.status, args.join(' ')).toBe(1)
      expect(r.stderr).toMatch(/character "\." at position 2/)
    }
    const unknown = run('--status', 'nope')
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toMatch(/no round "nope"/)
  })
})
