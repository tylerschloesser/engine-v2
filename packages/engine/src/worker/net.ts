// `net`-kind worker body (docs/plan/06b-workers-and-spawn.md, Scope: "event-driven idle shell, no
// WASM" until M29 gives it the `WebSocket` and a byte pump). docs/plan/29-net-worker-and-
// reference-server.md steps 1-2 (Scope): `createBytePump` (M27) + `createLink` (M28) +
// `wsConnection(url)` (this milestone) -- event-driven, uplink drained on a timer (0015 §2: "the
// net worker is event-driven ... and drains the uplink ring on a `setInterval`"; Deviations: a
// recursive `systemScheduler.setTimer` chain here, not a bare `setInterval` global -- `src/CLAUDE.md`'s
// "no ambient time outside `clock.ts`" rule still applies to this file, the same reason `server-
// node.ts`'s own `everyViaSetTimer` exists). It never
// enters `runBlockingLoop` (0015 §1: "a net worker `must receive socket events`, so it is never
// blocked in `Atomics.wait` the way the other kinds are"); `W_PARKED` is set once, immediately,
// since an event-driven worker is always reachable the way a parked one is.
//
// **It never parses a message** (Scope; this file's own exit criterion: no `DataView`, no import
// from the wire codec). Reconnect policy comes entirely from `CloseEvent.code` (`net/link.ts`'s own
// `DownReason` classification of `CloseCode`, M28); liveness comes from "any message on the current
// socket" (`createLink`'s own dead-timer reset on `onMessage`, not from reading what that message
// says). Bytes only ever move between the uplink/downlink SAB rings and a `Connection`
// (`createBytePump`) -- this file's own code never looks inside them.
import { systemClock, systemScheduler } from '../clock.js'
import { createLink, type DownReason, type Link } from '../net/link.js'
import { createBytePump } from '../net/pump.js'
import { wsConnection } from '../net/ws-connection.js'
import { CB_LINK_GEN, CB_LINK_STATE, W_PARKED, WORKER_CLIENT, workerWord } from '../sab/control.js'
import type { NetControlMessage, SetupMessage } from './protocol.js'
import type { LoopState, Shell } from './shell.js'

/** 0015 §2: "drains the uplink ring on a `setInterval`"; docs/decisions/0015-threads-memory-and-
 * topology.md, Planning decisions "Uplink poll period: 10 ms" (M06's own figure, reused here
 * verbatim -- Scope: "The uplink drain uses M06's poll period"). */
const UPLINK_DRAIN_MS = 10

/** `net/link.ts`'s own `LinkState.Down = 0`/`Up = 1`/`Stopped = 2` (numerically, not imported --
 * `sab/control.ts`'s own doc comment on `CB_LINK_STATE`: "not imported here, just numerically
 * identical by construction"). Only `Up`/`Down` are ever written: `Link.stop()` is never called in
 * production (the net worker's own `{ type: 'stop' }` handler below calls it only as this worker is
 * torn down, by which point nothing reads the control block again). */
const CB_LINK_STATE_DOWN = 0
const CB_LINK_STATE_UP = 1

/** No seed source is available here without breaking `.claude/rules` (no `Date.now()`/`crypto.*`
 * outside `clock.ts`/`src/client/secret.ts`, `no-ambient-random.test.ts`'s own allowlist): a fixed
 * constant, same as every other production seed this repo hard-codes at a call site with no
 * randomness to draw from (Deviations). `createLink`'s own jitter exists to avoid every client's
 * backoff attempts landing on the exact same schedule instant during a shared outage; per-tab
 * decorrelation across *many simultaneous real users* is a real concern this single fixed seed does
 * not solve (every tab jitters identically) -- accepted for this cut, revisit if a real device
 * check or step 4's browser reconnect tests ever show simultaneous-client thundering-herd load
 * actually mattering in practice. */
const LINK_JITTER_SEED = 0x2c1c2fb1

/**
 * `null`: net has no blocking loop (event-driven, must receive socket events, 0015 §2). A worker
 * spawned with no `SetupMessage.net` (never true in production -- `client.ts`'s `start()` always
 * sets it for a `net`-kind spawn, since that only ever happens for a `{ kind: 'remote' }` topology)
 * stays the pre-M29 idle shell, for a hand-built test page that spawns a bare `net` worker with
 * nothing to dial.
 */
