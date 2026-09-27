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
  harness.assertConverged({ only: [0] }) // see "own_player" below
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

## `assertConverged`'s `only` option

`assertConverged()` compares `replicaHash()` to the host's `sim_region_hash(conn)` per client. This
only agrees for `connId 0` at M27: `ClientInstance::init` (`game_instance.rs`) hardcodes
`own_player = PlayerId(1)` for every client regardless of its real connection (a real handshake is
M28's job); `PlayerId = conn + 1` only lines up for `connId 0`. Every other connection's replica is
missing its own private `Player` record while the host's hash always has one -- a structural
mismatch present even with no player-scoped action dispatched. Until M28, write a multi-client
convergence check as `assertConverged({ only: [0] })` and assert the rest directly (global `ui()`
equality, byte traffic, no crash). Do not fix this from here: it is Non-scope for M27.

## Fixtures

`fx-puts` (`support.ts`'s `putsFixture()`) is every scenario's fixture. `on_player(Joined)` puts the
player slot immediately -- required for acks past the pending-queue cap (32). `fixture` may also be
a raw `buildGame()` output directory path, resolved through `engine/server/node`'s `loadGame`.
