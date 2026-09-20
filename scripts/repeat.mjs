// Repeat one suite N times for a reliability check at a milestone gate (orchestrator tool, PROMPT.md
// Rules). Each run gets its own process group and a hard kill timeout; `--load <n>` adds n CPU burners
// that exit on their own if this script dies. A Bash call is capped at 10 minutes: `browser` fits
// about 20 runs quiet, 15 under load.
//
// node scripts/repeat.mjs <suite> <runs> [--load <n>] [--timeout <seconds>]
import { spawn } from 'node:child_process'

const [suite, runsArg, ...rest] = process.argv.slice(2)
const opt = (name, d) => (rest.indexOf(name) < 0 ? d : Number(rest[rest.indexOf(name) + 1]))
const runs = Number(runsArg),
  load = opt('--load', 0),
  timeoutMs = opt('--timeout', 120) * 1000
const burner =
  'const p=process.ppid;(function s(){const t=Date.now();while(Date.now()-t<200);if(process.ppid!==p)process.exit();setImmediate(s)})()'
const burners = Array.from({ length: load }, () =>
  spawn(process.execPath, ['-e', burner], { stdio: 'ignore' }),
)
const stop = () => {
  for (const b of burners)
    try {
      b.kill('SIGKILL')
    } catch {}
}
process.on('exit', stop)
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => process.exit(130))
let pass = 0,
  fail = 0,
  hang = 0,
  slowest = 0
for (let i = 0; i < runs; i++) {
  await new Promise((done) => {
    const c = spawn('pnpm', ['test', suite], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    c.stdout.on('data', (d) => (out += d))
    c.stderr.on('data', (d) => (out += d))
    const t = setTimeout(() => {
      hang++
      try {
        process.kill(-c.pid, 'SIGKILL')
      } catch {}
    }, timeoutMs)
    c.on('close', (code) => {
      clearTimeout(t)
      const m = out.match(new RegExp(`${suite}\\s+(?:pass|FAIL)\\s+\\d+ tests\\s+([\\d.]+)s`))
      if (m) slowest = Math.max(slowest, Number(m[1]))
      if (code === 0) pass++
      else {
        fail++
        console.log(
          `run ${i + 1}:\n` +
            out
              .split('\n')
              .filter((l) => /FAIL|Error|expected/.test(l))
              .slice(0, 6)
              .join('\n'),
        )
      }
      done()
    })
  })
}
console.log(
  `${suite} x${runs} load=${load}: pass=${pass} fail=${fail} hang=${hang} slowestSuiteSeconds=${slowest}`,
)
process.exit(fail || hang ? 1 : 0) // explicit: the live burner children would otherwise keep this process open
