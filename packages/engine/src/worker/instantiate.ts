// Shared WASM setup for every kind that has an instance (`client`, `sim`, `gen`; not `net`):
// docs/plan/06b-workers-and-spawn.md, Scope ("WASM kinds instantiate, call `engine_init(role)`,
// reserve their arena, build views once") and Planning decisions ("Posted `Module` first, URL as
// fallback"). Publishes `W_MEM_PAGES`/`W_MEM_GROWS` into the control block so main can read them by
// polling shared memory, never a message (0015 §2: main never blocks).
import type { Role } from '../abi.js'
import { type EngineInstance, instantiate } from '../loader.js'
import { W_MEM_GROWS, W_MEM_PAGES, workerWord } from '../sab/control.js'
import type { SetupMessage } from './protocol.js'
import type { Shell } from './shell.js'

const WASM_PAGE_BYTES = 65536

export async function instantiateForSetup(
  shell: Shell,
  message: SetupMessage,
  role: Role,
): Promise<EngineInstance> {
  const module = message.module ?? (await WebAssembly.compileStreaming(fetch(wasmUrl(message))))
  const inst = instantiate(module, role, message.config)
  publishMemory(shell, inst)
  inst.onViewsRebuilt(() => publishMemory(shell, inst))
  return inst
}

function wasmUrl(message: SetupMessage): string {
  if (!message.wasmUrl) {
    throw new Error('instantiateForSetup: setup message carried neither module nor wasmUrl')
  }
  return message.wasmUrl
}

function publishMemory(shell: Shell, inst: EngineInstance): void {
  const { control, index } = shell
  Atomics.store(control.words, workerWord(index, W_MEM_PAGES), inst.memoryBytes() / WASM_PAGE_BYTES)
  Atomics.store(control.words, workerWord(index, W_MEM_GROWS), inst.memGrows())
}
