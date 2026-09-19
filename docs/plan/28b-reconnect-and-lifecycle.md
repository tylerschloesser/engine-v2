# M28b: Reconnect and world lifecycle

Status: not started · After: 28, 19, 24 · Tyler-dependent: no

Second half of the PLAN.md row "sessions and reconnect" (split explained in M28). M29 follows 28b.

## Goal
A dropped client comes back for one round trip and about a kilobyte: the resume hint turns unchanged chunks into "keep" entries, pending actions are resent exactly once, and a host restart or panic recovery bumps the epoch and forces a full resync. A disconnect is logged only after the grace; a world with no players stops ticking, snapshots, and calls `onIdle`; the next connection resumes it.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0013-sessions-and-integrity.md` (Reconnect, A disconnected player's state, World lifecycle)
3. `docs/decisions/0005-persistence-and-recovery.md` (Recovery, Panic recovery steps 1–2, Storage: `flush`)
4. `docs/decisions/0011-wire-format-and-deltas.md` (Versions instead of acks; chunk enter entries)

Rules that apply: `.claude/rules/determinism.md` (ticks are counted, never inferred from wall clock).

## Scope
- **Resume hint.** Client: `client_hello` appends `resume` from the replica's per-chunk versions (0013 Handshake; bounded there). Host: `sim_attach` diffs hint against the new subscription: keep / snapshot / leave (0013 Reconnect). A "keep" is an entry of M14's reserved `ChunkKeeps` section (id 11); body and golden bytes land here. `Global` and `OwnPlayer` are always resent.
- **Epochs.** M24 provides only the hook `SimHost.onRecovered` (fired for `'panic'` and, from M24b, `'upgrade'`); the epoch is built here: `SimHost.epoch`, `SimHost.bumpEpoch()` and `SimHost.resyncAll()`, with `onRecovered` pointed at `bumpEpoch()` + `resyncAll()`. The epoch is durable and visible: `ManifestV1.epoch` (reserved by M22) is loaded at start, every bump is written back with `Storage.write` before the next `accept` or `Welcome`, the value is carried in `Welcome`, and a hint from another epoch is ignored.
- **Resync on a live connection** (the question M24 hands to this brief). After panic recovery or an upgrade bump the connections, ring or socket, are still open (0005): `resyncAll()` sends a fresh `Welcome` with the new epoch on each and treats every chunk as unsent. A client that receives `Welcome` while `Online` drops replica, overlay and interpolation state, sets `session_state = 4 Resyncing`, which main surfaces as `client.onResyncing(cb)` (a per-event subscription in the style of `client.onUi`; there is no `EngineEvent` union), and proceeds as after a join.
- **Pending-action resend.** On every `Welcome` the client resends pending actions with `seq` above `Welcome.last_processed_action_seq` (M25's `PendingQueue::unacked_after`, or M16's outbox if M25 is not ticked) and pops the rest (0004, 0013); the overlay is rebuilt by the normal reconcile path. A popped action whose ack was lost with the old connection is reported as `onActionResult(seq, Lost)`: processed by the host, outcome not delivered, state already correct. Main's `seq` counter needs nothing: M16 seeds it once per page life and M28 made `Welcome` the source.
- **Grace.** On close without `Bye{Leave}`: presence removed and relayed at once; `Disconnected` logged only when the grace of 0013 expires; a `Hello` with the same secret inside the grace logs nothing. Grace is measured on `HostServices.clock`, and the record lands in the next frame like any admitted record.
- **Idle.** The tick that applies the last `Disconnected` is the last tick run (unless `keepTickingWhenEmpty`); after the idle delay of 0013: `SimHost.pause()` (M22b: snapshot if dirty, `flush()`), then `onIdle()`. A `Hello` while paused calls `resume()` before the handshake is consumed. No tick is skipped or inferred.
- `stop()` sends nothing special: clients see a close and come back through `createLink`.

## Non-scope
Net worker and browser reconnect (M29). Desync `ResyncChunk` (M31b). Log-tail loss semantics (M22/M24 own them; this brief only relies on the epoch).

## Files, packages and crates touched
- `packages/engine/crates/engine`: `session` (hint build + diff, keep entry), client replica reset
- `packages/engine/src/host/{lifecycle,handshake}.ts`, `src/client.ts` (`Lost` result), `src/test/net-harness.ts`
- fixtures: M16's action fixture, M24's `panicky`, M21's timer fixture for the idle test (a timer must not advance while paused)

## Seams
**Provides:**
- `session_state` gains `4 Resyncing`; `HeadlessClient.status()` reports it; `client.onResyncing(cb)` on the TS surface (M37 audits it). `SimHost.epoch`, `bumpEpoch()`, `resyncAll()`. Action result variant `Lost` (TS union and ts-rs binding of M16).
- `ChunkKeeps` section body.
- Harness: `harness.restartServer(opts?: { crash?: boolean }): Promise<void>` (stop, or `crashClone`, then a new `createWorldServer` on that storage: epoch + 1), `link(i).disconnect()` / `reconnect()`, `serverInternals(server).isTicking`, `idleCalls`.
- `NetCounters.reconnectBytesUp/Down` (bytes between a `Hello` and the first frame after its `Welcome`).

**Consumes:** everything M28 provides; `PresenceTable.remove` + relay (M19); `SimHost.onRecovered`, `recover()`, `trapSim`, fixture `panicky` (M24); `ManifestV1`, `memoryStorage().crashClone` (M22); `SimHost.pause`/`resume`/`stop`, which already snapshot-if-dirty and `flush()` (M22b); outbox (M16), `PendingQueue::unacked_after` (M25, if ticked); `SectionId::ChunkKeeps` (M14); per-chunk version, `SubscriptionSet` (M15).

## Planning decisions
- **A second `Welcome` is the resync signal (0024 §8).** 0005 says clients "see `Resyncing`" with sockets open but names no message. Reusing `Welcome` adds no message type and makes recovery, restart and join one client path.
- **The epoch lives in the manifest, not the log** (M22 reserved the field), so bumping it never touches replayed state.
- **`Lost` is a third action result (0024 §8).** 0004 defines `Confirmed | Rejected`; after a reconnect the host, which keeps no per-session state (0013), cannot replay an ack. Reporting `Confirmed` could hide a rejection, so the honest variant is added; games may ignore it because the resync already shows the truth.
- **Grace and idle timers are host-clock timers outside the sim;** only their outcome (`Disconnected`) is logged. Under the harness they run on the `VirtualClock`.
- **Hint coordinates are relative to the `Hello` camera report's centre** (0013); chunks outside the `i16` range or beyond the bound are simply omitted and arrive as snapshots.

## Order of work
1. Keep entry + goldens; hint build and diff with native tests.
2. Epoch in manifest, `restartServer`, second-`Welcome` resync.
3. Pending resend + `Lost`.
4. Grace, presence removal, idle/`onIdle`/resume.
5. Counters and the reconnect-cost assertion.

## Tests added
Rust: `session/golden-keep-entry`, `session/hint-diff` (equal → keep, stale → snapshot, unwanted → leave, foreign epoch → all snapshots). Netcode: `reconnect/resume-keeps-unchanged-chunks` (also: the first frame after the resume carries the `Global` and `OwnPlayer` sections although every chunk is kept), `reconnect/changed-while-away`, `reconnect/pending-resent-once` (action in flight at the drop applies exactly once, hash converges), `reconnect/host-restart-epoch` (`restartServer`, hint ignored, converges, `seq` continues), `reconnect/panic-recovery-resync` (fixture `panicky`, `PanicInApply`: open links get a second `Welcome`, status passes through `Resyncing`, the faulting sender gets `EngineFault`), `reconnect/lost-ack-reports-lost`, `reconnect/within-grace-logs-nothing` (log byte-identical to a run without the drop), `reconnect/after-grace-logs-disconnected`, `reconnect/bye-skips-grace`, `reconnect/presence-vanishes-at-once`, `lifecycle/idle-stops-ticks-then-onidle` (tick counter frozen, timer fixture unchanged, one snapshot, one `onIdle`), `lifecycle/hello-resumes`, `lifecycle/keep-ticking-when-empty`, `reconnect/cost` (wilderness reconnect within the budgets file ceiling).

## Exit criteria
- [ ] Named tests pass, each reproducible from its printed seed.
- [ ] `reconnect/cost` asserts `reconnectBytesUp/Down` against new `budgets.json` rows derived from 0013 (Reconnect: cost) and 0010 (resume hint).
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test netcode -t reconnect` · `pnpm test netcode -t lifecycle` · `pnpm test rust -t session` · `pnpm lint`

## Budgets
PRE-PLAN §7 "Bandwidth per client, burst": the reconnect figure, by `reconnect/cost`. "Latency": snapshot on idle does not run on the tick path (asserted by `idle-stops-ticks-then-onidle` ordering).

## Context artifacts
Netcode `CLAUDE.md`: `restartServer`, `panicServer`, link `disconnect`/`reconnect`.

## Manual device checks
none (see M29)

## Deviations
