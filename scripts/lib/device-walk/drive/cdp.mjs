// Raw Chrome DevTools Protocol over a WebSocket (Node's global `WebSocket`), no Playwright: Playwright's
// `connectOverCDP` makes a backgrounded page report `visible` (spikes/device-driver-android/RESULT.md §6), and
// the driver must see the truth. One short-lived connection per call group: nothing stays attached to a page
// while it is being measured.

/** Connect to a page target's `webSocketDebuggerUrl`. */
export async function cdpConnect(wsUrl, { timeoutMs = 15_000 } = {}) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`CDP connect timed out: ${wsUrl}`)), timeoutMs)
    ws.onopen = () => {
      clearTimeout(t)
      resolve()
    }
    ws.onerror = () => {
      clearTimeout(t)
      reject(new Error(`CDP connect failed: ${wsUrl}`))
    }
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d)
      pending.delete(d.id)
    }
  }
  const send = (method, params = {}, ms = timeoutMs) =>
    new Promise((resolve, reject) => {
      const i = ++id
      const t = setTimeout(() => {
        pending.delete(i)
        reject(new Error(`CDP ${method} timed out after ${ms} ms`))
      }, ms)
      pending.set(i, (d) => {
        clearTimeout(t)
        if (d.error) reject(new Error(`CDP ${method}: ${JSON.stringify(d.error)}`))
        else resolve(d.result)
      })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  /** `Runtime.evaluate` by value, awaiting a promise; a page exception throws. */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails)
      throw new Error(
        `page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
      )
    return r.result.value
  }
  return { send, evaluate, close: () => ws.close() }
}
