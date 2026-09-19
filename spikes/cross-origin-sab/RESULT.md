# Spike S2: cross-origin isolation + SharedArrayBuffer ring vs postMessage

Run 2026-09-19. Throwaway. Nothing was deployed to any external host.

## Versions

| | |
|---|---|
| Vite | 8.3.0 (rolldown 1.2.9) |
| Playwright | 1.63.0: Chromium 153.0.8010.12 (headless shell), WebKit 26.6, Firefox 155.0 |
| Node / pnpm / Bun | 22.18.0 / 11.25.0 / 1.3.8 (Bun not used) |
| TypeScript | 7.0.2 |
| Machine | Apple M3 Max, macOS 26.6.2 |

## 1. Cross-origin isolation in a Vite app: PROVEN (dev and preview, 3 engines)

Minimal config. Nothing else is needed; `server.headers` / `preview.headers` apply to every response, including worker scripts:

```ts
import { defineConfig } from 'vite'
const coi = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}
export default defineConfig({
  server: { headers: coi },
  preview: { headers: coi },
  worker: { format: 'es' }, // module worker in the build; not an isolation requirement
})
```

Matrix actually run (`scripts/isolation.mjs`, raw output in `results-isolation.json`): {`vite dev`, `vite build` + `vite preview`} x 4 header modes x 3 engines = 24 cells. Page on `http://localhost`, cross-origin assets on `http://127.0.0.1:5999` (cross-site). Dev and preview gave identical results in every cell.

| Mode | Chromium | WebKit | Firefox |
|---|---|---|---|
| `require-corp` | isolated; SAB on main + module worker; `Atomics.wait` in worker; SAB round trip main->worker->main ok | same | same |
| `credentialless` | isolated, all ok | **NOT isolated**: `crossOriginIsolated === false`, `SharedArrayBuffer` undefined on main and in worker | isolated, all ok |
| no headers | not isolated, `SharedArrayBuffer` undefined | same | same |
| `require-corp` on HTML responses only | main isolated, **module worker fails to load** (bare `error` event, empty message) | same | same |

- The last row settles the "unverified detail" in research section 1.4: the worker script response must carry COEP too. All three engines refuse the worker. Host config must therefore match every path, not only `index.html`. The failure is unhelpful (an `error` event with no message), so the engine should turn it into a readable error.
- The build emits `new Worker(new URL('/assets/bench-worker-<hash>.js', import.meta.url), { type: 'module' })`; verified in `dist/`.

What breaks under `require-corp` (identical in all three engines):

| Cross-origin request | `require-corp` | `credentialless` (Chromium, Firefox) |
|---|---|---|
| `<img>` with no CORP/CORS headers, no `crossorigin` attr | blocked | loads |
| `<img>` with `Cross-Origin-Resource-Policy: cross-origin` | loads | loads |
| `<img crossorigin>` with `Access-Control-Allow-Origin: *` | loads | loads |
| `<img crossorigin>` with no CORS headers | blocked (plain CORS failure, unrelated to COEP) | blocked |
| `fetch(url, { mode: 'no-cors' })`, no headers | rejects | resolves (opaque) |

Not tested: fonts (always CORS-fetched, so they need ACAO regardless), cross-origin iframes, popups / `window.opener`, cookie stripping under `credentialless`.

Conclusion: `require-corp` is the only value that isolates all three engines. WebKit 26.6 silently ignores `credentialless`.

## 2. SPSC ring over SAB: WORKS in all three engines

`src/ring.ts`, `src/bench.ts`, `src/bench-worker.ts`. 256 slots x 1024 B; `Int32Array` control block (head, tail, drops) with `Atomics.load/store`; one preallocated `Uint8Array` per slot; main drains once per `requestAnimationFrame` with `wasmU8.set(slotView, off)` into a real non-shared `WebAssembly.Memory`. Worker pushes 10 slots per 16 ms `setInterval` tick (about 10 KB per tick). Every message carries a sequence number that is checked after the copy.

Functional run, 5 s per cell (`scripts/ring-engines.mjs`, `ring-engines.log`): 0 sequence errors and 0 ring drops in all 15 cells (5 variants x 3 engines). `Atomics.waitAsync` exists and works in all three. Message rates differ by engine because worker timers differ (Chromium ~624/s, WebKit ~530/s, Firefox ~520/s); headless Firefox ran rAF at ~120 Hz, the others ~60 Hz.

