// `pnpm device:walk` (docs/plan/39e-device-walkthrough-tool.md): walk through a round of the manual
// device checks one item at a time, serve each item's page and show it as a QR code, and record every
// result in an append-only log (docs/plan/device-rounds/<round>.jsonl).
//
//   pnpm device:walk [--round <name>] [--only <id-prefix,...>] [--no-open] [--no-tunnel] [--port <n>]
//   pnpm device:walk --status <round> [--json]
//   pnpm device:walk --apply <round> [--dry-run]
//   pnpm device:walk --auto [--round <name>] [--only <id-prefix,...>] [--no-open] [--no-tunnel]
//     (M39f: one QR, the phone and the Mac's own browsers walk the round; the Mac page is a live monitor)
//   pnpm device:walk --wait <round> [--timeout <s>] [--json]       (exit 0 done, 2 stalled or timed out)
//   pnpm device:walk --manual ...                                  (the M39e flow; the default without --auto)
//   pnpm device:walk --selftest [--round <name>] [--no-tunnel] [--hold <s> --drop-at <s> --drop <s> --probe <s>]
//     (M39f: the phone self-test: Auto-Lock Never idle probe, two origins, 6 min hold, a link cut; one QR scan, about 8 min)
// Test/scratch overrides: --checks <file>, --rounds-dir <dir>, --series-dir <dir>, --params <json> (round
// timings), --no-build (serve existing builds), --monitor-port <n>, --base-port <n>.

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './lib/device-walk/app.mjs'
import { applyRound, lineDiff } from './lib/device-walk/apply.mjs'
import { autoCli, readStatus, seriesDirFor, waitCli } from './lib/device-walk/auto-main.mjs'
import { judgeEvent } from './lib/device-walk/drive/judge.mjs'
import { parseChecks, selectItems } from './lib/device-walk/parse.mjs'
import { qrTerminal } from './lib/device-walk/qr.mjs'
import { appendEvent, checkRoundName, readEvents, replay } from './lib/device-walk/rounds.mjs'
import { DEFAULT_PARAMS, formatSelftest, SELFTEST_ID } from './lib/device-walk/selftest.mjs'
import { runSelftest } from './lib/device-walk/selftest-cli.mjs'
import { createServerControl } from './lib/device-walk/servers.mjs'
import { OVERRIDES } from './lib/device-walk/serving.mjs'
import { reapStale, spawnServe } from './lib/device-walk/spawn-serve.mjs'
import { formatState, formatStatus } from './lib/device-walk/status.mjs'

const REPO = fileURLToPath(new URL('..', import.meta.url))

export function parseArgs(argv) {
  const o = { flags: new Set(), values: {} }
  const withValue = new Set([
    '--round',
    '--only',
    '--status',
    '--apply',
    '--port',
    '--checks',
    '--rounds-dir',
    '--hold',
    '--drop-at',
    '--drop',
    '--probe',
    '--wait',
    '--timeout',
    '--params',
    '--series-dir',
    '--monitor-port',
    '--base-port',
    '--drive',
    '--judge',
    '--note',
  ])
  o.positional = []
  for (let i = 0; i < argv.length; i++) {
    if (withValue.has(argv[i])) o.values[argv[i].slice(2)] = argv[++i]
    else if (argv[i].startsWith('--')) o.flags.add(argv[i])
    else o.positional.push(argv[i])
  }
  return o
}

async function selftest({ values, roundFile }) {
  const round = values.round ?? `selftest-${new Date().toISOString().slice(0, 10)}`
  const badName = checkRoundName(round)
  if (badName) fail(badName)
  if (replay(readEvents(roundFile(round)), []).others.has(SELFTEST_ID))
    fail(`round "${round}" already has a self-test result; pick another --round`)
  const sec = (v, d) => (v === undefined ? d : Math.round(Number(v) * 1000))
  const params = {
    holdMs: sec(values.hold, DEFAULT_PARAMS.holdMs),
    dropAtMs: sec(values['drop-at'], DEFAULT_PARAMS.dropAtMs),
    dropMs: sec(values.drop, DEFAULT_PARAMS.dropMs),
    probeMs: sec(values.probe, DEFAULT_PARAMS.probeMs),
  }
  if (Object.values(params).some((n) => !Number.isFinite(n) || n <= 0))
    fail('bad --hold/--drop-at/--drop')
  const stale = reapStale()
  if (stale.length) console.log(`stopped ${stale.length} server(s) left by an earlier run`)
  const ac = new AbortController()
  let run = null
  const bye = (code) => {
    ac.abort()
    ;(run?.stop() ?? Promise.resolve()).finally(() => process.exit(code))
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => bye(130))
  console.log(`device:walk self-test, round "${round}" (hold ${params.holdMs / 1000} s)`)
  run = await runSelftest({
    round,
    file: roundFile(round),
    seriesDir: join(REPO, 'test-results/device-walk', round),
    spawnServe,
    tunnel: !process.argv.includes('--no-tunnel'),
    params,
    signal: ac.signal,
  })
  const pass = run.row?.result === 'pass'
  await run.stop()
  process.exit(pass ? 0 : 1)
}

