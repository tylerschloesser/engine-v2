# reference-server

A deployable multiplayer server for any engine-v2 game, built on `ws` and the engine's Node
adapter (`engine/server/node`). This is the human-facing quickstart; `CLAUDE.md` has the exact CLI
contract.

## Quickstart

Build a game bundle -- a fixture works before the reference game is multiplayer (M34):

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

## Flags and environment

| Flag/env | Meaning | Default |
|---|---|---|
| `--game <dir>` | `buildGame()` output directory | the reference game's release build |
| `--data <dir>` | Where `fsStorage` persists the world | required |
| `--import <archive>` | An exported world archive (`client.exportWorld()`) to import before start | none |
| `--exit-on-idle` | Exit 0 once the world goes idle (0013: 30 s after the last player leaves) | off |
| `PORT` | The WebSocket port | `4174` |
| `JOIN_KEY` | The 0013 join key | `''` |

## Exit codes

`0`: the `--exit-on-idle` idle path. `1`: `ready` rejected (a corrupt/incompatible world) or a
fatal trap (`onFatal`).
