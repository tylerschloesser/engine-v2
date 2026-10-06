// Device-state toggles with RAW CDP (no Playwright emulation of focus/visibility in the way).
import { rawCdp, sh, sleep } from './lib.mjs'
const c = await rawCdp()
await c.evaluate(`window.__vis = window.__vis || (document.addEventListener('visibilitychange', () => window.__vis.push([document.visibilityState, Math.round(performance.now())])), []); 0`)
const rd = async () => { try { return JSON.parse(await c.evaluate(`JSON.stringify({vis: document.visibilityState, focus: document.hasFocus(), frames: window.__check.readings().frames})`)) } catch (e) { return { err: String(e).slice(0, 80) } } }
const log = async (l) => console.log(l.padEnd(10), JSON.stringify(await rd()))
const run = (cmd) => { try { return sh(cmd).replace(/\n/g, ' ').slice(0, 140) } catch (e) { return 'FAILED: ' + String(e.stderr ?? e).slice(0, 150) } }
const step = async (l, cmd, wait = 3000) => { const t = Date.now(); const out = run(cmd); await sleep(wait); console.log(`${l} -> \`${cmd}\` ${out ? '[' + out + ']' : ''} (${Date.now() - t}ms)`); await log('  after') }
const fps = async (s = 3) => { const a = (await rd()).frames; await sleep(s * 1000); const b = (await rd()).frames; return ((b - a) / s).toFixed(1) + ' fps' }
await sleep(1500); await log('baseline'); console.log('  fps', await fps())
await step('battery saver ON', 'settings put global low_power 1', 4000)
console.log('  low_power', run('settings get global low_power'), '| cmd power:', run('cmd power get-battery-saver-state 2>&1 | head -2'), '| dumpsys:', run('dumpsys power | grep -iE "mLowPowerModeEnabled|Battery Saver" | head -2'))
console.log('  fps under saver', await fps())
await step('battery saver OFF', 'settings put global low_power 0', 4000); console.log('  fps', await fps())
await step('HOME key', 'input keyevent KEYCODE_HOME', 3000)
const h = (await rd()).frames; await sleep(3000); console.log('  frames advanced while hidden 3 s:', (await rd()).frames - h)
await step('Chrome to front', 'am start -n com.android.chrome/com.google.android.apps.chrome.Main', 3500); console.log('  fps', await fps(2))
console.log('  visibility log', await c.evaluate('JSON.stringify(window.__vis)'))
await step('screen OFF', 'input keyevent KEYCODE_SLEEP', 3000); console.log('  ', run('dumpsys power | grep mWakefulness='))
await step('screen ON', 'input keyevent KEYCODE_WAKEUP', 2000); console.log('  ', run('dumpsys power | grep mWakefulness='), run('dumpsys window | grep isKeyguardShowing | head -1'))
await step('dismiss keyguard', 'wm dismiss-keyguard', 2500); console.log('  ', run('dumpsys window | grep isKeyguardShowing | head -1'))
console.log('  fps', await fps(2)); console.log('  visibility log', await c.evaluate('JSON.stringify(window.__vis)'))
await step('airplane ON', 'cmd connectivity airplane-mode enable', 5000); console.log('  airplane_mode_on', run('settings get global airplane_mode_on'), '| navigator.onLine:', await c.evaluate('navigator.onLine'), '| CDP over USB still alive')
await step('airplane OFF', 'cmd connectivity airplane-mode disable', 5000); console.log('  airplane_mode_on', run('settings get global airplane_mode_on'), '| navigator.onLine:', await c.evaluate('navigator.onLine'))
console.log('  document still the same:', await c.evaluate('typeof window.__check + " vis events=" + window.__vis.length'))
c.close()
