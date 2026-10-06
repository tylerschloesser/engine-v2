// `pnpm device:walk --auto | --wait` (M39f step 13): the command line around `startAutoRound`. `--auto` starts
// the round (servers, phone API, the Mac monitor, one QR), keeps `state.json` current for other sessions and
// exits when every walked check has a result; `--wait` is how another session (the orchestrator, a sub-agent)
// blocks on it without polling the phone.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { startAutoRound } from './auto-cli.mjs'
import { createAndroidBackend } from './drive/android.mjs'
import { bestEffort } from './drive/deadline.mjs'
import { createIosBackend } from './drive/ios.mjs'
import { startDrive } from './drive/loop.mjs'
import { devicePerson } from './drive/person.mjs'
import { createLive, readLive, waitRound } from './live.mjs'
import { openMacBrowser } from './mac-browser.mjs'
import { createMonitor } from './monitor.mjs'
import { readEvents } from './rounds.mjs'
import { OVERRIDES } from './serving.mjs'
import { reapStale, spawnServe } from './spawn-serve.mjs'
import { formatState, formatStatus, fullStatus } from './status.mjs'

/** Where a round's untracked files live: raw series, `qr.svg`, `state.json`. */
export const seriesDirFor = (repo, round, override) =>
  override ?? join(repo, 'test-results/device-walk', round)

/** The `--status --json` object of a round, read fresh from its log and `state.json`. */
export function readStatus({ round, file, items, seriesDir, now = Date.now(), alive }) {
  return fullStatus({
    round,
    file,
    items,
    events: readEvents(file),
    overrides: OVERRIDES,
    live: readLive(join(seriesDir, 'state.json')),
    now,
    alive,
  })
}

/** `--wait <round> [--timeout s] [--json]`. Returns the process exit code: 0 done, 2 stalled or timed out. */
export async function waitCli({ round, timeoutS, json, read, out = console.log }) {
  const { code, final, timedOut } = await waitRound({
    read,
    timeoutMs: timeoutS === undefined ? 600_000 : Math.round(Number(timeoutS) * 1000),
    onChange: (s) => out(`wait ${round}: ${formatState(s)}`),
  })
  if (timedOut) out(`wait ${round}: timed out (${formatState(final)})`)
  out(json ? JSON.stringify(final, null, 2) : `${formatStatus(final)}\n${formatState(final)}`)
  return code
}

/**
 * `--auto`: returns when the round is done (exit code 0) or was stopped (2). `o`: `{ repo, round, only, items,
 * file, seriesDir, tunnel, noOpen, noBuild, params, monitorPort, log, drive, makeBackend }`. `drive: 'android'`
 * (M39j): the Mac is the person: it opens the runner on the USB phone and answers the act prompts
 * (`drive/`); `makeBackend(kind)` is how a test supplies a backend.
 */
