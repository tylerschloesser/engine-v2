// The title of a generated negative-control test, and with it its `@slow` tier tag (0026 §1, amended
// by 0043 §1). Pure, so `titles.test.ts` can list the tags a `zeroGcSuite` call would produce
// without a browser: `suite.ts` computes nothing about tiers itself.

/** `burst` is `@slow` for every page but `gc-loop` (whose fast burst controls prove both
 * instruments live on every `pnpm test`); `object` stays fast, except a worker isolate's when the
 * page opts in with `slowWorkerObjectControls` (`reference_single_player`). */
export function negControlTitle(
  pageId: string,
  kind: 'object' | 'burst',
  isolate: string,
  slowWorkerObjectControls = false,
): string {
  const slow =
    (kind === 'burst' && pageId !== 'gc-loop') ||
    (kind === 'object' && slowWorkerObjectControls && isolate !== 'main')
  return `${pageId} neg ${kind} ${isolate}${slow ? ' @slow' : ''}`
}
