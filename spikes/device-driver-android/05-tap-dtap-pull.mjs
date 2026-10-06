import { attach, readings, pick, swipe, tap, sh, sleep } from './lib.mjs'
const K = ['tiles_across', 'centre_x', 'centre_y', 'taps', 'tap_tile_x', 'tap_tile_y', 'cursor_valid', 'cursor_tile_x', 'cursor_tile_y']
const { browser, page } = await attach()
const state = () => page.evaluate(() => ({ origin: Math.round(performance.timeOrigin), scrollY, scrollX, vvScale: visualViewport.scale, vvW: Math.round(visualViewport.width), vvOffTop: visualViewport.offsetTop, marker: window.__marker, hud: document.getElementById('hud')?.innerText.slice(0, 200) }))
await page.evaluate(() => { window.__marker = 'alive' })
await sleep(3500) // let the glide settle
const show = async (l) => console.log(l.padEnd(16), JSON.stringify(pick(await readings(page), K)))
await show('before'); console.log('  page', JSON.stringify(await state()))
// ground truth for the tile: tileUnder(x,y) act, CSS px
console.log('act.tileUnder keys', await page.evaluate(() => window.__check.act.tileUnder.toString().slice(0, 300)))
const css = (px) => Math.round(px / (1080 / 980))
const pts = [[540, 1000], [300, 1500], [800, 700]]
for (const [x, y] of pts) {
  tap(x, y); await sleep(500)
  const r = await readings(page)
  let truth; try { truth = await page.evaluate(([a, b]) => window.__check.act.tileUnder({ x: a, y: b }), [css(x), css(y) - css(0)]) } catch (e) { truth = String(e).slice(0, 80) }
  console.log(`tap(${x},${y})`.padEnd(16), JSON.stringify(pick(r, ['taps', 'tap_tile_x', 'tap_tile_y', 'cursor_tile_x', 'cursor_tile_y'])), 'tileUnder', JSON.stringify(truth))
}
// double tap
const before = await state(); const c0 = await readings(page)
sh('input tap 540 1200 & input tap 540 1200'); await sleep(800)
const after = await state(); const c1 = await readings(page)
console.log('double-tap taps', c0.taps, '->', c1.taps, 'tiles_across', c0.tiles_across, '->', c1.tiles_across, 'vvScale', after.vvScale, 'origin same', before.origin === after.origin)
// pull down from just under the toolbar, and from the very top of the viewport
for (const y0 of [330, 420]) {
  swipe(540, y0, 540, y0 + 900, 400); await sleep(1500)
  const s = await state(); const c = await readings(page)
  console.log(`pull-down from y=${y0}: reloaded=${s.origin !== before.origin || s.marker !== 'alive'} scrollY=${s.scrollY} vvScale=${s.vvScale} offTop=${s.vvOffTop} tiles ${c.tiles_across} centre ${c.centre_x},${c.centre_y}`)
}
console.log('page after', JSON.stringify(await state()))
await sleep(500); await browser.close()
