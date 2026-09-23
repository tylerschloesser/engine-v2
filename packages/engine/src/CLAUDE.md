# packages/engine/src

Package-level layout, commands and conventions: `../CLAUDE.md`.

- **A per-frame/per-tick path reads a `Clock` through `clock.ts`'s `createResyncingClock`, never a
  bare `clock.now()` every call** (M15d, docs/plan/15d-client-clock-allocation.md): `clock.now()`
  boxes a fresh `HeapNumber` on every read, not only in the interpreter tier as 0030 assumed.
  `frame-loop.ts`'s `tick()` and `test/client.ts`'s `stepFrame` both use it.
- `server.ts` (docs/plan/13-sim-host-tick-loop.md, docs/plan/
  15b-ring-connection-and-replica-rendering.md): the sim host is one module for the sim worker
  and a server (docs/decisions/0015 "Server" row) -- never import `node:` or DOM here. `worker/
  sim.ts` (the sim worker kind, paced by `worker/atomics-timer.ts`'s `AtomicsTimer` on top of
  `runBlockingLoop`) and a future `createWorldServer` (M27) both drive a `SimHost` through
  `createSimHostFromInstance`; only `Connection`, `Storage`, the clock and the timer differ between
  them. `SimHost.accept(connection)` (M15b) allocates the next free `ConnId` (`< MAX_CONNS = 8`,
  `host::MAX_CONNS`'s own mirror), wires `connection.onMessage`/`onClose` to `sim_admit`/
  `sim_disconnect`, and the tick procedure then calls `sim_build_frame`/`connection.send` for every
  accepted connection automatically, every tick. `sim-config.ts` holds the three pure pieces
  (`WorldConfig`, `seedToHexU64`, `buildSimInstanceConfig`) that `server.ts` re-exports unchanged:
  split out so `client.ts` (main thread) can build the sim worker's own config without transitively
  importing `loader.ts` (`main.no_wasm_instantiate`).
- `ring-connection.ts` (M15b): `RingConnection`, the sim role's own 0009 `Connection` over a SAB
  ring pair (`downlink`: `RingProducer`, woken toward the client worker; `uplink`: `RingConsumer`,
  drained by `drainUplink()`). **Copy discipline for ring ↔ region transfers**: every direction
  copies a *whole fixed-size buffer* with `.set()`, never `subarray()`/`new Uint8Array(...)` on the
  per-message/per-tick path (`.claude/rules/hot-paths.md`) -- `sim_admit`'s caller
  (`wrapEngineInstance.simAdmit`, `server.ts`) copies the *whole* preallocated receive buffer into
  the `Rx` region with `.set()` and passes the real length as a separate number to `sim_admit(conn,
  len)`, since the Rust side only ever reads the first `len` bytes regardless of what stale bytes
  follow; `RingConnection.onMessage` hands the same preallocated receive buffer every call, with the
  real length on `lastMessageLength` (a side channel, since 0009's `Connection.onMessage(bytes)`
  takes one argument and a per-message `subarray()` would violate the same rule). `wrapEngineInstance
  .simBuildFrame`/`simSealFrame` (`server.ts`) follow the same shape on the way out: `.bytes` is the
  whole persistent `Tx`/`Persist` region view, never `region.u8.subarray(0, raw)` (fixed at the
  steps 4-6 gate, Orchestrator ruling 2 -- both branches are live every real tick once a connection
  exists), with `.len` carrying the real count. `RingConnection.send(cls, bytes, len?)` takes that
  same real length as an optional third parameter beyond 0009's own fixed `(cls, bytes)` shape
  (defaulting to `bytes.length` for a caller that already hands a correctly-sized view, e.g. every
  unit test here); `server.ts`'s `runOneTick` passes `frame.len` through it via the same
  optional-property cast pattern `pumpRetries`/`lastMessageLength` already use.
- `worker/sim.ts` (M15b): creates and `SimHost.accept()`s one `RingConnection` at startup only when
  `message.link === true` (Orchestrator ruling 1, a topology fact on the setup message both `sim`
  and `client` get, from `client.ts`'s `host: { kind: 'local', connect: true }`; no existing
  `sim`-kind test page sets it, so `puts_idle_100` keeps its zero-connection topology by
  construction). `body()` drains the uplink ring every wake, before `CB_SIM_STEP_REQ`. ADR 0030's
  `poll()` guard (`wokenBy === lastWokenBy`) is live here (a linked client's uplink push wakes this
  worker); `poll_skips_a_spurious_tick_on_a_ring_wake` fails if it is removed. The other branch
  calls `atomicsTimer.interrupt()` ([0032](../../../docs/decisions/0032-atomics-timer-bounds-external-wakes.md)):
  ring wakes add no tick and cannot starve the timer (`sim_ticks_steadily_under_external_wakes`).
- `worker/client-net.ts` (M15b): the client's net pump, built only when linked, run from `body()`
  *before* `uploadPump.pump()` (`on_frame`'s own dirty-chunk enqueue stages the same wake it
  arrives, not one wake later). Drains the downlink ring straight into `on_frame(len)` (`RegionId.
  Downlink`, no intermediate buffer), then polls `client_poll_uplink` and pushes its `Tx`-region
  output onto the uplink ring (`RingProducer`'s own `wake` option notifies `WORKER_HOST`).
- ABI (`ABI_VERSION` 9 -> 10, `abi.ts`): `on_frame(len) -> status`, `client_poll_uplink(t_ms) ->
  len` (client role); `RegionId.Downlink` (10) is the inbound host-frame buffer, distinct from `Rx`
  (input, M11) -- the client's own `Tx` (unclaimed before) carries the uplink output. Test-only:
  `sim_region_hash`/`client_region_hash`/`sim_conn_counters`, reached by name through `callParked`
  -- `engine/test`'s `hostRegionHash`/`replicaHash`/`netCounters` (`test/client.ts`).
- Ring records (M16): `actionRing` `[seq u32 LE][len u32 LE][UTF-8 JSON]`; `uiRing` `[kind u8][len u32 LE][JSON]` (kind `2` action result, `1` M16b's `Ui`), unknown kind skipped by `len`.
