import { appiumSession, timed, sleep } from './ap.mjs'
const out = process.argv[2]
const s = await appiumSession()
try {
  await s.post('/context', { name: 'NATIVE_APP' })
  await timed('open Control Center (drag from top-right)', () => s.exec('mobile: dragFromToForDuration', { duration: 0.3, fromX: 360, fromY: 2, toX: 360, toY: 500 }))
  await sleep(1200); await s.shot(`${out}/c-cc1.png`)
  const src = await s.get('/source'); const names = [...src.matchAll(/<XCUIElementType(?:Button|Switch|Other|Cell)[^>]*(?:label|name)="([^"]+)"[^>]*>/g)].map((m) => m[1]); console.log([...new Set(names)].join(' | ').slice(0, 1500))
} finally { await s.del().catch(() => {}) }
