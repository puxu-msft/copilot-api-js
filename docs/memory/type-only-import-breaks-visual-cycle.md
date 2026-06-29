---
name: type-only-import-breaks-visual-cycle
description: "TypeScript 的 `import type` 不会创建运行时依赖——当关系是\"B 引用 A 的类型,A 在运行时 import B\"时,用它来打破表面上的循环(A↔B)。比 `unknown + as cast` 更干净。"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 74cbbf78-f572-4505-b8b0-b822b5e0292e
---

当模块 A 产生一个值(如 `RequestContext`),被模块 B 的事件 payload 类型消费,而 B 又有 A 想调用的运行时代码时,表面上的 A↔B 循环通常只存在于类型层面。在 `a.ts` 里写 `import type { Foo } from "./b"` **不会**创建运行时的 require/import;TypeScript 会把它擦除。

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
- `lib/context/types.ts` 定义 `RequestContext`。
- `lib/observability/events.ts` 定义 `ObservabilityEvent` union;其中一个变体(`request.context_updated`)需要携带一个 `RequestContext` 引用,以便 HistorySink 能读取完整的 ctx 状态。
- 最初的循环担忧:`context` import `observability`(publisher 注入),所以 `observability` import `context` 会成环。
- 初稿用了 `RequestContextLive = unknown` + 在消费处做 `event.contextRef as RequestContext` cast。**这是错的**:它为了躲开一个并不存在的运行时问题而放弃了类型安全。
- Fix: 在 events.ts 里写 `import type { RequestContext } from "~/lib/context/types"`。`tsc` 检查干净通过;运行时没有循环,因为类型 import 在代码执行前就被擦除了。Cast 被移除。

**How to verify there's no real runtime cycle:**
1. 在"下游"模块里用 `import type`。
2. 运行 `bun run typecheck`——通过?类型层没问题。
3. 运行 `bun test`(或真的启动 app)——通过?运行时没问题。
4. 如果你想加一道保险:`grep -n "^import " a.ts b.ts`,确认可疑方向上只出现 `import type`。

**Anti-pattern:** 为了"避免循环 import"而去抓 `unknown + as X` cast。这些情况里 90% 都是纯类型的,`import type` 就能解决。

**Tested 2026-06-14, TypeScript ~5.x, bun 1.3.14.** 记录在 https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-8.html#type-only-imports-and-exports。

Related: [[feedback_optimize_long_term_maintainability]]、CLAUDE.md single-source-of-truth-types。
