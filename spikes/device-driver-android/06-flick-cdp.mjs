import { attach, readings, sleep, swipe } from './lib.mjs'
const { browser, page } = await attach()
const cdp = await page.context().newCDPSession(page)
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) })
const cx = async () => (await readings(page)).centre_x
async function drag(x0, x1, ms, n = 8) {
  await touch('touchStart', [[x0, 700]])
  for (let i = 1; i <= n; i++) { await touch('touchMove', [[x0 + ((x1 - x0) * i) / n, 700]]); await sleep(ms / n) }
  await touch('touchEnd', [])
}
for (const [name, f] of [['CDP touch flick left (finger 800->300 css, 80 ms)', () => drag(800, 300, 80)], ['CDP touch slow drag left then HOLD 400ms then release', async () => { await touch('touchStart', [[800, 700]]); for (let i = 1; i <= 10; i++) { await touch('touchMove', [[800 - 40 * i, 700]]); await sleep(30) } await sleep(400); await touch('touchEnd', []) }], ['adb flick left (80 ms)', () => swipe(900, 1200, 300, 1200, 80)]]) {
  await sleep(3000); const a = await cx(); await f(); await sleep(2500); const z = await cx()
  console.log(name.padEnd(62), 'centre_x', a, '->', z, 'delta', (z - a).toFixed(2))
}
await browser.close()
