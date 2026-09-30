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
(filled in during Phase 3)
