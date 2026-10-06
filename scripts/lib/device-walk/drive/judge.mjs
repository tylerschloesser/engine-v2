// `pnpm device:walk --judge <round> <id> pass|fail|skip [--note ...]` (M39j step 3): the orchestrator's verdict
// on a judge sheet the device person left pending (a screenshot is in the item's evidence). It is a `result`
// row with `by: 'orchestrator'`, carrying the criteria, metrics and evidence of the attempt that asked, the
// way the phone's own answer does (`auto-round.mjs` `onAnswer`), so `--status` and `--apply` read it as any other.
import { foldItem, rel } from '../auto-round.mjs'

const VALUES = ['pass', 'fail', 'skip']

/**
 * The `result` event for a judge verdict. Throws with a reason when there is nothing to judge.
 * @param {{ events: object[], ids: string[], id: string, value: string, note?: string, base?: string }} o `base`: what an absolute evidence path is made relative to (the repo)
 */
export function judgeEvent({ events, ids, id, value, note, base }) {
  if (!VALUES.includes(value)) throw new Error(`--judge takes pass, fail or skip, not "${value}"`)
  if (!ids.includes(id)) throw new Error(`"${id}" is not an item of this round`)
  const st = foldItem(events, id)
  if (st.result) throw new Error(`${id} already has a result (${st.result.result}); redo it first`)
  const a = st.last
  if (!a || a.status !== 'judge')
    throw new Error(
      `${id} has no judge sheet open (${a ? `attempt ${a.n} is ${a.status}` : 'no attempt yet'})`,
    )
  return {
    type: 'result',
    id,
    result: value,
    by: 'orchestrator',
    attempt: a.n,
    criteria: (a.criteria ?? []).map((c) =>
      c.ok === null ? { ...c, ok: value === 'pass', by: 'orchestrator' } : c,
    ),
    metrics: a.metrics,
    ...(a.evidence ? { evidence: rel(a.evidence, base) } : {}),
    ...(note ? { notes: note } : {}),
  }
}
