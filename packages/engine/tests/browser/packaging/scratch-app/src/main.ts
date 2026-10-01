// The scratch game's page (tarball test). `?host=local` (default) runs the world in this tab: client,
// sim and gen workers. `?host=remote&server=ws://...` joins a server: client, gen and net workers.
// Either way the page dispatches one `Ping`, waits for its verdict and publishes everything the
// test asserts on as `window.__result`.

import wasm from 'virtual:engine/wasm'
import { createClient } from 'engine'
import { PATTERN } from './config.ts'

const query = new URLSearchParams(location.search)
const remote = query.get('host') === 'remote'
const kinds: string[] = []

/** Records the worker kind of each setup message: how the test sees which kinds pattern B built. */
function track(make: () => Worker): () => Worker {
  return () => {
    const worker = make()
    const post = worker.postMessage.bind(worker) as (message: unknown, ...rest: unknown[]) => void
    worker.postMessage = (message: unknown, ...rest: unknown[]) => {
      const m = message as { type?: string; kind?: string }
      if (m.type === 'setup' && m.kind) kinds.push(m.kind)
      post(message, ...rest)
    }
    return worker
  }
}

const response = await fetch(wasm.url)
const contentType = response.headers.get('content-type')
const module = await WebAssembly.compile(await response.arrayBuffer())
const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`)

const client = createClient({
  canvas: document.getElementById('game') as HTMLCanvasElement,
  wasm,
  host: remote
    ? { kind: 'remote', url: query.get('server') ?? '' }
    : {
        kind: 'local',
        world: { worldId: 'scratch', params: { seed: '1', worldgen: null } },
        connect: true,
      },
  genWorkers: 1,
  /*CREATE_WORKER*/
})

// Subscribed before `ready` settles: a link that comes up first would otherwise be missed.
const online = new Promise<void>((resolve) => {
  if (!remote) return resolve()
  client.onLink((e) => {
    ;(window as unknown as { __links: string[] }).__links ??= []
    ;(window as unknown as { __links: string[] }).__links.push(e.state + (e.reason ?? ''))
    if (e.state === 'online') resolve()
  })
})
const stage = (name: string) => {
  ;(window as unknown as { __stage: string }).__stage = name
}
stage('created')
const result: Record<string, unknown> = {
  pattern: PATTERN,
  host: remote ? 'remote' : 'local',
  crossOriginIsolated: window.crossOriginIsolated,
  wasmUrl: wasm.url,
  buildHash: wasm.buildHash,
  contentType,
  imports,
}
try {
  await client.ready
  stage('ready')
  // A page that draws nothing still wakes the client worker once per frame (`createRealFrameLoop`'s
  // `writeCamera` phase); a joined client applies `Welcome` on that wake.
  const frame = () => {
    client.writeCameraAndWake()
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  await online
  const verdict = new Promise<unknown>((resolve) => {
    client.onActionResult((_seq, outcome) => {
      if (outcome !== 'NotPredictable') resolve(outcome)
    })
  })
  stage('dispatching')
  client.dispatch('Ping')
  result.verdict = await verdict
} catch (e) {
  result.error = e instanceof Error ? e.message : String(e)
}
result.kinds = [...new Set(kinds)].sort()
;(window as unknown as { __result: unknown }).__result = result
