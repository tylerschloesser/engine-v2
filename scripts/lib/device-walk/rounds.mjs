// Round log (M39e): an append-only JSONL file per round; state is replayed from it, so killing the
// tool at any point loses nothing and a changed result keeps the earlier one in its history.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const RESULTS = ['pass', 'fail', 'skip', 'not run: no device']

export function readEvents(file) {
  if (!existsSync(file)) return []
  const events = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e && typeof e === 'object' && typeof e.type === 'string') events.push(e)
    } catch {
      // a truncated last line (the tool was killed mid-write) is skipped
    }
  }
  return events
}

export function appendEvent(file, event, now = () => new Date().toISOString()) {
  mkdirSync(dirname(file), { recursive: true })
  const prefix =
    existsSync(file) &&
    !readFileSync(file, 'utf8').endsWith('\n') &&
    readFileSync(file, 'utf8') !== ''
      ? '\n'
      : ''
  const e = { t: now(), ...event }
  appendFileSync(file, `${prefix}${JSON.stringify(e)}\n`)
  return e
}

/** `key=value, ...` text for a `result`'s `metrics` (what `--apply` writes as the **Run on** numbers). */
export function formatMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return ''
  return Object.entries(metrics)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? +v.toFixed(3) : v}`)
    .join(', ')
}

const RESULT_EXTRAS = ['by', 'attempt', 'criteria', 'metrics', 'evidence']

/**
 * Replay events over the walked `items`. Returns
 * `{ only, device, cursor, env, others, items: Map<id, { result, notes, numbers, device, history,
 * attempts, prompts, by, criteria, metrics, evidence }> }`. Events from the phone API (M39f: `env`,
 * `attempt`, `prompt`, `result` with `by`/`criteria`/`metrics`/`evidence`) are replayed here; readers
 * from before M39f ignore the extra types and fields. A `result` for an id that is not walked (the
 * built-in `M39f-selftest`) lands in `others`.
 */
export function replay(events, items) {
  const ids = new Set(items.map((i) => i.id))
  const state = {
    only: null,
    device: { phone: '', ios: '', mac: '' },
    cursor: null,
    env: null,
    others: new Map(),
    items: new Map(),
  }
  for (const it of items)
    state.items.set(it.id, {
      result: null,
      notes: '',
      numbers: '',
      at: null,
      history: [],
      attempts: [],
      prompts: [],
    })
  for (const e of events) {
    if (e.type === 'start') state.only = e.only ?? null
    else if (e.type === 'device')
      state.device = { ...state.device, ...pick(e, ['phone', 'ios', 'mac']) }
    else if (e.type === 'cursor' && ids.has(e.id)) state.cursor = e.id
    else if (e.type === 'env') state.env = withoutMeta(e)
    else if (e.type === 'result' && !ids.has(e.id) && typeof e.id === 'string')
      state.others.set(e.id, {
        t: e.t,
        result: e.result,
        ...pickDefined(e, RESULT_EXTRAS),
        numbers: e.numbers ?? formatMetrics(e.metrics),
      })
    else if (e.type === 'attempt' && ids.has(e.id)) {
      const list = state.items.get(e.id).attempts
      const at = list.find((a) => a.n === e.n)
      if (at) Object.assign(at, pickDefined(e, ['status', 'variant', 'page']))
      else
        list.push({ t: e.t, n: e.n, variant: e.variant, page: e.page, status: e.status ?? 'open' })
    } else if (e.type === 'prompt' && ids.has(e.id))
      state.items.get(e.id).prompts.push({ t: e.t, n: e.n, kind: e.kind, text: e.text })
    else if ((e.type === 'result' || e.type === 'redo') && ids.has(e.id)) {
      const s = state.items.get(e.id)
      if (e.type === 'result') {
        // Re-saving the same result (editing notes) updates that row; a different result adds one.
        const numbers = e.numbers ?? formatMetrics(e.metrics)
        const extras = pickDefined(e, RESULT_EXTRAS)
        const row = { t: e.t, result: e.result, notes: e.notes ?? '', numbers, ...extras }
        const last = s.history.at(-1)
        if (last && !last.redo && last.result === e.result) s.history[s.history.length - 1] = row
        else s.history.push(row)
        for (const k of RESULT_EXTRAS) delete s[k]
        Object.assign(s, { result: e.result, notes: e.notes ?? '', numbers, at: e.t, ...extras })
      } else {
        s.history.push({ t: e.t, result: null, redo: true })
        for (const k of RESULT_EXTRAS) delete s[k]
        Object.assign(s, { result: null, notes: '', numbers: '', at: null })
      }
    }
  }
  return state
}

function withoutMeta(e) {
  const { type: _type, t: _t, src: _src, ...rest } = e
  return rest
}

function pickDefined(o, keys) {
  return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]))
}

function pick(o, keys) {
  return Object.fromEntries(keys.filter((k) => typeof o[k] === 'string').map((k) => [k, o[k]]))
}

/** First item without a result, else the first item. */
export function firstOpen(items, state) {
  return items.find((i) => !state.items.get(i.id).result)?.id ?? items[0]?.id ?? null
}
