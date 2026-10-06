import { rawCdp, sh, sleep } from './lib.mjs'
const c = await rawCdp()
const rd = async () => JSON.parse(await c.evaluate(`JSON.stringify({vis: document.visibilityState, frames: window.__check.readings().frames, online: navigator.onLine})`))
const run = (cmd) => { try { return sh(cmd).replace(/\n/g, ' ').slice(0, 160) } catch (e) { return 'FAILED: ' + String(e.stderr ?? e).slice(0, 150) } }
const fps = async (s = 3) => { const a = (await rd()).frames; await sleep(s * 1000); return (((await rd()).frames - a) / s).toFixed(1) + ' fps' }
console.log('state', JSON.stringify(await rd()))
// screen off/on with swipe-to-dismiss
run('input keyevent KEYCODE_SLEEP'); await sleep(2500); console.log('screen off ->', JSON.stringify(await rd()))
run('input keyevent KEYCODE_WAKEUP'); await sleep(1500); run('input swipe 540 2000 540 600 150'); await sleep(2000)
console.log('wake + swipe-up ->', JSON.stringify(await rd()), run('dumpsys window | grep isKeyguardShowing | head -1'), 'fps', await fps(2))
// airplane with page visible
console.log('airplane ON:', run('cmd connectivity airplane-mode enable'), await (async () => { await sleep(5000); return JSON.stringify(await rd()) })(), run('settings get global airplane_mode_on'))
console.log('airplane OFF:', run('cmd connectivity airplane-mode disable'), await (async () => { await sleep(6000); return JSON.stringify(await rd()) })(), run('settings get global airplane_mode_on'))
// battery saver for real: fake unplug, then low_power
console.log('dumpsys battery unplug:', run('dumpsys battery unplug'))
console.log('low_power 1:', run('settings put global low_power 1')); await sleep(4000)
console.log('saver state', run('dumpsys power | grep -E "Battery Saver is currently"'), '| fps', await fps(4))
console.log('low_power 0:', run('settings put global low_power 0')); await sleep(3000)
console.log('cmd power set-mode 1 (LOW_POWER):', run('cmd power set-mode 1 2>&1')); await sleep(3000)
console.log('saver state', run('dumpsys power | grep -E "Battery Saver is currently"'), '| fps', await fps(4))
console.log('cmd power set-mode 0:', run('cmd power set-mode 0 2>&1')); console.log('battery reset:', run('dumpsys battery reset')); await sleep(2500)
console.log('final', run('settings get global low_power'), run('dumpsys power | grep -E "Battery Saver is currently"'), run('dumpsys battery | grep -E "USB powered|AC powered|level"'))
c.close()
