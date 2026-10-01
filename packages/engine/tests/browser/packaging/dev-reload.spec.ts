// `dev-reload-keeps-world @slow` (docs/plan/37-robustness-events.md, Planning decisions "Snapshot ->
// reload -> restore on Rust edit"; closes the "keep the world across a Rust edit" question of 0017).
//
// Persistence already is the mechanism: a Rust edit changes the build hash, Vite full-reloads the page,
// and the reloaded single-player world takes 0005 "Upgrades" (latest snapshot, log tail re-executed
// under the new code). The proof is the real thing: the plugin's dev server (`vite dev`) on a temp copy
// of the scratch game (`createScratchApp`, `link:` install, never a tracked file), a persisted local
// world in a real browser, three `Ping`s, `exportWorld()` as the clean boundary, one line of the game
// crate edited, and the page that comes back after Vite's `full-reload`.
//
// The edit is a constant the client's `Ui` reports (`BUILD` 1 -> 2): it changes the module bytes and so
// the build hash, not the state layout. Every wait has a bound that fails, never hangs. The rebuild is
// not timed against the compile budget (0049): a reference `sim` edit measures about 17 s, this crate
// less once its dependencies are built.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { createScratchApp } from '../../support/scratch-app.js'

type PingUi = { pings: number; tick: number; build: number }
type W = {
  __pageReady?: boolean
  __startError?: string
  __ui?: () => PingUi | undefined
  __ping?: () => void
  __export?: () => Promise<number>
  __mark?: number
}

/** The scratch crate with a `Ui` the page can read: pings, authoritative tick, `BUILD`. */
function withUi(source: string): string {
  const patched = source
    .replace('type Ui = ();', 'type Ui = PingUi;')
    .replace('type Client = ();', 'type Client = PingClient;')
    .replace(
      'use engine::game::{',
      'use engine::client::{ClientSide, FrameCx, FrameView};\nuse engine::game::{',
    )
  expect(patched).not.toBe(source)
  return `${patched}
/// Edited by the test: a Rust change that moves the module bytes and no state layout.
const BUILD: u32 = 1;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, TS)]
pub struct PingUi {
    pub pings: u32,
    pub tick: u32,
    pub build: u32,
}

#[derive(Default)]
pub struct PingClient;

impl ClientSide<Scratch> for PingClient {
    fn frame(&mut self, cx: &mut FrameCx<'_, Scratch>, _presence: &mut ()) {
        cx.ui_dirty();
    }

    fn ui(&self, view: &FrameView<'_, Scratch>, out: &mut PingUi) {
        out.pings = view.world().global().pings;
        out.tick = view.clocks().authoritative.0;
        out.build = BUILD;
    }
}
`
}

const ui = (page: Page) => page.evaluate(() => (window as unknown as W).__ui?.())

// A cold dependency build is the first run's cost; every wait below has its own, shorter bound.
test.setTimeout(600_000)

test('dev-reload-keeps-world @slow', async ({ page }) => {
  const app = await createScratchApp({ pattern: 'A', install: 'link' })
  const lib = join(app.dir, 'sim/src/lib.rs')
  await writeFile(lib, withUi(await readFile(lib, 'utf8')))
  const dev = await app.dev()
  const problems: string[] = []
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  try {
    // First load. Vite's first dev load may re-optimise dependencies and reload once: wait for a page
    // that is ready and has drawn its first Ui (the evaluate throws while a context is replaced).
    await page.goto(`${dev.url}/persist.html`)
    await page.waitForFunction(
      () => {
        const w = window as unknown as W
        return w.__pageReady === true && w.__ui?.() !== undefined
      },
      undefined,
      { timeout: 120_000, polling: 100 },
    )
    expect(await page.evaluate(() => (window as unknown as W).__startError)).toBeUndefined()
    const first = await ui(page)
    expect(first, 'first load: a fresh world, the original build').toMatchObject({
      pings: 0,
      build: 1,
    })

    // Three admitted actions, each seen in the replica; the tick at which the last one showed is a
    // floor for the reloaded world (the log holds it).
    for (let n = 1; n <= 3; n++) {
      await page.evaluate(() => (window as unknown as W).__ping?.())
      await page.waitForFunction((want) => (window as unknown as W).__ui?.()?.pings === want, n, {
        timeout: 30_000,
        polling: 50,
      })
    }
    const atPings = await ui(page)
    expect(atPings?.pings).toBe(3)
    await page.evaluate(() => (window as unknown as W).__export?.()) // on disk
    await page.evaluate(() => {
      ;(window as unknown as W).__mark = 1
    })

    // The edit: `BUILD` 1 -> 2. The page must be replaced (the mark goes) by a ready one.
    await writeFile(
      lib,
      (await readFile(lib, 'utf8')).replace('BUILD: u32 = 1;', 'BUILD: u32 = 2;'),
    )
    await page.waitForFunction(
      () => {
        const w = window as unknown as W
        return w.__mark === undefined && w.__pageReady === true && w.__ui?.() !== undefined
      },
      undefined,
      { timeout: 240_000, polling: 200 },
    )

    expect(await page.evaluate(() => (window as unknown as W).__startError)).toBeUndefined()
    const after = await ui(page)
    expect(after?.build, 'the page runs the edited crate').toBe(2)
    expect(after?.pings, 'the actions admitted before the edit are in the world').toBe(3)
    expect(after?.tick, 'the tick did not go backwards').toBeGreaterThanOrEqual(atPings?.tick ?? 0)
    expect(problems).toEqual([])
  } finally {
    await dev.stop()
  }
})
