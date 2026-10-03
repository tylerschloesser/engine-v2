// Parser for docs/plan/device-checks.md: the tool's only source of checks (M39e). Nothing here
// copies a check; a new item in the file shows up in the next round with no tool change.

/**
 * @typedef {{ id: string, section: string, heading: string, line: number, ticked: boolean,
 *   android: boolean, raw: string, steps: string, pass: string, ifFails: string, open: string }} Item
 */

/** Split an item's bullet text into the three labelled parts (any may be empty). */
export function splitItem(raw) {
  const text = raw.replace(/^\*\*[^*]+\*\*\s*/, '')
  const steps = /\*Steps:\*/.exec(text)
  const pass = /\*Pass(?: \/ If it fails)?:\*/.exec(text)
  const fails = /\*If it fails:?\*,?/.exec(text)
  const cuts = [steps, pass, fails].filter(Boolean).sort((a, b) => a.index - b.index)
  const part = (m) => {
    if (!m) return ''
    const next = cuts.find((c) => c.index > m.index)
    return text.slice(m.index + m[0].length, next ? next.index : undefined).trim()
  }
  const ifFails = fails
    ? part(fails)
    : pass && /If it fails/.test(pass[0])
      ? 'As the Pass line of the item it points to.'
      : ''
  const lead = cuts.length ? text.slice(0, cuts[0].index).trim() : text.trim()
  return { lead, steps: part(steps), pass: part(pass), ifFails }
}

/** @returns {{ items: Item[], sections: Map<string, { heading: string, open: string, runOnLine: number }> }} */
export function parseChecks(text) {
  const lines = text.split('\n')
  const items = []
  const sections = new Map()
  let section = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const h = /^## (M\d+[a-z]?): (.*)$/.exec(line)
    if (h) {
      section = h[1]
      sections.set(section, { heading: h[2], open: '', runOnLine: -1 })
      continue
    }
    if (!section) continue
    const cur = sections.get(section)
    if (/^\*\*Open/.test(line)) {
      let open = line
      while (i + 1 < lines.length && lines[i + 1].trim() !== '') open += ` ${lines[++i].trim()}`
      cur.open = open
      continue
    }
    if (/^\*\*Run on:\*\*/.test(line)) {
      cur.runOnLine = i
      continue
    }
    const b = /^- \[([ xX])\] (\*\*([^*]+)\*\*.*)$/.exec(line)
    if (!b) continue
    let raw = b[2]
    while (i + 1 < lines.length && /^ {2,}\S/.test(lines[i + 1])) raw += ` ${lines[++i].trim()}`
    const id = b[3]
    items.push({
      id,
      section,
      heading: cur.heading,
      line: i + 1,
      ticked: b[1] !== ' ',
      android: /-android$/.test(id),
      raw,
      ...(({ lead, ...rest }) => ({ lead, ...rest }))(splitItem(raw)),
      open: cur.open,
    })
  }
  return { items, sections }
}

/** `--only M03,M11-boot`: prefix match on ids; empty/undefined keeps everything. */
export function selectItems(items, only) {
  if (!only || only.length === 0) return items
  return items.filter((it) => only.some((p) => it.id.startsWith(p)))
}
