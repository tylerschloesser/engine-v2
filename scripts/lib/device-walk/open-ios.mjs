// The driverless open of the USB iPhone (M39ad, ADR 0056): the Mac opens the round's join URL in Safari with
// `xcrun devicectl device process launch --payload-url` (CoreDevice: no WebDriverAgent, no Appium, no XCUITest,
// no Web Inspector), the page starts the walk itself (`&autostart=1`, `runner.html`), and this loop only watches
// the round log. Nothing here sends the phone a touch: an act prompt ends its row as a `NotDrivable` skip, a judge
// sheet is deferred like in a driven round (a screenshot through the DVT service is taken if the phone offers it).
// A live WDA session degrades WebKit's frame delivery, so before the first measuring window and at every window
// start the Mac must show no Appium, WDA or xcodebuild process; if it shows one the round fails loudly.
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { answeredInLog, openWindow } from './drive/loop.mjs'
import { openPrompts } from './live.mjs'
import { readEvents } from './rounds.mjs'

/** Tyler's test iPhone 12 (the only USB iPhone this tool is used with; `IOS_UDID` overrides). */
export const IOS_UDID = process.env.IOS_UDID ?? '00008101-001845EE1A82001E'

/** The command line of the opener (verified on the iPhone 12, 2026-10-08: Safari opened the URL in a new tab). */
export const openerArgs = ({ udid = IOS_UDID, url }) => [
  'xcrun',
  'devicectl',
  'device',
  'process',
  'launch',
  '--device',
  udid,
  '--payload-url',
  url,
  'com.apple.mobilesafari',
]

/** What identifies a WebDriver session on the Mac (the markers of `drive/ios.mjs`'s cleanup, plus its parents). */
export const DRIVER_PATTERN = 'appium|xcodebuild|WebDriverAgent|APPIUM_XCODEBUILD_WDA_MARKER'

