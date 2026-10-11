# Sync and netcode

The host is authoritative; each client holds a partial replica of the world (the chunks in its view), predicts its own actions on top of it,
and interpolates everything remote. Single-player runs the identical protocol: a sim worker as host, a client worker, the same frames over
worker messages instead of a socket. The game writes no delta, prediction or interpolation code: the engine derives deltas from the
`WorldWrite` calls in `apply`/`tick`, predicts by re-running the game's own `Game::apply`, and interpolates presence and moving entities
(Requirement, amended by Tyler 2026-09-19). A game may opt single actions out with `Game::predict -> false`.

Where it lives:

- Rust (`packages/engine/crates/engine/src/`): `wire/` (byte formats), `session/` (handshake codecs, resume hint), `host/` (connections,
  subscriptions, pacing, hash schedule), `client/` (`core.rs` `ClientCore`, `replica.rs` `Replica`), `predict/`, `clock/`, `interp/`,
  `presence.rs`, `integrity.rs`, `delta.rs`, `hash.rs`, `codec.rs`.
- TypeScript (`packages/engine/src/`): `server.ts` (`createWorldServer`, handshake queue), `host/` (`handshake.ts`, `sessions.ts`,
  `lifecycle.ts`), `net/` (`link.ts`, `pump.ts`, `ws-connection.ts`, `conditioner.ts`), `worker/net.ts`, `desync.ts`.
- Related: [runtime-and-hosting](runtime-and-hosting.md) (transport adapters), [threads-and-boundary](threads-and-boundary.md) (rings
  between net, client and sim), [simulation](simulation.md) (action validation, tick order).

## Wire format and deltas ([0011](../decisions/0011-wire-format-and-deltas.md), [0041](../decisions/0041-frame-bundle.md))

Binary, hand-rolled, little-endian, tagless, no schema evolution: strict build-hash equality makes compatibility pointless. `wire/CLAUDE.md`
is the single home of the byte layouts, type bytes and section ids; do not copy numbers elsewhere. Writers are generic over `ByteSink` and
allocate nothing; readers borrow and never panic.

- **Frame** `[type][flags][tick u32][ack_seq u32]` plus ascending sections; no sections is a heartbeat. Idle ticks send nothing; a
  heartbeat goes out at least every 500 ms (`HEARTBEAT_MS` in `host/mod.rs`). `FrameBundle` carries several whole frames, each applied
  alone, in order (degrade concatenation); `ClientCore::on_frame` validates the whole bundle first.
- **Deltas are the only write path.** `delta.rs` `Delta<G>` is what every `WorldWrite` put becomes; `Store::apply` is the only
  interpreter. `Delta::Ack` and `Delta::Roster` are engine-only: `Ack` goes straight to `Store` via `Authority::record_ack` and never
  reaches a client frame ([0064](../decisions/0064-phase-3-decisions-sync-and-netcode.md) §7). Every `match` over `Delta` in the frame
  builder names `Ack` explicitly, never a catch-all.
- **Scopes**: chunk (overlay tiles and entities anchored there, routed by `Game::anchor`), `Global` (game value plus the engine roster),
  `OwnPlayer`. Subscribing sends `ChunkEnterPristine` (coordinate only) or a snapshot `{coord, version, overlay runs, entity puts}`
  consistent as of the frame's tick; later changes are `ChunkDeltas`.
- **Versions, not acks.** A chunk's version is the tick of its last replicated change. The host stamps every footprint chunk of every
  write; a replica takes its version only from a snapshot or a frame-tick bump, so a stale replica version can only cause an over-snapshot,
  never a wrong keep ([0064](../decisions/0064-phase-3-decisions-sync-and-netcode.md) §18). `Host::chunk_versions` is never pruned (§17).
- The uplink is `UplinkBatch`: pending actions, the latest `CameraReport` (16 B, never seen by the sim), the latest presence sample,
  `last_received_tick`. Entity ids are never encoded as provisional (below).
- `codec.rs` bytes feed snapshots, the log and `hash.rs` (`Fnv64`); see [determinism](../../.claude/rules/determinism.md).

## Rates, subscriptions, bandwidth ([0010](../decisions/0010-rates-and-subscriptions.md), [0059](../decisions/0059-subscription-cap-144.md), [0040](../decisions/0040-interpolation-delay-presence-interval.md))

- **Rates.** Sim tick 20 Hz (a per-game constant, fixed for a world's life; the tick rate was TBD in the Requirements and is settled by
  0010). Client to host: at most one uplink batch per 50 ms and at least one per 1 s (`MIN_UPLINK_INTERVAL_MS`, `KEEPALIVE_INTERVAL_MS` in
  `client/core.rs`); camera and presence at most 10 Hz, on change; the host discards camera reports beyond 20/s (`pacing.rs`
  `CAMERA_REPORTS_PER_S`). Pending actions bypass the 50 ms floor ([0064](../decisions/0064-phase-3-decisions-sync-and-netcode.md) §12).
