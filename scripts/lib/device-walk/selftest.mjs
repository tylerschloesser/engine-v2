// The built-in `M39f-selftest` step (docs/plan/39f-device-auto-runner.md "Risks", wake lock first): the
// service-held state machine and the judge. The phone walks it from the runner page; the step lives in
// the round log, so a reload resumes where the log says.
//
//   idle -> (Start tap) -> hop-b -> hop-a -> hold [-> drop] -> done
//
// hop-b/hop-a: navigate the tab to the other origin and back (a script-initiated top-level navigation,
// no gesture); each arrival is a `selftest hop-arrive` and re-requests the wake lock. hold: the tab
// stays in the foreground for `holdMs` from the second arrival, screen untouched. drop: `dropAtMs` into
// the hold the phone sends `drop-begin`, the service refuses its whole phone API for `dropMs` (the
// phone's "tunnel drop"; a real cloudflared kill would change the URL), the person taps a button on the
// page and every tap queues in the agent's outbox; on recovery the outbox must flush in order.
// `hidden_events_in_hold` is the Auto-Lock check: a round runs with Auto-Lock set to Never, not on the wake
// lock (iOS grants it only with user activation on the document, so every navigation loses it).
// The service decides pass or fail from the criteria below (a page hint is advisory).

export const SELFTEST_ID = 'M39f-selftest'
export const DEFAULT_PARAMS = {
  holdMs: 360_000,
  dropAtMs: 150_000,
  dropMs: 20_000,
  probeMs: 30_000,
}
export const LIMITS = { maxPingGapMs: 8_000, maxRafGapMs: 3_000, recoveryMs: 15_000 }

const phases = (events) => events.filter((e) => e.type === 'selftest')
const at = (e) => Date.parse(e.t)

/** The step as the phone sees it, from the log. */
export function stepFor(events, nowMs, { origins, params }) {
  const st = phases(events)
  const result = events.find((e) => e.type === 'result' && e.id === SELFTEST_ID)
  const base = { id: SELFTEST_ID, origins, params, now: nowMs }
  if (result) return { ...base, phase: 'done', result }
  if (!st.some((e) => e.phase === 'start')) return { ...base, phase: 'idle' }
  const arrivals = st.filter((e) => e.phase === 'hop-arrive')
  if (arrivals.length < 2)
    return {
      ...base,
      phase: arrivals.length === 0 ? 'hop-b' : 'hop-a',
      expectOrigin: origins[arrivals.length === 0 ? 1 : 0],
    }
  const holdStartedAt = at(arrivals[1])
  const drop = st.find((e) => e.phase === 'drop-begin')
  const reported = st.some((e) => e.phase === 'drop-report')
  return {
    ...base,
    phase: drop && !reported ? 'drop' : 'hold',
    holdStartedAt,
    dropBeginAt: drop ? at(drop) : null,
    dropReported: reported,
    taps: st.filter((e) => e.phase === 'tap').length,
  }
}

