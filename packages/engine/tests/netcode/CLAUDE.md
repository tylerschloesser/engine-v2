# packages/engine/tests/netcode

The `netcode` suite (docs/decisions/0020-testing-strategy.md §7; docs/plan/
27-server-entrypoint-and-netcode-harness.md). One Node process: the real server entrypoint driving
the real `fx-puts` `.wasm`, joined to K real `HeadlessClient`s by in-memory `Connection` pairs
behind a seeded `conditionLink` on a `VirtualClock`. Nothing here is mocked: only the transport
(memory, not a socket) and the clock (virtual, not wall) are test doubles.

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
  the shared `VirtualClock` by one tick's worth per step, steps every client's own frame) or
  `harness.advanceTo(t)` (releases conditioner deliveries up to virtual time `t`, ticks nothing).
  Never call real `setTimeout`/`Date`/`performance.now()` in a scenario.
- **The seed.** `createNetHarness({ seed, ... })` seeds `WorldConfig.params.seed` and every client
  link's own conditioner. Pass a scenario-specific seed (a distinct literal per file); the harness's
  own errors already include it.
- **HeadlessClient**: `dispatch(action)`, `setCamera({x,y,tilesAcross})` (symmetric-viewport
  convenience), `setView(report)` (full `CameraReport` shape: `x,y,halfW,halfH,velX?,velY?`, for
  exact byte control), `ui()`, `replicaHash()`, `onActionResult(cb)`, `status()`,
  `pump()`/`stepFrame(dtMs)`. Camera/view changes take effect on the *next* `stepFrame`.
- **`harness.link(i)`**: the `ConditionedLink` for client `i` (`.set()`/`.stall()`/`.disconnect()`).
  `harness.counters(i)`: bytes/messages up/down, totals, per-tick breakdown. `harness.trace()`: the
  whole run's released-message log as one `Uint8Array` -- compare two same-seed runs with
  `expect(Array.from(a)).toEqual(Array.from(b))`.

## Each client's own identity (`myPlayerId`)

`assertConverged()` compares `replicaHash()` to the host's `sim_region_hash(conn)` per client, for
every client. `createNetHarness` passes each `HeadlessClient` its real `PlayerId` (M15's implicit
accept: `connId + 1`, `SimHost.accept`'s own return value) as `myPlayerId`, which
`ClientInstance::init` (`game_instance.rs`) uses for `Replica`'s `own_player` instead of a hardcoded
`PlayerId(1)` -- this is a pre-handshake stand-in (M28's real handshake, `Welcome`, replaces it as
the source of truth once it lands), not something a scenario needs to think about. A `HeadlessClient`
built outside `createNetHarness` (rare) defaults to `myPlayerId: 1`, correct only for a single real
connection.

## Fixtures

`fx-puts` (`support.ts`'s `putsFixture()`) is every scenario's fixture. `on_player(Joined)` puts the
player slot immediately -- required for acks past the pending-queue cap (32). `fixture` may also be
a raw `buildGame()` output directory path, resolved through `engine/server/node`'s `loadGame`.
