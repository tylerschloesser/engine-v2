// `pnpm setup:tools`'s Playwright-browsers row (docs/plan/03-browser-harness.md, Scope: "the
// Playwright browsers as a TOOLS row"). `playwright install --dry-run` always describes the full
// plan, installed or not (measured), so it cannot say what is missing; `playwright install --list`
// can: it prints one block per Playwright version found in the global cache, each with the browser
// directories under it. Prints the pinned version (`setup-tools.mjs`'s `match` then equals it) when
// that version's block names all three engines; prints nothing otherwise.
import { spawnSync } from 'node:child_process'

const PIN = '1.63.0' // docs/decisions/0017 §10; kept in step with TOOLS' entry below
const ENGINES = ['chromium-', 'firefox-', 'webkit-']

export function probe(pin = PIN, run = spawnSync) {
  const result = run('pnpm', ['exec', 'playwright', 'install', '--list'], { encoding: 'utf8' })
  if (result.status !== 0) return null
  const blocks = result.stdout.split(/(?=^Playwright version: )/m)
  const block = blocks.find((b) => b.startsWith(`Playwright version: ${pin}\n`))
  if (!block) return null
  return ENGINES.every((engine) => block.includes(engine)) ? pin : null
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const found = probe()
  if (found) console.log(found)
}
