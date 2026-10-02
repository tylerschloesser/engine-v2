// `node games/reference/scripts/check-coi.mjs <url>` (docs/plan/38-hosting-checks.md, Scope B): asserts
// the two cross-origin isolation headers, with the exact values of 0015 section 3, on a deployed
// page's `/`, its hashed worker script, its `.wasm`, one image and a 404. Exits 0 when every response
// carries both, 1 with one line per miss. Plain Node, no dependencies.
const base = process.argv[2]
if (!base) {
  console.error('usage: node check-coi.mjs <url>')
  process.exit(2)
}
const EXPECT = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
}

const get = (path) => fetch(new URL(path, base), { redirect: 'manual' })
const failures = []

async function check(label, path, expectStatus) {
  const res = await get(path)
  await res.arrayBuffer()
  const got = Object.keys(EXPECT).map((h) => `${h}=${res.headers.get(h)}`)
  const bad = Object.entries(EXPECT).filter(([h, v]) => res.headers.get(h) !== v)
  const statusBad = expectStatus !== undefined && res.status !== expectStatus
  const ok = bad.length === 0 && !statusBad
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(8)} ${res.status} ${path} ${got.join(' ')}`)
  if (!ok) {
    failures.push(
      `${label} ${path}: status ${res.status}${statusBad ? ` (wanted ${expectStatus})` : ''}, ${bad
        .map(([h, v]) => `${h} is ${res.headers.get(h)} (wanted ${v})`)
        .join(', ')}`,
    )
  }
}

const html = await (await get('/')).text()
const scripts = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1])
let worker
let wasm
for (const s of scripts) {
  const js = await (await get(s)).text()
  worker ??= /\/assets\/worker-auto-[\w-]+\.js/.exec(js)?.[0]
  wasm ??= /\/assets\/game-[\w-]+\.wasm/.exec(js)?.[0]
}
if (!worker || !wasm) {
  console.error(
    `FAIL could not find the worker script (${worker}) or the .wasm (${wasm}) from ${scripts}`,
  )
  process.exit(1)
}

await check('page', '/', 200)
await check('worker', worker, 200)
await check('wasm', wasm, 200)
await check('image', '/tiles.png', 200)
await check('404', '/no-such-file-m38', 404)

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL ${f}`)
  process.exit(1)
}
console.log('check-coi: every response carries COOP same-origin and COEP require-corp')
