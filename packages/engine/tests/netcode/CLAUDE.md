# packages/engine/tests/netcode

The `netcode` suite (docs/decisions/0020-testing-strategy.md §7). One Node process: `harness.server`
is a real `createWorldServer(cfg, host)` (`WorldServer`, `{ready, accept, stop}`) driving the real
`fx-puts` `.wasm`, joined to K real `HeadlessClient`s by in-memory `Connection` pairs behind a seeded
`conditionLink` on a `VirtualClock`. `assertConverged`/ticking reach the live `SimHost` through
`worldServerTestHandle(server)` (`server.ts`, `WeakMap`-keyed like `client.ts`'s `clientTestHandle`).
Nothing here is mocked: only the transport (memory) and the clock (virtual) are test doubles.

## Writing a scenario

```ts
const harness = await createNetHarness({ fixture: await putsFixture(), seed: 1234, clients: 2 })
try {
  harness.clients.forEach((c, i) => { c.setCamera(square(i)) })
  await harness.advanceTicks(10)
  harness.clients[0]?.dispatch({ SetMotd: { n: 7 } })
  await harness.settle()
  harness.assertConverged()
} finally {
  await harness.dispose()
}
```

- **No real time.** Drive everything through `harness.advanceTicks(n)` (ticks the host, advances the
  shared `VirtualClock`, steps every client) or `harness.advanceTo(t)` (releases conditioner
  deliveries up to virtual time `t`, ticks nothing); never real `setTimeout`/`Date`/`performance.now()`.
- **The seed.** `createNetHarness({ seed, ... })` seeds `WorldConfig.params.seed` and every client
  link's conditioner; pass a distinct literal per file (the harness's own errors include it).
- **HeadlessClient**: `dispatch(action)`, `setCamera({x,y,tilesAcross})`, `setView(report)` (full
  `CameraReport`: `x,y,halfW,halfH,velX?,velY?`), `ui()`, `replicaHash()`, `onActionResult(cb)`,
  `status()`, `pump()`/`stepFrame(dtMs)` -- camera/view changes take effect on the next `stepFrame`.
- **`harness.link(i)`**: the `ConditionedLink` for client `i` (`.set()`/`.stall()`/`.disconnect()`).
  `harness.counters(i)`: bytes/messages up/down per-tick, plus `reconnectBytesUp/Down` (step 5:
  `Hello` through the first frame after its `Welcome`, the `reconnect/cost` budget). `harness.
  trace()`: the whole run's released-message log as one `Uint8Array` (`Array.from` to compare runs).
- **Server and identity hooks** (`restartServer`, `link(i).reconnect()`, `panicServer()`, `connectRaw()`,
  `secrets`/`addClient(secret?)`, each client's `PlayerId` from `Welcome`): see their doc comments in
  `src/test/net-harness.ts` (`serverInternals` in `src/server.ts`); `support.ts`'s `buildHelloBytes` builds a raw `Hello`.

## Byte counters and `assertBudget` (docs/plan/31-rates-and-integrity.md)

`counters(i)` also has `sections` (bytes per `SectionId` name), `header`, `frames`, `heartbeats`,
`chunkEnters`/`chunkLeaves`, `worstSecondBytesDown`, and the host's pacing counters (`degradeLevel`, `queuedEnters`,
`bucketTokens`, `collapses`, ...: see `NetHarnessCounters`). `HeadlessClient.panTo(x, y, tilesPerS)` scripts a pan. `assertBudget(counters, 'net.<row>')` (`engine/test`)
needs the row's `counter` path to equal its `exact` and stay under its `ceiling`; failures name the row.
**Add a row** at `counters.net.<row>` in `budgets.json`: `{counter, exact, ceiling, source}`, the ceiling
taken from a 0010 cell or worked number named in `source`. **Raising a number is a reviewed change**
(0020 §9): fix the code, never the row.

## Fixtures

`fx-puts` (`support.ts`'s `putsFixture()`) is every scenario's fixture: `on_player(Joined)` puts the
player slot immediately (required for acks past the pending-queue cap, 32); its own `FlatWorldgen`
fills every tile `Tile::new(1, 0, 0)` (a `Paint` writing that back is a no-op overlay-wise). `fixture`
may also be a `buildGame()` directory path, resolved via `engine/server/node`'s `loadGame`.

## Desync hashes (docs/plan/31b-desync-hashes.md)

Opt in with `createNetHarness({ world: { debugHashMode: 'production' | 'all' } })` (default `'off'`; M31b step 4 flips it). The client checks each `Hashes` entry against its replica (never the overlay); a mismatch is a report `{ tick, scope: 'chunk' | 'global' | 'ownPlayer', cx, cy, hostHash, clientHash }` on the client (`harness.desyncs()`, tagged with the client index) and on the host (`harness.hostDesyncs()`; its `clientHash` is zeros: `ResyncChunk` carries only the coord), plus a `desync (client|host): ...` line in `engine.log`; `global`/`ownPlayer` use coord `(-2147483648, -2147483648)`. Faults: `client.corruptChunk(cx, cy)`, `harness.skipDelta(i, cx, cy)`, `harness.skipGlobalDelta(i)`. Exact-byte scenarios keep hashing `'off'`. Dumps under `test-results/desync/`: step 4.
