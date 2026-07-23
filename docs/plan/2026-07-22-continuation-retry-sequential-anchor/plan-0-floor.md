# Plan-0: 机制地基（纯新增、默认行为逐字不变）

> P0 只**新增**接口/配置/分类，不动提交点、不翻默认，行为逐字不变（golden 回放等价）。定义 P1-P7 共用契约。

**Files:**
- Create: `src/lib/pipeline/committed-blocks-ledger.ts`（+ test `tests/pipeline/committed-blocks-ledger.unit.test.ts`）
- Create: `src/lib/pipeline/continuation-request-builder.ts`（接口 + 空注册，per-format 实现在 P3-P6）
- Modify: `src/lib/config/schema.ts`（+ `buffered_retry.continuation` 子块）、`config.yaml`、`src/lib/config/state.ts`（CONFIG_MANAGED_DEFAULTS 三处）
- Modify: `src/lib/anthropic/protect-streaming-stats.ts`（+ `continuation-exhausted` outcome + 双计数字段）

**Interfaces:**
- Produces:
  - `CanonicalBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown }`
  - `CommittedBlocksLedger = { snapshot(): CanonicalBlock[]; recordCommitted(b: CanonicalBlock): void }`（无 reset-清空方法——跨 attempt 累积）
  - `ContinuationRequestBuilder = (original: RequestEnvelope, committed: CanonicalBlock[], message: string) => UpstreamRequest`
  - config `state.bufferedRetryContinuation: { enabled: boolean; message: string }`
  - outcome union += `"continuation-exhausted"`

---

### Task 0.1: committed-blocks-ledger

- [ ] **Step 1: 写失败测试**

```ts
// tests/pipeline/committed-blocks-ledger.unit.test.ts
import { expect, test } from "bun:test"
import { createCommittedBlocksLedger } from "~/lib/pipeline/committed-blocks-ledger"

test("records committed blocks in order, snapshot returns copy", () => {
  const l = createCommittedBlocksLedger()
  l.recordCommitted({ type: "text", text: "Hello " })
  l.recordCommitted({ type: "tool_use", id: "t1", name: "Write", input: { path: "/x" } })
  expect(l.snapshot()).toEqual([
    { type: "text", text: "Hello " },
    { type: "tool_use", id: "t1", name: "Write", input: { path: "/x" } },
  ])
})

test("snapshot is a copy — mutating it does not affect ledger", () => {
  const l = createCommittedBlocksLedger()
  l.recordCommitted({ type: "text", text: "a" })
  l.snapshot().push({ type: "text", text: "leak" })
  expect(l.snapshot()).toHaveLength(1)
})
```

- [ ] **Step 2: 跑，验证失败**

Run: `bun test tests/pipeline/committed-blocks-ledger.unit.test.ts`
Expected: FAIL（`createCommittedBlocksLedger` 未定义）。

- [ ] **Step 3: 最小实现**

```ts
// src/lib/pipeline/committed-blocks-ledger.ts
export type CanonicalBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }

export interface CommittedBlocksLedger {
  recordCommitted: (block: CanonicalBlock) => void
  snapshot: () => Array<CanonicalBlock>
}

export function createCommittedBlocksLedger(): CommittedBlocksLedger {
  const blocks: Array<CanonicalBlock> = []
  return {
    recordCommitted: (block) => void blocks.push(block),
    snapshot: () => blocks.map((b) => ({ ...b })),
  }
}
```

- [ ] **Step 4: 跑，验证通过**

Run: `bun test tests/pipeline/committed-blocks-ledger.unit.test.ts` → PASS。

- [ ] **Step 5: 提交**

```bash
git add -- src/lib/pipeline/committed-blocks-ledger.ts tests/pipeline/committed-blocks-ledger.unit.test.ts
git commit -m "feat(pipeline): committed-blocks ledger for continuation retry"
```

---

### Task 0.2: continuation-request-builder 接口 + 注册

- [ ] **Step 1: 写失败测试**（接口存在 + 未注册格式抛错）

```ts
// tests/pipeline/continuation-request-builder.unit.test.ts
import { expect, test } from "bun:test"
import { getContinuationBuilder, registerContinuationBuilder } from "~/lib/pipeline/continuation-request-builder"

test("unregistered format returns undefined (caller degrades to partial-degrade)", () => {
  expect(getContinuationBuilder("gemini")).toBeUndefined()
})

test("registered builder is retrievable", () => {
  const b = (orig, committed, msg) => ({ marker: committed.length, msg }) as any
  registerContinuationBuilder("test-fmt" as any, b)
  expect(getContinuationBuilder("test-fmt" as any)).toBe(b)
})
```