const fail = (msg) => {
  console.error(`device:walk: ${msg}`)
  process.exit(1)
}

async function main() {
  const { flags, values, positional } = parseArgs(process.argv.slice(2))
  const checksPath = values.checks ?? join(REPO, 'docs/plan/device-checks.md')
  const roundsDir = values['rounds-dir'] ?? join(REPO, 'docs/plan/device-rounds')
  const checksText = readFileSync(checksPath, 'utf8')
  const { items } = parseChecks(checksText)
  const roundFile = (r) => join(roundsDir, `${r}.jsonl`)

  if (flags.has('--selftest')) return selftest({ flags, values, roundFile })

  if (values.judge !== undefined) {
    // M39j: a verdict on a judge sheet the device person left pending (its screenshot is in the round's evidence).
    const bad = checkRoundName(values.judge)
    if (bad) fail(`--judge takes an existing round: ${bad}`)
    const file = roundFile(values.judge)
    const events = readEvents(file)
    if (!events.length) fail(`no round "${values.judge}" (${file})`)
    const [id, value] = positional
    const start = events.findLast((e) => e.type === 'start')
    const sel = selectItems(items, start?.only ?? undefined)
    let ev
    try {
      ev = judgeEvent({
        events,
        ids: sel.filter((i) => !i.android).map((i) => i.id),
        id,
        value,
        note: values.note,
        base: REPO,
      })
    } catch (e) {
      fail(`${e.message}\nusage: --judge <round> <id> pass|fail|skip [--note <text>]`)
    }
    appendEvent(file, ev)
    console.log(`round ${values.judge}: ${id} ${value} (by orchestrator)`)
    return
  }

  if (values.wait !== undefined) {
    const bad = checkRoundName(values.wait)
    if (bad) fail(`--wait takes an existing round: ${bad}`)
    const file = roundFile(values.wait)
    if (!readEvents(file).length) fail(`no round "${values.wait}" (${file})`)
    const start = readEvents(file).findLast((e) => e.type === 'start')
    const sel = selectItems(items, start?.only ?? undefined)
    const seriesDir = seriesDirFor(REPO, values.wait, values['series-dir'])
    const code = await waitCli({
      round: values.wait,
      timeoutS: values.timeout,
      json: flags.has('--json'),
      read: () => readStatus({ round: values.wait, file, items: sel, seriesDir }),
    })
    process.exit(code)
  }

  if (flags.has('--auto') && flags.has('--manual')) fail('--auto and --manual are different flows')
  if (flags.has('--auto')) {
    const round = values.round ?? `round-${new Date().toISOString().slice(0, 10)}`
    const badName = checkRoundName(round)
    if (badName) fail(badName)
    const only = values.only
      ? values.only.split(',').filter(Boolean)
      : (readEvents(roundFile(round)).find((e) => e.type === 'start')?.only ?? undefined)
    const sel = selectItems(items, only)
    if (!sel.some((i) => !i.android)) fail(`no items match --only ${values.only}`)
    let params
    try {
      params = values.params ? JSON.parse(values.params) : undefined
    } catch {
      fail('--params is a JSON object')
    }
    const drive = values.drive
    if (drive !== undefined && !['android', 'ios'].includes(drive))
      fail('--drive takes android or ios')
    const code = await autoCli({
      repo: REPO,
      round,
      items: sel,
      only,
      file: roundFile(round),
      seriesDir: seriesDirFor(REPO, round, values['series-dir']),
      // An Android phone is on USB: its origins are the loopback ones, reached through `adb reverse`.
      // The iPhone has no `adb reverse`, and a plain-http address is not a secure context: it needs the tunnel.
      tunnel: drive === 'android' ? flags.has('--tunnel') : !flags.has('--no-tunnel'),
      noOpen: flags.has('--no-open') || !!drive,
      noBuild: flags.has('--no-build'),
      // A driven full round runs for hours: `--timeout <seconds>` (default 90 min) bounds it.
      timeoutMs: values.timeout ? Math.round(Number(values.timeout) * 1000) : undefined,
      drive,
      params,
      monitorPort: values['monitor-port'],
      basePort: values['base-port'] ? Number(values['base-port']) : undefined,
      wsBasePort: values['base-port'] ? Number(values['base-port']) + 1 : undefined,
    })
    process.exit(code)
  }

  const reading = values.status ?? values.apply
  if (reading !== undefined) {
    const bad = checkRoundName(reading)
    if (bad) fail(`--status and --apply take an existing round: ${bad}`)
    const events = readEvents(roundFile(reading))
    if (!events.length) fail(`no round "${reading}" (${roundFile(reading)})`)
    const start = [...events].reverse().find((e) => e.type === 'start')
    if (start?.mode === 'selftest') {
      const row = replay(events, []).others.get(SELFTEST_ID)
      return console.log(
        flags.has('--json')
          ? JSON.stringify({ round: reading, selftest: row ?? null }, null, 2)
          : formatSelftest(row),
      )
    }
    const only = start?.only
    const sel = selectItems(items, only ?? undefined)
    const state = replay(
      events,
      sel.filter((i) => !i.android),
    )
    if (values.status !== undefined) {
      const full = readStatus({
        round: reading,
        file: roundFile(reading),
        items: sel,
        seriesDir: seriesDirFor(REPO, reading, values['series-dir']),
      })
      console.log(
        flags.has('--json')
          ? JSON.stringify(full, null, 2)
          : `${formatStatus(full)}${full.mode === 'auto' ? `\n${formatState(full)}` : ''}`,
      )
      return
    }
    const { text, changes } = applyRound(checksText, state, {
      round: reading,
      overrides: OVERRIDES,
    })
    if (!changes.length) return console.log(`round ${reading}: device-checks.md already up to date`)
    for (const c of changes) console.log(c)
    if (flags.has('--dry-run')) {
      console.log(`\n${lineDiff(checksText, text)}\n\n(dry run: nothing written)`)
      return
    }
    writeFileSync(checksPath, text)
    console.log(`wrote ${checksPath}`)
    return
  }

  // --- Walk mode --------------------------------------------------------------------------
  const round = values.round ?? `round-${new Date().toISOString().slice(0, 10)}`
  const badName = checkRoundName(round)
  if (badName) fail(badName)
  const events = readEvents(roundFile(round))
  const only = values.only
    ? values.only.split(',').filter(Boolean)
    : (events.find((e) => e.type === 'start')?.only ?? undefined)
  const sel = selectItems(items, only)
  if (!sel.some((i) => !i.android)) fail(`no items match --only ${values.only}`)

  const stale = reapStale()
  if (stale.length) console.log(`stopped ${stale.length} server(s) left by an earlier run`)

  let appRef
  const printed = new Set()
  const control = createServerControl({
    spawnServe,
    // No reachability probe: this Mac often cannot resolve a fresh trycloudflare name for a minute
    // while the phone can, so a probe only delayed `ready`. The UI says to reload if Safari can't find it.
    onChange: (st) => {
      if (!appRef || st.status !== 'ready') return
      const s = appRef.state()
      const it = s.items.find((i) => i.id === s.cursor)
      const url = it?.urls[0]
      if (url && it.serving.device === 'phone' && !printed.has(`${it.id} ${url}`)) {
        printed.add(`${it.id} ${url}`)
        console.log(`\n${it.id}\n${qrTerminal(url)}\n${url}\n`)
      }
    },
  })
  const app = createApp({
    round,
    items: sel,
    file: roundFile(round),
    control,
    tunnel: !flags.has('--no-tunnel'),
    overrides: OVERRIDES,
  })
  appRef = app
  app.begin(only)

  const stopAll = async () => {
    app.server.close()
    await control.stopAll()
  }
  let stopping = false
  const bye = (code) => {
    if (stopping) return
    stopping = true
    stopAll().finally(() => process.exit(code))
  }
  process.on('SIGINT', () => bye(0))
  process.on('SIGTERM', () => bye(0))
  process.on('SIGHUP', () => bye(0))
  process.on('uncaughtException', (e) => {
    console.error(e)
    bye(1)
  })
  process.on('unhandledRejection', (e) => {
    console.error(e)
    bye(1)
  })

  await new Promise((resolve) => app.server.listen(Number(values.port ?? 0), '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${app.server.address().port}/`
  console.log(`device:walk round "${round}": ${sel.filter((i) => !i.android).length} items`)
  console.log(`UI: ${url}   (Ctrl-C stops the tool and every server it started)`)
  console.log(`results: ${roundFile(round)}`)
  if (!flags.has('--no-open') && process.platform === 'darwin')
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
}

main().catch((e) => fail(e.stack ?? e))
