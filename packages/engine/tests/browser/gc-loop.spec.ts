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

  expect(
    flat.totalBytes.sim,
    JSON.stringify({ tunnel: tunnel.totalBytes, flat: flat.totalBytes }),
  ).toBe(tunnel.totalBytes.sim)
})