- [ ] **Step 2: 跑，失败** → `bun test tests/pipeline/continuation-request-builder.unit.test.ts` FAIL。

- [ ] **Step 3: 实现接口 + registry**

```ts
// src/lib/pipeline/continuation-request-builder.ts
import type { CanonicalBlock } from "./committed-blocks-ledger"

export type ClientFormat = "anthropic" | "openai-cc" | "openai-responses" | "gemini"
export type ContinuationRequestBuilder = (
  original: unknown, // RequestEnvelope — 精确类型 P3 接线时收紧
  committed: Array<CanonicalBlock>,
  message: string,
) => unknown // UpstreamRequest

const REGISTRY = new Map<ClientFormat, ContinuationRequestBuilder>()
export function registerContinuationBuilder(fmt: ClientFormat, b: ContinuationRequestBuilder): void {
  REGISTRY.set(fmt, b)
}
export function getContinuationBuilder(fmt: ClientFormat): ContinuationRequestBuilder | undefined {
  return REGISTRY.get(fmt)
}
```

- [ ] **Step 4: 跑，通过** → PASS。
- [ ] **Step 5: 提交** → `git commit -m "feat(pipeline): continuation-request-builder registry (interface only)"`。

---

### Task 0.3: 配置 continuation 子块

- [ ] **Step 1: 写失败测试**（config 解析 + 默认值 + per-vendor 覆盖）

```ts
// tests/config/continuation-config.unit.test.ts —— 用 test-isolation useIsolatedRuntime
test("buffered_retry.continuation defaults: enabled true, message default", () => {
  // 解析空配置 → state.bufferedRetryContinuation.enabled === true
  //                 state.bufferedRetryContinuation.message === "network issue. please continue"
})
test("per-vendor override anthropic.buffered_retry.continuation.message wins", () => { /* ... */ })
```

- [ ] **Step 2: 跑，失败。**

- [ ] **Step 3: 加 schema + 默认 + state 传播**

`schema.ts` 的 `BufferedRetryOverrideSchema`（或共享 `buffered_retry`）加：
```ts
continuation: nullableSection(z.object({
  enabled: z.boolean().optional(),
  message: z.string().optional(),
})).optional(),
```
`config.yaml` 注释 + 默认块;`state.ts` CONFIG_MANAGED_DEFAULTS 三处（grep `heartbeat_sec` 定位同组）加 `bufferedRetryContinuation`，默认 `{ enabled: true, message: "network issue. please continue" }`;解析优先级 per-vendor > 共享 > 默认（复用现有 `resolveBufferedCaps` 模式）。

- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `git commit -m "feat(config): buffered_retry.continuation block (enabled/message)"`。

---

### Task 0.4: outcome 分类 + telemetry 双计数

- [ ] **Step 1: 写失败测试**（`continuation-exhausted` 进 outcome union + hit-rate 分母 + 双计数字段）

```ts
// tests/anthropic/protect-streaming-stats.unit.test.ts 追加
test("continuation-exhausted counts as non-success in hit rate denominator", () => { /* ... */ })
test("stats split retriesBeforeDegrade into pre-first-block vs continuation counts", () => { /* ... */ })
```

- [ ] **Step 2: 跑，失败。**

- [ ] **Step 3: 扩 `protect-streaming-stats.ts`**

outcome union += `"continuation-exhausted"`;hit-rate 分母 `success / (success + exhausted + partial-degrade + continuation-exhausted)`;新增 `preFirstBlockRetries` / `continuationRetries` 两独立计数（取代/补充 `retriesBeforeDegrade`，telemetry-architecture「不可重算因子拆最细」）。

- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `git commit -m "feat(telemetry): continuation-exhausted outcome + split retry counts"`。

---

### P0 收口

- [ ] 跑 `bun run test:fast` 全绿（P0 纯新增，基线 +N 不减）。
- [ ] 跑 `bun run typecheck` 绿。
- [ ] golden 回放等价（若前 spec 有 golden fixture，确认 P0 未改任何提交点、默认行为逐字不变）。
