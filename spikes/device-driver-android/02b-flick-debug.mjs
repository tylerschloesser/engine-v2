import { attach, readings, swipe, sleep } from './lib.mjs'
const { browser, page } = await attach()
await page.evaluate(() => {
  window.__ev = []
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'touchstart', 'touchend'])
    addEventListener(t, (e) => window.__ev.push([t, Math.round(e.timeStamp), Math.round(e.clientX ?? e.touches?.[0]?.clientX ?? -1), e.pointerType ?? '']), { capture: true, passive: true })
})
const cx = async () => (await readings(page)).centre_x
await sleep(2500)
for (const [name, args] of [['slow 600ms left', [800, 1200, 400, 1200, 600]], ['flick 80ms left', [900, 1200, 300, 1200, 80]], ['flick 150ms right', [300, 1200, 900, 1200, 150]]]) {
  await sleep(2500)
  const a = await cx(); await page.evaluate(() => (window.__ev.length = 0))
  swipe(...args)
  const s = []; for (let i = 0; i < 10; i++) { await sleep(200); s.push(await cx()) }
  await sleep(1500); const z = await cx()
  const ev = await page.evaluate(() => window.__ev)
  console.log(name, 'start', a, 'samples', s.join(' '), 'final', z)
  console.log('  events', ev.length, JSON.stringify(ev.filter((e) => e[0] !== 'pointermove').concat(ev.filter((e) => e[0] === 'pointermove').slice(0, 3))))
}
await browser.close()
