# fixtures/presence (`fx-presence`)

The presence-channel fixture (docs/plan/19-presence-channel.md, steps 1-3; docs/decisions/
0001-camera-and-presence.md). `Presence = PlayerPresence { pos: [i32; 2] /* Q24.8 */, vel: [i16;
2] }` (0001's own reference-game shape, verbatim, 12 bytes). One witness-carrying action,
`Action::Poke { tile, from }`:

- `admit` (host only, never replayed): rejects `NoSample` (no presence recorded for the player) or
  `TooFar` (`from` beyond `ADMIT_TOLERANCE_TILES` = 16 from the player's latest presence sample).
- `apply` (host live, host replay, client prediction): rejects `OutOfRange` if
  `dist(from, tile) > POKE_RANGE_TILES` (2) in Q24.8 fixed point, from the action's own bytes alone
  -- no `PresenceTable` in scope (its signature cannot name one).

`Player { poke_count, last_tile }` is the only replicated state a successful `Poke` changes, just
enough for a test to observe that `apply` ran. `Entity = ()`/`Global = ()`: this fixture never
spawns anything (Non-scope: `fixtures/puts`'s own job).

Tests: `tests/presence_apply.rs` (`apply_range_is_replayable`, step 1: `testkit::run_script` alone,
no `Host`), `tests/presence_admit.rs` (`admit_witness_*`, `presence_is_not_state`, step 3: through
the real `Host::on_uplink` pipeline, since `admit` needs a `PresenceTable` a real host actually
populates), `tests/presence_sampler.rs` (`sampler_rate_and_on_change`, step 2: driving `ClientCore`
directly with an injected clock), `tests/presence_host.rs` (`oversize_dropped`,
`outside_world_cap_dropped`, step 3 -- see that file's own doc comment: the world-cap check is
structurally unreachable for any `WorldPos`-encoded sample, 0007 §2, flagged in the milestone's own
Deviations).
