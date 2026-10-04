// The Mac's own browsers for the rows that are the Mac's (M39f step 14): the service opens a tab itself.
// `open -a Safari|Firefox <url>` (macOS) loads the loopback URL of the runner page with the run token and a
// `mac-` tab id; the agent in that tab walks the same step machine as a phone does. `DEVICE_WALK_OPEN`
// replaces the command (the demonstration and the tests drive a Playwright page instead): it is run as
// `<command> <browser> <url>` through the shell, detached.
import { spawn } from 'node:child_process'

export const MAC_BROWSERS = { safari: 'Safari', firefox: 'Firefox' }

/** The argv `open` is run with for `browser` (`safari` or `firefox`) at `url`. */
export function openArgs(browser, url) {
  const app = MAC_BROWSERS[browser]
  if (!app) throw new Error(`no Mac browser "${browser}" (safari or firefox)`)
  return ['-a', app, url]
}

/**
 * Open `url` in `browser`. Resolves with `{ command }`; never throws for a missing browser (the service
 * logs it and the row stays open for the person to open the URL by hand).
 */
export function openMacBrowser(
  browser,
  url,
  { log = () => {}, env = process.env, run = spawn } = {},
) {
  try {
    if (env.DEVICE_WALK_OPEN) {
      const child = run(`${env.DEVICE_WALK_OPEN} ${browser} '${url}'`, [], {
        shell: true,
        stdio: 'ignore',
        detached: true,
      })
      child.unref?.()
      return { command: env.DEVICE_WALK_OPEN }
    }
    const child = run('open', openArgs(browser, url), { stdio: 'ignore', detached: true })
    child.on?.('error', (e) => log(`could not open ${browser}: ${e.message}; open ${url} yourself`))
    child.unref?.()
    return { command: 'open' }
  } catch (e) {
    log(`could not open ${browser}: ${e.message}; open ${url} yourself`)
    return { command: null }
  }
}
