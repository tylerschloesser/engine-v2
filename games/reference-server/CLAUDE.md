# games/reference-server

A deployable, game-agnostic multiplayer server (docs/plan/29-net-worker-and-reference-server.md):
`ws` + `engine/server/node`'s Node adapter (`nodeHostServices`, `fsStorage`, `loadGame`,
`attachWebSocketServer`), `createWorldServer`/`importWorld` (`engine/server`). Testable against any
built game: a fixture, or the reference game (multiplayer since M34).
`index.mjs` is the whole entrypoint, plain Node (no build step): `node games/reference-server`
resolves it via `package.json`'s `main`.

## CLI

`node games/reference-server --game <dir> --data <dir> [--import <archive>] [--exit-on-idle]`

- `--game <dir>`: a `buildGame()` output directory (`game.wasm` + `game.json`, `loadGame`).
  Default: the reference game's own release build (`games/reference/sim/target/engine/release`).
- `--data <dir>`: `fsStorage(dir)`'s own root -- required.
- `--import <archive>`: an exported world archive's bytes (`client.exportWorld()`), imported via
  `importWorld(storage, bytes, { worldId, overwrite: true })` before the world ever starts (0005's
  single-player-to-hosted path) -- always re-rooted under this process's own fixed world id.
- `--exit-on-idle`: exits 0 once `HostServices.onIdle` fires (0013 "World lifecycle": 30 s after
  the last player leaves). Omitted, the process keeps running and re-ticks on the next join.

`pnpm --filter reference-server start` = `node index.mjs --data .data` (gitignored), serving the reference game's release build (`pnpm --filter reference build` first). `--game` left at its default uses `games/reference/world.json` as the world (`null` params do not deserialize into `RefParams`); an explicit `--game` keeps seed `'1'`, `worldgen: null`.

Env: `PORT` (default `4174`), `JOIN_KEY` (default `''`, 0013's join key).

Exits 1 on `WorldServer.ready` rejecting (a corrupt/incompatible world) or `HostServices.onFatal`
firing (an unrecoverable trap, 0024 §5) -- the process never touches a file or a socket further
after either.

## Wire

One fixed world id per process (0013 "One server instance hosts exactly one world"); every socket
`attachWebSocketServer` accepts is queued internally until `ready` resolves (0024 §5), then speaks
0013's `Hello`/`Welcome` handshake -- no path filtering on this port itself (a real client dials
`/ws` on its own origin; a proxy in front of this process, e.g. `pnpm device:serve --ws`, is what
strips the path before the connection reaches here).

## Not here (Non-scope)

Static file serving (`--static`, M38); Bun/Deno adapters (M35b); a Fly deploy.
