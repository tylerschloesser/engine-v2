// Leg B: does `developer dvt screenshot` during the 10 s rAF/GPU measuring window disturb it?
import { newSession, sleep } from './wd.mjs'
import { execFileSync } from 'node:child_process'
const [u, out] = process.argv.slice(2)
const s = await newSession()
const K = ['raf_p50_ms', 'raf_p95_ms', 'raf_worst_ms', 'raf_over20', 'raf_n', 'gpu_p95_ms', 'gpu_n']
const rd = async (t) => { const r = await s.readings(); console.log(t.padEnd(26), K.map((k) => `${k}=${r[k]}`).join(' ')) }
try {
  await s.get(u + '/device.html'); await sleep(12000)
  await rd('baseline #1'); await sleep(11000); await rd('baseline #2 (no shot)'); await sleep(11000); await rd('baseline #3')
  // Windows are 10 s rolling: screenshots at t+1, t+3, t+5 s, then read at t+9 s
  for (let round = 1; round <= 2; round++) {
    await sleep(11000)
    const t0 = Date.now()
    for (const d of [1000, 3000, 5000]) { await sleep(Math.max(0, d - (Date.now() - t0))); const a = Date.now(); execFileSync('pymobiledevice3', ['developer', 'dvt', 'screenshot', `${out}/b-shot-${round}.png`], { stdio: 'ignore' }); console.log(`  shot at +${a - t0} ms took ${Date.now() - a} ms`) }
    await sleep(Math.max(0, 9500 - (Date.now() - t0))); await rd(`with 3 shots (round ${round})`)
  }
  await sleep(11000); await rd('after (no shot)')
} finally { await s.end().catch(() => {}) }
