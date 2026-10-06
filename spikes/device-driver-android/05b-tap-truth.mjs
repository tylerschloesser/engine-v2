import { attach, readings, tap, sleep } from './lib.mjs'
const { browser, page } = await attach()
await page.evaluate(() => { if (!window.__pd) { window.__pd = null; addEventListener('pointerdown', (e) => { window.__pd = [e.clientX, e.clientY] }, true) } })
for (const [x, y] of [[540, 1000], [300, 1500], [800, 700], [200, 600]]) {
  await sleep(1500); tap(x, y); await sleep(500)
  const r = await readings(page); const pd = await page.evaluate(() => window.__pd)
  const truth = await page.evaluate(([a, b]) => window.__check.act.tileUnder({ x: a, y: b }), pd)
  console.log(`adb tap(${x},${y}) -> page clientXY ${pd.map((v) => Math.round(v))}; HUD tap tile (${r.tap_tile_x},${r.tap_tile_y}) cursor (${r.cursor_tile_x},${r.cursor_tile_y}); tileUnder(clientXY) ${JSON.stringify(truth)}`)
}
await browser.close()
