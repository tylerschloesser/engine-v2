# packages/engine/tests/netcode

The `netcode` suite (docs/decisions/0020-testing-strategy.md §7; docs/plan/
27-server-entrypoint-and-netcode-harness.md). One Node process: `harness.server` is a real
`createWorldServer(cfg, host)` (`WorldServer`, `{ready, accept, stop}`) driving the real `fx-puts`
`.wasm`, joined to K real `HeadlessClient`s by in-memory `Connection` pairs behind a seeded
`conditionLink` on a `VirtualClock`. `assertConverged`/ticking reach the live `SimHost` through
`worldServerTestHandle(server)` (`server.ts`, the same `WeakMap`-keyed-by-the-public-object pattern
`client.ts`'s `clientTestHandle` uses) -- `WorldServer` itself stays exactly `{ready, accept,
stop}`. Nothing here is mocked: only the transport (memory, not a socket) and the clock (virtual,
not wall) are test doubles.

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

## Each client's own identity (secrets, not `myPlayerId`)

docs/plan/28-sessions-and-reconnect.md deleted M15's implicit accept: every connection opens with a
real `Hello`/`Welcome`, and a `HeadlessClient`'s own `PlayerId` comes from `Welcome`
(`status().ownPlayerId`). `createNetHarness({ secrets?, joinKey? })`: `opts.secrets[i]` for a
scenario that cares about identity, else `deterministicSecret(seed, i)`. `harness.advanceTicks`/
`settle` await `serverInternals(server).handshakesSettled()` (a real `crypto.subtle.digest` needs a
genuine `await`). `harness.connectRaw(): Connection` is a raw, `HeadlessClient`-free end
(`handshake.test.ts`); `support.ts`'s `buildHelloBytes(wasm, { secret, joinKey, buildHash })`
builds real `client_hello()` bytes for it. `harness.addClient(secret?)` reuses a specific secret.
`liveness.test.ts` tests `src/net/link.ts`'s `createLink` directly, over `createManualClock()`.

## Fixtures

`fx-puts` (`support.ts`'s `putsFixture()`) is every scenario's fixture. `on_player(Joined)` puts the
player slot immediately -- required for acks past the pending-queue cap (32). `fixture` may also be
a raw `buildGame()` output directory path, resolved through `engine/server/node`'s `loadGame`.