Only worker -> main was built. Main -> worker was not tested.

## 3. Main-thread JS heap, headless Chromium: claim HOLDS, with two qualifications

Method (`scripts/gc.mjs`): production build on `vite preview`, `--js-flags=--expose-gc`, 8 s warm-up, forced GC, then a 10 s window (~600 frames) during which the page is not evaluated. Pass A: `Runtime.getHeapUsage` before/after, polled every 500 ms, plus a trace (`v8`, `v8.gc`, `devtools.timeline`) with GC events bucketed by thread name so worker-isolate GCs are not counted as main. Pass B (separate page load): `HeapProfiler.startSampling` at a 64 B interval including already-collected objects, which attributes allocations to functions.

Every variant was run **twice**; both runs are shown (except `timer`, added afterwards and run once: `results-gc-timer.json`). Data: `results-gc.json`, `gc-run.log`. An earlier 4 s smoke run of `sab` and `garbage` is not included.

| Variant | Frames | Msgs | Heap growth (B) | Main GCs (minor / major) | Sampled bytes allocated | Notes |
|---|---|---|---|---|---|---|
| `none` (no loop, no worker) | 0 | 0 | 0 / 0 | 0 / 0 | 0 / 0 | noise floor is zero |
| `timer` (setInterval counter)* | 628 | 0 | 0 | 0 | 84 | *one run only |
| `raf` (empty rAF loop) | 603 / 602 | 0 | 7,288 / 8,076 | 0 / 0 | 8,364 / 7,544 | 12-13 B/frame |
| **`sab`** (ring polled per rAF) | 604 / 603 | 6,290 / 6,280 | 8,072 / 8,108 | **0 / 0** | 6,896 / 7,248 | 13.4 B/frame, same as `raf` |
| `waitasync` (no rAF) | 630 / 629 wakes | 6,300 / 6,290 | 95,760 / 95,456 | 0 / 0 | 96,340 / 99,052 | ~152 B per wake |
| `pm-object` | 603 / 605 | 6,280 / 6,300 | 691,928 / 672,112 | 1 minor | 1.13 MB / 1.14 MB | ~180 B per message |
| `pm-transfer` (fresh 1 KB buffer) | 605 / 605 | 6,310 / 6,310 | 447,144 / 450,680 | 2 minor + **1 major** (+ incremental marking) | 1.72 MB / 1.73 MB | ~273 B per message |
| `pm-transfer-pool` (main transfers buffer back) | 607 / 603 | 6,320 / 6,290 | 541,816 / 544,752 | 3 minor | 2.05 MB / 2.04 MB | ~325 B per message |
| `garbage` (positive control, ~100 KB/frame) | 605 / 602 | 0 | n/a | 103 / 102 minor | 90 MB | proves the detector sees main-thread GCs |

0 sequence errors and 0 ring drops in every row.

How to read this:

- For the postMessage rows, **use the sampled column, not heap growth**: GCs ran inside the window, so growth understates what was allocated.
- **The rAF loop itself allocates ~12 B/frame.** An empty rAF loop and the SAB ring loop are indistinguishable, and the sampler attributes the bytes to native code, not to any JS function. A `setInterval` loop doing the same counter work allocates 0. My reading is that this is the `DOMHighResTimeStamp` argument boxed as a HeapNumber (12 B with pointer compression). That is an inference that fits the numbers; I did not confirm it in V8. At ~720 B/s it would take on the order of tens of minutes to fill new space, and no scavenge was observed in any window.
- **The ring drain is not exactly zero.** In the 60 s runs below the sampler attributes 2,276 and 2,560 B to the drain function, versus 168 B for the empty rAF callback: under 1 B/frame, present in both long runs, cause not diagnosed. In the 10 s runs it appears as a single 84 B sample.
- **`Atomics.waitAsync` allocates ~152 B per wake** (result object + promise + reaction). No GC in 10 s, but it is ~12x the rAF cost. Polling at frame boundaries is the cheaper option, as the research doc assumed.
- **A transferable pool does not help the receiver.** It allocated more on main than fresh buffers did (each message still creates a `MessageEvent`, an `ArrayBuffer` wrapper and a view, and the return `postMessage` adds its own), and it raised worker GCs from 2 to 4. It did avoid the major GC that `pm-transfer` triggered.
- Scale: postMessage costs 1-3 scavenges per 10 s at ~630 msgs/s on main. That is measurable garbage, not a catastrophe. The `pm-transfer` major GC is the more notable cost.

