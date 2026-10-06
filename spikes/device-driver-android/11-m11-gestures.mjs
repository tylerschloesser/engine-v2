// Scripted M11-gestures equivalent: boot, 10 s pan, flick, pinch to both limits, tap, pull-down, double-tap, rotate.
import { open, readings, swipe, tap, sh, sleep, setup, teardown } from './lib.mjs'
const T0 = Date.now(); const lap = (l, ok, extra = '') => console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(5)} s] ${ok ? 'PASS' : 'FAIL'} ${l} ${extra}`)
setup()
const { browser, page } = await open('device.html')
const cdp = await page.context().newCDPSession(page)
const R = () => readings(page)
let r = await R()
lap('boot: isolated + adapter + workers ready', r.isolated === true && r.adapter !== '' && r.workers_ready === true, `${r.adapter} ${r.delivery}`)
const marker = await page.evaluate(() => { window.__m = 1; return performance.timeOrigin })
// pan 10 s: finger moves 300 px left over 10 s
await sleep(1500); const a = await R(); swipe(800, 1200, 500, 1200, 10000); await sleep(1200); let b = await R()
lap('pan 10 s: centre follows the finger (+x for finger left)', b.centre_x - a.centre_x > 0, `centre_x ${a.centre_x} -> ${b.centre_x}`)
// flick: glide should continue in the direction of the flick and stop
await sleep(3000); const f0 = (await R()).centre_x; swipe(900, 1200, 300, 1200, 80); await sleep(2500); const f1 = (await R()).centre_x; await sleep(1000); const f2 = (await R()).centre_x
lap('flick glides in flick direction and stops', f1 > f0 && Math.abs(f2 - f1) < 0.01, `centre_x ${f0} -> ${f1} (+1 s: ${f2})`)
// pinch both limits via CDP touch
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) })
async function pinch(d0, d1, n = 10) { await touch('touchStart', [[490 - d0, 800], [490 + d0, 800]]); for (let i = 1; i <= n; i++) { const d = d0 + ((d1 - d0) * i) / n; await touch('touchMove', [[490 - d, 800], [490 + d, 800]]); await sleep(16) } await touch('touchEnd', []) }
const seen = []
for (let i = 0; i < 6; i++) { await pinch(40, 330); seen.push((await R()).tiles_across) }
const zin = (await R()).tiles_across
for (let i = 0; i < 8; i++) { await pinch(330, 40); seen.push((await R()).tiles_across) }
const zout = (await R()).tiles_across
await sleep(800)
lap('pinch to both zoom limits, finite', Number.isFinite(zin) && Number.isFinite(zout) && zin < zout, `in-limit ${zin}, out-limit ${zout}; sequence ${seen.join(' ')}`)
// tap
const t0 = (await R()).taps; await sleep(1500); tap(540, 1200); await sleep(500); r = await R()
lap('tap reports a tile', r.taps === t0 + 1 && r.tap_tile_x !== null, `tile (${r.tap_tile_x},${r.tap_tile_y})`)
// pull down from the top edge (below the toolbar) + double tap
sh('input swipe 540 330 540 1300 400'); await sleep(1200)
sh('input tap 540 1200 & input tap 540 1200'); await sleep(900)
const st = await page.evaluate(() => ({ origin: performance.timeOrigin, m: window.__m, scrollY, vv: visualViewport.scale }))
lap('pull-down + double-tap: no reload, scroll or zoom', st.origin === marker && st.m === 1 && st.scrollY === 0 && Math.abs(st.vv - 0.4007) < 0.01, JSON.stringify(st))
// rotate
const accel = sh('settings get system accelerometer_rotation'); const rot = sh('settings get system user_rotation')
const before = await R(); sh('settings put system accelerometer_rotation 0'); sh('settings put system user_rotation 1'); await sleep(1500); const land = await R()
sh('settings put system user_rotation 0'); await sleep(1500); const back = await R()
sh(`settings put system user_rotation ${rot}`); sh(`settings put system accelerometer_rotation ${accel}`)
lap('rotate: orientation flips, centre kept, restored', land.orientation === 'landscape' && back.orientation === 'portrait' && Math.abs(land.centre_x - before.centre_x) < 0.5, `centre ${before.centre_x} -> ${land.centre_x} -> ${back.centre_x}`)
console.log(`TOTAL ${((Date.now() - T0) / 1000).toFixed(1)} s (incl. 10 s pan, 14 s of waits it does not need to be)`)
await browser.close(); teardown()
