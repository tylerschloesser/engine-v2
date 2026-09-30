# M33f: A remote client takes its world's seed and params from `Welcome`

Status: not started · After: 33e · Tyler-dependent: no

Written by the orchestrator before M34 (2026-09-30), settling the ledger row M29 left "not decided, needs a call before M34". A read-only research pass traced the code; its findings are summarised under "The evidence" so this brief stands alone.

## Goal
`createClient({ host: { kind: 'remote', url } })` works with no `test.game`: the client and its gen workers generate the same pristine terrain as the server because they were configured from the seed and params in `Welcome`. Nothing seed-dependent runs on a remote client before that. A local host is unchanged.

## The evidence
- `Welcome` carries seed and params (0013 "Welcome = { … world seed + params (0008) … }"), and clients regenerate pristine terrain themselves (0008). `client_on_welcome` (`crates/engine/src/game_instance.rs`, about line 1189) decodes both and never reads them.
- The client role and the gen role are configured once, at `engine_init`, from the setup message's `game` JSON: `ClientInstance::init` (about 301-365) parses `TerrainConfig` (seed and params required), calls `client.on_init(seed, &params)` (0035) and builds `Pristine::new(seed, params)` into the replica's `TerrainStore` (`world/terrain.rs`: `source: Box<dyn PristineSource>`, no setter). `Role::Gen` (about 397-404) builds `GenCore::new(dims, seed, params)`, immutable afterwards.
- `client.ts` `start()` (about 1895-2000) builds `game` only for a local host; for `remote` with no `test.game` it is `null`, and the client and every gen worker fail `engine_init` with `BadConfig`. Every remote page and the netcode harness therefore pass the whole config through `ClientOptions.test.game` / `HeadlessClientOptions.game` (`tests/browser/pages/src/mp.ts` about 140-148, `src/test/net-harness.ts` about 752, `tests/netcode/reference-server-smoke.test.ts` about 96).
- Order on a remote client today: workers set up and `engine_init`ed; `frame()` runs whenever main asks, not gated on `Welcome` (`worker/client.ts` `body()`, about 172-200), so `TerrainFeed::on_frame` enqueues gen jobs, gen workers generate, `ClientSide::ui` runs and replica cache misses call `Pristine::generate`, all before `Welcome` arrives. `Client.ready` for `remote` means workers set up, not `Welcome`.
- Params are `Codec` binary in `Welcome` and JSON in an instance config; `Params: Serialize` (0008).

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0035-clientside-on-init.md`
3. `docs/decisions/0013-sessions-and-integrity.md` (Welcome; Client policy; one world per server)
4. `docs/decisions/0015-threads-memory-and-topology.md` (§2: what `postMessage` may carry; the worker set)

Look up at the step: `docs/plan/29-net-worker-and-reference-server.md` Deviations (the `test.game` escape hatch and why it exists); the ABI rule at the top of `crates/engine/src/abi/registry.rs`. Rules that apply: `.claude/rules/hot-paths.md`, `.claude/rules/prediction.md`, `.claude/rules/determinism.md`, `packages/engine/CLAUDE.md`, `packages/engine/src/CLAUDE.md`, the crate's `CLAUDE.md`. Skills: `write-adr`, `run-tests`.

## Scope
- **An unconfigured client role.** For a client linked to a remote host, `TerrainConfig`'s seed and params are optional. Without them the instance starts unconfigured: its terrain source answers `Unknown` for every pristine read, `TerrainFeed` enqueues nothing, and `ClientSide::on_init`, `frame`, `extract` and `ui` are not called (no `Ui` record, an empty DrawList). A local-host client and any config that carries seed and params behave exactly as today.
- **Configure on the first `Welcome`.** `client_on_welcome` installs `Pristine::new(welcome.seed, welcome.params)` through a new `TerrainStore::set_source`, calls `on_init(seed, &params)`, and marks the client configured. `on_init` is still called exactly once per client instance; only its moment moves for a remote client.
- **A later `Welcome`** with the same seed and params (a reconnect, the common case) is a no-op for configuration. With different ones, the client does not reconfigure: it reports a fatal, named so a page can tell it from a trap (one world per server, 0013; the page's policy is a reload, as for a build-hash mismatch).
- **Gen workers are spawned after the first `Welcome`** on a remote client, with seed and params in their setup message (0015 §2 allows setup messages). The client worker tells main through a lifecycle message that carries the config as JSON, read from the instance by a new ABI export. `Client.ready` keeps its meaning. No gen job is dispatched before the gen workers exist.
- **Tests stop using the escape hatch for remote hosts:** `HeadlessClientOptions.game` becomes optional and `createNetHarness` stops passing it for its remote clients; `pages/src/mp.ts` drops `test.game`. `ClientOptions.test.game` itself stays for the pages that still need it.
- **ADR 0042**, by the `write-adr` skill: a remote client's world config comes from `Welcome`; amends 0035 (when `on_init` runs), 0015 (gen workers may be spawned after setup on a remote client) and 0013 (what a client does with a `Welcome` for a different world). Record the rejected alternative: a `ClientOptions.host` field carrying seed and params out of band, about 40 lines, rejected because a player with only an invite link does not know the seed, and because a page and a server that disagree would generate different terrain silently (the sampled pristine-hash check of 0008 is deferred).

## Non-scope
The reference game and `games/reference-server` (M34 moves the reference page to remote mode and gives the server its default world). Reconfiguring a live client for a different world. The pristine-hash check of 0008. Removing `ClientOptions.test.game`.

## Files, packages and crates touched
`packages/engine/crates/engine/` (`game_instance.rs`, `world/terrain.rs`, `abi/registry.rs` and the export, tests), `packages/engine/src/` (`client.ts`, `abi.ts`, `worker/client.ts`, `worker/client-net.ts`, `worker/protocol.ts`, `test/headless-client.ts`, `test/net-harness.ts`), engine tests and browser pages, `docs/decisions/0042-*.md`.

## Seams
**Provides:** `TerrainStore::set_source`; the client-role export that returns the `Welcome` world config as JSON (name it in the registry and in Deviations; `ABI_VERSION` 36 → 37); the lifecycle message's config field (`worker/protocol.ts`); a remote `createClient` that needs no `test.game`; `HeadlessClientOptions.game` optional; for tests, a way to wait until a remote client is configured and its gen workers are set up (name it in Deviations: M34's two-page tests need it).
**Consumes:** `session::read_welcome`, `client_on_welcome`, `seed_presence` (M28); `ClientSide::on_init` (0035, M20b); `Pristine`, `PristineSource`, `TerrainStore`, `TerrainFeed`, `GenCore`, the gen ring (M07, M08, M08b); the worker spawn path and `parkWorkers` (M06b, M16e); `client-welcome` and `client.onLink` (M29); `createNetHarness`, `HeadlessClient` (M27); `seedToHexU64` (`sim-config.ts`).

## Planning decisions
- **The server is the only source of a remote client's world config** (option (a) of the ledger row). The data is already on the wire by 0013's design.
- **Hold, don't guess.** Before `Welcome` a remote client generates nothing and shows nothing, rather than generating with a placeholder seed and discarding it. An `Unknown` pristine read is what `.claude/rules/prediction.md` already makes every reader handle.
- **Late spawn over a late-configure export for gen workers.** A `gen_configure` export plus a shared config region would add a second configuration path to a role that is otherwise immutable after `engine_init`; spawning late reuses the one setup path. If late spawn turns out to fight `parkWorkers`, the arena budget check or a zero-GC page in a way that costs more than about 100 lines, stop and report with the numbers.
- **A different world is fatal, not a wipe.** A server restarted with another seed is rare (0013: one world per server) and a reload already handles it.

## Order of work
1. Rust: optional seed and params for the client role, the unconfigured source, `set_source`, the held feed and withheld `ClientSide` calls; native tests.
2. Rust: `client_on_welcome` configures, the same-world no-op, the different-world fatal, the config-as-JSON export, ABI registry; native tests.
3. TypeScript: the lifecycle message, late gen-worker spawn in `client.ts`, `HeadlessClient` and the harness without `game`.
4. `mp.ts` without `test.game`, browser tests, the wait-until-configured test helper, ADR 0042, `CLAUDE.md` lines.

Cut line: steps 1-2 are one delegation and steps 3-4 another. The seam between them is the export's name and JSON shape, the lifecycle message's field, and "`frame()` on an unconfigured client is a no-op that publishes an empty DrawList".

## Tests added
- Rust native: `unconfigured_client_reads_unknown_and_enqueues_nothing` (frames before `Welcome`: no gen job, no `on_init`, no `Ui`, pristine reads `Unknown`), `client_on_welcome_applies_seed_and_params` (after `Welcome` the client's pristine tiles equal a client built with that config directly; `on_init` called once with the welcome's seed), `second_welcome_same_world_is_noop` (`on_init` still once, replica kept), `welcome_for_a_different_world_is_fatal`, `configured_client_unchanged` (a config with seed and params behaves as before: an existing local-path test may already be this; name it rather than duplicate it).
- Netcode: `remote_client_without_game_config_matches_host` (a `HeadlessClient` created with no `game`: after settling, `replicaHash` equals the host's region hash and a gen-worker-generated pristine chunk equals one from a client built with the config); `reference-server-smoke` keeps passing with its `game` option removed.
- Browser: `mp/remote_client_configures_from_welcome` (the `mp` page with no `test.game`: terrain pixels at a known tile match the same page configured the old way, by readback), and the existing `mp/*` tests pass unchanged apart from `mp.ts` itself. One new browser test, under 3 s; `browser` is at 42-44 s of 48 s.
- Each new test is shown red once: before its step's fix, or by injection (for example `client_on_welcome` not installing the source) where the code is new.

## Exit criteria
- [ ] All tests above pass by name, each with its red line in the report.
- [ ] `grep -rn "test: *{ *game\|test\.game" packages/engine/tests packages/engine/src/test` shows no remote-host use left; the uses that remain are listed under Deviations with why.
- [ ] No existing golden changed; zero-GC pages pass with no budget moved (`pnpm test browser -t gc`).
- [ ] ADR 0042 written; `pnpm test wasm -t "abi registry"` passes at `ABI_VERSION` 37.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t welcome` · `pnpm test netcode -t remote_client_without_game_config` · `pnpm test browser -t "mp/"` · `pnpm test browser -t gc` · `pnpm test wasm -t "abi registry"`.

## Budgets
Zero-GC (`budgets.json`, unchanged): the configured check on the per-frame path is a branch on a field, no allocation. Time to first terrain on a remote client grows by the gen-worker spawn after `Welcome`: measure it on the `mp` page (ms from link up to the first generated chunk) and record it under Deviations; no ceiling is set here.

## Context artifacts
`packages/engine/src/CLAUDE.md`: one entry on the remote start order (client and net workers, `Welcome`, config, gen workers). ADR 0042.

## Manual device checks
None of its own; M34's device section plays a remote client on a phone.

## Deviations
Steps 1-2 (Rust), commits `de2bf00`, `9a3db7c`. Seam shapes for steps 3-4:

- **Export:** `client_world_config() -> i32` (client role, `params: 0`, `result: 'len'`; registry `Instance::client_world_config(&mut self, tx) -> Result<u32, Status>`, `abi::client_world_config`). Writes UTF-8 JSON into the `Tx` region and returns its length; **`0` = not configured yet**; `-(status)` on failure. Shape: `{"seed":"0x<16 lowercase hex digits>","params":<params JSON>}`, exactly the `seed`/`params` fields `TerrainConfig` parses (the `seedToHexU64` form, zero-padded), so TypeScript spreads it into a `game` config (`{ ...JSON.parse(text), genWorkers, cacheChunks, ... }`) without re-encoding. It answers for any configured client (also one configured at `engine_init`). `ABI_VERSION` 36 -> 37; `abi.ts` mirrors it.
- **"Configured just now":** `client_on_welcome`'s `Result` widened 16 -> 20 bytes: a fifth LE `u32` at offset 16 is `1` when this call configured the client (once per instance), else `0`. The other four words keep their offsets. The caller posts the lifecycle message exactly when it is `1`, then calls `client_world_config`.
- **Different world:** `client_on_welcome` returns new `Status.WorldMismatch = 16` (appended; `abi.ts` `Status.WorldMismatch`), applying nothing (validate first). "Same world" = seed equal and the `Codec` bytes of the welcome's params equal the installed ones (`InstalledWorld.params_codec`, encoded once at install; the comparison allocates, on the welcome path only).
- **`frame()` unconfigured:** returns `Status.Ok`; publishes an empty DrawList (`begin_frame` + `sort_into`, `drawlist_len() == 0`); does not call `set_camera`, `TerrainFeed::on_frame`, `Uploader::on_frame` or any `ClientSide` method; clears the input queue. `on_frame` (a host frame) is not gated: `Welcome` always precedes frames, and a frame before it is not reachable through the client worker.
- **Config:** `TerrainConfig.seed` and `.params` are `Option`; both present or both absent, one alone is `BadConfig`; `"params": null` counts as present (a `()`-params game). The gen role still requires both (`BadConfig` otherwise). `TerrainStore::new_unconfigured(dims, capacity)`, `has_source()`, `set_source(Box<dyn PristineSource>)` (debug-asserts none installed), `Replica::with_source(dims, Option<Box<..>>, ..)`; `Replica::tile` answers `Err(Unknown)` while unconfigured (a field branch); a bare `TerrainStore::tile` on an unconfigured store is `Tile::VOID` (unreachable through `Replica`).
- **Departure from the brief:** the different-world fatal applies only to a client whose world came from a `Welcome`. A client configured at `engine_init` (seed and params in its config: local host, `test.game`) keeps ignoring `Welcome`'s world, as today (`init_configured_client_ignores_the_welcome_world`); making it fatal risks existing netcode/browser tests whose client config and host disagree, and was not run here. Decision for the orchestrator: whether to tighten it once step 4 removes the remote `test.game` uses.
- Evidence: the client had no other route to an unconfigured role (`TerrainConfig` was required); `on_init` has one caller (`ClientInstance::init`), now also `client_on_welcome`. Red lines: `unconfigured_client_reads_unknown_and_enqueues_nothing` with the `frame` hold disabled: `no gen job before the world is known left: 64 right: 0`; `client_on_welcome_applies_seed_and_params` with `set_source` removed: `assertion left == right failed left: Tile(4294967295)`; `second_welcome_same_world_is_noop` with the comparison forced unequal: `not configured again left: (WorldMismatch, 0)`; `welcome_for_a_different_world_is_fatal` with it forced equal: `assertion left == right failed left: Ok`. Also new: `configured_client_unchanged`, `config_with_only_one_of_seed_and_params_is_bad_config`, `init_configured_client_ignores_the_welcome_world`, `world::terrain::tests::unconfigured_store_caches_nothing_until_set_source`.
- Measured: `pnpm test rust` 751 pass, `wasm` 159 pass (abi registry at 37), `pnpm lint` green. Fixtures rebuild on any `registry.rs` change (about 100-230 s).

Steps 3-4 (TypeScript), commits `0ea956b`, `42968c5`, `M33f step 4`-fix below.

- **Seams.** Lifecycle message `{ type: 'client-configured'; config: string }` (`worker/protocol.ts`, `ClientLifecycleMessage`; `config` = `client_world_config` JSON; in `POST_SETUP_MESSAGE_TYPES`). Posted from `worker/client.ts` via `NetPumpHandshake.onConfigured` (`worker/client-net.ts`) on the `client_on_welcome` whose result word 16 is `1`: once per instance, which is where the hot-paths "no steady-state `postMessage`" rule is enforced (the wasm side reports `1` once; a reconnect's second `Welcome` reports `0`; `spawnGenLate` also has a `genSpawned` guard). Test helper: `untilConfigured(client)` in `engine/test` (`test/client.ts`; awaits `workersReady` then new `ClientTestHandle.genWorkersUp`, rejects after 10 s with no `Welcome`). `HeadlessClient` gains `chunkHash(cx, cy)`; `HeadlessClientOptions.game` optional (gen instance built on the configuring `Welcome`); `NetHarnessOptions.clientsConfiguredAtInit` (default false, harness clients get no `game`).
- **WorldMismatch surfacing.** The build-hash path (`link` reason `version-mismatch`, reload once keyed on the build hash) is not generic, so no reload policy: the client worker ends with `shell.fatal('WorldMismatch: ...')`; main (which ignored every post-`ready` fatal) maps that prefix to `onLink({ state: 'rejected', reason: 'WorldMismatch' })` (`LinkReason` gains `'WorldMismatch'`). Not exercised end to end in TypeScript (the Rust `welcome_for_a_different_world_is_fatal` covers the status).
- **Departure from step 2.** An unconfigured `frame()` now still calls `set_camera` (the report is world-independent). Without it the first camera report went out a tick later and `counters-exact` and `rates/degrade-on-soft-cap` failed. Existing Rust tests unchanged and green.
- **OPEN, for the orchestrator: `rates/baseline-join-converges` is red.** `bytesDown = 368`, recorded exact 335 (ceiling 369); `worstSecondBytesDown` 196 -> 229. Cause: sections `Presence` 44 -> 67 and one extra frame; `ClientSide::frame` (presence) starts after `Welcome`, one client frame later than a client configured at init. With `clientsConfiguredAtInit: true` it passes at 335. Not changed here (an existing budget).
- **Late-spawn checklist.** `parkWorkers`/`resumeWorkers`/`allEqual`/`diagWorkers` iterate the live `workers` array (pushed when spawned): fine, but a gen worker spawned while the others are parked is not parked, so call `untilConfigured` first (documented). `asHarness` snapshots the worker set: `gc-multiplayer-topology.ts` failed its `neg * gen0` controls until it built the harness after `untilConfigured` (fixed, page now without `test.game`). Arena budget check: still at start with the maximum gen count (conservative, nothing allocated until spawn). `destroy()` sets `destroyed`; a `Welcome` after it spawns nothing; a spawn already in flight is in `workers` and is terminated (its `genWorkersUp` never settles: `untilConfigured` is bounded). No `Welcome` ever: no gen workers, teardown clean (nothing to terminate). Reconnect: word 16 is 0, plus the `genSpawned` guard. `netNoDial` pages (no `Welcome` ever) keep the old path: gen workers at start and `game` as given (`terrain-client.ts` regressed until this exception was added). "No gen job before the gen workers exist" is not enforced: `W_READY` is never set to `Yes`, so `genPump` cannot gate on it; jobs a configured client enqueues in the few ms before the spawn wait in the gen request rings (8 slots) and are taken when the worker starts. `stepFrame`/`untilQuiescent` need no change (client worker only).
- **Remaining `test.game` uses** (grep `test\.game|test: *{ *game|game:` in tests and `src/test`): `gc-anchors.ts`, `framecx.ts`, `device.ts`, `terrain-client.ts`, `gen.ts` (remote hosts at `ws://unused.invalid` or `netNoDial`: no `Welcome` ever comes), `gc-echo.ts`, `gc-topology.ts`, `topology.ts` (local hosts), `wiring.ts` (raw worker), and `mp.ts` `?testGame=1` (the new test's comparison arm). `mp.ts` and `gc-multiplayer-topology.ts` no longer pass it.
- **Measured** (`mp/remote_client_configures_from_welcome`, 546 ms): from `onLink` `online` to gen workers up about 4-5 ms; to first revealed view 21-35 ms (about 19 ms on the `test.game` arm, polled every 5 ms). `browser mp/` 7 existing tests 5.3-5.5 s wall; the pre-change figure was not taken (no way to build the old tree without a stash).
- **ADR 0042** written; the index rows (`PRE-PLAN.md` §1, `PLAN.md`, root `CLAUDE.md` range) and the `Amended by` lines on 0013/0015/0035 are not done: outside an implementer's edit rights.

