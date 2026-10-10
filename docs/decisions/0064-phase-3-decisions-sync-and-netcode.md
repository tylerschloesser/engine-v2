# 0064: Phase 3 decisions: sync, prediction and netcode

Status: Accepted (2026-10-10). Amends [0012](0012-prediction-and-reconciliation.md) (Consequences: taint
rule, own-timer gap, lead estimation, `entity(id)` Unknown, "Remote motion" tangents),
[0004](0004-action-timing-and-rejection.md) (rejections not logged), [0011](0011-wire-format-and-deltas.md)
"Versions instead of acks", [0013](0013-sessions-and-integrity.md) (hash cadence, resync, fade) and
[0022](0022-entity-ids-and-provisional-ids.md) §7. Captured at the Phase 3 to Phase 4 handoff (M39b) from decisions
that were made inside milestone briefs (M12 to M39ai) and would otherwise be lost when the briefs are deleted.

## Context

Phase 3 built prediction, sessions, reconnect, presence, pacing and desync hashes. Several items that
ADRs 0001, 0004, 0011, 0012 and 0013 list as "deferred" were settled in code, and a number of choices
(each cheap to re-litigate) were never written down. This ADR records them in one place, grouped by
topic. Entries state what the code does today.

## Decision

### Prediction

**1. Taint rule R1 (settles 0012 "Deferred to Phase 3").** Once an action is `NotPredictable`, every
action queued behind it is `NotPredictable` until the tainting one is popped. `ClientCore::on_action`
applies it at dispatch without calling `predict`, and the action is still sent to the host. Selection rule:
zero contradicted verdicts first, then fewest lost predictions. R0 (no taint) gave 4 contradicted verdicts
per dependency scenario, because a later action predicted without the declined one's effects is rejected
locally while the host accepts. R2 (taint on read-set overlap) is unsound by construction: a declined
action stops at its first `Unknown`, so its overlay is empty and nothing overlaps. R1 loses 4 predictions
on the independence scenario; accepted. No code keeps R0 or R2.