/** Run `argv`, resolve `{ code, out }` (stdout and stderr, bounded by `timeoutMs`). */
function runFile(argv, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      out += d
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, out: String(e.message) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

/** Running Appium, WDA or xcodebuild processes (`pgrep -fl`, this process and the pgrep itself left out). */
export function driverProcesses() {
  const r = spawnSync('pgrep', ['-fl', DRIVER_PATTERN], { encoding: 'utf8' })
  return String(r.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith(`${process.pid} `))
}

/**
 * The opener. `open(url)` rejects when devicectl fails (a locked or unplugged phone, Safari not installed).
 * `screenshot(path)`: best effort through `pymobiledevice3 developer dvt screenshot` (no inspector, no WDA).
 */
export function createIosOpener({ udid = IOS_UDID, run = runFile, log = () => {} } = {}) {
  return {
    name: 'devicectl',
    udid,
    async open(url) {
      const { code, out } = await run(openerArgs({ udid, url }))
      if (code !== 0)
        throw new Error(
          `devicectl could not open the URL (exit ${code}): ${out.trim().slice(-300)}`,
        )
      log(`opened on the iPhone: ${out.trim().split('\n').pop()}`)
    },
    async screenshot(path) {
      const { code } = await run(
        ['pymobiledevice3', 'developer', 'dvt', 'screenshot', path],
        60_000,
      )
      return code === 0
    },
  }
}

/**
 * Open the round on the phone and watch it without touching it. `o`: `{ opener, joinUrl, file, ids, seriesDir,
 * append(event), settle(), isDone(), lastSeen(), onWindow(fn), driverProcesses?, log, pollMs, seenTimeoutMs,
 * guardEveryMs }`. Returns `{ ready, finished, stop() }` like `startDrive`; `finished` rejects when a driver
 * process is alive at a window start.
 */
export function startDriverless(o) {
  const { opener, file, ids, seriesDir, append, settle, isDone } = o
  const log = o.log ?? (() => {})
  const procs = o.driverProcesses ?? driverProcesses
  const pollMs = o.pollMs ?? 250
  const seenTimeoutMs = o.seenTimeoutMs ?? 60_000
  const guardEveryMs = o.guardEveryMs ?? 5000
  const url = `${o.joinUrl}${o.joinUrl.includes('?') ? '&' : '?'}autostart=1`
  let stopped = false
  let windowStarted = false
  o.onWindow?.((e) => {
    if (e.phase === 'start') windowStarted = true
  })

  const guard = (when) => {
    const alive = procs()
    if (!alive.length) return
    const msg = `a driver process is alive ${when}: ${alive.join(' | ').slice(0, 300)}; a WDA session degrades WebKit's frame delivery (ADR 0056), so the round is not measured`
    append({ type: 'drive', action: 'refused', id: 'walk', n: 0, reason: msg })
    throw new Error(msg)
  }

  async function onPrompt(p, events, handled) {
    const key = `${p.id}:${p.n}:${p.kind}:${p.text}`
    if (handled.has(key) || answeredInLog(events, p)) return
    handled.add(key)
    if (p.kind === 'judge') {
      const path = join(seriesDir, `${p.id}-${p.n}-judge.png`)
      const ok = await opener.screenshot?.(path).catch(() => false)
      if (ok) append({ type: 'shot', id: p.id, n: p.n, path })
      else log(`driverless: no screenshot of the ${p.id} judge sheet (the phone offered none)`)
      append({ type: 'defer', id: p.id, n: p.n })
      append({ type: 'drive', id: p.id, n: p.n, kind: p.kind, text: p.text, action: 'pending' })
      settle()
      return
    }
    // An act (or a redo) needs hands this mode does not have: the row ends here, never a hang.
    log(`driverless ${p.id} #${p.n} [${p.kind}] ${p.text.slice(0, 70)} -> notDrivable`)
    append({
      type: 'drive',
      id: p.id,
      n: p.n,
      kind: p.kind,
      text: p.text,
      action: 'notDrivable',
      handler: 'driverless',
    })
    append({
      type: 'result',
      id: p.id,
      result: 'skip',
      by: 'device',
      notes: `NotDrivable: driverless open has no hands (${p.text})`,
    })
    settle()
  }

  const ready = (async () => {
    guard('before the first measuring window')
    append({ type: 'env', partial: true, opener: opener.name, driver: 'none' })
  })()

  const finished = (async () => {
    await ready
    const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    let openedAt = Date.now()
    await opener.open(url)
    log(`driverless: opened ${url.replace(/walk=[0-9a-f]+/, 'walk=...')}`)
    let reopened = false
    let warned = false
    let guardedAt = Date.now()
    const handled = new Set()
    while (!stopped && !isDone()) {
      const seen = (o.lastSeen?.() ?? 0) > openedAt
      if (!seen) {
        const waited = Date.now() - openedAt
        if (!reopened && waited > seenTimeoutMs) {
          reopened = true
          log(
            `driverless: the phone has not been seen for ${Math.round(waited / 1000)} s, opening the URL again`,
          )
          append({
            type: 'drive',
            action: 'reopened',
            id: 'walk',
            n: 1,
            reason: `not seen for ${Math.round(waited / 1000)} s`,
          })
          openedAt = Date.now()
          await opener
            .open(url)
            .catch((e) => log(`driverless: reopening failed: ${String(e.message).slice(0, 160)}`))
        } else if (reopened && !warned && waited > seenTimeoutMs) {
          warned = true
          log(
            'driverless: the phone has still not been seen: see `--status --json` phone.requests (served, refused by reason) for what reached the Mac',
          )
        }
      }
      if (windowStarted) {
        windowStarted = false
        guard('at a measuring window start')
        guardedAt = Date.now()
      } else if (Date.now() - guardedAt > guardEveryMs) {
        guard('while the round runs')
        guardedAt = Date.now()
      }
      const events = readEvents(file)
      // A measuring window: the Mac does as little as it can (one cheap read per second, no `settle`).
      if (openWindow(events, Date.now(), 3000)) {
        await sleep(1000)
        continue
      }
      settle()
      for (const p of openPrompts(events, ids)) {
        if (stopped) break
        await onPrompt(p, events, handled)
      }
      await sleep(pollMs)
    }
  })()
  return {
    ready,
    finished,
    stop: async () => {
      stopped = true
      await finished.catch(() => {})
    },
  }
}
