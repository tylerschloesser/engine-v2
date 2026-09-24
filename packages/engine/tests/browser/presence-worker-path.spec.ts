// `presence-worker-path`: single-player page (`fx-presence`, real `SimHost.accept`ed connection),
// no renderer (docs/plan/19-presence-channel.md step 6, Tests added). `PresenceClient::frame`
// writes a changing sample every client frame (`fixtures/presence/src/lib.rs`); this test proves
// it reaches the sim worker's own `PresenceTable` (`uplinkPresenceBytes` > 0, bumped only on the
// accepted-sample path, `ConnCounters::presence_bytes_up`'s own doc comment), stays within the
// `counters.presence.uplinkBytesPerSec` budget, and drops nothing on either ring.
//
// Inject-fail-revert (stop the worker from reading the uplink field): in `ClientCore::
// presence_due` (`crates/engine/src/client/core.rs`), forced the return value to always `false`
// (the client worker never attaches a presence sample to any uplink batch) -- this test failed
// with "the sample must have reached the sim worker's table" (`Received: 0`, `Expected: > 0`);
// reverted.
import { expect, test } from '@playwright/test'
import type { NetCounters } from '../../src/test/client.js'
import { expectWithinBudget } from '../support/budgets.js'
import { openPage } from './support/page.js'

declare global {
  interface Window {
    __run?: (frames: number) => Promise<NetCounters>
  }
}

test('presence-worker-path', async ({ page }) => {
  await openPage(page, '/presence-worker-path.html')

  // 60 frames at 60 fps = ~1 s of manual-clock time, ticking the sim every 3rd frame (~20 Hz) --
  // the same one-second window `sampler_rate_and_on_change` (native) measures against.
  const counters = await page.evaluate(() => window.__run?.(60))
  if (!counters) throw new Error('presence-worker-path: __run did not return counters')

  expect(
    counters.uplinkPresenceBytes,
    "the sample must have reached the sim worker's table",
  ).toBeGreaterThan(0)
  expectWithinBudget('counters.presence.uplinkBytesPerSec', counters.uplinkPresenceBytes)
  expect(counters.uplink.drops).toBe(0)
  expect(counters.downlink.drops).toBe(0)
})
