---
name: hono-onerror-consumes-throws
description: "Hono's server.onError() consumes handler throws BEFORE they propagate back to middleware catch blocks — middleware try/catch is dead code unless you explicitly skip onError"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 74cbbf78-f572-4505-b8b0-b822b5e0292e
---

In a Hono server with `server.onError(...)` registered, the middleware execution model is:

1. Handler throws
2. Hono invokes `onError(err, c)` synchronously
3. onError returns a Response (typically via `forwardError(c, err, ...)`)
4. The throw is converted to that Response — does NOT propagate
5. Middleware's `await next()` resolves normally (no throw)
6. Middleware's `try/catch` around `next()` will NEVER fire

**Implication**: any middleware code that does `try { await next() } catch (err) { ...handle... }` is dead code in a project with `onError` registered. The cleaner pattern:

```typescript
// Trust that next() doesn't throw (onError handles it).
await next()
// Check c.res.status — onError sets it to >= 400 on failure.
if (c.res.status >= 400) { /* error path */ }
```

**Discovery context**: This bit me in `src/lib/observability/middleware.ts` when I wrote a defensive `try/catch + ctx.failIfNotFinalized(err)` block. Subagent caught it — `forwardError(c, ..., 'anthropic'|'openai'|'gemini')` in `server.ts:39` always sets a 4xx/5xx response. The error visibility comes through `c.res.status >= 400` post-`next()`, which I already had.

**When the catch DOES matter:**
- Routes that bypass Hono entirely (custom upgrade handlers, raw WebSocket — `responses/ws.ts`)
- If you ever conditionally `c.onError(null)` or use a different error handler stack
- For stdio / non-HTTP entry points (no Hono in the chain)

For those entry points keep `ctx.failIfNotFinalized()` as a defensive primitive (same reason it's in the RequestContext API surface in this project).

**Tested 2026-06-14 against Hono ~4.x running on Bun 1.3.14.** Behavior is documented at https://hono.dev/api/hono#onerror.

Related: [[feedback-mine-the-pass-with-warn]] (caught this).
