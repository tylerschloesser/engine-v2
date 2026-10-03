# M39f: Device auto-runner (one QR, the phone walks the round)

Status: draft, not started · After: 39e · Tyler-dependent: yes (four decisions under Planning decisions, "For Tyler")

## Goal
Tyler, 2026-10-03, after trying M39e: "Ok this is a good start. But now you're asking me to record a ton of information that honestly you should be able to get from the device/browser automatically. Extend to build a data collection service. Further, I feel like you could just instrument an entire test run in a single page. Like, I scan a QR code, and you do all of the rest. Either via a script on the phone, or via websockets remotely or something like that."

When this is done Tyler scans **one** QR code. An agent script on the phone walks the whole round: it opens each check's page through the tunnel, collects everything machine-readable (UA, adapter info, `crossOriginIsolated`, HUD numbers, golden and hash results, `engine_mem_grows`, rAF stats, timings, errors, `uncapturederror`, device loss), judges the criteria it can, and streams the results to the Mac `device:walk` service, which writes them to the M39e round log. Tyler is prompted on the phone only for what needs a human (a gesture, a visual verdict, leaving the app, Low Power Mode, a second device, desktop inspector items). The orchestrator can start a round, wait for it and read it from `--status --json`.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/39e-device-walkthrough-tool.md` (Deviations: round log, serving model, `createServerControl`) and `docs/plan/device-checks.md` (the 45 non-meta rows classified below)
3. `packages/engine/scripts/device-serve.mjs` (`--tunnel`, `--ws`, `--app reference`, `--bench`; the `ENGINE_WS_PROXY_PORT` precedent for a proxied path)
Mine: `scripts/lib/device-walk/*` (parse, rounds, servers, serving, app, status, apply), the fixture pages' existing hooks (`window.__determinism`, `__worldgenBench`, `__opfsLatencyResult`, `__device`, `__hudText`, `__tick`, `__sliceConfirmed`, `__worldHashAndTick`, `__persistenceDebug`, `__mpLinkLog`, `__errors`, `__adapterInfo`), `games/reference/src/bench.ts` (`window.__bench`, `#bench-hud`). Rules that apply: `.claude/rules/hot-paths.md` (the agent's per-frame observer is allocation-free; it runs in pages under that rule even though never in the gc suites), `.claude/rules/determinism.md` (untouched).

## Scope
Cut into five delegations of about three steps each, in order. Each lands green on `main`.

