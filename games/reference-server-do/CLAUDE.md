# games/reference-server-do

The "one Durable Object per world id" recipe of ADR 0009 (docs/plan/38-hosting-checks.md Scope A): a
Worker routes `/ws/<worldId>` to a `WorldDO`, which runs `createWorldServer` (`engine/server`) over
the standard WebSocket API. It is a recipe and a feasibility harness, never an `engine/server/*`
entrypoint, and not part of `pnpm test` (the Durable Objects ADR records what it measured and whether
the target is supported). Plain `.mjs`, no build step; `wrangler` (on PATH) bundles it.

- `src/worker.mjs`: the Worker (`/ws/<id>`, `/stats/<id>?since=<seq>`, and `/alloc/<id>` only when
  deployed with `--var ALLOW_ALLOC:1`) and `WorldDO`. `Connection` is the server end of a
  `WebSocketPair`: set `binaryType = 'arraybuffer'` (the default is `blob`), and `send(cls, bytes,
  len?)` must honour `len`. `timer.every` is `setInterval`; `scheduler` is `setTimeout` (without it
  `onIdle` never fires); `onIdle` stops the world and drops it so the object can be evicted.
- `src/storage.mjs`: `doStorage(ctx.storage)`, the 0005 adapter table's Durable Object row: logical keys
  as 1 MiB numbered part objects `p/<key>/<gen>/<seq>` plus an `idx` object; `write` swaps a new
  generation in one `put`. Test: `do/storage-adapter` (`runStorageConformance` on a double of
  `ctx.storage`, netcode suite).
- `scripts/stage.mjs <puts|reference|bench> [--scale n] [--arena-mib n]`: fills `.stage/` (the `.wasm`
  copied out of `target/`, refused unless sha256 == `buildHash`, plus the world's config). Run before
  `wrangler dev` or `wrangler deploy`; `.stage/` is gitignored.
- `scripts/smoke.mjs`: join, act, reconnect against a running Worker (`puts` payload).
  `scripts/measure.mjs` (observers that log JSON lines for hours), `summarize.mjs` (reads that log),
  `probe-memory.mjs`, `probe-recovery.mjs`: the step-2 measurements. They import the built engine from
  `packages/engine/dist` (`pnpm --filter engine build` first).
- Test: `do/local-smoke` (`packages/engine/tests/netcode/do-local-smoke.test.ts`, slow tier, runs
  `wrangler dev --local`, kills it hard and restarts it on the same storage).

Deploy: `node scripts/stage.mjs <payload> && wrangler deploy` (Workers Paid; SQLite-backed object
class, `wrangler.toml`). Every deploy restarts the objects. Delete with `wrangler delete`.