**2. Own-timer completion gap: stretch (settles 0012; Tyler's Q10, 2026-09-19).** A timer bar runs over
`duration + lead`, so it fills when the host's result can arrive rather than filling on time and waiting.
Measured gap: 0 ticks, against `lead` ticks for the plain predicted clock (delays 0, 1, 3). The cost is a
bar about 7 % slower for a 2 s timer at 150 ms. On loopback the unstretched bar was full 112 to 517 ms
before the result (median bar 1550 ms), the exact "bar full, result waiting" failure. The formula uses
`effective_lead = lead - correction` in both terms; the brief's literal `done_at - correction` leaves a
k-tick jump at the ack. Rejected: opt-in predicted expiry, because it is a client-side tick rule.
The device check's timer tolerance (100 ms, one 20 Hz tick plus two frames) is a measurement resolution,
not a pass number.

**3. Lead estimator and host clock (settles 0012 lead estimation).** Lead is the median of the last 8 ack
samples (`ack.tick - auth_tick_at_dispatch`: pure tick arithmetic, no wall clock), clamped to 1..=40
ticks, seeded `ceil(rtt/tick) + 1` from the `Hello`/`Welcome` RTT. Median over mean because one outlier of
40 moved the mean. `HostClock` samples every arriving frame, takes the maximum offset over a 2 s window and
slews at the 0010 dilation limit, never stepping except `rebase()` (and once on the first real host tick,
so a late joiner does not lag by host-tick/10). Reason it samples every frame: idle ticks send no frames,
so a clock that only steps on frames would freeze bars for up to a heartbeat.

**4. `entity(id)` distinguishes unknown (amends 0022 §7, settles 0012).** `Replica::entity` returns
`Err(Unknown)` for an unseen real id and `Ok(None)` for a provisional id; `Predicting::entity`
short-circuits provisional ids before asking its base. `View::entity` stays unchanged: it serves the
host-total reading (a despawned id must stay `Ok(None)`; an authoritative host has no "Unknown") as well
as the client subscription reading. The change flipped three older tests from `Ok(None)` to
`Err(Unknown)`, caught only by a workspace-wide run.

**5. The reference game predicts every action.** `RefGame::predict` is `true` (only the `test-hooks`
poison craft opts out), including `FurnaceTake`. The collect button for a resource under a predicted
furnace stays until the placement is acked (one round trip), because the in-range list reads the
confirmed replica and a predicted status is a hint; a `StartCollect` in that window is refused by the host.

### Actions, acks and admission

**6. Ack contract needs `put_player` (a game-author contract).** Ack tracking lives in `PlayerSlot`, so a
game must call `put_player` in `on_player(Joined)`; otherwise `ack_seq` and `last_processed_action_seq`
stay 0 and resend and `Lost` do nothing. Rejected: an engine-tracked per-connection seq outside
`PlayerSlot` (changes `Store`'s canonical encoding for every game, re-blesses every golden), and the
engine creating the slot (`G::Player` has no `Default` bound; adding one is a `Game`-trait change with the
same blast radius). Every fixture already does it.

**7. Acks are engine-only deltas.** `Delta::Ack { who, seq }` and `Delta::Roster` exist only inside the
engine. `Ack` is applied straight to `Store` via `Authority::record_ack`, bypassing the `ChangeLog`, so it
never appears in a client-facing frame (0004 delivers acks on their own channel). Every exhaustive `match`
over `Delta` in the frame builder has an explicit empty `Ack` arm with a stated reason, never a catch-all.
`Delta::Roster` with no player slot is a silent no-op (apply stays infallible and idempotent).
`Store::next_entity_id` tracks `max(applied id) + 1`, so replay reproduces ids.

**8. Id conventions.** `PlayerId(conn + 1)` (0 means "none", so `connect` cannot map conn 0 literally).
`PlayerId` shares `EntityId`'s 0 = none but not its bit-31 provisional rule. On the client `own_player` is
`PlayerId(0)` until `Welcome` supplies it (`Replica::set_own_player`). Chunk version defaults to 0 on both
sides (absent in `Host`, inserted at 0 by `apply_enter_pristine`).

**9. Host dedup is a per-connection floor.** `ConnSlot::highest_admitted_seq` advances only on a
successful admit and is folded with `Store::last_seq` via `max`. A single snapshot taken before the batch
let a resend that arrived before the first copy applied double-apply (`Bump` totalled 10, not 5).
Admission-time rejects do not advance it: a rejected `seq` is never logged, so a resend is safe.

**10. Admission rejections leave the action pending (amends 0004).** Admission-time rejections (rate limit
20/s burst 40, `RateLimited`) are unlogged and do not move `ack_seq`, so the client's pending queue keeps
the action until a later accepted action is acked, and `dispatch` refuses past 32 pending. A rate-limit
test must send only what the queue lets it.

**11. A locally dropped action produces no result.** A ring record that fails `on_action` (`Decode`,
`OutOfMemory`) gets no `onActionResult` and no synthesised `Rejected`: `Rejected<G>` is a host-only verdict
(0004). The drop is counted via `RingConsumer.recordDrop()` into the ring's `drops` counter; `main`'s
`dispatch` already enforces outbox capacity synchronously, so the ring backstop is defence in depth. Do not
"fix" the silent drop by faking a `Rejected`. Known gap: a `seq` dropped this way never resolves on
`main`; a local-rejection path would belong with the pending queue and is not built.

**12. `poll_uplink` bypasses pacing for actions.** Whenever the outbox holds an action, `poll_uplink`
ignores 0010's pacing (at most one batch per 50 ms, at least one per 1 s): an action's latency budget (0004:
one tick plus network) has no room for a floor. A judgement call; revisit if rate limiting finds rapid-fire
dispatch too permissive. Observed, never investigated: a batch about every 50 ms right after a camera move,
at odds with 0010's "send only on change".

**13. Typed fast path not built.** A typed fast path or quantized deltas for continuous action streams is
neither built nor scheduled (no planned game sends an action every tick). Uplink flag bits 2 to 7 stay free
for a future stream record; revisit when a game sends an action every tick, with its own ADR. 0001 and 0004
still say "deferred".

### Reconnect, resync, versions

**14. Resync is a second `Welcome` (amends 0013 and 0024 §8).** A second `Welcome` on an attached
connection is the resync signal (no new message type). The epoch lives in the manifest and bumps on every
host start over an existing world, not only after `recover()`. `client_on_welcome` resets replica and
overlay only when `welcome.epoch` differs, so a same-epoch reconnect keeps chunks and the 3-byte "keep"
resume works. The pending queue is never cleared: unacked actions are resent and those at or below the ack
seq are reported `Lost`. `onRecovered` is wired per call site, not as a default (a blanket default silently
changed callers that build a raw `SimHost`).

**15. Cross-device recovery not built.** "Copy my player link" is deliberately absent (no cross-device
recovery is the Requirement). Cheap to add: the secret has one accessor (`loadOrMintSecret`), the invite
fragment `#k=<joinKey>` parser ignores unknown parameters (so `&p=<secret>` can be added), and `exportWorld`
already carries the session table. Revisit when Tyler asks or on the first real identity loss.

**16. `WorldMismatch` has no reload policy.** A client that reaches `WorldMismatch` shows `onLink`
`rejected` with reason `WorldMismatch` (0042 deferred the reload policy and the check for a client
configured at `engine_init`; that is still open). No end-to-end test exists; it needs a netcode scenario
that restarts a server on another seed.

**17. `chunk_versions` is never pruned (amends 0011).** `Host::chunk_versions` (`BTreeMap<ChunkCoord, u32>`)
keeps one permanent entry (about 26 B) per chunk ever touched by a replicated write. The version is
host-global and feeds the resume diff and the snapshot `version`; the entry is dwarfed by the state those
writes leave, and pruning would read back as 0 and force a needless re-snapshot on resume. It grows faster
than world state (half the keys in the pan workload are chunks whose replicated state is empty). Accepted
ceiling: at most 88 B per newly reached chunk, asserted by
`host_and_client_panning_allocates_per_new_chunk_not_per_tick`; a bounded camera must show exactly zero
per-tick growth. Revisit only if a world's touched-chunk count outgrows its state budget.

**18. Resume cannot produce a wrong keep (amends 0011 "Versions instead of acks").** The host stamps every
scope chunk of every write with the completing tick; a replica's version comes only from a snapshot's wire
version or a frame-tick bump, so it is always lower than the host's for a changed chunk. A stale replica
version can only cause an over-snapshot. The host is the reference (the replica must match what it was
sent, not the reverse); over-bumping shows as a reverse `region_hash` mismatch and extra re-snapshots,
never wrong content.

### Desync hashes, pacing and degrade (amends 0013)

**19. Hash cadence.** A due hash never forces a frame: entries ride the next frame sent anyway (a heartbeat
included), at most 4 per frame, so an idle world stays at heartbeat rate and hashes cost 63 B/s per client
(forcing frames measured 67 B/s and changed 14 byte-pinned tests). Every 4th pick is round-robin even when
modified chunks keep arriving, so a quiet corrupt chunk cannot starve. The snapshot `version` is hashed as
0, because the host stamps every footprint chunk while a replica bumps only the anchor and a pristine enter
leaves the replica at 0. Default mode is `Production` (host, ABI, `games/reference-server`); the harness
defaults to `All`. Byte budgets must be measured with production hashing (adds 63 to 69 B/s). Not built:
the Vite dev server turning hash-all on, and a browser `engine.log` first-differing-offset line.

**20. Degrade cannot bring a client under the soft cap.** `window_sum` counts built-frame bytes and
bundling saves only the 10 B header per frame, so an over-cap client stays at level 4 while its traffic is
unchanged; only delta collapse cuts bytes. Relief is byte diffing, kept as a non-API option by 0048 §6 and
not built.

**21. Per-tick pacing cost is not O(1) per client (known limit).** The drain re-encodes the head chunk
through `CountSink` every tick it is unaffordable (about 100 ticks per dense chunk), the collapse pass
counts a snapshot for every chunk with a delta every tick, and `queue.remove(0)`, `queue_position` and the
insertion sort are linear or quadratic in queue length (113 to 275 observed). The fix named at the time,
caching the head cost and per-chunk snapshot length, was not built (no such cache in `host/pacing.rs`).
Related: the soft-cap collapse (`pending > snapshot_len`) re-snapshots dense chunks, giving about 35.5 KB
per tick at maximum zoom-out on the large save, which is why frame build is 29 % of the desktop pass.

**22. Frame overflow loses other deltas (known limit).** When a frame overflows the `SliceSink` the host
undoes it (tokens refunded, newly held chunks re-queued, each consecutive overflow halves the next chunk
budget so it cannot livelock), but the frame still loses the deltas of other held chunks and its tile and
entity ops. It takes a first chunk over 64 KiB or an unbounded delta section to hit; hash-all in a
121-chunk world did not trip it.

### Presence and remote motion

**23. Presence design (beyond 0001/0024).** No replay track: replays show no avatars and nothing is
reserved in log or snapshot formats (a track would be a separate storage key fed from
`PresenceTable::on_sample`). The 32-byte cap is checked per encoded sample (postcard varints make size
value-dependent); an oversize sample is dropped and counted. "On change" means encoded bytes differ from
the last sent, so a resting sample needs no special case. Every relayed sample carries `age_ticks`, so the
1 Hz re-relay of a held sample is not mistaken for a fresh one by the interpolation buffer. `Gone` entries
tell clients at once because the roster's online flag lags by the grace period. A player's own sample is
never relayed back. The host's world-cap check (`sample.pos().tile().in_range()`) can never reject, since
raw `WorldPos` i32 maps 1:1 onto `[TILE_MIN, TILE_MAX]`; it is correct dead code (test
`world_cap_check_accepts_representable_extremes`), and a reachable rejection would need the check before
narrowing, which the fixed `pos() -> WorldPos` trait signature forbids.

**24. When a remote fades (amends 0013 and 0040).** A connected but silent remote never fades: the host
re-relays held presence samples at 1 Hz or faster (`refresh_presence`), so 0013's "silent drop fades after
about 2 s" fires only when the relay stops (a stalled link). A clean close sends `PresenceRelayOp::Gone`
and the circle vanishes at once (116 to 215 ms measured), so the device check asserts "vanishes within
1000 ms", not a fade. The real fade is covered by `remote-fade.spec.ts` with a TCP proxy holding
server-to-client traffic for 2.6 s (below `DEAD_MS` 3000); CDP network emulation could not reproduce a
silent drop headless.

**25. Remote-motion tangent clamp (M39ab, amends 0012 "Remote motion").** A remote at rest holds one old
sample, so on the first new sample `render_t` sits at u of 0.95 to 0.99 of a very long segment and the
cubic Hermite drew the circle up to about 1 tile behind `b.pos - V*delay` (-1.094 tiles on the Pixel),
then glided forward. Chosen: clamp each end's tangent per axis, `|h*v| <= 3*|delta|` (Fritsch-Carlson),
only for stale segments (longer than the extrapolation cap), in `InterpBuffer::sample`. Rejected: a
relay-interval constant treating a long segment as starting from a synthetic rest sample (needs a
constant), and a first version clamping every segment, which zeroes the tangents of a flat segment and
fails rest-then-walk. An ordinary 10 Hz walk is bit-identical to the unclamped curve. Side effect: the
returned velocity across a clamped knot is not C1 (only `pos` is drawn).

### Server

**26. `accept()` can stall the attach queue (known bug, unfixed).** In `server.ts` `accept`, if
`hashSecretHex` or `sessions.save()` rejects, the attach-queue slot is never filled and every later
`Hello` stalls at `pumpHandshakes`. Fix with the next change to `accept()`.

## Alternatives rejected

Stated inline per entry (taint R0/R2, predicted expiry, engine-tracked seq, faked `Rejected`, forced hash
frames, pruned `chunk_versions`, whole-segment tangent clamp).

## Consequences

- 0012's "Deferred to Phase 3" taint bullet and the "Deferred to Phase 2" own-timer and lead-estimation
  bullets are settled by §1 to §3. The other 0012 items (provisional ids, overlay change list, undo journal)
  are out of scope here.
- Open and unbuilt: §11 local-rejection path, §13 typed fast path, §15 player link, §16 reload policy, §20 to
  §22 pacing limits, §26 `accept()` stall. Each states its own trigger to revisit.
- A prediction trap in client `.wasm` is covered only by 0050's generic client re-`Hello`; whether a
  `G::apply` panic during prediction should report `NotPredictable` instead is undecided.

## Sources

Milestone briefs M12 to M39ai (deleted in Phase 4); measurements are those quoted inline. Code checked
2026-10-10: `client/core.rs`, `clock/lead.rs`, `interp/buffer.rs`, `host/mod.rs`, `host/hashes.rs`,
`host/pacing.rs`, `src/server.ts`, `src/client.ts`.