### 60 s window (`sab` and `raf` only)

This was attempted **twice**. Attempt 1 (`gc-60s-attempt1-crashed.log`): `sab` completed, then the `raf` pass died mid-window with `Target page, context or browser has been closed` on a heap poll. I did not diagnose it; nothing in the script closes the page there. No JSON was saved because the script then wrote results only at the end (since fixed: it now writes after every row). Attempt 2 (`results-gc-60s.json`) completed both.

| Variant | Attempt | Frames | Msgs | Heap growth | B/frame | Main GCs |
|---|---|---|---|---|---|---|
| `sab` | 1 | 3,615 | 37,660 | 45,364 | 12.5 | 0 |
| `raf` | 1 | crashed | | | | |
| `raf` | 2 | 3,622 | 0 | 43,212 | 11.9 | 0 |
| `sab` | 2 | 3,621 | 37,720 | 46,368 | 12.8 | 0 |

So over 60 s and ~37 k messages (~37 MB copied) the ring produced zero GC events in both attempts, and its heap growth exceeds the empty-rAF baseline by ~3 KB total.

### Limits of this measurement

- Chromium only. **WebKit and Firefox heap behaviour was not measured**; S2's "no obvious allocation in WebKit" is still open. Only functional correctness was checked there.
- Headless shell on a fast desktop; no mobile device.
- The "heap decreased between polls" signal is weak (it read 0 for the `garbage` control despite ~100 scavenges); the trace events are the GC evidence.
- One harness crash of unknown cause in ~45 benchmark page loads (above).
- Message shape was 10 x 1 KB per tick. Other sizes and a single 10 KB message were not tried.
- S2 item 5 (`queue.writeBuffer` from `WebAssembly.Memory.buffer`) was not attempted.
- S2 item 1's "one real static host" was **not done** (no deploys allowed). Section 4 is from docs only.

## 4. Host configuration (from docs, NOT deployed or verified)

All must match every path, because worker scripts need COEP too (section 1).

**Vercel**, `vercel.json` (docs state this applies to static files and functions). https://vercel.com/docs/project-configuration/vercel-json
```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
      ]
    }
  ]
}
```

**Netlify**, `_headers` in the publish directory (for Vite: put it in `public/`) or `netlify.toml`. Applies only to files served from Netlify's own store, not to proxied content, functions or edge functions; cannot be scoped per branch/deploy context. https://docs.netlify.com/manage/routing/headers/
```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```
```toml
[[headers]]
  for = "/*"
  [headers.values]
    Cross-Origin-Opener-Policy = "same-origin"
    Cross-Origin-Embedder-Policy = "require-corp"
```

**Cloudflare Pages**, `_headers` in the build output (Vite: `public/_headers`), same syntax as the Netlify block above. Max 100 rules, 2,000 chars per line, and "not applied to responses generated by Pages Functions". Workers static assets support the same file with the same caveat for Worker-generated responses. https://developers.cloudflare.com/pages/configuration/headers/ , https://developers.cloudflare.com/workers/static-assets/headers/

**GitHub Pages** cannot set response headers. The official limits page does not mention custom headers at all (https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits); the gap is tracked in https://github.com/orgs/community/discussions/13309 . Workaround: `coi-serviceworker` (https://github.com/gzuidhof/coi-serviceworker), a service worker that re-serves responses with COOP/COEP. Drawbacks per its README: it reloads the page on first visit; it must be a separate, un-bundled file served from your own origin (no CDN); it needs HTTPS or localhost. Beyond the README, and not tested here: it depends on service workers being available, and it puts a service worker in front of every request. Not run in this spike.

## 5. Re-run

```sh
cd spikes/cross-origin-sab
pnpm install
npx playwright install chromium webkit firefox
node scripts/isolation.mjs      # section 1 matrix (~2 min), needs ports 5173, 4173, 5999
node scripts/ring-engines.mjs   # section 2 (~1.5 min)
RUNS=2 node scripts/gc.mjs      # section 3 (~12 min)
VARIANTS=raf,sab WINDOW_MS=60000 OUT=results-gc-60s.json node scripts/gc.mjs
# manual: COEP=credentialless pnpm dev   (env knobs are documented in vite.config.ts)
```
