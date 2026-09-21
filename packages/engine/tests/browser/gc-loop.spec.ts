// `gc-loop`: one sim-role worker on fixture `hash`, no WebGPU (docs/plan/04-zero-gc-harness.md,
// Planning decisions "No WebGPU on this page"). `zeroGcSuite` reads its isolates from
// `budgets.json`'s `gc.pages.gc-loop` entry, so this file only names the page.
import { expect, test } from '@playwright/test'
import { flatAttachForThisWorker, measure } from './gc/instrument.ts'
import { attachTunnelSessions } from './gc/sessions.ts'
import { zeroGcSuite } from './gc/suite.ts'
import { openPage } from './support/page.ts'

zeroGcSuite({ pageId: 'gc-loop', path: '/gc-loop.html' })

// 0016's Consequences / PRE-PLAN.md risk 11: `Target.sendMessageToTarget` is deprecated; this proves
// `cdp-flat.ts`'s replacement reads the same bytes, so the day Chrome removes it the fix is flipping
// `instrument.ts`'s default transport, not writing a transport under a red suite (Planning decisions
// "CDP transport: both, behind one interface").
test('gc: flat transport parity', async ({ page, browser }) => {
  await openPage(page, '/gc-loop.html')
  const tunnel = await measure(page, browser, { pageId: 'gc-loop', attach: attachTunnelSessions })

  await openPage(page, '/gc-loop.html')
  const flat = await measure(page, browser, { pageId: 'gc-loop', attach: flatAttachForThisWorker })

  // Per-isolate, per-window attribution for both transports: a bare byte-total mismatch does not
  // say *why* two independent sessions differ, and re-deriving that by hand (temporarily patching
  // this file to dump `byFn`/`windowBytes`) cost a whole investigation round once already (gc-parity
  // defect-fix session, 2026-09-21). `windowByFn` in particular exists because a mismatch can come
  // from a one-off event landing in *both* measured windows at a different magnitude -- invisible in
  // `byFn` (only the chosen, lower window's sites) or `windowBytes` (totals only) alone; see
  // `instrument.ts`'s own doc comment on that field for the `scope.onmessage` case that motivated it.
  const detail = JSON.stringify({
    totalBytes: { tunnel: tunnel.totalBytes, flat: flat.totalBytes },
    windowBytes: { tunnel: tunnel.windowBytes, flat: flat.windowBytes },
    windowByFn: { tunnel: tunnel.windowByFn, flat: flat.windowByFn },
  })
  // `GC_PARITY_DEBUG=1`: the same detail on a *passing* run too, so a future session can diff a
  // green run against a red one instead of only ever seeing this when it is already failing.
  if (process.env.GC_PARITY_DEBUG) console.log(`gc parity detail: ${detail}`)

  expect(flat.totalBytes.sim, detail).toBe(tunnel.totalBytes.sim)
})
