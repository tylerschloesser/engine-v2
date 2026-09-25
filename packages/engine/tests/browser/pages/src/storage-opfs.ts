// `storage-opfs.html`: `storage_conformance_opfs` (docs/plan/23-persistence-opfs-and-lifecycle.md
// step 2, Tests added) plus the pending-async hook test (Seams for step 3, "test it at the adapter
// level"). All real work happens in `storage-opfs-worker.ts`, a dedicated worker -- every browser
// this milestone probed only has working OPFS from inside one (step 1, Deviations).
declare global {
  interface Window {
    __storageOpfs?: unknown
    __pageReady?: true
  }
}

const worker = new Worker(new URL('./storage-opfs-worker.js', import.meta.url), { type: 'module' })
const done = new Promise((resolve) => {
  worker.onmessage = (ev: MessageEvent) => resolve(ev.data)
})
window.__storageOpfs = await done
window.__pageReady = true
