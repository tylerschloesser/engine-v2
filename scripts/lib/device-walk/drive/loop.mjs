// The drive loop (M39j step 3): `--drive android|ios` on `device:walk --auto`. It opens the runner on the
// USB phone (no QR), passes the runner's pre-flight like Tyler does, then watches the round log for open
// prompts (`live.mjs` `openPrompts`: the same words the walk bar shows) and has the device person answer each
// act prompt once. Why the log and not the bar through page JS: the log is the service's own record of what is
// open (the bar is gone during a measuring window, a navigation empties it, a second tab has its own), costs
// the phone nothing, and a restart of this process resumes from it; the cost is that a button of the bar must
// still be found through page JS when a handler needs it (done by the handlers that tap one).
// Nothing here touches the phone inside a measuring window: a handler runs only for an open prompt, and no
// prompt is open while a window is.
import { join } from 'node:path'
import { openPrompts } from '../live.mjs'
import { readEvents } from '../rounds.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const RUNNER = `(() => {
  const el = (id) => document.getElementById(id)
  const on = (id) => { const e = el(id); return !!e && !e.hidden && !e.disabled && !e.closest('[hidden]') }
  return {
    runner: /runner\\.html$/.test(location.pathname),
    href: location.href.slice(0, 120),
    autolock: on('autolock'), probe: on('probe'), start: on('start'),
    walking: !!el('run') && !el('run').hidden,
  }
})()`
const CENTRE = (id) => `(() => {
  const e = document.getElementById(${JSON.stringify(id)})
  e.scrollIntoView({ block: 'center' })
  const r = e.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})()`

/**
 * The runner's pre-flight as Tyler does it: "Auto-Lock is Never" (the driver keeps the screen on), the idle
 * check (no touch for `probeMs`), Start. A page that is no longer the runner, or already walking, is done.
 */
export async function passRunner(
  backend,
  { timeoutMs = 180_000, log = () => {}, joinUrl = null, wait = sleep } = {},
) {
  const t0 = Date.now()
  let tapped = ''
  let reloads = 0
  while (Date.now() - t0 < timeoutMs) {
    let s
    try {
      s = await backend.readPage(RUNNER)
    } catch {
      await sleep(500) // the document is navigating
      continue
    }
    // A quick tunnel's name may not resolve yet when the phone first asks (Chrome and Safari then show their own
    // error page): ask again, about every 10 s, for up to 3 minutes.
    if (joinUrl && /^(chrome-error:|about:blank)/.test(s.href) && reloads < 18) {
      reloads++
      log(`runner: ${s.href}, opening it again (${reloads})`)
      await wait(10_000)
      await backend.open(joinUrl)
      continue
    }
    if (!s.runner || s.walking) {
      log(`runner: done (${s.walking ? 'walking' : 'not the runner page'}: ${s.href})`)
      return true
    }
    const next = s.autolock ? 'autolock' : s.probe ? 'probe' : s.start ? 'start' : ''
    if (next && next !== tapped) {
      const p = await backend.readPage(CENTRE(next))
      await backend.tap(p.x, p.y)
      log(`runner: tapped ${next}`)
      tapped = next
    }
    await sleep(next ? 400 : 1000)
  }
  throw new Error(`the runner page did not reach Start within ${timeoutMs / 1000} s`)
}

/**
 * Start driving. `o`: `{ backend, person, file, ids, joinUrl, seriesDir, append(event), settle(), isDone(),
 * log, pollMs }`. Returns `{ ready, stop() }`: `ready` resolves when the runner has been started, `stop()` ends
 * the loop (it does not clean the backend up: the caller does).
 */
export function startDrive(o) {
  const { backend, person, file, ids, joinUrl, seriesDir, append, settle, isDone } = o
  const log = o.log ?? (() => {})
  const pollMs = o.pollMs ?? 250
  let stopped = false
  const handled = new Set()
  person.ctx.joinUrl = joinUrl
  person.ctx.passRunner = () => passRunner(backend, { log, joinUrl })
  person.ctx.shotPath = (p) => join(seriesDir, `${p.id}-${p.n}-judge.png`)

  const note = (e) => append({ type: 'drive', ...e })

  async function onPrompt(p) {
    const key = `${p.id}:${p.n}:${p.kind}:${p.text}`
    if (handled.has(key)) return
    handled.add(key)
    const out = await person.answer(p)
    // DRIVE_SHOTS=<dir>: a screenshot after every answered act prompt (a debugging aid: a prompt is never open in a window).
    if (process.env.DRIVE_SHOTS && p.kind === 'act')
      await backend
        .screenshot(join(process.env.DRIVE_SHOTS, `${p.id}-${p.n}-${out.handler ?? 'x'}.png`))
        .catch(() => {})
    log(
      `drive ${p.id} #${p.n} [${p.kind}] ${p.text.slice(0, 70)} -> ${out.status}${out.reason ? `: ${out.reason}` : ''}${out.error ? `: ${out.error}` : ''}`,
    )
    note({
      id: p.id,
      n: p.n,
      kind: p.kind,
      text: p.text,
      action: out.status,
      handler: out.handler,
      ...(out.reason ? { reason: out.reason } : {}),
      ...(out.error ? { error: out.error } : {}),
    })
    if (out.status === 'pending') {
      if (out.shot) append({ type: 'shot', id: p.id, n: p.n, path: out.shot })
      // The row stays open for the orchestrator (`--judge`); the walk goes on to the next check.
      append({ type: 'defer', id: p.id, n: p.n })
      settle()
    }
    if (out.status === 'notDrivable') {
      // The row ends here: skipped, with the reason (never a pass). The phone moves on with the step.
      append({
        type: 'result',
        id: p.id,
        result: 'skip',
        by: 'device',
        notes: `NotDrivable: ${out.reason}`,
      })
      settle()
    }
  }

  const ready = (async () => {
    await backend.open(joinUrl)
    await passRunner(backend, { log, joinUrl })
  })()

  const finished = (async () => {
    await ready
    while (!stopped && !isDone()) {
      settle() // a `--judge` from another process is a row in the log: let the round move on
      const events = readEvents(file)
      for (const p of openPrompts(events, ids)) {
        if (stopped) break
        await onPrompt(p).catch((e) => log(`drive: ${e.stack ?? e}`))
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
