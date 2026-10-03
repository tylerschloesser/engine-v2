// `pnpm device:walk --selftest` (M39f step 3): start the phone API and two fixture servers (two origins,
// one tunnel each, `--walk`), print the QR of the runner page and wait for the phone to walk the
// built-in `M39f-selftest` step. Prints the verdict and exits 0 on pass, 1 on fail.
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPhoneApi } from './phone-api.mjs'
import { qrSvg, qrTerminal } from './qr.mjs'
import { appendEvent, readEvents, replay } from './rounds.mjs'
import { createSelftest, DEFAULT_PARAMS, formatSelftest, SELFTEST_ID } from './selftest.mjs'
import { createMultiServerControl } from './servers.mjs'

/**
 * @param {{ round: string, file: string, seriesDir: string, spawnServe: Function, tunnel?: boolean,
 *   params?: typeof DEFAULT_PARAMS, basePort?: number, wsBasePort?: number, log?: (s: string) => void,
 *   timeoutMs?: number, signal?: AbortSignal, pollMs?: number }} o
 * @returns {Promise<{ row: object|null, stop(): Promise<void>, joinUrl: string }>} resolves when the
 *   run has a result (or on timeout/abort with `row: null`); the servers are still up until `stop()`.
 */
export async function runSelftest(o) {
  const { round, file, seriesDir, spawnServe, tunnel = true, log = console.log, pollMs = 500 } = o
  const params = o.params ?? DEFAULT_PARAMS
  const token = randomBytes(16).toString('hex')
  if (!readEvents(file).some((e) => e.type === 'start'))
    appendEvent(file, { type: 'start', only: [SELFTEST_ID], mode: 'selftest' })
  const origins = []
  const selftest = createSelftest({
    origins,
    params,
    onPhase: (e) =>
      log(`  phone: ${e.phase}${e.n ? ` ${e.n}` : ''}${e.origin ? ` @ ${e.origin}` : ''}`),
  })
  const api = createPhoneApi({ file, round, token, seriesDir, ...selftest })
  const walkPort = await api.listen(0)
  const control = createMultiServerControl({
    spawnServe,
    walkPort,
    basePort: o.basePort ?? Number(process.env.ENGINE_TEST_PORT ?? 4173),
    wsBasePort: o.wsBasePort ?? Number(process.env.ENGINE_WS_PORT ?? 4174),
  })
  const stop = async () => {
    await control.stopAll()
    await api.close()
  }
  try {
    log('starting two fixture servers (two origins)...')
    const variant = (key) => ({ key, app: 'fixture', ws: false, bench: false, tunnel })
    await control.ensureAll([variant('fixture-a'), variant('fixture-b')])
    for (const key of ['fixture-a', 'fixture-b']) {
      const u = control.urlsFor(key)
      origins.push(control.urlFor(key))
      for (const x of [u.loopback, u.tunnel, control.urlFor(key)]) if (x) api.allowHost(x)
      if (u.loopback) api.allowHost(u.loopback.replace('127.0.0.1', 'localhost'))
    }
    const joinUrl = `${origins[0]}/__walk/runner.html?walk=${token}&run=${encodeURIComponent(round)}`
    mkdirSync(seriesDir, { recursive: true })
    writeFileSync(join(seriesDir, 'qr.svg'), qrSvg(joinUrl))
    log(`\nScan with the iPhone camera (opens in Safari):\n${qrTerminal(joinUrl)}\n${joinUrl}\n`)
    const deadline = Date.now() + (o.timeoutMs ?? params.holdMs + 15 * 60_000)
    let row = null
    while (!row && Date.now() < deadline && !o.signal?.aborted) {
      row = replay(readEvents(file), []).others.get(SELFTEST_ID) ?? null
      if (!row) await new Promise((r) => setTimeout(r, pollMs))
    }
    if (row) log(formatSelftest(row))
    return { row, stop, joinUrl, token, api }
  } catch (e) {
    await stop()
    throw e
  }
}
