// Does screencap / screenrecord disturb rAF + GPU readings?  Readings are a rolling 10 s window on the page.
import { attach, readings, sh, sleep, screencap, adb } from './lib.mjs'
import { spawn } from 'node:child_process'
const { browser, page } = await attach()
const K = ['raf_p50_ms', 'raf_p95_ms', 'raf_worst_ms', 'raf_over20', 'raf_n', 'gpu_p95_ms', 'gpu_n']
const pk = (r) => Object.fromEntries(K.map((k) => [k, r[k]]))
const fps = async (s) => { const a = (await readings(page)).frames; await sleep(s * 1000); return (((await readings(page)).frames - a) / s).toFixed(1) }
console.log('A idle   ', JSON.stringify(pk(await (async () => { await sleep(11000); return readings(page) })())), 'fps', await fps(3))
await sleep(8000)
console.log('A2 idle  ', JSON.stringify(pk(await readings(page))))
// B: screencap once a second for 10 s
let ms = []; const t0 = Date.now()
for (let i = 0; i < 10; i++) { const t = Date.now(); screencap(`/private/tmp/claude-501/-Users-tyler-repos-engine-v2/221cb9fd-d757-476f-8f42-72af3362a61a/scratchpad/shots/cap-${i}.png`); ms.push(Date.now() - t); await sleep(Math.max(0, 1000 - (Date.now() - t))) }
console.log('B screencap x10/10s', JSON.stringify(pk(await readings(page))), 'screencap ms', ms.join(','))
await sleep(11000)
console.log('C idle again', JSON.stringify(pk(await readings(page))))
// D: screenrecord 10 s
const rec = spawn('/opt/homebrew/bin/adb', ['-s', '13061FDD4002VN', 'shell', 'screenrecord', '--time-limit', '10', '--bit-rate', '4000000', '/sdcard/spike.mp4'], { stdio: 'inherit' })
const done = new Promise((r) => rec.on('close', r)); await sleep(10500); await done
console.log('D screenrecord 10 s', JSON.stringify(pk(await readings(page))))
adb('pull', '/sdcard/spike.mp4', '/private/tmp/claude-501/-Users-tyler-repos-engine-v2/221cb9fd-d757-476f-8f42-72af3362a61a/scratchpad/shots/spike.mp4'); sh('rm /sdcard/spike.mp4')
await browser.close()
