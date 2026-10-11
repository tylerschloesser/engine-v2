# 0073: Own-timer bars end when the result can arrive: predicted own timers, the host-clock authoritative tick, a one-round-trip seed

Status: Accepted (2026-10-10). Amends [0064](0064-phase-3-decisions-sync-and-netcode.md) §2 (how the stretch reaches the page) and §3 (the authoritative tick, the lead sample, the seed), and [0012](0012-prediction-and-reconciliation.md) "Two clocks" ("Authoritative = latest frame tick").

## Context

0064 §2 settled that a player's own timer bar runs over `duration + lead` and fills when the host's result can arrive. On 2026-10-10, desktop Chrome on the reference game (two windows; a delay proxy giving 281 ms each way, DevTools' "Slow 4G" 562.5 ms round trip, which CDP throttling does not apply to a WebSocket) measured the bars against the result (tolerance 100 ms, 0064 §2):

- Unthrottled, the collect bar was full 58-257 ms before its result, the bar 1650-1900 ms for a 2000 ms collect: the reference UI timed both bars as `done_at - clock.predicted`, the unstretched bar. The engine's `own_progress` had the stretch, but no game used it.
- With that fixed, under Slow 4G the bar started one round trip after the tap: `Ui.collecting`/`Ui.crafting` came from the raw replica, so the predicted collect reached the page only with the host's frame.
- With that fixed, the bars ran 250-350 ms past their results. A one-player world is idle, so the host sends only heartbeats, one every 500 ms (0010), and the replica's tick moves in 10-tick steps. The lead sample (`ack.tick - auth_tick_at_dispatch`) took the dispatch tick from that stale replica tick, and the page's `clock().authoritative` came from the clock block, which the client worker refreshed only when a frame landed. Lead settled near 20 ticks against a true 13.
- The first bar after a join was 640 ms long: the lead seed (`ceil(rtt / tick) + 1`) came from a `Hello`-`Welcome` RTT that also counted the WebSocket upgrade, because the net worker reported the link up at dial and the socket held the `Hello` until `open`.

The netcode harness never saw any of this: its virtual clock steps frames and ticks together, and its `Ui` reads were not timed against a bar.

## Decision

1. **The reference game's own timers in `Ui` are predicted.** `RefClient::ui` reads `collecting` and `crafting` from `FrameView::predicted_player`; everything else (`inventory`, unlocks) stays the replica's. A refused action drops them again at its verdict.
2. **A bar runs until the authoritative clock reaches `done_at`** (`games/reference/src/ui/own-timer.ts`, `ownTimerMs`): `(done_at - authoritative - tickFraction) / ticksPerSecond`. With `done_at` on the predicted clock, that is `duration + lead` from the tap, the end point of `own_progress`.
3. **The authoritative tick is `ClientCore::auth_now`:** `HostClock`'s estimate of the host tick, never behind the replica's own tick. It feeds `predicted_tick` (`auth_now + lead`), the lead sample's dispatch tick, `FrameView::clocks().authoritative` and the clock block's `authoritative`, paired with its own fraction. The last frame's tick stays available (`client_clock_stats` offset 0; `HeadlessClient.status().tick`).
4. **The client worker rewrites the clock block every wake once live**, not only when a frame lands. `tickFraction` crosses as the raw bits of its `f32` (`ClockFields.tickFractionBits`): decoding the float each wake boxed a double, 16 B per frame on the client isolate (the `gc` controls caught it).
5. **`client_clock_stats` is 24 bytes** (`ABI_VERSION` 39 -> 40): offset 20 is `auth_now`'s tick.
6. **The net worker reports the link up on the socket's real `open`** (`wsConnection(url, onOpen)`), so the client sends its `Hello` then and the RTT is one round trip. The `Hello` reaches the server at the same moment as before (the socket queued it until `open`).
7. **The seed is `ceil(rtt / tick)`**, no `+ 1`: with the RTT measured from `open`, it equals what the samples converge to (620 ms: 13 ticks).

Result, desktop Chrome, check build: unthrottled bars within -16..+25 ms of their result; Slow 4G from page load, ten collects and a craft within 9-83 ms.

## Alternatives rejected

- **Keep `authoritative` as the latest frame tick and add a field for the estimate.** Every reader of the clock (the furnace smelt bar, `own_progress`, a page's bars) wants the clock that keeps moving between heartbeats; 0064 §3 built `HostClock` for exactly that. The frame tick stays where a test needs "it still hears frames".
- **Shorten the heartbeat interval.** Costs bytes on every idle connection (0010) to fix what is a client-side estimate.
- **Predict the whole `Ui`.** `inventory` would show a predicted spend before the host's verdict; the torn-state rules of the furnace tests (0012) rely on the replica's inventory and the ghost sprite.

## Consequences

- A sudden RTT change mid-session takes about four acks to reach the bars (the median of 8, 0064 §3): measured, Slow 4G switched on mid-session, the first three bars ran 350-660 ms long, then within tolerance.
- A test that waited for `Ui.collecting`/`Ui.crafting` to mean "the host has it" now waits for the host's `Confirmed` (`sessions`, `races`, `subscription` tests).
- `authoritative` can be ahead of the newest frame: code that needs "a frame for tick T arrived" reads the replica's own tick (`FrameView::world().tick()`), not the clock.

## Sources

- Session of 2026-10-10: the scripted desktop-Chrome M34 runs (scratch scripts, delay proxy on `:4180`), the per-chunk trace of one join (`Hello` at +570 ms, `Welcome` back at +1187 ms), and the per-collect logs of `clock_auth`/`clock_pred` from the check build.
