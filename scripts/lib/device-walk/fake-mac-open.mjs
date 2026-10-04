// `DEVICE_WALK_OPEN='node scripts/lib/device-walk/fake-mac-open.mjs'`: the demonstration's stand-in for
// `open -a Safari|Firefox <url>` (mac-browser.mjs runs `<command> <browser> <url>`). It opens the URL in a
// Playwright browser (`safari` is WebKit, `firefox` is Firefox) and plays the person until the round is done.
// Firefox in Playwright has no WebGPU, which is the real "Firefox without navigator.gpu" case.
import { chromium, firefox, webkit } from '@playwright/test'
import { walkAsMac } from './fake-mac.mjs'

const [, , browser, url] = process.argv
const engine = { safari: webkit, firefox, chromium }[browser] ?? chromium
const b = await engine.launch(
  browser === 'chromium' ? { channel: 'chromium', args: ['--enable-unsafe-webgpu'] } : {},
)
const page = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
page.on('pageerror', () => {})
const stop = () => b.close().finally(() => process.exit(0))
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, stop)
let finished = false
let down = 0
const poll = setInterval(async () => {
  const phase = await page.evaluate(() => window.__walkAgent?.step?.phase).catch(() => null)
  if (phase === 'done') finished = true
  // The tool stops its servers when the round is done; a tab that can no longer reach it is finished too.
  const up = await page
    .evaluate(() =>
      fetch('/__walk/agent.js', { cache: 'no-store' }).then(
        (r) => r.ok,
        () => false,
      ),
    )
    .catch(() => true)
  down = up ? 0 : down + 1
  if (down >= 3) finished = true
}, 2000)
try {
  await page.goto(url)
  await walkAsMac(page, {
    isDone: () => finished,
    timeoutMs: 40 * 60_000,
    handlers: [],
    onBar: () => {},
  })
} catch (e) {
  console.error(`fake mac ${browser}: ${e.message}`)
}
clearInterval(poll)
await b.close()
