// Matrix: {dev, preview} x {require-corp, credentialless, none, require-corp html-only} x {chromium, webkit, firefox}
import { createServer, preview, build } from 'vite'
import { chromium, webkit, firefox } from 'playwright'
import { writeFileSync } from 'node:fs'
import { startAssetServer } from './asset-server.mjs'

const engines = { chromium, webkit, firefox }
const modes = [
  { name: 'require-corp', COEP: 'require-corp', HEADER_SCOPE: 'all' },
  { name: 'credentialless', COEP: 'credentialless', HEADER_SCOPE: 'all' },
  { name: 'none', COEP: 'none', HEADER_SCOPE: 'all' },
  { name: 'require-corp, headers on HTML only', COEP: 'require-corp', HEADER_SCOPE: 'html-only' },
]
const assets = await startAssetServer()
const browsers = {}
for (const [n, b] of Object.entries(engines)) browsers[n] = await b.launch()
const versions = Object.fromEntries(Object.entries(browsers).map(([n, b]) => [n, b.version()]))
console.log('browser versions', versions)

const all = []
for (const serverKind of ['dev', 'preview']) {
  for (const mode of modes) {
    process.env.COEP = mode.COEP
    process.env.HEADER_SCOPE = mode.HEADER_SCOPE
    let srv, url
    if (serverKind === 'dev') {
      srv = await createServer({ server: { port: 5173, strictPort: true }, logLevel: 'error' })
      await srv.listen()
      url = 'http://localhost:5173/'
    } else {
      await build({ logLevel: 'error' })
      srv = await preview({ preview: { port: 4173, strictPort: true }, logLevel: 'error' })
      url = 'http://localhost:4173/'
    }
    for (const [engine, browser] of Object.entries(browsers)) {
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      const consoleErrors = []
      page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 200)))
      let workerScriptHeaders = null
      page.on('response', (r) => {
        if (/isolation-worker/.test(r.url())) {
          const h = r.headers()
          workerScriptHeaders = { url: new URL(r.url()).pathname, coep: h['cross-origin-embedder-policy'] ?? null }
        }
      })
      let result
      try {
        await page.goto(url)
        await page.waitForFunction(() => window.__result, null, { timeout: 30000 })
        result = await page.evaluate(() => window.__result)
      } catch (e) {
        result = { error: String(e).slice(0, 300) }
      }
      const row = { server: serverKind, mode: mode.name, engine, workerScriptHeaders, result, consoleErrors }
      all.push(row)
      const r = result
      console.log(
        `[${serverKind}] [${mode.name}] [${engine}] main.coi=${r.main?.crossOriginIsolated} main.sab=${r.main?.sabConstruct}` +
          ` worker=${JSON.stringify(r.worker)} images=${JSON.stringify(r.images)} fetchNoCors=${r.fetchNoCorsPlain}` +
          ` workerScriptCOEP=${workerScriptHeaders?.coep}`,
      )
      await ctx.close()
    }
    await (serverKind === 'dev' ? srv.close() : new Promise((r) => srv.httpServer.close(r)))
    srv.httpServer?.closeAllConnections?.()
  }
}
writeFileSync(new URL('../results-isolation.json', import.meta.url), JSON.stringify({ versions, all }, null, 2))
for (const b of Object.values(browsers)) await b.close()
assets.close()
process.exit(0)
