import { appiumSession, timed, sleep } from './ap.mjs'
const u = process.argv[2]
const s = await timed('new session', () => appiumSession())
try {
  console.log('contexts', JSON.stringify(await timed('contexts', () => s.get('/contexts')).catch((e) => e.message)))
  console.log('orientation', await s.get('/orientation'))
  console.log('window size', JSON.stringify(await s.get('/window/rect')))
} finally { await s.del().catch(() => {}) }
