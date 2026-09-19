// What a page for any fixture other than `hash` loads through, since one plugin instance serves one
// crate (docs/plan/02b-vite-plugin.md, "One plugin instance = one crate"). Shaped exactly like
// `virtual:engine/wasm`'s `EngineWasm` so a page cannot tell the two apart.
import type { EngineWasm } from 'virtual:engine/wasm'

export async function fixtureWasm(name: string): Promise<EngineWasm> {
  const res = await fetch(`/fixtures/${name}/game.json`)
  if (!res.ok) throw new Error(`fixtureWasm(${name}): /fixtures/${name}/game.json: ${res.status}`)
  const json = (await res.json()) as { buildHash: string }
  return { url: `/fixtures/${name}/game.wasm`, buildHash: json.buildHash }
}
