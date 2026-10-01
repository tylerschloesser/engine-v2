// The two waits that tell a reload from a second tab (docs/plan/37-robustness-events.md, the M34b seam
// "F5 during startup gets `world-busy`"). Plain constants: `client.ts` (main thread) imports them, and
// it must not import anything under `worker/` (`main.no_wasm_instantiate`).

/** The ceiling on how long a starting sim worker waits for `world:<id>`, not the mechanism. A reload
 * starts the new document's worker while the old document's sim worker may still be alive; main wakes
 * it out of `Atomics.wait` on `pagehide` (`client.ts` `wakeOutOfWait`), so the browser ends it at once
 * and the lock goes with it (measured: without the wake about 2 s, with it a reload test is 0.75 s). */
export const WORLD_LOCK_WAIT_MS = 3000

/** How long main waits for the world-owner lock (`world-owner:<id>`, held by a document's main thread
 * for as long as its client lives). A main thread's locks are released when its document is gone, so a
 * held one means a live second tab: the start is refused at once (`lockWaitMs: 0`) instead of after
 * `WORLD_LOCK_WAIT_MS`. The wait only covers the document teardown race of a reload. */
export const WORLD_OWNER_WAIT_MS = 300
