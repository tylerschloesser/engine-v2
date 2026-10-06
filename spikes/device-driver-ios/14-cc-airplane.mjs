import { appiumSession, timed, sleep } from './ap.mjs'
const out = process.argv[2]
const s = await appiumSession()
const tap = (x, y) => s.exec('mobile: tap', { x, y })
const cc = () => s.exec('mobile: dragFromToForDuration', { duration: 0.3, fromX: 360, fromY: 2, toX: 360, toY: 500 })
try {
  await s.post('/context', { name: 'NATIVE_APP' })
  await timed('open CC', cc); await sleep(1200)
  // CC remembers its page: is this the connectivity page? screenshot to confirm
  await s.shot(`${out}/c-cc-0.png`)
  await timed('tap Airplane tile (on)', () => tap(194, 163)); await sleep(2500); await s.shot(`${out}/c-cc-air-on.png`)
  await timed('tap Airplane tile (off)', () => tap(194, 163)); await sleep(4000); await s.shot(`${out}/c-cc-air-off.png`)
  // other pages: swipe up/down inside CC
  await timed('swipe to previous page', () => s.exec('mobile: dragFromToForDuration', { duration: 0.2, fromX: 200, fromY: 700, toX: 200, toY: 200 })); await sleep(1000); await s.shot(`${out}/c-cc-p1.png`)
} finally { await s.del().catch(() => {}) }
