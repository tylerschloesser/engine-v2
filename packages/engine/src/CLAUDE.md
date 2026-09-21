# packages/engine/src

Package-level layout, commands and conventions: `../CLAUDE.md`.

- `server.ts` (docs/plan/13-sim-host-tick-loop.md): the sim host is one module for the sim worker
  and a server (docs/decisions/0015 "Server" row) -- never import `node:` or DOM here. `worker/
  sim.ts` (the sim worker kind) and a future `createWorldServer` (M27) both drive it through the
  same `createSimHost(cfg, services)`; only `Connection`, `Storage` and the clock differ between
  them.
