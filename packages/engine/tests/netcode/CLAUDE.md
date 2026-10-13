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
  trace()`: the whole run's released-message log as one `Uint8Array` (`Array.from` to compare runs). The `ws` harness releases arrivals sorted by a global send sequence (sockets deliver in OS-poll order) after polling for nothing in flight (counts messages and close frames: a 4002 close must be seen); `ws/reconnect-resume`, `ws/trace-identical` are `@slow` (the subset cost ~10 s).
- **Server and identity hooks** (`restartServer`, `link(i).reconnect()`, `panicServer()`, `connectRaw()`,
  `secrets`/`addClient(secret?)`, each client's `PlayerId` from `Welcome`): see their doc comments in
  `src/test/net-harness.ts` (`serverInternals` in `src/server.ts`); `support.ts`'s `buildHelloBytes` builds a raw `Hello`. `crypto.subtle.digest` finishes in unseeded order, so joiners are serialised by `sessionMutationChain` in `Hello`-arrival order and the harness awaits `handshakesSettled()` each tick. `Reject` only follows a parseable `Hello`; garbage counts to 8, then `ProtocolError` (5 s with no `Hello` too).

## Byte counters and `assertBudget` (M31

`counters(i)` also has `sections` (bytes per `SectionId` name), `header`, `frames`, `heartbeats`,
`chunkEnters`/`chunkLeaves`, `worstSecondBytesDown`, and the host's pacing counters (`degradeLevel`, `queuedEnters`,
`bucketTokens`, `collapses`, ...: see `NetHarnessCounters`). `HeadlessClient.panTo(x, y, tilesPerS)` scripts a pan. `assertBudget(counters, '<net|transport>.<row>')` (`engine/test`)
needs the row's `counter` path to equal its `exact` and stay under its `ceiling`; failures name the row.
**Add a row** at `counters.net.<row>` (`counters.transport.<row>` for sections 12 and 13) in `budgets.json`: `{counter, exact, ceiling, source}`, the ceiling
taken from a 0010 cell or worked number named in `source`. **Raising a number is a reviewed change**
(0020 §9): fix the code, never the row.

## Fixtures

`fx-puts` (`support.ts`'s `putsFixture()`) is every scenario's fixture but `belts/*`: `on_player(Joined)` puts the player slot immediately (required for acks past the pending-queue cap, 32); its own `FlatWorldgen` fills every tile `Tile::new(1, 0, 0)` (a `Paint` writing that back is a no-op overlay-wise). `fixture` may also be a `buildGame()` directory path, resolved via `engine/server/node`'s `loadGame`.

**Line structures (M46, `belts.test.ts`).** `beltsFixture()` (`fx-belts`) with `world: { params: { maxLines, maxItems } }` (the replica reserves what the world declares); lines are built by `dispatch({ Request: op })` (`fixtures/belts` ops, run next tick; a line without `Segments` never replicates). `engine/test`: `lineStructures(client)` is the held `{ id, len, speed, out, segments }` list ascending by id, `structsDropped(client)` the puts the replica could not hold, `corruptLineStructure(client, id)` flips a held line's `speed` (an injected fault). Every request entity is anchored at the origin chunk and spawned and despawned in one tick; that moves no chunk version (M48), so lines and cameras may sit there. **Forecasts (M47b, `belts-forecast.test.ts`, `belts-bytes.test.ts`).** `support.ts`'s `beltsBenchWorld(regime, scale, caps)` is the `fx-belts` bench world built at genesis (`fixtures/belts/CLAUDE.md`, regimes) with the chunk pacing lifted (M47b: its spawner entities then wrote a delta per insert; since M53 they write none, their lines' schedules being engine state, 0079 §21). `engine/test`: `forecastCounters(client)` (M47), `lineItems(client, line)` (a held line's items and the replica's forecast tick, `null` when not held; the client's `Tx` is 4 KiB, about 500 items), `hostLineItems(serverInternals(h.server).rawInstance)` (every host line at its last tick), `client.forecastCatchUp(tick)` (the step `on_frame` takes first, for a tick no frame came for); `counters(i).sections.Forecasts` is section 13. `belts/forecast_client_matches_host` (the arbiter: M41's seven 1/64 worlds, 300 ticks, items equal on every held line every tick), `belts/forecast_corrected_on_jam` (toggles are `State`s, never lists), `belts/saturated_view_bytes` (the gate: sections 12 + 13 on the full-scale `SaturatedView` at (20 %, 100), `assertBudget(m, 'transport.downBytesPerSec')`, the row `counters.transport.downBytesPerSec`, production hashing, the median profile) and `belts/saturated_view_stress @slow` ((20 %, 20), recorded in that row's source) and `belts/saturated_view_cells @slow` (the three other cells the source quotes, pinned). **Replication (M48b).** `support.ts` holds the arbiter (`arbitrate(h, i, label, ticks, fullView, before?)`: `before(i)` runs before each tick, a scenario's dispatches), `hostItems`, M47b's `measure()` (`paced` keeps the default chunk pacing: `beltsBenchWorld(.., paced)`; its join then also waits for no queued enter) and `framesAfterWelcome(trace, link)` (`Welcome` count and the parsed frames since the last). `belts-edits.test.ts`: `belts/edit_during_flow_converges` (cut, join, extend, shrink, rescale, speed, destroy of request-built lines beside the 1/64 saturated world, arbitrated every tick; the bench lines are not in the chain table) and `belts/predicted_request_is_not_predictable` (`Action::Probe`). `belts-degrade.test.ts`: `belts/degraded_client_follows` (a 2.6 s stall: levels 1, 2, 4, 2, 1; items compared at every client forecast tick against the host's recorded tick, never caught up by the test) and `belts/reconnect_reputs_structures`. `belts-join.test.ts`: `belts/join_at_scale @slow` (M48c: two cells, `Mixed` and `MixedFeeders`, each paced and lifted, lists applied equal to lines held) and `belts/saturated_view_paced_bytes @slow` (default pacing). **Drawing (M49).** `belts-motion.test.ts`: `belts/items_advance_on_the_item_clock` (one line of the 1/64 jam-free `SaturatedView`, the median profile, 12.5 ms frames for 60 ticks: every drawn item at `floor(p - speed x frac)` from `lineItems` at the follower's tick and `clamp(hostClockNow, T, T + 4, 0078 A12)` (`interpCounters()`), every item strictly advancing every frame, 0 frozen frames and the lead over the render time pinned) and `belts/item_clock_through_a_degraded_hold` (the same line, production hashing, a 2.6 s stall: every frame's draws checked, the clock's frozen frames by clamp and level from the first bundle after it, pinned). M49: a line holder gets a frame every tick (header-only when nothing changed; `belts.test.ts`'s `belts/line_holder_frames_every_tick` pins the idle cost), so catch-up runs only for held or lost frames: `link(i).dropNext(n)` loses the host's next `n` messages (`belts/forecast_catches_up_a_lost_frame`), and the arbiter catches up a tick whose frame never reached the client. A `stepFrame` draws before it applies what arrived, so a frame's draws are of the previous frame's follower. `HeadlessClient.drawsOrigin()` is the window origin of `draws()` (`recordWorldPos`), `setViewportPx(w, h)` makes `px_per_tile()` real (0 otherwise: the fixture style then draws nothing). A `NotPredictable` taints every later pending action until it pops: dispatch a predictable action alone to see it predict.

## Desync hashes (M31b

Hash-all is the harness default (`createNetHarness({ hashAll })`, default `true`; `world: { debugHashMode: 'off' | 'production' | 'all' }` wins): every subscribed chunk is hashed in every frame sent and announced to clients by `Welcome`'s `HASH_ALL` flag, so each scenario is also a replication test and `assertConverged()` also calls `assertNoDesync()` (skipped once a fault was injected). Pass `hashAll: false` only for a scenario that pins non-hash bytes or budgets, with a one-line reason (`rates/*`, `zoomout/*`, `reconnect/cost`, `counters-exact`, `liveness/heartbeat-idle-world`, `interpolation/presence_bytes_budget`, `belts/line_holder_frames_every_tick`). **Reading a report:** a mismatch is `{ tick, scope: 'chunk' | 'global' | 'ownPlayer', cx, cy, hostHash, clientHash }` on the client (`harness.desyncs()`, tagged with the client index) and on the host (`harness.hostDesyncs()`, `serverInternals(server).desyncCount`; its `clientHash` is zeros: `ResyncChunk` carries only the coord), plus a `desync (client|host): ...` line in `engine.log`; `global`/`ownPlayer` use coord `(-2147483648, -2147483648)`. Only `chunk` mismatches dump: `harness.desyncDumps()` and `test-results/desync/<tick>-<cx>_<cy>.{client,host}.bin` (the replica's bytes when the hash mismatched, and after the host's resync snapshot replaced them; `firstDiff` is the first differing offset; bytes are `integrity::encode_chunk`, snapshot version 0). Faults: `client.corruptChunk(cx, cy)`, `harness.skipDelta(i, cx, cy)`, `harness.skipGlobalDelta(i)`. A host that holds frames (degrade level 4) lags the replica by up to 3 ticks, so `assertConverged()` only passes on the tick a held frame just went out: that is not a desync (no report).
