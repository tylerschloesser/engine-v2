# Research: simulation and persistence

Phase 1 research for `docs/spec/simulation.md`. Evidence and recommendations, not decisions. All URLs accessed 2026-09-19.

Reflects the spec correction of 2026-09-19: **the camera is not an action**, never mutates the world, and is not logged. Engine-defined actions are connection only. Subscriptions and viewports live outside the deterministic sim.

Vocabulary used below:

- **Core**: the deterministic part of the sim (state + `apply` + `tick`). Replayable. Knows nothing about cameras, sockets, clocks, or storage.
- **Host**: the non-deterministic shell around the core (JS bootstrap + host-side Rust in the same WASM module). Owns connections, subscriptions, presence, action admission, tick scheduling, delta fan-out, storage. Never replayed.

---

## 1. Findings

### 1.1 WASM float determinism

**What the spec guarantees.** WebAssembly float arithmetic is IEEE 754 with a single rounding mode: "All operators use round-to-nearest ties-to-even" for `fadd`/`fmul`/`fdiv`/`fsqrt` etc. There is no ambient FPU state a module can change, no extended precision, and no scalar fused multiply-add instruction outside relaxed-SIMD. [Spec, numerics](https://webassembly.github.io/spec/core/exec/numerics.html)

**The complete list of nondeterminism** in the design repo's [Nondeterminism.md](https://github.com/WebAssembly/design/blob/main/Nondeterminism.md):

1. Feature availability differs between engines.
2. The host environment (imports, call order).
3. Shared memory + threads.
4. NaN bit patterns: when an arithmetic op returns NaN, payload bits are nondeterministic (canonical if all NaN inputs were canonical, otherwise "any arithmetic NaN").
5. NaN sign bit: when an op with no NaN inputs produces NaN, the sign is nondeterministic. In practice x86 produces a negative default NaN and ARM a positive one ([design#477](https://github.com/WebAssembly/design/issues/477), [design#619](https://github.com/WebAssembly/design/issues/619)). This is a hardware difference, so it shows up as **x86 server vs. ARM phone**, regardless of which engine runs the module.
6. Relaxed SIMD instructions.
7. Resource exhaustion (`memory.grow` may fail, stack exhaustion).

Everything else, including every non-NaN float result, is fully specified. The Wasmtime docs put it as "NaN bit patterns are the only non-determinism in the language" (for a single-threaded module with no relaxed SIMD). [Wasmtime: deterministic execution](https://docs.wasmtime.dev/examples-deterministic-wasm-execution.html)

**Relaxed SIMD.** Ships in Chrome 114+, Firefox 120+, Safari 18.4+ ([relaxed-simd proposal](https://github.com/WebAssembly/relaxed-simd/blob/main/proposals/relaxed-simd/Overview.md)). `f32x4.relaxed_madd` is single-rounded where hardware FMA exists and double-rounded otherwise, so results differ by CPU. It is opt-in at compile time: Rust's `wasm32-unknown-unknown` default features are `multivalue`, `mutable-globals`, `reference-types`, `sign-ext`, `nontrapping-fptoint`, `bulk-memory`; **neither `simd128` nor `relaxed-simd` is on by default**. [rustc book: wasm32-unknown-unknown](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html). Plain `simd128` is deterministic (same NaN caveat).

**Deterministic profile.** Wasm 3.0 (completed 2025-09-17) "specifies a deterministic default behavior for every instruction with otherwise non-deterministic results" ([Wasm 3.0 announcement](https://webassembly.org/news/2025-09-17-wasm-3.0/)). Browsers do not run in that profile; Wasmtime can (`cranelift_nan_canonicalization`, `relaxed_simd_deterministic`) at a float performance cost ([wasmtime Config](https://docs.wasmtime.dev/api/wasmtime/struct.Config.html)). V8, JSC and SpiderMonkey offer no NaN-canonicalization switch, so a browser sim must be robust to NaN bits on its own.

**V8 vs JSC vs SpiderMonkey vs wasmtime.** I found no documented divergence in non-NaN float results between conforming engines; they are all bound by the same spec tests. Node, Deno and workerd embed the same V8 as Chrome; Bun embeds JSC. The residual risk is engine bugs, which a cross-engine replay-hash test covers (section 5).

**Fused multiply-add in Rust.** RFC 3514 guarantees `+ - * / % sqrt mul_add` "exactly match IEEE 754-2008", with NaN bits nondeterministic ([RFC 3514](https://rust-lang.github.io/rfcs/3514-float-semantics.html)). rustc does not set LLVM fast-math/contract flags, so `a*b+c` is never silently fused. `f32::mul_add` is "guaranteed to be the rounded infinite-precision result" ([std f64 docs](https://doc.rust-lang.org/std/primitive.f64.html)); on wasm without relaxed-SIMD it compiles to a software `fma`: deterministic but slow. Avoid it in hot paths; it is not a hazard.

**libm / transcendentals.** Rust documents `sin`, `cos`, `exp`, `ln`, `powf`, `powi`, `hypot`, `cbrt`… as having precision that "varies by platform, Rust version" ([std f64 docs](https://doc.rust-lang.org/std/primitive.f64.html)). On `wasm32-unknown-unknown` there is no system libm: these resolve to the pure-Rust `libm` port linked from `compiler-builtins` ([rust-lang/libm#152](https://github.com/rust-lang/libm/pull/152)), so **the implementation is inside the `.wasm` file**. A given `.wasm` binary therefore computes identical `sin(x)` on every engine. A native build calls the platform libm (glibc, macOS libSystem, MSVC CRT), which differs from the wasm build and between OSes. This is the classic problem Factorio solved by writing its own trig ("We got away with implementing our own trigonometric functions", [FFF-52](https://factorio.com/blog/post/fff-52)) and that Rapier solves with its `enhanced-determinism` feature (libm crate, no SIMD, no parallelism; "most modern mainstream processors as well as WASM targets") ([Rapier determinism](https://rapier.rs/docs/user_guides/rust/determinism/)).

**WASM vs. a native Rust build of the same crates.** Differences that would break bit-identity:

| Source | WASM module | Native build |
|---|---|---|
| Transcendentals | Rust `libm`, inside the binary | System libm; differs by OS |
| `usize`/`isize` width | 32-bit | 64-bit (overflow, `as` casts, hashing of `usize`, `rand` usize sampling) |
| `HashMap` seed | Stack/heap *addresses* (see 1.2) | OS randomness |
| NaN bits | By CPU | By CPU, plus LLVM const-folding may produce different NaNs than runtime ([rust#124364-class issues](https://github.com/rust-lang/rust/issues/124364)) |
| Auto-vectorization / codegen | Fixed at wasm build time | Varies by target CPU features; still IEEE, but more surface for compiler bugs |
| x87 | n/a | 32-bit x86 only; ignore |

Native bit-identity is achievable (Rapier, Factorio, Gaffer's survey: "yes, if…" [Gaffer: floating point determinism](https://gafferongames.com/post/floating_point_determinism/)), but it is a permanent discipline tax. With one `.wasm` everywhere, the list of rules collapses to: no relaxed-SIMD, no threads, no ambient imports, never observe NaN bits.

### 1.2 Deterministic RNG and collection iteration order in Rust

**rand.** Current `rand` is 0.10.x. Its reproducibility policy: `StdRng` and `SmallRng` are explicitly **not portable** ("may make value-breaking changes in any release"); named PRNGs (`rand_chacha::ChaCha8Rng`, `rand_pcg`) are portable and reproducible across patch releases; value-breaking changes to portable items are allowed in minor releases; "if portability is required, *never* sample a `usize` or `isize` value directly"; float distributions may be non-portable due to transcendental functions. [Rand book: reproducibility](https://rust-random.github.io/book/crate-reprod.html), [rand docs](https://docs.rs/rand/latest/rand/rngs/struct.StdRng.html)

**HashMap.** `std::collections::HashMap` uses `RandomState`. On `wasm32-unknown-unknown` (an "unsupported" platform for OS randomness) std seeds it from **the address of a stack byte and the address of a heap byte**: "Use allocation addresses for a bit of randomness" ([std/src/sys/random/unsupported.rs](https://raw.githubusercontent.com/rust-lang/rust/master/library/std/src/sys/random/unsupported.rs)). Consequence: iteration order in WASM is a function of allocator history. It may look stable run-to-run, but it **changes after a snapshot restore** (different allocation history) and differs from native. Even with a fixed hasher, a hash table's iteration order depends on insertion history and capacity, which a snapshot does not preserve. So the rule is stronger than "use a fixed seed": any collection whose iteration order can influence the sim must have an order that is *part of its serialized value*.

Safe choices: `BTreeMap`/`BTreeSet` (order = key order), sorted `Vec`, `IndexMap` (order = insertion order, serialized in order), dense arenas with generational indices **whose free list is serialized too** (otherwise IDs allocated after a restore differ).

**Hidden state is the real enemy.** Factorio: "most of the desync problems are caused by 'hidden state', that is not properly initialised or saved"; their "heavy mode" saves and reloads the game every tick and compares CRCs, and "reliably finds all these hidden state problems" ([FFF-63](https://www.factorio.com/blog/post/fff-63)). This applies to us unchanged: caches, hash-table layout, free lists, and RNG state are all hidden state.

### 1.3 OPFS vs. IndexedDB

**Sync access handles.** `FileSystemFileHandle.createSyncAccessHandle()` is available **only in dedicated workers**, Baseline "widely available" since March 2023; Safari/iOS since 15.2. It "takes an exclusive lock on the file"; a second open in the default `readwrite` mode throws `NoModificationAllowedError`. Modes `read-only` and `readwrite-unsafe` exist but only Chrome 121+ implements them. `read`/`write`/`truncate`/`flush`/`getSize` are synchronous; obtaining the handle is async. [MDN createSyncAccessHandle](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle), [PowerSync: state of SQLite persistence on the web, May 2026](https://powersync.com/blog/sqlite-persistence-on-the-web)

**Current caveats (May 2026 survey, same source):** Safari private browsing has **no OPFS**; Chrome incognito caps around 100 MB; **SharedWorkers cannot use OPFS**; Safari cannot spawn dedicated workers from a shared worker. None of these block a design where one dedicated sim worker owns the files. MDN does not document `flush()` as a hard durability guarantee; SQLite-on-OPFS projects treat `write` without `flush` as "weak durability" (survives tab/renderer death, may lose data on OS crash/power loss).

**Quotas** ([MDN: storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria), [WebKit storage policy, Safari 17](https://webkit.org/blog/14403/updates-to-storage-policy/)):

| Browser | Per-origin quota |
|---|---|
| Chrome/Edge | up to 60% of disk (best-effort and persistent alike) |
| Firefox | best-effort: min(10% of disk, 10 GiB); persistent: up to 50% of disk |
| Safari 17+ (macOS 14 / iOS 17) | ~60% of disk in browser apps and Home Screen web apps; ~15% in other WebKit apps |
| localStorage | 5 MiB, synchronous on the main thread: unsuitable |

OPFS, IndexedDB and Cache API share one quota and are evicted **together, whole-origin, LRU**, under storage pressure. Persistent origins are skipped.

**`navigator.storage.persist()`**: Firefox prompts the user; Chrome and Safari decide silently by heuristic (engagement, installed/Home Screen app). It cannot be relied on, only requested and reported.

**Safari's 7-day rule.** ITP deletes "all of a website's script-writable storage after seven days of Safari use without user interaction on the site"; Home Screen web apps are exempt because their usage counter is their own ([WebKit: full third-party cookie blocking and more](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)). MDN still lists this as current Safari behavior. For a game someone returns to fortnightly in Safari-the-browser, **a single-player save can legitimately vanish**. The only real mitigations are install-to-Home-Screen, export/import, or hosting the world on a server.

**Web Locks.** `navigator.locks` is available in windows and workers, Safari/iOS since 15.4 ([MDN Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API), [WebKit 15.4 notes](https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/)). Locks are released automatically when the holder's context dies, which makes them a clean "one tab owns this world" primitive; the OPFS exclusive handle is a second line of defense.

**OPFS vs. IndexedDB for our workload.** Our writes are (a) tiny appends to a log many times per minute and (b) a whole-snapshot blob about once a minute. OPFS gives byte-level append with no structured clone, synchronously, from the worker that owns the sim, with no per-write JS garbage beyond a reusable options object; benchmarks put it at 3-4x IndexedDB for byte I/O ([RxDB OPFS](https://rxdb.info/rx-storage-opfs.html)). IndexedDB has no append: a log would be one record per batch (transaction + structured clone + Promise/event garbage each). IndexedDB's only advantages are working in Safari private mode and in SharedWorkers, neither of which we need.

**Compression without dependencies.** `CompressionStream`/`DecompressionStream` (gzip, deflate, deflate-raw) are Baseline since May 2023 and present in Node (deflate-raw since 21.2) ([web.dev](https://web.dev/blog/compressionstreams)). Sealed log segments and exports can be compressed with zero npm dependencies.

### 1.4 Rust serialization options (status as of September 2026)

| Crate | Status | Format stability | Notes for us |
|---|---|---|---|
| **bincode** | **Unmaintained.** RUSTSEC-2025-0141 (advisory 2026-01-07): "the bincode team has taken the decision to cease development permanently"; 3.0.0 is a stub that fails to compile. [RustSec](https://rustsec.org/advisories/RUSTSEC-2025-0141.html) | 1.3.3 frozen | Reject. The advisory itself suggests wincode, postcard, bitcode, rkyv. |
| **postcard** | 1.1.3 (2025-07-24), ~8.7M downloads/month, irregular but steady releases. [lib.rs](https://lib.rs/crates/postcard) | "As of v1.0.0, postcard has a documented and stable wire format" (spec at postcard.jamesmunns.com) | serde-based, `no_std`, varint integers (small actions), not self-describing. Evolution only by appending enum variants/fields-at-end conventions plus an explicit version number. |
| **rkyv** | 0.8.18 (Sept 2026), active. RUSTSEC-2026-0235 (OOB read validating `Rc`/`Arc` archives) fixed in 0.8.17. [RustSec](https://rustsec.org/advisories/RUSTSEC-2026-0235.html), [releases](https://github.com/rkyv/rkyv/releases) | Stable for the life of 0.8; 0.7 data incompatible | Zero-copy load is its selling point; our worlds are small, so load speed is not the bottleneck. Archived types are distinct from native types (awkward for game authors), layout-coupled, not evolvable, and untrusted input needs `bytecheck`. |
| **bitcode** | 0.6.9 (2025-12-18), active. [lib.rs](https://lib.rs/crates/bitcode) | "Stable format across major versions" is an explicit **non-goal** | Smallest/fastest, but wrong for a log kept indefinitely. |
| **wincode** | 0.6.1 (2026-08-10), anza (Solana) team, bincode-compatible bytes, own traits not serde. [lib.rs](https://lib.rs/crates/wincode) | 0.x, 6 breaking releases so far | Fixed-width ints (larger actions); young. |
| **Hand-rolled** (`Encode`/`Decode` traits + derive) | n/a | Ours forever | Zero deps, total control, decode-in-place for the wire; costs a proc-macro crate and tests. |

The zero-GC goal does not constrain this choice much: decoding happens in Rust inside linear memory, not on the JS heap.

### 1.5 Sharing types between Rust and TypeScript

| Tool | Status | Fit |
|---|---|---|
| **ts-rs** | 12.0.1 (2026-01-31), ~2.2M downloads/month, MSRV 1.88. Derive `TS`; bindings are written when `cargo test` runs. Understands serde attributes (`tag`, `content`, `rename_all`, `skip`…). `u64/i64` map to `bigint` by default (configurable via `TS_RS_LARGE_INT`). [lib.rs](https://lib.rs/crates/ts-rs) | **Independent of wasm-bindgen**, so it works whatever `runtime-and-packaging.md` decides about the ABI. Types only; no encoders. |
| **specta** | 2.0.0-rc.25 (2026-05-07): still a release candidate after a long RC series; TS exporter marked stable. [lib.rs](https://lib.rs/crates/specta) | Capable, but RC churn; more machinery than we need. |
| **tsify** | 0.5.8 (2026-08-23), active again; `tsify-next` fork exists. Depends on `wasm-bindgen` and serde_json / serde-wasm-bindgen. [lib.rs](https://lib.rs/crates/tsify) | Couples type generation to wasm-bindgen's object-passing ABI, which allocates JS objects per call: at odds with the hand-rolled-ABI option and the GC goal. |
| **wasm-bindgen `.d.ts`** | wasm-bindgen moved to its own org with new maintainers after the rustwasm org was archived (July 2025); actively released. [Inside Rust](https://blog.rust-lang.org/inside-rust/2025/07/21/sunsetting-the-rustwasm-github-org), [wasm-bindgen#4533](https://github.com/wasm-bindgen/wasm-bindgen/issues/4533) | Types exported *functions* and classes, not data enums with payloads (needs tsify for that). |
| **Schema-first codegen** (protobuf, flatbuffers, custom IDL) | Mature | Rust stops being the source of truth; adds a build tool; fights "game authors write Rust". |

### 1.6 Panics and traps

Default `wasm32-unknown-unknown` is `panic=abort`: a panic becomes a trap, and the instance is left mid-mutation and must be discarded ("panics were historically fatal, poisoning the instance"). In April 2026 wasm-bindgen gained `panic=unwind` support (WASM exception handling), abort hooks, and a re-init mechanism, but it needs **nightly Rust with `-Zbuild-std`**; and "unreachable, stack overflow, or out-of-memory are non-recoverable" regardless. [Cloudflare: making Rust Workers reliable, 2026-04-22](https://blog.cloudflare.com/making-rust-workers-reliable/), [wasm-bindgen guide: catching panics](https://wasm-bindgen.github.io/wasm-bindgen/reference/catch-unwind.html). So recovery-by-new-instance is needed in every case; unwinding would only be an optimization.

### 1.7 Background tabs

Main-thread timers in hidden tabs are clamped to 1/s and, since Chrome 88, to 1/min for chained timers ([Chrome timer throttling](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)). Dedicated-worker timers are throttled less on desktop, but mobile browsers freeze or purge whole background pages, and iOS drops everything shortly after backgrounding. A sim must treat "I was not scheduled for a while" as normal and must never convert elapsed wall time into ticks implicitly.

---

## 2. Prior art and what to take from it

**Factorio.** Deterministic lockstep; "the server acts as an arbiter, deciding which player actions execute in each game tick"; a late input is simply placed in the next tick rather than stalling others; clients render a speculative "latency state" on top of the confirmed game state ([FFF-302](https://www.factorio.com/blog/post/fff-302)). Periodic whole-map CRCs detect desyncs; a desync report bundles both saves and the replay ([FFF-188](https://factorio.com/blog/post/fff-188), [FFF-63](https://www.factorio.com/blog/post/fff-63)). Saves carry version info; on load, JSON migrations then Lua migrations run in a defined order and "each save file remembers (by name) which migrations… have been applied" ([Factorio migrations](https://lua-api.factorio.com/latest/auxiliary/migrations.html)). Replays are only valid for the exact game version. A headless server auto-pauses with no players.
*Take:* host-assigned ticks with "next tick" semantics; log order as the only ordering; heavy-mode (save/load every tick) as the primary determinism test; version-locked replays with snapshot migration as the upgrade path; auto-pause when empty.

**Deterministic-lockstep RTS literature.** Age of Empires scheduled commands two "turns" ahead and synced 1500 units for 8 players with bandwidth proportional to commands, not entities ([1500 Archers](https://github.com/SFTtech/openage/discussions/1493)); Gaffer's articles document how fragile cross-compiler float determinism is ([Gaffer](https://gafferongames.com/post/floating_point_determinism/)).
*Take:* log size scales with commands, which is why our log is tiny. We are not lockstep (clients hold partial worlds), so we do not need cross-*client* determinism for correctness, only for prediction quality and replay.

**GGRS / bevy_ggrs.** The game implements `Config { Input, State, Address }` and services three requests: `SaveGameState`, `LoadGameState`, `AdvanceFrame`; checksums on saved states give desync detection; `SyncTestSession` re-simulates frames and compares checksums as a determinism test ([ggrs docs, 0.13](https://docs.rs/ggrs/latest/ggrs/)).
*Take:* the minimal contract (save, load, advance-with-inputs) is the right shape for the core; a sync-test session belongs in the engine's test kit. Peer-to-peer rollback itself does not fit (server-authoritative, partial worlds).

**Event sourcing (snapshot + log).** Commands are validated; *events* are facts and are re-applied without question; snapshots are an optimization and the log is the truth; upcasting handles old event schemas. SpacetimeDB is the game-flavored instance: state in memory, "persisted via an append-only… commitlog", reducers must be deterministic, and ambient inputs arrive via context: "Use `ctx.rng`… `ctx.timestamp`, never `SystemTime::now()`" ([SpacetimeDB reducer context](https://spacetimedb.com/docs/functions/reducers/reducer-context/)).
*Take:* pass tick and RNG through a context object; write-ahead the log; treat snapshots as disposable. Note one deliberate difference: our log holds *commands that passed admission*, and `apply` re-validates deterministically (section 3.3), because a single code path for live and replay is worth more than skipping a cheap check.

**bevy_replicon / lightyear.** replicon: `app.replicate::<C>()`, `add_client_event::<E>()`, server receives `FromClient<E>`; server-authoritative; per-client visibility; prediction left to third parties ([bevy_replicon](https://docs.rs/bevy_replicon/latest/bevy_replicon/)). lightyear 0.30: a shared "protocol" registers components with prediction/interpolation functions (`interpolate_with::<Position>(…)`), tick-stamped inputs, optional `deterministic` mode where only inputs replicate ([lightyear](https://docs.rs/lightyear/latest/lightyear/)).
*Take:* one shared protocol declaration in Rust that both sides compile; actions as plain serde enums tagged with sender by the engine, never by the client; interpolation supplied as per-type functions.

---

## 3. Recommendations per open question

### 3.1 Game-facing API

**Recommendation (medium confidence):** one `Game` trait tying together a deterministic core and host-side hooks; all engine-provided inputs arrive through context objects; the core never sees cameras or subscriptions. TypeScript types are generated from the Rust types with **ts-rs**; actions cross JS→WASM as JSON at human input rates and are re-encoded to the binary format in Rust.

```rust
// ---------- engine crate: deterministic core contract ----------

/// Compile-time facts. All of these are part of the sim's identity.
pub trait Game: Sized + 'static {
    const TICK_RATE: TickRate;        // e.g. TickRate::hz(20); see 3.7
    const SCHEMA_VERSION: u32;        // bump when Snapshot layout changes; see 3.5

    type Config:  Codec + TS;         // seed + world params, fixed at world creation (genesis record)
    type Action:  Codec + TS;         // game-defined actions (serde enum)
    type Reject:  Codec + TS;         // why an action was refused
    type State:   SimState<Self>;     // everything replay must reproduce
    type Worldgen: Worldgen<Self>;    // pure chunk generator
    type Presence: Codec;             // ephemeral per-player data, never logged (may be `()`)
    type Protocol: Protocol<Self>;    // deltas / client mirror / interpolation / prediction: owned by sync.md
}

pub trait SimState<G: Game>: Sized {
    fn genesis(cfg: &G::Config, cx: &mut GenesisCx<G>) -> Self;

    /// Engine-defined connection actions. Logged. `Joined` fires once per new PlayerId.
    fn on_player(&mut self, cx: &mut ApplyCx<G>, who: PlayerId, ev: PlayerEvent);
    //  PlayerEvent::{Joined, Connected, Disconnected}

    /// The only entry point for outside intent. Must validate against sim state and
    /// either fully apply or leave state untouched. Same code path live and in replay.
    fn apply(&mut self, cx: &mut ApplyCx<G>, who: PlayerId, action: &G::Action)
        -> Result<(), G::Reject>;

    /// Advance one tick. No clock, no I/O; time is cx.tick.
    fn tick(&mut self, cx: &mut TickCx<G>);

    /// Canonical serialization: equal states produce equal bytes (state hash = hash of these bytes).
    fn save(&self, w: &mut Writer);
    fn load(r: &mut Reader) -> Result<Self, LoadError>;
    /// Optional upgrade hook; default refuses. See 3.5.
    fn migrate(_from_schema: u32, _r: &mut Reader) -> Result<Self, LoadError> {
        Err(LoadError::UnsupportedSchema)
    }
}

/// What the core may touch. No subscriptions, no sockets, no time.
pub struct ApplyCx<'a, G: Game> { pub tick: Tick, pub rng: &'a mut SimRng,
    pub world: &'a mut World<G>,          // engine-owned chunk store (see world.md); generates on demand
    pub changes: &'a mut ChangeSink<G> }  // write-only: what changed, for delta building
pub type TickCx<'a, G> = ApplyCx<'a, G>;

/// Pure function of (config, coord). Order-independent: chunk request order is camera-driven.
pub trait Worldgen<G: Game> {
    fn generate(cfg: &G::Config, coord: ChunkCoord, out: &mut ChunkBuf<G>);
}
// Per-chunk randomness comes from hash(cfg.seed, coord, salt), never from SimRng.

// ---------- host-side hooks: run outside the deterministic core, never replayed ----------

pub trait Admission<G: Game> {
    /// Called by the host before an action is logged. May read ephemeral presence.
    /// Anything the core will need from non-sim state must be inside the action (a "witness").
    fn admit(state: &G::State, presence: &PresenceTable<G::Presence>,
             who: PlayerId, action: &G::Action) -> Result<(), G::Reject> { Ok(()) }
}

/// Owned by sync.md; listed so the boundary is visible. All methods take `&State`.
pub trait Protocol<G: Game> {
    type ChunkDelta: Codec; type PlayerDelta: Codec; type GlobalDelta: Codec;
    type Mirror;                                       // client-side partial state
    fn build_deltas(state: &G::State, changes: &ChangeSet<G>, sub: &Subscription, out: &mut DeltaOut<G>);
    fn apply_delta(mirror: &mut Self::Mirror, d: &Delta<G>);
    fn interpolate(a: &Self::Mirror, b: &Self::Mirror, t: f32, out: &mut RenderState<G>);
    /// Prediction = run the same rule code against the partial mirror; bail if data is missing.
    fn predict(mirror: &mut Self::Mirror, who: PlayerId, action: &G::Action) -> Predicted;
}

// ---------- game crate ----------
engine::export_game!(MyGame);   // emits the WASM exports for every role (sim, client, tools)
```

Points that matter:

- **Subscriptions are host state.** `Subscription`, viewports and presence live in a `HostState` that is not snapshotted, not hashed, and not reachable from `ApplyCx`. `build_deltas` reads `&State`; it cannot mutate the core. This enforces the camera decision in the type system.
- **The sim must not depend on which chunks are materialized.** Chunk generation is triggered by cameras (nondeterministic order and timing), so an unmodified chunk is a cache entry, not state: `World::get` generates on demand, and only *modified* chunk layers are saved. "Only tick loaded chunks" rules would let the camera mutate the world and must be impossible. (Cross-domain with `world.md`.)
- **Rules should be written against an access trait** (`WorldAccess`) implemented by both the full `World` and the client `Mirror`, so prediction reuses rule code; missing data returns `Unloaded` and prediction declines. The exact shape is `sync.md`'s.
- **`Codec`** is the engine's serialization bound (3.5): `serde::Serialize + DeserializeOwned` if postcard is chosen.

**TypeScript side.**

- `#[derive(TS)]` on `Config`, `Action`, `Reject`, and the UI-facing view types. A `cargo test`-driven step (wrapped by the engine's build tooling) writes `bindings/*.ts` into the game package. Works with or without wasm-bindgen.
- Dispatch: `engine.dispatch(action: Action)` → `JSON.stringify` → bytes into linear memory → the *client-side* WASM parses JSON to `G::Action`, runs prediction, and emits the binary (postcard) encoding for the transport and the log. Allocation happens only at human input rate, which the zero-GC proposal exempts (DOM UI path). The server never parses JSON.
- Avoid `u64` in TS-facing types (JSON cannot carry `bigint`): ticks exposed to TS are `u32` (6.8 years at 20 Hz) or the binding is configured to `number`.
- A game that adds a continuous input stream (3.12 option b) should not send it through JSON; the engine offers a typed fast path for one "input" struct per frame written directly into linear memory.

*Main alternative rejected:* **tsify/wasm-bindgen object passing**, because it binds the type story to wasm-bindgen's allocating ABI before `runtime-and-packaging.md` has decided on it. *Also rejected:* schema-first IDL (Rust stops being the source of truth), hand-written TS types (drift), and a generated TS binary encoder (more code to get exactly right for no measurable benefit at UI rates; can be added later without changing the log format).

### 3.2 Determinism in practice

**Recommendation (high confidence): the server runs the same `.wasm` module as the browser, inside a JS runtime.** Native builds exist only for fast `cargo test` and tooling and carry no determinism guarantee.

Why: with one binary, libm, `usize` width, codegen, and allocator behavior are identical by construction; the only in-spec divergences left are NaN bits, relaxed-SIMD (off), threads (none), and imports (controlled). It also matches the fixed decision that the engine ships a JS **server entrypoint** in the npm package, keeps the game's build to one target, makes single-player saves and server saves interchangeable (3.8), and makes client prediction agree bit-for-bit with authority. The cost is roughly 1.2-2x slower than native, irrelevant at 2-8 players. *Alternative rejected:* native server binary: needs a second toolchain target per game, a Rust WebSocket/storage stack per host, the libm/usize/HashMap discipline forever, and a CI job proving wasm-native equivalence that can only ever sample.

The determinism rules, each mechanically enforced where possible:

| Rule | Enforcement |
|---|---|
| No `relaxed-simd`, no `atomics` target features in the sim build | Engine build tooling owns `RUSTFLAGS`; test inspects the module's feature/target sections |
| No ambient imports (`Date.now`, `Math.random`, `performance.now`, `getrandom`) | **Test that parses the `.wasm` import section against an allowlist.** Cheap and airtight |
| NaN bits never observable: no NaN in state; codec writes canonical NaN; no `to_bits`/`total_cmp`/`copysign`/`is_sign_*` on values that could be NaN | `Codec` for floats canonicalizes and `debug_assert!(is_finite)`; clippy `disallowed_methods` |
| Prefer integers/fixed-point for persistent quantities (coords, counts, timers); floats fine for dynamics | Convention + review |
| No `std::collections::HashMap/HashSet` in sim state; use `BTreeMap`, `IndexMap`, sorted `Vec`, engine arenas (free list serialized) | clippy `disallowed_types` in the engine's shared lint config |
| RNG: engine-owned `SimRng`, state in the snapshot; hand-rolled PCG32 (or xoshiro) with integer-only range sampling (Lemire); `fork(stream)` for independent streams; worldgen uses a stateless coordinate hash | Engine API: there is no other RNG in `ApplyCx` |
| No wall clock, no I/O: time is `cx.tick` | Import allowlist + API shape |
| `save`→`load` reproduces behavior exactly | **Heavy-mode test** (below) |

*RNG alternative rejected:* `rand` + `rand_pcg`/`rand_chacha`: portable, but value-breaking changes are allowed in minor releases, `usize` sampling is non-portable, and it is ~40 lines to own instead.

**Test kit (belongs in `testing.md`, listed here because the design depends on it):**

1. *Replay equality:* run script → state hash H; replay the produced log from genesis → H.
2. *Heavy mode:* every tick (or every N), `save` → fresh instance → `load` → continue; hashes must match the uninterrupted run. Finds hidden state, as it does for Factorio.
3. *Cross-engine:* the same log replayed in Node (V8, x86 CI) and in Playwright Chromium/Firefox/WebKit produces the same hash. Add an ARM runner when available; that is the only place NaN-sign differences could appear.

### 3.3 Action timing, ordering, validation, rejection

**Recommendation (high confidence): the host assigns ticks and order; the log order is the canonical order.**

- An action received while tick *T* is current is scheduled for tick *T+1* (Factorio's "include it in the next tick"). Clients never choose ticks. No input delay, no waiting for slow clients.
- Within a tick, actions apply **in host arrival order**, before `tick()` runs: `for a in frame { apply(a) }; state.tick()`. The host is the single sequencer, so arrival order is total, fair, and costs nothing; the log records it positionally. *Alternative rejected:* sort by player ID (needed only in peer lockstep with no arbiter; gives low IDs permanent priority).
- The engine, not the client, stamps `who: PlayerId` from the connection.
- Pipeline per action: **decode** (malformed → drop + protocol error) → **admit** (host-side, non-sim checks, rate limit; 3.12) → **append to log (write-ahead)** → **apply** at *T+1* (deterministic validation inside `apply`) → **ack**.
- Each client action carries a per-connection `seq: u32`. The result is piggybacked on that client's delta for tick *T+1*: `Ack { seq, tick, result: Ok | Rejected(G::Reject) }`. Deltas are on a reliable ordered transport, so the ack arrives together with the authoritative state it produced.
- Prediction layer: keeps a queue of unacked actions; on each authoritative delta it drops actions `<= seq`, rebases remaining predictions on the new state, and for `Rejected` also raises a UI event (`onActionRejected(seq, reason)`) so the game can show feedback. Smoothing of the visual correction is `sync.md`'s concern.
- Admission rejections never reach the log; sim rejections do (the action is in the log, and replay deterministically rejects it again). Both reach the client through the same `Ack`.
- Connection events are actions in the same stream (`Joined/Connected/Disconnected`), sequenced like any other. The host should debounce `Disconnected` (grace period, e.g. 15-30 s) so mobile reconnect blips are not world events (ties to sessions in `sync.md`).

### 3.4 Replay vs. code changes (version stamping and upgrade behavior)

**Recommendation (medium-high confidence):**

- **Sim identity = content hash of the built `.wasm`** (128-bit truncated SHA-256 computed at build time and embedded via the bootstrap), plus human-readable `engine_version`, `game_version`, and `SCHEMA_VERSION`. The hash is strict on purpose: a toolchain bump can change libm or codegen.
- The log is a sequence of **segments**. Every segment header and every snapshot header carries the identity. A segment is replayable only by the module with the same hash, **starting from that segment's base snapshot** (segment 0's base is genesis = `Config`).
- **On load, if the running hash differs from the stored one:** load the latest snapshot (via `migrate` if `SCHEMA_VERSION` differs; 3.5), replay the short tail after it *with the new code*, immediately write a snapshot, seal the old segment, and open a new segment based on that snapshot. The tail replay under new code is safe because `apply` validates everything (worst case an action is now rejected); it may differ slightly from what was originally simulated, which is acceptable for at most one snapshot interval of history and is flagged in the segment header (`tail_reexecuted: true`).
- Keeping that tail near-empty: snapshot on every clean boundary we can detect (server `SIGTERM`/host shutdown hook, zero-player pause, browser `visibilitychange→hidden` and `pagehide`).
- "Replay the world" across versions therefore means: replay each segment from its base snapshot with its own binary. End-of-segment hash vs. next base-snapshot hash is a verification that may legitimately differ only where `tail_reexecuted` is set.
- Whether to **archive old `.wasm` binaries** alongside the world (about 1-3 MB per version) so old segments stay replayable without checking out old commits is a cost/taste call: see Questions for Tyler. Default: not in v1; the hash plus `game_version` is enough to rebuild from git.

*Alternative rejected:* semantic "sim version" constants bumped by hand (will be forgotten exactly when it matters); attempting cross-version replay from tick 0 (unsound by definition).

### 3.5 Snapshots: format, cadence, consistency, compaction, schema evolution

**Format (medium confidence): postcard 1.x via serde for snapshots, the action log, and as the default payload codec; an engine-owned hand-written container around it.**

- Container: `magic | container_version u16 | identity (3.4) | schema_version u32 | tick u64 | log_position (segment, byte offset) | engine_section_len | game_section_len | … | state_hash u64 | crc32`. Engine section: tick, `SimRng`, player table, modified chunk layers. Game section: `State::save`.
- Why postcard: documented stable wire format since 1.0, maintained, varints make actions a few bytes, serde derive is what game authors already know and what ts-rs reads. *Rejected:* bincode (unmaintained, RUSTSEC-2025-0141); bitcode (format stability is a stated non-goal, wrong for an indefinite log); rkyv (zero-copy is wasted on small worlds, archived-type ergonomics leak into game code, not evolvable); fully hand-rolled derive (keeps deps at zero but is a proc-macro project of its own; revisit only if the Rust dependency policy in `runtime-and-packaging.md` forbids serde). The engine hides the choice behind `Codec`/`Writer`/`Reader` so it can be swapped without touching games.
- Bulk tile layers bypass serde: written as raw little-endian arrays (optionally RLE) through `Writer::bytes`.
- Canonical bytes are required (state hash = hash of snapshot bytes; 64-bit, e.g. hand-rolled xxHash64/FNV-1a): another reason for ordered collections only.

**Consistency.** Snapshots are taken at a tick boundary, after tick *N* completes. The header records the log position of the first frame with tick > *N*. Recovery = newest snapshot whose CRC verifies → seek to its log position → re-apply frames until the first truncated or CRC-failing frame (truncate the file there) → resume at the last applied tick. Serialization is synchronous inside the core (a consistent cut for free); the bytes are written out afterwards. Write to a temp name, then rename/replace, then update the manifest; keep the previous snapshot until the new one verifies.

**Cadence.** Every **60 s of sim time** if anything changed, plus every detectable clean boundary (3.4). This bounds crash-recovery replay to ~1,200 ticks at 20 Hz (well under a second for a small world). Per-game configurable.

**Compaction: none. Keep the full log from tick 0** (high confidence). At the measured sizes (3.9) the whole history of a long-lived world is tens of MB; compaction would buy nothing and would break the Requirement. Prune *snapshots* instead: keep genesis config, the base snapshot of every segment (needed to replay that segment), and the latest two.

**Schema evolution (medium confidence):** `SCHEMA_VERSION` + an optional `migrate(from_schema, reader)` hook, default "unsupported". If the schema version matches (the common case: rules changed, layout did not), the old snapshot loads directly under the new code. If it differs and the game supplies no migration, the engine reports `SaveIncompatible` to the game's TS, leaves the files untouched (so an older build or an export can still read them), and the game decides (offer a new world). This gives "upgrades may invalidate saves during prototyping" as the zero-effort default while leaving the Factorio-style path (keep `StateV1`, write `From<StateV1>`) open. *Rejected:* a self-describing evolvable format (CBOR/MessagePack with named fields, protobuf): pays size and speed on every snapshot to make only the easy migrations (added field with default) automatic, and still needs hooks for real ones.

### 3.6 Storage

**Browser (high confidence): OPFS with sync access handles, owned exclusively by the sim worker.** IndexedDB is not used in v1. Layout per world: `worlds/<id>/manifest`, `log/<segment>.evl`, `snap/<tick>.evs`.

- **Single owner:** the sim worker takes `navigator.locks.request("world:<id>", { ifAvailable: true })` for its lifetime. If unavailable, the engine surfaces `WorldBusy` and the game shows "open in another tab". The exclusive OPFS handle is the backstop.
- **Eviction:** call `navigator.storage.persist()` once after a user gesture at world creation; expose `{ persisted, usage, quota }` to the game. Do not depend on the answer.
- **Safari private mode / OPFS missing:** fall back to an in-memory adapter and surface `durable: false` so the game can warn. (An IndexedDB adapter is possible behind the same interface if this ever matters.)
- Safari's 7-day rule cannot be engineered away in a browser tab; see export/import in Questions for Tyler.

**Host-agnostic interface (medium-high confidence).** One small interface, implemented for OPFS, memory, and Node `fs` by the engine; hosts such as Durable Objects or S3-style stores get adapters written by the deployer:

```ts
interface WorldStorage {
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, bytes: Uint8Array): Promise<void>;   // atomic replace
  append(key: string, bytes: Uint8Array): Promise<void>;  // resolves when accepted; see sync()
  sync(key: string): Promise<void>;                        // durability barrier (flush/fsync); may be a no-op
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}
```

Object stores cannot append; their adapter emulates `append` by writing numbered part objects (`log/0003/000045`) and `read` concatenates them. The segment format is already frame-delimited with per-frame CRCs, so partial parts are tolerated. In the browser worker the OPFS implementation is synchronous underneath; the engine's worker may call a sync variant directly to keep Promise garbage out of the tick path (a `runtime-and-packaging.md` detail). Zero npm dependencies either way.

*Alternative rejected:* IndexedDB primary (no append, structured clone and event garbage per write, slower for bytes); SQLite-WASM (a large dependency solving a problem we do not have).

### 3.7 Time units (seconds → ticks)

**Recommendation (medium-high confidence):** the tick rate is a **compile-time constant of the game** (`Game::TICK_RATE`), part of the sim identity. Authors write durations in real units; the engine converts to integer ticks at compile time with integer math; state stores ticks.

```rust
pub struct Ticks(pub u32);
impl TickRate {
    /// ceil-free nearest rounding, integer only, never 0 for a non-zero duration.
    pub const fn millis(self, ms: u32) -> Ticks {
        let t = (ms as u64 * self.hz as u64 + 500) / 1000;
        Ticks(if t == 0 && ms > 0 { 1 } else { t as u32 })
    }
    pub const DT: f32 /* = 1.0 / hz */;
}
const COLLECT: Ticks = G::TICK_RATE.millis(2_000);   // 40 ticks at 20 Hz, 60 at 30 Hz
```

- Discrete durations (collect 2 s, craft 5 s, smelt 5 s): `millis()` constants. Rounding error is at most half a tick (25 ms at 20 Hz).
- Rates ("1 coal per 10 ingots") stay as counts, not per-tick fractions. Where a per-second rate is unavoidable, use integer accumulators (`acc += units_per_sec; while acc >= hz { acc -= hz; emit }`), which are exact at any tick rate.
- Continuous dynamics (a spring, velocities): author constants per second and integrate with `DT`. Feel is preserved to first order when the rate changes; stiff springs should use a dt-independent form (analytic critically-damped spring) rather than explicit Euler.
- Changing the tick rate is a sim-identity change like any other (new segment). Stored tick counters (remaining craft time) would be rescaled by a `migrate`; during prototyping, simply bump `SCHEMA_VERSION`.

*Alternative rejected:* sim time in integer microseconds with deadlines stored in time units (rate-independent snapshots, but every comparison and every author-facing API gets more awkward to save a migration that prototyping rarely needs).

### 3.8 Single-player world later hosted as multiplayer

**Recommendation (high confidence it is feasible; cheap to keep):** yes by construction. Same `.wasm` (3.2), same container formats, same `WorldStorage` keys, and single-player uses a real opaque `PlayerId` and logs `Joined/Connected` like multiplayer. Moving a world = copy its storage directory (or one export blob) to the server's storage. With identical binaries the sim identity even matches, so the log continues in the same segment. The engine-level `exportWorld()/importWorld()` primitive is the only code needed; whether a game exposes it is the export/import question for Tyler.

### 3.9 Log growth (connection + game actions only)

Frame layout (one frame per tick that has actions): `len varint(1) | tick_delta varint(1-2) | count varint(1) | records… | crc32(4)`; record: `kind(1) | player_slot(1) | payload`. Player slots index a table written once per join, so 16-byte IDs are not repeated. Typical reference-game payloads under postcard: tile coords as two zigzag varints (2-6 B), item/recipe id (1 B), count (1 B) → 3-8 B.

Result: **~16 B per action when it is alone in its frame, ~10 B when frames are shared.** Connection events are ~9 B each and negligible (even 60 reconnects/hour is 0.5 KB).

| Scenario | Actions per player-hour | Bytes/action | Per player-hour |
|---|---|---|---|
| Casual (one action per 4 s) | 900 | 16 | **14 KB** |
| Active (1 per second, sustained) | 3,600 | 16 | **58 KB** |
| Heavy drag-building (5 per second, sustained) | 18,000 | 10 | **180 KB** |
| Same "active" rate as JSON lines (~110 B) | 3,600 | 110 | 396 KB |
| *Option (b) movement stream, 10 Hz, quantized 1/16-tile deltas* | 36,000 | 8 | *288 KB* |
| *Option (b), 20 Hz, quantized* | 72,000 | 8 | *576 KB* |
| *Option (b), 20 Hz, naive 2×f32 in own frame* | 72,000 | 19 | *1.37 MB* |

Lifetime check: 4 players × 200 hours = 800 player-hours → **46 MB** at the "active" rate; 460 MB with a 20 Hz quantized movement stream (before gzip, which typically gives 2-4x on sealed segments via `CompressionStream`). Against quotas of 10 GiB (Firefox best-effort) to 60% of disk, "indefinitely" is affordable with a plain binary encoding and no compaction. JSON would also fit but is 7x larger for no benefit. If a game adds a continuous input stream, that stream is >90% of the log, and the levers are: send only on change, quantize, delta-encode against the previous sample, cap the rate at the tick rate, gzip sealed segments.

### 3.10 Browser durability and acceptable loss window

**Recommendation (medium-high confidence):**

- The log is the durability mechanism. **Write-ahead:** a frame is `write()`n to the OPFS handle *before* it is applied. A `write` that has returned survives tab close, worker termination, and renderer crash (weak durability).
- `flush()` at most **once per second** when dirty (bounds loss on OS crash/power loss to 1 s of actions without paying a flush per frame on slow mobile storage).
- Ticks that pass with no actions are not logged; after a crash the world resumes at max(last snapshot tick, last logged frame tick). With 60 s snapshots this loses **at most 60 s of action-free simulation** (e.g. a furnace re-smelts a few ingots), which no player can distinguish from the tab having been paused.
- **The number:** admitted actions lost on tab close/crash: **0** (at most the single in-flight frame); on power loss: **≤ 1 s**; idle progress lost: **≤ 60 s (1,200 ticks at 20 Hz)**. Server: same policy via `append` + `sync` every 1 s; adapters on object stores batch appends every 1-2 s, so ≤ 2 s.
- Extra snapshots on `visibilitychange→hidden` and `pagehide` (best effort; never relied on).
- After any recovery the host bumps a **session epoch**; clients seeing a new epoch discard predicted and interpolated state and take a full resync, since ticks after the recovery point are re-lived.
- Eviction, multi-tab, private mode: see 3.6. Export/import: see Questions for Tyler (recommended in scope at the engine level because it is the only real answer to Safari's 7-day rule for single-player).

### 3.11 Sim crash recovery

**Recommendation (medium-high confidence):** build the sim `panic=abort` on stable Rust; treat any trap as "instance is garbage"; recover by re-instantiation. Do not adopt `panic=unwind` now (nightly + `-Zbuild-std`, and OOM/stack overflow still abort).

1. The host wraps every export call in `try/catch`. On `WebAssembly.RuntimeError` it marks the instance dead and never calls it again. The compiled `WebAssembly.Module` is kept, so a new instance is cheap.
2. New instance → load latest valid snapshot → replay the log tail → bump session epoch → resume ticking.
3. **Deterministic crash loops:** a panic is deterministic, so replay may hit it again. If the trap recurs during replay *inside `apply` of frame F, record R*, the host appends a `Skip { segment, offset }` record, restarts recovery honoring it, and sends `Rejected(EngineFault)` to the originating client if connected. The log stays append-only and replay stays exact (skip records are part of the log). If the trap recurs inside `tick()` (not attributable to one action), the world is wedged under this build: stop, keep all files intact, surface `onFatal({ tick, message })` to the game's TS. A fixed build then loads the last snapshot through the normal upgrade path (3.4).
4. Panic message capture: a minimal imported `host_panic(ptr, len)` hook (on the import allowlist; output only).
5. **What clients see.** Multiplayer: sockets stay open (the JS host survived); the host sends `Resyncing`, recovery takes well under a few seconds for a 60 s tail, then every client gets the same full resync used for reconnects. Single-player: identical, over the worker channel. If the *worker itself* dies (usually the whole tab is gone with it), the main thread's `error`/heartbeat handler respawns it and the same recovery runs.
6. `memory.grow` failure → Rust alloc error → abort → same path; if it recurs it is fatal (world exceeds the device; ties to the memory-cap question in `runtime-and-packaging.md`).

### 3.12 Player position: presence (a) vs. movement action (b), and is "validate at admission, log only admitted, replay without re-validating" sound?

**Soundness analysis.** The pattern mixes two different kinds of check, and it is sound for one of them only:

1. *Checks against non-sim state* (presence, rate limits, connection status). Their inputs are not in the log, so replay **cannot** re-run them. Logging only what passed is exactly event sourcing's command→event step and is sound **if and only if** (i) the core never reads presence, and (ii) anything the core needs from non-sim state is copied into the logged action as a **witness** (e.g. the position the player was at). Then the log is self-contained.
2. *Checks against sim state* (resource exists, inventory has the item, tiles buildable). These must live in `apply` and **must run in replay too**. They are deterministic, so re-running them gives the same verdict for free; skipping them would create a second code path (`apply_unchecked`) used only in replay and only after crashes and upgrades, which is precisely where divergence hides. It would also make the upgrade-tail re-execution in 3.4 unsafe.

So: **"log only admitted actions" is sound; "replay applies without re-validating" should be narrowed to "replay does not re-run *admission*; `apply` always validates sim-state rules."** Write-ahead logging forces this anyway: the frame is logged before `apply` runs, so the log necessarily contains admitted actions that the sim then rejects (deterministically, harmlessly).

**What option (a) demands of the engine:**

- A **presence channel**: per-player ephemeral `G::Presence`, relayed to subscribers, unlogged, absent from snapshots and hashes.
- The **`Admission` hook** (3.1) run by the host only. It is not covered by replay tests and needs its own unit tests.
- **Stale-presence problem:** the server's view of a player's position lags by about half an RTT plus the presence send interval, so an honest player who just arrived in range would be refused by a strict server-side range check. The clean fix is a **witness-carrying action**: `Collect { target, from: Pos }`, where the client stamps its own position; `apply` checks `dist(from, target) <= R` **deterministically from the action's own data** (replayable, same code path, predictable on the client with zero error), and `admit` merely checks that `from` is plausible versus last known presence within a tolerance. That is fully consistent with the trust model ("server-authoritative validation is enough; no further anti-cheat").
- **Ongoing conditions:** "collecting takes 2 s" raises "must the player stay in range?". Under (a) the core cannot see the player leave. Either range is checked only at start (recommended, simplest), or the host must inject a logged `CancelCollect` when presence leaves range: a host-originated action, which works but adds a concept.
- **Coverage gap:** under (a) no *sim* entity ever moves, so delta-driven interpolation of moving entities and continuous-input prediction/reconciliation are exercised only via presence, not via the delta path. If the engine claims those features, the reference game needs one small moving sim entity (flag for `reference-game.md` feature coverage).
- Disconnected players have no position; on reconnect it derives from the camera. Nothing to persist.

**What option (b) demands:**

- Nothing new in the log/replay design: a movement action is just an action. It needs the fast input path (no JSON), rate capping at the tick rate, quantization and delta encoding (3.9), and it multiplies the log by roughly 5-40x (still affordable).
- The spring runs in the core in floats: fine under 3.2.
- Full predicted-movement reconciliation in `sync.md` (the classic hard case), and position lives in snapshots.
- Tension with the fixed decision's intent ("the camera lives independently of the sim"): the camera itself stays a non-action, but a game-sampled shadow of it is streamed into the sim continuously.

**Recommendation (medium confidence): (a), in its witness-carrying form, with range checked at action start.** It honors the camera decision, keeps the log at the 14-58 KB/player-hour level, removes stale-presence rejections, and keeps a single validate-in-`apply` code path for live, replay, and prediction. The engine's action pipeline should still not preclude (b) (it costs nothing: fast input path + quantized encoding can come later), since a future game with real collision will need sim-side positions.

### 3.13 Idle worlds

**Recommendation (high confidence on replay safety; defaults are taste):**

- **Replay safety is structural:** the core has no clock; only the host calls `tick()`. Pausing is "the host stops calling `tick()`"; the tick counter simply does not advance. Nothing about a pause is logged or needs to be. Replay runs ticks as fast as it likes.
- **Multiplayer, zero connected players:** after the disconnect grace period, snapshot and **pause** (Factorio's dedicated-server default). Resume on the next connection. This is also the only behavior compatible with hosts that hibernate idle processes (Durable Objects). Per-game config `idle: Pause | KeepTicking` for games that want factories to run overnight on a VM.
- **Single-player, tab hidden:** main thread tells the sim worker to snapshot and **pause** on `visibilitychange→hidden`; resume on visible. Timer throttling and iOS page freezing make background ticking unreliable anyway, and an explicit pause is predictable.
- **Catch-up clamp:** when the scheduler wakes late, run at most a few catch-up ticks (e.g. ≤ 5) per wakeup and let sim time fall behind wall time, so a throttled or stalled host never spirals. Deliberate "offline progress" (run K fast ticks on return) would also be replay-safe, since ticks are only ever counted, but it is a game-feel feature and out of scope by default.

---

## 4. Cross-domain interactions

- **world.md:** the sim must be independent of chunk materialization (3.1). Worldgen must be a pure, order-independent function of `(Config, coord)`; only modified layers are persisted. If clients generate chunks locally, bit-identical worldgen relies on the same-`.wasm` rule. The tile-trait question ("placement asks the tiles") lives inside `apply` validation and must be usable against the client mirror for prediction.
- **sync.md:** `Ack { seq, tick, result }` rides on deltas; the **session epoch** after crash recovery; the **version handshake** should compare the same `.wasm` content hash used for log identity; disconnect debounce vs. logged `Disconnected`; per-chunk hashes for desync detection should reuse the canonical codec; presence is a new ephemeral channel alongside deltas if option (a) is chosen; prediction wants rules written against a `WorldAccess` trait.
- **runtime-and-packaging.md:** "server runs the same WASM" means the server entrypoint targets JS runtimes (Node/Bun/Deno/workerd) and answers the "native Rust server binary?" question with no. ts-rs keeps type generation independent of the wasm-bindgen decision, but needs a native `cargo test` step in the build. The import allowlist test constrains which crates may be linked into the sim (no `getrandom` with the `js` feature, no `js-sys` clock calls in core code). Serde + postcard is a Rust dependency-policy decision. OPFS sync handles require the sim to be in a **dedicated** worker (not shared). `memory.grow` failure is a trap: preallocation policy affects crash behavior. The engine build must own `RUSTFLAGS` (no relaxed-simd/atomics in the sim module); if the renderer wants WASM threads or SIMD, that argues for it being a separate module from the sim.
- **testing.md:** replay-equality, heavy-mode, cross-engine hash, and import-allowlist tests are the enforcement for this whole document and should be early milestones. Native `cargo test` is for speed only; the authoritative determinism tests run the `.wasm`.
- **reference-game.md:** option (a) leaves nothing moving in the sim (coverage gap); "must the player stay in range for 2 s?" needs an answer; `u64` should be avoided in TS-facing types.
- **client.md:** `onActionRejected`, `onFatal`, `WorldBusy`, `SaveIncompatible`, `durable: false`, and storage estimates are engine→game-UI events the TS surface must carry.

---

## 5. Needs a spike

No decision here strictly hinges on feasibility; the WASM spec, not an experiment, is what guarantees 3.2. Two cheap verifications are worth folding into existing spikes or the first test milestone rather than blocking decisions:

1. **Cross-engine replay hash** (V8, SpiderMonkey, JSC via Playwright, plus Node): a float-heavy toy sim (spring + `sin` + RNG) run for ~10⁵ ticks must hash identically. Confirms 3.2 empirically and becomes the permanent test.
2. **OPFS append/flush latency on iOS Safari** from a dedicated worker (write 16-byte frames, flush at 1 Hz; 1 MB snapshot write). Only tunes the numbers in 3.10; the fallback (flush less often) is trivial.

---

## 6. Questions for Tyler

1. **Player position: (a) presence or (b) movement action?** Recommended default: **(a)**, with actions carrying the player's position as a witness and range checked once when the action starts (3.12). Follow-up if (a): is it fine that collecting does not cancel when the player drifts out of range? (Default: yes.)
2. **May upgrades invalidate saves during prototyping?** Default: **yes**. The engine ships the `SCHEMA_VERSION` + optional `migrate` hook; games that skip it get a clean "save incompatible" event instead of corruption.
3. **Save export/import in scope?** Default: **yes at the engine level** (`exportWorld()` / `importWorld()` on the storage layer, a day of work), because it is the only real protection against Safari's 7-day eviction for single-player and it is the mechanism for moving a single-player world to a server. Game UI for it stays optional.
4. **Idle behavior.** Defaults: multiplayer **pauses at zero players**; single-player **pauses when the tab is hidden**; no offline progress. Per-game config can override the first.
5. **Archive old sim binaries with the world** so every historical log segment stays replayable without rebuilding old commits (about 1-3 MB per version)? Default: **no for now**; headers record the wasm hash and game version, which is enough to rebuild from git.
6. **Rust dependencies in the sim:** is `serde` + `postcard` (+ `ts-rs` at build time) acceptable under the spirit of "zero dependencies", which is stated for npm only? Default: **yes**; the alternative is an engine-owned derive macro, which is weeks of work for little gain.

## Spike results

- **Cross-engine determinism:** see `spikes/determinism-hash/RESULT.md` (std transcendentals and NaN bit patterns diverge; everything else tested matched).
