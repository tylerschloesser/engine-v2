// Control run: bare Vite config (see bare/vite.config.ts), dev and build+preview, patterns A and B.
import { spawn, execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
const vite = new URL('../node_modules/.bin/vite', import.meta.url).pathname
const cwd = new URL('../bare/', import.meta.url).pathname
const b = await chromium.launch()
let failed = 0
for (const mode of ['dev', 'preview']) {
  if (mode === 'preview') execFileSync(vite, ['build'], { cwd, stdio: 'pipe' })
  const port = mode === 'dev' ? '5391' : '5392'
  const p = spawn(vite, [...(mode === 'dev' ? ['--force'] : ['preview']), '--port', port, '--strictPort'], { cwd, env: { ...process.env, NO_COLOR: '1' } })
  let out = ''
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d))
  while (!/Local:/.test(out)) await new Promise((r) => setTimeout(r, 50))
  for (const pattern of ['A', 'B']) {
    const page = await b.newPage()
    await page.goto(`http://localhost:${port}/?pattern=${pattern}`)
    let r
    for (let i = 0; i < 400 && !r; i++) { r = await page.evaluate(() => window.__result).catch(() => undefined); await new Promise((r) => setTimeout(r, 50)) }
    const pass = r?.ok && r.sum === 42
    if (!pass) failed++
    console.log(pass ? 'PASS' : 'FAIL', 'bare', mode, JSON.stringify(r))
    await page.close()
  }
  p.kill()
}
await b.close()
process.exit(failed)
