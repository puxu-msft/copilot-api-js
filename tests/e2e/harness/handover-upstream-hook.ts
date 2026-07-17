/**
 * Upstream hook for the graceful-restart handover e2e (tests/e2e/handover.e2e.test.ts):
 * every exchange is answered locally (no real GHC call) so the test doesn't burn quota
 * and runs deterministically. A request whose body contains the literal substring
 * `SLOWMARKER` sleeps `1500` ms before responding — that's the "in-flight slow request"
 * the test holds open across the handover window (old process must finish draining it,
 * not get interrupted by the new process's takeover).
 *
 * The response text embeds `process.pid` so the test can tell WHICH process (old vs
 * new) actually served a given request — the core "new connections go to the new
 * process" oracle.
 *
 * Loaded via config `hooks.upstream_module` + `enabled: true` + `POST /api/hooks/reload`
 * (see skill `upstream-hook-mocking`).
 *
 * `export const hooks = { exchange }` — the four-point hook surface (RFC
 * 2026-07-14-symmetric-four-point-hooks; migrated from the pre-RFC `export const
 * onExchange` this file used to export — see `src/lib/pipeline/hooks/loader.ts`'s
 * `HOOK_POINTS`). `exchange`'s signature/return shape (`(wire, env, next) =>
 * Promise<UpstreamStream>`, `UpstreamStream = {frames, headers}`) is UNCHANGED from the
 * old `onExchange` — verified against `src/lib/pipeline/hooks/types.ts` and by feeding
 * this hook through `loadUpstreamHook` + invoking the returned `exchange` directly
 * (empirically confirms the mock genuinely short-circuits: the `next` callback, which
 * would forward to the real transport, is never called).
 *
 * Since RFC landing, `loadUpstreamHook` compiles hook source to a REAL project-internal
 * file (`.hooks-cache/`) rather than a `data:` URL import — so, unlike this file's
 * pre-RFC version, the Bun.Transpiler data-URL dot-access-drops-named-exports bug no
 * longer applies (empirically reverified: this file uses normal dot access throughout,
 * loads fine) AND the `~/lib/pipeline/hooks` toolkit alias now resolves, so this hook
 * uses the shared `mockAnthropicMessage` builder instead of hand-rolled base64 SSE
 * frames (which the pre-RFC data-URL loader's import-free constraint used to force).
 */
import { mockAnthropicMessage } from "~/lib/pipeline/hooks"

export const hooks = {
  exchange: async (wire: { body?: unknown }) => {
    const bodyStr = JSON.stringify(wire.body)
    const isSlow = bodyStr.includes("SLOWMARKER")
    if (isSlow) {
      // Held open across the handover window — long enough that the test's spawned
      // "new" process has definitely bound + signaled by the time this resolves,
      // short enough the test doesn't drag (empirically ~1.5s is comfortably above
      // reusePort-bind + SIGUSR2 delivery latency).
      await Bun.sleep(1500)
    }
    const marker = "served-by-pid-" + String(process.pid)
    return mockAnthropicMessage(marker)
  },
}
