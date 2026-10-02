// `node scripts/summarize.mjs <log.jsonl> [--from <epochMs>] [--to <epochMs>]`: what `measure.mjs`
// logged, as the numbers of docs/plan/38-hosting-checks.md Scope A step 2: tick interval p50/p99
// across the object's 10 s windows, overruns, memory, restarts, link transitions, and the message
// counts the 20:1 request billing is projected from.
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { from: { type: 'string' }, to: { type: 'string' } },
})
const from = values.from ? Number(values.from) : 0
const to = values.to ? Number(values.to) : Infinity
const rows = readFileSync(positionals[0], 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => r.t >= from && r.t <= to)
const by = (type) => rows.filter((r) => r.type === type)
const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null)
const q = (a, p) =>
  a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] : null
const windows = by('window')
const f = (x) => (x === null ? '-' : x.toFixed(2))
const start = by('start')[0]
const spanS = rows.length ? (rows[rows.length - 1].t - rows[0].t) / 1000 : 0
console.log(`log ${positionals[0]}: ${rows.length} rows over ${(spanS / 3600).toFixed(3)} h`)
if (start) console.log(`started ${new Date(start.t).toISOString()}, clients ${start.clients}`)
console.log(
  `windows: ${windows.length} (${windows.reduce((a, w) => a + w.ticks, 0)} timer callbacks)`,
)
if (windows.length) {
  const w50 = windows.map((w) => w.interval_ms.p50)
  const w99 = windows.map((w) => w.interval_ms.p99)
  const wmax = windows.map((w) => w.interval_ms.max)
  console.log(
    `timer ${windows[0].timer_ms} ms requested; callback interval ms: p50 of window p50 = ${f(med(w50))}, p99 of window p99 = ${f(q(w99, 0.99))}, median window p99 = ${f(med(w99))}, worst single = ${f(Math.max(...wmax))}`,
  )
  console.log(
    `tick duration ms (clock only advances on I/O): median window p99 = ${f(med(windows.map((w) => w.dur_ms.p99)))}, worst = ${f(Math.max(...windows.map((w) => w.dur_ms.max)))}`,
  )
  console.log(
    `overruns (gap > 1.5 x timer): total ${windows.reduce((a, w) => a + w.overruns, 0)} in ${windows.reduce((a, w) => a + w.ticks, 0)} callbacks; zero-gap callbacks ${windows.reduce((a, w) => a + (w.zeroGaps ?? 0), 0)}`,
  )
  console.log(
    `wasm memory bytes max ${Math.max(...windows.map((w) => w.memBytes))}, memGrows max ${Math.max(...windows.map((w) => w.memGrows))}`,
  )
  console.log(
    `window wall ms: perf median ${f(med(windows.map((w) => w.perf_ms)))} vs Date median ${f(med(windows.map((w) => w.date_ms)))}`,
  )
}
const statuses = by('status').filter((r) => r.live && r.arrive_ms && r.arrive_ms.n > 20)
if (statuses.length) {
  const a50 = statuses.map((r) => r.arrive_ms.p50)
  const a99 = statuses.map((r) => r.arrive_ms.p99)
  console.log(
    `client-side tick-message arrival gap ms (${statuses.length} client samples of ~10 s; includes network jitter): median p50 = ${f(med(a50))}, median p99 = ${f(med(a99))}, p99 of sample p99 = ${f(q(a99, 0.99))}, worst single = ${f(Math.max(...statuses.map((r) => r.arrive_ms.max)))}`,
  )
}
const hosts = windows.filter((w) => w.host)
if (hosts.length) {
  const last = hosts.at(-1).host
  console.log(
    `host counters (engine, cumulative, last window): ticksRun ${last.ticksRun}, ticksDropped ${last.ticksDropped}, tickOverruns ${last.tickOverruns}`,
  )
}
const starts = by('starts').at(-1)?.starts ?? []
console.log(
  `object starts (constructor runs, from the stats endpoint): ${starts.length}${starts.length ? ` at ${starts.map((s) => new Date(s.t).toISOString()).join(', ')}` : ''}`,
)
for (const r of by('fault')) console.log(`FAULT ${new Date(r.t).toISOString()} ${r.fault}`)
for (const r of by('poll-error'))
  console.log(`poll-error ${new Date(r.t).toISOString()} ${r.error}`)
const links = by('link')
const downs = links.filter((r) => !r.live && r.linkUpCount >= 1 && r.linkDown)
console.log(`link transitions: ${links.length}; with a recorded down: ${downs.length}`)
for (const r of downs)
  console.log(
    `  ${new Date(r.t).toISOString()} client ${r.client} down ${JSON.stringify(r.linkDown)} tick ${r.tick}`,
  )
const summary = by('summary').at(-1)
const lastStatus = new Map()
for (const r of by('status')) lastStatus.set(r.client, r)
const sentTotal = [...lastStatus.values()].reduce((a, r) => a + r.sent, 0)
const recvBytes = [...lastStatus.values()].reduce((a, r) => a + r.recvBytes, 0)
console.log(
  `last status per client: ${[...lastStatus.values()].map((r) => `c${r.client} live=${r.live} tick=${r.tick} up=${r.linkUpCount} sent=${r.sent} recv=${r.recv}`).join(' | ')}`,
)
if (spanS > 0 && sentTotal) {
  const perMonth = (sentTotal / spanS) * 86400 * 30
  console.log(
    `uplink messages ${sentTotal} in ${spanS.toFixed(0)} s = ${(sentTotal / spanS).toFixed(2)}/s; at 20:1 = ${(perMonth / 20 / 1e6).toFixed(3)} M billed requests per 30 days per ${lastStatus.size} clients (included 1 M/month on the plan, then $0.15/M)`,
  )
  console.log(`downlink ${(recvBytes / spanS).toFixed(0)} B/s (not billed on Workers)`)
  const gbs = spanS ? 0.125 * 86400 * 30 : 0
  console.log(
    `duration if the object stays active all month at 128 MB: ${gbs.toFixed(0)} GB-s per 30 days (included 400,000 GB-s, then $12.50 per million)`,
  )
}
if (summary) console.log(`summary row: reason ${summary.reason}, live ${summary.live}`)