/** Criteria for a finished run. `mem` is what the service saw live: ping gaps and the recovery time. */
export function evaluate(events, params, mem = {}) {
  const st = phases(events)
  const arrivals = st.filter((e) => e.phase === 'hop-arrive')
  const startIdx = events.indexOf(arrivals[1])
  const endEv = st.find((e) => e.phase === 'hold-end')
  const endIdx = events.indexOf(endEv)
  const inHold = (e) => {
    const i = events.indexOf(e)
    return startIdx >= 0 && i > startIdx && i < endIdx
  }
  const hidden = events.filter(
    (e) => e.type === 'visibility' && e.state !== 'visible' && inHold(e),
  ).length
  const released = events.filter(
    (e) => e.type === 'wake' && e.event === 'released' && e.visible && inHold(e),
  ).length
  const taps = st.filter((e) => e.phase === 'tap')
  const report = st.find((e) => e.phase === 'drop-report')
  const sent = report?.tapsSent ?? 0
  const heldMs = endEv && arrivals[1] ? at(endEv) - at(arrivals[1]) : 0
  const origins = new Set(arrivals.map((e) => e.origin))
  const c = (name, value, limit, ok) => ({ name, value, limit, ok })
  const criteria = [
    c('origins_visited', origins.size, 2, origins.size >= 2),
    c('hold_ms', heldMs, params.holdMs, heldMs >= params.holdMs),
    c('hidden_events_in_hold', hidden, 0, hidden === 0),
    c(
      'max_ping_gap_ms',
      mem.maxPingGapMs ?? null,
      LIMITS.maxPingGapMs,
      (mem.maxPingGapMs ?? Infinity) <= LIMITS.maxPingGapMs,
    ),
    c(
      'max_raf_gap_ms',
      endEv?.rafMax ?? null,
      LIMITS.maxRafGapMs,
      (endEv?.rafMax ?? Infinity) <= LIMITS.maxRafGapMs,
    ),
    c('taps_received_of_sent', taps.length, sent, sent >= 1 && taps.length === sent),
    c(
      'taps_in_order',
      taps.map((e) => e.n).join(',') === taps.map((_, i) => i + 1).join(','),
      true,
      taps.length > 0 && taps.every((e, i) => e.n === i + 1),
    ),
    c(
      'recovery_ms',
      mem.recoveryMs ?? null,
      LIMITS.recoveryMs,
      (mem.recoveryMs ?? Infinity) <= LIMITS.recoveryMs,
    ),
  ]
  const metrics = {
    hold_ms: heldMs,
    taps: taps.length,
    origins: [...origins].join(' '),
    wake_after_hops: arrivals.map((e) => e.wake).join(' '),
    wake_releases_visible: released, // recorded, not judged: iOS drops the lock on navigation
    preflight: st
      .filter((e) => e.phase === 'preflight')
      .map((e) => (e.ok ? 'ok' : 'fail'))
      .join(' '),
    wake_granted: events.filter((e) => e.type === 'wake' && e.event === 'granted').length,
    wake_denied: events.filter((e) => e.type === 'wake' && e.event === 'denied').length,
    raf_frames: endEv?.rafFrames ?? null,
    reconnects: report?.reconnects ?? null,
  }
  return { criteria, metrics, ok: criteria.every((x) => x.ok) }
}

/** `{ stepFor, react, observe }` for `createPhoneApi`; `onPhase(event)` is told of each selftest event. */
export function createSelftest({
  origins,
  params = DEFAULT_PARAMS,
  onPhase = () => {},
  clock = Date.now,
}) {
  const mem = {
    maxPingGapMs: 0,
    lastPing: 0,
    holding: false,
    recoveryMs: null,
    waitingRecovery: false,
  }
  const cfg = { origins, params }
  return {
    mem,
    stepFor: (events, now) => stepFor(events, now, cfg),
    observe(msg, now, api) {
      const w = api.cutWindow()
      if (mem.waitingRecovery && now >= w.until) {
        mem.recoveryMs = now - w.until
        mem.waitingRecovery = false
      }
      if (msg.type !== 'ping' || !mem.holding) return
      if (mem.lastPing) {
        // The gap, less the time the service itself refused the phone.
        let gap = now - mem.lastPing
        const overlap = Math.min(now, w.until) - Math.max(mem.lastPing, w.from)
        if (overlap > 0) gap -= overlap
        mem.maxPingGapMs = Math.max(mem.maxPingGapMs, gap)
      }
      mem.lastPing = now
    },
    react(event, { api, events }) {
      if (event.type !== 'selftest') return []
      onPhase(event)
      if (
        event.phase === 'hop-arrive' &&
        events.filter((e) => e.phase === 'hop-arrive').length === 2
      ) {
        mem.holding = true
        mem.lastPing = clock()
      } else if (event.phase === 'drop-begin') {
        api.cut(params.dropMs)
        mem.waitingRecovery = true
        setTimeout(
          () => api.append({ type: 'selftest', phase: 'drop-end', by: 'service' }),
          params.dropMs,
        ).unref?.()
      } else if (event.phase === 'hold-end') {
        mem.holding = false
        const { criteria, metrics, ok } = evaluate(events, params, mem)
        return [
          {
            type: 'result',
            id: SELFTEST_ID,
            result: ok ? 'pass' : 'fail',
            by: 'auto',
            criteria,
            metrics,
          },
        ]
      }
      return []
    },
  }
}

/** A few lines for the terminal and `--status`. */
export function formatSelftest(row) {
  if (!row) return 'M39f-selftest: not finished'
  const lines = [`M39f-selftest: ${row.result.toUpperCase()}`]
  for (const c of row.criteria ?? [])
    lines.push(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.value} (limit ${c.limit})`)
  if (row.numbers) lines.push(`  ${row.numbers}`)
  return lines.join('\n')
}