- **Subscriptions** (`host/subs.rs` `SubscriptionSet`): derived on the host from the client's untrusted view rectangle, clamped (never
  rejected) to 256 tiles per axis with the centre inside the world (`clamp_report`; the clamps go to the client in `Welcome`). Subscribe
  ring 1 plus up to 2 chunks of velocity look-ahead; unsubscribe only beyond ring 3 and after 5 s outside; hard cap `CAP_CHUNKS = 144`,
  evicting farthest-first by class (visible > ring 1 > look-ahead > retained).
- **Pacing** (`host/pacing.rs` `Pacing`, per connection, a function of tick count alone): chunk data goes through a token bucket (48 KB/s
  refill, 128 KB burst, visible chunks first, then nearest the look-ahead centre); tick frames never queue behind it. Soft cap 16 KB/s of
  frames: past it, or when the `last_received_tick` backlog grows, the connection degrades to every 2nd, then 4th tick, and a chunk whose
  queued deltas exceed its snapshot is collapsed into a snapshot. Hard ceiling 64 KB/s. Known limits: degrade cannot get a client under the
  soft cap by itself, per-tick pacing cost is not O(1) per client, and a frame that overflows the `SliceSink` loses other chunks' deltas
  ([0064](../decisions/0064-phase-3-decisions-sync-and-netcode.md) §20-22).
- **Admission rate limit**: 20 actions/s, burst 40, `EngineReject::RateLimited`; unlogged and leaves the action pending (§10). The client
  refuses to dispatch past 32 pending (`OUTBOX_CAPACITY`).
- Games must never replicate per-tick progress: replicate parameters (`started_at`, `done_at`) and derive bars from the tick clock. Byte
  budgets are `counters.net.*` rows in `packages/engine/budgets.json`, asserted with `assertBudget`; measure with production hashing on.

## Sessions ([0013](../decisions/0013-sessions-and-integrity.md), [0053](../decisions/0053-connection-slots-and-full-admission.md), [0042](../decisions/0042-remote-client-world-config-from-welcome.md))

- **Identity.** The client mints a 128-bit secret in `localStorage`; the host keeps `SHA-256(secret) -> PlayerId` plus the last presence
  sample in the session table (`src/host/sessions.ts`, storage key `sessions`, outside sim state). Access control is a join key from the
  invite URL fragment (`#k=<joinKey>`) plus that secret; there is no cross-device recovery (Requirement; the secret has one accessor and the
  fragment parser ignores unknown parameters, [0064](../decisions/0064-phase-3-decisions-sync-and-netcode.md) §15). `PlayerId(conn + 1)`; 0
  means none. A server hosts exactly one world; mapping URLs to worlds is the deployer's problem.
- **Handshake** (`session/mod.rs`, `src/host/handshake.ts`): `Hello` (frozen 38-byte prefix: magic, `PROTOCOL_VERSION`, 32-byte build
  hash; then join key, secret, `CameraReport`, optional resume hint) answered by `Welcome` (player id, epoch, tick, tick rate, seed and
  params, view clamps, `last_processed_action_seq`, flags `WELCOME_PRESENCE`/`WELCOME_HASH_ALL`, last presence) or `Reject{VersionMismatch |
  BadKey | Full}`. `Bye{Leave | Superseded}`. Strict build equality; no ranges. A remote client takes its world seed and params from
  `Welcome` (0042); `WorldMismatch` shows `onLink rejected` and has no reload policy
  ([0064](../decisions/0064-phase-3-decisions-sync-and-netcode.md) §16).
- **Server side** (`server.ts`): `accept` queues each `Hello` and `pumpHandshakes` settles them at the tick boundary in arrival order
  (`sessionMutationChain` serialises the `crypto.subtle` work so joiners are deterministic); a rejected settle releases its turn, slot and
  connection. Join is late join. `Full` counts attached players; 16 connection slots (`host::MAX_CONNS = warm::MAX_VIEWS`, mirrored in `server.ts`) so a
  silently dead socket's redial does not hit `Full`. The same secret on a second connection supersedes the old one (`Bye{Superseded}`; that
  client does not auto-reconnect).
- **Reconnect is join plus the resume hint**; the host keeps no per-session state. The hint is up to `MAX_RESUME_CHUNKS = 128` `(dx, dy,
  version)` entries relative to the view centre (`session/resume.rs` `build_resume_hint`/`diff_resume_hint`); equal version gives a 3-byte
  `ChunkKeeps` entry, otherwise a snapshot. `epoch` (in the manifest) bumps on every host start over an existing world; a hint from another
  epoch is ignored.
