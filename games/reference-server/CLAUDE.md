# games/reference-server

A deployable, game-agnostic multiplayer server (M29:
`ws` + `engine/server/node`'s Node adapter (`nodeHostServices`, `fsStorage`, `loadGame`,
`attachWebSocketServer`), `createWorldServer`/`importWorld` (`engine/server`). Testable against any
built game: a fixture, or the reference game (multiplayer since M34).
`index.mjs` is the whole entrypoint, plain Node (no build step): `node games/reference-server`
resolves it via `package.json`'s `main`.

## CLI

`node games/reference-server --game <dir> --data <dir> [--world <file>] [--import <archive>] [--exit-on-idle] [--static <dir>] [--stats-every <s>]`

- `--game <dir>`: a `buildGame()` output directory (`game.wasm` + `game.json`, `loadGame`).
  Default: the reference game's own release build (`games/reference/sim/target/engine/release`).
- `--world <file>`: a `world.json` (seed, worldgen) for an explicit `--game`; without it an explicit `--game` gets `worldgen: null`, which `RefParams` refuses (`BadConfig`). `device-serve --app reference --bench` passes it.
- `--data <dir>`: `fsStorage(dir)`'s own root -- required.
- `--import <archive>`: an exported world archive's bytes (`client.exportWorld()`), imported via
  `importWorld(storage, bytes, { worldId, overwrite: true })` before the world ever starts (0005's
  single-player-to-hosted path) -- always re-rooted under this process's own fixed world id.
- `--exit-on-idle`: exits 0 once `HostServices.onIdle` fires (0013 "World lifecycle": 30 s after
  the last player leaves). Omitted, the process keeps running and re-ticks on the next join.
- `--static <dir>` (M38, `static.mjs`): the same `node:http` server serves files from `<dir>` (`/` is `index.html`), with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on every response including 404s, `application/wasm`, immutable `/assets/*`, and no path outside `<dir>`. Only `/ws` upgrades then (without the flag any path does). Test: `reference-server/static-headers`.
- `--stats-every <s>`: a `stats: ticks=.. tick_ms p50=.. p99=.. max=.. overruns=..` line every `<s>` seconds (the tick callback's own duration, measured around `timer.every`); off by default. `scripts/loadtest.mjs` reads nothing from it: read `fly logs`.

`pnpm --filter reference-server start` = `node index.mjs --data .data` (gitignored), serving the reference game's release build (`pnpm --filter reference build` first). `--game` left at its default uses `games/reference/world.json` as the world (`null` params do not deserialize into `RefParams`); an explicit `--game` without `--world` keeps seed `'1'`, `worldgen: null`.

Env: `PORT` (default `4174`), `HOST` (default `127.0.0.1`; the image sets `0.0.0.0`), `JOIN_KEY` (default `''`, 0013's join key).

Exits 1 on `WorldServer.ready` rejecting (a corrupt/incompatible world) or `HostServices.onFatal`
firing (an unrecoverable trap, 0024 §5) -- the process never touches a file or a socket further
after either.

## Wire

One fixed world id per process (0013 "One server instance hosts exactly one world"); every socket
`attachWebSocketServer` accepts is queued internally until `ready` resolves (0024 §5), then speaks
0013's `Hello`/`Welcome` handshake -- no path filtering on this port itself (a real client dials
`/ws` on its own origin; a proxy in front of this process, e.g. `pnpm device:serve --ws`, is what
strips the path before the connection reaches here).

## Bun and Deno entries

`bun.ts` (`pnpm --filter reference-server start:bun`) and `deno.ts` (`start:deno`: `deno run --allow-read --allow-write --allow-net --allow-env=PORT,JOIN_KEY`) serve through `engine/server/bun` / `/deno`, with no `ws`; `common.mjs` holds the shared flag and world-config code. Flags: `--game`, `--data` (the same default-game rule as `index.mjs`); `PORT`, `JOIN_KEY`. No `--import` or `--exit-on-idle`. The three start commands: `start` (Node), `start:bun`, `start:deno`.

## Fly image (M38)

`Dockerfile`, `fly.toml`, `.dockerignore`; the build context is `.stage/` (gitignored), filled by `node scripts/stage-image.mjs` after `pnpm --filter engine build && pnpm --filter reference build`; then `fly deploy --remote-only --config fly.toml --dockerfile Dockerfile` from this directory. `reference-server/docker-args` keeps the three files and the CLI in agreement. `scripts/loadtest.mjs --url wss://<host>/ws --clients 8 --seconds 120 [--trace]`. The Fly recipe is in the README.

## Not here (Non-scope)

A Durable Object adapter (tried in M38 and dropped: [ADR 0051](../../docs/decisions/0051-durable-objects-no-go.md)).
