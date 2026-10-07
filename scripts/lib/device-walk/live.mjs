// What an orchestrating session (or `--wait`) needs to know about a running auto round without asking the
// phone: the live facts of the `device:walk --auto` process (`state.json` beside the round's series, written
// by the process, untracked) joined with the round log (committed) into one `state` word. M39f step 13,
// docs/plan/39f-device-auto-runner.md "Tracker integration".
//
//   starting           the servers and the phone API are coming up (no join URL yet)
//   waiting-for-phone  the round is up and the phone has not started it, or has not been heard from for
//                      `staleMs` while nothing is waiting on the person
//   running            the phone is walking a check
//   waiting-for-human  a prompt is open on the phone (an act, a judge sheet, "Redo this check")
//   paused             the person pressed Pause on the bar and nothing has happened since (advisory: the
//                      walk does not stop; see Deviations of delegation 5)
//   done               every walked check has a result (read from the log: it needs no live process)
//   done-pending-judge a driven round (M39w) walked every check and the rest are judge sheets its driver deferred:
//                      the process has ended on purpose and releases the phone; `--judge` closes them (from the log)
//   stalled            the process is gone (killed, crashed, timed out) and the round is not done
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { CHECKS, walkable } from './checks.mjs'

export const STALE_MS = 90_000

