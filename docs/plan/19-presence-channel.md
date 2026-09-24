# M19: Presence channel

Status: done · After: 17 · Tyler-dependent: no

## Goal
A game's `ClientSide::frame` writes a `G::Presence` value every client frame; the engine samples it into the uplink batch, the host keeps it in a `PresenceTable`, hands that table to `G::admit` for witness checks, and relays samples in the frame's Presence section to clients subscribed to the sample's chunk. Verified with a fixture game in the Rust suite and through the single-player worker path; remote samples are exposed raw (snapped), interpolation is M30.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0001-camera-and-presence.md` (Decision: "Presence is an engine channel", "Witness-carrying actions", the soundness paragraph; Consequences)
3. `docs/decisions/0010-rates-and-subscriptions.md` (Rates table rows "Client → host" and "Host drop rule"; the worked presence number)
4. `docs/decisions/0011-wire-format-and-deltas.md` (Frame, Scopes table row `Presence`)
Mine from spikes: none. Rules that apply: `.claude/rules/hot-paths.md`, `.claude/rules/determinism.md`.

## Scope
- Client role: `ClientSide::frame` already runs every client frame (M18 landed `fn frame(&mut self, cx: &mut FrameCx<'_, G>, presence: &mut G::Presence)`, passing a scratch `G::Presence` it discards — M18 Deviations, steps 4-6); make the passed value real and keep it across frames; sample it into the uplink batch under the rate rule of 0010.
- Host role: decode the sample, `PresenceTable<G>`, world-cap check, the call of `G::admit` with the real table, relay and the 1 Hz re-relay, immediate removal on connection loss.
- Presence section content encoding (the section id is M14's).
- Client role: `RemotePresences` store of the newest sample per remote player, exposed through `FrameView`.
- Fixture game `presence` with a witness-carrying action.

## Non-scope
- Interpolation, adaptive delay, fade after silence (M30). Until M30, remote avatars snap to the newest sample.
- `FrameCx` beyond M12's shell: input events in it and `cx.follow` (M18). Persisting the last sample in the session table and sending it in `Welcome` (M28; seam below). Roster and online flag (Global scope, M34). The reference game's spring (M20b).

## Files, packages and crates touched
- `packages/engine/crates/engine/`: new modules `presence` (trait, `PresenceTable`, sampler, `RemotePresences`) and edits to the uplink assembler, frame builder, `on_frame` decoder and the `admit` call site.
- `packages/engine/fixtures/presence/` (new fixture game crate).
- `packages/engine/` tests only (one worker-path test); no new TypeScript in `src/`.

## Seams
**Provides:**
- Fills M12's shells: `trait Presence` exactly as 0001, plus the `Default` bound (see Planning decisions); `impl Presence for ()`.
- `PresenceTable<G>` (M12 shell, owned by `Host<G>`): `get(who) -> Option<&PresenceEntry<G>>` where `PresenceEntry { sample: G::Presence, received_at: Tick }`; `iter()` in ascending `PlayerId`. Engine-internal: `on_sample(who, sample, tick)`, `remove(who)`, `restore(who, sample)` (M28 calls `get`/`restore` for the session table of 0013).
- Presence section entry, in ascending `PlayerId`: `Sample { who: varint, age_ticks: varint, payload: postcard G::Presence }` and `Gone { who: varint }`; `age_ticks = frame.tick − received_at`.
- `RemotePresences<G>` (client): newest `{ sample, sample_tick, arrived_ms }` per remote player; M30 replaces its read side. `FrameView::own_presence() -> &G::Presence` and `FrameView::presences(&mut dyn FnMut(RemotePresence<'_, G>))` with `RemotePresence { who, pos: WorldPos, vel: [i32; 2], sample: &G::Presence, alpha: f32 }` (`alpha` is 1.0 until M30).
- `ClientCore::seed_presence(G::Presence)` (M28 calls it from `Welcome`); `ClientCore::poll_uplink` now carries the sample.
- `testkit::Loopback::set_presence(client, value)` for scripted producers; `engine/test` counter `uplinkPresenceBytes`.

**Consumes:** `Presence`, `PresenceTable`, `FrameCx` shells (M12). The `frame(t_ms)` export and `FrameView` (M17; M18 already added the `ClientSide::frame` call, with a scratch `G::Presence` it discards each frame, and input events in `cx.input()` — M18 Deviations, steps 4-6; this milestone makes the passed presence value persist and matter). `wire::UplinkBatch`/`UplinkWriter`/`UplinkReader` with the presence field and `SectionId` for Presence (M14; if the field was left out, add it and regenerate that golden). `Host::on_uplink`, `Host::build_frame`, `Host::disconnect`, `SubscriptionSet` membership per `ConnId`, `ClientCore`, `testkit::Loopback` (M15); `sim_admit` taking the whole batch (M15b). The `G::admit` call site, which passes `PresenceTable::empty()` until now, and the "not recorded" rule (M16). `Codec` (M05). World coordinate range check (M07).

## Planning decisions
- **Presence as an optional replay track: not built.** Replays show the world without avatars (0001 Consequences). A track would be a separate storage key fed from `PresenceTable::on_sample`, so nothing needs reserving in the log or snapshot formats now. Closes the 0001 deferred item.
- **`Presence` gains a `Default` bound.** The engine must construct the value it passes to `frame` before the game has written one; 0001 gives no constructor. `()` already has it. 0024 §6 adds the bound. M18 already needed a value to build its scratch `G::Presence` and added `G::Presence: Default` as a where-clause on `impl Instance for GameInstance<G>` (matching the existing `Global` precedent), not on the `Presence` trait's own supertraits — reconcile with 0024 §6's literal `trait Presence: Codec + Copy + Default + 'static` before adding a second, possibly redundant bound (M18 Deviations, steps 4-6).
- **The 32-byte limit is enforced per encoded sample** (0024 §6), not at init: postcard varints make the size value-dependent. An oversize sample is dropped and counted (`presence_oversize`, must read 0 in tests).
- **"On change" means the encoded bytes differ from the last sent sample.** The final at-rest sample of 0001 then needs no special case: when motion stops, the resting value differs from the last sent one and goes out in the next slot. A test pins this.
- **`age_ticks` on every relayed sample.** The 1 Hz re-relay of a held sample would otherwise look like a fresh sample at a new time to M30's buffer. One byte.
- **`Gone` entries** implement "tells clients at once" on connection loss; the roster's online flag follows the logged event after the grace (0013) and is too late. On a lossy adapter a lost `Gone` degrades to M30's fade.
- A player's own sample is never relayed back to that player. Presence samples share the camera report's host drop rule (0010).
- Relay is built per client per tick from the table, never queued: a sample is relayed when `received_at` is newer than that client's last relayed tick for that player, or that was ≥ 1 s ago.

## Order of work
1. `Presence` trait, `()` impl, fixture game `presence`: `Presence = { pos, vel }`, `Action::Poke { tile, from }`, `admit` rejects without a sample or beyond a tolerance, `apply` checks `dist(from, tile)` in fixed point (0001 steps 1–2).
2. Client sampler + uplink field; rate and on-change tests with an injected clock.
3. `PresenceTable`, world-cap check, host decode; wire the real table into `admit`.
4. Relay + re-relay + `Gone`; section encode/decode; golden bytes for one Presence section.
5. `RemotePresences` and the `FrameView` accessors; fixture `extract` draws a circle per presence.
6. Worker-path test; zero-GC scene's fixture gains a presence type so the existing allocation test covers the path.

## Tests added
Rust suite (`presence_*`):
- `sampler_rate_and_on_change`: ≤ 10 samples/s while changing, none at rest, final resting sample sent once.
- `admit_witness`: no sample → `Rejected`; beyond tolerance → `Rejected`; inside → recorded and applied; an `admit` rejection leaves the sealed frame's records unchanged (0001 Consequences: `admit` needs its own unit tests).
- `apply_range_is_replayable`: `testkit::run_script` over the recorded script reproduces the hash with an empty `PresenceTable`.
- `presence_is_not_state`: two runs, with and without presence traffic, equal state hashes and equal recorded scripts.
- `relay_recipients`: only clients subscribed to the chunk of `pos()`; never the sender; newest only after a stalled client resumes.
- `rerelay_and_gone`: held sample re-relayed at ≥ 1 Hz with growing `age_ticks`; disconnect produces `Gone` in the next frame.
- `outside_world_cap_dropped`, `oversize_dropped`.
- `presence_section_golden`.
Browser suite: `presence-worker-path`: single-player page, fixture presence reaches the sim worker's table (read through an `engine/test` hook) with `drops == 0` on both rings.

## Exit criteria
- [x] Every test above passes; the Presence golden is checked in.
- [x] `PresenceTable` appears in the signature of `admit` only; a compile-fail doc test shows `apply` cannot name it.
- [x] The zero-GC test still passes with the presence-enabled fixture.
- [x] `uplinkPresenceBytes` while changing every frame is within the budgets-file ceiling added below.
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t presence` · `pnpm test browser -t presence-worker-path` · `pnpm test browser -t zero-gc` · `pnpm test && pnpm lint`

## Budgets
- Bandwidth per client, steady, up (0010): new `budgets.json` key `uplink_presence_bytes_per_s`, measured by `sampler_rate_and_on_change`.
- Allocation per isolate, client and sim workers (0016): the existing zero-GC test with the presence fixture.

## Context artifacts
Extend the engine crate's nested `CLAUDE.md` with one line: presence types never enter `Store`, the log or a hash. No new rule file or skill.

## Manual device checks
none

## Deviations
(steps 1-3 only; steps 4-6 -- relay, re-relay, `Gone`, section encode/golden, `RemotePresences`/
`FrameView` accessors, the worker-path browser test, the zero-GC fixture -- are a later cut)

**Seam shapes for the next cut, exactly as landed:**

- **Trait**: `pub trait Presence: Codec + Copy + Default + 'static { fn pos(&self) -> WorldPos; fn
  vel(&self) -> [i32; 2]; }` at `crates/engine/src/presence.rs`, re-exported as `engine::game::
  Presence` (`game.rs`'s own `pub use`, same pattern as `TickCx`/`FrameCx`). `impl Presence for ()`
  is there too. `MAX_ENCODED_BYTES: usize = 32` is `crate::presence::MAX_ENCODED_BYTES` (also
  re-exported nowhere else -- reach it via `engine::presence::MAX_ENCODED_BYTES`, not `engine::
  game::MAX_ENCODED_BYTES`, since only the trait and the table themselves are re-exported into
  `game.rs`, not every constant in the module).
- **`PresenceTable<G>`**, same file, re-exported as `engine::game::PresenceTable` (and
  `PresenceEntry`, newly re-exported there too): `PresenceEntry<G> { pub sample: G::Presence, pub
  received_at: Tick }`; `pub fn empty() -> Self`; `pub fn get(&self, who: PlayerId) -> Option<&
  PresenceEntry<G>>`; `pub fn iter(&self) -> impl Iterator<Item = (PlayerId, &PresenceEntry<G>)>`
  (ascending, `BTreeMap`-backed); `pub fn on_sample(&mut self, who: PlayerId, sample: G::Presence,
  received_at: Tick)`; `pub fn remove(&mut self, who: PlayerId)`; `pub fn restore(&mut self, who:
  PlayerId, sample: G::Presence)` (stamps `Tick(0)` -- no tick is known at a session-table restore
  site with this two-argument signature; M28 may need to revisit if `Tick(0)` reads badly through
  steps 4-6's `age_ticks` relay math). `on_sample`/`remove`/`restore` are plain `pub`, not `pub(crate)`
  or feature-gated: "engine-internal" here is a doc-comment convention (matching `TickCx`'s "HOST
  ONLY" precedent), not a visibility boundary -- the actual guarantee ("presence never enters
  `Store`/log/hash") is structural, from `apply`/`tick`'s fixed signatures never naming
  `PresenceTable` at all (proved by the compile-fail doc test on `PresenceTable` itself). The table
  lives on `Host<G>` as a private field `presence: PresenceTable<G>` (one per world, not per
  connection, keyed by `PlayerId` so it survives reconnect the way `Store::last_seq` does); a
  `#[cfg(any(test, feature = "testing"))] pub fn debug_presence(&self, who: PlayerId) ->
  Option<G::Presence>` exists for tests (no production accessor yet -- steps 4-6's relay is the
  first real reader beyond `admit`).
- **Wire**: used exactly as `wire/CLAUDE.md` already had it (uplink `flags` bit 1 "presence",
  `presence (len varint + bytes)`); no second field added, nothing changed there.
- **Client's persistent `G::Presence`**: `ClientInstance<G>`'s own field, `presence: G::Presence`
  (`crates/engine/src/game_instance.rs`), constructed once at `init` with `G::Presence::default()`
  and destructured alongside `core`/`client`/etc. in `frame()`. `client.frame(&mut cx, presence)`
  writes it; `core.set_presence(presence)` is called *after* `client.extract(&view, ..)`, not
  right after `client.frame`, because `view` (built from `core.view()`) borrows `core` immutably
  for its own entire lifetime and `set_presence` needs `core` mutably -- the sample is still the
  same value written earlier in the call, `set_presence` is just deferred past `view`'s last use.
- **`ClientCore::poll_uplink`'s sampler state** (`crates/engine/src/client/core.rs`):
  `presence_encoded: [u8; MAX_ENCODED_BYTES]` + `presence_len: usize` (this frame's latest encoded
  sample, kept live by `set_presence`), `last_sent_presence: Option<([u8; MAX_ENCODED_BYTES],
  usize)>` + `last_presence_sent_ms: Option<u32>` (the last one actually *sent*). `set_presence(&mut
  self, sample: &G::Presence)` encodes eagerly; a `set_presence` encode failure (oversize for
  *this* client's own `Default`, not expected in practice) silently keeps the previous
  `presence_encoded`/`presence_len` rather than corrupting them. `PRESENCE_MIN_INTERVAL_MS = 100`
  (10 Hz) is independent of and additional to the existing `MIN_UPLINK_INTERVAL_MS`/
  `KEEPALIVE_INTERVAL_MS` camera/batch pacing -- camera relies on the 50 ms batch floor plus the
  host's own drop rule (0010 "Host drop rule"); presence has no host-side drop rule, so the client
  enforces its own ceiling.
- **Counters added**: `host::ConnCounters::presence_oversize: u64` (per connection, cumulative) --
  bumped on `Host::on_uplink` whenever a carried presence sample's encoded bytes exceed
  `MAX_ENCODED_BYTES` *or* fail `decode_canonical`; both failure modes fold into this one counter
  (not split into "oversize" vs. "malformed" -- both are "sample dropped for an encoding problem").
  Live in production: every real `Host` reaches this from `on_uplink`, not only tests. No other new
  counter; `uplinkPresenceBytes` (Provides, an `engine/test` browser-side counter) is **not**
  built in this cut -- it needs the worker-path browser test (step 6) to have anywhere to be read
  from, so it is left for that cut.
- **`budgets.json`**: new key is `counters.presence.uplinkBytesPerSec` (camelCase, matching this
  file's own `counters.<category>.*` convention -- `counters.subscription.*`, `counters.action.*`),
  not the brief's literal snake_case `uplink_presence_bytes_per_s`. **Gate round 1 fix**: the first
  cut counted whole `UplinkBatch`es (129 B measured, ceiling 320) although the counter's own name
  and the row's own formula claimed only the presence field -- the ~8 B/batch of
  type/flags/tick/action-count/camera-absent framing was uncounted-for slop hiding inside both
  numbers. Re-scoped to the presence field alone (`len varint + payload`, matching the wire's own
  `presence (len varint + bytes)` framing): `sampler_rate_and_on_change` now sums only that, measuring
  59 B/s at its own small test coordinates; ceiling is `33 x 10 = 330` (1-byte len varint, always
  exactly 1 for any payload `0..=32`, plus 0001's own 32-byte per-sample cap, at 10 Hz) -- the worst
  case the `Presence` trait itself allows at any coordinate, not a measured-plus-margin guess. The
  test compares its own measured figure against this exact `budgets.json` key via `engine::testing::
  budgets::expect_within_budget`, never a constant in the test.
- **`seed_presence`**: **not built.** The brief's own Provides lists `ClientCore::seed_presence(G::
  Presence)` "(M28 calls it from `Welcome`)" -- genuinely M28's own call site (the session-table
  restore path), nothing in steps 1-3 needs it, and adding an unused public method now would be
  seam surface with no caller to keep honest. `PresenceTable::restore` (above) is the host-side
  half of the same M28 feature and *is* built, since step 3's own Order of work item names it
  explicitly ("PresenceTable<G> (with on_sample/remove/restore/get/iter)").

**Test-filter nuance for the next session**: `pnpm test rust -t presence` (a bare nextest substring
filter) matches only the leaf test *function* name, not the crate/binary id -- it catches
`presence_is_not_state`, everything under `engine::presence::tests`, and `engine::wire::uplink::
tests::roundtrip_*_presence` (10 tests), but **misses** `admit_witness_*`, `apply_range_is_
replayable`, `sampler_rate_and_on_change`, `oversize_dropped`,
`world_cap_check_accepts_representable_extremes`, `well_formed_undersize_presence_is_recorded` and
the two `dist_sq`/`within` unit tests -- everything in `fx-presence` whose function name doesn't
literally contain "presence". Verified instead with `cargo nextest run --workspace -E
'package(fx-presence) or test(presence)'` (15 tests in `fx-presence` alone, all pass) and a full
unfiltered `cargo nextest run --workspace` (355 tests, all pass, nothing else moved).

**World-cap check: implemented, but its own "dropped" case cannot be made to fail honestly** --
escalating for the orchestrator/Tyler to weigh in on. `Host::on_uplink` checks `sample.pos().tile
().in_range()` (0007 §2's `TilePos::in_range`) before `PresenceTable::on_sample`, exactly reusing
the Consumes item "World coordinate range check (M07)". But `Presence::pos()` returns `WorldPos`,
whose raw `i32` fields map 1:1 onto `[TILE_MIN, TILE_MAX]` once floored to a tile -- `docs/plan/
07-world-model-core.md`'s own Deviations already says this exact thing ("the raw i32 already covers
[TILE_MIN, TILE_MAX] 1:1 ... so only a wider intermediate (movement math before it's clamped) can be
out of range"). There is no `i32` bit pattern a `WorldPos` can hold whose `.tile()` fails
`in_range()`: `i32::MIN`/`i32::MAX` map to exactly `TILE_MIN`/`TILE_MAX`. So for *any* conforming
`Presence` implementation (whose `pos()` must return a real `WorldPos`), this check structurally
cannot reject a sample -- it is correct, defensive, dead code today. **Gate round 1 fix**: renamed
`outside_world_cap_dropped` to `world_cap_check_accepts_representable_extremes` in `tests/
presence_host.rs` so its name matches what it actually asserts (it cannot fail on a drop path by
construction -- there is no byte pattern that reaches that arm -- but it does have its own real
inject-fail-revert on the *accept* arm, see below). If a future milestone wants a genuinely reachable
rejection here, the check likely needs to move to a place that still holds a wider intermediate
(before narrowing into `WorldPos`), which the `Presence` trait's fixed `pos() -> WorldPos` signature
does not expose.

**Measured**: `sampler_rate_and_on_change`'s own phase A (continuously changing sample, one client,
polled every 10 ms for one second) sends exactly 10 presence-carrying `UplinkBatch`es (the 10 Hz
ceiling, never more), totalling 59 B of presence-field-only bytes (gate round 1 re-scoping, see the
`budgets.json` entry above); the final at-rest value is sent exactly once more, then nothing further
for the next 490 ms polled. `presence_oversize` reads 0 across every test that sends only
well-formed samples (`well_formed_undersize_presence_is_recorded`), confirmed 1 for a genuinely
oversize (36-byte, `WidePresence`) payload (`oversize_dropped`).

**Failability proofs (gate round 1), one inject-fail-revert per test, each performed and reverted
in this session; none is checked-in code -- every line below is a report of what was actually run**:

- `sampler_rate_and_on_change` (`client/core.rs`'s `presence_due`): injected `fn presence_due(&self,
  _t_ms: u32) -> bool { true }` (sends on every poll, ignoring on-change and the 10 Hz rate) -->
  `assert_eq!(sent, 10)` failed (`left: 20, right: 10`); reverted. Covers the "sending on every
  poll"/"ignoring on-change" branch pair (both collapse to the same over-count under this
  injection).
- `admit_witness_beyond_tolerance_is_rejected` + `admit_witness_no_sample_is_rejected`
  (`fx-presence`'s `Presence::admit`): injected `Ok(())` unconditionally (ignores both the
  `NoSample` and `TooFar` checks) --> both failed (`left: 1, right: 0`, `poke_count` wrongly
  incremented); `admit_witness_inside_tolerance_is_recorded_and_applied` correctly still passed
  (a true positive is not this injection's job to break); reverted.
- `apply_range_is_replayable` (`fx-presence`'s `Presence::apply`): injected a `static
  AtomicI64` call counter, forcing `OutOfRange` once the process-wide count reached 2 (simulating
  `apply` depending on state outside the action's own bytes -- impossible for real, since `apply`'s
  signature cannot name a `PresenceTable`, so this stands in for "any external dependency", not
  presence specifically) --> `assert_eq!(hash1, hash2)` failed (two different hashes, since the
  second `run_script` call inherited the first's tainted counter); reverted.
- `presence_is_not_state` (`host/mod.rs`'s `on_uplink`, the accepted-sample arm): injected an
  extra `self.pending_records.push(Record::Player { who: player, ev: PlayerEvent::Joined })`
  alongside `self.presence.on_sample(..)` (a `Joined` re-push resets `poke_count` to 0 via `Presence
  ::on_player`, generic enough to need no game-specific write) --> `assert_eq!(with_presence.hash,
  without_presence.hash)` failed (`with_presence`'s 20 extra presence-only uplinks each reset its
  state, `without_presence`'s did not); reverted.
- `oversize_dropped` (`host/mod.rs`'s `raw.len() > MAX_ENCODED_BYTES` gate): first injection attempt
  (delete the gate, decode unconditionally) against the *original* test (33 zero bytes) did **not**
  fail -- `decode_canonical`'s own trailing-bytes rejection caught the garbage independently of the
  size gate, since no genuine `PlayerPresence` encoding can reach 33 B (worst case 16 B) to begin
  with. Per "fix the test, not the injection": rewrote the test around a new local `WidePresence`
  (`pos`/`vel` plus a fixed `[u8; 32]` `padding` field, always >= 36 B when genuinely, validly
  encoded) and its own minimal `WideGame`. Re-ran the same injection against the fixed test -->
  `assert_eq!(presence_oversize, 1)` failed (`left: 0, right: 1`) and `debug_presence` returned
  `Some` instead of `None`; reverted.
- `well_formed_undersize_presence_is_recorded` (`host/mod.rs`'s `decode_canonical::<G::Presence>
  (raw).ok()` call): injected forcing it to `None` unconditionally --> `assert_eq!(presence_oversize,
  0)` failed (`left: 1, right: 0`); reverted.
- `world_cap_check_accepts_representable_extremes` (`host/mod.rs`'s `sample.pos().tile().in_range()`
  guard): injected replacing the guard with the literal `false` (never accepts) --> `debug_presence`
  returned `None` for both `i32::MIN` and `i32::MAX` instead of `Some(sample)`, failing; reverted.
  (This is the accept-arm proof the check's own doc comment above promises; the reject arm has no
  possible injection, by the same structural argument.)

**Not built (left for the next cut, per the brief's own step split)**: relay, re-relay at >= 1 Hz,
`Gone`, the Presence section's own encode/decode and golden, `RemotePresences`, `FrameView::
own_presence()`/`presences()`, the `presence-worker-path` browser test, the zero-GC fixture's own
presence type, and `testkit::Loopback::set_presence`.

## Deviations (steps 4-6)

**Wire, `wire/presence.rs`** (section id 8, `wire/CLAUDE.md`): a flat entry list to the section's
own end, ascending `PlayerId`: `who varint · tag u8 (0 Sample, 1 Gone)`, `Sample` continuing
`age_ticks varint · Codec G::Presence` with no length prefix of its own (the codec's own decode
boundary is exact, matching every other game-typed wire value). `write_presence`/`read_presence`
are the shared, tested definition; `Host::build_frame` does **not** call `write_presence` on its
own hot path -- it writes the identical bytes from its own flat, already-sorted `Vec<(PlayerId,
PresenceRelayOp<G>)>` scratch buffer through a hand-written `write_presence_flat` (`host/mod.rs`),
mirroring the existing `write_chunk_deltas_flat` precedent, to avoid building a temporary
`Vec<wire::PresenceOp>` every tick (`.claude/rules/hot-paths.md`'s steady-state convention).
`presence_section_golden` (one `Sample` + one `Gone` entry) blessed via `pnpm golden:bytes`; no
existing golden moved (confirmed: `git status` after a full `pnpm golden:bytes` run showed only
that one new `.hex` file).

**Relay algorithm, `Host::build_frame`**: per connection, per tick, from `PresenceTable::iter()`
(never queued): skip the sender's own player; skip a player whose chunk (`chunk_of::<G>(sample
.pos().tile())`) this connection is not subscribed to; otherwise relay when `entry.received_at` is
newer than `ConnSlot::presence_relayed[who]` (a fresh sample) or `self.last_tick -
presence_relayed[who] >= G::TICK_RATE.hz_value()` (>= 1 Hz re-relay of a held sample), with
`age_ticks = self.last_tick.saturating_sub(entry.received_at)`. A second pass over `ConnSlot::
presence_relayed`'s own keys with no matching `PresenceTable` entry emits `Gone` (fires exactly
once: `Host::disconnect` now removes the table entry immediately, not on the next `tick()`).
Both passes feed one `Vec`, sorted ascending by `PlayerId` with the existing `insertion_sort_by_key`
helper, before writing section 8 -- so a tick whose *only* change is a presence relay must still be
counted in `build_frame`'s "nothing to say" early-return guard (added `&& self.scratch_presence
.is_empty()`), or it would incorrectly return 0 and silently drop the relay.

**Counters**: `ConnCounters::presence_bytes_up` (new `u64`), bumped in `Host::on_uplink` only on
the accepted-sample arm (`self.presence.on_sample(..)`'s own call site), always `1 + raw.len()`
(a LEB128 varint for any value `0..=32` is always exactly one byte, `MAX_ENCODED_BYTES` = 32,
checked before this runs) -- never a separate `varint_len` helper. `sim_conn_counters` widened
48 -> 56 bytes (a 7th `u64`), read by `engine/test`'s `netCounters()` as `uplinkPresenceBytes`.
`presence_oversize` (added step 3) still has no ABI reader: nothing in this cut's exit criteria
needs it from a browser test, so it stayed native-only.

**`RemotePresences<G>`, `client/remote_presence.rs`**: `RemotePresenceEntry<G> { sample,
sample_tick, arrived_ms }`, hand-written `Clone`/`Copy` (the same `PresenceEntry` pitfall: a
derive would bound `G: Copy`, not `G::Presence: Copy`). `sample_tick = frame.tick - age_ticks`.
**`arrived_ms` is not real wall-clock arrival**: it is `sample_tick` converted through `G::
TICK_RATE` (`sample_tick.0 as f64 * 1000.0 / hz`), a deterministic proxy. Threading the client's
real frame clock into `ClientCore::on_frame`'s fixed `(&mut self, bytes: &[u8])` signature (no
`t_ms` parameter, and every existing native/wasm call site across the crate calls it that way) was
judged a wider seam change than this cut should take on unasked; nothing in this cut's own exit
criteria or tests reads `arrived_ms` (it is not part of the `RemotePresence` struct `presences()`
hands to a game, only of the internal store `RemotePresences::debug_get` exposes to tests). M30,
which owns the real interpolation buffer this field anticipates, will need a real value here and
may need to widen `on_frame`'s signature to get one -- flagged for that milestone, not decided here.

**`FrameView::own_presence()` crosses by value, not `&G::Presence`** as the brief's own Provides
literally spells it (`FrameView::own_presence() -> &G::Presence`). `game_instance.rs`'s fixed call
order (M18: "build `FrameView` -> `ClientSide::frame` -> `extract`") builds `FrameView` *before*
`ClientSide::frame` runs, and `frame` receives `presence: &mut G::Presence` into the exact
`ClientInstance` field a `&'a G::Presence` held inside `FrameView` would alias for that struct's
whole lifetime (which spans past `client.frame`, into `extract`'s own use of the same `view`) --
the borrow checker rejects a `&`/`&mut` pair to the same location coexisting that way. Since
`Presence: Copy`, copying the value out at `FrameView` construction (`let own_presence =
*presence;`, taken before `client.frame` writes it) sidesteps the conflict entirely; the value
`own_presence()` returns is therefore the sample as of the *start* of this frame (last frame's
final write), not this frame's own not-yet-written update -- the same one-frame staleness
`camera_view`'s cached fields already accept for `on_frame`'s own `FrameView` construction. Every
`FrameView::new` call site in the crate (`game_instance.rs` x2, `client/frame_cx.rs` x2, `client/
ui.rs`, `fixtures/drawables/tests/drawlist_golden.rs`, `client/frame_view.rs`'s own tests) updated
for the two new trailing parameters (`own_presence: G::Presence`, `remote_presences: &'a
RemotePresences<G>`).

**`Replica<G>` gains `remote_presences: RemotePresences<G>`** plus `apply_presence_sample`/
`apply_presence_gone` (`pub(crate)`, called only from `ClientCore::apply`'s new `SectionId::
Presence` arm) and a `pub fn remote_presences(&self) -> &RemotePresences<G>` accessor (`pub`, not
`pub(crate)`, for the same reason `entities_map`/`registry` are: `fixtures/drawables`'s own native
test builds a `FrameView` directly from a `Replica` it owns, outside this crate).

**Fixture `fx-presence` gains `type Client = PresenceClient`**: `frame()` writes a sample derived
from an internal counter (`self.t`, incremented every call), independent of the camera --
deliberately, since the worker-path browser test drives `frame()` directly through the harness
with no guarantee a camera ever moves, and the exit criterion is "while changing every frame".
`extract()` draws one circle per `presences()` entry; in the single-player worker-path topology
this is always zero entries (a player's own sample is never relayed back to them), so the loop body
is exercised but never actually pushes a `Draw` there -- multiplayer circle-drawing itself has no
dedicated test in this cut (Non-scope of the Tests added list; the accepted risk is the same class
already covered structurally by `presences()`'s own unit tests in `client/frame_view.rs`, which do
assert `pos`/`vel`/`alpha` derivation with a real multi-player `RemotePresences`).

**Fixture `fx-puts` gains a real `PutsPresence` type** (`{ pos: [i32; 2], vel: [i16; 2] }`, same
shape as `fx-presence`'s own `PlayerPresence`) so `gc-connected-terrain.html`'s existing zero-GC
panning window (docs/plan/15c) also exercises presence sampling, uplink and host decode --
"the zero-GC scene's fixture gains a presence type", per the brief's own step 6 wording. This
fixture spawns no player entity, so `PutsClient::frame` samples the camera's own centre
(`cx.camera().centre`, Q24.8-scaled: `(centre * 256.0) as i32`) every call instead; floats here are
explicitly sanctioned by 0001 Decision ("the spring lives here, in ordinary floats ... nothing
depends on its bits") even though this file otherwise falls under `.claude/rules/determinism.md`'s
path scope, since presence never enters `Store`/the log/the hash. **Measured, not assumed**:
`pnpm gc -t connected-terrain` (all 10 cases: `clean` + every negative control, `main`/`client`/
`sim`/`gen0`) still passes at the existing `budgets.json` ceilings with no change -- in particular
the `sim` isolate's 17 B/frame budget, the one row a naive reading of `codec::decode_canonical`'s
own `vec![0u8; bytes.len()]` scratch allocation might predict would rise. It does not: that
allocation happens inside the WASM instance's own bump-allocator arena (`abi::arena::Arena`), which
is disjoint from the V8 JS heap the browser `gc` suite's CDP sampling profiler measures -- a small
allocation that fits inside the arena's existing pre-reservation triggers no `memory.grow` and is
therefore invisible to that profiler, unlike the *native* `no_alloc_connection.rs` suite (which
measures `abi::arena::live_bytes()` directly and would have caught it -- that suite defines its own
local `NGame` with `type Presence = ()`, so it is structurally unaffected by this change and still
passes unmodified). No `budgets.json` value was edited.

**`presence-worker-path`**: a `host.connect: true`, no-renderer page over `fx-presence` (`connected
.ts`'s own precedent), exposing one `__run(frames)` hook that drives `frames` client frames at
60 fps (`stepFrame`) with a sim tick every 3rd frame (`stepSimTickSync`, ~20 Hz) -- **not**
`test/client.ts`'s own `stepTick`, which parks every worker on its own way out
(`untilQuiescent`'s tail call) and would deadlock the very next `stepFrame` in the same loop
without an explicit `resumeWorkers` round trip; `gc-connected-terrain.ts`'s own `drive()` is the
precedent for `stepSimTickSync` + a raw frame loop sharing one tight loop. Settles once
(`untilQuiescent`) at the end, then reads `netCounters()`. The spec runs 60 frames (~1 s of manual-
clock time, matching `sampler_rate_and_on_change`'s own one-second window) and asserts
`uplinkPresenceBytes > 0` (the "reaches the table" proof), `expectWithinBudget('counters.presence
.uplinkBytesPerSec', ..)`, and `drops === 0` on both rings. **Measured**: 1.9 s of the fast
`browser` suite's 35 s budget (one test added, as instructed).

**Failability proof (steps 4-6), one inject-fail-revert per new test, each performed and reverted
in this session against the actual code, not a hypothetical**:

- `relay_recipients` / "relay to the sender": in `Host::build_frame`, changed `if who ==
  slot.player { continue; }` to `if false && who == slot.player { .. }` (never skips) -->
  this test's own "sender: never sees their own sample" assertion failed (panicked with "a
  player's own sample must never be relayed back to them"); reverted. (Needed `a`'s own camera
  subscribed to its own chunk in the test setup, or the *other* guard below masks it -- found live:
  the first attempt at this injection did not fail, because connection 0 had never sent a camera
  report at all, so the subscription guard alone already excluded it.)
- `relay_recipients` / "relay to an unsubscribed client": changed `if !slot.subs.is_subscribed
  (chunk) { continue; }` to `if false && !slot.subs.is_subscribed(chunk) { .. }` --> "never
  subscribed: sees nothing" failed; reverted.
- `rerelay_and_gone` / "drop the re-relay": changed the `due` match's `Some(&last) => ..` arm to
  always `false` --> panicked with ">= 1 Hz re-relay must eventually fire" (the loop ran out after
  20 ticks with no second hit); reverted.
- `rerelay_and_gone` / "drop Gone": guarded the `Gone` push in `Host::build_frame`'s second
  scratch-presence loop with `if false && ..` --> panicked with "the disconnect frame must carry a
  Presence section" (`presence_entries` returned `None`); reverted.
- `rerelay_and_gone` / "skip age_ticks": hardcoded the `age_ticks` varint to `0` in
  `write_presence_flat`'s `Sample` arm --> panicked with "age_ticks must grow across a re-relay:
  first 0, second 0"; reverted.
- `presence-worker-path` / "stop the worker from reading the uplink field": forced `ClientCore::
  presence_due` to always return `false` --> failed with "the sample must have reached the sim
  worker's table" (`Received: 0`, `Expected: > 0`); reverted.

**Exit criteria evidence**:
- Every test above passes (`cargo nextest run --workspace -E 'test(presence) or
  package(fx-presence)'`: all pass; `pnpm test browser -t presence-worker-path`: pass, 1.9 s); the
  Presence golden is checked in (`presence_section_golden.hex`).
- `PresenceTable` appears in `admit`'s signature only: unchanged from steps 1-3, still proved by
  the compile-fail doc test on `PresenceTable` itself (`presence.rs`); steps 4-6 add no new
  `PresenceTable` parameter anywhere.
- The zero-GC test still passes with the presence-enabled fixture: `pnpm gc -t connected-terrain`,
  10/10 cases pass, no budget changed.
- `uplinkPresenceBytes` while changing every frame is within budget: `presence-worker-path.spec.ts`
  asserts `expectWithinBudget('counters.presence.uplinkBytesPerSec', counters.uplinkPresenceBytes)`
  directly; passes.
- `pnpm test` / `pnpm lint` in full: not run by this session (Tyler is the gate, per the delegation
  prompt); every suite touched was run individually and green, plus a full `pnpm golden:bytes` run
  (366/366 native tests passing, no existing golden moved) and `pnpm --filter engine typecheck`
  (clean).

## Orchestrator's gate record

Cut 1-3 / 4-6, two implementers. Cut 1 had one fix round, cut 2 none. Cut 1's round added the missing inject-fail-revert proofs. Its `oversize_dropped` proof found that test dead: the "oversize" payload was not a valid encoding, so `decode_canonical` rejected it before the size gate. It now uses a genuinely wide presence type. The round also corrected the uplink ceiling's arithmetic: 320 counted payload, while the measurement counted whole batches. It is now presence-field bytes only, 59 B/s measured against 33 × 10 = 330. The zero-GC coverage is real: `fixtures/puts` writes `PutsPresence` from the live camera in `frame`, and `connected-terrain` pans through its measured window, so the sampler sends and the host records every changing sample. Relay to a *second* client is covered natively (`relay_recipients`, `rerelay_and_gone`), not by a zero-GC page, because no page has two connections.

Final gate: `rust` 366, `unit` 215, `wasm` 55, `browser` 169 at 25-27 s of 35 s, lint clean. One byte golden added (`presence_section_golden`), none moved. Loops: 13/13 under `--load 10` (slowest 32 s) and 14/15 quiet. The quiet failure was `park('sim')` on `gc: flat transport parity` with the worker `Armed` and `Req` = `Ack`, the same signature as at M18's gate, on harness code M19 did not touch. That is `docs/plan/19b-sim-park-while-armed.md`.
