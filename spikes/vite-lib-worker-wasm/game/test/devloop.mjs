// Measures: save .rs -> (watcher) -> cargo build -> full-reload -> page shows new wasm's value.
// Usage: node test/devloop.mjs [dev|release] [iterations]
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const profile = process.argv[2] ?? 'dev'
const N = Number(process.argv[3] ?? 6)
const src = 'sim/src/lib.rs'
const original = readFileSync(src, 'utf8')
const withBias = (n) => original.replace(/pub const BIAS: i32 = \d+;/, `pub const BIAS: i32 = ${n};`)

const p = spawn('node_modules/.bin/vite', ['--port', '5398', '--strictPort'], { env: { ...process.env, SPIKE_PROFILE: profile, NO_COLOR: '1' } })
let out = ''
p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d))
while (!/Local:/.test(out)) await new Promise((r) => setTimeout(r, 50))
const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto('http://localhost:5398/?pattern=B&wasm=virtual')
const sumNow = async () => { try { return await page.evaluate(() => window.__result?.sum) } catch { return undefined } }
const tStart = Date.now()
while ((await sumNow()) !== 42) {
  if (Date.now() - tStart > 30_000) { p.kill(); await browser.close(); throw new Error('initial load never produced sum=42: ' + JSON.stringify(await page.evaluate(() => window.__result).catch(() => null))) }
  await new Promise((r) => setTimeout(r, 20))
}

const rows = []
try {
  for (let i = 1; i <= N; i++) {
    const mark = out.length
    const t0 = Date.now()
    writeFileSync(src, withBias(i))
    while ((await sumNow()) !== 42 + i) {
      if (Date.now() - t0 > 120_000) throw new Error('timeout\n' + out.slice(mark))
      await new Promise((r) => setTimeout(r, 5))
    }
    const total = Date.now() - t0
    const log = out.slice(mark)
    const detect = Number(/change: .* t=(\d+)/.exec(log)?.[1]) - t0
    const cargo = Number(/cargo build \(\w+\) ok in (\d+) ms/.exec(log)?.[1])
    const reloadSent = Number(/full-reload sent t=(\d+)/.exec(log)?.[1]) - t0
    rows.push({ i, detect, cargo, reloadSent, total })
    console.log(`#${i} profile=${profile}: watcher +${detect} ms, cargo ${cargo} ms, reload sent +${reloadSent} ms, new value on page +${total} ms`)
    await new Promise((r) => setTimeout(r, 300))
  }
} finally {
  p.kill(); await browser.close()
  writeFileSync(src, original)
}
const med = (k) => rows.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(rows.length / 2)]
console.log(`MEDIAN profile=${profile}: cargo ${med('cargo')} ms, save->page ${med('total')} ms (n=${rows.length})`)