- **Resync is a second `Welcome`** on an attached connection. `client_on_welcome` (`game_instance.rs`) resets replica and overlay only if
  the epoch differs. The pending queue survives: `ClientCore::resend_after_welcome` resends actions above `last_processed_action_seq` and
  reports those at or below it as `Lost` (client-side only, never on the wire).
- **Client link** (`net/link.ts` `createLink`): dead after `DEAD_MS = 3000` without a message or on close; `probe()` (called on
  `visibilitychange`/`online`) with a 1 s deadline; backoff 0, 0.5, 1, 2, 5 s jittered, new socket opened before the old is dropped. Stops
  for good on `Superseded`, `BadKey`, `Full` and `VersionMismatch`. On a version mismatch `client.ts` reloads the page once per build hash;
  otherwise it goes `updating` and builds a new `Link` on the backoff.
- **Grace and idle** (`host/lifecycle.ts`): presence vanishes at once on close (`PresenceRelayOp::Gone`); the logged `Disconnected` waits
  `GRACE_MS = 10 s` (an explicit `Bye` skips it). With nobody connected, ticking stops after `IDLE_MS = 30 s` unless `keepTickingWhenEmpty`,
  then the host snapshots and calls `onIdle`. Ticks are counted, never inferred from wall time.
- **Ack contract on the game side**: ack tracking lives in `PlayerSlot`, so a game must call `put_player` in `on_player(Joined)`, else
  `ack_seq` stays 0 and resend/`Lost` do nothing. Host dedup is a per-connection floor (`ConnSlot::highest_admitted_seq` folded with
  `Store::last_seq`), advanced only on successful admit.

## Prediction and reconciliation ([0012](../decisions/0012-prediction-and-reconciliation.md), [0022](../decisions/0022-entity-ids-and-provisional-ids.md), [0064](../decisions/0064-phase-3-decisions-sync-and-netcode.md))

Rules for code under `predict/` are in [prediction](../../.claude/rules/prediction.md): validate first and write after, `?` on every read,
never encode a provisional id, a predicted status is a hint.

- `ClientCore::on_action` queues an action in `PendingQueue` (`predict/pending.rs`, `Pending`) and predicts it once; after each received
  frame the overlay is reset and every still-pending action is replayed (`predict/predicting.rs` `predict`, `Predicting` reading overlay
  then replica). The overlay (`predict/overlay.rs`) is preallocated vectors; a failed action rolls back by truncating to a mark.
  `predict/diff.rs` (`OverlayDiff`) is the only thing that marks chunks dirty for re-upload.