export async function autoCli(o) {
  const { repo, round, items, file, seriesDir, log = console.log } = o
  const stale = reapStale()
  if (stale.length) log(`stopped ${stale.length} server(s) left by an earlier run`)
  const prior = readLive(join(seriesDir, 'state.json'))
  if (prior?.pid && prior.pid !== process.pid && prior.phase !== 'stopped') {
    try {
      process.kill(prior.pid, 0)
      throw new Error(
        `round "${round}" is already running (pid ${prior.pid}); --wait it, or stop it first`,
      )
    } catch (e) {
      if (e.message.startsWith('round')) throw e
    }
  }
  const live = createLive({ path: join(seriesDir, 'state.json'), round })
  const ac = new AbortController()
  let run = null
  let monitor = null
  let beat = null
  let stopping = null
  let driver = null
  let backend = null
  // One shutdown, however many callers: a second one (the normal path after a signal) waits for the first,
  // so the process never exits with the phone half restored.
  // Every step has its own deadline: a hung Appium call or an unanswering page must not hold the shutdown (the
  // whole of it takes about 10 s at most, then the process exits).
  const shutdown = () =>
    (stopping ??= (async () => {
      ac.abort()
      clearInterval(beat)
      live.set({ phase: 'stopped' })
      await bestEffort(driver?.stop(), 2000, 'stopping the drive loop', log)
      await bestEffort(backend?.cleanup(), 6000, 'restoring the phone', log)
      await bestEffort(monitor?.close(), 1000, 'closing the monitor', log)
      await bestEffort(run?.stop(), 4000, 'stopping the servers', log)
    })())
  const bye = (code) => shutdown().finally(() => process.exit(code))
  // `pnpm` forwards a Ctrl-C to the tool on top of the one the terminal sends it: signals close together are one.
  // A signal 2 s or more after the first means the shutdown is stuck: leave at once.
  let firstSignal = 0
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(sig, () => {
      if (firstSignal && Date.now() - firstSignal > 2000) process.exit(130)
      if (firstSignal) return
      firstSignal = Date.now()
      bye(130)
      setTimeout(() => process.exit(130), 12_000).unref() // and the first does not wait for ever
    })
  process.on('uncaughtException', (e) => {
    console.error(e)
    bye(1)
  })

  const noBuild = o.noBuild ? ['--no-build'] : []
  const { botTimings, ...paramsRest } = o.params ?? {}
  try {
    log(`device:walk --auto, round "${round}"`)
    run = await startAutoRound({
      round,
      file,
      seriesDir,
      items,
      only: o.only,
      spawnServe: (args, io) => spawnServe([...args, ...noBuild], io),
      tunnel: o.tunnel,
      timeoutMs: o.timeoutMs,
      // `client: 'both'`: the phone walks its rows, the Mac's own browsers walk theirs. `botTimings` (dev and
      // tests) is the M34 bot's, not a round parameter.
      // A driven round is the phone's alone (the Mac's own browsers are not driven).
      params: { client: o.drive ? 'phone' : 'both', ...paramsRest },
      botTimings,
      signal: ac.signal,
      log,
      openMac: o.openMac ?? ((browser, url) => openMacBrowser(browser, url, { log })),
      basePort: o.basePort,
      wsBasePort: o.wsBasePort,
    })
    const walked = items.filter((i) => !i.android)
    const status = () => readStatus({ round, file, items: walked, seriesDir })
    monitor = createMonitor({
      status,
      event: (e) => {
        const known = new Set(walked.map((i) => i.id))
        if (!known.has(e.id)) throw new Error('bad id')
        if (e.type === 'redo') run.api.append({ type: 'redo', id: e.id })
        else if (e.type === 'result')
          run.api.append({
            type: 'result',
            id: e.id,
            result: e.result,
            by: 'human',
            notes: String(e.notes ?? ''),
          })
        else throw new Error('bad event')
        run.machine.settle()
      },
    })
    const monitorPort = await monitor.listen(Number(o.monitorPort ?? 0))
    const monitorUrl = `http://127.0.0.1:${monitorPort}/`
    live.set({ phase: 'serving', joinUrl: run.joinUrl, monitorUrl, mode: 'auto' })
    let lastAt = 0
    let lastMac = 0
    beat = setInterval(() => {
      const seen = run.api.seen()
      const mac = run.api.seenMac()
      if (seen.at !== lastAt) {
        lastAt = seen.at
        live.set({ phone: { lastSeen: seen.at, tab: seen.tab, count: seen.count } })
      }
      if (mac.at !== lastMac) {
        lastMac = mac.at
        live.set({ mac: { lastSeen: mac.at, tab: mac.tab, count: mac.count } })
      }
    }, 1000)
    log(`monitor: ${monitorUrl}   (Ctrl-C stops the tool and every server it started)`)
    log(`results: ${file}`)
    log(`another session: pnpm device:walk --wait ${round}   or   --status ${round} --json`)
    if (!o.noOpen && process.platform === 'darwin')
      spawn('open', [monitorUrl], { stdio: 'ignore', detached: true }).unref()
    if (o.drive) {
      backend = (
        o.makeBackend ??
        ((kind) => (kind === 'ios' ? createIosBackend({ log }) : createAndroidBackend({ log })))
      )(o.drive)
      backend.start?.().catch(() => {}) // the iPhone's WDA warm-up overlaps the rest; `open` waits for it
      // The phone reaches this Mac's servers on its own loopback: `adb reverse` each variant's port.
      const ports = Object.values(run.origins)
        .map((u) => new URL(u))
        .filter((u) => u.hostname === '127.0.0.1')
        .map((u) => Number(u.port))
      await backend.reverse?.(ports)
      live.set({ drive: o.drive })
      log(`driving the ${o.drive} phone over USB (no QR): ${run.joinUrl}`)
      driver = startDrive({
        backend,
        person: devicePerson(backend, { log }),
        file,
        ids: walked.map((i) => i.id),
        joinUrl: run.joinUrl,
        seriesDir,
        append: (e) => run.api.append(e),
        settle: () => run.machine.settle(),
        isDone: () => run.machine.done(),
        log,
      })
      driver.finished.catch((e) => {
        log(`drive failed: ${e.stack ?? e}`)
        ac.abort()
      })
    }
    const done = await run.finished()
    live.set({ phase: done ? 'done' : 'stopped' })
    const final = status()
    log(`${formatStatus(final)}\n${formatState({ ...final, state: done ? 'done' : final.state })}`)
    await shutdown()
    return done ? 0 : 2
  } catch (e) {
    await shutdown()
    throw e
  }
}
