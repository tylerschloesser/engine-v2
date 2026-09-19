function tryCall<T>(f: () => T): T | string {
  try {
    return f()
  } catch (e) {
    return 'threw: ' + (e as Error).message
  }
}
self.onmessage = (e: MessageEvent) => {
  if (e.data.type === 'sab') {
    const v = new Int32Array(e.data.sab)
    Atomics.store(v, 1, 42)
    self.postMessage({ type: 'sab-done' })
  }
}
self.postMessage({
  type: 'report',
  crossOriginIsolated: self.crossOriginIsolated,
  sabConstruct: tryCall(() => new SharedArrayBuffer(16).byteLength),
  atomicsWait: tryCall(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)),
})
