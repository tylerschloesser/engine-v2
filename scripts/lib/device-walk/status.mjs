// `--status`: a round's state for humans and for the orchestrating session (`--json`). M39e.
import { roundState } from './live.mjs'
import { firstOpen, replay } from './rounds.mjs'
import { servingFor } from './serving.mjs'

const attemptRow = (a) => ({
  n: a.n,
  status: a.status,
  ...(a.rung ? { rung: a.rung } : {}),
  ...(a.reason ? { reason: a.reason } : {}),
  ...(a.outcome ? { outcome: a.outcome } : {}),
  ...(a.criteria ? { criteria: a.criteria } : {}),
  ...(a.metrics ? { metrics: a.metrics } : {}),
  ...(a.evidence ? { evidence: a.evidence } : {}),
})

export function summarize({ round, file, items, state, overrides }) {
  const walked = items.filter((i) => !i.android)
  const rows = walked.map((i) => {
    const s = state.items.get(i.id)
    return {
      id: i.id,
      section: i.section,
      device: servingFor(i, overrides).device,
      result: s.result,
      notes: s.notes,
      numbers: s.numbers,
      history: s.history,
      // M39f: what an auto round recorded (absent from a manual round's rows).
      ...(s.by ? { by: s.by } : {}),
      ...(s.criteria ? { criteria: s.criteria } : {}),
      ...(s.metrics ? { metrics: s.metrics } : {}),
      ...(s.evidence ? { evidence: s.evidence } : {}),
      ...(s.attempts.length ? { attempts: s.attempts.map(attemptRow) } : {}),
      ...(s.shots?.length ? { shots: s.shots } : {}),
    }
  })
  const counts = { pass: 0, fail: 0, skip: 0, 'not run: no device': 0, open: 0 }
  for (const r of rows) counts[r.result ?? 'open']++
  return {
    round,
    file,
    only: state.only,
    device: state.device,
    total: rows.length,
    recorded: rows.length - counts.open,
    counts,
    env: state.env,
    cursor: state.cursor ?? firstOpen(walked, state),
    remaining: rows.filter((r) => !r.result).map((r) => r.id),
    items: rows,
  }
}

export function formatStatus(sum) {
  const lines = [
    `round ${sum.round}: ${sum.recorded}/${sum.total} recorded (pass ${sum.counts.pass}, fail ${sum.counts.fail}, skip ${sum.counts.skip}, not run ${sum.counts['not run: no device']}, open ${sum.counts.open})`,
    `devices: phone ${sum.device.phone || '-'} · iOS ${sum.device.ios || '-'} · mac ${sum.device.mac || '-'}`,
  ]
  for (const r of sum.items) {
    const hist = r.history.filter((h) => !h.redo).length
    const by = r.by ? `[${r.by}] ` : ''
    lines.push(
      `  ${(r.result ?? 'open').padEnd(18)} ${by}${r.id}${r.notes ? `  ${r.notes.replace(/\s+/g, ' ')}` : ''}${hist > 1 ? `  (${hist} runs)` : ''}`,
    )
  }
  if (sum.remaining.length) lines.push(`next open: ${sum.remaining[0]}`)
  return lines.join('\n')
}

/**
 * `--status --json` and `--wait`: the summary of the round log plus the live word (`roundState`) and the facts
 * of the running tool (`live`: join URL, monitor URL, pid), for the orchestrating session. A manual round
 * (M39e) has `mode: 'manual'` and the state `manual` until every item has a result, then `done`.
 */
export function fullStatus({ round, file, items, events, overrides, live, now, alive }) {
  const walked = items.filter((i) => !i.android)
  const start = events.findLast((e) => e.type === 'start')
  const mode = start?.mode === 'auto' ? 'auto' : 'manual'
  const sum = summarize({ round, file, items, state: replay(events, walked), overrides })
  if (mode === 'manual')
    return { ...sum, mode, state: sum.remaining.length ? 'manual' : 'done', reason: null }
  const rs = roundState({ events, ids: walked.map((i) => i.id), live, now, alive })
  return {
    ...sum,
    mode,
    state: rs.state,
    reason: rs.reason,
    joinUrl: live?.joinUrl ?? null,
    monitorUrl: live?.monitorUrl ?? null,
    pid: live?.pid ?? null,
    phone: rs.phone,
    current: rs.current,
    humanPending: rs.humanPending,
    prompts: rs.prompts,
  }
}

/** The one-line form of `state` for terminals. */
export function formatState(st) {
  const cur = st.current?.id ? ` at ${st.current.id}` : ''
  const why = st.reason ? ` (${st.reason})` : ''
  return `state: ${st.state}${st.state === 'done' ? '' : cur}${why}`
}