**Delegation 1: transport, service core and the agent skeleton (steps 1-3).**
1. *Service split and protocol.* `device:walk` gets a second listener, the **phone API** on its own loopback port, never the Mac UI's port: the Mac UI keeps `/api/*` on `127.0.0.1` only. The phone API serves `/__walk/agent.js`, `/__walk/runner.html`, a WebSocket `/__walk/ws` and a POST `/__walk/msg` fallback, all gated by a random 128-bit run token (query or first message), with an Origin/Host check. Message envelope `{run, tab, seq, t, type, ...}`; the service acks `seq`, ignores `seq <= lastSeq[tab]` (idempotent resend), and stores `src: {tab, seq}` on every event it appends so the dedupe table is rebuilt from the log on restart. New round-log events, replayed by `rounds.mjs` and ignored by older readers: `env`, `attempt {id, n, variant, page}`, `prompt {id, n, kind: act|judge, text}`, `result` extended with `by: auto|human|mixed`, `attempt`, `criteria: [{name, value, limit, ok}]`, `metrics`, `evidence` (a path). `numbers` is filled from `metrics` so `--apply` writes the same **Run on** text from auto data. Raw series (per-second HUD samples, link log, console) go to `test-results/device-walk/<round>/<id>-<n>.json`, untracked, referenced by `evidence`.
2. *Serve-time mount and multi-server.* `device-serve.mjs` takes `--walk <port>`: both Vite configs (the fixture app's and `games/reference/vite.config.ts`) read `ENGINE_WALK_PORT`, add `preview.proxy['/__walk']` (http and ws, same shape as `ENGINE_WS_PROXY_PORT`) and a small shared preview plugin that injects `<script src="/__walk/agent.js">` into served HTML. The release bundle is untouched (injection happens at serve time, in `vite preview`). `createServerControl` becomes a keyed map: `ensureAll(variants)` starts every variant the selected items need in parallel (distinct `ENGINE_TEST_PORT`/`ENGINE_WS_PORT`, one tunnel each; the two `games/reference` builds are serialised because they share the cargo target dir), `urlFor(variant)`, `stopAll`. The fixture variant always runs with `--ws puts`, so `mp.html` needs no separate variant.
3. *Agent skeleton and runner page.* `scripts/lib/device-walk/agent/agent.js` (plain JS, no build step, about 400 lines): identity from `?walk=<token>&tab=<id>` (kept in `sessionStorage`); `hello {lastSeq}` and resume; environment facts (UA, `navigator.userAgentData` where present, `platform`, screen, `devicePixelRatio`, `visualViewport`, `crossOriginIsolated`, `hardwareConcurrency`, `deviceMemory` where present, `navigator.gpu` adapter `info` and `features`/`limits` summary, `matchMedia` colour/motion); a wrapper of `GPUAdapter.prototype.requestDevice` that attaches `uncapturederror` and `device.lost` listeners to any device the page creates; `window.onerror`/`unhandledrejection`/`console.error` capture; a visibility and `pagehide` log; an allocation-free rAF gap recorder (Float32Array ring) plus long-frame counters; an outbox in `sessionStorage` flushed in order after a drop; screen wake lock requested on the runner's Start tap and re-requested on `visibilitychange`; a bottom-sheet **walk bar** (shadow DOM; act prompts with live "detected" ticks, judge prompts with Pass/Fail/Skip and a note, **Redo previous**, **Pause**) that is **removed entirely during a measuring window** so it cannot change compositing. `runner.html` is the QR target: a Start button (the gesture), a pre-flight list (Auto-Lock, Low Power Mode off, Wi-Fi), then it navigates to the first step. A built-in `M39f-selftest` step (no check content): hop across two origins, hold the wake lock 6 min, drop the tunnel 20 s with a foreground tap, report.

**Delegation 2: the criteria table and the static and device.html families (steps 4-6).**
4. `scripts/lib/device-walk/checks.mjs`: one entry per walked id: `{class, signal, plan, criteria: [{name, source, limit}], acts, judges}`, limits read from `budgets.json` or quoted with their ADR section, never copied prose. Unit test: every non-Android, non-meta id in `device-checks.md` has exactly one entry and the reverse; each entry stores a short hash of the item's Pass text, so editing a Pass line without updating the entry fails the test. Mac-side helper: desktop median for M08-warn-threshold by running `worldgen-bench.html` in headless Chromium on the Mac (`baselines/worldgen.json` is native, not WASM-in-browser, so not usable).
5. Adapters for the pages whose hooks exist: determinism, worldgen-bench, opfs-latency (read `__determinism`, `__worldgenBench`, `__opfsLatencyResult`; no page change), `device.html` boot. `device.html` gets `window.__check = { ready, readings() }` returning the HUD's own numbers as numbers (rAF interval p50/p95/worst, `>20 ms` count, main callback p95, GPU latency p95, `frames rendered`, `workersReady`, `delivery`, orientation, `tilesAcross`, `centre`, `cursorTile`).
6. Fill-rate and memory: a 60 s measuring window per orientation (the agent samples `readings()` once a second, keeps the worst 10 s window, detects the rotation with `orientationchange`), the `?probe=memory` page's progress lines exposed as `readings().steps[]`, reload detection (a boot nonce in `sessionStorage` against the probe-in-progress marker: an iOS tab kill reads as **fail at step N**, with the last progress line), and the **ladders** (`&scaleCap=1.5`, `&scaleCap=1`, `&cutoff=4`; `?module=url`; `&sim=64&client=32`; `&anchorMode=translate`) run automatically as further attempts, each its own `attempt` and `result`.

**Delegation 3: lifecycle and choreography on the fixture pages (steps 7-9).**
7. `slice.html` (boot, round-trip, coexist, background, low-power) and `world.html` (hidden-pause, kill-resume, private, world-busy, export-import): the agent drives Paint through `__dispatchPaintAt`, scripted pan through an `?autopan=1` addition to `slice.html` (what `device.html` already has) and `__sliceInjectPointer` for the flick, and reads `__sliceConfirmed`/`__sliceRejected`/`__tick`/`__worldHashAndTick`/`__persistenceDebug`; the slice's `memGrows` and the `ring drops` count are added to a `__check.readings()`. Kill-resume keeps the **before** reading on the service (hash, tick, admitted count) and compares after the reopen; Low Power Mode is detected as a rAF cadence of about 30 Hz, and the motion check compares a scripted flick's distance at 60 Hz (the attempt just before) with 30 Hz.
8. `mp.html` (socket-resume, play-through-drop, net-heap): a **drop choreographer**: for each of the 6 scenarios x 3 runs the bar says what to do and for roughly how long, the **service** times the absence from the page's `hidden` and `visible` beacons (`sendBeacon` on `visibilitychange`, ignored when the actual time is outside +-30% of the target, the run repeats), the outbox covers airplane mode, and the `__mpLinkLog()` rows give `close` or silence and `visible -> Welcome`. The scripted pan runs through every drop, so M29-play-through-drop reads the same runs as M29-socket-resume (18 drops, not 36). Net-heap is a 10 min run with scripted paints at a steady rate and the rAF long-frame counters.
9. `device.html?anchors=50`: the expected ring position per button from `__anchorsRingWorld` and the camera transform against each button's `getBoundingClientRect()` per frame (max error in px, jitter), a scripted pan and zoom sweep, `pick_id` expectation for **M18-pick** (the bar highlights a target ring, Tyler taps it, `pick_id` is compared), the cursor tile for **M18-touch-ghost**.

**Delegation 4: the reference game (steps 10-12).**
10. Release build, no hooks: **M35** (Mac, iPhone) and **M37b** through injection and the DOM only (capability screen, fatal screen, `rendererLost` banner, `#linklog`, canvas size, frame cadence, the wrapped device's lost/uncapturederror, boot nonce for a discard), plus a judge prompt for "world drawn". **M35-capability** runs on the Mac in headless Chromium with `navigator.gpu` removed by an init script, reading the capability screen text (the automated `capability.spec.ts` already covers it; see "For Tyler").
11. Bench build, `__bench`: **M39-large-save** and **M39-frame-shares** (limits from `PRE-PLAN.md` §7: tick <= 10 ms, main <= 4 ms, client-worker frame <= 8 ms), reading `__bench.hud()` after the first 10 s; a bench-only `?zoom=max` so the zoom-out is scripted. Decide by measurement whether the bench build's `bench` cargo feature leaves normal worlds bit-identical (golden); if so the bench build is also the reference **check build** (adds `window.__check`: link, roster, remote entity render positions, own-timer bars). If not, add `--mode check` (release profile, `__CHECK__`), served by `--check`.
12. **M34** with a **bot partner**: a Playwright Chromium on the Mac joins the same LAN world, scripted by the service (collect, place, move, disconnect). Own-timer-bar: tap time, bar full time, result time, per link (Wi-Fi, then the phone's Wi-Fi off, a prompt). Remote motion: the per-frame jump of the remote circle against its speed (a snap is a jump above a multiple of the expected step), the fade after the bot disconnects, one judge prompt.

**Delegation 5: tracker, Mac browsers and the end-to-end demonstration (steps 13-15).**
13. `--status --json` extended (below), `--wait <round> [--timeout <s>]`, `pnpm device:walk --auto --round <name> [--only ...] [--no-open]` (prints the QR in the terminal and writes `test-results/device-walk/<round>/qr.svg` and the join URL), and `--manual` keeps the M39e flow. The Mac UI becomes the live monitor (items turning green as readings arrive, the current prompt, the phone's last-seen time, redo and back).
14. Mac browser items: the service opens `open -a Safari|Firefox <loopback URL>?walk=...` itself; **M11-pinch-desktop-safari**, **M17b-*** and **M39-desktop-browsers** use the same agent (Mac tab, loopback). M17b collects the harness probe lines and errors automatically and asks only for the Web Inspector allocation growth and GC marker count.
15. `device-round` skill rewritten, `device-checks.md` header line updated, **end-to-end demonstration**: a Playwright WebKit page in iPhone emulation plays the "phone" through `--only M03,M08,M11-boot,M16,M23-opfs,M23-hidden` with no human input, and a scripted second run kills the page mid-attempt (resume) and cuts the tunnel (outbox).

## Non-scope
Android (no device, Q5). Any change to a check's meaning, id or Pass criterion in `device-checks.md` (the headers and **Run on** writes only). A hosted service or account. Reading the Fly deployment (see below). Engine changes beyond bench/check-build hooks. Replacing the M39e Mac UI.

## Files, packages and crates touched
`scripts/device-walk.mjs`, `scripts/lib/device-walk/*` (new: `phone-api.mjs`, `checks.mjs`, `agent/`, `runner.html`, `mac-browser.mjs`, `bot.mjs`), `scripts/lib/device-walk-*.test.mjs`; `packages/engine/scripts/device-serve.mjs` and a shared preview plugin beside it; `packages/engine/tests/browser/pages/` (`device.html`/`src/device.ts`, `slice.ts`, `world.ts`, `mp.ts`: `__check`, `?autopan=1`); `games/reference/` (vite config and `bench.ts`, check-build hooks); `.claude/skills/device-round/SKILL.md`; `docs/plan/device-checks.md` (header line). Four packages touched (scripts, engine, reference, the plan docs): that is why it is five delegations.

## Seams
**Provides:** `pnpm device:walk --auto|--manual|--wait`; the phone API (`/__walk/*`, envelope above); `window.__check` on fixture pages and the reference bench/check build; the extended round-log events; `checks.mjs` (the machine-readable criteria). **Consumes:** M39e (`createServerControl`, round log, `--apply`, `--status`), `device-serve` flags, `window.__bench`, `budgets.json`, `PRE-PLAN.md` §7.

**The check reporter contract (`window.__check`)**, on fixture pages and the bench/check build only; **absent from the release build**:
```ts
type CheckReporter = {
  ready: boolean                          // same moment as window.__pageReady
  page: string                            // 'device', 'slice', 'world', 'mp', 'bench', ...
  readings(): Record<string, number | string | boolean | null>  // flat, JSON-safe, <= 1 Hz; keys follow the HUD names (raf_p95_ms)
  verdictHints?(): Array<{ criterion: string; value: unknown; ok?: boolean }>  // page-computed, advisory
  act?: Record<string, (arg?: unknown) => Promise<unknown>>     // scripted drivers: paint, autopan, zoomTo, flick, dropLink
  errors(): string[]                      // the page's own error channel (device.errors())
}
```
The service decides pass/fail from `checks.mjs`, never the page (a page hint is advisory), so a limit lives in one place. Diagnostic pages are outside the hot-path rule, as `device.ts`'s own header says.

## Planning decisions

### The classification (45 rows; Android rows excluded; M39-rerun is meta)
`auto` = verdict from measurement (a human may be asked to **act**, not to **judge**). `auto+confirm` = measured plus one judge tap. `human` = the verdict is the human's. "Hitch" clauses use a numeric proxy (below). Counts: **auto 25, auto+confirm 11, human 8, meta 1**.

| id | class | signal source (existing, or the small instrumentation to add) | human does |
|---|---|---|---|
| M03-determinism | auto | existing `window.__determinism` (`fixtures[*].pass`, `userAgent`, `crossOriginIsolated`) | nothing |
| M08-worldgen-ms-per-chunk | auto | existing `__worldgenBench` (`medianMs`, `pass`, `hardwareConcurrency`); 1 ms from `0008` §6 | nothing |
| M08-warn-threshold | auto | phone median from `__worldgenBench`; desktop median from the same page in headless Chromium on the Mac (service-run) | nothing |
| M09b-fill-rate | auto | add `device.html` `__check.readings()` (HUD numbers as numbers); 60 s window per orientation, worst 10 s window; hitch proxy = `>20 ms` count and rAF gap max | rotate the phone once |
| M11-boot | auto | `device.html` `workersReady` and delivery line into `__check`; `isolated` and adapter from the agent | nothing |
| M11-gestures | auto+confirm | agent pointer log (touch count, scroll, `visualViewport.scale`), `__check` camera (tilesAcross reaching both limits, cursorTile after a tap, centre across `orientationchange`), reload nonce | do the gestures; judge "stays under the finger", "flick glides" |
| M11-memory | auto | add `?probe=memory` progress as `__check.readings().steps[]`; reload detection by boot nonce (a tab kill is the failure, recorded with the last line) | nothing |
| M11-pinch-desktop-safari | auto+confirm | agent on Mac Safari: `gesturechange` count and scale, `visualViewport.scale` stays 1, `__check.cameraTilesAcross` | pinch; judge "about the cursor" |
| M16-slice-boot | auto+confirm | `slice.html` isolated/adapter/workers from `__hudText`, terrain drawn from the existing `__probeTile`/`__sliceSettle` readback; M03 inherited; gestures inherited from M11-gestures if in the round | one tap if M11-gestures is not in the round |
| M16-round-trip | auto | `__dispatchPaintAt` x10, `__sliceConfirmed`/`__sliceRejected`, `ring drops`, click-to-confirm latency (a limit for "no perceptible delay" is a decision, below) | nothing |
| M16-coexist | auto | `?autopan=1` on `slice.html` (new), scripted paints, `engine_mem_grows` added to `__check`, reload nonce, long-frame counters, 10 min | nothing (keep the screen on) |
| M16-background | auto | visibility log, `__tick` at `hidden` versus at `visible`, rAF resumes, no reload (nonce) | leave the app 30 s, lock 60 s |
| M16-low-power | auto | Low Power Mode detected as ~30 Hz rAF; scripted flick through `__sliceInjectPointer`, distance at 60 Hz (prior attempt) versus 30 Hz | turn Low Power Mode on |
| M17b-harness-desktop-safari | human | `window.__deviceHarness` probe lines and errors captured automatically; the allocation timeline is Web Inspector only | read two numbers off the Timelines panel |
| M17b-harness-desktop-firefox | human | same, Profiler | same |
| M18-anchors | auto+confirm | `__anchorsRingWorld` plus camera transform against each button's `getBoundingClientRect()` per frame: max px error and jitter (compositor-side swim is invisible to JS, hence the confirm); rAF p95 | judge "no swim, crisp text" |
| M18-fill-rate-with-anchors | auto | as M09b-fill-rate on `?anchors=50`, scripted pan/zoom sweep, ladder `&anchorMode=translate` | rotate once |
| M18-pick | auto | `pick_id` into `__check`; the bar highlights a target ring and the page knows the expected id; a button tap must leave `pick_id` unchanged | tap the highlighted rings and a button |
| M18-touch-ghost | auto+confirm | `cursorTile` after a tap (`__check`), camera centre moved by a drag | tap and drag; judge "the ghost sits on the tile" |
| M23-opfs-latency | auto | existing `__opfsLatencyResult` (`flush` p95, `move()`/locks booleans) | nothing |
| M23-kill-resume | auto | before reading (hash, tick, admitted count) kept on the **service**, compared after the reopen via `__worldHashAndTick`/`__persistenceDebug` | swipe-kill Safari, reopen (the tab is restored with its `?walk=` URL, or the QR is shown again) |
| M23-world-busy | auto | second tab opened from a tap on the bar, both tabs report: `__worldBusy()` true in the second, the first not superseded | tap "open second tab", come back |
| M23-private | auto | `durable:false` from the HUD text, Paint still advances `tick` | open the link in a Private tab (the bar offers Copy link) |
| M23-hidden-pause | auto | Paint through `__dispatchPaintAt`, `__worldHashAndTick` before and after, visibility log (hidden 30 s), `durable`, nonce | leave the app 30 s |
| M23-export-import | auto+confirm | `__worldHashAndTick` on both worlds; the download and picker are real, so no scripted shortcut | tap Export, choose the file in Import; judge "it arrived in Files" |
| M29-socket-resume | auto | `__mpLinkLog()` rows plus the service-timed absence: `close` or silence, `visible -> Welcome`, nonce for a discard; 6 scenarios x 3 runs; the outbox covers airplane mode | do each drop for the stated time |
| M29-play-through-drop | auto | same runs, scripted pan across every drop, link-log timing of the indicator versus 0013's delay, no dialog element in the DOM | nothing extra |
| M29-net-heap | auto | 10 min of scripted paints, rAF long-frame count and max (hitch proxy) | nothing |
| M34-two-devices | auto+confirm | bot partner on the Mac (Playwright Chromium); check-build `__check` roster and remote entities | judge "I see its circle" (one tap) |
| M34-own-timer-bar | auto | check-build `__check` own-timer progress per frame: tap time, bar-full time, result time, per link | switch the phone off Wi-Fi when asked |
| M34-remote-motion | auto+confirm | check-build remote render positions: per-frame jump versus speed (snap metric), fade after the bot drops | judge "fades, no snap" |
| M35-safari-build-mac | auto+confirm | release build, DOM only: no capability or fatal screen, canvas present, frame cadence, no delivery line, GPU wrap events | judge "world drawn" |
| M35-safari-build-iphone | auto+confirm | same | same |
| M35-capability | auto | Mac headless Chromium with `navigator.gpu` removed, capability screen text `no-webgpu` (already covered by `capability.spec.ts`) | nothing |
| M37b-ios-background | auto+confirm | release build: device lost/uncapturederror via the `requestDevice` wrapper, `rendererLost` banner in the DOM, rAF resumes, nonce (reload), 3 runs | background under memory pressure; judge "drawn again" per run |
| M38-hosted-boot | human | none on the page (the Fly origin is not ours to inject into); the service runs `scripts/check-coi.mjs <url>` and attaches it | open the URL on cellular, judge "online" |
| M38-socket-resume | human | none (as above); the on-page `?linklog=1` rows are read by eye | the M29 drops, copy the rows |
| M38-remote-motion | human | none | as M34-remote-motion by hand |
| M39-rerun | meta | not walked (`device: none` already) | |
| M39-large-save | auto | `window.__bench.hud()` after 10 s: `engineMemGrows` sim/client = 0, `tickP95Ms`; reload nonce; 10 min | nothing (keep the screen on) |
| M39-frame-shares | auto | `__bench.hud()` `mainP95Ms`, `frameP95Ms`; scripted pan, bench-only `?zoom=max` | nothing |
| M39-full-game-touch | human | telemetry only (reload, long frames, errors, rAF); the verdict is the play | play the script of `34b`, judge |
| M39-two-devices | human | telemetry only; the real second device is the point | play, judge |
| M39-desktop-browsers | auto | Mac Safari and Firefox tabs opened by the service: console and `uncapturederror` capture, long-frame proxy, scripted pan for 5 min; Firefox without `navigator.gpu` is recorded and the item is `skip` with that evidence | nothing |
| M39-sign-off | human | none | Tyler signs |

Of the 25 `auto` rows, 11 ask Tyler to act (rotate, leave the app, a drop, a Private tab, Low Power Mode, tap targets): that is a prompt with a live "detected" tick, not a judgement.

**Hitch proxy.** "No visible hitch" (M09b, M16-coexist, M29-net-heap, M18-fill-rate, M39-desktop) becomes: count of rAF gaps above 25 ms and the single worst gap, plus GPU latency p95 where the page measures it. The limit is stated per entry in `checks.mjs` and the bar shows a judge prompt **only when the proxy is borderline**. Decision for Tyler below.

### Architecture options
| | (a) runner page, iframe per check | (b) phone holds a socket, Mac drives it remotely | (c) recommended: injected agent + top-level navigation + service-held step state (a hybrid of b) |
|---|---|---|---|
| How | one runner page iframes each check page, reads it by same-origin access or `postMessage` | a thin page on the phone opens a WebSocket; the Mac sends "open X"; the page navigates and reports | the agent script is injected into every served HTML at serve time; each check page is a **top-level** navigation; the agent opens the socket on every page load, asks the service "what is the step", and reports to it |
| COOP/COEP and WebGPU | **Probe, desktop only** (scratchpad `probe39f/probe.mjs`): same-origin iframe under `COOP: same-origin` + `COEP: require-corp` gave `crossOriginIsolated`, `SharedArrayBuffer`, a shared `WebAssembly.Memory`, a worker, a WebGPU adapter and device, and rAF in both Playwright Chromium (`apple`/`metal-3`) and Playwright WebKit (`apple`). **iOS Safari is unverified.** | n/a | n/a (no iframe) |
| Fidelity | the measured page runs inside another document: its rAF, memory, visibility and the gestures of M11 are measured through an iframe; leftover workers and WASM memory of earlier iframes (teardown is not prompt) contaminate M11-memory and M39-large-save | a top-level page, as a player has | a top-level page, as a player has; the injected script is observer-only |
| Different servers and origins | impossible: a cross-origin iframe cannot be read at all, and the fixture app, the reference game and the bench build are three origins (three tunnels) | handled by `goto` | handled by `goto`; state is on the service, so a hop between origins loses nothing |
| Survives the phone sleeping or a reload | the runner dies with the page | the page asks "where was I" on reload | same, and a page killed mid-attempt is detected by the nonce and retried |
| Lifecycle checks (kill-resume, background, private, second tab) | the runner is the thing being killed or hidden | works | works |
| Page changes | none for reading, but iframes need `allow=webgpu` | pages unchanged | fixture pages gain `__check` where HUD text is not enough; release builds unchanged |
| Verdict | rejected as the primary (fidelity, origins, lifecycle); worth a 20-line iOS probe only if someone wants it later | sound, but a bare remote control cannot read page internals | recommended |

**Servers.** One server with everything mounted is not workable: the fixture app and the reference game both serve at `/` with absolute asset paths (`/terrain/tiles.json`, `/tiles.json`, `/assets/*`), and mounting under prefixes breaks them. The service instead starts every needed variant **in parallel at the start** and passes each its own tunnel: fixture (+ `--ws puts`), reference (+ `--ws`), reference bench; the Fly URL is external. The phone is never made to wait for a server switch, and the QR it scans (the runner URL on the first needed origin) is the only one it needs; later hops are `goto` navigations the agent performs (a script-initiated top-level navigation of the same tab needs no user gesture on iOS). Startup is serial for builds (shared cargo dir) and parallel for tunnels; the first step's variant is built first so the QR appears early. The alternative, switching servers while the phone waits, would need the old origin's page to stay alive to be told the new tunnel URL, and has no benefit.

**Results to the log.** The agent posts `{type: reading|result|prompt-answer|env|visibility}`; the service validates, appends to the round log (`result` with `by`, `criteria`, `metrics`) and writes the raw series beside it. `--apply` and `--status` read the same `result` rows as before, so M39e's tick and **Run on** logic is unchanged; the **Run on** line additionally carries the device model class, the UA's Safari version and the adapter string from `env`.

**Sleep, drops, resume, idempotency.** The step machine is on the service (cursor plus the open attempt), not in the page. Every message has `{tab, seq}`; the agent's outbox keeps unacked messages in `sessionStorage` and resends in order; the service dedupes on `seq`. A phone that sleeps mid-attempt reloads or resumes; the agent says `hello {lastSeq}` and the service answers with the current step. If the attempt was interrupted (page reloaded or hidden outside an act prompt, a boot nonce mismatch), the service writes `attempt n` as `interrupted` and opens `n+1`. A dropped tunnel is invisible to a foreground page (the outbox) and is re-dialled with backoff; if the tunnel **URL** changes (cloudflared restarted) the phone cannot learn it, so the service reprints the QR for the same run token and the log continues. Wake lock is requested on the Start tap and on every page load; the pre-flight asks for Auto-Lock "Never" for the round as the fallback.

**Back, redo, append-only history.** The Mac UI keeps M39e's buttons (back, jump, redo, change a result) and the phone bar has **Redo previous** and **Pause**. A redo is a `redo` event plus a new `attempt`; each attempt ends in its own `result`, so both runs stay in the history exactly as M39e specifies. `by: human` overrides an `auto` result the same way (a new row).

**What leaves the machine.** Nothing beyond what M39e already approved (Q7): the Cloudflare quick tunnel carries the pages and the agent's traffic (UA, screen, adapter, readings) over TLS through Cloudflare's edge. The phone API is reachable from the internet to anyone with the tunnel hostname, so: run token required on every request and socket, Origin/Host checks, a **separate listener from the Mac UI**, and the phone API can only append readings and answer prompts (it cannot read the log, serve repo files or move the cursor except through the step protocol). The agent never reads location, clipboard, contacts, camera, microphone, cookies of other sites, or anything outside the page. Raw series stay in untracked `test-results/`; the committed log holds aggregates, the UA string and the adapter string (no IP, no identifiers).

### For Tyler
1. **Hitch proxy:** accept a numeric rAF-gap proxy in place of "no visible hitch", with a judge prompt only when borderline (recommended), or always ask?
2. **Bot partner:** let M34's two-device items use a Playwright Chromium on the Mac as the second player (the phone is the device under test; M39-two-devices and sign-off stay with a real second device), or keep the real Mac Chrome?
3. **Retire M35-capability** from the device list (the automated `capability.spec.ts` covers it; here it is run again in headless Chromium)? And **M38 on Fly stays human** because the Fly origin cannot be instrumented without putting a script hook in the production static handler: confirm that is fine.
4. **Committed device facts:** the round log would include the UA string and adapter string (no IP). OK to commit, or keep them in `test-results/` only? Also the iOS field: Safari's UA reports a frozen OS version, so the runner offers a one-tap iOS and model picker once, prefilled from the `Version/` token and screen size (no model API exists).

### Risks
- **Wake lock and Auto-Lock (riskiest).** The 10 min items (M16-coexist, M29-net-heap, M39-large-save) and every foreground measurement die if the screen locks. iOS Safari supports the Screen Wake Lock API (16.4+) but releases it on any page hide and on navigation, and its behaviour in a plain tab after a script-driven navigation is untested here. Retire it first: the `M39f-selftest` step of delegation 1 holds the lock 6 min with Auto-Lock at 30 s, after two origin hops; fallback is the pre-flight "Auto-Lock: Never" plus the no-sleep looping-video trick. Delegation 2 does not start on a red result.
- **iOS background and discard.** Sockets and timers are suspended when hidden; the service times absences from beacons and from `hello` on return, never from the phone's timers. A tab Safari discards reloads the page (nonce mismatch) and is recorded as the failure it is in M11-memory, M37b and M29.
- **iframes on iOS.** Unverified, and not needed by the recommendation. Probe if wanted: a 20-line fixture page that runs the probe's child inside an iframe, scanned once.
- **Tunnel.** The URL cannot change mid-run without a re-scan; quick tunnels may rate-limit three parallel starts (serialise if so); WebSocket works through cloudflared, so SSE is not used. The tunnel dropping mid-measure is a retry, not a failure.
- **Observer effect.** The agent's rAF recorder adds a callback per frame; the walk bar is removed during measuring windows; delegation 1 measures HUD p95 with and without the agent on desktop (must differ by under 0.2 ms) and records it.
- **UA quirks.** Safari has no `userAgentData` and no `deviceMemory`: recorded as `null`, not as a failure; the model name is not exposed.
- **Mac browser launch.** `open -a Safari` may need a first-run permission; Firefox may lack WebGPU, recorded as `skip` with evidence.
- **Scripted input is not touch.** Round-trip, low-power and the anchors sweep use script-driven camera and pointer events (the camera integrator is time-based); the pick and gesture items keep real touches.

## Order of work
Delegations 1 to 5 in order; steps 1 to 15 as above. The phone self-test (Tyler scans once) gates delegation 2.

## Tests added
`unit` (each inject-fail-reverted): envelope dedupe and `src` rebuild after restart; replay of the new events with an old reader; interrupted-attempt and resume state machine; two-listener separation (the phone API refuses `/api/*`, a request without the token or with a foreign Origin is refused); the `checks.mjs` drift test (ids both ways, Pass-text hash); criteria evaluation (limits at, above and below); drop-choreographer timing (+-30% window, repeat); `--wait` exit codes; `--status --json` shape. `browser` (Playwright Chromium and WebKit, fixture app with the agent injected, no real tunnel): the agent reports `env` and survives a navigation; outbox flush after the socket is cut; the `requestDevice` wrapper sees a forced `uncapturederror` and `device.lost`; the walk bar is absent in a measuring window. A `check-absent` spec beside `bench-absent.spec.ts`: no `window.__check`, `__walk` or agent string in `games/reference/dist/`, and none in the page served without `--walk`.

## Exit criteria
- [ ] `pnpm device:walk --auto --round demo --only M03,M08,M11-boot,M16-round-trip,M23-opfs,M23-hidden-pause --no-open` completes with a Playwright WebKit page in iPhone emulation as the phone, no human input, every row recorded with `by: auto`; evidence: `--status demo --json` pasted, the round log, the `test-results/device-walk/demo/` series.
- [ ] A scripted run that kills the page mid-attempt and cuts the socket for 20 s resumes and finishes with no duplicate `result` rows (the log shows `interrupted` then `attempt 2`).
- [ ] The release `games/reference/dist/` carries none of the agent or reporter (`check-absent`).
- [ ] The `checks.mjs` drift test covers all 45 rows and fails when a Pass line is edited.
- [ ] `--status --json` shows `state`, `joinUrl`, `phone.lastSeen`, per-item `by`, `criteria`, `attempts`, `evidence`; `--wait` returns the final state.
- [ ] `pgrep` after Ctrl-C shows no `vite preview`, `cloudflared`, `reference-server` or Playwright child (as M39e).
- [ ] Tyler's single-scan self-test run is recorded in `device-checks.md`'s header section: wake lock held 6 min, two-origin hop, 20 s drop and recovery.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm device:walk --auto --round demo --only M03 --no-open` · `pnpm device:walk --wait demo --timeout 600` · `pnpm device:walk --status demo --json` · `pnpm test unit -t device-walk` · `pnpm test browser -t walk` · `pnpm lint`

## Budgets
Each new `unit` test under 500 ms p95 and `unit` inside 3 s (ADR 0020 §4); the agent adds under 0.2 ms to a desktop HUD p95; the agent file stays one file, under 600 lines.

## Context artifacts
`.claude/skills/device-round/SKILL.md` rewritten (below); the `device-checks.md` header line; no new `.claude/rules/` file (the hot-path rule is cited in the agent's header comment).

### Tracker integration (the `device-round` skill, rewritten)
- **Start:** `pnpm device:walk --auto --round <name> [--only ...] --no-open`, run in the background by the orchestrator or a sub-agent. It prints the QR and writes `test-results/device-walk/<round>/qr.svg`; the join URL is in `--status --json` (`joinUrl`), so the orchestrator relays the line "scan this" to Tyler. `--manual` is the M39e flow.
- **Wait:** `pnpm device:walk --wait <round> [--timeout s]` blocks until `state` is `done` (exit 0) or `stalled`/timeout (exit 2, prints the state); or poll `--status <round> --json`. `state`: `starting | waiting-for-phone | running | waiting-for-human | paused | done | stalled`; `phone: {connected, lastSeen}`; `current: {id, prompt}`; `humanPending: [ids]` so the orchestrator tells Tyler what is waiting on him without reading the page.
- **Read:** per item `result`, `by`, `attempts` (each with its `criteria` values and limits), `metrics`, `evidence`, `notes`; round-level `env` (UA, Safari version, adapter, screen, cores, isolation) so the **Run on** line needs no typing. Failures: the `criteria` that failed are in the output, then follow *If it fails* in `device-checks.md` as before.
- **Apply:** unchanged (`--apply [--dry-run]`), then `pnpm acceptance:check`.
- **Do not:** treat a proxy-judged hitch as a measured frame time; hand-edit the round log or `test-results/`; start an auto round without Tyler (the phone is needed).

## Manual device checks
One new, run once: the `M39f-selftest` scan (wake lock, two-origin hop, tunnel drop). Every other device check keeps its section in `device-checks.md`.

## Deviations
(filled in during Phase 3)
