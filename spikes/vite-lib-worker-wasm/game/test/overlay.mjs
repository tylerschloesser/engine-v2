// Break the Rust, expect Vite's error overlay with cargo's message; fix it, expect recovery.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
const src = 'sim/src/lib.rs'
const original = readFileSync(src, 'utf8')
const p = spawn('node_modules/.bin/vite', ['--port', '5396', '--strictPort'], { env: { ...process.env, NO_COLOR: '1' } })
let out = ''
p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d))
while (!/Local:/.test(out)) await new Promise((r) => setTimeout(r, 50))
const b = await chromium.launch(); const page = await b.newPage()
try {
  await page.goto('http://localhost:5396/?pattern=B')
  await page.waitForFunction(() => window.__result?.sum === 42, null, { timeout: 20000 })
  writeFileSync(src, original.replace('a + b + BIAS', 'a + b + BIAS +'))
  await page.waitForSelector('vite-error-overlay', { state: 'attached', timeout: 20000 })
  const text = await page.evaluate(() => document.querySelector('vite-error-overlay').shadowRoot.querySelector('.message')?.textContent ?? '')
  console.log('overlay shown:', /cargo build failed/.test(text), '| mentions rustc error:', /error: expected expression/.test(text) || /error/.test(text))
  console.log(text.split('\n').slice(0, 6).join('\n'))
  writeFileSync(src, original)
  await page.waitForFunction(() => window.__result?.sum === 42 && !document.querySelector('vite-error-overlay'), null, { timeout: 20000 })
  console.log('recovered after fix: true')
} finally {
  writeFileSync(src, original); await b.close(); p.kill()
}
