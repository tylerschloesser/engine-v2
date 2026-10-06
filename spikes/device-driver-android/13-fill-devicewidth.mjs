// Frame rate and canvas size at the device-width layout (after M39h), idle and auto-panning, 15 s each.
import { open, readings, sleep, setup, teardown } from './lib.mjs'
setup()
for (const q of ['device.html', 'device.html?autopan=1&tiles=256&scale=2']) {
  const { browser, page } = await open(q)
  await sleep(15000)
  const r = await readings(page)
  const c = await page.evaluate(() => { const c = document.querySelector('canvas'); return `${c.width}x${c.height}` })
  console.log(q, 'canvas', c, 'raf_p50', r.raf_p50_ms, 'raf_p95', r.raf_p95_ms, 'over20/10s', r.raf_over20_per_10s, 'gpu_p95', r.gpu_p95_ms)
  await browser.close()
}
teardown()
