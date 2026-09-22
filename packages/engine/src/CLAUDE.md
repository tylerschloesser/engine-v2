# packages/engine/src

Package-level layout, commands and conventions: `../CLAUDE.md`.

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
- `worker/sim.ts` (M15b steps 4-6): creates and `SimHost.accept()`s one `RingConnection` at startup
  only when `message.link === true` (Orchestrator ruling 1 -- a topology fact carried on the setup
  message both `sim` and `client` receive identically, `client.ts`'s `host: { kind: 'local',
  connect: true }`; every existing `sim`-kind test page never sets it, so it keeps `puts_idle_100`'s
  zero-connection topology by construction). `body()` drains the uplink ring unconditionally every
  wake, before checking `CB_SIM_STEP_REQ`. ADR 0030's `AtomicsTimer.poll()` fix (the `wokenBy ===
  lastWokenBy` guard) is live here: a linked client's own uplink push is the first thing that ever
  wakes this worker from outside its own pacing timer, and `connected-paced.spec.ts`'s
  `poll_skips_a_spurious_tick_on_a_ring_wake` fails if that guard is ever removed (verified by fault
  injection at the steps 4-6 gate: replacing it with an unconditional `true` measured a real,
  reproducible ~2x inflation in `ticksRun` over a fixed real-time window).
- `worker/client-net.ts` (M15b step 4): the client worker's net pump, built only when linked. Drains
  the downlink ring straight into WASM linear memory (`on_frame(len)`, one call per message, over
  `RegionId.Downlink`'s own preallocated view -- no intermediate buffer, since `popInto`'s own return
  value already is the real length), then polls `client_poll_uplink` once per wake and pushes
  whatever landed in the client's own `Tx` region onto the uplink ring (`RingProducer`'s own `wake`
  option notifies `WORKER_HOST` on every successful push). `worker/client.ts`'s `body()` runs it
  *before* `uploadPump.pump()`: `on_frame` enqueues a newly dirty chunk into `Uploader`'s own pending
  queues, and this order stages it onto the upload ring the same wake it arrived, not one wake later.
- ABI additions (M15b, `ABI_VERSION` 9 -> 10): `on_frame(len) -> status` and `client_poll_uplink
  (t_ms) -> len` (client role; the real export list, `abi.ts`); `RegionId.Downlink` (10) is the
  client's own inbound host-frame buffer, distinct from `Rx` (input records, M11) -- the client's
  `Tx` region (unclaimed by that role until now) carries `client_poll_uplink`'s output. Test-only:
  `sim_region_hash`/`client_region_hash`/`sim_conn_counters`, reached directly by ABI export name
  through `callParked` (no `server.ts` wrapper needed) -- `engine/test`'s `hostRegionHash`/
  `replicaHash`/`netCounters` (`test/client.ts`).
