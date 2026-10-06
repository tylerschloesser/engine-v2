import { attach, readings, pick, swipe, sleep } from './lib.mjs'
const K = ['tiles_across', 'centre_x', 'centre_y', 'taps', 'raf_p95_ms']
const { browser, page } = await attach()
const show = async (label) => console.log(label.padEnd(22), JSON.stringify(pick(await readings(page), K)))
await show('before')
// finger moves LEFT 400px (physical) => world point under finger follows => centre moves RIGHT (+x)
let t = Date.now(); swipe(800, 1200, 400, 1200, 600); console.log('swipe ms', Date.now() - t)
await sleep(300); await show('after pan left')
swipe(400, 1200, 800, 1200, 600); await sleep(300); await show('after pan right')
swipe(540, 1500, 540, 900, 600); await sleep(300); await show('after pan up')
// flick: fast swipe, then sample the glide
const c0 = await readings(page)
swipe(900, 1200, 300, 1200, 80)
const samples = []
for (let i = 0; i < 12; i++) { await sleep(150); const r = await readings(page); samples.push(r.centre_x) }
console.log('flick start', c0.centre_x, 'glide samples', samples.join(' '))
await browser.close()