/** A tool's live record, or null when there is none (never started, or unreadable). */
export function readLive(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Atomic writes of the live record: a reader never sees half a file. */
export function createLive({ path, round, pid = process.pid, clock = Date.now }) {
  let rec = { round, pid, startedAt: clock(), updatedAt: clock(), phase: 'starting', joinUrl: null }
  const flush = () => {
    rec.updatedAt = clock()
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`)
    renameSync(tmp, path)
  }
  flush()
  return {
    set(patch) {
      rec = { ...rec, ...patch }
      flush()
    },
    get: () => ({ ...rec }),
  }
}

/** Is `pid` a live process (signal 0 asks without sending)? */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** Events that show the phone (or Mac tab) moved on: a prompt is answered or stale after any of these. */
const PROGRESS = new Set(['series', 'attempt', 'result', 'answer', 'redo', 'reading', 'walk'])

/**
 * The open prompts of an auto round, from the log: a `prompt` that nothing after it has answered. A judge
 * sheet is open while its attempt is `judge`; an act sheet (`kind: act`) while it is the newest word from
 * the phone about that check; an interrupted attempt waits for "Redo this check".
 * @returns {{ id: string, n: number, kind: string, text: string }[]}
 */
export function openPrompts(events, ids) {
  const out = []
  const want = new Set(ids)
  for (const id of want) {
    let last = null
    let attempt = null
    for (const e of events) {
      if (e.id !== id) continue
      if (e.type === 'result') {
        last = null
        attempt = null
      }
      if (e.type === 'attempt') {
        if (e.status === undefined) attempt = { n: e.n, status: 'open' }
        else if (attempt && attempt.n === e.n) {
          if (e.status === 'interrupted')
            attempt = { n: e.n, status: 'interrupted', reason: e.reason }
          else if (e.status === 'done')
            attempt = { n: e.n, status: e.outcome === 'judge' ? 'judge' : 'done' }
        }
      } else if (e.type === 'answer' && attempt?.n === e.n) attempt = { n: e.n, status: 'answered' }
      else if (e.type === 'redo' && attempt?.status === 'interrupted')
        attempt = { n: attempt.n, status: 'redone' }
      if (e.type === 'prompt') last = e
      else if (PROGRESS.has(e.type)) last = null
    }
    if (!attempt) continue
    if (attempt.status === 'judge') {
      const p = [...events]
        .reverse()
        .find((e) => e.type === 'prompt' && e.id === id && e.kind === 'judge')
      out.push({ id, n: attempt.n, kind: 'judge', text: p?.text ?? 'a judge sheet is open' })
    } else if (attempt.status === 'interrupted' && attempt.reason !== 'reload')
      out.push({
        id,
        n: attempt.n,
        kind: 'redo',
        text: 'the check was interrupted: "Redo this check"',
      })
    else if (attempt.status === 'open' && last?.kind === 'act')
      out.push({ id, n: attempt.n, kind: 'act', text: last.text })
  }
  return out
}

/** Is the newest attempt of `id` a judge sheet the driver deferred (a `defer` for it after its `judge` outcome)? */
function parkedJudge(events, id) {
  let n = 0
  let judge = false
  let deferred = false
  for (const e of events) {
    if (e.id !== id) continue
    if (e.type === 'result') n = 0
    else if (e.type === 'attempt' && e.status === undefined && e.n >= n) {
      n = e.n
      judge = false
      deferred = false
    } else if (e.type === 'attempt' && e.n === n && e.status === 'done')
      judge = e.outcome === 'judge'
    else if (e.type === 'defer' && e.n === n && judge) deferred = true
    else if ((e.type === 'answer' || e.type === 'redo') && e.n === n) deferred = false
  }
  return judge && deferred
}

/**
 * The state word of an auto round.
 * @param {{ events: object[], ids: string[], live: object|null, now?: number, alive?: boolean|((pid: number) => boolean),
 *   staleMs?: number }} o `ids`: the walked checks (a round is done when each has a result).
 */
export function roundState({
  events,
  ids,
  live,
  now = Date.now(),
  alive = pidAlive,
  staleMs = STALE_MS,
}) {
  const result = new Set(events.filter((e) => e.type === 'result').map((e) => e.id))
  const left = ids.filter((id) => walkable(id) && !result.has(id))
  const prompts = openPrompts(events, left)
  // The client the round is waiting on: the Mac's own browser for a row that is the Mac's, else the phone.
  const cursorId =
    [...events].reverse().find((e) => e.type === 'cursor' && left.includes(e.id))?.id ??
    left[0] ??
    null
  const onMac = !!cursorId && (CHECKS[cursorId]?.plan.device ?? 'phone') === 'mac'
  const lastSeen = (onMac ? live?.mac?.lastSeen : live?.phone?.lastSeen) ?? null
  const phone = {
    connected: lastSeen !== null && now - lastSeen <= staleMs,
    lastSeen: lastSeen === null ? null : new Date(lastSeen).toISOString(),
    secondsSince: lastSeen === null ? null : Math.round((now - lastSeen) / 1000),
  }
  const first = prompts[0]
  const cursor =
    [...events].reverse().find((e) => e.type === 'cursor' && left.includes(e.id))?.id ??
    left[0] ??
    null
  const current = cursor
    ? {
        id: cursor,
        n:
          [...events]
            .reverse()
            .find((e) => e.type === 'attempt' && e.id === cursor && e.status === undefined)?.n ??
          null,
        prompt: prompts.find((p) => p.id === cursor) ?? first ?? null,
      }
    : null
  const base = {
    phone,
    client: onMac ? 'mac' : 'phone',
    current,
    humanPending: prompts.map((p) => p.id),
    prompts,
  }
  if (left.length === 0 && ids.some((id) => walkable(id)))
    return { state: 'done', reason: null, ...base }
  // M39w: nothing is left but judge sheets the driver parked for `--judge`: the walk is over whether or not the
  // process is still shutting down (a QR round never has a deferred sheet).
  if (left.length > 0 && left.every((id) => parkedJudge(events, id)))
    return {
      state: 'done-pending-judge',
      reason: `walk over; ${left.length} judge sheet(s) wait for --judge: ${left.join(', ')}`,
      ...base,
    }
  const up = live && (typeof alive === 'function' ? alive(live.pid) : alive)
  if (!up)
    return {
      state: 'stalled',
      reason: live
        ? `the device:walk process (pid ${live.pid}) is gone`
        : 'no running device:walk --auto for this round',
      ...base,
    }
  if (!live.joinUrl) return { state: 'starting', reason: null, ...base }
  const started = events.some((e) => e.type === 'walk' && e.phase === 'start')
  if (!started)
    return {
      state: 'waiting-for-phone',
      reason: onMac ? 'the Mac browser tab has not opened' : 'the phone has not tapped Start',
      ...base,
    }
  if (first) return { state: 'waiting-for-human', reason: `${first.id}: ${first.text}`, ...base }
  const lastPause = events.findLastIndex((e) => e.type === 'pause')
  if (lastPause >= 0 && !events.slice(lastPause + 1).some((e) => PROGRESS.has(e.type) && e.id))
    return { state: 'paused', reason: 'Pause was pressed on the phone', ...base }
  if (!phone.connected)
    return {
      state: 'waiting-for-phone',
      reason: `the ${onMac ? 'Mac browser tab' : 'phone'} was last heard from ${phone.secondsSince ?? '?'} s ago`,
      ...base,
    }
  return { state: 'running', reason: null, ...base }
}

/**
 * `--wait`: poll `read()` (a `roundState` result plus anything else) until `done`, or `stalled` once it has
 * lasted `stalledGraceMs` (a restart in between is not a stall), or `timeoutMs`. Returns `{ code, final,
 * timedOut }`: code 0 for done, 2 for stalled or a timeout. `onChange(state)` sees each new state word.
 */
export async function waitRound({
  read,
  timeoutMs = 600_000,
  pollMs = 1000,
  stalledGraceMs = 5000,
  onChange = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  clock = Date.now,
}) {
  const t0 = clock()
  let seen = ''
  let stalledSince = null
  for (;;) {
    const s = read()
    const key = `${s.state}|${s.current?.id ?? ''}|${(s.humanPending ?? []).join()}`
    if (key !== seen) {
      seen = key
      onChange(s)
    }
    if (s.state === 'done' || s.state === 'done-pending-judge')
      return { code: 0, final: s, timedOut: false }
    if (s.state === 'stalled') {
      stalledSince ??= clock()
      if (clock() - stalledSince >= stalledGraceMs) return { code: 2, final: s, timedOut: false }
    } else stalledSince = null
    if (clock() - t0 >= timeoutMs) return { code: 2, final: s, timedOut: true }
    await sleep(Math.max(1, Math.min(pollMs, timeoutMs - (clock() - t0))))
  }
}
