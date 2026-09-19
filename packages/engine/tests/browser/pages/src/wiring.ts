// `wiring.html`'s script: the only page that imports the real `virtual:engine/wasm` (so the public
// path stays tested; other pages load fixtures through `fixture-wasm.ts`). For now it only fetches
// the url and records what a test reads back; M03 extends this with the worker.
import wasm from 'virtual:engine/wasm'

declare global {
  interface Window {
    __wiring?: {
      url: string
      buildHash: string
      contentType: string | null
      crossOriginIsolated: boolean
    }
  }
}

const res = await fetch(wasm.url)
window.__wiring = {
  url: wasm.url,
  buildHash: wasm.buildHash,
  contentType: res.headers.get('content-type'),
  crossOriginIsolated: window.crossOriginIsolated,
}
