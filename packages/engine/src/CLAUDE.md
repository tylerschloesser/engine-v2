# packages/engine/src

Package-level layout, commands and conventions: `../CLAUDE.md`.

- `server.ts` (docs/plan/13-sim-host-tick-loop.md): the sim host is one module for the sim worker
  and a server (docs/decisions/0015 "Server" row) -- never import `node:` or DOM here. `worker/
  sim.ts` (the sim worker kind, paced by `worker/atomics-timer.ts`'s `AtomicsTimer` on top of
  `runBlockingLoop`) and a future `createWorldServer` (M27) both drive a `SimHost` through
  `createSimHostFromInstance`; only `Connection`, `Storage`, the clock and the timer differ between
  them. `sim-config.ts` holds the three pure pieces (`WorldConfig`, `seedToHexU64`,
  `buildSimInstanceConfig`) that `server.ts` re-exports unchanged: split out so `client.ts` (main
  thread) can build the sim worker's own config without transitively importing `loader.ts`
  (`main.no_wasm_instantiate`).
