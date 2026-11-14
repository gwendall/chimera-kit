/** Compiled-module identity survives in the caller; Workers receive the verified ID alongside it. */
import { readBytes, type Source } from "./chimera.js";

const identities = new WeakMap<WebAssembly.Module, string>();
export const performanceEngineId = (module: WebAssembly.Module): string | undefined => identities.get(module);
export async function compilePerformance(wasm?: Source): Promise<WebAssembly.Module> {
  const bytes = await readBytes(wasm ?? new URL("./chimera.wasm", import.meta.url));
  const [module, hash] = await Promise.all([
    WebAssembly.compile(bytes as BufferSource),
    crypto.subtle.digest("SHA-256", bytes as BufferSource),
  ]);
  identities.set(module, Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join(""));
  return module;
}
