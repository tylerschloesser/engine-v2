import { newSession, sleep, finger, down, up, mv, pause } from './wd.mjs'
const [u, outdir = '.'] = process.argv.slice(2)
const s = await newSession()
const KEYS = ['tiles_across', 'centre_x', 'centre_y', 'taps', 'tap_tile_x', 'tap_tile_y', 'cursor_valid', 'cursor_tile_x', 'cursor_tile_y', 'orientation']
const snap = async () => { const r = await s.readings(); return Object.fromEntries(KEYS.map((k) => [k, r[k]])) }
const page = async () => s.js('return [innerWidth,innerHeight,visualViewport.scale,visualViewport.offsetLeft,visualViewport.offsetTop,scrollX,scrollY,document.scrollingElement.scrollHeight]')
const finite = (o) => Object.values(o).every((v) => typeof v !== 'number' || Number.isFinite(v))
async function run(name, actions, wait = 1500) {
  const a = await snap(); const p0 = await page()
  const t = performance.now()
  await s.actions(actions); await s.release().catch(() => {})
  const dt = Math.round(performance.now() - t)
  await sleep(wait)
  const b = await snap(); const p1 = await page()
  console.log(`\n== ${name} (actions call ${dt} ms)\n before ${JSON.stringify(a)}\n after  ${JSON.stringify(b)}\n finite=${finite(b)} page ${JSON.stringify(p0)} -> ${JSON.stringify(p1)}`)
}
try {
  await s.get(u + '/device.html'); await sleep(6000)
  console.log('boot', JSON.stringify(await snap()), 'page', JSON.stringify(await page()))
  await run('pan left 400px', [finger('f1', [mv(750, 900), down(), mv(750, 900, 0), mv(350, 900, 400), up()])])
  await run('pan down-right 300px', [finger('f1', [mv(300, 700), down(), mv(600, 1000, 400), up()])])
  await run('flick (fast, 60ms)', [finger('f1', [mv(800, 1000), down(), mv(300, 1000, 60), up()])], 3000)
  const pinch = (x0a, x0b, x1a, x1b, y, ms) => [
    finger('f1', [mv(x0a, y), down(), mv(x1a, y, ms), up()]),
    finger('f2', [mv(x0b, y), down(), mv(x1b, y, ms), up()])]
  await run('pinch OUT (zoom in) 200->600 apart', pinch(440, 540, 240, 740, 900, 500))
  await run('pinch IN (zoom out) 600->100 apart', pinch(240, 740, 440, 540, 900, 500))
  for (let i = 0; i < 4; i++) await run(`pinch IN again #${i + 1}`, pinch(240, 740, 440, 540, 900, 400), 800)
  for (let i = 0; i < 6; i++) await run(`pinch OUT again #${i + 1}`, pinch(440, 540, 100, 880, 900, 400), 800)
  await run('tap (490,900)', [finger('f1', [mv(490, 900), down(), pause(60), up()])])
  await run('double-tap (300,600)', [finger('f1', [mv(300, 600), down(), pause(40), up(), pause(80), down(), pause(40), up()])])
  await run('pull down from top edge', [finger('f1', [mv(490, 5), down(), mv(490, 700, 400), up()])])
  await s.screenshot(`${outdir}/a-gestures-end.png`)
} finally { await s.end().catch(() => {}) }
