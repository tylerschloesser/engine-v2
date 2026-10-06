import { attach, readings, pick, sh, sleep, screencap } from './lib.mjs'
const { browser, page } = await attach()
const K = ['orientation', 'canvas_w', 'canvas_h', 'tiles_across', 'centre_x', 'centre_y']
const snap = async (l) => console.log(l.padEnd(28), JSON.stringify(pick(await readings(page), K)), JSON.stringify(await page.evaluate(() => [innerWidth, innerHeight, screen.orientation.type])))
const orig = { acc: sh('settings get system accelerometer_rotation'), rot: sh('settings get system user_rotation') }
console.log('original settings', JSON.stringify(orig))
await sleep(2500); await snap('portrait (initial)')
try {
  sh('settings put system accelerometer_rotation 0')
  for (const [n, r] of [[1, 'user_rotation=1 (landscape)'], [0, 'user_rotation=0 (portrait)'], [3, 'user_rotation=3 (reverse landscape)'], [0, 'back to 0']]) {
    const t = Date.now(); sh(`settings put system user_rotation ${n}`)
    await page.waitForFunction((o) => window.__check.readings().orientation !== o, (await readings(page)).orientation, { timeout: 4000 }).catch(() => {})
    const dt = Date.now() - t; await sleep(1500); await snap(r + ` [${dt}ms]`)
    if (n === 1) screencap(process.env.SHOT_LAND ?? '/dev/null')
  }
} finally {
  sh(`settings put system user_rotation ${orig.rot === 'null' ? 0 : orig.rot}`); sh(`settings put system accelerometer_rotation ${orig.acc}`)
  console.log('restored', sh('settings get system accelerometer_rotation'), sh('settings get system user_rotation'))
}
await browser.close()
