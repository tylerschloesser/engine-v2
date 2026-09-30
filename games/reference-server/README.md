# reference-server

A deployable multiplayer server for any engine-v2 game, built on `ws` and the engine's Node
adapter (`engine/server/node`). This is the human-facing quickstart; `CLAUDE.md` has the exact CLI
contract.

## Quickstart

Build a game bundle -- a fixture works too:

```
pnpm --filter engine build
node packages/engine/scripts/build-fixtures.mjs   # builds every packages/engine/fixtures/*, incl. `puts`
```

Run the server against it:

```
node games/reference-server --game packages/engine/fixtures/puts/target/engine/dev --data /tmp/reference-world
```

Point a page's `createClient({ host: { kind: 'remote', url: 'ws://127.0.0.1:4174' } })` at it (or,
served through `pnpm device:serve --tunnel --ws`, `wsUrl(location)`); two tabs converge on the same
world.

## Play the reference game with a friend on the LAN

Build the reference game (its release build is the server's default `--game`), start the server, and
serve the page with the socket proxied onto its own origin:

```
pnpm --filter reference build
pnpm --filter reference-server start          # ws://127.0.0.1:4174, world kept in games/reference-server/.data
ENGINE_WS_PROXY_PORT=4174 pnpm --filter reference exec vite preview --host 0.0.0.0 --port 4173
```

Open `http://<your LAN address>:4173/#k=` on each device (the fragment is the invite: `k` is the join
key, empty unless you start the server with `JOIN_KEY=...`, then `#k=<that key>`). Without a `#k=` the
page plays a world of its own in that browser. To reach it from a phone over HTTPS, use
[How to serve a page to the phone](../../docs/plan/device-checks.md#how-to-serve-a-page-to-the-phone)
(`pnpm device:serve --tunnel --app reference --ws` starts the server and the proxy for you).

## Flags and environment

| Flag/env | Meaning | Default |
|---|---|---|
| `--game <dir>` | `buildGame()` output directory | the reference game's release build, with the world of `games/reference/world.json` (an explicit `--game` gets seed `'1'`, `null` params) |
| `--data <dir>` | Where `fsStorage` persists the world | required |
| `--import <archive>` | An exported world archive (`client.exportWorld()`) to import before start | none |
| `--exit-on-idle` | Exit 0 once the world goes idle (0013: 30 s after the last player leaves) | off |
| `PORT` | The WebSocket port | `4174` |
| `JOIN_KEY` | The 0013 join key | `''` |

## Exit codes

`0`: the `--exit-on-idle` idle path. `1`: `ready` rejected (a corrupt/incompatible world) or a
fatal trap (`onFatal`).
