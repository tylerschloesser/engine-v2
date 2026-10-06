// `--apply`: round state -> device-checks.md (M39e). Pure text in, text out; idempotent because the
// Run on line it writes is regenerated from the round and carries the round's tag.
import { describeEnv } from './env.mjs'
import { parseChecks } from './parse.mjs'
import { servingFor } from './serving.mjs'

const SHORT = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP', 'not run: no device': 'NOT RUN' }
const one = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
const SIGN_OFF = /; \*\*sign-off:\*\*[^[]*/

/** @returns {{ text: string, changes: string[] }} */
export function applyRound(checksText, state, { round, overrides }) {
  const { items } = parseChecks(checksText)
  const lines = checksText.split('\n')
  const changes = []
  const tag = `[round ${round}]`
  const walked = items.filter((i) => !i.android && state.items.has(i.id))
  const bySection = new Map()
  // A round run on an Android phone (M39j) is evidence about Android: the ids are the iPhone's rows, and the
  // `-android` rows are never ticked (Q5), so such a round writes its Run on lines and ticks nothing.
  const onAndroid = describeEnv(state.env)?.device === 'Android'
  for (const it of walked) {
    if (!state.items.get(it.id).result) continue
    if (!bySection.has(it.section)) bySection.set(it.section, [])
    bySection.get(it.section).push(it)
    const r = state.items.get(it.id).result
    const l = it.line - 1
    if (onAndroid) continue
    if (r === 'pass' && !it.ticked) {
      lines[l] = lines[l].replace('- [ ]', '- [x]')
      changes.push(`tick ${it.id}`)
    } else if (r === 'fail' && it.ticked) {
      lines[l] = lines[l].replace(/- \[[xX]\]/, '- [ ]')
      changes.push(`UNTICK ${it.id}: round ${round} recorded fail on an item that was ticked`)
    }
  }
  // Run on lines, bottom section first so inserted lines never shift one still to do.
  const heads = lines.map((l, i) => [l, i]).filter(([l]) => /^## M\d+[a-z]?: /.test(l))
  for (let h = heads.length - 1; h >= 0; h--) {
    const [head, start] = heads[h]
    const section = /^## (M\d+[a-z]?):/.exec(head)[1]
    const rows = bySection.get(section)
    if (!rows) continue
    const end = h + 1 < heads.length ? heads[h + 1][1] : lines.length
    const runOns = []
    for (let i = start; i < end; i++) if (lines[i].startsWith('**Run on:**')) runOns.push(i)
    const hasAndroid = items.some((i) => i.section === section && i.android)
    const devices = new Set()
    for (const it of rows) {
      const d = state.device
      const dev = servingFor(it, overrides).device
      if (dev === 'mac') {
        // Typed in the Mac UI wins; else what the Mac's own browsers said (an auto round): `Mac (Safari 26.0,
        // adapter apple/metal-3; Firefox 143.0, no WebGPU)`.
        const seen = [...(state.macEnvs?.values() ?? [])].map(describeEnv).filter(Boolean)
        const text = seen
          .map((e) =>
            [e.browser, e.adapter ? `adapter ${e.adapter}` : 'no WebGPU']
              .filter(Boolean)
              .join(', '),
          )
          .join('; ')
        devices.add(d.mac ? `Mac ${d.mac}` : text ? `Mac (${seen[0].os}; ${text})` : 'Mac')
      } else {
        // Typed in the Mac UI wins; else what the phone's own `env` says (an auto round, M39f).
        const e = describeEnv(state.env)
        const own = [d.phone, d.ios && `iOS ${d.ios}`].filter(Boolean).join(' ')
        const seen = e ? [e.device, e.os, e.browser].filter(Boolean).join(', ') : ''
        const gpu = e
          ? [e.adapter && `adapter ${e.adapter}`, e.cores !== null && `${e.cores} cores`]
          : []
        devices.add(
          (own || seen
            ? [own || seen, ...(own ? [e?.browser] : []), ...gpu].filter(Boolean).join(', ')
            : '') || 'iPhone (model not recorded)',
        )
      }
    }
    const date = rows
      .map((it) => state.items.get(it.id).at ?? '')
      .sort()
      .at(-1)
      .slice(0, 10)
    const results = rows.map((it) => {
      const s = state.items.get(it.id)
      const extra = [one(s.notes), s.numbers && `numbers: ${one(s.numbers)}`]
        .filter(Boolean)
        .join('; ')
      return `${it.id} ${SHORT[s.result]}${extra ? ` (${extra})` : ''}`
    })
    if (hasAndroid && !onAndroid) results.push('Android: not run: no device')
    const build = (old) =>
      `**Run on:** ${[...devices].join(' + ')}, ${date}; **result:** ${results.join('; ')}${old?.match(SIGN_OFF)?.[0] ?? ''} ${tag}`
    const mine = runOns.find((i) => lines[i].includes(tag))
    const placeholder = runOns.find(
      (i) => /<[^>]+>/.test(lines[i]) && !lines[i].includes('[round '),
    )
    if (mine !== undefined) {
      const next = build(lines[mine])
      if (next !== lines[mine]) {
        lines[mine] = next
        changes.push(`update Run on of ${section}`)
      }
    } else if (placeholder !== undefined) {
      lines[placeholder] = build(lines[placeholder])
      changes.push(`write Run on of ${section}`)
    } else if (runOns.length) {
      lines.splice(runOns.at(-1) + 1, 0, build(null))
      changes.push(`add a Run on line to ${section} (earlier lines kept)`)
    }
  }
  return { text: lines.join('\n'), changes }
}

/** A small line diff for `--dry-run`: changed or inserted lines with their numbers. */
export function lineDiff(before, after) {
  const a = before.split('\n')
  const b = after.split('\n')
  const out = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
    } else if (i + 1 < a.length && a[i + 1] === b[j] && b[j + 1] === a[i + 2]) {
      out.push(`-${i + 1}: ${a[i]}`)
      i++
    } else if (b.length > a.length && a[i] === b[j + 1]) {
      out.push(`+${j + 1}: ${b[j]}`)
      j++
    } else {
      out.push(`-${i + 1}: ${a[i]}`, `+${j + 1}: ${b[j]}`)
      i++
      j++
    }
  }
  return out.join('\n')
}
