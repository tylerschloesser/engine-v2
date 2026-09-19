import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
const p = spawn('node_modules/.bin/vite', ['--port', '5395', '--strictPort', '--force'], { env: { ...process.env, SPIKE_PROFILE: 'release', NO_COLOR: '1' } })
let out = ''
p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d))
while (!/Local:/.test(out)) await new Promise((r) => setTimeout(r, 50))
const b = await chromium.launch(); const page = await b.newPage()
page.on('response', (r) => /worker|engine/.test(r.url()) && console.log(r.status(), r.url().replace('http://localhost:5395', '')))
await page.goto('http://localhost:5395/?pattern=A')
await page.waitForFunction(() => window.__result, null, { timeout: 20000 }).catch(() => console.log('TIMEOUT'))
console.log(JSON.stringify(await page.evaluate(() => ({ ok: window.__result.ok, error: window.__result.error }))))
console.log(out.split('\n').filter((l) => /allow|outside|403|warn|error/i.test(l)).join('\n'))
await b.close(); p.kill()