- `Prediction` is `Applied | NotPredictable | Rejected(R)`. `Unknown` reads (outside the subscription, including any spawn touching an
  unheld chunk) make the action `NotPredictable`: no ghost, still sent. Taint rule: once one action is `NotPredictable`, every later queued
  action is too until it pops (§1). A local `Rejected` is never shown as a rejection; the host's `ActionResults` entry (`Applied |
  Rejected::Game | Rejected::Engine`) is the verdict, and `Lost` covers the reconnect gap. A locally dropped action (decode, out-of-memory)
  gets no result (§11).
- The client runs no tick rules. `w.tick()` under prediction returns the tick stored per pending action at submit time (frozen), so
  replays do not rewrite timers.
- **Two clocks.** Authoritative = `ClientCore::auth_now`: `HostClock`'s estimate of the host tick, never behind the replica's tick (an
  idle world sends a heartbeat only every 500 ms, so the latest frame tick stands still for 10 ticks). Predicted = authoritative + lead.
  `clock/lead.rs` `LeadEstimator`: median of the last 8 ack samples (`ack.tick - auth_now` at dispatch), clamped to 1..=40 ticks, seeded
  `ceil(rtt / tick)` from the `Hello`-`Welcome` RTT, timed from the socket's real `open`. `clock/host_clock.rs` `HostClock` takes the
  windowed maximum offset over 2 s, slews at 10 %, steps only on `rebase()`; while the host stalls (or a test steps it by hand) the
  estimate keeps running ahead until that window clears. The client worker rewrites the clock block every wake. A
  player's own timer bar runs over `duration + lead`: it ends when the authoritative clock reaches a predicted `done_at`
  ([0064](../decisions/0064-phase-3-decisions-sync-and-netcode.md) §2, [0073](../decisions/0073-own-timer-bars-on-the-host-clock.md)).
- **Provisional ids.** Real `EntityId`s are allocated only by the host, monotonic, never reused. `Predicting::spawn` returns an id with
  bit 31 set from the pending action's `seq` and spawn index, identical on every replay (`EntityId::is_provisional`). Actions address
  anything the sender may have predicted by tile (`entity_at`), never by id. `Replica::entity` returns `Err(Unknown)` for an unseen real id
  and `Ok(None)` for a provisional one (§4).
- Known gap: prediction runs `G::apply` in the client `.wasm`, so a panicking `apply` traps the client; only the generic client re-`Hello`
  ([0050](../decisions/0050-engine-failure-surface.md)) covers it.

## Presence and interpolation ([0001](../decisions/0001-camera-and-presence.md), [0040](../decisions/0040-interpolation-delay-presence-interval.md))

- `Presence` (`presence.rs`): a game type of at most 32 encoded bytes per sample (`MAX_ENCODED_BYTES`; an oversize sample is dropped and
  counted). The host keeps a `PresenceTable`, relays samples with `age_ticks`, never back to the sender, re-relays a held sample at 1 Hz or
  faster (`refresh_presence`), and sends `Gone` on disconnect. Presence is not logged or replayed.
- `interp/` `InterpBuffer` (`buffer.rs`, depth 8) is shared by presence (`client/remote_presence.rs`) and moving entities: Hermite on
  position and velocity, extrapolation capped at 250 ms, tangents clamped on stale segments (§25). `InterpDelay` (`delay.rs`): adaptive from
  the presence sample interval, initial 250 ms, floor 200 ms, cap 400 ms, slewed at most 10 %, never stepped; jitter window in `jitter.rs`.
  The alpha ramps to 0 over `FADE_MS = 500` after `SILENCE_LIMIT_MS = 2000` of silence; since the host re-relays held samples, that fires
  only on a stalled link, and a connected but silent remote never fades (§24). The delay holds at 250 ms until `MIN_SAMPLES = 8` jitter
  samples arrive, and `rebase()` resets it.

## Integrity and desync ([0013](../decisions/0013-sessions-and-integrity.md), [0064](../decisions/0064-phase-3-decisions-sync-and-netcode.md) §19)

- What can drift is the authoritative replica; prediction mismatches heal by design and are never hashed. `integrity.rs` defines the
  hashes (`chunk_hash`, `global_hash`, `player_hash`) both `Host` and `Replica` call: `Fnv64` over `encode_chunk`, the canonical snapshot
  encoding with `version` written as 0.
- `host/hashes.rs` `HashSchedule`: production mode sends one chunk entry per 4 ticks (recently modified first, every 4th pick round-robin)
  and `Global` + `OwnPlayer` every 5 s, riding frames that go out anyway (max 4 per frame). `HashMode::All` (the test default, announced by
  `WELCOME_HASH_ALL`) hashes every subscribed chunk on every frame.
- The client hashes its replica right after applying the frame. On mismatch it sends `ResyncChunk` (reserved coordinate `(i32::MIN,
  i32::MIN)` means `Global` + `OwnPlayer`); the host resends a snapshot through the chunk bucket; both sides record a `DesyncReport` in a
  16-entry ring. The client reads it through `src/desync.ts` (`client.onDesync`); chunk mismatches dump both encodings to
  `test-results/desync/` in the netcode harness.

## Other pieces
- `host/warm.rs` `Warm`: one view per connection slot (`MAX_VIEWS = 16`), feeding the chunk warmer. `host/measure_diff.rs` (feature `measure-diff`, never shipped) counts what byte-diffing puts would save.
- `src/ring-connection.ts` is the sim worker's `Connection` over the SAB ring pair; `src/worker/client-net.ts` is the client worker's end (downlink into `on_frame`, `client_poll_uplink` to uplink).
- Host persistence: `host/persistence.ts`, `host/recovery.ts`, `host/upgrade.ts` (log and snapshots, trap retry, snapshot upgrade); see [persistence](persistence.md).

## Tests

- Rust unit and golden tests sit beside the code; `tests/no_alloc_wire.rs`, `no_alloc_interp.rs`, `no_alloc_connection.rs` and `predict`
  fixtures (`packages/engine/fixtures/predict`, `pnpm test rust -t predict`) prove zero-allocation. Goldens are written only by `pnpm
  golden`.
- The `netcode` suite (`packages/engine/tests/netcode/`, registered in `scripts/suites.mjs`; see its `CLAUDE.md` for the harness,
  `assertBudget` and desync tooling) drives the real server and `HeadlessClient`s over a seeded conditioned link on a virtual clock.
  Hash-all is its default, so every scenario is also a replication test. The `ws` scenarios (real sockets through `ws-connection.ts`) are
  `@slow`; the remote fade is `tests/browser/remote-fade.spec.ts` (`browser` suite). Commands:
  [run-tests](../../.claude/skills/run-tests/SKILL.md).
