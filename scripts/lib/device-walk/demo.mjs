// The end-to-end demonstration of the auto runner (M39f step 15), one command:
//   node scripts/lib/device-walk/demo.mjs [--only <id-prefix,...>] [--engine webkit|chromium] [--round <name>]
//        [--base-port <n>] [--timeout <s>]
// It copies device-checks.md to a scratch directory and drives the REAL command line against that copy:
//   `pnpm device:walk --auto` (loopback, no tunnel, `--no-build`: build the fixture app and both reference
//   builds first) with a Playwright WebKit page in iPhone emulation as the phone (`fake-phone.mjs` and
//   `fake-person.mjs`: no human input), the Mac's Safari and Firefox tabs as Playwright pages
//   (`DEVICE_WALK_OPEN`, `fake-mac-open.mjs`), the M34 bot partner started by the service;
//   `--wait` (a second process) until the round is done; `--status --json`; `--apply --dry-run`; `--apply`;
//   then `acceptance:check` against the applied scratch copy. Prints the counts. Short timings (a test, not
//   a phone): windows of 12 s, the memory probe 4 s, absences of 1.5 s, the 1/64 large save.
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, devices, webkit } from '@playwright/test'
import { readDeviceChecks } from '../../acceptance-check.mjs'
import { keepDevices, personHandlers } from './fake-person.mjs'
import { walkAsPhone } from './fake-phone.mjs'

const REPO = fileURLToPath(new URL('../../..', import.meta.url))
const arg = (name, d) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : d
}
const only = arg('--only', '')
// `webkit` is Playwright's iPhone 15 emulation, which has no mouse wheel (the M11 pinch): the whole set runs on
// `chromium`; the short set of the brief's first criterion runs on both.
const engine = arg('--engine', 'chromium')
const round = arg('--round', 'demo')
const base = arg('--base-port', '14900')
const timeoutS = Number(arg('--timeout', '2400'))

// `--scratch <dir>` keeps one scratch copy across several runs (a run per slice of the set, each its own round
// name, all applied to the same copy): `--apply` is per round, the **Run on** lines accumulate.
const scratchArg = arg('--scratch', '')
const dir = scratchArg || mkdtempSync(join(tmpdir(), 'device-walk-demo-'))
const checks = join(dir, 'device-checks.md')
mkdirSync(join(dir, 'rounds'), { recursive: true })
if (!existsSync(checks)) copyFileSync(join(REPO, 'docs/plan/device-checks.md'), checks)
const common = [
  '--checks',
  checks,
  '--rounds-dir',
  join(dir, 'rounds'),
  '--series-dir',
  join(dir, 'series'),
]
const cli = (...a) =>
  spawnSync(process.execPath, [join(REPO, 'scripts/device-walk.mjs'), ...common, ...a], {
    encoding: 'utf8',
  })
const status = () => JSON.parse(cli('--status', round, '--json').stdout)

const params = {
  probeMs: 700,
  windowMs: 12_000,
  warmupMs: 4000,
  actTimeoutMs: 40_000,
  timeoutMs: 90_000,
  probeS: 4,
  leaveMs: 1500,
  playMs: 3000,
  runsEach: 1,
  scenarioMs: {
    'app-5s': 1500,
    'app-30s': 1500,
    'app-5min': 1500,
    'lock-60s': 1500,
    'airplane-15s': 1500,
  },
  panMs: 1500,
  observeMs: 2500,
  benchScale: 64,
  botTimeoutMs: 120_000,
  fadeMs: 12_000,
  settleMs: 500,
  graceMs: 60_000,
  botTimings: { walkMs: 12_000 },
}
const t0 = Date.now()
console.log(`demo: scratch ${dir}`)
const auto = spawn(
  process.execPath,
  [
    join(REPO, 'scripts/device-walk.mjs'),
    ...common,
    '--auto',
    '--round',
    round,
    ...(only ? ['--only', only] : []),
    '--no-tunnel',
    '--no-open',
    '--no-build',
    '--base-port',
    base,
    '--params',
    JSON.stringify(params),
  ],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DEVICE_WALK_OPEN: `node ${join(REPO, 'scripts/lib/device-walk/fake-mac-open.mjs')}`,
    },
  },
)
let log = ''
for (const s of [auto.stdout, auto.stderr]) s.on('data', (d) => (log += d))
const autoExit = new Promise((r) => auto.once('exit', (c) => r(c)))
let waitDone = false
let waitOut = ''
const bye = async (code) => {
  auto.kill('SIGTERM')
  await autoExit
  process.exit(code)
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => bye(130))

