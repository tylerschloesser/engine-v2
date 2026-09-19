// Functional check of the SAB ring (and waitAsync / postMessage variants) in all three engines. No heap numbers here.
import { preview, build } from 'vite'
import { chromium, webkit, firefox } from 'playwright'
process.env.COEP = 'require-corp'
process.env.HEADER_SCOPE = 'all'
await build({ logLevel: 'error' })
const srv = await preview({ preview: { port: 4173, strictPort: true }, logLevel: 'error' })
for (const [name, type] of Object.entries({ chromium, webkit, firefox })) {
  const browser = await type.launch()
  for (const variant of ['sab', 'waitasync', 'pm-object', 'pm-transfer', 'pm-transfer-pool']) {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)))
    await page.goto(`http://localhost:4173/bench.html?variant=${variant}`)
    await new Promise((r) => setTimeout(r, 5000))
    const r = await page.evaluate(() => ({ s: Array.from(window.__stats), drops: window.__ctrl ? Atomics.load(window.__ctrl, 2) : 0 }))
    console.log(`${name} ${browser.version()} ${variant}: frames=${r.s[0]} wakes=${r.s[5]} msgs=${r.s[1]} seqErrors=${r.s[2]} maxDrain=${r.s[4]} ringDrops=${r.drops} errors=${JSON.stringify(errors)}`)
    await page.close()
  }
  await browser.close()
}
srv.httpServer.close()
process.exit(0)
