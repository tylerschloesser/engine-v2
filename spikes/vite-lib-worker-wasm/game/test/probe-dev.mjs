// Records which URLs the browser requests in dev, to see whether the engine was pre-bundled.
import { spawn } from 'node:child_process'
import { rmSync, readdirSync, existsSync } from 'node:fs'
import { chromium } from 'playwright'
const exclude = process.argv[2] ?? '0'
rmSync('node_modules/.vite', { recursive: true, force: true })
const p = spawn('node_modules/.bin/vite', ['--port', '5399', '--strictPort'], { env: { ...process.env, SPIKE_EXCLUDE: exclude, SPIKE_PROFILE: 'release', NO_COLOR: '1' } })
let out = ''
p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d))
while (!/Local:/.test(out)) await new Promise((r) => setTimeout(r, 50))
const b = await chromium.launch()
for (const pattern of ['A', 'B']) {
  const page = await b.newPage()
  const reqs = []
  page.on('request', (r) => reqs.push(`${r.resourceType()} ${r.url().replace('http://localhost:5399', '')}`))
  page.on('worker', (w) => reqs.push('WORKER ' + w.url().replace('http://localhost:5399', '')))
  await page.goto(`http://localhost:5399/?pattern=${pattern}`)
  await page.waitForFunction(() => window.__result, null, { timeout: 20000 })
  console.log(`--- exclude=${exclude} pattern=${pattern} ok=${await page.evaluate(() => window.__result.ok)}`)
  console.log(reqs.join('\n'))
  await page.close()
}
console.log('.vite/deps:', existsSync('node_modules/.vite/deps') ? readdirSync('node_modules/.vite/deps').join(' ') : '(none)')
console.log(out.split('\n').filter((l) => /optimiz|deps|error|warn/i.test(l)).join('\n'))
await b.close(); p.kill()