export function setup(shell: Shell, message: SetupMessage): Promise<LoopState | null> {
  const net = message.net
  if (!net) {
    Atomics.store(shell.control.words, workerWord(shell.index, W_PARKED), 1)
    return Promise.resolve(null)
  }

  const pump = createBytePump({ uplink: message.sabs.uplink, downlink: message.sabs.downlink })
  // Narrowed out of the closure below (Deviations): TS does not carry a `const`'s own narrowing
  // into a function *declaration*'s body (unlike an immediately-evaluated expression), since that
  // body could in principle run at any later point.
  const dialUrl = net.url

  // A fresh `Link` (`net/link.ts`), (re)built on demand: `createLink` stops *for good* on a
  // terminal `DownReason` (`Superseded`/`BadKey`/`Full`/`VersionMismatch`, its own doc comment),
  // and `Link.probe()` is a no-op once `stopped` -- so main's own `{ type: 'retry' }` (Scope: the
  // `updating` state's own backoff retry after a version-mismatch reload attempt finds the same
  // build hash) has to build an entirely new `Link`, not merely re-probe the dead one. `buildLink`
  // is that one factory, called once at setup and again by `linkControl`'s own `retry` branch below
  // (Deviations: not itself a pinned Seam -- the two message names, `probe`/`retry`, are the only
  // thing this milestone's own Scope actually pins).
  function buildLink(): Link {
    return createLink({
      dial: () => wsConnection(dialUrl),
      clock: systemClock,
      scheduler: systemScheduler,
      seed: LINK_JITTER_SEED,
      onUp(conn, gen) {
        pump.attach(conn)
        Atomics.store(shell.control.words, CB_LINK_STATE, CB_LINK_STATE_UP)
        Atomics.store(shell.control.words, CB_LINK_GEN, gen)
        // The client worker's own `worker/client-net.ts` reads these two words to decide when it
        // is safe to send `client_hello()` for the first time (`SetupMessage.remoteLinked`) -- it
        // must actually wake to notice the new value, since it may already be parked in
        // `Atomics.wait`.
        shell.control.wake(WORKER_CLIENT)
        shell.post({ type: 'link', state: 'up' })
      },
      onDown(why: DownReason, code?: number) {
        pump.detach()
        Atomics.store(shell.control.words, CB_LINK_STATE, CB_LINK_STATE_DOWN)
        shell.control.wake(WORKER_CLIENT)
        shell.post(
          code === undefined
            ? { type: 'link', state: 'down', reason: why }
            : { type: 'link', state: 'down', reason: why, code },
        )
      },
    })
  }

  let link: Link = buildLink()

  // Event-driven: reachable the instant it is spawned, the same "already quiescent" contract a
  // parked blocking-loop worker offers (`worker/shell.ts`'s own `W_PARKED` doc comment) -- this
  // kind never leaves the event loop in the first place, so there is nothing to leave.
  Atomics.store(shell.control.words, workerWord(shell.index, W_PARKED), 1)

  // 0015 §2 "drains the uplink ring on a `setInterval`" and "a timer loop measured 0 B": `src/
  // CLAUDE.md`'s "no ambient time outside `clock.ts`" rule still applies to this file (`net.ts` is
  // not `clock.ts`), so this is `systemScheduler.setTimer` re-armed on every fire -- the exact
  // recursive-`setTimer` shape `server-node.ts`'s own `everyViaSetTimer` already uses for the same
  // "no `setInterval`" reason, not a bare global.
  let drainTimerId: number | null = null
  function armDrainTimer(): void {
    drainTimerId = systemScheduler.setTimer(() => {
      pump.drain()
      armDrainTimer()
    }, UPLINK_DRAIN_MS)
  }
  armDrainTimer()

  return Promise.resolve({
    // No `body`/`timeoutMs`: this kind never enters `runBlockingLoop` (`worker.ts`'s own doc
    // comment on the `loop?.body` check).
    linkControl(m: NetControlMessage) {
      // Scope: "main -> net `{ type: 'probe' }` on `visibilitychange -> visible` and `online`, and
      // `{ type: 'retry' }`". `probe` is `Link.probe()` verbatim (`net/link.ts`'s own doc comment:
      // "a no-op on a link that has heard from its current connection ... otherwise redials
      // immediately") -- a no-op if this link already stopped for good (Deviations, above: main
      // itself never sends `probe` after a terminal reason, only `retry`). `retry` rebuilds the
      // link from scratch first (`buildLink`'s own doc comment), since the previous one -- if it
      // stopped on a terminal reason -- can never dial again on its own.
      if (m.type === 'retry') {
        link.stop() // idempotent if already stopped; never leaves two live links dialing at once
        link = buildLink()
        return
      }
      link.probe()
    },
    stop() {
      if (drainTimerId !== null) systemScheduler.clearTimer(drainTimerId)
      link.stop()
    },
  })
}
