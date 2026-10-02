# 0051: Durable Objects: no-go

Status: Accepted (2026-10-02). Amends [0009](0009-transport-and-hosting.md) "Targets, in order" (target 2) and its "Durable Objects constraints the design accepts" paragraph; settles the deferred Durable Object feasibility check (0009 Consequences, PRE-PLAN section 9 risk 5). Implemented by M38 (`docs/plan/38-hosting-checks.md`).

## Context

[0009](0009-transport-and-hosting.md) named Cloudflare Durable Objects as the second target, "the proof that the library assumes no process, filesystem, or HTTP server", and deferred four measurements: usable memory, timer accuracy, billing and restart frequency. The go/no-go rule was fixed in the M38 brief before any number existed. **Go** needed all of: the PRE-PLAN section 9 risk 5 triggers not hit (cost within the $5 Workers plan for an always-available world, no tick throttling, at least 96 MiB usable), and at most one restart per hour while connected.

M38 built a recipe package (`games/reference-server-do/`: a Worker routing `/ws/<id>` to one object per id; `createWorldServer` over the standard WebSocket API; `Storage` as 1 MiB numbered part objects `p/<key>/<gen>/<seq>` plus an index object, on SQLite-backed object storage; `timer` from `setInterval`; `scheduler` from `setTimeout`; `onIdle` dropping the world). It ran under `wrangler dev --local` and deployed on Workers Paid (account of Tyler, 2026-10-02). The package is deleted with this ADR; its findings are below.

## Decision

**1. Durable Objects are not a supported target.** [0009](0009-transport-and-hosting.md)'s target list becomes: Node 22 or Bun as a process on a VM, container or Fly machine (primary); Deno (adapter, best-effort). The deployer recipe "one Durable Object per world id" is dropped; "one Fly machine per world" stays. The package `games/reference-server-do/` and its tests (`do/local-smoke`, `do/storage-adapter`) are deleted; the engine gained nothing for it (no `exports` entry, 0009 Consequences).

**2. The rule's outcome.** Item "usable memory" is not met on the restart path, which is enough for no-go. The cost and throttling items were met; the restart-frequency item was measured for one hour only (the 24 h run was stopped at 1 h 2 min because the decision was already made).

**3. Revisit when** a restore from a snapshot uses a single sim instance (see the measurements: `Persistence.open` creates two), or Cloudflare raises the isolate memory limit, and the restart path can then be shown to work on a deployed object at the scale-1 save. Only a deployed run counts: `wrangler dev --local` does not reproduce the limit.

## Measurements

Bench payload (`busy-field`, the 0020 section 9 save, 262,144 furnaces at scale 1), release build, arena 96 MiB (`memoryBytes` 101,974,016), in a Durable Object on Workers Paid, two headless observers over `wss`, 20 Hz.

| Item | Result |
|---|---|
| Local smoke (`wrangler dev --local`, `puts` fixture) | join live in 118 ms; action acked, `motd` 7; socket drop and redial back in 221 ms with the same replica hash; after `kill -9` of the runtime and a restart on the same storage the action's effect was still there |
| Fresh world, scale 1 | instantiates and runs genesis in the object: live 1.4 s after the dial; `memGrows` 0; the 96 MiB arena and a 128 MiB arena (`memBytes` 135,528,448) both tick; +96 MiB of touched JS heap was tolerated before a reset |
| Snapshot write | scale 1: 13 parts (about 12.5 MiB) at ticks 1,200 and 2,400, no fault |
| **Restore from a snapshot (the restart path)** | **fails on the deployed object.** The object reaches `ready`, writes the epoch bump, then is reset before its first tick (`Durable Object connection closed because the object was reset`), repeatedly (10-13 restarts in 40 s). Scale 1 at 96 MiB: fails. Scale 4: 32 and 40 MiB arenas recover; 48, 64 and 96 MiB fail. Scale 16 at 24 MiB and scale 64 at 16 MiB recover. The same code recovers on `wrangler dev --local` |
| Cause, as far as measured | `Persistence.open` instantiates a probe instance for the `chunk_bits` check and `loadLatest` a second one for the restore (Node: `WebAssembly.Instance` count 1 on genesis, 2 on a restore; scale 1 at 96 MiB: `external` 99 -> 221 MiB, RSS 111 -> 213 MiB). **The isolate's memory accounting is not fully explained:** one 128 MiB-arena instance (135 MB) passes while two 48 MiB ones fail, so the unit that counts is not simply reserved bytes |
| Timer (60 min, 2 clients) | the object's clock only advances on I/O, so its own tick intervals read exactly 50.00 ms and a tick's duration 0 ms: not measurable on the host. Engine host counters: 74,400+ ticks, `ticksDropped` 0, `tickOverruns` 0, 20.0 Hz (client tick 71,992 after 3,600 s). Clients' downlink gap, one message per tick: median 49.8 ms, median per-10 s p99 about 62 ms, worst 3.2 s (a client network blip, no object restart) |
| Cost (projected from the run) | duration 0.125 GB x 86,400 s x 30 = 324,000 GB-s per month of 400,000 included; 17.0 uplink messages/s for two observers = 2.2 M billed requests per month at 20:1, 1 M included then $0.15/M (about $0.18 over; about $1.2 for eight players); rows written far inside 50 M included. Prices: the Cloudflare pricing page, checked 2026-10-02. The dashboard figure was not read |
| Restarts | one hour only: one object start, so zero restarts while connected; no 24 h count |

Other adapter facts, for whoever tries again: `Connection.send` receives `(cls, bytes, len?)` and must honour `len`; a workerd server socket's `binaryType` defaults to `blob` (set `arraybuffer`); without `HostServices.scheduler`, `onIdle` never fires; a connection accepted before `ready` works since 60e373c; every deploy of a new version resets the objects.

## Alternatives rejected

- **Keep Durable Objects as a second target limited to small worlds** (scale 4 at 40 MiB recovers): the target existed to prove the library fits a host with no process, and a world that cannot reload after a deploy is down until fixed; the supported size would also be a number nobody has an explanation for.
- **Patch the engine to release the probe instance and re-run:** the brief's Non-scope hands engine changes to the ADR, and the memory accounting is unexplained, so a patch would be a guess. Tracked as a ledger row (deferred-ledger).
- **KV-backed object storage or other storage backends:** the failure is memory on restore, not storage; no backend change touches it.

## Consequences

- 0009's "Durable Objects constraints the design accepts" paragraph is history, not a plan: its 128 MB figure matched the first-boot result, but the restore path needs more.
- `Persistence.open` creating two instances on a restore is an engine finding that matters to any memory-tight host, a phone's sim worker included (ledger row, owed diagnosis).
- Hosting recipes: the Fly machine ([`games/reference-server/README.md`](../../games/reference-server/README.md)); Bun and Deno adapters unchanged.
- The 24 h billing and restart figures were never collected; the decision does not depend on them.

## Sources

- `docs/plan/38-hosting-checks.md` Deviations (full tables, resource list); logs were under `test-results/m38-do/` (not committed).
- https://developers.cloudflare.com/durable-objects/platform/pricing/ (checked 2026-10-02); https://developers.cloudflare.com/durable-objects/best-practices/websockets/ and https://developers.cloudflare.com/workers/platform/limits/ (the sources of 0009; not re-read).
