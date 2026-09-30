# M34: Reference game: roster, remote players, play through the reference server

Status: not started · After: 33b, 33d, 33e, 33f, 30, 31b · Tyler-dependent: no

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
- Mode selection in `main.ts`: `readInvite()` (M29) present → `host: { kind: 'remote', url }` (`url` = `wsUrl(location)`, M29: the server's `/ws` on the page's own origin) with the join key from the fragment; absent → `host: { kind: 'local' }`. In remote mode the page passes no world and no `test.game`: the client is configured from `Welcome` (M33f, ADR 0042), so nothing is drawn and no `Ui` arrives until then.
- **One declared default world** (ledger, M29's `BadConfig` row; decided 2026-09-30): `games/reference/world.json` holds `{ seed, worldgen }` (today's `main.ts` literal: seed `6840143426475589698`, `worldgen: {}`). `main.ts` imports it for the local host; `games/reference-server/index.mjs` uses it when `--game` is left at its default and keeps `{ seed: '1', worldgen: null }` for an explicit `--game` (fixtures' `Params = ()` needs exactly `null`). The cause of the old failure was found by reading, not by running: confirm it first (`worldgen: null` does not deserialize into `RefParams`).
- Link status: `src/ui/status.ts` shows a small indicator from `client.onLink` (states per M29) after the delay of `0013` Client policy; `rejected` with `BadKey`, `Full` or `WorldMismatch` (M33f) shows a one-line message. No modal.
- Returning player: on its first `frame`, if the presence passed in was seeded (`seed_presence`, built by M28 from `Welcome`: `ClientCore::seed_presence` in `client/core.rs`) `RefClient` starts the spring there and calls `cx.follow(Some(pos))` for that one frame, then `None`. Otherwise M20b's spawn rule applies.
- `games/reference-server`: confirm its defaults serve the reference game (`--game` default, `JOIN_KEY`, `--data`); add `pnpm --filter reference-server start` and a README section "play with a friend on the LAN" that points at [How to serve a page to the phone](device-checks.md#how-to-serve-a-page-to-the-phone) in `docs/plan/device-checks.md`.

## Non-scope
Scripted full-game and race tests (M34b, M34c). Player names, chat, cursors. Any per-player colour choice UI. Status UI for storage and fatal events (M37 owns the remaining engine events).

## Files, packages and crates touched
`games/reference/` (`sim/src/{types,lib,client}.rs`, `src/main.ts`, `world.json`, `src/ui/{roster,status}.ts`, tests), `games/reference-server/` (scripts, README). Engine crate: only the `FrameView::roster` accessor below.

## Seams
**From M33c (orchestrator):** a page draws its DrawList through `attachClientDrawables(client, device, renderer, { colorFormat })` from `engine/render` (with `Client.drawListSlot`/`Client.assets` public, read-only). Colours are packed with `engine::client::rgba(r, g, b, a)` (byte 0 = r); never write a hex literal. Inside a zero-GC window, read camera fields through the terrain renderer's staged uniform bytes (`stagedFrameUniform`), never its double fields, which allocate (M33c Deviations). A visual criterion needs a pixel readback on the production page (`engine/test` `readPixels`, `__pixelAt`), not only a DrawList read.

**From M33d, M33e and M33f (orchestrator):** sprites are pickable by `pick_id` and `stepFrame` writes a real viewport (M33d). `Loopback` and harness clients no longer degrade by accident, so a test that needs bundles must stall the link (M33d). `client.onUi` rides the real rAF: read `Ui` through `readUi` (waits for a non-null one), never emit input from `onUi`, and page code acting on the first `Ui` checks what the player did meanwhile (`src/spawn.ts`, M33e). A remote client has no gen workers until `Welcome`: a test calls `engine/test`'s `untilConfigured(client)` before it parks workers, builds a harness (`asHarness`) or expects terrain, and `startTestServer`/`createNetHarness` default to `worldgen: null`, seed `'1'`, so `startReferenceServer` and the netcode scenarios must pass the reference world (M33f Deviations). `games/reference/CLAUDE.md` is at its 60-line cap (`unit` enforces it): condense when adding.

**Provides:** `FrameView::roster` (engine crate); `games/reference/world.json`; `GlobalState`, `content::PALETTE`, `Ui.roster`; Playwright helper `tests/helpers/server.ts::startReferenceServer({ seed, joinKey?, maxPlayers?, manualTimer: true })` wrapping M29's `startTestServer` with the reference game's `buildGame` output; `openGame(page, { invite })`.
**Consumes:** `put_global` (M12b), `Delta::Roster` in the `Store` (M12; 0024 §8), Global section with the roster (M14); `FrameView::presences` with `alpha` (M19, M30); `seed_presence` from `Welcome` (M28); a remote client configured from `Welcome`, `untilConfigured` (M33f); `cx.follow` (M18); `createClient` `host` option (M06b), `readInvite`, `wsUrl`, `client.onLink`, `startTestServer`, `games/reference-server`, `pnpm device:serve --app reference --ws` (M29); rates and hashes on by default (M31, M31b); `SimRng` through `WorldWrite::rng` (M12b).
**From M27's harness (in its brief; if missing in code, stop and fix the plan):** `createNetHarness({ fixture })` accepting the reference game's `buildGame` output directory; `HeadlessClient.setCamera({ x, y, tilesAcross })` (so the game's spring produces presence) and `HeadlessClient.ui()` returning the last `Ui` JSON.
**Engine addition owned by this milestone** (no earlier brief provides a read accessor for the engine roster from client code): `FrameView::roster(&self, f: &mut dyn FnMut(PlayerId, bool))` in ascending `PlayerId`, reading the replica's `Store` (M12's `Delta::Roster`, 0024 §8). About 40 lines in the engine crate plus one fixture test (`frameview_roster_follows_delta`).

## Planning decisions
- **Colour assignment uses `SimRng`.** Which colour a player gets is unspecified, `on_player` is host-only and logged, and no other reference feature draws from the sim RNG. This puts `rng()`, the RNG's place in the snapshot, and its replay determinism under the reference game's golden log at no cost in scope.
- **Colours are `Global`, not `Player`.** Every client must read every player's colour, including offline ones; that is the definition of the Global scope (`0011`).
- **The one-frame follow is how the host's memory of a position reaches the camera.** It also gives the follow target its only reference-game user. If a locally saved camera exists it is within a few tiles of the same place, so the jump is invisible.
- **Offline players stay in the roster** as hollow dots: player state persists indefinitely (`0013`), and the dot is the visible proof that the online flag follows the logged event after the grace.
- **Own-timer completion gap** (`0012`, deferred 2→3; carried from M20b): decided, not judged here. Own bars stretch over `duration + lead` (Q10; M26's `own_progress`). Check by hand against the reference server through a throttled connection that every own bar (collect, craft) uses it and ends when the result arrives; the device entry below repeats that on a real network.

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
Bandwidth per client, steady (`PRE-PLAN.md` §7): in `reference_presence_only_to_subscribers`, read `counters(i)` from the harness for a 10 s window of two moving players and assert against the `budgets.json` ceiling M31 set. The harness defaults to hash-all since M31b, so this scenario passes `world: { debugHashMode: 'production' }` (the production cost) and its ceiling is M31's row plus `net.hashesBytesPerS` (M31b Deviations R1).

## Context artifacts
`games/reference/CLAUDE.md`: single-player vs invite mode, how to run two players locally. `games/reference-server/CLAUDE.md`: the start script.

## Manual device checks
[device-checks.md, M34: Reference multiplayer on real devices](device-checks.md#m34-reference-multiplayer-on-real-devices): two devices in one world, the own-timer bar (owner M26), remote motion (owner M30).
The phone reaches the reference game over HTTPS with `/ws` to `games/reference-server` on the same origin through M29's `pnpm device:serve --tunnel --app reference --ws`; the game's remote `url` defaults to `wsUrl(location)` (M29).

## Deviations
Steps 1-3 (commits `M34 step 1..3`, base `cd44372`).

**Step 3b (engine defect, fixed): the roster online bit was never written.** `Sim::step`'s `Record::Player` arm now calls `Authority::put_roster` (`authority.rs`, `pub(crate)`, writes `Delta::Roster` in `Scope::Global`) after `G::on_player`: `Connected` -> true, `Disconnected` -> false, `Joined` nothing. `on_player` is called only from `Sim::step`, so live host, replay and recovery all take it. Test: `fx-predict::loopback roster_follows_connection_events` (`packages/engine/fixtures/predict/tests/loopback.rs`): host store bit and a second client's roster; red with the `Connected` line disabled. `reference_roster_single_player` now asserts `online: true`.

**Goldens moved (commit `M34: goldens moved by the roster delta`).** (a) each scenario logs `Connected`; (b) checked by baseline: both passed at the step 3 commit, identical but for this change. `join_wilderness_frame.hex`: byte 15 `00` -> `01` (Global roster online flag). `fixtures/puts/golden/golden-connected.json`: `3a392e50dba8f378` -> `8ddca175d11d82e3`.

**Resolved (commit `M34: script-a gets Connected; golden and pins follow the roster delta`).** Native `script_a()` (`fixtures/puts/tests/puts_scenarios.rs`) now carries a `Connected` record right after `Joined`, as `Host::connect` queues them. Native run = wasm run = `805a6100f46e3701`. Moved: `golden-script-a.json` `0a7cc2623a83a03e` -> `805a6100f46e3701`; pinned literals `tests/wasm/puts.test.ts:287` (script a) `0a7cc2623a83a03e` -> `805a6100f46e3701`, `tests/browser/vertical-slice.spec.ts:253` (golden-connected) `3a392e50dba8f378` -> `8ddca175d11d82e3` (comments at 230-231 too). Other occurrences of the old values are historical prose in earlier briefs and doc comments, left as written.

**Seams (exact).**
- `GlobalState` is `pub type GlobalState = RefGlobal` in `games/reference/sim/src/lib.rs`; `RefGlobal { colours: [u8; content::MAX_PLAYERS] }`, index = `PlayerId.0` (ids are `conn + 1`, so 1..=8; slot 0 unused), value = 1-based `PALETTE` index, 0 = unassigned. `RefGlobal::EMPTY` (const), `RefGlobal::colour(PlayerId) -> u8` (0 past the table). `content::{MAX_PLAYERS = 16, PALETTE: [u32; 8], UNASSIGNED_COLOUR (today's green), colour_of(idx: u8) -> u32}`; all packed with `rgba`. `SCHEMA_VERSION` 4 -> 5.
- Assignment: `lib.rs::assign_colour`, called from `on_player(Joined)` after `put_player`: free index via `w.rng()` (`below(n_free)`), one `put_global`; a rejoin or an id past the table writes nothing; with all 8 taken the ninth repeats. `genesis` does `put_global(RefGlobal::EMPTY)`.
- Engine: `WorldRead::roster(&self, f: &mut dyn FnMut(PlayerId, bool))` (default: visits nothing) in `world_access.rs`; `FrameView::roster` (same signature, `client/frame_view.rs`) delegates to it. `Replica` holds its own `roster: BTreeMap<PlayerId, bool>` fed by `apply_roster` and overrides it; `View` reads `Store::roster`. Why not "the replica's Store": a replica `Store` has a slot only for its own player (`Delta::Roster` for anyone else is a no-op there), so remote players' bits would have been dropped. Not hashed or encoded. The test is `client::ui::tests::frameview_roster_follows_delta` in the engine crate (`packages/engine/crates/engine/src/client/ui.rs`), not a fixture.
- `Ui.roster: Vec<UiRosterEntry { id: u32, online: bool, colour: [u8; 3] (RGB, unassigned = green), me: bool }>`, ascending id, capacity `MAX_PLAYERS`; TS: `Array<UiRosterEntry>` in `games/reference/src/bindings/RefUi.ts`, `UiRosterEntry.ts` beside it. `colour` is RGB, not a palette index, so the DOM needs no table.
- `games/reference/src/ui/roster.ts`: `createRosterUi(container, doc?) -> { onUi(ui) }`, wired in `game.ts` (every page, single-player included). DOM: `.roster` (fixed top-right) holding one `span.roster-dot` per entry, in roster order, with `data-player`, `data-online="true|false"`, `data-me="true|false"`, `data-colour="r,g,b"`; offline adds class `offline` (hollow), own adds class `me`.
- `extract`: remotes via `FrameView::presences`, one `circle` each at `p.pos`, colour `colour_of(global.colour(p.who))` with alpha byte `round(alpha * 255)` (only the alpha byte is replaced), no ring, drawn before the own circle; own circle colour `colour_of(global.colour(view.me()))`. `PLAYER_COLOR` is gone (`UNASSIGNED_COLOUR` has its value), so a stub `Global` with no colour hashes as before: `extract_hash_player_circle`, `extract_hash_ghost_and_furnace` and every other existing golden are untouched.
- Browser helper: `RefUiState.roster` added in `tests/helpers/game.ts`.

**Existing tests touched (compile-only).** `RefGlobal` stopped being a unit struct, so the five stub worlds in `sim/tests/{ui,place,extract_golden,ghost,furnace_predict}.rs` changed `&RefGlobal` to `&RefGlobal::EMPTY` (6 lines). No assertion, golden or snapshot pinned `SCHEMA_VERSION` or a reference state hash; `upgrade.test.ts` uses its own fixtures. Bindings: `RefUi.ts` gained `roster`.

**Tests.** `colours.rs` (`joined_assigns_distinct_colours`, `colour_assignment_replays_identically`, `global_written_only_on_join`), `extract_remote.rs` (`extract_hash_remote_players`, golden `tests/golden/extract_hash_remote_players.hash`, blessed with `GOLDEN_BLESS=1 cargo nextest`, the route `extract_hash_player_circle` uses; built on `Loopback` with three clients, `with_render_time(128.0)`: player 3 at alpha 0.6, player 2 at 1.0; render time is in host ticks), `frameview_roster_follows_delta` (engine crate), `roster.spec.ts::reference_roster_single_player` (extra). `colour_assignment_replays_identically` checks equal state hash, colours and `SimRng` state across two identical runs plus RNG moved off its seed; it does not replay a log or decode a snapshot (`state_hash` excludes the RNG).

**Inject-fail-revert (all reverted).** `assign_colour`: `!g.colours.contains(&idx)` -> `true`: `joined_assigns_distinct_colours` red. `free[rng.below(nfree)]` -> `free[0]`: `colour_assignment_replays_identically` red. `put_global` added in the `Disconnected` arm: `global_written_only_on_join` red. `extract`: alpha byte forced to 0xff: `extract_hash_remote_players` red; remotes coloured with `view.me()`'s colour: red. `Replica::apply_roster` inserting only the own player: `frameview_roster_follows_delta` red. `roster.ts` without `dot.dataset.me = me`: `reference_roster_single_player` red.

**Other.** `UiRosterEntry.ts` binding landed in the step 1 commit (the ts-rs export test regenerates it). Full run: rust 757, unit 299 (3.4 s against a 3 s budget under load, WARN only), wasm 159, netcode 94, browser 229; lint green.
