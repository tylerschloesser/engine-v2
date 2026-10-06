import { attach, readings, pick, pinch, sleep } from './lib.mjs'
const K = ['tiles_across', 'centre_x', 'centre_y']
const { browser, page } = await attach()
await page.evaluate(() => {
  window.__ev = {}
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove', 'gesturestart'])
    addEventListener(t, (e) => { const k = t + ':' + (e.pointerType ?? '') + (e.touches ? '/' + e.touches.length : ''); window.__ev[k] = (window.__ev[k] || 0) + 1 }, { capture: true, passive: true })
})
const show = async (l) => console.log(l.padEnd(26), JSON.stringify(pick(await readings(page), K)))
await sleep(2500); await show('before')
for (const [name, o] of [['spread (zoom in) 100->450', { d0: 100, d1: 450 }], ['pinch (zoom out) 450->100', { d0: 450, d1: 100 }], ['spread x3 (to limit)', null], ['pinch x4 (to limit)', null]]) {
  if (o) { const t = Date.now(); pinch({ ...o, steps: 25, stepMs: 16 }); await sleep(1200); console.log('  script ms', Date.now() - t) }
  else if (name.startsWith('spread')) { for (let i = 0; i < 3; i++) pinch({ d0: 100, d1: 450, steps: 25 }); await sleep(1200) }
  else { for (let i = 0; i < 4; i++) pinch({ d0: 450, d1: 100, steps: 25 }); await sleep(1200) }
  await show(name)
}
console.log('page saw', JSON.stringify(await page.evaluate(() => window.__ev)))
const r = await readings(page); console.log('finite', Number.isFinite(r.tiles_across) && Number.isFinite(r.centre_x) && Number.isFinite(r.centre_y))
await browser.close()
