import consola from "consola"
import { readFileSync } from "node:fs"

import type {
  //
  UpstreamHook,
  UpstreamHookState,
} from "./types"

let hookState: UpstreamHookState | undefined

export function getUpstreamHook(): UpstreamHook | undefined {
  return hookState?.hook
}

export function getUpstreamHookState(): UpstreamHookState | undefined {
  return hookState
}

export function resetUpstreamHook(): void {
  hookState = undefined
}

const HOOK_POINTS = ["onRequest", "onExchange", "rewriteUpstreamFrame"] as const

/** Load (or reload) the hook module via data-URL (bypasses Bun's path-keyed ESM cache). */
export async function loadUpstreamHook(modulePath: string): Promise<UpstreamHookState> {
  const src = readFileSync(modulePath, "utf8")
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(src)
  const mod = (await import("data:text/javascript," + encodeURIComponent(js))) as Record<string, unknown>
  const exports = HOOK_POINTS.filter((k) => typeof mod[k] === "function")
  if (exports.length === 0) {
    throw new Error(`hook module ${modulePath} exports none of: ${HOOK_POINTS.join(", ")}`)
  }
  const hook: UpstreamHook = {}
  for (const k of exports) (hook as Record<string, unknown>)[k] = mod[k]
  const loadedAt = Date.now()
  hookState = {
    hook,
    module: modulePath,
    loadedAt,
    version: String(loadedAt),
    exports: [...exports],
  }
  return hookState
}

/**
 * Warn-continue wrapper around {@link loadUpstreamHook}: load/validation failures never throw
 * to the caller (and never crash the process). On failure, the previous hook state is kept in
 * place and `lastReloadError` is recorded on it; on success, the freshly-built state naturally
 * has no `lastReloadError`.
 */
export async function loadUpstreamHookSafe(modulePath: string): Promise<{ ok: true; state: UpstreamHookState } | { ok: false; error: string }> {
  try {
    const state = await loadUpstreamHook(modulePath)
    return { ok: true, state }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    consola.warn(`[hooks] failed to load ${modulePath}: ${error} — keeping previous hook`)
    if (hookState) hookState.lastReloadError = error
    return { ok: false, error }
  }
}
