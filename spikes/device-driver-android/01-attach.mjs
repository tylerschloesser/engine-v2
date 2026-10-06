import { open, readings, setup, teardown } from './lib.mjs'
setup()
const { browser, page } = await open('device.html')
console.log('url', page.url())
const info = await page.evaluate(async () => {
  const out = { crossOriginIsolated, secure: isSecureContext, hasGpu: !!navigator.gpu, ua: navigator.userAgent }
  out.sab = typeof SharedArrayBuffer
  out.hc = navigator.hardwareConcurrency
  out.dm = navigator.deviceMemory
  out.screen = [screen.width, screen.height, devicePixelRatio, innerWidth, innerHeight]
  if (navigator.gpu) {
    const a = await navigator.gpu.requestAdapter()
    out.adapter = a && { info: { vendor: a.info.vendor, architecture: a.info.architecture, device: a.info.device, description: a.info.description }, fallback: a.isFallbackAdapter, features: [...a.features], maxBuf: a.limits.maxBufferSize }
  }
  out.visibility = document.visibilityState
  return out
})
console.log(JSON.stringify(info, null, 1))
await new Promise((r) => setTimeout(r, 3000))
console.log(JSON.stringify(await readings(page), null, 1))
console.log('errors', await page.evaluate(() => window.__check.errors()))
console.log('act', await page.evaluate(() => Object.keys(window.__check.act ?? {})))
await browser.close()
teardown()
