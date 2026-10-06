// Pinch at the device-width layout (after M39h): CSS width ~393, so fingers centre at innerWidth/2.
import { open, readings, sleep, setup, teardown } from './lib.mjs'
setup()
const { browser, page } = await open('device.html')
const cdp = await page.context().newCDPSession(page)
const { w, h } = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))
const cx = w / 2, cy = h / 2
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) })
async function pinch(d0, d1, n = 10) { await touch('touchStart', [[cx - d0, cy], [cx + d0, cy]]); for (let i = 1; i <= n; i++) { const d = d0 + ((d1 - d0) * i) / n; await touch('touchMove', [[cx - d, cy], [cx + d, cy]]); await sleep(16) } await touch('touchEnd', []) }
const seen = [(await readings(page)).tiles_across]
for (let i = 0; i < 8; i++) { await pinch(20, 170); seen.push((await readings(page)).tiles_across) }
for (let i = 0; i < 10; i++) { await pinch(170, 20); seen.push((await readings(page)).tiles_across) }
const r = await readings(page)
console.log(`innerWidth ${w}; tiles_across sequence ${seen.join(' ')}; centre ${r.centre_x},${r.centre_y}; finite ${seen.every(Number.isFinite) && Number.isFinite(r.centre_x)}`)
await browser.close(); teardown()
