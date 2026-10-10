// `deployed/coi-and-online @slow` (M38, Tests added): the reference game
// built and served from a real deployment (`games/reference-server --static` on Fly, or a static host
// with a `VITE_SERVER_URL` build, ADR 0072), opened in a real browser. Runs only with
// `DEPLOYED_URL=https://<host>`; without it the test is reported as
// skipped by name. In the `packaging` project (after the gc projects), so a slow remote page load never
// shares the machine with the zero-GC controls.
//
// Passes when: the page is cross-origin isolated (COOP/COEP reached the browser), there is a WebGPU
// adapter, the page and its workers loaded with no page error, console error or GPU error, and the
// link reaches `online` (`#k=` is the empty join key of an open server). The first load may wake a stopped machine, so `online` gets 60 s.
import { expect, test } from '@playwright/test'

const deployed = process.env.DEPLOYED_URL

test('deployed/coi-and-online @slow', async ({ page }) => {
  test.skip(!deployed, 'DEPLOYED_URL is not set')
  test.setTimeout(120_000)
  const problems: string[] = []
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    const t = m.text()
    if (m.type() === 'error') problems.push(`console.error: ${t}`)
    if (m.type() === 'warning' && /^GPU (device lost|uncapturederror)/.test(t)) problems.push(t)
  })

  const url = new URL('/', deployed)
  url.hash = 'k='
  const started = Date.now()
  await page.goto(url.href, { waitUntil: 'load' })

  expect(await page.evaluate(() => crossOriginIsolated), 'crossOriginIsolated').toBe(true)
  expect(
    await page.evaluate(async () => (await navigator.gpu?.requestAdapter()) !== null),
    'WebGPU adapter',
  ).toBe(true)

  // The capability screen would replace the page with one line per failure.
  await expect(page.locator('[data-code]')).toHaveCount(0)
  await expect(page.locator('canvas')).toHaveCount(1)
  await expect(page.locator('.link-status[data-state="online"]')).toHaveCount(1, {
    timeout: 60_000,
  })
  console.log(`deployed/coi-and-online: online ${Date.now() - started} ms after navigation`)

  expect(problems).toEqual([])
})
