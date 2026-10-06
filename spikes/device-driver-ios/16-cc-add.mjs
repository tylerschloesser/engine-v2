import { appiumSession, timed, sleep } from './ap.mjs'
const out = process.argv[2]
const s = await appiumSession()
const drag = (a, b, c, d, dur = 0.25) => s.exec('mobile: dragFromToForDuration', { duration: dur, fromX: a, fromY: b, toX: c, toY: d })
try {
  await s.post('/context', { name: 'NATIVE_APP' })
  await drag(360, 2, 360, 500, 0.3); await sleep(1200)
  await timed('tap +', () => s.exec('mobile: tap', { x: 52, y: 37 })); await sleep(1500); await s.shot(`${out}/c-cc-edit.png`)
} finally { await s.del().catch(() => {}) }
