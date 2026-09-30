# 0042: A remote client takes its world's seed and params from `Welcome`

Status: Accepted (2026-09-30). Amends [0035](0035-clientside-on-init.md) (when `on_init` runs), [0015](0015-threads-memory-and-topology.md) §2 (gen workers may be spawned after setup on a remote client) and [0013](0013-sessions-and-integrity.md) (what a client does with a `Welcome` for a different world). Implemented in M33f (`docs/plan/33f-client-world-config-from-welcome.md`).

## Context

`Welcome` carries the world's seed and params ([0013](0013-sessions-and-integrity.md)) and clients regenerate pristine terrain themselves ([0008](0008-chunk-generation.md)). Until M33f nothing read them: the client role and the gen role were configured once, at `engine_init`, from a `game` JSON that only a local host (`host.world`) or the `ClientOptions.test.game` escape hatch supplied. A `{ kind: 'remote' }` client with no `test.game` failed `engine_init` with `BadConfig`, in the client worker and in every gen worker. A player who arrives with only an invite link does not know the seed.

## Decision

**1. The server is the only source of a remote client's world.** A client linked to a remote host and given no seed and params starts *unconfigured*. Seed and params are both present or both absent in its config (one alone is `BadConfig`; `"params": null` counts as present). The gen role still requires both.

**2. Hold, don't guess.** Until the first `Welcome`, an unconfigured client answers `Unknown` to every pristine read, enqueues no gen job, calls no `ClientSide` method (`on_init`, `frame`, `extract`, `ui`) and publishes an empty DrawList. Its frame still records the camera report (a game-independent fact the host needs to subscribe the view), so the first report goes out on the tick after `Welcome`, as before.

**3. The first `Welcome` configures it.** `client_on_welcome` installs `Pristine::new(seed, params)` through `TerrainStore::set_source` and calls `ClientSide::on_init` there. This amends [0035](0035-clientside-on-init.md): `on_init` is still called exactly once per client instance; only its moment moves, for a remote client, from `engine_init` to that `Welcome`. The wake that applied that `Welcome` had already run its `frame()` unconfigured, so the caller runs `frame()` once more right after the configuring `Welcome`, before the uplink is polled: the first presence sample and gen requests then leave in the same wake as for a client configured at init (measured: without it the M31 join baseline moved 335 -> 368 bytes down, as presence reached the host one frame later). The call reports "configured just now" in a fifth `u32` (offset 16) of its result, `1` on that one call. The export `client_world_config` returns `{"seed":"0x<16 hex>","params":<json>}`, the fields `TerrainConfig` parses (`ABI_VERSION` 37).

**4. Gen workers are spawned late.** The client worker posts one `client-configured` lifecycle message, carrying that JSON, on the call that configured the client; main then spawns the gen workers with it as their `game`. This amends [0015](0015-threads-memory-and-topology.md) §2: a setup message may be posted to a worker spawned after the first, on a remote client. `Client.ready` keeps its meaning (workers set up). The rings and the arena budget check are unchanged (sized for the maximum at start). The message is once per client instance, not steady state: the wasm side reports the configured word `1` once, and the message allowlist test names it. A reconnect's `Welcome` reports `0` and posts nothing; a second spawn is also guarded on main.

**5. A later `Welcome` for the same world is a no-op; for another world it is fatal.** Same means equal seed and equal `Codec` bytes of the params. Otherwise `client_on_welcome` returns `Status.WorldMismatch` (16) and applies nothing; the client worker ends with a fatal named `WorldMismatch`, which main surfaces as `onLink` `{ state: 'rejected', reason: 'WorldMismatch' }`. No reload policy: the version-mismatch reload is keyed on the build hash, which says nothing about a changed world, so a page decides for itself. One world per server ([0013](0013-sessions-and-integrity.md)); a server restarted with another seed is rare.

**6. Stated limit.** The mismatch check applies only to a client whose world came from a `Welcome`. A client configured at `engine_init` (a local host, or a page still passing `test.game`) keeps ignoring the world in `Welcome`: a page that was told its world at start is the author's responsibility, and tightening it risked existing tests whose client config and host disagree. Revisit when no remote page passes `test.game`.

## Alternatives rejected

- **A `ClientOptions.host` field carrying seed and params out of band** (about 40 lines): a player with only an invite link does not know the seed, and a page and a server that disagree would generate different terrain silently (the sampled pristine-hash check of 0008 is deferred).
- **A `gen_configure` export and a shared config region** for already-running gen workers: a second configuration path in a role that is otherwise immutable after `engine_init`; late spawn reuses the one setup path.
- **Generating with a placeholder seed and discarding it** at `Welcome`: wasted work and a visible flash of wrong terrain.
- **Wipe and reconfigure on a different world:** rare, and a reload already handles it.

## Consequences

- Time to first generated terrain on a remote client grows by the gen-worker spawn after `Welcome` (measured in the M33f brief's Deviations).
- Code that snapshots the worker set (`engine/test`'s `asHarness`, `parkWorkers` while a spawn is mid-flight) must wait until the gen workers exist: `engine/test`'s `untilConfigured(client)`.
- `ClientOptions.test.game` remains for pages that never dial (`netNoDial`, `ws://unused.invalid`).
- Deferred: the pristine-hash check (0008); a reload policy for `WorldMismatch`; the different-world check for a client configured at init.

## Sources

- `docs/plan/33f-client-world-config-from-welcome.md` (evidence and Deviations), 2026-09-30.
