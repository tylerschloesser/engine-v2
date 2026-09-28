// Main-thread entrypoint (`engine`): `createClient`'s spawn path (docs/plan/06b-workers-and-spawn.md).
// Checks isolation, compiles the module once, creates the `SabSet`, spawns the worker set for the
// chosen topology, and posts each worker its `Module` (or `wasmUrl`), its SABs and its config.
import { CameraBlockView, writeCameraBlock } from './camera/block.js'
import type { CameraInput, CameraIntegrator, MoveToOptions, Rect } from './camera/camera.js'
import { createCameraIntegrator } from './camera/camera.js'
import { cameraStorageKey, restoreCameraState, saveCameraState } from './camera/persistence.js'
import { CameraState, copyCameraState } from './camera/state.js'
import type { CameraViewport, ScreenPoint } from './camera/transform.js'
import { screenToWorld, worldToScreen } from './camera/transform.js'
import { hexEncode, loadOrMintSecret } from './client/secret.js'
import type { Clock, Scheduler } from './clock.js'
import { systemClock, systemScheduler } from './clock.js'
import { CLOCK_FIELD, ClockBlockView, readClockBlockInto, SessionState } from './clock-block.js'
import type { IdentityJson } from './host/persistence.js'
import type { IncompatReasonName } from './host/upgrade.js'
import { installBlurAndVisibilityReset } from './input/focus.js'
import { installKeyListeners, KeyState } from './input/keys.js'
import { createPicker, type Picker } from './input/pick.js'
import { installPointerListeners, PointerSlots } from './input/pointers.js'
import { createSemanticRecognizer, type SemanticRecognizer } from './input/semantic.js'
import { installWheelListeners, WheelState } from './input/wheel.js'
import type { InstanceConfig } from './loader.js'
import { createOverlay, type Overlay, type OverlayOptions } from './overlay/anchors.js'
import { createDrawListSlot, type DrawListSlot } from './render/drawlist-slot.js'
import { at, copyBytes, readU32LE } from './sab/bytes.js'
import {
  CB_FLAGS,
  CB_FRAME_REQ,
  CB_LIFECYCLE,
  ControlBlock,
  Lifecycle,
  W_PARKED,
  W_YIELD,
  WORKER_CLIENT,
  WORKER_GEN0,
  WORKER_GEN1,
  WORKER_HOST,
  workerWord,
} from './sab/control.js'
import { createSabSet, MAX_GEN_WORKERS, type SabSet, sabBytesTotal } from './sab/layout.js'
import { RingConsumer, RingProducer } from './sab/ring.js'
import {
  buildSimInstanceConfig,
  type WorldConfig as ServerWorldConfig,
  seedToHexU64,
} from './sim-config.js'
import type {
  ClientLifecycleMessage,
  FromWorker,
  NetLinkMessage,
  SimLifecycleMessage,
  SimWorldOpResult,
  StorageStatus,
  TestFlags,
  ToWorker,
  WorkerKind,
} from './worker/protocol.js'

export type { SupportFailure, SupportFailureCode, SupportReport } from './support.js'
export { checkSupport } from './support.js'
// docs/plan/23-persistence-opfs-and-lifecycle.md Seams (Provides): `StorageStatus` is declared in
// `worker/protocol.ts` (so `SimLifecycleMessage` can reference it without a `client.ts` import
// cycle) and re-exported here unchanged -- the same "no renamed Provides" convention `sim-config.ts`/
// `storage/types.ts` already follow.
export type { StorageStatus } from './worker/protocol.js'

/**
 * The real shape (docs/plan/13-sim-host-tick-loop.md, Scope "`createClient` local host"): `server.
 * ts`'s own `WorldConfig` (0009), minus `buildHash` -- `createClient` fills that itself, from
 * `ClientOptions.wasm.buildHash`, the same build the worker set it spawns is instantiated from (a
 * caller would otherwise have to keep two copies of one hash in sync). `Params` defaults to
 * `unknown`, matching `server.ts`'s own default; `ClientOptions` itself stays non-generic (Seams:
 * no renamed Provides).
 */
export type WorldConfig<Params = unknown> = Omit<ServerWorldConfig<Params>, 'buildHash'>

/** docs/plan/09b-terrain-art-and-lifecycle.md, Seams (Provides): `ClientOptions.render`'s exact
 * shape. Defaults (per that brief's own Seams line): `scale` per 0018 §8 (`render/viewport.ts`'s
 * `computeRenderScale`, undefined here means "derive from DPR"), `scaleCap` none (undefined means
 * the derivation's own built-in 2x cap, not a narrower one), `neighbourCutoffPx` 0 ("always read
 * neighbours", already `terrain.wgsl`'s and `FrameUniformValues`'s own default since M09). Not read
 * by `createClient` itself (rendering never touches a WASM instance, 0018 §1) -- kept here so one
 * `ClientOptions` object is also what a caller hands `frame-loop.ts`'s `createRealFrameLoop`, the
 * same pattern `assets` already uses for `render/art.ts`'s `loadTileArt`. */
export type RenderOptions = { scale?: number; scaleCap?: number; neighbourCutoffPx?: number }

/** `sim::EngineReject`'s TS shape, hand-mirrored here (docs/plan/16-action-round-trip.md step 4):
 * `engine` itself has no game to run `export_bindings` against, so this one small, stable enum is
 * kept in sync by hand rather than generated -- `fixtures/puts/bindings/EngineReject.ts` (and any
 * later game's own copy) must read the same three variants. */
export type EngineRejectReason = 'RateLimited' | 'StateBudgetFull' | 'EngineFault'

/** `game_instance::push_result_record`'s exact JSON shape (docs/plan/16-action-round-trip.md
 * Deviations, "The exact JSON"): `Rejected<G>`'s `Game`/`Engine` tag is preserved, not flattened.
 * `Reject` is the game's own `G::Reject` TS type (`fixtures/puts/bindings/Reject.ts`, or a later
 * game's own); `onActionResult`'s caller supplies it as a type parameter for full typing on both
 * halves. `'NotPredictable'` (docs/plan/25-prediction-core.md, `game_instance::
 * push_not_predictable_record`): a declined prediction, surfaced once at dispatch (0003, 0012) --
 * never a local `Rejected`, which is a hint and is not surfaced this way at all. `'Lost'`
 * (docs/plan/28b-reconnect-and-lifecycle.md step 3, `game_instance::push_lost_record`): a pending
 * action `Welcome.last_processed_action_seq` proves the host already processed, but whose own ack
 * died with the old connection before it arrived -- the host keeps no per-session state to replay
 * one from (0013), so neither `Confirmed` nor `Rejected` is knowable; the resync already shows the
 * true outcome in replicated state. */
export type ActionOutcome<Reject = unknown> =
  | 'Confirmed'
  | 'NotPredictable'
  | 'Lost'
  | { Rejected: { Game: Reject } }
  | { Rejected: { Engine: EngineRejectReason } }

/** `Client.onLink`'s own state (docs/plan/29-net-worker-and-reference-server.md steps 1-2, Scope):
 * see `Client.onLink`'s own doc comment for what each value means. Module-scope (not declared
 * inside `createClient`) so the exported `Client` interface can name it. */
export type LinkState =
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'updating'
  | 'superseded'
  | 'rejected'
/** `Client.onLink`'s own `reason`, set only for `state: 'rejected'`. */
export type LinkReason = 'BadKey' | 'Full'

/** `Client.clock()`'s own return shape (docs/plan/16b-ui-observation-and-clock.md Scope): tick
 * counts, not seconds (0006 "On the client": "the UI never counts ticks itself" -- a page derives
 * remaining seconds from a replicated `done_at` tick and this pair). Returned as the same reused
 * object on every call (Planning decisions: "`clock()` returns a reused object"). `predicted`
 * differs from `authoritative` from docs/plan/26-prediction-rendering-and-clocks.md on (0012 "Two
 * clocks": `predicted = authoritative + lead`). `tickFraction` (that milestone's own addition,
 * Seams: "a `tickFraction` field if M16b's object lacks one"): progress into the current tick,
 * `0..1`, for a smooth animation between two ticks. */
export type ClockSnapshot = {
  authoritative: number
  predicted: number
  ticksPerSecond: number
  tickFraction: number
}

/** `client::core::OUTBOX_CAPACITY` (docs/plan/16-action-round-trip.md Deviations): the 0012
 * pending-queue figure, mirrored here so `dispatch` can enforce the same "queue full" backstop
 * Rust's own `on_action` re-checks (defence in depth, not the primary enforcement point either
 * side of the boundary). */
const OUTBOX_CAPACITY = 32

/** One action-ring record's own worst case (`ACTION_RX_BYTES`, `game_instance.rs`): an 8-byte
 * `[seq][len]` header plus generous headroom for the JSON body. `dispatch`/`dispatchRaw` throw
 * rather than silently truncate a payload that would not fit. */
const ACTION_RECORD_BYTES = 1024

/** `UI_BYTES` (`game_instance.rs`): the largest single `client_poll_ui` batch the client role can
 * ever produce, and so the largest single `uiRing` message the per-rAF drain will ever pop. */
const UI_POLL_BYTES = 4096

export interface ClientOptions {
  canvas: HTMLCanvasElement
  wasm: { url: string; buildHash: string }
  host:
    | {
        kind: 'local'
        world: WorldConfig
        /** docs/plan/15b-ring-connection-and-replica-rendering.md, Orchestrator ruling 1: links
         * the sim and client workers over the uplink/downlink ring pair (`SimHost.accept`, the
         * client's own net pump) -- the real single-player topology this milestone lands. Default
         * `false` (unset), by design: every existing `sim`-kind test page constructs `host`
         * without this field and so keeps its own zero-connection topology automatically, with no
         * flag to remember to turn off (Planning decisions). A page that wants a real connected
         * session sets this `true`. */
        connect?: boolean
        /** docs/plan/23-persistence-opfs-and-lifecycle.md steps 3-4: the sim worker's own startup
         * order becomes Web Lock -> OPFS probe -> `Persistence.open` -> tick loop (a world survives
         * tab close/reload, and a second tab opening the same `worldId` gets `WorldBusy`) instead of
         * the M13 in-memory-only stub. Default `false` (unset), the same "no flag to remember to
         * turn off" convention `connect` above already uses: no existing `sim`-kind test page sets
         * this, so none of them gain the OPFS/Web-Lock startup order or its extra async work. */
        persist?: boolean
      }
    | { kind: 'remote'; url: string; joinKey?: string }
  /** Pattern B (0017 §3): the game constructs the worker itself. */
  createWorker?: () => Worker
  /** Bytes; defaults are 0015 §5's per-role arenas. */
  arenas?: { sim?: number; client?: number; gen?: number }
  /** Default per 0008: 2 when `navigator.hardwareConcurrency >= 8`, else 1. */
  genWorkers?: number
  /** docs/plan/11-camera-and-input.md Seams (Provides): the `localStorage` persistence suffix (a
   * game passes its world id, so each world keeps its own camera). `camera/persistence.ts`'s
   * `cameraStorageKey` turns this into the actual key; omitted means `'default'`. */
  cameraKey?: string
  /** docs/plan/09-renderer-terrain.md, Seams (Provides): URL of `tiles.json`; `sprites` (docs/plan/
   * 17b-sprites-and-frame-budget.md Seams, Provides) is URL of `sprites.json`. Not read by
   * `createClient` itself -- rendering is main-thread-only and owns no WASM instance (0018 §1) --
   * kept here so a caller's one `ClientOptions` object is also what it hands `render/art.ts`'s
   * `loadTileArt`/`render/atlas.ts`'s `loadSpriteAtlas`, instead of a second, separately-threaded
   * asset config. `tests/browser/pages/src/gc-drawables.ts` (fix round 1) is the first real page to
   * build one `assets` object and thread it into both `createClient` and the two asset loaders by
   * reference, rather than typing the same URL a second time (every other real-client page still
   * does the latter, unchanged by this cut). */
  assets?: { tiles: string; sprites?: string }
  /** docs/plan/09b-terrain-art-and-lifecycle.md, Seams (Provides). See `RenderOptions`'s own doc
   * comment for defaults and why `createClient` doesn't read this itself. */
  render?: RenderOptions
  /** docs/plan/18-picking-and-overlay.md Seams (Provides): default root is the canvas's own parent
   * element (the engine appends one anchor-layer element there and re-parents each anchored `el`
   * into it, lazily, on the first `client.overlay.anchor` call -- `overlay/anchors.ts`'s own doc
   * comment). `mode: 'translate'` is accepted for the full type but not built by this cut (Non-scope:
   * the per-anchor `translate()` fallback is a later step's). */
  overlay?: OverlayOptions
  /** Test-only escape hatch (Planning decisions: "`createClient` takes `{ clock, scheduler }`
   * through a test-only options field"); never set by a game. */
  test?: {
    clock?: Clock
    scheduler?: Scheduler
    /** Every worker's `game` config, overriding `host.world.game` (real `WorldConfig` plumbing is
     * M07's; tests need to reach a real fixture's config today). */
    game?: unknown
    flags?: TestFlags
  }
}

