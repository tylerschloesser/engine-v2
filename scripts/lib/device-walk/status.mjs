// `--status`: a round's state for humans and for the orchestrating session (`--json`). M39e.
import { firstOpen } from './rounds.mjs'
import { servingFor } from './serving.mjs'

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
    lines.push(
      `  ${(r.result ?? 'open').padEnd(18)} ${r.id}${r.notes ? `  ${r.notes.replace(/\s+/g, ' ')}` : ''}${hist > 1 ? `  (${hist} runs)` : ''}`,
    )
  }
  if (sum.remaining.length) lines.push(`next open: ${sum.remaining[0]}`)
  return lines.join('\n')
}
