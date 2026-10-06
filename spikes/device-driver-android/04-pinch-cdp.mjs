import { attach, readings, pick, sleep } from './lib.mjs'
const K = ['tiles_across', 'centre_x', 'centre_y']
const { browser, page } = await attach()
const cdp = await page.context().newCDPSession(page)
await page.evaluate(() => {
  window.__ev = {}
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove', 'gesturestart'])
    addEventListener(t, (e) => { const k = t + ':' + (e.pointerType ?? '') + (e.touches ? '/' + e.touches.length : ''); window.__ev[k] = (window.__ev[k] || 0) + 1 }, { capture: true, passive: true })
})
const show = async (l) => console.log(l.padEnd(34), JSON.stringify(pick(await readings(page), K)))
const evs = async () => { const e = await page.evaluate(() => { const e = window.__ev; window.__ev = {}; return e }); console.log('   page saw', JSON.stringify(e)) }
// CSS px coordinates: layout viewport is 980 wide
await sleep(2000); await show('before')
let t = Date.now()
try {
  await cdp.send('Input.synthesizePinchGesture', { x: 490, y: 800, scaleFactor: 2.5, relativeSpeed: 400, gestureSourceType: 'touch' })
  console.log('  synthesizePinchGesture(2.5) ok', Date.now() - t, 'ms')
} catch (e) { console.log('  synthesizePinchGesture failed:', e.message) }
await sleep(800); await show('after synthesizePinch 2.5x'); await evs()
try { await cdp.send('Input.synthesizePinchGesture', { x: 490, y: 800, scaleFactor: 0.3, relativeSpeed: 400, gestureSourceType: 'touch' }) } catch (e) { console.log('  fail', e.message) }
await sleep(800); await show('after synthesizePinch 0.3x'); await evs()
// raw multi-touch
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) })
async function pinchRaw(d0, d1, steps = 20) {
  const cx = 490, cy = 800
  await touch('touchStart', [[cx - d0, cy], [cx + d0, cy]])
  for (let i = 1; i <= steps; i++) { const d = d0 + ((d1 - d0) * i) / steps; await touch('touchMove', [[cx - d, cy], [cx + d, cy]]); await sleep(16) }
  await touch('touchEnd', [])
}
t = Date.now(); await pinchRaw(60, 300); console.log('  raw spread ms', Date.now() - t)
await sleep(800); await show('after raw dispatchTouch spread'); await evs()
await pinchRaw(300, 60); await sleep(800); await show('after raw dispatchTouch pinch'); await evs()
for (let i = 0; i < 4; i++) await pinchRaw(60, 300, 12); await sleep(800); await show('after 4 raw spreads (limit?)')
for (let i = 0; i < 6; i++) await pinchRaw(300, 40, 12); await sleep(800); await show('after 6 raw pinches (limit?)')
const r = await readings(page); console.log('finite', [r.tiles_across, r.centre_x, r.centre_y].every(Number.isFinite))
await browser.close()
