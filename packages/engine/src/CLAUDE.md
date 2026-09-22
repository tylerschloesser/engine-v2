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
  takes one argument and a per-message `subarray()` would violate the same rule). One known
  exception, flagged rather than fixed: `wrapEngineInstance.simBuildFrame`'s `raw > 0` branch
  (`server.ts`) still does `region.u8.subarray(0, raw)` once per tick per connection -- the same
  open question `simSealFrame`'s own `raw > 0` branch already carried from M13 (unmeasured by any
  zero-GC page; 0014 §4's "a per-send subarray is acceptable" applies to the *server*, not the sim
  worker, which is 0016-budgeted) -- left for a zero-GC measurement once a real topology exercises
  it (docs/plan/15b-ring-connection-and-replica-rendering.md's own Deviations).
