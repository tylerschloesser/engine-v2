// `pnpm device:walk` (docs/plan/39e-device-walkthrough-tool.md): walk through a round of the manual
// device checks one item at a time, serve each item's page and show it as a QR code, and record every
// result in an append-only log (docs/plan/device-rounds/<round>.jsonl).
//
//   pnpm device:walk [--round <name>] [--only <id-prefix,...>] [--no-open] [--no-tunnel] [--port <n>]
//   pnpm device:walk --status <round> [--json]
//   pnpm device:walk --apply <round> [--dry-run]
// Test/scratch overrides: --checks <file>, --rounds-dir <dir>.

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './lib/device-walk/app.mjs'
import { applyRound, lineDiff } from './lib/device-walk/apply.mjs'
import { parseChecks, selectItems } from './lib/device-walk/parse.mjs'
import { qrTerminal } from './lib/device-walk/qr.mjs'
import { readEvents, replay } from './lib/device-walk/rounds.mjs'
import { createServerControl } from './lib/device-walk/servers.mjs'
import { OVERRIDES } from './lib/device-walk/serving.mjs'
import { reapStale, spawnServe } from './lib/device-walk/spawn-serve.mjs'
import { formatStatus, summarize } from './lib/device-walk/status.mjs'

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
  ])
  for (let i = 0; i < argv.length; i++) {
    if (withValue.has(argv[i])) o.values[argv[i].slice(2)] = argv[++i]
    else o.flags.add(argv[i])
  }
  return o
}

const fail = (msg) => {
  console.error(`device:walk: ${msg}`)
  process.exit(1)
}

async function main() {
  const { flags, values } = parseArgs(process.argv.slice(2))
  const checksPath = values.checks ?? join(REPO, 'docs/plan/device-checks.md')
  const roundsDir = values['rounds-dir'] ?? join(REPO, 'docs/plan/device-rounds')
  const checksText = readFileSync(checksPath, 'utf8')
  const { items } = parseChecks(checksText)
  const roundFile = (r) => join(roundsDir, `${r}.jsonl`)

  const reading = values.status ?? values.apply
  if (reading !== undefined) {
    if (!reading || reading.startsWith('--')) fail('--status and --apply take a round name')
    const events = readEvents(roundFile(reading))
    if (!events.length) fail(`no round "${reading}" (${roundFile(reading)})`)
    const only = [...events].reverse().find((e) => e.type === 'start')?.only
    const sel = selectItems(items, only ?? undefined)
    const state = replay(
      events,
      sel.filter((i) => !i.android),
    )
    if (values.status !== undefined) {
      const sum = summarize({
        round: reading,
        file: roundFile(reading),
        items: sel,
        state,
        overrides: OVERRIDES,
      })
      console.log(flags.has('--json') ? JSON.stringify(sum, null, 2) : formatStatus(sum))
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
  if (!/^[\w.-]+$/.test(round)) fail('--round must be letters, digits, dot, dash, underscore')
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
    probe: async (url) => {
      const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) })
      return r.status < 500
    },
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
