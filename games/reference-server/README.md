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

## Recipe: one Fly machine per world

`Dockerfile`, `fly.toml` (`shared-cpu-1x`, 512 MB, one 1 GB volume at `/data`, `kill_signal = SIGTERM`, `kill_timeout = 30`, autostop and autostart, `min_machines_running = 0`). Build and deploy:

```
pnpm --filter engine build && pnpm --filter reference build
node games/reference-server/scripts/stage-image.mjs     # fills .stage/; refuses a client .wasm that differs from the release build
cd games/reference-server && fly deploy --remote-only --config fly.toml --dockerfile Dockerfile
```

A build whose save schema changed cannot open the world already on the volume: the machine exits 1 with `WorldLoadError: incompatible (MigrateDeclined)` and Fly stops restarting it. To start a fresh world, move the old one aside with a one-off command, then deploy again (which restores the normal command): `fly machine update <id> -a engine-v2-ref --command "sh -c 'mv /data/worlds /data/worlds-old'" --restart no --yes && fly machine start <id> -a engine-v2-ref` (done 2026-10-10 after M39ai's schema 5 → 6; the old world is at `/data/worlds-schema5-2026-10-02`).

The image runs `--static /app/client --exit-on-idle --stats-every 10`: page and `/ws` share one origin (no CORS or cross-origin `wss`), `--static` sets the two isolation headers on every response (`check-coi.mjs <url>`), and `SIGTERM`/`SIGINT` snapshot the world and exit 0 (0005). Measured on `ord`, 2026-10-02:

- **Idle stop:** about 30 s after the last player leaves the machine is `stopped`; a stopped machine bills only its rootfs and the volume (about $0.16/month computed; the billed figure is in Tyler's Fly dashboard).
- **Cold wake:** 3.4-4.1 s from dial to `Welcome`, longer than the client's 3 s dead timer, so `createLink` redials once; no error screen. Warm: 0.34-0.42 s.
- **A page load alone wakes the machine** but never reaches `onIdle` (it fires after a *player* leaves), so it stays up until Fly's own autostop (observed 6 min 31 s).
- **Tick time, 8 clients, 120 s** (`scripts/loadtest.mjs --url wss://<host>/ws --clients 8 --seconds 120`): p50 0.06-0.43 ms, window p99 about 2.4 ms, max 7.9 ms, 0 overruns.
- Always-on cost, computed from Fly's price list: about $3.69-4.62/month plus the volume.

Teardown: `fly apps destroy <app> --yes`.

## Durable Objects

Not supported. A Durable Object cannot reload a snapshotted world (the isolate is reset before its first tick); see [ADR 0051](../../docs/decisions/0051-durable-objects-no-go.md) for the measurements and when to revisit.
