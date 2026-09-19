// Types only; erased at compile time so client.js and worker.js stay import-free.
export type ToWorker =
  | { type: 'init'; module?: WebAssembly.Module; wasmUrl?: string; seed: number }
  | { type: 'add'; id: number; a: number; b: number }
  | { type: 'tick'; id: number; n: number }

export type FromWorker =
  | { type: 'ready'; abiVersion: number; exports: string[]; how: 'module' | 'streaming' }
  | { type: 'result'; id: number; value: number }
  | { type: 'log'; level: number; msg: string }
  | { type: 'panic'; msg: string }
  | { type: 'error'; msg: string }
