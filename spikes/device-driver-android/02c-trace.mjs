import { attach, swipe, sleep } from './lib.mjs'
const { browser, page } = await attach()
await page.evaluate(() => {
  window.__tr = []; window.__on = true
  const t0 = performance.now()
  const f = () => { const c = window.__check.readings(); window.__tr.push([Math.round(performance.now() - t0), c.centre_x]); if (window.__on) requestAnimationFrame(f) }
  requestAnimationFrame(f)
  addEventListener('pointerdown', () => window.__tr.push(['down', Math.round(performance.now() - t0)]), true)
  addEventListener('pointerup', () => window.__tr.push(['up', Math.round(performance.now() - t0)]), true)
})
await sleep(3000)
await page.evaluate(() => (window.__tr.length = 0))
swipe(900, 1200, 300, 1200, 100)
await sleep(2500)
const tr = await page.evaluate(() => (window.__on = false, window.__tr))
const ev = tr.filter((x) => typeof x[0] === 'string'); const xs = tr.filter((x) => typeof x[0] === 'number')
console.log('events', JSON.stringify(ev))
console.log(xs.filter((_, i) => i % 3 === 0).slice(0, 45).map((x) => x.join(':')).join(' '))
await browser.close()