export interface Client {
  /** docs/plan/16-action-round-trip.md Scope: "M06b's `Client.ready` now also waits for
   * `session_state = 1`" -- but only for `{ kind: 'local', connect: true }`. Every other topology
   * (no `connect`, none at all, or `{ kind: 'remote' }`) keeps `ready`'s pre-M16 meaning, "the
   * worker set is up": a `local` host's own "server" is the sim worker in the same tab (a
   * `RingConnection`, effectively instantaneous), but a real network has no such guarantee (0013
   * Client policy: "the game stays interactive on last known state ... no modal and no error for
   * outages under ~10 s") -- blocking `ready` itself on a `Welcome` that may never arrive would
   * contradict that policy and hang forever on a bad join key, no server yet, or a real outage
   * (docs/plan/29-net-worker-and-reference-server.md steps 1-2, Deviations: found live -- every
   * pre-existing test/device page built on a placeholder, never-dialing `{ kind: 'remote' }` host
   * hung the instant `remote` started dialing for real). Use `client.onLink`'s own `'online'` event
   * to know when a multiplayer session is actually live. */
  readonly ready: Promise<void>
  /** docs/plan/16-action-round-trip.md Scope: JSON-encodes `action` into the action ring and
   * returns its `seq`. Throws `Error("engine: dispatch before ready")` before the session is live
   * (`ready`'s own extended meaning), and `Error("engine: action queue full")` once ready when
   * either the 0012 pending-queue backstop (`seq - ack_seq > `[`OUTBOX_CAPACITY`]) or the action
   * ring itself is full -- both leave `seq`'s own counter unadvanced, so the next call gets the
   * same candidate `seq` again (Deviations: `dispatch_when_queue_full_fails_locally`'s own exact
   * shape). JSON encoding is a human-rate, UI-driven path (0003, 0016 §2's own exemption): this
   * method is not part of the zero-GC surface -- `engine/test.dispatchRaw` is, for a measured
   * window. */
  dispatch(action: unknown): number
  /** docs/plan/16-action-round-trip.md Scope: fires once per drained kind-2 (`ActionResults`) UI-
   * ring record, in ring order, on a per-rAF poll this `Client` runs on its own (no page wiring
   * needed). Returns an unsubscribe function. `Reject` is the game's own `G::Reject` TS type,
   * supplied by the caller for full typing (Deviations: "onActionResult's reason is fully typed on
   * both halves"); default `unknown` when omitted. */
  onActionResult<Reject = unknown>(
    cb: (seq: number, result: ActionOutcome<Reject>) => void,
  ): () => void
  /** docs/plan/16b-ui-observation-and-clock.md Scope: fires with the decoded JSON of the *latest*
   * kind-1 (`Ui`) UI-ring record in a drain, at most once per per-rAF poll (Planning decisions:
   * "`Ui` is coalesced to the newest value per rAF; action results are never coalesced"), and
   * always before any `onActionResult` callback of that same drain (Provides: the delivery-order
   * rule "`onUi` then results", enforced natively by `game_instance::GameInstance::on_frame`,
   * docs/plan/16b Deviations "Delivery order"). No record in a drain, no call. Returns an
   * unsubscribe function. `Ui` is the game's own `G::Ui` TS type, supplied by the caller for full
   * typing, the same convention `onActionResult<Reject>` already uses; default `unknown` when
   * omitted. */
  onUi<Ui = unknown>(cb: (ui: Ui) => void): () => void
  /** docs/plan/23-persistence-opfs-and-lifecycle.md Seams: fires with the persisted world's own
   * `StorageStatus` at load, after the `persist()` answer (Planning decision 5), and after each
   * hidden-boundary snapshot -- `host: { kind: 'local', persist: true }` only; never fires otherwise.
   * Returns an unsubscribe function, the same convention as `onActionResult`/`onUi`. */
  onStorage(cb: (status: StorageStatus) => void): () => void
  /** docs/plan/28b-reconnect-and-lifecycle.md step 2 (Seams: "a per-event subscription in the
   * style of `client.onUi`; there is no `EngineEvent` union"): fires once, with no payload, the
   * instant this client's own linked connection detects a *second* `Welcome` on an already-`Online`
   * session (0013 Reconnect / 0005 Panic recovery: after a host restart, panic recovery, or an
   * upgrade bump) -- `session_state` reads `Resyncing` at the moment this fires and `Online` again
   * immediately after (the same terminal state a plain join's own `Welcome` reaches). Never fires
   * for a topology with no linked client worker (`host.kind !== 'local'`, or M29's net worker,
   * Non-scope here). Returns an unsubscribe function. */
  onResyncing(cb: () => void): () => void
  /** docs/plan/29-net-worker-and-reference-server.md steps 1-2 (Scope: "Link events"): a per-event
   * subscription in the style of `onUi`/`onResyncing`, fired with this client's own multiplayer
   * link state (`connecting | online | reconnecting | updating | superseded | rejected`) --
   * `reason` is set only for `'rejected'` (`'BadKey' | 'Full'`; a version mismatch is handled by
   * `onVersionMismatch`/the default reload flow instead, never surfaced here as `'rejected'`).
   * `reconnecting` is emitted only after the indicator delay of 0013 (1 s); the game stays
   * interactive on last-known state throughout. Never fires for a `{ kind: 'local' }` host (no net
   * worker). Returns an unsubscribe function. */
  onLink(cb: (e: { state: LinkState; reason?: LinkReason }) => void): () => void
  /** docs/plan/29-net-worker-and-reference-server.md steps 1-2 (Scope): replaces the default
   * build-hash-mismatch handler outright (0013 "Build-hash handshake": reload once, guarded by
   * `sessionStorage['engine.reloadedFrom']`; a mismatch that survives a reload of the same hash
   * goes `updating` and retries on 0013's own backoff schedule) -- one override, not a listener
   * list, mirroring 0013's own "the engine raises an event whose default handler..." (a mismatch
   * has exactly one reaction, never several independent ones). Returns an unsubscribe function that
   * restores the default handler when called (a no-op if a later `onVersionMismatch` call already
   * replaced this one). Never fires for a `{ kind: 'local' }` host. */
  onVersionMismatch(cb: () => void): () => void
  /** docs/plan/23-persistence-opfs-and-lifecycle.md step 5, Seams: packs the running world's own
   * key set (0005 Storage) into a gzip archive (`storage/archive.ts`) and resolves with it as a
   * `Blob`. Parks the sim worker, pauses it (snapshot-if-dirty, flush) only if it was not already
   * paused, packs, resumes it back to exactly the state it was in before (Planning decision 6;
   * Deviations "well-defined under an overlapping hidden-boundary pause"). Rejects with
   * `NotSinglePlayer` when there is no sim worker (`host.kind !== 'local'`). */
  exportWorld(): Promise<Blob>
  /** docs/plan/23-persistence-opfs-and-lifecycle.md step 5, Seams: writes `bytes` (a previously
   * exported archive) under `opts.worldId` or the archive's own id. Refuses the running world's own
   * id and refuses an existing id without `opts.overwrite` (`WorldExistsError`, `storage/
   * archive.ts`). Never loads the imported world itself (Planning decision 6): the caller starts it
   * with a new `createClient`. Rejects with `NotSinglePlayer` when there is no sim worker. */
  importWorld(
    bytes: Blob | Uint8Array,
    opts?: { worldId?: string; overwrite?: boolean },
  ): Promise<{ worldId: string }>
  /** docs/plan/23-persistence-opfs-and-lifecycle.md step 5, Seams: deletes every key of `worldId`
   * (`storage/archive.ts`'s `deleteWorld`). Refuses the running world's own id (Deviations: the same
   * safety rule Planning decision 6 gives `importWorld`, extended here since deleting a world's
   * storage out from under its own live `Persistence` is undefined). Rejects with `NotSinglePlayer`
   * when there is no sim worker. */
  deleteWorld(worldId: string): Promise<void>
  /** docs/plan/16b-ui-observation-and-clock.md Scope: `client.clock()` exposes the clock block --
   * `authoritative`/`predicted` tick counts (`predicted` equals `authoritative` until M26 gives
   * prediction a real lead, 0012) and the game's own `ticksPerSecond` -- refreshed from the clock
   * block on every call and returned as the *same* reused object (Planning decisions: "a fresh
   * object per call would put game-UI polling on the main isolate's budget"): read the fields, do
   * not keep the object past the next call. */
  clock(): ClockSnapshot
  /** docs/plan/09-renderer-terrain.md, Non-scope ("here the camera is set by `engine/test.
   * setCamera` or a fixed `CameraState`"): a plain mutable object, later milestones add members to
   * the public `Client` shape (this comment's own precedent) as production features need direct
   * access instead of the test-only `clientTestHandle`. Mutate its fields directly, then call
   * `writeCameraAndWake()`; M11 is the real camera integration that will drive this every frame. */
  readonly cameraState: CameraState
  /** The SAB the client worker's `client::Uploader` stages upload-ring records into
   * (`worker/client-upload.ts`); `render/upload.ts`'s own `RingConsumer` drains it every frame
   * under a byte budget (0018 §3). Exposed directly, not gated behind `clientTestHandle`: draining
   * it is a production concern of any renderer built around a `createClient()` result, not a test
   * concern. */
  readonly uploadRing: SharedArrayBuffer
  /** Writes the whole camera block from `cameraState`, bumps `CB_FRAME_REQ` and wakes the client
   * worker (docs/plan/09-renderer-terrain.md Scope: `frame-loop.ts`'s "writeCameraBlock +
   * CB_FRAME_REQ + wake" phase calls this directly). Returns the new `CB_FRAME_REQ` value (`engine/
   * test`'s `stepFrame` uses it to spin on the worker's own ack; production code ignores it). */
  writeCameraAndWake(): number
  /** Sets bits of `mask` in the global `CB_FLAGS` word (`sab/control.ts`) without clearing any
   * other bit already set there. docs/plan/09b-terrain-art-and-lifecycle.md Scope/Seams:
   * `frame-loop.ts`'s `resume()` calls this with `FLAG_REBASE` on a real return-from-background
   * ("on visible ... tell the client worker to re-base interpolation"); M30 is the one that clears
   * and consumes the flag, not this milestone. */
  setFlags(mask: number): void
  /** docs/plan/11-camera-and-input.md Seams (Provides): `client.input.{on, setMode, suspend,
   * resume}` with 0019's signatures, plus `recognize(...)` (Deviations: this range's own addition,
   * the production-wiring seam a later range calls once per rAF -- mirroring `CameraIntegrator.
   * integrate`, from the same externally-owned `pointers`/`keys`/`wheel` bundle -- rather than a
   * pinned Seam name). */
  readonly input: SemanticRecognizer
  /** docs/plan/18-picking-and-overlay.md Seams (Provides): `pick.acquire()` pulls the newest
   * DrawList slot (called once per rAF by `frame-loop.ts`'s new `acquire` phase, or directly by a
   * page not built on `frame-loop.ts`); `pick.at(cssX, cssY)` is `input/pick.ts`'s internal
   * `pickAt`, the same function `input.{on, recognize}` uses to fill every event's own `pickId`.
   * `engine/test.pickAt(client, x, y)` is a thin wrapper over this. */
  readonly pick: {
    acquire(): void
    at(cssX: number, cssY: number): number
  }
  /** docs/plan/18-picking-and-overlay.md Seams (Provides): `overlay.anchor`/`overlay.anchorSlot`
   * (0019 §5's own signatures). `update()` is this cut's own addition (Deviations: not itself a
   * pinned Seam name, mirroring `camera.tick`/`input.recognize`'s own precedent) -- a page's
   * `onOverlay` hook (`frame-loop.ts`) calls it once per rAF. */
  readonly overlay: {
    anchor: Overlay['anchor']
    anchorSlot: Overlay['anchorSlot']
    update(): void
  }
  /** docs/plan/11-camera-and-input.md Seams (Provides): `camera.{setConstraints, moveTo, read,
   * worldToScreen, screenToWorld}` with 0019's signatures, plus `camera.restored: boolean` and,
   * internal (Seams: "Internal"), `setViewClamp`/`setFollow`. `tick(dtMs)` is this range's own
   * addition (Deviations: not itself a pinned Seam name, mirroring `input.recognize`'s own
   * precedent): runs one rAF's worth of `CameraIntegrator.integrate` then `input.recognize`, both
   * over the real pointer/key/wheel listeners this same `createClient` call installed on
   * `options.canvas`/`window` -- a page's own `onCamera` hook (`frame-loop.ts`) calls this once per
   * rAF instead of reaching into a separately-built integrator/bundle. */
  readonly camera: {
    setConstraints(opts: { bounds?: Rect; minTiles?: number; maxTiles?: number }): void
    moveTo(x: number, y: number, opts?: MoveToOptions): void
    read(out: CameraState): void
    worldToScreen(x: number, y: number, out: ScreenPoint): void
    screenToWorld(px: number, py: number, out: ScreenPoint): void
    readonly restored: boolean
    setViewClamp(maxTilesPerAxis: number): void
    setFollow(x: number, y: number, valid: boolean): void
    tick(dtMs: number): void
  }
  destroy(): void
}

