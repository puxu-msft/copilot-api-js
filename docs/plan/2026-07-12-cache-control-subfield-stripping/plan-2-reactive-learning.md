# Phase 2：反应式学习腿（自愈新未知子字段）

> **实施状态（2026-07-12 landed，commit 53b5f19d）**：全部完成。扇出实为**十一处**（union/array/Map/mark/get/V2 接口/snapshot/load/count/locateMeta/deleteLocated/getGroupedSnapshot/clear）+ ui-v4 CATEGORY_LABELS。三路径遮蔽回归证实 disjoint。附带更新三个计数守卫：NEGOTIATION_CATEGORIES 10→11、snapshot 分类 10→11、策略列表 16→17（cache-control-subfield 在 body-field 之后）。

**Goal**：GHC 拒绝新 cache_control 子字段时，自动学习该字段、剥掉重试、endpoint-level fixate，后续经 Phase 1 读取端预剥。

**依赖**：Phase 1（读取端源③/④注入点、`PrepareHints.excludeCacheControlSubfields`）。

**承重**：spec §6.1（新 `NegotiationCategory` 十点扇出、红线3）+ §6.3（三路径遮蔽回归、红线4）。对齐 [tool-field-rejection-retry.ts](../../../src/lib/request/strategies/tool-field-rejection-retry.ts)（endpoint-level、batch matchAll、手写非通用原语）。

---

### Task 2.1：negotiation cache 新分类（十点扇出，红线3）

