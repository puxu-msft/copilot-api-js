# Phase 1：passthrough 黑名单子字段过滤

**Goal**：passthrough 模式下剥掉 GHC 未支持的 cache_control 子字段（内置 `scope`），保留客户端精调断点；history 记可辨识剥离标记。

**与 Phase 0 正交**：只改 `applyCacheControlMode` 的 `passthrough` 分支 + 新增读取端/filter/config/history 字段。

**依赖**：无（Phase 0 可后做）。**被 Phase 2 依赖**（源③/④注入点）。

**承重**：spec §5（四源 union、红线1 filter 返回 identity）+ §8（history 标记）。对齐 [collectStripBetas:228](../../../src/lib/anthropic/request-preparation.ts#L228) / [stripBetaHeaders state 三处落点](../../../src/lib/state.ts#L801)。

---

### Task 1.1：collectUnsupportedCacheControlSubfields 读取端（内置 scope + config，源③/④缺席）

**Files:**
- Modify: `src/lib/anthropic/request-preparation.ts`（新增，紧邻 [collectStripBetas:228](../../../src/lib/anthropic/request-preparation.ts#L228)）
- Test: `tests/anthropic/cache-control-subfield-strip.unit.test.ts`（新建）

**Interfaces:**
- Consumes: `collectAllMatching`（已 import [:59](../../../src/lib/anthropic/request-preparation.ts#L59)）、`state.stripCacheControlSubfields`（Task 1.3 建；本 task 先用可选链容缺）。
- Produces: `collectUnsupportedCacheControlSubfields(model, hints?): Set<string>`（README 契约）。

- [ ] **Step 1：写失败测试**

```ts
import { afterEach, describe, expect, test } from "bun:test"
import { collectUnsupportedCacheControlSubfields } from "~/lib/anthropic/request-preparation"
import { restoreStateForTests, setStateForTests, snapshotStateForTests } from "~/lib/state"

const originalState = snapshotStateForTests()
afterEach(() => restoreStateForTests(originalState))

describe("collectUnsupportedCacheControlSubfields", () => {
  test("内置默认含 scope（无需 config）", () => {
    expect(collectUnsupportedCacheControlSubfields("claude-opus-4-8").has("scope")).toBe(true)
  })
  test("config 追加字段（per-model + 通配）", () => {
    setStateForTests({ stripCacheControlSubfields: { "*": ["foo"], "claude-opus-4-8": ["bar"] } })
    const s = collectUnsupportedCacheControlSubfields("claude-opus-4-8")
    expect([...s].sort()).toEqual(["bar", "foo", "scope"])
  })
  test("源④ hints 并入", () => {
    const s = collectUnsupportedCacheControlSubfields("claude-opus-4-8", ["baz"])
    expect(s.has("baz")).toBe(true)
  })
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `bun test tests/anthropic/cache-control-subfield-strip.unit.test.ts`
Expected: FAIL（未定义）。

- [ ] **Step 3：实现（四源 union，源③ Phase 2 才加）**

```ts
/** GHC 上游不支持的 cache_control 子字段（内置地雷）。scope 由 prompt-caching-scope beta 引入，GHC 未启用。 */
const BUILTIN_UNSUPPORTED_CACHE_CONTROL_SUBFIELDS: ReadonlyArray<string> = ["scope"]

/**
 * 收集应从 passthrough cache_control 剥除的子字段。四源 union（对齐 collectStripBetas）：
 * ① 内置地雷 ② config anthropic.strip_cache_control_subfields（per-model + "*"）
 * ③ negotiation 学习集（Phase 2 接入，本阶段缺席）④ per-attempt hint（Phase 2 注入）
 */
export function collectUnsupportedCacheControlSubfields(model: string, hints?: ReadonlyArray<string>): Set<string> {
  const strip = new Set<string>(BUILTIN_UNSUPPORTED_CACHE_CONTROL_SUBFIELDS)
  for (const fields of collectAllMatching(model, state.stripCacheControlSubfields)) {
    for (const field of fields) strip.add(field)
  }
  // 源③ negotiation：Phase 2 在此追加 getUnsupportedCacheControlSubfields()
  for (const field of hints ?? []) strip.add(field)
  return strip
}
```

- [ ] **Step 4：跑测试确认通过**

Run: `bun test tests/anthropic/cache-control-subfield-strip.unit.test.ts`
Expected: PASS（内置 scope 用例过；config 用例需 Task 1.3 的 state 字段——若此刻 `state.stripCacheControlSubfields` 未定义会 typecheck 失败，故本 task 与 1.3 合并提交或先加 state 字段。**决策**：先做 Task 1.3 的 state 字段，再回本 task。见执行顺序注记）。

- [ ] **Step 5：提交**（与 Task 1.3 合并，见下）

> **执行顺序注记**：Task 1.1 读取端引用 `state.stripCacheControlSubfields`，Task 1.3 建该 state 字段。为满足 commit invariant（中间态不半坏），**先执行 Task 1.3 建 state 字段 + config，再执行 Task 1.1**。或本 task Step 3 先用 `(state as { stripCacheControlSubfields?: Record<string, Array<string>> }).stripCacheControlSubfields ?? {}` 容缺、Task 1.3 补正。推荐前者（顺序 1.3 → 1.1 → 1.2 → 1.4 → 1.5）。

---

### Task 1.3：config schema + state 落点（先于 1.1 执行）

**Files:**
- Modify: `src/lib/config/schema.ts`（紧邻 [cache_control:413](../../../src/lib/config/schema.ts#L413)）
- Modify: `src/lib/state.ts`（字段声明 [~801](../../../src/lib/state.ts#L801) + clone [926/930](../../../src/lib/state.ts#L926) + patch 白名单 [1175](../../../src/lib/state.ts#L1175) + CONFIG_MANAGED_DEFAULTS [1473](../../../src/lib/state.ts#L1473) + 二次落点 [1546/1700](../../../src/lib/state.ts#L1546)）
- Modify: `src/lib/config/config.ts`（若有 schema→state 映射，对齐 stripBetaHeaders）
- Test: `tests/config/`（对齐现有 config 测试；或经 Task 1.1 的 config 用例间接覆盖）

**Interfaces:**
- Produces: `state.stripCacheControlSubfields: Record<string, Array<string>>`（默认 `{}`）+ config 键 `anthropic.strip_cache_control_subfields`。

- [ ] **Step 1：schema.ts 加键**

紧邻 `cache_control: nullableEnum(...)` 后：

```ts
// GHC 未支持的 cache_control 子字段黑名单（per-model + 通配 "*"）。passthrough 模式下剥除。
// 内置 {scope} 在读取端注入，此处默认 {} 表示无额外覆盖（正交）。
strip_cache_control_subfields: z
  .record(z.string(), z.array(z.string()))
  .optional()
  .transform((v) => v ?? undefined),
```

- [ ] **Step 2：state.ts 五处落点**（严格对齐 `stripBetaHeaders`——grep `stripBetaHeaders` 得 [801/926/983/1175/1473/1546/1700](../../../src/lib/state.ts#L801) 每处平行加 `stripCacheControlSubfields`）

- 字段声明（[:801](../../../src/lib/state.ts#L801) 附近）：`readonly stripCacheControlSubfields: Record<string, Array<string>>`
- clone（[:926](../../../src/lib/state.ts#L926)）：`stripCacheControlSubfields: cloneStripBetaHeaders(source.stripCacheControlSubfields),`
- patch（[:983](../../../src/lib/state.ts#L983) 平行块）：`if ("stripCacheControlSubfields" in patch) { cloned.stripCacheControlSubfields = patch.stripCacheControlSubfields ? cloneStripBetaHeaders(patch.stripCacheControlSubfields) : undefined }`
- patch 键白名单 union（[:1175](../../../src/lib/state.ts#L1175)）：`| "stripCacheControlSubfields"`
- CONFIG_MANAGED_DEFAULTS（[:1473](../../../src/lib/state.ts#L1473)）：`stripCacheControlSubfields: {} as Record<string, Array<string>>,`
- 二次 clone 落点（[:1546](../../../src/lib/state.ts#L1546)/[:1700](../../../src/lib/state.ts#L1700)）：`stripCacheControlSubfields: cloneStripBetaHeaders(CONFIG_MANAGED_DEFAULTS.stripCacheControlSubfields),`

- [ ] **Step 3：config.ts schema→state 映射**（若存在，对齐 stripBetaHeaders 的 `anthropic.strip_beta_headers` → `stripBetaHeaders` 映射）

Run 先定位: `bunx eslint --rulesdir /dev/null 2>/dev/null; rg -n "stripBetaHeaders|strip_beta_headers" src/lib/config/config.ts`
按同款加 `strip_cache_control_subfields` → `stripCacheControlSubfields`。

- [ ] **Step 4：typecheck**

Run: `bun run typecheck`
Expected: PASS（所有 `never` 穷尽 + 类型完整）。

- [ ] **Step 5：提交（连同 Task 1.1 读取端）**

```bash
git add -- src/lib/config/schema.ts src/lib/state.ts src/lib/config/config.ts src/lib/anthropic/request-preparation.ts tests/anthropic/cache-control-subfield-strip.unit.test.ts
git commit -F - -- src/lib/config/schema.ts src/lib/state.ts src/lib/config/config.ts src/lib/anthropic/request-preparation.ts tests/anthropic/cache-control-subfield-strip.unit.test.ts <<'EOF'
feat: cache_control 子字段黑名单 config + 四源读取端（内置 scope）
EOF
```

---

### Task 1.2：filterCacheControlSubfields 原语（红线1：返回 identity）

**Files:**
- Modify: `src/lib/anthropic/request-preparation.ts`（新增，紧邻 [walkCacheControl:1173](../../../src/lib/anthropic/request-preparation.ts#L1173)）
- Test: `tests/anthropic/cache-control-subfield-strip.unit.test.ts`（追加）

**Interfaces:**
- Consumes: `walkCacheControl`（复用遍历骨架）。
- Produces: `filterCacheControlSubfields(wire, blacklist): Array<string>`（返回实际剥掉的字段去重列表）。

- [ ] **Step 1：写失败测试（含红线1：不删整个 cc）**

```ts
test("filterCacheControlSubfields：剥 scope、保 type+ttl、返回剥掉列表", () => {
  const wire = {
    system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h", scope: "global" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "m", cache_control: { type: "ephemeral", scope: "global" } }] }],
    tools: [],
  }
  const stripped = filterCacheControlSubfields(wire as never, new Set(["scope"]))
  expect(stripped).toEqual(["scope"])
  expect((wire.system[0] as never as { cache_control: unknown }).cache_control).toEqual({ type: "ephemeral", ttl: "1h" }) // 红线1：cc 对象仍在
  expect((wire.messages[0].content[0] as { cache_control: unknown }).cache_control).toEqual({ type: "ephemeral" })
})

test("黑名单为空 → 完全不动 + 返回 []", () => {
  const wire = { system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", scope: "x" } }], messages: [], tools: [] }
  expect(filterCacheControlSubfields(wire as never, new Set())).toEqual([])
  expect((wire.system[0] as { cache_control: unknown }).cache_control).toEqual({ type: "ephemeral", scope: "x" })
})
```

（需在测试文件顶部 `import { filterCacheControlSubfields } from ...`——它非 export 则加 `@internal` export 供测。**决策**：export。）

- [ ] **Step 2：跑测试确认失败**

Run: `bun test tests/anthropic/cache-control-subfield-strip.unit.test.ts -t filterCacheControlSubfields`
Expected: FAIL。

- [ ] **Step 3：实现（红线1：delete 后 return cc）**

```ts
/**
 * 就地删除 wire 中所有 cache_control 的黑名单子字段，保留其余（红线1：绝不返回 undefined，
 * 那会删掉整个 cache_control 退化成 disabled）。返回实际剥掉的字段去重列表（供 history 标记）。
 */
export function filterCacheControlSubfields(wire: Record<string, unknown>, blacklist: Set<string>): Array<string> {
  if (blacklist.size === 0) return []
  const stripped = new Set<string>()
  walkCacheControl(wire, (current) => {
    const cc = current as Record<string, unknown>
    for (const field of blacklist) {
      if (field in cc) {
        delete cc[field]
        stripped.add(field)
      }
    }
    return cc as { type: string } // 红线1：identity，走 replace 分支但对象不变
  })
  return [...stripped]
}
```

- [ ] **Step 4：跑测试确认通过**

Run: `bun test tests/anthropic/cache-control-subfield-strip.unit.test.ts -t filterCacheControlSubfields`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add -- src/lib/anthropic/request-preparation.ts tests/anthropic/cache-control-subfield-strip.unit.test.ts
git commit -F - -- src/lib/anthropic/request-preparation.ts tests/anthropic/cache-control-subfield-strip.unit.test.ts <<'EOF'
feat: filterCacheControlSubfields 原语（保对象删子字段）
EOF
```

---

### Task 1.4：接线 passthrough 分支 + PrepareContext/PrepareHints 出参

**Files:**
- Modify: `src/lib/anthropic/request-preparation.ts`（[passthrough 分支:921](../../../src/lib/anthropic/request-preparation.ts#L921) + [PrepareContext:78](../../../src/lib/anthropic/request-preparation.ts#L78) + PrepareHints [:124](../../../src/lib/anthropic/request-preparation.ts#L124)）
- Test: `tests/anthropic/cache-control-subfield-strip.unit.test.ts`（追加集成用例，用 spec §1.1 实测形态）

**Interfaces:**
- Consumes: `collectUnsupportedCacheControlSubfields`、`filterCacheControlSubfields`。
- Produces: `PrepareContext.strippedCacheControlSubfields`、`PrepareHints.excludeCacheControlSubfields`（README 契约）。

- [ ] **Step 1：写失败集成测试（§1.1 实测形态）**

```ts
test("passthrough 剥 scope、保留其余客户端断点（§1.1 实测形态）", () => {
  setStateForTests({ cacheControlMode: "passthrough", copilotToken: "t", vsCodeVersion: "1.100.0", accountType: "individual" })
  const prepared = prepareAnthropicRequest({
    model: "claude-opus-4-8", max_tokens: 1024,
    system: [
      { type: "text", text: "sys0" },
      { type: "text", text: "sys1", cache_control: { type: "ephemeral", scope: "global" } as never },
      { type: "text", text: "sys2", cache_control: { type: "ephemeral" } as never },
    ],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  })
  const sys = prepared.wire.system as Array<{ cache_control?: unknown }>
  expect(sys[1].cache_control).toEqual({ type: "ephemeral" }) // scope 已剥
  expect(sys[2].cache_control).toEqual({ type: "ephemeral" }) // 不变
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `bun test tests/anthropic/cache-control-subfield-strip.unit.test.ts -t "passthrough 剥 scope"`
Expected: FAIL（passthrough 现纯 break，scope 仍在）。

- [ ] **Step 3：接线**

PrepareContext（[:78](../../../src/lib/anthropic/request-preparation.ts#L78)）加出参字段：

```ts
/** 由 cache-control step 写：passthrough 剥掉的 cache_control 子字段列表（供 history 可辨识标记，spec §8）。 */
strippedCacheControlSubfields?: ReadonlyArray<string>
```

PrepareHints（[:124](../../../src/lib/anthropic/request-preparation.ts#L124) 附近，excludeToolFields 旁）加：

```ts
/** 源④ per-attempt：Phase 2 retry 腿注入，剥掉刚被上游拒的 cache_control 子字段。 */
excludeCacheControlSubfields?: ReadonlyArray<string>
```

passthrough 分支（[:921](../../../src/lib/anthropic/request-preparation.ts#L921)）：

```ts
case "passthrough": {
  const blacklist = collectUnsupportedCacheControlSubfields(model, ctx.opts.excludeCacheControlSubfields)
  const stripped = filterCacheControlSubfields(wire, blacklist)
  if (stripped.length > 0) ctx.strippedCacheControlSubfields = stripped
  break
}
```

（`model` 是分支上方 [:905](../../../src/lib/anthropic/request-preparation.ts#L905) 已取的 `wire.model`；`ctx.opts` 是 PrepareContext.opts。）

- [ ] **Step 4：跑测试确认通过 + 回归**

Run: `bun test tests/anthropic/cache-control-subfield-strip.unit.test.ts && bun test tests/anthropic/`
Expected: PASS（passthrough 现有测试不回归——无 scope 的请求 blacklist 命中 0 → no-op）。

- [ ] **Step 5：typecheck + 提交**

```bash
bun run typecheck
git add -- src/lib/anthropic/request-preparation.ts tests/anthropic/cache-control-subfield-strip.unit.test.ts
git commit -F - -- src/lib/anthropic/request-preparation.ts tests/anthropic/cache-control-subfield-strip.unit.test.ts <<'EOF'
feat: passthrough 接线 cache_control 子字段过滤（剥 scope 消除 400）
EOF
```

---

### Task 1.5：history 剥离标记（UpstreamRequestLeg 诊断字段）

**Files:**
- Modify: `src/lib/history/types.ts`（[UpstreamRequestLeg:353](../../../src/lib/history/types.ts#L353) 加字段）
- Modify: `src/lib/codec/anthropic/codec.ts`（构造 outbound leg 处读 `prepared.strippedCacheControlSubfields` 写入）
- Modify: `src/lib/anthropic/client.ts`（[prepared 结果](../../../src/lib/anthropic/client.ts) 透出 `strippedCacheControlSubfields`，对齐 wire/headers）
- Test: `tests/anthropic/cache-control-subfield-strip.unit.test.ts` 或 history 集成测试

**Interfaces:**
- Consumes: `PrepareContext.strippedCacheControlSubfields`（Task 1.4）。
- Produces: `UpstreamRequestLeg.strippedCacheControlSubfields`（README 契约）。

- [ ] **Step 1：写失败测试（prepared 透出该字段）**

```ts
test("prepared 结果透出 strippedCacheControlSubfields", () => {
  setStateForTests({ cacheControlMode: "passthrough", copilotToken: "t", vsCodeVersion: "1.100.0", accountType: "individual" })
  const prepared = prepareAnthropicRequest({
    model: "claude-opus-4-8", max_tokens: 1024,
    system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", scope: "global" } as never }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  })
  expect(prepared.strippedCacheControlSubfields).toEqual(["scope"])
})
```

（若 `prepareAnthropicRequest`（client.ts wrapper）当前只透 `{wire, headers}`，本 step 会 FAIL 于字段缺失。）

- [ ] **Step 2：跑测试确认失败**

Run: `bun test tests/anthropic/cache-control-subfield-strip.unit.test.ts -t "prepared 结果透出"`
Expected: FAIL。

- [ ] **Step 3：三处接线**

- history types（[UpstreamRequestLeg:353](../../../src/lib/history/types.ts#L353)）加：`strippedCacheControlSubfields?: Array<string>`
- client.ts wrapper：`prepared` 返回对象加 `strippedCacheControlSubfields: ctx.strippedCacheControlSubfields`（对齐现有 `wire`/`headers` 透出）
- codec.ts 构造 upstreamRequest leg 处：`strippedCacheControlSubfields: prepared.strippedCacheControlSubfields`（richest-data-flow：后端完整存，即使前端暂不呈现）

- [ ] **Step 4：跑测试确认通过 + typecheck**

Run: `bun test tests/anthropic/cache-control-subfield-strip.unit.test.ts && bun run typecheck`
Expected: PASS。

- [ ] **Step 5：lint + 提交**

```bash
bunx eslint src/lib/anthropic/request-preparation.ts src/lib/history/types.ts src/lib/codec/anthropic/codec.ts src/lib/anthropic/client.ts
git add -- src/lib/history/types.ts src/lib/codec/anthropic/codec.ts src/lib/anthropic/client.ts tests/anthropic/cache-control-subfield-strip.unit.test.ts
git commit -F - -- src/lib/history/types.ts src/lib/codec/anthropic/codec.ts src/lib/anthropic/client.ts tests/anthropic/cache-control-subfield-strip.unit.test.ts <<'EOF'
feat: history 记 cache_control 子字段剥离标记（静默降级可观测）
EOF
```

---

## Phase 1 完成判据

- passthrough 剥 scope、消除 §1.1 的 400、保留其余客户端断点。
- config 键 `anthropic.strip_cache_control_subfields` 可追加字段（per-model + 通配）。
- history 的 upstreamRequest leg 含 `strippedCacheControlSubfields`（运维可见缓存语义降级）。
- 源③/④在读取端已留 union 位（源③ Phase 2 追加一行、源④已接 hint）。
