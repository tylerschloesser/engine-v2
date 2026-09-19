# M34: Reference game: roster, remote players, play through the reference server

Status: not started · After: 33b, 30, 31b · Tyler-dependent: no

Split during planning: the PLAN.md row for M34 also held the scripted full-game tests, which alone exceed one session. They are `34b-reference-scripted-single-player.md` and `34c-reference-scripted-multiplayer.md`. This brief makes the game multiplayer; those two prove the whole game.

## Goal
Two browsers pointed at `games/reference-server` with an invite link see each other's circles move smoothly, see a roster of coloured dots that follows joins, drops and returns, and share one world of furnaces and depleted tiles. Single-player is unchanged and shows a one-dot roster. A returning player's camera starts where they left.

## Read first
1. `docs/spec/overview.md`
2. `docs/spec/reference-game.md` (Players: roster, returning player; Furnace: "any player")
3. `docs/decisions/0011-wire-format-and-deltas.md` (Scopes; "Deltas are the only write path")
4. `docs/decisions/0013-sessions-and-integrity.md` (Identity and join key; A disconnected player's state; Client policy)

Look up at the step: remote rendering and the 1 Hz re-relay `0001` (Presence bullets); interpolation limits and fade `0012` ("Remote motion"); `SimRng` rules `0002` §2; follow target `0019` §1; the seams of `docs/plan/19-presence-channel.md` and `docs/plan/29-net-worker-and-reference-server.md`.
Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md`, `games/reference/CLAUDE.md`, `games/reference-server/CLAUDE.md`.

## Scope
- `GlobalState { colours: [u8; MAX_PLAYERS] }` (palette index per `PlayerId`, 0 = unassigned). `genesis` puts the empty value. `on_player(Joined)` picks a free palette index with `w.rng()` and does one `put_global`. Nothing else writes `Global`.
- `Ui.roster: Vec<{ id, online, colour, me }>` built in `ui()` from the engine roster and `global().colours`. DOM `src/ui/roster.ts`: one dot per entry, hollow when offline.
- Remote players in `extract`: for each `FrameView::presences` entry draw a `circle` in that player's colour with the entry's `alpha`; own circle takes the own colour. No range ring for remotes.
- Mode selection in `main.ts`: `readInvite()` (M29) present → `host: { kind: 'remote', url }` with the join key from the fragment; absent → `host: { kind: 'local' }`.
- Link status: `src/ui/status.ts` shows a small indicator from `client.onLink` (states per M29) after the delay of `0013` Client policy; `rejected` with `BadKey` or `Full` shows a one-line message. No modal.
- Returning player: on its first `frame`, if the presence passed in was seeded (M19 `seed_presence`, from `Welcome`) `RefClient` starts the spring there and calls `cx.follow(Some(pos))` for that one frame, then `None`. Otherwise M20b's spawn rule applies.
- `games/reference-server`: confirm its defaults serve the reference game (`--game` default, `JOIN_KEY`, `--data`); add `pnpm --filter reference-server start` and a README section "play with a friend on the LAN" that points at `<<serve>>` in `docs/plan/device-checks.md`.

## Non-scope
Scripted full-game and race tests (M34b, M34c). Player names, chat, cursors. Any per-player colour choice UI. Status UI for storage and fatal events (M37 owns the remaining engine events).

## Files, packages and crates touched
`games/reference/` (`sim/src/{types,lib,client}.rs`, `src/main.ts`, `src/ui/{roster,status}.ts`, tests), `games/reference-server/` (scripts, README). Engine crate: only the `FrameView::roster` accessor below.

## Seams
**Provides:** `FrameView::roster` (engine crate); `GlobalState`, `content::PALETTE`, `Ui.roster`; Playwright helper `tests/helpers/server.ts::startReferenceServer({ seed, joinKey?, maxPlayers?, manualTimer: true })` wrapping M29's `startTestServer` with the reference game's `buildGame` output; `openGame(page, { invite })`.
**Consumes:** `put_global` (M12b), `Delta::Roster` in the `Store` (M12; 0024 §8), Global section with the roster (M14); `FrameView::presences` with `alpha` (M19, M30); `seed_presence` from `Welcome` (M19/M28); `cx.follow` (M18); `createClient` `host` option (M06b), `readInvite`, `client.onLink`, `startTestServer`, `games/reference-server` (M29); rates and hashes on by default (M31, M31b); `SimRng` through `WorldWrite::rng` (M12b).
**From M27's harness (in its brief; if missing in code, stop and fix the plan):** `createNetHarness({ fixture })` accepting the reference game's `buildGame` output directory; `HeadlessClient.setCamera({ x, y, tilesAcross })` (so the game's spring produces presence) and `HeadlessClient.ui()` returning the last `Ui` JSON.
**Engine addition owned by this milestone** (no earlier brief provides a read accessor for the engine roster from client code): `FrameView::roster(&self, f: &mut dyn FnMut(PlayerId, bool))` in ascending `PlayerId`, reading the replica's `Store` (M12's `Delta::Roster`, 0024 §8). About 40 lines in the engine crate plus one fixture test (`frameview_roster_follows_delta`).

## Planning decisions
- **Colour assignment uses `SimRng`.** Which colour a player gets is unspecified, `on_player` is host-only and logged, and no other reference feature draws from the sim RNG. This puts `rng()`, the RNG's place in the snapshot, and its replay determinism under the reference game's golden log at no cost in scope.
- **Colours are `Global`, not `Player`.** Every client must read every player's colour, including offline ones; that is the definition of the Global scope (`0011`).
- **The one-frame follow is how the host's memory of a position reaches the camera.** It also gives the follow target its only reference-game user. If a locally saved camera exists it is within a few tiles of the same place, so the jump is invisible.
- **Offline players stay in the roster** as hollow dots: player state persists indefinitely (`0013`), and the dot is the visible proof that the online flag follows the logged event after the grace.
- **Own-timer completion gap** (`0012`, deferred 2→3; carried from M20b): judge it here by hand against the reference server through a throttled connection and record the decision in Deviations: accept, or render own bars over `duration + lead`. The device entry below repeats it on a real network.

## Order of work
1. `GlobalState`, colour assignment, native tests; `SCHEMA_VERSION` bump; bindings.
2. `FrameView::roster`, `Ui.roster`, `roster.ts`.
3. Remote circles in `extract`.
4. Mode selection, `status.ts`, `startReferenceServer`, two-page test.
5. Returning-player rule. 6. README, `CLAUDE.md` updates.

## Tests added
- Rust native: `joined_assigns_distinct_colours` (eight joins, eight indices), `colour_assignment_replays_identically` (replay hash equal, RNG state in the snapshot), `global_written_only_on_join`, `extract_hash_remote_players` (two scripted presences, one faded).
- Netcode (`createNetHarness` with the reference game): `reference_roster_follows_join_grace_and_return` (online flag drops only after the grace of `0013`, returns on reconnect, colour unchanged), `reference_presence_only_to_subscribers`.
- Browser, two pages against `startReferenceServer`: `reference_two_players_see_each_other` (each page's DrawList holds two circles in distinct colours; two roster dots), `reference_shared_world` (A depletes a tile and places a furnace; B's texel and DrawList show both), `reference_returning_player_resumes` (close page A, reopen with the same storage state, camera within one tile of where it left).

## Exit criteria
- [ ] All tests above pass by name.
- [ ] By hand: `pnpm --filter reference-server start`, two desktop browser windows on the invite link; circles move without stutter, a closed window's dot goes hollow after the grace.
- [ ] Single-player still passes every earlier `reference_*` test.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t reference` · `pnpm test netcode -t reference_` · `pnpm test browser -t reference_two` · `pnpm --filter reference-server start` + `pnpm --filter reference dev`.

## Budgets
Bandwidth per client, steady (`PRE-PLAN.md` §7): in `reference_presence_only_to_subscribers`, read `counters(i)` from the harness for a 10 s window of two moving players and assert against the `budgets.json` ceiling M31 set.

## Context artifacts
`games/reference/CLAUDE.md`: single-player vs invite mode, how to run two players locally. `games/reference-server/CLAUDE.md`: the start script.

## Manual device checks
[device-checks.md, M34: Reference multiplayer on real devices](device-checks.md#m34-reference-multiplayer-on-real-devices): two devices in one world, the own-timer bar (owner M26), remote motion (owner M30).
The phone must reach the reference game over HTTPS with `/ws` to `games/reference-server` on the same origin.

## Deviations
(filled in during Phase 3)
