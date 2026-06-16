---
name: type-only-import-breaks-visual-cycle
description: "TypeScript `import type` does not create runtime dependencies — use it to break apparent cycles (A↔B) when the relationship is \"B references A's type, A imports B at runtime\". Cleaner than `unknown + as cast`."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 74cbbf78-f572-4505-b8b0-b822b5e0292e
---

When module A produces a value (e.g. `RequestContext`) consumed by module B's event payload type, and B also has runtime code A wants to call, the apparent A↔B cycle is usually only at the type level. `import type { Foo } from "./b"` in `a.ts` does NOT create a runtime require/import; TypeScript erases it.

**Pattern:**
```typescript
// b.ts (downstream observer module)
import type { Foo } from "./a"  // type-only, no runtime cycle
export interface FooEvent { payload: Foo }

// a.ts (upstream producer)
import { emit } from "./b"  // runtime import
const foo: Foo = ...
emit({ payload: foo })
```

**Discovery context (observability rewrite, commit 3b):**
- `lib/context/types.ts` defines `RequestContext`.
- `lib/observability/events.ts` defines `ObservabilityEvent` union; one variant (`request.context_updated`) needs to carry a `RequestContext` reference so HistorySink can read full ctx state.
- Initial cycle fear: `context` imports `observability` (publisher injection), so `observability` importing `context` would loop.
- First draft used `RequestContextLive = unknown` + `event.contextRef as RequestContext` cast at the consumption site. **This is wrong**: it gives up type safety to dodge a non-existent runtime problem.
- Fix: `import type { RequestContext } from "~/lib/context/types"` in events.ts. `tsc` checks resolved cleanly; runtime has no cycle because type imports are erased before code execution. Cast removed.

**How to verify there's no real runtime cycle:**
1. Use `import type` in the "downstream" module.
2. Run `bun run typecheck` — passes? Type layer is fine.
3. Run `bun test` (or actually start the app) — passes? Runtime is fine.
4. If you want belt-and-suspenders: `grep -n "^import " a.ts b.ts` and confirm only `import type` appears in the suspect direction.

**Anti-pattern:** Reaching for `unknown + as X` casts to "avoid circular imports". 90% of those cases are type-only and `import type` solves them.

**Tested 2026-06-14, TypeScript ~5.x, bun 1.3.14.** Documented at https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-8.html#type-only-imports-and-exports.

Related: [[feedback_optimize_long_term_maintainability]], CLAUDE.md 原则9.