let st
for (let i = 0; i < 300 && !st?.joinUrl; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  try {
    st = status()
  } catch {}
}
if (!st?.joinUrl) {
  console.log(`demo: no join URL\n${log}`)
  await bye(1)
}
console.log(`demo: ${st.state}, join ${st.joinUrl}`)
const wait = spawn(
  process.execPath,
  [
    join(REPO, 'scripts/device-walk.mjs'),
    ...common,
    '--wait',
    round,
    '--timeout',
    String(timeoutS),
    '--json',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)
wait.stdout.on('data', (d) => (waitOut += d))
const waitExit = new Promise((r) => wait.once('exit', (c) => r(c)))
waitExit.then(() => (waitDone = true))

const browser = await (engine === 'chromium' ? chromium : webkit).launch(
  engine === 'chromium' ? { channel: 'chromium', args: ['--enable-unsafe-webgpu'] } : {},
)
const ctx = await browser.newContext(engine === 'webkit' ? { ...devices['iPhone 15'] } : {})
await keepDevices(ctx)
const page = await ctx.newPage()
page.on('pageerror', () => {})
const ticker = setInterval(() => {
  try {
    const s = status()
    console.log(
      `demo: ${Math.round((Date.now() - t0) / 1000)} s  ${s.recorded}/${s.total}  ${s.state}  ${s.current?.id ?? ''}`,
    )
  } catch {}
}, 30_000)
let seen
try {
  seen = await walkAsPhone(page, {
    runnerUrl: st.joinUrl,
    isDone: () => waitDone,
    timeoutMs: timeoutS * 1000,
    handlers: personHandlers({ page, joinUrl: st.joinUrl, panMs: params.panMs }),
  })
} catch (e) {
  console.log(`demo: the fake phone stopped: ${e.message}`)
  clearInterval(ticker)
  await browser.close().catch(() => {})
  wait.kill('SIGTERM')
  await bye(1)
}
clearInterval(ticker)
const waitCode = await waitExit
if (waitCode !== 0)
  console.log(
    `demo: the phone page at the end: ${page.url()}\n${JSON.stringify(
      await page
        .evaluate(() => ({
          text: document.body?.innerText?.slice(0, 200),
          link: window.__check?.readings().link,
          circles: window.__check?.readings().remote_circles,
          step: window.__walkAgent?.step?.phase,
        }))
        .catch((e) => String(e)),
    )}`,
  )
const autoCode = await Promise.race([
  autoExit,
  new Promise((r) => setTimeout(() => r('still running'), 30_000)),
])
await browser.close()
// A round that did not finish leaves the tool running: stop it (it stops its servers), never leave it behind.
if (autoCode === 'still running') {
  auto.kill('SIGTERM')
  await Promise.race([autoExit, new Promise((r) => setTimeout(r, 90_000))])
  if (auto.exitCode === null) auto.kill('SIGKILL')
}

const final = status()
console.log(
  `\ndemo: --wait exit ${waitCode}, --auto exit ${autoCode}, ${Math.round((Date.now() - t0) / 1000)} s`,
)
console.log(
  `demo: state ${final.state}; ${final.recorded}/${final.total} recorded; counts ${JSON.stringify(final.counts)}`,
)
const by = {}
for (const i of final.items)
  by[`${i.result ?? 'open'}/${i.by ?? '-'}`] = (by[`${i.result ?? 'open'}/${i.by ?? '-'}`] ?? 0) + 1
console.log(`demo: result/by ${JSON.stringify(by)}`)
for (const i of final.items.filter((x) => x.result !== 'pass'))
  console.log(
    `  ${i.result ?? 'open'}  [${i.by ?? '-'}] ${i.id}  ${String(i.notes ?? '').slice(0, 150)}`,
  )
console.log(
  `demo: fake phone judged ${seen?.judged}, rotated ${seen?.rotated}, redone ${seen?.redone}`,
)

const dry = cli('--apply', round, '--dry-run')
console.log(
  `\ndemo: --apply --dry-run (${dry.stdout.split('\n').filter((l) => /^(tick|UNTICK|write|update|add)/.test(l)).length} changes, nothing written)`,
)
console.log(
  dry.stdout
    .split('\n')
    .filter((l) => /^(tick|UNTICK)/.test(l))
    .join('\n'),
)
const before = readDeviceChecks(readFileSync(checks, 'utf8'))
const applied = cli('--apply', round)
const after = readDeviceChecks(readFileSync(checks, 'utf8'))
console.log(
  `demo: --apply exit ${applied.status}; ticked ${before.ticked.size} -> ${after.ticked.size} of ${after.all.size} items`,
)
const acc = (extra) =>
  spawnSync(process.execPath, [join(REPO, 'scripts/acceptance-check.mjs'), ...extra], {
    encoding: 'utf8',
    cwd: REPO,
  })
const real = acc([])
const scratch = acc(['--device-checks', checks])
const lines = (o) => o.stdout.split('\n').filter(Boolean)
const notTicked = (o) => lines(o).filter((l) => /is not ticked/.test(l))
console.log(
  `demo: acceptance:check on the repo as it is: ${notTicked(real).length} device citations not ticked`,
)
console.log(
  `demo: acceptance:check on the applied scratch copy: exit ${scratch.status}, ${notTicked(scratch).length} device citations not ticked, ${lines(scratch).length - notTicked(scratch).length} other lines`,
)
const ids = [
  ...new Set(notTicked(scratch).map((l) => /device check (\S+) is not ticked/.exec(l)?.[1])),
]
console.log(`demo: still not ticked (${ids.length} ids): ${ids.join(', ')}`)
process.exit(final.state === 'done' ? 0 : 1)
