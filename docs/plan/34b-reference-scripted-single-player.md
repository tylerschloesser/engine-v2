# M34b: Reference game: scripted full game, single-player, with persistence extras

Status: not started · After: 34, 23, 24b · Tyler-dependent: no

Split from M34 during planning (see that brief). Needs a new PLAN.md row; M23 and M24b are not upstream of M34 in PLAN.md, so they are listed here explicitly.

## Goal
One scripted playthrough of the whole reference game runs in the browser suite through the real DOM, and a recorded log of the same play is a golden replayed in every runtime. The coverage items `0003` Consequences assigns to scripted tests that need storage (state budget full, panic recovery, `SaveIncompatible`, export/import) are pinned against the reference game. Every single-player row of the Requirement matrix in `docs/plan/reference-coverage.md` names a passing test.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0003-game-facing-api.md` (Consequences: the coverage list)
3. `docs/decisions/0020-testing-strategy.md` (§3 suites and budgets, §4 demotion, §5 determinism, §8 test entrypoint)
4. `docs/decisions/0005-persistence-and-recovery.md` (Recovery; Upgrades; Storage: Browser and Export/import bullets; Panic recovery)
Also: `docs/plan/reference-coverage.md` (both tables). Skills: `run-tests`, `gc-test`.
Rules that apply: `games/reference/CLAUDE.md`; `.claude/rules/determinism.md` for the hook code.

## Scope
- **Script helper** `games/reference/tests/helpers/script.ts`: one fluent description of a play (`panTo`, `collect(resource, n)`, `craft`, `place(origin)`, `deposit`, `waitTicks`, `takeAll`, `expectUi(partial)`), with two drivers: `domDriver(page)` (injected pointer input and real button clicks through `engine/test`) and `headlessDriver(client)` (M27 `HeadlessClient`: `setCamera`, `dispatch`, `ui`). Coordinates come from `landmarks.json`.
- **Full game, browser:** spawn on land, mine to the unlock, craft, place, fetch iron and coal, deposit, smelt, take. Asserts `Ui` after every step and the final state hash against the headless run of the same script.
- **Golden log:** `pnpm --filter reference golden:record` runs the script on the headless driver against `createWorldServer` with memory storage and a virtual clock, and writes `tests/golden/full-game.log` plus checkpoint hashes (from the `.wasm` run, `0002` §1). Replayed natively, under Node and Bun, and on M03's determinism page in three browsers.
- **Persistence through the game:** reload resumes (inventory, furnace contents, depleted tiles, camera); a furnace keeps smelting while its chunk is unsubscribed; a second tab on the same world gets `WorldBusy`; export then import under a new world id gives an equal hash; an exported single-player world imported into a server storage is reclaimed by the same secret with its inventory (`0005` "Single-player to hosted").
- **State budget full:** a `WorldConfig` whose `max_entities` leaves less headroom than `max_action_growth`; `PlaceFurnace` returns `Rejected(Engine(StateBudgetFull))`, the item stays in the inventory, and the build control shows the reason.
- **`test-hooks` cargo feature** on `reference-sim`, never enabled by `vite build`: `SCHEMA_VERSION + 1`, and `StartCraft` with recipe id 255 panics in `apply`. Two `slow`-tagged tests use that build: the poison action is skipped and acked `EngineFault` while play continues (`0005` Panic recovery step 3); a world saved by the normal build reports `SaveIncompatible` under the hooks build with every stored byte unchanged and `exportWorld` still working.
- **Zero GC through the game:** the M04 assertion, single-player topology, over a window of the script that pans, collects and deposits.
- Minimal status UI needed by these tests only: `status.ts` shows `WorldBusy` and `SaveIncompatible` (with Export and Delete, per M23's default) from the rejection of `client.ready` (`EngineStartError` codes `'world-busy'`, M23, and `'save-incompatible'`, M24b; there is no `EngineEvent` union).

## Non-scope
Multiplayer scripts and races (M34c). Heavy mode, soak, benchmarks, the standard large save (M36 consumes this milestone's script and log). Device loss (M37b). `migrate` with a real second schema: the reference game has none (fixtures `migrate-v*` of M24b cover it; see the coverage file).

## Files, packages and crates touched
`games/reference/` (tests, helpers, `sim/Cargo.toml` feature, `sim/src/rules/craft.rs` hook, `src/ui/status.ts`, `package.json` script). `packages/engine/src/vite.ts` for `buildGame({ features?: string[] })`: this milestone needs it first (the `test-hooks` build), so it is built here: the features are passed to cargo, and the output directory and build hash differ per feature set, so a feature build never joins a normal server. M36 and M36b consume it.

## Seams
**Provides:** `buildGame({ features?: string[] })` (engine, `engine/vite`); `script.ts` with both drivers; `tests/golden/full-game.log` and its hashes (M36 heavy mode and M36b measurements consume them); cargo feature `test-hooks`; `golden:record` command.
**Consumes:** everything M20–M34 provide; `HeadlessClient`, `createNetHarness`/memory storage, `VirtualClock` (M27); determinism page and golden regeneration pattern (M03, M05); `forceSnapshot`, `client.exportWorld`/`importWorld`, server `exportWorld`/`importWorld`, `EngineStartError` code `'world-busy'`, `client.onStorage` (M23); recovery, `Skip`, `EngineFault` (M24); `client.onResyncing` (M28b); `EngineStartError` code `'save-incompatible'` (M24b); state-budget check (M21); zero-GC harness (M04); `engine/test` input injection (M11), `drawListRecords` (M17), `untilQuiescent` (M06b).

## Planning decisions
- **One script, two drivers.** The DOM run proves the UI path; the headless run is fast, feeds the golden log, and is what M34c reuses. Their final hashes must match, which pins "the UI adds nothing the actions do not say".
- **Panic and schema tests use a feature build, not a test-only action in the shipped game.** The shipped `.wasm` has no poison. The extra build is why they are `slow`; M24 and M24b's fixture tests remain the fast-tier cover, so the demotion rule of `0020` §4 holds.
- **Reaching a full state budget by configuration**, not by placing 262,144 furnaces: the check reads only counts and world params (`0004`), so a tiny limit exercises the same code.
- **Golden regeneration is an explicit command** and a reviewed diff (`0020` §5). A rule change that alters the hash is expected to update it in the same commit.

## Order of work
1. `script.ts` and the headless driver; full game headless; `golden:record`; native, Node and Bun replays; determinism-page entry.
2. DOM driver; `reference_full_game_single`; hash equality with the headless run.
3. Persistence tests. 4. State budget. 5. `test-hooks` and the two slow tests. 6. GC window. 7. Fill the matrix column in `reference-coverage.md`.

## Tests added
- Browser: `reference_full_game_single`, `reference_reload_resumes`, `reference_offscreen_furnace_keeps_smelting`, `reference_world_busy_second_tab`, `reference_export_import_roundtrip`, `reference_state_budget_full_shows_reason`, `gc.reference_single_player`.
- WASM under Node (engine `wasm` suite): `build-game-features` (a fixture built with and without a feature lands in two directories with two build hashes).
- WASM under Node and Bun: `reference_golden_replay` (checkpoint hashes; first divergent tick reported), `reference_single_player_save_to_server`, `reference_state_budget_full`.
- Rust native: `golden_replay` (same log, same hashes).
- Browser determinism page: the reference log added to the Chromium, WebKit and Firefox runs.
- Slow: `reference_panic_in_apply_skips_and_recovers`, `reference_save_incompatible_leaves_files`.

## Exit criteria
- [ ] All tests above pass by name; the slow ones under `pnpm test:slow`.
- [ ] Every single-player row of the Requirement matrix in `docs/plan/reference-coverage.md` has its test column filled with a test that exists.
- [ ] Fast-suite budgets of `0020` §3 still hold; anything demoted is tagged per §4 and listed under Deviations.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test browser -t reference_` · `pnpm test wasm -t reference_` · `pnpm test rust -t golden_replay` · `pnpm test:slow -t reference_` · `pnpm --filter reference golden:record` (must produce no diff).

## Budgets
Test suite (`PRE-PLAN.md` §7): the browser suite's budget with these tests added, read from the `pnpm test` summary line. Allocation per isolate: `gc.reference_single_player` against `budgets.json`.

## Context artifacts
`games/reference/CLAUDE.md`: the script helper, how to regenerate the golden, what `test-hooks` is and that it must never ship. Extend the `run-tests` skill with the `reference_` filter.

## Manual device checks
None of its own; M39's section replays this script by hand on the phone.

## Deviations
(filled in during Phase 3)
