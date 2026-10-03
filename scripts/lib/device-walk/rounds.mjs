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

/**
 * Replay events over the walked `items`. Returns
 * `{ only, device, cursor, items: Map<id, { result, notes, numbers, device, history }> }`.
 */
export function replay(events, items) {
  const ids = new Set(items.map((i) => i.id))
  const state = {
    only: null,
    device: { phone: '', ios: '', mac: '' },
    cursor: null,
    items: new Map(),
  }
  for (const it of items)
    state.items.set(it.id, { result: null, notes: '', numbers: '', at: null, history: [] })
  for (const e of events) {
    if (e.type === 'start') state.only = e.only ?? null
    else if (e.type === 'device')
      state.device = { ...state.device, ...pick(e, ['phone', 'ios', 'mac']) }
    else if (e.type === 'cursor' && ids.has(e.id)) state.cursor = e.id
    else if ((e.type === 'result' || e.type === 'redo') && ids.has(e.id)) {
      const s = state.items.get(e.id)
      if (e.type === 'result') {
        // Re-saving the same result (editing notes) updates that row; a different result adds one.
        const row = { t: e.t, result: e.result, notes: e.notes ?? '', numbers: e.numbers ?? '' }
        const last = s.history.at(-1)
        if (last && !last.redo && last.result === e.result) s.history[s.history.length - 1] = row
        else s.history.push(row)
        Object.assign(s, {
          result: e.result,
          notes: e.notes ?? '',
          numbers: e.numbers ?? '',
          at: e.t,
        })
      } else {
        s.history.push({ t: e.t, result: null, redo: true })
        Object.assign(s, { result: null, notes: '', numbers: '', at: null })
      }
    }
  }
  return state
}

function pick(o, keys) {
  return Object.fromEntries(keys.filter((k) => typeof o[k] === 'string').map((k) => [k, o[k]]))
}

/** First item without a result, else the first item. */
export function firstOpen(items, state) {
  return items.find((i) => !state.items.get(i.id).result)?.id ?? items[0]?.id ?? null
}
