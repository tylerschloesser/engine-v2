# packages/engine/tests/netcode

The `netcode` suite (docs/decisions/0020-testing-strategy.md §7; docs/plan/
27-server-entrypoint-and-netcode-harness.md). One Node process: `harness.server` is a real
`createWorldServer(cfg, host)` (`WorldServer`, `{ready, accept, stop}`) driving the real `fx-puts`
`.wasm`, joined to K real `HeadlessClient`s by in-memory `Connection` pairs behind a seeded
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

- **No real time.** Drive everything through `harness.advanceTicks(n)` (ticks the host, advances
  the shared `VirtualClock`, steps every client) or `harness.advanceTo(t)` (releases conditioner
  deliveries up to virtual time `t`, ticks nothing). Never call real `setTimeout`/`Date`/
  `performance.now()` in a scenario.
- **The seed.** `createNetHarness({ seed, ... })` seeds `WorldConfig.params.seed` and every client
  link's conditioner; pass a distinct literal per file (the harness's own errors include it).
- **HeadlessClient**: `dispatch(action)`, `setCamera({x,y,tilesAcross})`, `setView(report)` (full
  `CameraReport`: `x,y,halfW,halfH,velX?,velY?`), `ui()`, `replicaHash()`, `onActionResult(cb)`,
  `status()`, `pump()`/`stepFrame(dtMs)` -- camera/view changes take effect on the next `stepFrame`.
- **`harness.link(i)`**: the `ConditionedLink` for client `i` (`.set()`/`.stall()`/`.disconnect()`).
  `harness.counters(i)`: bytes/messages up/down, per-tick. `harness.trace()`: the whole run's
  released-message log as one `Uint8Array` -- compare same-seed runs with `Array.from`.
- **`harness.restartServer(opts?: { crash?: boolean })`** (docs/plan/28b-reconnect-and-lifecycle.md
  step 2): swaps in a fresh `WorldServer` over the same world (`crash: true`: `storage.crashClone()`,
  no clean `stop()` first). New `epoch` is one higher; `resyncAll()` sends every open connection a
  fresh `Welcome`. **`link(i).reconnect()`** (step 3): a fresh conditioned pair, `server.accept()`ed,
  redialed by the *same* `HeadlessClient` (pending queue intact) -- call right after `disconnect()`,
  before the next `advanceTicks`/`advanceTo`. **`panicServer()`**: `trapSim` + `simHost.recover()`.
  **`serverInternals(server)`**: `isTicking`, `idleCalls`, `rawInstance`, `handshakesSettled()`.

## Each client's own identity (secrets, not `myPlayerId`)

docs/plan/28-sessions-and-reconnect.md deleted M15's implicit accept: every connection opens with a
real `Hello`/`Welcome`, and a `HeadlessClient`'s `PlayerId` comes from `Welcome`
(`status().ownPlayerId`). `createNetHarness({ secrets?, joinKey? })`: `opts.secrets[i]` for a
scenario that cares about identity, else `deterministicSecret(seed, i)`; `addClient(secret?)` reuses
one. `harness.advanceTicks`/`settle` await `handshakesSettled()` (needs a real `await`).
`harness.connectRaw(): Connection` is raw, `HeadlessClient`-free; `support.ts`'s `buildHelloBytes(wasm,
{ secret, joinKey, buildHash })` builds real `client_hello()` bytes for it.

## Fixtures

`fx-puts` (`support.ts`'s `putsFixture()`) is every scenario's fixture. `on_player(Joined)` puts the
player slot immediately -- required for acks past the pending-queue cap (32). `fixture` may also be
a raw `buildGame()` output directory path, resolved through `engine/server/node`'s `loadGame`.
