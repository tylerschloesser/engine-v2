// A whole auto round with a fake phone, for the demonstrations (M39f): servers (`device-serve --walk
// --no-build`, so build the fixture app first), the phone API and step machine, then a Playwright page
// that walks the round like Tyler would.
//   node scripts/lib/device-walk/fake-phone-run.mjs <id,id,...> [chromium|webkit|webkit-desktop] [log.jsonl] [basePort]
// `webkit` is Playwright's iPhone 15 emulation. Short windows (3 s) and a short memory probe (4 s) keep
// it quick; the round log lands in `log.jsonl`, the raw series beside it. `KILL=1` reloads the page once
// the memory probe is in its second session (the tab-kill case).
import { readFileSync, rmSync } from 'node:fs'
import { chromium, devices, webkit } from '@playwright/test'
import { startAutoRound } from './auto-cli.mjs'
import { walkAsPhone } from './fake-phone.mjs'
import { parseChecks } from './parse.mjs'
import { readEvents } from './rounds.mjs'
import { spawnServe } from './spawn-serve.mjs'

const [, , ids, engine = 'chromium', file = '/tmp/demo.jsonl', port = '14900'] = process.argv
rmSync(file, { force: true })
const idl = ids.split(',')
const items = parseChecks(
  readFileSync(new URL('../../../docs/plan/device-checks.md', import.meta.url), 'utf8'),
).items.filter((i) => idl.includes(i.id))
const r = await startAutoRound({
  round: 'demo',
  file,
  seriesDir: file.replace('.jsonl', '-series'),
  items,
  only: idl,
  tunnel: false,
  basePort: +port,
  wsBasePort: +port + 1,
  log: () => {},
  params: { probeMs: 700, windowMs: 3000, warmupMs: 0, actTimeoutMs: 20000, probeS: 4 },
  spawnServe: (a, io) => spawnServe([...a, '--no-build'], io),
})
const b = await (engine.startsWith('webkit') ? webkit : chromium).launch(
  engine === 'chromium' ? { channel: 'chromium', args: ['--enable-unsafe-webgpu'] } : {},
)
const ctx = await b.newContext(
  engine === 'webkit'
    ? { ...devices['iPhone 15'] }
    : engine === 'webkit-desktop'
      ? { ...devices['Desktop Safari'] }
      : {},
)
const page = await ctx.newPage()
page.on('console', (m) => {
  if (m.type() === 'error') console.log('PAGE ERR', m.text().slice(0, 200))
})
page.on('pageerror', (e) => console.log('PAGEERR', String(e).slice(0, 200)))
const t = setInterval(
  () =>
    console.log(
      readEvents(file)
        .slice(-1)
        .map((e) => e.type + ' ' + (e.id ?? '') + (e.phase ?? '') + (e.status ?? ''))[0],
    ),
  5000,
)
if (process.env.KILL)
  setTimeout(async () => {
    await page.waitForFunction(
      () => window.__check?.readings().steps?.some((l) => l.startsWith('(2) touch=0:')),
      undefined,
      { timeout: 60000, polling: 200 },
    )
    console.log('RELOAD')
    await page.reload()
  }, 1000)
try {
  console.log(
    await walkAsPhone(page, {
      runnerUrl: r.joinUrl,
      isDone: () => r.machine.done(),
      timeoutMs: 120000,
    }),
  )
} catch (e) {
  console.log('ERR', e.message)
  console.log(await page.url())
}
clearInterval(t)
await b.close()
await r.stop()
console.log(
  readEvents(file)
    .filter((e) => e.type === 'result')
    .map((e) => [e.id, e.result, e.by]),
)
