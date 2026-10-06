import { appiumSession, timed, sleep } from './ap.mjs'
const out = process.argv[2]
const s = await appiumSession()
const drag = (a, b, c, d, dur = 0.25) => s.exec('mobile: dragFromToForDuration', { duration: dur, fromX: a, fromY: b, toX: c, toY: d })
try {
  await s.post('/context', { name: 'NATIVE_APP' })
  await drag(360, 2, 360, 500, 0.3); await sleep(1200)
  for (let i = 1; i <= 3; i++) { await timed('page back ' + i, () => drag(150, 400, 150, 1300)); await sleep(1000); await s.shot(`${out}/c-cc-page-${i}.png`) }
} finally { await s.del().catch(() => {}) }
