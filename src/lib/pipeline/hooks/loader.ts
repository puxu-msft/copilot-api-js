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

/**
 * Leaf mount-point paths (dot-separated), mirroring the nested {@link UpstreamHook} shape
 * (RFC 2026-07-14-symmetric-four-point-hooks §3). A hook module exports `export const hooks =
 * { upstream: { inbound, outbound }, exchange, ... }`; the loader navigates each leaf path and
 * collects the ones that are functions. `client.inbound` lands in RFC Phase 4.
 */
const HOOK_POINTS = ["client.inbound", "upstream.inbound", "upstream.outbound", "exchange"] as const

/** Read a dot-path leaf off a nested object (returns undefined if any segment is missing/non-object). */
function getLeaf(root: unknown, path: string): unknown {
  let cur: unknown = root
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** Set a dot-path leaf on a nested object, creating intermediate objects as needed. */
function setLeaf(root: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split(".")
  let cur = root
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]
    if (typeof cur[seg] !== "object" || cur[seg] === null) cur[seg] = {}
    cur = cur[seg] as Record<string, unknown>
  }
  cur[segs.at(-1) as string] = value
}

/** Enumerate the leaf paths of a hook object that carry a function (for `exports`). */
function presentLeaves(hook: UpstreamHook): Array<string> {
  return HOOK_POINTS.filter((p) => typeof getLeaf(hook, p) === "function")
}

/**
 * Test-only DI seam: install an arbitrary {@link UpstreamHook} directly (bypassing the
 * file-loading path) so driver hook-mount-point tests can mount closures that count
 * calls / mutate captured test state, which a real on-disk module (loaded via a
 * data-URL import) cannot express. Production code never calls this — only
 * `loadUpstreamHook`/`loadUpstreamHookSafe` populate `hookState` at runtime.
 */
export function setUpstreamHookForTests(hook: UpstreamHook | undefined): void {
  hookState = hook && { hook, module: "<test>", loadedAt: 0, version: "test", exports: presentLeaves(hook) }
}

// Monotonic counter backing `version` below. `Date.now()` alone is NOT sufficient to satisfy the
// "changes on every successful reload" contract (see the `version` field's openapi description in
// `src/routes/hooks/route.ts`): two reloads landing within the same millisecond would otherwise
// produce an identical `String(loadedAt)` version, silently breaking any caller that polls
// `version` to detect a fresh reload. This counter is bumped on every successful load, regardless
// of wall-clock resolution, so `version` is always unique and strictly increasing.
let loadSeq = 0

/**
 * Load (or reload) the hook module via data-URL (bypasses Bun's path-keyed ESM cache).
 * The module exports `export const hooks = { ... }` (nested, RFC §3/§4.1); the loader navigates
 * each {@link HOOK_POINTS} leaf path off `mod.hooks` and assembles the nested {@link UpstreamHook}.
 */
export async function loadUpstreamHook(modulePath: string): Promise<UpstreamHookState> {
  const src = readFileSync(modulePath, "utf8")
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(src)
  const mod = (await import("data:text/javascript," + encodeURIComponent(js))) as Record<string, unknown>
  const hooksRoot = mod.hooks
  const exports = HOOK_POINTS.filter((p) => typeof getLeaf(hooksRoot, p) === "function")
  if (exports.length === 0) {
    throw new Error(`hook module ${modulePath} exports none of: ${HOOK_POINTS.join(", ")} (via \`export const hooks = { ... }\`)`)
  }
  const hook: Record<string, unknown> = {}
  for (const p of exports) setLeaf(hook, p, getLeaf(hooksRoot, p))
  const loadedAt = Date.now()
  hookState = {
    hook: hook as UpstreamHook,
    module: modulePath,
    loadedAt,
    version: `${loadedAt}-${++loadSeq}`,
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
