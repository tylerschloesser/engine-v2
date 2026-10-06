import { appiumSession, timed, sleep } from './ap.mjs'
const out = process.argv[2]
const s = await appiumSession({ 'appium:bundleId': 'com.apple.Preferences' })
const names = async () => { const src = await s.get('/source'); return [...src.matchAll(/<XCUIElementType(\w+)[^>]*?(?:label|name)="([^"]+)"/g)].filter((m) => /Switch|Cell|Button/.test(m[1])).map((m) => m[1][0] + ':' + m[2]).slice(0, 40).join(' | ') }
try {
  await s.post('/context', { name: 'NATIVE_APP' })
  await s.exec('mobile: tap', { x: 100, y: 705 }); await sleep(1500)
  console.log('battery page:', await names())
  await s.exec('mobile: dragFromToForDuration', { duration: 0.3, fromX: 200, fromY: 700, toX: 200, toY: 250 }); await sleep(800)
  console.log('scrolled:', await names()); await s.shot(`${out}/c-set-battery2.png`)
} finally { await s.del().catch(() => {}) }
