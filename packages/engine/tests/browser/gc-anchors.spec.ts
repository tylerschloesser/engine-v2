// `anchors` zero-GC page (docs/plan/18-picking-and-overlay.md step 8, Tests added: "Zero-GC: page id
// `anchors` through `zeroGcSuite`; strict pages unchanged. Per ADR 0026, `anchors`' `burst`
// negatives are `@slow` automatically (only `gc-loop` stays fast-tier); its clean test must show
// `presentIsolates` containing every isolate this page names before its verdict check"). Same
// production-topology shape as `gc-input.ts`/`gc-drawables.ts` (real `createClient()`, real WebGPU
// adapter, no `post-message` control).
import { zeroGcSuite } from './gc/suite.ts'

zeroGcSuite({
  pageId: 'anchors',
  path: '/gc-anchors.html',
  expectAdapter: true,
  controlKinds: ['object', 'burst'],
})