export class EngineStartError extends Error {
  readonly code:
    | 'not-isolated'
    | 'worker-blocked'
    | 'compile-failed'
    | 'abi-mismatch'
    | 'arena-config'
    | 'worker-fatal'
    /** docs/plan/23-persistence-opfs-and-lifecycle.md Seams: a second tab (or any other running
     * process) already holds the persisted world's own Web Lock (`world:<worldId>`) -- a start
     * failure, not a trap (`SimLifecycleMessage`'s `start-failed` variant carries it). */
    | 'world-busy'
    /** docs/plan/23-persistence-opfs-and-lifecycle.md step 5 (Deviations: an addition beyond the
     * brief's own pinned Seams, needed for `export_works_after_load_failure`): `Persistence.open`
     * threw a `WorldLoadError` this milestone does not attempt to handle (Non-scope: the upgrade/
     * `SaveIncompatible` path is M24b's) -- the world cannot be played, but its sim worker stays
     * alive (never calls `shell.fatal`) so `client.exportWorld()`/`deleteWorld()` still reach the
     * same, already-open OPFS handles afterward. Distinct from `'world-busy'`, whose worker really
     * does die (another process owns the lock, no handles to offer). */
    | 'load-failed'
    /** docs/plan/24b-upgrade-and-migration.md: carved out of `'load-failed'` -- an identity/schema/
     * tick-rate/worldgen/chunk-size mismatch that ends in `SaveIncompatible` (0005 Upgrades: every
     * stored byte stays untouched). `detail` carries `{ reason, stored, running }`;
     * `exportWorld()`/`deleteWorld()` stay usable, same as `'load-failed'`. */
    | 'save-incompatible'
  /** docs/plan/24b-upgrade-and-migration.md: structured detail for `'save-incompatible'` only --
   * every other code keeps using `.message` (a plain string) as before. */
  readonly detail?: { reason: IncompatReasonName; stored: IdentityJson; running: IdentityJson }
  constructor(
    code: EngineStartError['code'],
    message: string,
    detail?: EngineStartError['detail'],
  ) {
    super(message)
    this.name = 'EngineStartError'
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

// 0015 §5: default per-role arenas.
const MIB = 1024 * 1024
const DEFAULT_ARENA_BYTES = { sim: 96 * MIB, client: 48 * MIB, gen: 4 * MIB }
// 0015 §5: whole-tab target on the baseline phone, minus the fixed SAB and GPU shares (Planning
// decisions "Arena config check on main").
const TAB_TARGET_BYTES = 256 * MIB
const GPU_SHARE_BYTES = 20 * MIB

/** Bytes left for arenas once the fixed SAB and GPU shares are taken out of the whole-tab target
 * (0015 §5; Planning decisions "Arena config check on main"). Exported for `arena.sum_rule`. */
export function arenaBudgetBytes(): number {
  return TAB_TARGET_BYTES - sabBytesTotal() - GPU_SHARE_BYTES
}

/** Total arena bytes the chosen topology reserves: `client` + (`sim`, only when hosting locally)
 * + `gen` * `genWorkers`. Exported for `arena.sum_rule`. */
export function totalArenaBytes(
  arenas: { sim: number; client: number; gen: number },
  hostKind: 'local' | 'remote',
  genWorkers: number,
): number {
  return arenas.client + (hostKind === 'local' ? arenas.sim : 0) + arenas.gen * genWorkers
}

/** Throws `EngineStartError('arena-config', ...)` when the chosen topology's arenas sum past
 * `arenaBudgetBytes()`. Exported for `arena.sum_rule` (docs/plan/06b-workers-and-spawn.md, Tests
 * added): a pure check, callable without a DOM (`Worker`, `fetch`) or cross-origin isolation. */
export function checkArenaBudget(
  arenas: { sim: number; client: number; gen: number },
  hostKind: 'local' | 'remote',
  genWorkers: number,
): void {
  const budget = arenaBudgetBytes()
  const total = totalArenaBytes(arenas, hostKind, genWorkers)
  if (total > budget) {
    throw new EngineStartError(
      'arena-config',
      `arenas sum to ${total} bytes, over the ${budget} byte budget left by the whole-tab ` +
        `target minus SABs and GPU (0015 §5)`,
    )
  }
}

/** docs/plan/23-persistence-opfs-and-lifecycle.md step 5, Seams: `client.exportWorld`/`importWorld`/
 * `deleteWorld`'s own shared rejection for "no sim worker" (`options.host.kind !== 'local'`, or a
 * local host whose sim worker never came up at all). */
export class NotSinglePlayer extends Error {
  constructor(method: string) {
    super(`engine: ${method}: not a single-player world (no sim worker)`)
    this.name = 'NotSinglePlayer'
  }
}

export type WorkerEntry = { kind: WorkerKind; index: number; worker: Worker }

/** `engine/test` only: everything the client test helpers (`parkWorkers`, `stepFrame`, `setCamera`,
 * `asHarness`, ...) need. Not part of the public `Client` shape (its Seams comment: "later
 * milestones add members"); reached only through `clientTestHandle`. */
export interface ClientTestHandle {
  readonly control: ControlBlock
  readonly sabs: SabSet
  readonly cameraState: CameraState
  readonly cameraWriter: CameraBlockView
  readonly clock: Clock
  readonly scheduler: Scheduler
  readonly workers: WorkerEntry[]
  /** docs/plan/11-camera-and-input.md, step 6 (Deviations): the *same* `PointerSlots`/`KeyState`/
   * `WheelState` the client's own real listeners write into and `camera.tick()` reads from --
   * exposed so a test/dev page can pair it with `engine/test.attachCameraInputTestHooks` (the
   * existing, pinned `injectPointer`/`injectWheel`/`injectKey` seam) instead of driving a second,
   * unrelated bundle no real listener or `camera.tick()` call ever reads. */
  readonly cameraBundle: CameraInput
  readonly cameraIntegrator: CameraIntegrator
  /** docs/plan/18-picking-and-overlay.md: the client's own single `DrawListSlot`/`Picker`/`Overlay`
   * -- full test access (`.scanned()`/`.styleWrites()`, `engine/test`'s own counters) beyond the
   * public `Client.pick`/`Client.overlay` surface. */
  readonly drawListSlot: DrawListSlot
  readonly picker: Picker
  readonly overlay: Overlay
  /** docs/plan/16-action-round-trip.md Provides: `engine/test.dispatchRaw`'s own low-level
   * primitive -- writes one pre-encoded `[seq][len][jsonBytes]` record through `dispatch`'s own
   * `RingProducer` (never a second, independent one over the same `actionRing` SAB: an SPSC ring
   * has exactly one producer). Skips the seq-counter/session-state bookkeeping `dispatch` itself
   * does, so the zero-GC window can dispatch without JSON encoding *or* a clock-block read in the
   * measured window (0016 §2). Returns `false` (nothing written) when the record cannot fit the
   * ring right now, the same "full" condition `dispatch` itself throws on. */
  writeActionRecord(seq: number, jsonBytes: Uint8Array): boolean
  /** docs/plan/16-action-round-trip.md, gate-round fix: resolves once every spawned worker has
   * posted its own `{ type: 'ready' }` -- `ready`'s own earlier, `start()`-only phase, well before
   * `ready` itself (which, for a linked topology, also waits for `session_state = 1`). The one
   * thing safe to await before calling anything that blocks the main thread on a worker's own ack
   * (`stepSimTickSync`; see `engine/test.pumpUntilLive`, which awaits this before its first pump
   * attempt): calling such a thing earlier busy-spins the main thread, which starves the very
   * worker setup it is waiting for (measured: an 11.28 s spin ending exactly when every worker's
   * `engine_init ok` finally logged, immediately after the spin gave up and yielded the thread). */
  readonly workersReady: Promise<void>
  /** Coordinator gate, M16b cut 2: `pollActionResults`'s own running totals -- `recordsSeen` is
   * how many kind-1 records this drain has ever popped off `uiRing` (before coalescing), `onUi` is
   * how many times any `onUi` listener has ever fired. Never reset for the life of this `Client`;
   * a test reads it once, after its own measured window, and compares against whatever it read
   * before that window. */
  uiDrainStats(): { recordsSeen: number; onUi: number }
  /** docs/plan/23-persistence-opfs-and-lifecycle.md step 5 (Rules and traps, "serialize them"): one
   * FIFO lock shared by `attachHostLifecycle`'s own hidden/visible park+message calls and
   * `exportWorld`/`importWorld`/`deleteWorld`'s -- whichever acquires it first fully completes
   * (including whatever park/unpark it does around the host worker) before the other runs, so the
   * two families are never interleaved on the same worker. */
  hostWorkerLock<T>(fn: () => Promise<T>): Promise<T>
}

const handles = new WeakMap<Client, ClientTestHandle>()

export function clientTestHandle(client: Client): ClientTestHandle {
  const h = handles.get(client)
  if (!h) throw new Error('clientTestHandle: not a createClient() result')
  return h
}

/**
 * docs/plan/23-persistence-opfs-and-lifecycle.md steps 3-4, Scope: "Browser clean boundaries:
 * `visibilitychange -> hidden` and `pagehide` -> `SimHost.pause()`; `visible -> resume()`" -- a
 * page-invoked wiring function, `frame-loop.ts`'s own `attachVisibilityHandling`/`input/focus.ts`'s
 * `installBlurAndVisibilityReset` precedent (an injectable `doc`, default the real `document`):
 * headless Chromium's own `document.hidden` cannot be forced from outside the page, so a test page
 * builds its own `{ hidden, addEventListener, removeEventListener }` object and drives it directly
 * (`hidden-tab-upload.ts`'s `FakeDoc`) instead of the real one a manual device-check page uses
 * unmodified. A no-op for any topology with no `sim`-kind host worker (`remote`, `gen`-only), and
 * for one whose host worker never received `message.world` (`worker/sim.ts`'s `simControl` is then
 * `undefined`, so `sim-pause`/`sim-resume` are silently ignored by `worker.ts`'s own dispatch) --
 * calling this on a client with `host.persist` unset costs a spurious park/resume round trip per
 * visibility change and nothing else.
 *
 * `SimHost` lives inside the sim worker, so main reaches it through the parked-only
 * `sim-pause`/`sim-resume` protocol (`SimControlMessage`): park the host worker (`W_YIELD` + wake,
 * polling `W_PARKED` -- the same low-level mechanism `engine/test`'s `parkWorkers` uses,
 * reimplemented here since production code cannot import `src/test/**`), then post `sim-pause`; its
 * own completion ack is the next `storage` message the sim worker posts back (Planning decision 5).
 * `sim-resume` needs no separate park step (the worker is already parked from `sim-pause`).
 *
 * A small state machine (Rules and traps: "make sure a quick hidden -> visible -> hidden sequence
 * can't interleave two pauses or resume before a pause settles"): `desiredHidden` is the latest
 * state any caller (`visibilitychange`, `pagehide`) asked for; `pump` drains it one async step at a
 * time, re-checking `desiredHidden` after every `await` so a state that changed mid-pause is only
 * ever acted on once the in-flight pause has actually settled, never interleaved with it. Returns a
 * disposer.
 */
export function attachHostLifecycle(
  client: Client,
  doc: {
    hidden: boolean
    addEventListener(type: 'visibilitychange', cb: () => void): void
    removeEventListener(type: 'visibilitychange', cb: () => void): void
  } = document,
  win: { addEventListener(type: 'pagehide', cb: () => void): void } = window,
): () => void {
  const h = clientTestHandle(client)

  function hostWorkerEntry(): WorkerEntry | undefined {
    return h.workers.find((w) => w.index === WORKER_HOST)
  }

  /** Gate fix (docs/plan/23-persistence-opfs-and-lifecycle.md, "Open gate failures" 1): `W_PARKED`
   * reads `1` for two different reasons -- a worker that yielded from `W_YIELD` (a real park), *or*
   * one that is mid-`shell.runAsync` (an OPFS rename still queued from `worker/sim.ts`'s own
   * `pendingAsync()` poll, unrelated to this call). This poll cannot tell them apart, and does not
   * need to: it can resolve the instant it sees `1`, even when that `1` predates the `W_YIELD` store
   * `pauseHostWorker` just made (the worker is provably not blocked in `Atomics.wait` either way, so
   * the `sim-pause` message below is always deliverable). What actually gates `pauseHostWorker()`'s
   * own returned promise is *not* this poll -- it is the `storage` message the worker posts back once
   * `SimHost.pause()` resolves, which does not happen until `Persistence.flush()` (`storage.flush()`)
   * resolves, which now (gate fix 1, `storage/opfs.ts`'s `#renameInFlight`) itself waits out any rename
   * `pendingAsync()` already handed to `shell.runAsync` before this call ever ran. So a pause that
   * lands mid-rename is still correct end to end even though this poll alone cannot see the
   * difference. */
  function pollHostParked(): Promise<void> {
    return new Promise((resolve) => {
      function poll(): void {
        if (Atomics.load(h.control.words, workerWord(WORKER_HOST, W_PARKED)) === 1) {
          resolve()
          return
        }
        h.scheduler.setTimer(poll, 0)
      }
      poll()
    })
  }

  function pauseHostWorker(): Promise<void> {
    const w = hostWorkerEntry()
    if (!w) return Promise.resolve()
    Atomics.store(h.control.words, workerWord(WORKER_HOST, W_YIELD), 1)
    h.control.wake(WORKER_HOST)
    return pollHostParked().then(
      () =>
        new Promise<void>((resolve) => {
          const unsubscribe = client.onStorage(() => {
            unsubscribe()
            resolve()
          })
          w.worker.postMessage({ type: 'sim-pause' } satisfies ToWorker)
        }),
    )
  }

  function resumeHostWorker(): void {
    const w = hostWorkerEntry()
    if (!w) return
    w.worker.postMessage({ type: 'sim-resume' } satisfies ToWorker)
  }

  let desiredHidden = false
  let state: 'running' | 'pausing' | 'paused' = 'running'
  let pumping = false
  function pump(): void {
    if (pumping) return
    pumping = true
    void (async () => {
      try {
        for (;;) {
          if (desiredHidden && state === 'running') {
            state = 'pausing'
            // docs/plan/23-persistence-opfs-and-lifecycle.md step 5 (Rules and traps, "serialize
            // them"): the same lock `exportWorld`/`importWorld`/`deleteWorld` use, so a request
            // racing this pause is always well-defined -- whichever gets here first (this pause, or
            // a world-op already queued ahead of it) finishes before the other starts.
            await h.hostWorkerLock(() => pauseHostWorker())
            state = 'paused'
          } else if (!desiredHidden && state === 'paused') {
            await h.hostWorkerLock(async () => resumeHostWorker())
            state = 'running'
          } else {
            break
          }
        }
      } finally {
        pumping = false
      }
    })()
  }

  const onVisibilityChange = (): void => {
    desiredHidden = doc.hidden
    pump()
  }
  const onPageHide = (): void => {
    desiredHidden = true
    pump()
  }
  doc.addEventListener('visibilitychange', onVisibilityChange)
  win.addEventListener('pagehide', onPageHide)
  return () => {
    doc.removeEventListener('visibilitychange', onVisibilityChange)
    // `pagehide` has no matching `removeEventListener` requirement here (Seams: the type only
    // names `addEventListener`) -- a real page tearing down over `pagehide` never calls its own
    // disposer afterward anyway.
  }
}

/** 0008 §2: 1 worker by default, 2 when `hardwareConcurrency >= 8`. `requested` (`ClientOptions.
 * genWorkers`) overrides the default when given, clamped to `[1, MAX_GEN_WORKERS]` --
 * `createSabSet`'s own worst-case sizing (`sab/layout.ts`), which the whole-tab arena and SAB
 * budgets (0015 §5) already assume. A pure function (docs/plan/08b-gen-workers-and-queue.md,
 * Seams) so `genWorkerCount rule` can drive it without `navigator`. */
export function genWorkerCount(hardwareConcurrency: number, requested?: number): number {
  if (requested !== undefined) return Math.min(Math.max(requested, 1), MAX_GEN_WORKERS)
  return hardwareConcurrency >= 8 ? 2 : 1
}

function spawnWorker(options: ClientOptions): Worker {
  return options.createWorker
    ? options.createWorker()
    : new Worker(new URL('./worker-auto.js', import.meta.url), { type: 'module' })
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Sends the setup message to `worker` and resolves once it replies `ready`, or rejects with an
 * `EngineStartError`: `worker-blocked` for a script the browser refused to even run (0015 §3,
 * "turn a pre-ready worker `error` into..."), `worker-fatal` for a trap or setup failure it
 * reported through the fixed protocol, unless the message names an ABI mismatch (`abi-mismatch`).
 */
function setupWorker(
  worker: Worker,
  kind: WorkerKind,
  index: number,
  sabs: SabSet,
  config: InstanceConfig,
  wasm: { module?: WebAssembly.Module; url?: string },
  test: TestFlags | undefined,
  link: boolean,
  world: { worldId: string; buildHash: string; params: ServerWorldConfig['params'] } | undefined,
  /** docs/plan/29-net-worker-and-reference-server.md steps 1-2: the `net`-kind spawn's own real
   * `wsConnection` dial target, present only for a `{ kind: 'remote' }` host. */
  net: { url: string; joinKey?: string } | undefined,
  /** docs/plan/29-net-worker-and-reference-server.md steps 1-2: `true` only for the `client`-kind
   * spawn of a `{ kind: 'remote' }` host (`SetupMessage.remoteLinked`'s own doc comment). */
  remoteLinked: true | undefined,
  /** docs/plan/23-persistence-opfs-and-lifecycle.md steps 3-4: forwards every `SimLifecycleMessage`
   * this worker ever posts, for the life of the worker -- not only during this handshake window
   * (`storage` fires again after the `persist()` answer and after every hidden-boundary snapshot,
   * long after `ready`/`reject` have already settled this function's own promise). Only the `sim`
   * worker ever posts one; harmless to wire for every kind. */
  onLifecycle: (m: SimLifecycleMessage) => void,
  /** docs/plan/23-persistence-opfs-and-lifecycle.md step 5: forwards every `SimWorldOpResult` this
   * worker ever posts, the same "not only during this handshake window" convention `onLifecycle`
   * already uses -- an export/import/delete request can arrive long after `ready`/`reject` settled
   * this function's own promise. Only the `sim` worker ever posts one. */
  onWorldOp: (m: SimWorldOpResult) => void,
  /** docs/plan/28-sessions-and-reconnect.md step 5: forwards the one `client-welcome` message a
   * linked `client`-kind worker ever posts (`ClientLifecycleMessage`), same "not only during this
   * handshake window" convention as `onLifecycle`/`onWorldOp` -- `Welcome` can apply well after
   * `ready` settled (`ready` itself waits for it, for a linked topology, but this callback exists
   * so a redundant `if (settled) return` isn't needed here either). Only the `client` worker ever
   * posts one. */
  onWelcome: (m: ClientLifecycleMessage) => void,
  /** docs/plan/29-net-worker-and-reference-server.md steps 1-2: forwards every `{ type: 'link',
   * ... }` message a `net`-kind worker ever posts (`NetLinkMessage`, `worker/net.ts`'s own
   * `createLink` transitions), same "not only during this handshake window" convention as
   * `onLifecycle`/`onWorldOp`/`onWelcome` -- a real reconnect can happen years into a session, long
   * after `ready` settled. Only the `net` worker ever posts one. */
  onLink: (m: NetLinkMessage) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    worker.onerror = (e) => {
      if (settled) return
      settled = true
      reject(
        new EngineStartError(
          'worker-blocked',
          `worker script blocked: is COEP set on every path? (${e.message})`,
        ),
      )
    }
    worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data
      if (m.type === 'ready') {
        if (settled) return
        settled = true
        resolve()
      } else if (m.type === 'fatal') {
        if (settled) return
        settled = true
        const code = m.message.includes('ABI mismatch') ? 'abi-mismatch' : 'worker-fatal'
        reject(new EngineStartError(code, m.message))
      } else if (m.type === 'start-failed') {
        // Posted once, before the worker also calls `shell.fatal` and dies (Seams): settle here so
        // `client.ready` rejects with the real code/detail, and ignore the `fatal` that follows.
        if (settled) return
        settled = true
        if (m.code === 'save-incompatible') {
          reject(
            new EngineStartError(m.code, m.detail, {
              reason: m.reason,
              stored: m.stored,
              running: m.running,
            }),
          )
        } else {
          reject(new EngineStartError(m.code, m.detail))
        }
      } else if (m.type === 'storage') {
        onLifecycle(m)
      } else if (
        m.type === 'export-world-result' ||
        m.type === 'import-world-result' ||
        m.type === 'delete-world-result' ||
        m.type === 'world-op-error'
      ) {
        onWorldOp(m)
      } else if (m.type === 'client-welcome' || m.type === 'client-resyncing') {
        // Real bug found (Deviations): this used to check only `'client-welcome'`, so a linked
        // client worker's own `client-resyncing` message (M28b, `worker/client-net.ts`'s
        // `onResyncing` callback) was posted but never dispatched anywhere -- `client.onResyncing`
        // listeners could never actually fire in production (only netcode-level coverage ever
        // exercised the resync path directly, not through a real `createClient()` worker
        // topology). `onWelcome`'s own implementation already switches on `m.type` internally
        // (`onWelcome`'s doc comment: "`client-resyncing` ... fans out to `onResyncing`'s own
        // listener list instead of forwarding view clamps") -- it was simply never reached.
        onWelcome(m)
      } else if (m.type === 'link') {
        onLink(m)
      }
    }
    const setup: ToWorker = {
      type: 'setup',
      kind,
      index,
      sabs,
      config,
      ...(wasm.module ? { module: wasm.module } : {}),
      ...(wasm.url ? { wasmUrl: wasm.url } : {}),
      ...(test ? { test } : {}),
      ...(link ? { link } : {}),
      ...(world ? { world } : {}),
      ...(net ? { net } : {}),
      ...(remoteLinked ? { remoteLinked } : {}),
    }
    worker.postMessage(setup)
  })
}