**Files:**
- Modify: `src/lib/anthropic/negotiation-lifecycle.ts`（[NegotiationCategory:22](../../../src/lib/anthropic/negotiation-lifecycle.ts#L22) + [NEGOTIATION_CATEGORIES:35](../../../src/lib/anthropic/negotiation-lifecycle.ts#L35)）
- Modify: `src/lib/anthropic/feature-negotiation.ts`（in-memory Map + mark/get + [locateMeta:668](../../../src/lib/anthropic/feature-negotiation.ts#L668) + [deleteLocated:712](../../../src/lib/anthropic/feature-negotiation.ts#L712) + [NegotiationStateFileV2:439](../../../src/lib/anthropic/feature-negotiation.ts#L439) + [buildV2Snapshot:471](../../../src/lib/anthropic/feature-negotiation.ts#L471) + [loadPersistedFeatureNegotiation:563](../../../src/lib/anthropic/feature-negotiation.ts#L563) + [getGroupedSnapshot:788](../../../src/lib/anthropic/feature-negotiation.ts#L788)）
- Modify: `src/lib/state.ts`（`negotiationTtlOverridesMs` 分类，若有 per-category 配置）
- Test: `tests/pipeline/cache-control-subfield-rejection-retry.unit.test.ts`（新建）

**Interfaces:**
- Produces: `markAnthropicUnsupportedCacheControlSubfield(field)` / `getUnsupportedCacheControlSubfields()`（README 契约）、`NegotiationCategory` 新成员 `"cacheControlSubfields"`。

- [ ] **Step 1：写失败测试（mark → get 往返）**

```ts
import { afterEach, describe, expect, test } from "bun:test"
import {
  getUnsupportedCacheControlSubfields,
  markAnthropicUnsupportedCacheControlSubfield,
  resetAnthropicFeatureNegotiationForTesting,
} from "~/lib/anthropic/feature-negotiation"

afterEach(async () => { await resetAnthropicFeatureNegotiationForTesting() })

describe("cacheControlSubfields negotiation", () => {
  test("mark → get 往返（endpoint-level）", () => {
    markAnthropicUnsupportedCacheControlSubfield("scope")
    expect(getUnsupportedCacheControlSubfields()).toContain("scope")
  })
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `bun test tests/pipeline/cache-control-subfield-rejection-retry.unit.test.ts`
Expected: FAIL（未定义）。

- [ ] **Step 3：十点扇出实现**（严格对齐 `unsupportedToolFields` / `toolFields` 分类——grep 每处逐一平行加）

1. negotiation-lifecycle.ts `NegotiationCategory` union 加 `| "cacheControlSubfields"`
2. negotiation-lifecycle.ts `NEGOTIATION_CATEGORIES` 数组末尾加 `"cacheControlSubfields"`
3. feature-negotiation.ts 加 in-memory Map：`const unsupportedCacheControlSubfields = new Map<string, Map<string, LearnedEntryMeta>>()`（对齐 `unsupportedToolFields` 声明处）
4. feature-negotiation.ts 加 mark/get（对齐 [markAnthropicUnsupportedToolFields:402](../../../src/lib/anthropic/feature-negotiation.ts#L402) / [getUnsupportedToolFields:417](../../../src/lib/anthropic/feature-negotiation.ts#L417)）：

```ts
/** Mark a cache_control subfield the upstream rejected (endpoint-level, one 400 immunizes all models). */
export function markAnthropicUnsupportedCacheControlSubfield(field: string): void {
  const trimmed = field.trim()
  if (!trimmed) return
  recordEntry(unsupportedCacheControlSubfields, endpointKey(), trimmed, nowMs())
  schedulePersist()
}
/** All cache_control subfields marked unsupported (and still active) for the current endpoint. */
export function getUnsupportedCacheControlSubfields(): Array<string> {
  return activeKeys(unsupportedCacheControlSubfields.get(endpointKey()), "cacheControlSubfields")
}
```

5. [locateMeta:668](../../../src/lib/anthropic/feature-negotiation.ts#L668) 的 `switch (category)` 加 `case "cacheControlSubfields": return ...unsupportedCacheControlSubfields...`（对齐 `toolFields` case）→ **消除 `never` 编译错**
6. [deleteLocated:712](../../../src/lib/anthropic/feature-negotiation.ts#L712) 同款加 case
7. [NegotiationStateFileV2:439](../../../src/lib/anthropic/feature-negotiation.ts#L439) 接口 + [buildV2Snapshot:471](../../../src/lib/anthropic/feature-negotiation.ts#L471) + [loadPersistedFeatureNegotiation:563](../../../src/lib/anthropic/feature-negotiation.ts#L563)（loadRecordMap + count 累加）+ [getGroupedSnapshot:788](../../../src/lib/anthropic/feature-negotiation.ts#L788) recordMaps 数组，逐处平行加 `cacheControlSubfields`
8. state.ts `negotiationTtlOverridesMs`（若存在 per-category）加分类默认 TTL
9. **（评审 M1）** [clearNegotiationMaps:836](../../../src/lib/anthropic/feature-negotiation.ts#L836) 加 `unsupportedCacheControlSubfields.clear()`——漏则测试间泄漏（静默污染，非编译错）
10. **（评审 H1）** [ui-v4/src/lib/learned.ts:8](../../../ui-v4/src/lib/learned.ts#L8) `CATEGORY_LABELS: Record<NegotiationCategory,string>` 加键（穷尽 Record，缺键 ui-v4 tsc 报错）。中文标签取可解码措辞，如 `cacheControlSubfields: "不支持的 cache_control 子字段（endpoint 级）"`

- [ ] **Step 4：跑测试通过 + typecheck（根 + ui-v4 双门，评审 H1）**

Run: `bun test tests/pipeline/cache-control-subfield-rejection-retry.unit.test.ts && bun run typecheck && bun run typecheck:ui-v4`
Expected: PASS（无 `never` 编译错、mark→get 往返绿、**ui-v4 CATEGORY_LABELS 穷尽绿**——根 typecheck 不覆盖 ui-v4，必须显式跑 typecheck:ui-v4）。

- [ ] **Step 5：提交**

```bash
git add -- src/lib/anthropic/negotiation-lifecycle.ts src/lib/anthropic/feature-negotiation.ts src/lib/state.ts ui-v4/src/lib/learned.ts tests/pipeline/cache-control-subfield-rejection-retry.unit.test.ts
git commit -F - -- src/lib/anthropic/negotiation-lifecycle.ts src/lib/anthropic/feature-negotiation.ts src/lib/state.ts ui-v4/src/lib/learned.ts tests/pipeline/cache-control-subfield-rejection-retry.unit.test.ts <<'EOF'
feat: cacheControlSubfields negotiation 分类（十点扇出 + endpoint-level 学习）
EOF
```

---

### Task 2.2：reactive retry 腿 + 三路径遮蔽回归（红线4）

**Files:**
- Create: `src/lib/request/strategies/cache-control-subfield-rejection-retry.ts`
- Modify: `src/lib/codec/anthropic/strategies.ts`（注册，ordering 见红线4）
- Test: `tests/pipeline/cache-control-subfield-rejection-retry.unit.test.ts`（追加）

**Interfaces:**
- Consumes: `markAnthropicUnsupportedCacheControlSubfield`（Task 2.1）、`PrepareHints.excludeCacheControlSubfields`（Phase 1）、`RetryStrategy`/`RetryAction`/`RetryContext`（[pipeline.ts](../../../src/lib/request/pipeline.ts)）、`ApiError`/`HTTPError`（[error](../../../src/lib/error)）。
- Produces: `createCacheControlSubfieldRejectionStrategy` / `parseRejectedCacheControlSubfields`（README 契约）。

- [ ] **Step 1：写失败测试（三路径遮蔽 + 解析 + 重试）**

```ts
import { createCacheControlSubfieldRejectionStrategy, parseRejectedCacheControlSubfields } from "~/lib/request/strategies/cache-control-subfield-rejection-retry"
import { parseRejectedToolFields } from "~/lib/request/strategies/tool-field-rejection-retry"
import type { ApiError } from "~/lib/error"

function ccError(msg: string): ApiError {
  return { type: "bad_request", status: 400, message: msg, raw: undefined } as never as ApiError
}

describe("三路径遮蔽（红线4）", () => {
  const paths = [
    "system.1.cache_control.ephemeral.scope: Extra inputs are not permitted",
    "tools.0.cache_control.ephemeral.scope: Extra inputs are not permitted", // 最险：共享 tools. 前缀
    "messages.0.content.1.cache_control.ephemeral.scope: Extra inputs are not permitted",
  ]
  test("新腿认领全部三路径", () => {
    for (const p of paths) expect(parseRejectedCacheControlSubfields(ccError(p))).toEqual(["scope"])
  })
  test("tool-field 腿绝不误认领 cache_control 路径（含 tools. 前缀那条）", () => {
    for (const p of paths) expect(parseRejectedToolFields(ccError(p))).toBeNull()
  })
})

describe("解析与重试", () => {
  test("matchAll 多字段一次剥", () => {
    const e = ccError("system.1.cache_control.ephemeral.scope: Extra inputs are not permitted\nsystem.2.cache_control.ephemeral.foo: Extra inputs are not permitted")
    expect(parseRejectedCacheControlSubfields(e)!.sort()).toEqual(["foo", "scope"])
  })
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `bun test tests/pipeline/cache-control-subfield-rejection-retry.unit.test.ts -t 遮蔽`
Expected: FAIL（新腿未定义）。

- [ ] **Step 3：实现 retry 腿**

```ts
import consola from "consola"
import { markAnthropicUnsupportedCacheControlSubfield } from "~/lib/anthropic/feature-negotiation"
import { type ApiError, HTTPError } from "~/lib/error"
import type { RetryAction, RetryContext, RetryStrategy } from "../pipeline"

// section (system|messages|tools) + 索引/嵌套段 + cache_control.<variant>.<field>: Extra inputs
// <variant> = ephemeral 等（\w+），<field> = 被拒子字段。容三种 section 前缀 + 嵌套 content 路径。
const CC_SUBFIELD_EXTRA_INPUTS = /\.cache_control\.\w+\.([a-z_]\w*): Extra inputs are not permitted/gi
const CC_SUBFIELD_PRESENT = /\.cache_control\.\w+\.[a-z_]\w*: Extra inputs are not permitted/i

function extractErrorText(error: ApiError): string | null {
  if (CC_SUBFIELD_PRESENT.test(error.message)) return error.message
  if (error.raw instanceof HTTPError) return error.raw.responseText
  return null
}

/** 解析上游拒绝的 cache_control 子字段集（去重），非此类 400 返 null。 */
export function parseRejectedCacheControlSubfields(error: ApiError): Array<string> | null {
  const text = extractErrorText(error)
  if (text === null) return null
  const fields = new Set<string>()
  for (const m of text.matchAll(CC_SUBFIELD_EXTRA_INPUTS)) fields.add(m[1])
  return fields.size > 0 ? [...fields] : null
}

export function createCacheControlSubfieldRejectionStrategy<TPayload extends { model: string }>(): RetryStrategy<TPayload> {
  let attempted = false
  return {
    name: "cache-control-subfield-rejection-retry",
    canHandle(error: ApiError): boolean {
      if (error.type !== "bad_request" || error.status !== 400 || attempted) return false
      return parseRejectedCacheControlSubfields(error) !== null
    },
    handle(error: ApiError, currentPayload: TPayload, _ctx: RetryContext<TPayload>): Promise<RetryAction<TPayload>> {
      attempted = true
      const fields = parseRejectedCacheControlSubfields(error)
      if (fields === null) return Promise.resolve({ action: "abort", error })
      for (const f of fields) markAnthropicUnsupportedCacheControlSubfield(f)
      consola.warn(`[CacheControlSubfieldRejection] Upstream rejected cache_control subfield(s): ${fields.join(", ")}; stripping and retrying (learned endpoint-wide).`)
      return Promise.resolve({ action: "retry", payload: currentPayload, prepareHints: { excludeCacheControlSubfields: fields }, meta: { strippedCacheControlSubfields: fields } })
    },
  }
}
```

- [ ] **Step 4：注册进 driver（红线4 ordering）**

`codec/anthropic/strategies.ts`：在 tool-field / body-field 腿**之后**（防御性——正则已证 disjoint，见 spec §6.3）加：

```ts
adapt(createCacheControlSubfieldRejectionStrategy<MessagesPayload>()),
```

（import 同款加于文件头。）

- [ ] **Step 5：跑测试通过 + 全量 pipeline 回归 + typecheck**

Run: `bun test tests/pipeline/ && bun run typecheck`
Expected: PASS（三路径遮蔽绿、tool-field 不回归）。

- [ ] **Step 6：lint + 提交**

```bash
bunx eslint src/lib/request/strategies/cache-control-subfield-rejection-retry.ts src/lib/codec/anthropic/strategies.ts
git add -- src/lib/request/strategies/cache-control-subfield-rejection-retry.ts src/lib/codec/anthropic/strategies.ts tests/pipeline/cache-control-subfield-rejection-retry.unit.test.ts
git commit -F - -- src/lib/request/strategies/cache-control-subfield-rejection-retry.ts src/lib/codec/anthropic/strategies.ts tests/pipeline/cache-control-subfield-rejection-retry.unit.test.ts <<'EOF'
feat: cache_control 子字段 reactive 学习腿（三路径遮蔽已证 disjoint）
EOF
```

---

### Task 2.3：源③接入读取端（reactive → proactive 收敛）

**Files:**
- Modify: `src/lib/anthropic/request-preparation.ts`（[collectUnsupportedCacheControlSubfields](../../../src/lib/anthropic/request-preparation.ts) 加源③）
- Test: `tests/anthropic/cache-control-subfield-strip.unit.test.ts`（追加）

**Interfaces:**
- Consumes: `getUnsupportedCacheControlSubfields`（Task 2.1）。

- [ ] **Step 1：写失败测试（学习后 proactive 预剥）**

```ts
import { markAnthropicUnsupportedCacheControlSubfield, resetAnthropicFeatureNegotiationForTesting } from "~/lib/anthropic/feature-negotiation"

test("源③：学到的字段进入读取端（reactive→proactive）", async () => {
  markAnthropicUnsupportedCacheControlSubfield("foo")
  expect(collectUnsupportedCacheControlSubfields("claude-opus-4-8").has("foo")).toBe(true)
  await resetAnthropicFeatureNegotiationForTesting()
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `bun test tests/anthropic/cache-control-subfield-strip.unit.test.ts -t 源③`
Expected: FAIL（读取端还没接源③）。

- [ ] **Step 3：读取端加源③一行**

`collectUnsupportedCacheControlSubfields` 内，源②之后、源④之前加：

```ts
for (const field of getUnsupportedCacheControlSubfields()) strip.add(field) // 源③ negotiation
```

（文件头 import `getUnsupportedCacheControlSubfields`。）

- [ ] **Step 4：跑测试通过 + typecheck**

Run: `bun test tests/anthropic/cache-control-subfield-strip.unit.test.ts && bun run typecheck`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add -- src/lib/anthropic/request-preparation.ts tests/anthropic/cache-control-subfield-strip.unit.test.ts
git commit -F - -- src/lib/anthropic/request-preparation.ts tests/anthropic/cache-control-subfield-strip.unit.test.ts <<'EOF'
feat: cache_control 子字段读取端接入 negotiation 学习集（源③收敛）
EOF
```

---

## Phase 2 完成判据

- GHC 拒绝新子字段 → reactive 腿学习 + 剥掉重试 + endpoint-level fixate。
- 三路径遮蔽已回归证实（尤其 `tools.N.cache_control.*` 不被 tool-field 误认领）。
- 学到的字段经源③进入后续请求 proactive 预剥（学一次 → 后续零 400）。
- Learned 页可见 `cacheControlSubfields` 分类（TTL/pin 管理）。
- G2「新子字段零改代码自愈」达成。
