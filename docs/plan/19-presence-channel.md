# M19: Presence channel

Status: not started · After: 17 · Tyler-dependent: no

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
- [ ] Every test above passes; the Presence golden is checked in.
- [ ] `PresenceTable` appears in the signature of `admit` only; a compile-fail doc test shows `apply` cannot name it.
- [ ] The zero-GC test still passes with the presence-enabled fixture.
- [ ] `uplinkPresenceBytes` while changing every frame is within the budgets-file ceiling added below.
- [ ] `pnpm test` and `pnpm lint` are green.

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
  not the brief's literal snake_case `uplink_presence_bytes_per_s`. Value `320` (0001's own
  worst-case per-sample cap, 32 B x 10/s), not a tight `measured + 8 B` margin: this fixture's own
  `sampler_rate_and_on_change` measures 129 B/s at its own small test coordinates, but a real
  game's coordinates range over the whole world and postcard's own varint cost grows with
  magnitude, so a tight margin here would be meaningless (same reasoning `counters.render.gpuBytes`'s
  own formula already gives for not using the tight-margin convention).
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
replayable`, `sampler_rate_and_on_change`, `oversize_dropped`, `outside_world_cap_dropped`,
`well_formed_undersize_presence_is_recorded` and the two `dist_sq`/`within` unit tests -- everything
in `fx-presence` whose function name doesn't literally contain "presence". Verified instead with
`cargo nextest run --workspace -E 'package(fx-presence) or test(presence)'` (23 tests, all pass) and
a full unfiltered `cargo nextest run --workspace` (355 tests, all pass, nothing else moved).

**World-cap check: implemented, but its own "dropped" test cannot be made to fail honestly** --
escalating for the orchestrator/Tyler to weigh in on. `Host::on_uplink` checks `sample.pos().tile
().in_range()` (0007 §2's `TilePos::in_range`) before `PresenceTable::on_sample`, exactly reusing
the Consumes item "World coordinate range check (M07)". But `Presence::pos()` returns `WorldPos`,
whose raw `i32` fields map 1:1 onto `[TILE_MIN, TILE_MAX]` once floored to a tile -- `docs/plan/
07-world-model-core.md`'s own Deviations already says this exact thing ("the raw i32 already covers
[TILE_MIN, TILE_MAX] 1:1 ... so only a wider intermediate (movement math before it's clamped) can be
out of range"). There is no `i32` bit pattern a `WorldPos` can hold whose `.tile()` fails
`in_range()`: `i32::MIN`/`i32::MAX` map to exactly `TILE_MIN`/`TILE_MAX`. So for *any* conforming
`Presence` implementation (whose `pos()` must return a real `WorldPos`), this check structurally
cannot reject a sample -- it is correct, defensive, dead code today. `tests/presence_host.rs`'s
`outside_world_cap_dropped` was rewritten to prove the check *accepts* both representable extremes
(`i32::MIN`, `i32::MAX`) rather than fabricate a "dropped" assertion that can never really exercise
the reject branch. If a future milestone wants a genuinely reachable rejection here, the check
likely needs to move to a place that still holds a wider intermediate (before narrowing into
`WorldPos`), which the `Presence` trait's fixed `pos() -> WorldPos` signature does not expose.

**Measured**: `sampler_rate_and_on_change`'s own phase A (continuously changing sample, one client,
polled every 10 ms for one second) sends exactly 10 presence-carrying `UplinkBatch`es (the 10 Hz
ceiling, never more), totalling 129 B; the final at-rest value is sent exactly once more, then
nothing further for the next 490 ms polled. `presence_oversize` reads 0 across every test that
sends only well-formed samples (`well_formed_undersize_presence_is_recorded`), confirmed 1 for a
33-byte payload (`oversize_dropped`).

**Not built (left for the next cut, per the brief's own step split)**: relay, re-relay at >= 1 Hz,
`Gone`, the Presence section's own encode/decode and golden, `RemotePresences`, `FrameView::
own_presence()`/`presences()`, the `presence-worker-path` browser test, the zero-GC fixture's own
presence type, and `testkit::Loopback::set_presence`.
