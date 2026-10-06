// Low Power Mode via Settings > Battery (the default Control Center layout has no Low Power Mode tile; "+ Add a Control" would change Tyler's layout)
import { appiumSession, timed, sleep } from './ap.mjs'
const out = process.argv[2]
const s = await appiumSession({ 'appium:bundleId': 'com.apple.Preferences' })
const el = async () => { const r = await s.post('/element', { using: 'accessibility id', value: 'LOW_POWER_MODE_IDENTIFIER_SWITCH' }); return Object.values(r)[0] }
try {
  await s.post('/context', { name: 'NATIVE_APP' })
  await timed('tap Battery row', () => s.exec('mobile: tap', { x: 100, y: 705 })); await sleep(1500)
  const sw = await timed('find LPM switch', el)
  console.log('value before', await s.get(`/element/${sw}/attribute/value`))
  await timed('toggle ON', () => s.post(`/element/${sw}/click`)); await sleep(3000)
  console.log('value after ON', await s.get(`/element/${sw}/attribute/value`)); await s.shot(`${out}/c-set-lpm-on.png`)
  await timed('toggle OFF', () => s.post(`/element/${sw}/click`)); await sleep(3000)
  console.log('value after OFF', await s.get(`/element/${sw}/attribute/value`)); await s.shot(`${out}/c-set-lpm-off.png`)
} finally { await s.exec('mobile: pressButton', { name: 'home' }).catch(() => {}); await s.del().catch(() => {}) }