/**
 * `readInvite(location)` (docs/plan/29-net-worker-and-reference-server.md Scope; M28's own Planning
 * decisions "the invite fragment is parsed as `#k=<joinKey>` with unknown parameters ignored, so
 * `&p=<secret>` can be added without breaking old links"): the URL fragment's own `k` parameter as
 * `ClientOptions.host.joinKey` (`{ kind: 'remote', joinKey? }`), or `{}` when the fragment carries
 * none -- `URLSearchParams` already ignores any parameter this function does not read by name, so
 * "unknown parameters ignored" costs nothing extra here. Takes `{ hash }`, not the full `Location`
 * (Deviations: a test can hand this a plain object with no `window`), matching `location.hash`'s
 * own leading-`#` convention (present or absent, both accepted).
 */
export function readInvite(location: { hash: string }): { joinKey?: string } {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash
  const joinKey = new URLSearchParams(hash).get('k')
  return joinKey !== null ? { joinKey } : {}
}

/** `createClient` is synchronous (PRE-PLAN §4); spawn itself is asynchronous, tracked by
 * `client.ready`. */
export function createClient(options: ClientOptions): Client {
  // Checked first, synchronously, before anything below touches `SharedArrayBuffer`
  // (`createSabSet`): on a page the browser never made cross-origin isolated, the global does not
  // exist at all, so `new SharedArrayBuffer(...)` throws a bare `ReferenceError` synchronously out
  // of `createClient` itself instead of the readable, awaitable `EngineStartError` `client.ready` is
  // meant to reject with (0015 §3; docs/plan/06b-workers-and-spawn.md, Tests added
  // `start.not_isolated_error`, Deviations).
  if (!globalThis.crossOriginIsolated) {
    const err = new EngineStartError(
      'not-isolated',
      'crossOriginIsolated is false: see checkSupport() for what to fix',
    )
    const ready = Promise.reject(err)
    ready.catch(() => {}) // see `start()`'s own `.ready.catch()` comment below
    // No `SharedArrayBuffer` exists on this path (that global is exactly what being isolated
    // provides), so `uploadRing`/`writeCameraAndWake` cannot be real: any caller reaching them
    // without first awaiting the already-rejected `ready` gets the same error repeated.
    return {
      ready,
      cameraState: new CameraState(),
      get uploadRing(): SharedArrayBuffer {
        throw err
      },
      dispatch(): number {
        throw err
      },
      onActionResult(): () => void {
        throw err
      },
      onUi(): () => void {
        throw err
      },
      onStorage(): () => void {
        throw err
      },
      onResyncing(): () => void {
        throw err
      },
      onLink(): () => void {
        throw err
      },
      onVersionMismatch(): () => void {
        throw err
      },
      exportWorld(): Promise<Blob> {
        throw err
      },
      importWorld(): Promise<{ worldId: string }> {
        throw err
      },
      deleteWorld(): Promise<void> {
        throw err
      },
      clock(): ClockSnapshot {
        throw err
      },
      writeCameraAndWake(): number {
        throw err
      },
      setFlags(): void {
        throw err
      },
      input: {
        on(): () => void {
          throw err
        },
        setMode(): void {
          throw err
        },
        suspend(): void {
          throw err
        },
        resume(): void {
          throw err
        },
        recognize(): void {
          throw err
        },
        emit(): boolean {
          throw err
        },
      },
      pick: {
        acquire(): void {
          throw err
        },
        at(): number {
          throw err
        },
      },
      overlay: {
        anchor(): never {
          throw err
        },
        anchorSlot(): never {
          throw err
        },
        update(): void {
          throw err
        },
      },
      camera: {
        setConstraints(): void {
          throw err
        },
        moveTo(): void {
          throw err
        },
        read(): void {
          throw err
        },
        worldToScreen(): void {
          throw err
        },
        screenToWorld(): void {
          throw err
        },
        restored: false,
        setViewClamp(): void {
          throw err
        },
        setFollow(): void {
          throw err
        },
        tick(): void {
          throw err
        },
      },
      destroy() {},
    }
  }

  const genWorkers = genWorkerCount(
    typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 1,
    options.genWorkers,
  )
  const arenas = {
    sim: options.arenas?.sim ?? DEFAULT_ARENA_BYTES.sim,
    client: options.arenas?.client ?? DEFAULT_ARENA_BYTES.client,
    gen: options.arenas?.gen ?? DEFAULT_ARENA_BYTES.gen,
  }
  const clock = options.test?.clock ?? systemClock
  const scheduler = options.test?.scheduler ?? systemScheduler

  const sabs = createSabSet(options.host.kind === 'local' ? 'sim' : 'net', genWorkers)
  const control = new ControlBlock(sabs.control)
  const cameraState = new CameraState()
  const cameraWriter = new CameraBlockView(sabs.cameraBlock)
  const workers: WorkerEntry[] = []

  // CSS-pixel viewport (`camera/transform.ts`'s own space, distinct from `render/viewport.ts`'s
  // device-pixel one): read once at init and refreshed only on an actual resize
  // (`ResizeObserver`), never per frame -- `getBoundingClientRect()` allocates a `DOMRect`, and
  // `camera.tick()` runs on the strict per-rAF path this milestone's own zero-GC page proves
  // (`.claude/rules/hot-paths.md`; 0016 §2 exempts a real resize as a rare discontinuity). Moved
  // above `input`/`picker` (docs/plan/18-picking-and-overlay.md): both need it too, and `input`'s
  // own `pick` argument needs a real `picker` in hand before it is constructed.
  const cameraViewport: CameraViewport = { widthPx: 1, heightPx: 1 }
  function refreshCameraViewport(): void {
    const rect = options.canvas.getBoundingClientRect()
    if (rect.width > 0) cameraViewport.widthPx = rect.width
    if (rect.height > 0) cameraViewport.heightPx = rect.height
  }
  refreshCameraViewport()
  let cameraResizeObserver: ResizeObserver | undefined
  if (typeof ResizeObserver !== 'undefined') {
    cameraResizeObserver = new ResizeObserver(refreshCameraViewport)
    cameraResizeObserver.observe(options.canvas)
  }

  // docs/plan/18-picking-and-overlay.md, Order of work step 1: the client's own single
  // `DrawListSlot` (the only `TripleReader` over `sabs.drawList` for this client's whole life,
  // `render/drawlist-slot.ts`'s own doc comment) and the `Picker` built over it -- `input`'s own
  // `pick` argument below is this same instance, so `client.input.on('tap', ...)`'s own `pickId`
  // and `client.pick.at` always agree (the same cache, the same acquired slot).
  const drawListSlot: DrawListSlot = createDrawListSlot(sabs.drawList)
  const picker: Picker = createPicker({ drawListSlot, cameraState, viewport: cameraViewport })

  const input = createSemanticRecognizer(sabs.inputRing, picker)

  const overlayDeps: Parameters<typeof createOverlay>[0] = {
    cameraState,
    viewport: cameraViewport,
    canvas: options.canvas,
    drawListSlot,
  }
  if (options.overlay !== undefined) overlayDeps.options = options.overlay
  const overlay: Overlay = createOverlay(overlayDeps)

  // docs/plan/11-camera-and-input.md, step 6 (Deviations: "engine-owned camera", 0019 §1): the one
  // real `PointerSlots`/`KeyState`/`WheelState` bundle this client's own real DOM listeners write
  // into and `camera.tick()`/`input.recognize` both read from every rAF. Built here (not per-page)
  // so `client.camera.{setConstraints, moveTo}` always affects the one camera actually driven by
  // real gestures, whether or not a page ever calls `camera.tick()` at all (a headless spectator
  // client still gets a working `moveTo`/`read`).
  const cameraBundle: CameraInput = {
    pointers: new PointerSlots(),
    keys: new KeyState(),
    wheel: new WheelState(),
  }
  const cameraStorageKeyValue = cameraStorageKey(options.cameraKey)
  const cameraRestored = restoreCameraState(cameraStorageKeyValue, cameraState)
  const cameraIntegrator = createCameraIntegrator(cameraBundle, {
    onMotionEnd: (s) => saveCameraState(cameraStorageKeyValue, s),
  })

  // Real DOM wiring (0019 §3-§4): pointer capture + gestures and wheel on the canvas, keys (with
  // focus rules) and the blur/visibilitychange full-state reset on `window`/`document` -- the exact
  // listener set the exit criterion's own source scan expects, and nowhere else. `typeof window`
  // guards a non-browser embedding (none exists today; `createClient` is main-thread-only, Files
  // touched) rather than assuming one.
  const cameraInputDisposers: Array<() => void> = []
  if (typeof window !== 'undefined') {
    cameraInputDisposers.push(installPointerListeners(cameraBundle.pointers, options.canvas))
    cameraInputDisposers.push(installWheelListeners(cameraBundle.wheel, options.canvas))
    cameraInputDisposers.push(installKeyListeners(cameraBundle.keys, window))
    cameraInputDisposers.push(installBlurAndVisibilityReset(cameraBundle, window, document))
  }

  const camera: Client['camera'] = {
    setConstraints(opts) {
      cameraIntegrator.setConstraints(opts)
    },
    moveTo(x, y, opts) {
      cameraIntegrator.moveTo(cameraState, x, y, opts)
    },
    read(out) {
      copyCameraState(cameraState, out)
    },
    worldToScreen(x, y, out) {
      worldToScreen(cameraState, cameraViewport, x, y, out)
    },
    screenToWorld(px, py, out) {
      screenToWorld(cameraState, cameraViewport, px, py, out)
    },
    restored: cameraRestored,
    setViewClamp(maxTilesPerAxis) {
      cameraIntegrator.setViewClamp(maxTilesPerAxis)
    },
    setFollow(x, y, valid) {
      cameraIntegrator.setFollow(x, y, valid)
    },
    tick(dtMs) {
      // docs/plan/18-picking-and-overlay.md steps 4-6 (0019 §1): "the main thread centres on it in
      // the frame that draws that DrawList" -- reads the *acquired* slot's own header (the `acquire`
      // phase already ran this rAF, `frame-loop.ts`'s `FRAME_PHASES`), so a target the Rust side set
      // this frame takes effect in this same `integrate()` call, not one rAF later.
      cameraIntegrator.setFollow(
        drawListSlot.followX,
        drawListSlot.followY,
        drawListSlot.followValid,
      )
      cameraIntegrator.integrate(cameraState, cameraViewport, dtMs)
      input.recognize(cameraBundle, cameraState, cameraViewport, dtMs)
    },
  }

  // docs/plan/16-action-round-trip.md, step 3: `dispatch`/`onActionResult`/the extended `ready`.
  // `linked` decides whether the client worker sets up its net pump at all (`start()` below's own
  // `link` field, computed once here so the two cannot drift) -- true for `local` only when
  // `connect: true`, and always true for `remote` (docs/plan/29-net-worker-and-reference-server.md
  // steps 1-2, Scope: "the remote host option ... becomes real: multiplayer topology of 0015 §1, no
  // sim worker" -- there is no `connect` flag to opt out of for that `kind`).
  const linked =
    (options.host.kind === 'local' && options.host.connect === true) ||
    options.host.kind === 'remote'
  // `awaitLive` is a *separate* predicate from `linked` (Deviations, real bug found and fixed): only
  // `local` waits for `session_state = 1` inside `ready` itself. A `local` host's own "server" is
  // the sim worker in the same tab over a `RingConnection` -- effectively instantaneous, and M16's
  // own established behaviour ("`Client.ready` now also waits for `session_state = 1`"), unchanged
  // here. A real network has no such guarantee (0013 Client policy: "the game stays interactive on
  // last known state ... no modal and no error for outages under ~10 s") -- blocking `ready` itself
  // on a `Welcome` that may never arrive (a bad join key, no server listening yet, a real outage)
  // contradicts that policy, and broke it concretely: every pre-existing browser test/device page
  // built on a `{ kind: 'remote', url: 'ws://unused.invalid' }` placeholder host (M06b's own
  // reserved-but-inert shape, used by more than ten pages under `tests/browser/pages/src/` purely
  // to get a "client + gen, no sim worker" topology with no real networking) hung forever the
  // instant this milestone made `remote` dial for real. `ready` for a remote host therefore means
  // what it always meant pre-M29 ("the worker set is up"); a caller that wants to know when a
  // multiplayer session is actually live uses `client.onLink`'s own `'online'` event instead (this
  // milestone's own new seam, built for exactly this).
  const awaitLive = options.host.kind === 'local' && options.host.connect === true

  const clockView = new ClockBlockView(sabs.clockBlock)
  // Built once (`.claude/rules/hot-paths.md`): every clock-block read copies into this same
  // seven-slot scratch array, the first six in `CLOCK_FIELD`'s own order (a torn read -- every
  // retry raced the writer -- leaves it holding whatever the previous successful read saw: stale,
  // never garbage, always a real snapshot the writer actually published at some point). The
  // seventh (docs/plan/26-prediction-rendering-and-clocks.md steps 4-6) is `tickFraction`'s own
  // raw bits, sized only so `readClockBlockInto`'s own `.set()` has room -- `CLOCK_FIELD` has no
  // entry for it on purpose (`clock-block.ts`'s own doc comment): read it back through
  // `clockView.scratchFieldsFloatView()` after the same call, never through `clockScratch` itself.
  const clockScratch = new Uint32Array(8)

  // `dispatch`'s own producer, wake target `WORKER_CLIENT` (Scope: "then Atomics.notify of the
  // client worker" -- `RingProducer`'s own `wake` option does this on every successful push, the
  // same pattern `client-net.ts`'s uplink producer already uses toward `WORKER_HOST`). Exactly one
  // producer for `actionRing` ever exists (an SPSC ring): `engine/test.dispatchRaw` reaches this
  // same instance through `writeActionRecord` below, never a second one of its own.
  const actionRingProducer = new RingProducer(sabs.actionRing, { control, index: WORKER_CLIENT })
  const actionScratch = new Uint8Array(ACTION_RECORD_BYTES)
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  /** The shared low-level primitive behind `dispatch` and `engine/test.dispatchRaw`
   * (`writeActionRecord`, exposed on `ClientTestHandle`): `[seq u32 LE][len u32 LE][UTF-8 JSON]`
   * (Scope), one whole record through `actionRingProducer.tryPush`. */
  function writeActionRecord(seq: number, jsonBytes: Uint8Array): boolean {
    const total = 8 + jsonBytes.length
    if (total > actionScratch.length) {
      throw new Error(`engine: action payload too large (${jsonBytes.length} bytes)`)
    }
    actionScratch[0] = seq & 0xff
    actionScratch[1] = (seq >>> 8) & 0xff
    actionScratch[2] = (seq >>> 16) & 0xff
    actionScratch[3] = (seq >>> 24) & 0xff
    const len = jsonBytes.length
    actionScratch[4] = len & 0xff
    actionScratch[5] = (len >>> 8) & 0xff
    actionScratch[6] = (len >>> 16) & 0xff
    actionScratch[7] = (len >>> 24) & 0xff
    actionScratch.set(jsonBytes, 8)
    return actionRingProducer.tryPush(actionScratch, total)
  }

  /** `seed + 1` (Scope), read exactly once, the moment `session_state` first becomes `Live`
   * (Planning decisions "How main learns the `seq` seed"); `-1` means "not seeded yet", which
   * `dispatch`'s own `session_state` check always rejects before this value could matter. Never
   * reset for the life of this `Client` (Scope: "the counter is never reset"). */
  let nextSeq = -1

  function dispatch(action: unknown): number {
    // docs/plan/23-persistence-opfs-and-lifecycle.md Planning decision 5: "or the first
    // `client.dispatch`, whichever comes first" -- `tryPersist` itself no-ops outside a `persist:
    // true` local host (`persistWorldCreated` never becomes `true` there).
    persistGestureSeen = true
    tryPersist()
    readClockBlockInto(clockView, clockScratch)
    if (at(clockScratch, CLOCK_FIELD.SessionState) !== SessionState.Online) {
      throw new Error('engine: dispatch before ready')
    }
    const candidateSeq = nextSeq
    const ackSeq = at(clockScratch, CLOCK_FIELD.AckSeq)
    if (candidateSeq - ackSeq > OUTBOX_CAPACITY) {
      throw new Error('engine: action queue full')
    }
    const jsonBytes = encoder.encode(JSON.stringify(action))
    if (!writeActionRecord(candidateSeq, jsonBytes)) {
      throw new Error('engine: action queue full')
    }
    nextSeq = candidateSeq + 1
    return candidateSeq
  }

  /** Resolves once `session_state` first reads `Live`, seeding `nextSeq` from that same read
   * (Planning decisions: main reads the seed "exactly once"). Polls via the injected `Scheduler`
   * (never a bare `setTimeout`: `.claude/rules/hot-paths.md`'s sibling rule in `src/CLAUDE.md`,
   * "no ambient time outside `clock.ts`") -- main never blocks (0015 §2), so this is a macrotask
   * poll, not `Atomics.wait`. */
  function waitForLive(): Promise<void> {
    return new Promise((resolve) => {
      function poll(): void {
        readClockBlockInto(clockView, clockScratch)
        if (at(clockScratch, CLOCK_FIELD.SessionState) === SessionState.Online) {
          nextSeq = at(clockScratch, CLOCK_FIELD.SeqSeed) + 1
          resolve()
          return
        }
        scheduler.setTimer(poll, 0)
      }
      poll()
    })
  }

  // One listener array backs every `Reject` type `onActionResult<Reject>` is called with: each
  // call site's own generic is erased to `unknown` here and recovered by the caller's own cast
  // (the parsed JSON was never actually typed as `Reject` in the first place -- that typing is a
  // compile-time convenience over data this module never validates against it).
  type Listener = (seq: number, result: ActionOutcome<unknown>) => void
  const actionResultListeners: Listener[] = []

  function onActionResult<Reject = unknown>(
    cb: (seq: number, result: ActionOutcome<Reject>) => void,
  ): () => void {
    const listener = cb as Listener
    actionResultListeners.push(listener)
    return () => {
      const i = actionResultListeners.indexOf(listener)
      if (i >= 0) actionResultListeners.splice(i, 1)
    }
  }

  const uiRingConsumer = new RingConsumer(sabs.uiRing)
  const uiScratch = new Uint8Array(UI_POLL_BYTES)
  // Coordinator gate (zero_gc_action attribution): holds the *bytes* of the latest kind-1 record
  // seen so far in the current drain, copied with `copyBytes` (a plain loop, no allocation) rather
  // than decoded immediately -- a coalesced-away kind-1 record (one a *later* record in the same
  // drain overwrites) would otherwise still have paid a `TextDecoder.decode()` allocation for a
  // string this same call throws away. Reused every drain; sized to the largest single record
  // `client_poll_ui` can ever produce, the same bound `uiScratch` itself already uses.
  const lastUiScratch = new Uint8Array(UI_POLL_BYTES)

  // docs/plan/16b-ui-observation-and-clock.md Scope: "keep only the last kind-1 record ... call
  // onUi(ui) before any onActionResult of the same drain". A kind-1 record can land anywhere in
  // the byte stream relative to a kind-2 one (more than one `on_frame` call can land between two
  // drains), so every kind-2 record's own `{seq, result}` must be held until the whole drain has
  // been walked and it is known whether a `Ui` record showed up at all -- these two reused,
  // parallel arrays (index by `pendingCount`, never `.push`ed/`.length`-reset) are that holding
  // pen, cleared only by overwrite on the next drain that actually uses them.
  const pendingSeqs: number[] = []
  const pendingOutcomes: ActionOutcome<unknown>[] = []

  type UiListener = (ui: unknown) => void
  const uiListeners: UiListener[] = []

  // Coordinator gate, M16b cut 2: plain counters (never reset), read only through
  // `ClientTestHandle.uiDrainStats()` -- a test-only accessor, never part of the per-frame path
  // itself (incrementing an outer-scope `number` costs nothing the frame loop doesn't already pay,
  // no allocation either way).
  let uiRecordsSeenTotal = 0
  let onUiFiredTotal = 0

  function onUi<Ui = unknown>(cb: (ui: Ui) => void): () => void {
    const listener = cb as UiListener
    uiListeners.push(listener)
    return () => {
      const i = uiListeners.indexOf(listener)
      if (i >= 0) uiListeners.splice(i, 1)
    }
  }

  // docs/plan/23-persistence-opfs-and-lifecycle.md steps 3-4: `client.onStorage` (Seams), fired by
  // `setupWorker`'s own `onLifecycle` callback below whenever the sim worker posts a `storage`
  // `SimLifecycleMessage` -- at load, after the `persist()` answer, and after each hidden-boundary
  // snapshot (Planning decision 5). Never fires for a topology with no persisted sim worker.
  type StorageListener = (status: StorageStatus) => void
  const storageListeners: StorageListener[] = []

  function onStorage(cb: (status: StorageStatus) => void): () => void {
    const listener = cb as StorageListener
    storageListeners.push(listener)
    return () => {
      const i = storageListeners.indexOf(listener)
      if (i >= 0) storageListeners.splice(i, 1)
    }
  }

  // docs/plan/28b-reconnect-and-lifecycle.md step 2: `client.onResyncing` (Seams: "a per-event
  // subscription in the style of `client.onUi`") -- fired by `onWelcome` below whenever the linked
  // client worker posts `client-resyncing` (a second `Welcome` on an already-`Online` connection).
  // There is no `EngineEvent` union (Scope): this is its own dedicated subscription, the same
  // shape `onStorage`/`onUi` already are.
  type ResyncingListener = () => void
  const resyncingListeners: ResyncingListener[] = []

  function onResyncing(cb: () => void): () => void {
    const listener = cb as ResyncingListener
    resyncingListeners.push(listener)
    return () => {
      const i = resyncingListeners.indexOf(listener)
      if (i >= 0) resyncingListeners.splice(i, 1)
    }
  }

  // docs/plan/29-net-worker-and-reference-server.md steps 1-2 (Scope: "Link events"): `client.
  // onLink` -- a per-event subscription in the style of `onUi`/`onResyncing`, the public six-value
  // state this milestone's own net worker traffic (`NetLinkMessage`, `net/link.ts`'s own
  // `DownReason`) is translated into here on main, since only main knows the two things the net
  // worker itself cannot (`Deviations`, `NetLinkMessage`'s own doc comment in `worker/protocol.ts`):
  // whether a session is actually live (`session_state`, polled off the clock block the same way
  // `waitForLive` already does) and how long a `down` has lasted before it is worth an indicator
  // (0013 Client policy: "an indicator appears after 1 s").
  type LinkEvent = { state: LinkState; reason?: LinkReason }
  type LinkListener = (e: LinkEvent) => void
  const linkListeners: LinkListener[] = []
  function onLink(cb: (e: LinkEvent) => void): () => void {
    const listener = cb as LinkListener
    linkListeners.push(listener)
    return () => {
      const i = linkListeners.indexOf(listener)
      if (i >= 0) linkListeners.splice(i, 1)
    }
  }
  function emitLink(e: LinkEvent): void {
    for (const l of linkListeners) l(e)
  }

  // docs/plan/29-net-worker-and-reference-server.md steps 1-2 (Scope: "the default handler reloads
  // once, guarded by `sessionStorage['engine.reloadedFrom'] = <own build hash>`; if the reloaded
  // bundle has the same hash, state `updating` and `link.retry()` on the backoff schedule").
  // `client.onVersionMismatch(cb)` replaces this default outright (Scope), the same "one override,
  // not a listener list" shape 0013's own "the engine raises an event whose default handler..."
  // implies -- there is exactly one reaction to a mismatch, never several independent ones.
  let versionMismatchHandler: (() => void) | null = null
  function onVersionMismatch(cb: () => void): () => void {
    versionMismatchHandler = cb
    return () => {
      if (versionMismatchHandler === cb) versionMismatchHandler = null
    }
  }
  const RELOADED_FROM_KEY = 'engine.reloadedFrom'
  function defaultVersionMismatchHandler(): void {
    if (typeof window === 'undefined' || typeof sessionStorage === 'undefined') return
    let already: string | null = null
    try {
      already = sessionStorage.getItem(RELOADED_FROM_KEY)
    } catch {
      // Storage access can throw (private mode, quota) -- treated the same as "never reloaded":
      // 0013's own guard degrades to "reload every time" rather than never reloading at all.
    }
    if (already !== options.wasm.buildHash) {
      try {
        sessionStorage.setItem(RELOADED_FROM_KEY, options.wasm.buildHash)
      } catch {
        // Same as above: a failed write still reloads once (this pass), just without the guard
        // against a *further* reload on the next mismatch.
      }
      window.location.reload()
      return
    }
    // Same build hash as the last reload: redeploying will not fix this reconnect. `updating`
    // (Scope) and retry on the backoff schedule -- `net/link.ts`'s own `BACKOFF_SCHEDULE_MS`,
    // mirrored here as a plain literal (Deviations: this file has no reason to import `net/link.ts`
    // otherwise, and the schedule is 0013's own fixed constant, not a value the net worker computes
    // per call) since main, not the net worker, owns this retry loop once a link has stopped for
    // good (`worker/net.ts`'s own `buildLink` doc comment: `{ type: 'retry' }` is what rebuilds a
    // terminally-stopped `Link` from scratch).
    emitLink({ state: 'updating' })
    scheduleVersionMismatchRetry(0)
  }
  const VERSION_MISMATCH_BACKOFF_MS = [0, 500, 1000, 2000, 5000]
  function scheduleVersionMismatchRetry(step: number): void {
    const delay = VERSION_MISMATCH_BACKOFF_MS[
      Math.min(step, VERSION_MISMATCH_BACKOFF_MS.length - 1)
    ] as number
    scheduler.setTimer(() => {
      const w = hostWorkerEntry()
      w?.worker.postMessage({ type: 'retry' } satisfies ToWorker)
      // No ack of "did that retry actually land": the net worker's own next `{ type: 'link' }`
      // message (a fresh `up`, or another `down`) drives whatever happens after this, the same way
      // a real reconnect always does -- this is only what keeps *asking* while nothing has.
      scheduleVersionMismatchRetry(step + 1)
    }, delay)
  }

  // docs/plan/29-net-worker-and-reference-server.md steps 1-2: `session_state` polling off the
  // clock block (the same `readClockBlockInto`/`clockScratch` `dispatch`/`waitForLive` already use)
  // -- the one thing that turns a net-level `up` into the public `online` state, since the net
  // worker itself never parses a message and so cannot know whether a session actually went live.
  // Runs only while a poll is in flight (`onlinePolling`), one per `up` transition; a `down` before
  // it resolves stops it by construction (`onlinePolling` is set `false`, so the next queued
  // `scheduler.setTimer` callback -- if one is already pending -- checks it and no-ops).
  let onlinePolling = false
  function pollForOnline(): void {
    if (!onlinePolling) return
    readClockBlockInto(clockView, clockScratch)
    if (at(clockScratch, CLOCK_FIELD.SessionState) === SessionState.Online) {
      onlinePolling = false
      emitLink({ state: 'online' })
      return
    }
    scheduler.setTimer(pollForOnline, 0)
  }

  let everLinkedUp = false
  // 0013 Client policy: "an indicator appears after 1 s" -- a transient `down` (`'dead'`/`'close'`)
  // is not itself worth a `reconnecting` event until a real socket has actually stayed down this
  // long; `downGen` lets a `down` that resolves back to `up` before the delay elapses cancel the
  // pending indicator (a stale timer's own check just no-ops instead).
  const RECONNECT_INDICATOR_DELAY_MS = 1000
  let downGen = 0
  function handleNetLink(m: NetLinkMessage): void {
    if (m.state === 'up') {
      downGen++
      if (!everLinkedUp) {
        everLinkedUp = true
        emitLink({ state: 'connecting' })
      }
      onlinePolling = true
      pollForOnline()
      return
    }
    onlinePolling = false
    if (m.reason === 'superseded') {
      emitLink({ state: 'superseded' })
      return
    }
    if (m.reason === 'bad-key') {
      emitLink({ state: 'rejected', reason: 'BadKey' })
      return
    }
    if (m.reason === 'full') {
      emitLink({ state: 'rejected', reason: 'Full' })
      return
    }
    if (m.reason === 'version-mismatch') {
      ;(versionMismatchHandler ?? defaultVersionMismatchHandler)()
      return
    }
    // `'dead'` or `'close'`: a transient drop the net worker's own `Link` is already retrying on
    // its own backoff schedule (`net/link.ts`) -- this is purely the UI-facing indicator delay.
    const myGen = ++downGen
    scheduler.setTimer(() => {
      if (myGen === downGen) emitLink({ state: 'reconnecting' })
    }, RECONNECT_INDICATOR_DELAY_MS)
  }

  // docs/plan/23-persistence-opfs-and-lifecycle.md Planning decision 5: `navigator.storage.persist()`
  // called exactly once, from the first engine-observed `pointerdown`/`keydown` or the first
  // `client.dispatch`, whichever comes first -- and only when `Persistence.open` reported `created`
  // (a reopened world never calls it). `persistWorldCreated` is `undefined` until the sim worker's
  // first `storage` message says otherwise (a gesture arriving before that first message just sets
  // `persistGestureSeen`; the call itself fires once both are known, whichever settles last).
  let persistWorldCreated: boolean | undefined
  let persistGestureSeen = false
  let persistCalled = false
  function tryPersist(): void {
    if (persistCalled || persistWorldCreated !== true || !persistGestureSeen) return
    persistCalled = true
    void navigator.storage.persist()
  }
  function onLifecycle(m: SimLifecycleMessage): void {
    if (m.type === 'storage') {
      if (persistWorldCreated === undefined) persistWorldCreated = m.created
      tryPersist()
      for (const l of storageListeners) l(m.status)
    }
  }

  // docs/plan/28-sessions-and-reconnect.md step 5: the linked client worker's own one-off
  // `client-welcome` message (`worker/client-net.ts`'s `NetPumpHandshake.onAttached`) -- only main
  // can call `cameraIntegrator.setViewClamp` (0019 §1), so this is the one place `Welcome`'s own
  // view clamps actually reach the camera. docs/plan/28b-reconnect-and-lifecycle.md step 2:
  // `client-resyncing` (a *second* `Welcome`, posted instead of `client-welcome`) has no view
  // clamps to forward -- it fans out to `onResyncing`'s own listeners instead.
  function onWelcome(m: ClientLifecycleMessage): void {
    if (m.type === 'client-resyncing') {
      for (const l of resyncingListeners) l()
      return
    }
    cameraIntegrator.setViewClamp(m.viewMaxTilesPerAxis)
  }

  // docs/plan/23-persistence-opfs-and-lifecycle.md step 5: `exportWorld`/`importWorld`/`deleteWorld`
  // (Seams), plus the shared lock `attachHostLifecycle` also uses (Rules and traps, "serialize
  // them"). `hostOpChain` is the lock's own FIFO promise chain; `.catch(() => {})` on the *stored*
  // chain keeps it alive after a rejected job without ever swallowing that job's own caller-visible
  // rejection (`job` itself, returned to the caller, is a separate promise).
  let hostOpChain: Promise<unknown> = Promise.resolve()
  function hostWorkerLock<T>(fn: () => Promise<T>): Promise<T> {
    const job = hostOpChain.then(fn, fn)
    hostOpChain = job.catch(() => {})
    return job
  }

  function hostWorkerEntry(): WorkerEntry | undefined {
    return workers.find((w) => w.index === WORKER_HOST)
  }

  function pollHostParked(): Promise<void> {
    return new Promise((resolve) => {
      function poll(): void {
        if (Atomics.load(control.words, workerWord(WORKER_HOST, W_PARKED)) === 1) {
          resolve()
          return
        }
        scheduler.setTimer(poll, 0)
      }
      poll()
    })
  }

  // At most one world-op request is ever in flight from this `Client` (`hostWorkerLock` above
  // serializes every caller), so a single pending-resolver slot is enough -- no correlation id.
  let pendingWorldOp: { resolve(m: SimWorldOpResult): void } | null = null
  function onWorldOp(m: SimWorldOpResult): void {
    const p = pendingWorldOp
    pendingWorldOp = null
    p?.resolve(m)
  }

  /**
   * Planning decision 6 ("Main parks the sim worker ... posts the request"), made well-defined
   * under an overlapping hidden-boundary pause (Rules and traps): parks the host worker only if it
   * is not *already* parked (a settled or in-flight `attachHostLifecycle` pause, serialized ahead of
   * this call by `hostWorkerLock`), sends `msg`, awaits the one matching `SimWorldOpResult`, then
   * restores the park bit to exactly what it was before this call -- never touching it at all when
   * it was already parked, so a hidden-boundary pause already in effect (or about to run next, still
   * queued behind this very call) is left exactly as it wants to be either way.
   */
  function withHostParked(
    method: string,
    msg: ToWorker,
    transfer?: Transferable[],
  ): Promise<SimWorldOpResult> {
    return hostWorkerLock(async () => {
      const w = hostWorkerEntry()
      if (!w || options.host.kind !== 'local') throw new NotSinglePlayer(method)
      const alreadyParked = Atomics.load(control.words, workerWord(WORKER_HOST, W_PARKED)) === 1
      if (!alreadyParked) {
        Atomics.store(control.words, workerWord(WORKER_HOST, W_YIELD), 1)
        control.wake(WORKER_HOST)
        await pollHostParked()
      }
      try {
        const result = await new Promise<SimWorldOpResult>((resolve) => {
          pendingWorldOp = { resolve }
          if (transfer) w.worker.postMessage(msg, transfer)
          else w.worker.postMessage(msg)
        })
        if (result.type === 'world-op-error')
          throw new Error(`engine: ${method}: ${result.message}`)
        return result
      } finally {
        if (!alreadyParked) w.worker.postMessage({ type: 'resume' } satisfies ToWorker)
      }
    })
  }

  async function exportWorld(): Promise<Blob> {
    const result = await withHostParked('exportWorld', { type: 'export-world' })
    if (result.type !== 'export-world-result') {
      throw new Error(`engine: exportWorld: unexpected reply ${result.type}`)
    }
    return new Blob([result.bytes as BlobPart])
  }

  async function importWorld(
    bytes: Blob | Uint8Array,
    opts: { worldId?: string; overwrite?: boolean } = {},
  ): Promise<{ worldId: string }> {
    const view = bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes
    const msg: ToWorker = {
      type: 'import-world',
      bytes: view,
      ...(opts.worldId !== undefined ? { worldId: opts.worldId } : {}),
      ...(opts.overwrite !== undefined ? { overwrite: opts.overwrite } : {}),
    }
    const result = await withHostParked('importWorld', msg, [view.buffer as ArrayBuffer])
    if (result.type !== 'import-world-result') {
      throw new Error(`engine: importWorld: unexpected reply ${result.type}`)
    }
    return { worldId: result.worldId }
  }

  async function deleteWorld(worldId: string): Promise<void> {
    const result = await withHostParked('deleteWorld', { type: 'delete-world', worldId })
    if (result.type !== 'delete-world-result') {
      throw new Error(`engine: deleteWorld: unexpected reply ${result.type}`)
    }
  }
  const persistGestureDisposers: Array<() => void> = []
  if (
    options.host.kind === 'local' &&
    options.host.persist === true &&
    typeof window !== 'undefined'
  ) {
    const onGesture = (): void => {
      persistGestureSeen = true
      tryPersist()
    }
    window.addEventListener('pointerdown', onGesture, { once: true })
    window.addEventListener('keydown', onGesture, { once: true })
    persistGestureDisposers.push(() => window.removeEventListener('pointerdown', onGesture))
    persistGestureDisposers.push(() => window.removeEventListener('keydown', onGesture))
  }

  /** "Main rAF: drain the UI ring once" (Scope). Kind 1 (`Ui`, M16b) and kind 2 (`ActionResults`,
   * M16): an unknown kind is skipped by its own length field, never crashing. JSON parsing is a
   * human-rate path (0003, 0016 §2), not yet zero-GC (Deviations: a later milestone's own budget,
   * not this one's -- "it cannot fix a design that allocates by construction"). No record of
   * either kind in a drain costs nothing beyond the empty `popInto` poll itself. */
  function pollActionResults(): void {
    let lastUiLen = -1
    let pendingCount = 0
    for (;;) {
      const len = uiRingConsumer.popInto(uiScratch, 0)
      if (len < 0) break
      let i = 0
      while (i + 5 <= len) {
        const kind = at(uiScratch, i)
        const recLen = readU32LE(uiScratch, i + 1)
        const bodyStart = i + 5
        if (bodyStart + recLen > len) break // never split a record (defensive; producer never does)
        if (kind === 1) {
          // Coalesced to the newest: a later record in this same drain simply overwrites it. Copy
          // the raw bytes only (`copyBytes`, no allocation): decoding here would pay a
          // `TextDecoder.decode()` string allocation even for a record a later one in this same
          // drain immediately discards -- only the final winner is ever decoded, once, below.
          copyBytes(lastUiScratch, 0, uiScratch, bodyStart, recLen)
          lastUiLen = recLen
          // Coordinator gate, M16b cut 2: a plain counter (not itself an allocation) so a test can
          // assert "zero kind-1 records drained" directly, instead of only reading `byFn` in a
          // `budgets.json` `formula` string.
          uiRecordsSeenTotal += 1
        } else if (kind === 2) {
          const text = decoder.decode(uiScratch.subarray(bodyStart, bodyStart + recLen))
          const parsed = JSON.parse(text) as { seq: number; result: ActionOutcome<unknown> }
          pendingSeqs[pendingCount] = parsed.seq
          pendingOutcomes[pendingCount] = parsed.result
          pendingCount++
        }
        i = bodyStart + recLen
      }
    }
    if (lastUiLen >= 0) {
      const text = decoder.decode(lastUiScratch.subarray(0, lastUiLen))
      const ui: unknown = JSON.parse(text)
      onUiFiredTotal += 1
      for (let li = 0; li < uiListeners.length; li++) at(uiListeners, li)(ui)
    }
    for (let k = 0; k < pendingCount; k++) {
      const seq = at(pendingSeqs, k)
      const result = at(pendingOutcomes, k)
      for (let li = 0; li < actionResultListeners.length; li++) {
        at(actionResultListeners, li)(seq, result)
      }
    }
  }

  // docs/plan/16b-ui-observation-and-clock.md Scope: "`client.clock()` returns a reused object
  // `{ authoritative, predicted, ticksPerSecond }` refreshed from the clock block on call (no
  // allocation per call)". Reuses `clockScratch` (above): `dispatch`/`waitForLive`'s own reads and
  // this one never run inside the same call, so sharing the one scratch array costs nothing.
  const clockSnapshot: ClockSnapshot = {
    authoritative: 0,
    predicted: 0,
    ticksPerSecond: 0,
    tickFraction: 0,
  }

  // Named `readClockSnapshot`, not `clock`: `clock` (above) already names the injected `Clock`
  // (`options.test?.clock ?? systemClock`) this whole function scope closes over. Exposed on the
  // public `Client` shape as `clock()` (below) regardless.
  function readClockSnapshot(): ClockSnapshot {
    readClockBlockInto(clockView, clockScratch)
    clockSnapshot.authoritative = at(clockScratch, CLOCK_FIELD.AuthoritativeTick)
    clockSnapshot.predicted = at(clockScratch, CLOCK_FIELD.PredictedTick)
    clockSnapshot.ticksPerSecond = at(clockScratch, CLOCK_FIELD.TicksPerSecond)
    // docs/plan/26-prediction-rendering-and-clocks.md steps 4-6: the one field `CLOCK_FIELD` has
    // no plain-`u32` entry for (`clock-block.ts`'s own doc comment) -- read back through the same
    // reinterpreting view `readClockBlockInto` just refreshed, not through `clockScratch`.
    clockSnapshot.tickFraction = at(clockView.scratchFieldsFloatView(), 0)
    return clockSnapshot
  }

  let resultsFrameHandle = -1
  function resultsFrame(): void {
    pollActionResults()
    resultsFrameHandle = scheduler.requestFrame(resultsFrame)
  }

  function destroy(): void {
    Atomics.store(control.words, CB_LIFECYCLE, Lifecycle.Stopping)
    for (const w of workers) {
      Atomics.store(control.words, workerWord(w.index, W_YIELD), 1)
      control.wake(w.index)
    }
    for (const w of workers) w.worker.terminate()
    for (const dispose of cameraInputDisposers) dispose()
    for (const dispose of persistGestureDisposers) dispose()
    cameraResizeObserver?.disconnect()
    overlay.dispose()
    scheduler.cancelFrame(resultsFrameHandle)
  }

  /** docs/plan/09-renderer-terrain.md Scope: "writeCameraBlock + CB_FRAME_REQ + wake" as one
   * seam (`Client.writeCameraAndWake`, Deviations). No spin/wait here (production never blocks
   * main, 0015 §2): `engine/test`'s `stepFrame` is the one that spins on the returned value. */
  function writeCameraAndWake(): number {
    writeCameraBlock(cameraWriter, cameraState)
    const req = (Atomics.add(control.words, CB_FRAME_REQ, 1) + 1) >>> 0
    control.wake(WORKER_CLIENT)
    return req
  }

  /** docs/plan/09b-terrain-art-and-lifecycle.md Scope: "set `CB_FLAGS.REBASE`". `Atomics.or`, not a
   * load-then-store: another flag bit set by something else between the load and the store would
   * otherwise be clobbered. */
  function setFlags(mask: number): void {
    Atomics.or(control.words, CB_FLAGS, mask)
  }

  async function start(): Promise<void> {
    checkArenaBudget(arenas, options.host.kind, genWorkers)

    const postModule = options.test?.flags?.postModule !== false
    let module: WebAssembly.Module | undefined
    if (postModule) {
      try {
        module = await WebAssembly.compileStreaming(fetch(options.wasm.url))
      } catch (e) {
        throw new EngineStartError(
          'compile-failed',
          `compiling ${options.wasm.url}: ${errorMessage(e)}`,
        )
      }
    }

    // The real `WorldConfig`, `buildHash` filled from `options.wasm.buildHash` (this milestone's
    // own "the engine fills `buildHash`" rule): only present for a local host.
    const worldConfig: ServerWorldConfig | undefined =
      options.host.kind === 'local'
        ? { ...options.host.world, buildHash: options.wasm.buildHash }
        : undefined

    // `options.test.game` is the documented escape hatch for *every* worker (its own doc comment:
    // "overriding `host.world.game`"), so it still wins over a real `WorldConfig` when set. Absent
    // that, each role gets its own config shape converted from the one real `WorldConfig`
    // (Planning decisions: "the client and gen workers take them from `host.world.params`" until
    // M28 delivers seed/params in `Welcome`) -- `sim`'s own shape (`SimConfig`, `host::mod.rs`) is
    // `buildSimInstanceConfig`'s (already built, steps 1-3); `gen`/`client`'s own shape
    // (`TerrainConfig`, `game_instance.rs`) needs only `seed`/`params`, the rest defaulted, so it
    // is built inline here rather than through a second named export nothing else calls yet.
    const simGame =
      options.test?.game ?? (worldConfig ? buildSimInstanceConfig(worldConfig).game : null)
    const game =
      options.test?.game ??
      (worldConfig
        ? { seed: seedToHexU64(worldConfig.params.seed), params: worldConfig.params.worldgen }
        : null)
    // docs/plan/28-sessions-and-reconnect.md step 5 (Scope: "single-player takes the same path ...
    // the client worker config carries `{ secret, joinKey: \"\", buildHash }`"): only when linked
    // (a real Hello/Welcome round trip happens) and only when `options.test.game` did not already
    // win outright (the same escape hatch `simGame`/`game` above defer to). `loadOrMintSecret` is
    // browser-only (`localStorage`), called exactly once per `createClient()`, here -- not inside
    // the worker, which has no `localStorage` of its own to be the one accessor of (Planning
    // decisions "the secret has one accessor").
    const clientGame =
      options.test?.game ??
      (linked && game
        ? {
            ...game,
            secret: hexEncode(loadOrMintSecret()),
            joinKey: worldConfig?.joinKey ?? '',
            buildHash: options.wasm.buildHash,
          }
        : game)

    type Spawn = { kind: WorkerKind; index: number; arenaBytes: number }
    const spawns: Spawn[] = [{ kind: 'client', index: WORKER_CLIENT, arenaBytes: arenas.client }]
    spawns.push(
      options.host.kind === 'local'
        ? { kind: 'sim', index: WORKER_HOST, arenaBytes: arenas.sim }
        : { kind: 'net', index: WORKER_HOST, arenaBytes: 0 },
    )
    const genIndices = [WORKER_GEN0, WORKER_GEN1]
    for (let i = 0; i < genWorkers; i++) {
      spawns.push({ kind: 'gen', index: genIndices[i] as number, arenaBytes: arenas.gen })
    }

    // Orchestrator ruling 1 (Planning decisions): a topology fact, carried identically to the
    // `sim` and `client` setup messages, never to `gen`/`net` (`linked` itself is computed once,
    // above `start()`, so this and `ready`'s own extended meaning cannot drift apart).
    const waits = spawns.map(({ kind, index, arenaBytes }) => {
      const worker = spawnWorker(options)
      workers.push({ kind, index, worker })
      const config: InstanceConfig = {
        arenaBytes,
        game: kind === 'sim' ? simGame : kind === 'client' ? clientGame : game,
      }
      const wasm: { module?: WebAssembly.Module; url?: string } = {}
      if (kind !== 'net') {
        if (module) wasm.module = module
        else wasm.url = options.wasm.url
      }
      const link = linked && (kind === 'sim' || kind === 'client')
      // docs/plan/23-persistence-opfs-and-lifecycle.md steps 3-4: the sim spawn only, only when
      // `host.persist` is set -- `worldConfig` already carries `worldId`/`buildHash`/`params`
      // (`Persistence.open`'s own `WorldConfig` needs no more than these three).
      const world =
        kind === 'sim' && options.host.kind === 'local' && options.host.persist === true
          ? worldConfig && {
              worldId: worldConfig.worldId,
              buildHash: worldConfig.buildHash,
              params: worldConfig.params,
            }
          : undefined
      // docs/plan/29-net-worker-and-reference-server.md steps 1-2: the `net`-kind spawn's own real
      // dial target, present only for a `{ kind: 'remote' }` host. `remoteLinked` (the `client`-kind
      // spawn only) is what gates `worker/client-net.ts`'s handshake pump on `CB_LINK_STATE`.
      const net =
        kind === 'net' && options.host.kind === 'remote'
          ? {
              url: options.host.url,
              ...(options.host.joinKey ? { joinKey: options.host.joinKey } : {}),
            }
          : undefined
      const remoteLinked = kind === 'client' && options.host.kind === 'remote' ? true : undefined
      return setupWorker(
        worker,
        kind,
        index,
        sabs,
        config,
        wasm,
        options.test?.flags,
        link,
        world,
        net,
        remoteLinked,
        onLifecycle,
        onWorldOp,
        onWelcome,
        handleNetLink,
      )
    })
    await Promise.all(waits)
  }

  // Captured separately from `ready` itself (below), and exposed on `ClientTestHandle` as
  // `workersReady` (docs/plan/16-action-round-trip.md, gate-round fix): the moment every spawned
  // worker has actually posted its own `{ type: 'ready' }` handshake -- distinct from `ready`'s
  // own, later "session live" meaning, and the one thing a test page needs before it is safe to
  // call anything that blocks the main thread waiting on a worker's own ack (`stepSimTickSync`;
  // `engine/test.pumpUntilLive`'s own doc comment has the incident this fixes: calling it *before*
  // this moment busy-spins the main thread, which starves the very worker setup it is waiting for
  // -- measured at 11.28 s of a tight spin ending exactly when every worker's own `engine_init ok`
  // finally logged, immediately after the spin gave up and yielded the thread back).
  const workersUp = start()
  const ready = workersUp.then(() => {
    resultsFrameHandle = scheduler.requestFrame(resultsFrame)
    // `waitForLive()` is started whenever `linked` (both `local` + `connect` and every `remote`
    // host), so `nextSeq` still gets seeded from the real session's own `seqSeed` the moment a
    // remote session actually goes live -- `ready` itself only *awaits* it when `awaitLive` is
    // also true (`local`): a remote host's own poll keeps running in the background regardless,
    // deliberately not chained into anything (it never rejects; nothing needs its resolution here).
    const live = linked ? waitForLive() : undefined
    return awaitLive ? live : undefined
  })
  const client: Client = {
    ready,
    cameraState,
    uploadRing: sabs.uploadRing,
    dispatch,
    onActionResult,
    onUi,
    onStorage,
    onResyncing,
    onLink,
    onVersionMismatch,
    exportWorld,
    importWorld,
    deleteWorld,
    clock: readClockSnapshot,
    writeCameraAndWake,
    setFlags,
    input,
    pick: { acquire: picker.acquire, at: picker.at },
    overlay: { anchor: overlay.anchor, anchorSlot: overlay.anchorSlot, update: overlay.update },
    camera,
    destroy,
  }
  handles.set(client, {
    control,
    sabs,
    cameraState,
    cameraWriter,
    clock,
    scheduler,
    workers,
    cameraBundle,
    cameraIntegrator,
    drawListSlot,
    picker,
    overlay,
    writeActionRecord,
    workersReady: workersUp,
    uiDrainStats: () => ({ recordsSeen: uiRecordsSeenTotal, onUi: onUiFiredTotal }),
    hostWorkerLock,
  })
  return client
}
