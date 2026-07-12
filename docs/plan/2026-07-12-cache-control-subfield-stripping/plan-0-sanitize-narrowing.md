# Phase 0：sanitize 语义收窄 + resolveSanitizedTtls + 跨层单调化

**Goal**：收窄 sanitize，使其保留客户端合法 `ttl`（不再无条件降 5m），并保证输出 wire 满足 Anthropic 跨层 TTL 递减约束（tools≥system≥messages）。抽 `resolveSanitizedTtls` 共享原语作 TTL 决策单一 owner。

**与 Phase 1 正交**：只改 `applyCacheControlMode` 的 `sanitize` 分支 + 新增原语 + proxied 复用原语。不碰 passthrough。

**承重背景**：spec §4.3（旧 sanitize 塌缩两层为同值 5m 意外掩盖了跨层违规；忠实保留会重新引入）+ §4.4（共享原语单一 owner）。现有 `resolveExtendedTtls`（[request-preparation.ts:176](../../../src/lib/anthropic/request-preparation.ts#L176)）的 messages≤tools_system clamp 逻辑内聚进新原语。

---

### Task 0.1：golden 预捕获现有 sanitize 行为

改动前锁旧行为，证等价基线（改后对照差异）。

**Files:**
- Test: `tests/anthropic/cache-control-sanitize.unit.test.ts`（新建）

**Interfaces:**
- Consumes: `prepareAnthropicRequest`（[client.ts](../../../src/lib/anthropic/client.ts)）返回 `{ wire, headers }`；`setStateForTests`/`restoreStateForTests`/`snapshotStateForTests`（state.ts）。断言模式见 [anthropic-request-preparation.it.test.ts:44-64](../../../tests/anthropic/anthropic-request-preparation.it.test.ts#L44)。

- [ ] **Step 1：写 golden 测试锁旧行为**

```ts
import { afterEach, describe, expect, test } from "bun:test"
import type { MessagesPayload } from "~/types/api/anthropic"
import { prepareAnthropicRequest } from "~/lib/anthropic/client"
import { restoreStateForTests, setStateForTests, snapshotStateForTests } from "~/lib/state"

const originalState = snapshotStateForTests()
afterEach(() => restoreStateForTests(originalState))

function payloadWith(system: MessagesPayload["system"]): MessagesPayload {
  return { model: "claude-opus-4-8", max_tokens: 1024, system, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }
}

describe("[GOLDEN] sanitize 现状（改动前基线）", () => {
  test("现状：sanitize 把客户端 ttl:1h 降为 5m（extended 未激活）", () => {
    setStateForTests({ cacheControlMode: "sanitize", copilotToken: "t", vsCodeVersion: "1.100.0", accountType: "individual" })
    const prepared = prepareAnthropicRequest(payloadWith([
      { type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } as never },
    ]))
    const sys = prepared.wire.system as Array<{ cache_control?: unknown }>
    // 现状行为（本 task 锁定，Task 0.4 会改成保留 1h）：
    expect(sys[0].cache_control).toEqual({ type: "ephemeral" })
  })
})
```

- [ ] **Step 2：跑测试确认通过（锁的是现状）**

Run: `bun test tests/anthropic/cache-control-sanitize.unit.test.ts`
Expected: PASS（这是现状快照，用于 Task 0.4 对照）。

- [ ] **Step 3：提交**

```bash
git add -- tests/anthropic/cache-control-sanitize.unit.test.ts
git commit -F - -- tests/anthropic/cache-control-sanitize.unit.test.ts <<'EOF'
test: golden 预捕获 sanitize 现状（cache_control ttl 降级）
EOF
```

---

### Task 0.2：resolveSanitizedTtls 原语（TDD）

**Files:**
- Modify: `src/lib/anthropic/request-preparation.ts`（新增 exported 函数，紧邻 [resolveExtendedTtls:176](../../../src/lib/anthropic/request-preparation.ts#L176)）
- Test: `tests/anthropic/resolve-sanitized-ttls.unit.test.ts`（新建）

**Interfaces:**
- Produces: `resolveSanitizedTtls` / `PerLayerClientTtls` / `SanitizedLayerTtls`（签名见 README 冻结契约）。

- [ ] **Step 1：写失败测试（含 C1 非法组合 + 单调化）**

```ts
import { describe, expect, test } from "bun:test"
import { resolveSanitizedTtls } from "~/lib/anthropic/request-preparation"

const ext = { toolsSystem: "1h" as const, messages: "5m" as const }

describe("resolveSanitizedTtls", () => {
  test("合法递减原样保留（extended 未激活）", () => {
    expect(resolveSanitizedTtls({ tools: "1h", system: "5m", messages: "5m" }, false, ext))
      .toEqual({ tools: "1h", system: "5m", messages: "5m" })
  })

  test("C1 非法组合：system=5m + messages=1h → messages 被降到 ≤system", () => {
    expect(resolveSanitizedTtls({ system: "5m", messages: "1h" }, false, ext))
      .toEqual({ tools: "5m", system: "5m", messages: "5m" })
  })

  test("缺层默认 5m", () => {
    expect(resolveSanitizedTtls({}, false, ext)).toEqual({ tools: "5m", system: "5m", messages: "5m" })
  })

  test("extended 激活：floor 升级 + 仍满足递减", () => {
    // tools/system floor=1h, messages floor=5m；客户端全缺
    expect(resolveSanitizedTtls({}, true, ext)).toEqual({ tools: "1h", system: "1h", messages: "5m" })
  })

  test("extended 激活 + 客户端 messages=1h 但 system floor 使 system=1h → messages 可保 1h（递减成立）", () => {
    expect(resolveSanitizedTtls({ messages: "1h" }, true, ext)).toEqual({ tools: "1h", system: "1h", messages: "1h" })
  })
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `bun test tests/anthropic/resolve-sanitized-ttls.unit.test.ts`
Expected: FAIL（`resolveSanitizedTtls is not a function`）。

- [ ] **Step 3：实现原语**

在 request-preparation.ts 紧邻 `resolveExtendedTtls` 后加：

```ts
export interface PerLayerClientTtls {
  tools?: CacheTtl
  system?: CacheTtl
  messages?: CacheTtl
}
export interface SanitizedLayerTtls {
  tools: CacheTtl
  system: CacheTtl
  messages: CacheTtl
}

/** ttl 大小比较：5m < 1h。 */
function maxTtl(a: CacheTtl, b: CacheTtl): CacheTtl {
  return a === "1h" || b === "1h" ? "1h" : "5m"
}
function minTtl(a: CacheTtl, b: CacheTtl): CacheTtl {
  return a === "5m" || b === "5m" ? "5m" : "1h"
}

/**
 * TTL 决策单一 owner（sanitize + proxied 共用）。对每层取 max(客户端最大 ttl, extended floor)，
 * 再沿 tools→system→messages 单调化（后层 ≤ 前层），满足 Anthropic 前缀递减约束（spec §4.3）。
 * extended 未激活时所有 floor = 5m。
 */
export function resolveSanitizedTtls(
  clientMax: PerLayerClientTtls,
  extendedActive: boolean,
  extendedTtls: { toolsSystem: CacheTtl; messages: CacheTtl },
): SanitizedLayerTtls {
  const floorToolsSystem: CacheTtl = extendedActive ? extendedTtls.toolsSystem : "5m"
  const floorMessages: CacheTtl = extendedActive ? extendedTtls.messages : "5m"
  const tools = maxTtl(clientMax.tools ?? "5m", floorToolsSystem)
  const system = minTtl(maxTtl(clientMax.system ?? "5m", floorToolsSystem), tools)
  const messages = minTtl(maxTtl(clientMax.messages ?? "5m", floorMessages), system)
  return { tools, system, messages }
}
```

- [ ] **Step 4：跑测试确认通过**

Run: `bun test tests/anthropic/resolve-sanitized-ttls.unit.test.ts`
Expected: PASS（5 例全绿）。

- [ ] **Step 5：typecheck + 提交**

```bash
bun run typecheck
git add -- src/lib/anthropic/request-preparation.ts tests/anthropic/resolve-sanitized-ttls.unit.test.ts
git commit -F - -- src/lib/anthropic/request-preparation.ts tests/anthropic/resolve-sanitized-ttls.unit.test.ts <<'EOF'
feat: resolveSanitizedTtls 共享 TTL 决策原语（跨层单调化）
EOF
```

---

### Task 0.3：收集每层客户端最大 ttl（sanitize 前置遍历）

sanitize 需先扫 wire 得每层 clientMax 快照，才能算 `resolveSanitizedTtls`。

**Files:**
- Modify: `src/lib/anthropic/request-preparation.ts`（新增内部函数）
- Test: `tests/anthropic/resolve-sanitized-ttls.unit.test.ts`（追加）

**Interfaces:**
- Produces: `function collectPerLayerClientTtls(wire: Record<string, unknown>): PerLayerClientTtls`（内部，不 export；但为可测导出到测试可用 `@internal` export 或经 sanitize 行为间接测）。**决策**：export 供直接单测。

- [ ] **Step 1：写失败测试**

```ts
import { collectPerLayerClientTtls } from "~/lib/anthropic/request-preparation"

test("collectPerLayerClientTtls：每层取该层出现的最大 ttl", () => {
  const wire = {
    system: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }, { type: "text", text: "b", cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] }],
    tools: [],
  }
  expect(collectPerLayerClientTtls(wire)).toEqual({ tools: undefined, system: "1h", messages: "5m" })
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `bun test tests/anthropic/resolve-sanitized-ttls.unit.test.ts -t collectPerLayerClientTtls`
Expected: FAIL（未定义）。

- [ ] **Step 3：实现（复用现有 section 遍历骨架）**

```ts
/** 扫 wire 每层（system/messages/tools + 嵌套 content），返回该层出现的最大 cache_control ttl（缺则 undefined）。 */
export function collectPerLayerClientTtls(wire: Record<string, unknown>): PerLayerClientTtls {
  const result: PerLayerClientTtls = {}
  for (const section of ["tools", "system", "messages"] as const) {
    if (!Array.isArray(wire[section])) continue
    let layerMax: CacheTtl | undefined
    const visit = (items: Array<Record<string, unknown> | null | undefined>): void => {
      for (const item of items) {
        if (!item || typeof item !== "object") continue
        const cc = item.cache_control as { ttl?: unknown } | undefined
        if (cc) {
          const ttl: CacheTtl = cc.ttl === "1h" ? "1h" : "5m"
          layerMax = layerMax === undefined ? ttl : maxTtl(layerMax, ttl)
        }
        if (Array.isArray(item.content)) visit(item.content as Array<Record<string, unknown>>)
      }
    }
    visit(wire[section] as Array<Record<string, unknown>>)
    result[section] = layerMax
  }
  return result
}
```

- [ ] **Step 4：跑测试确认通过**

Run: `bun test tests/anthropic/resolve-sanitized-ttls.unit.test.ts -t collectPerLayerClientTtls`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add -- src/lib/anthropic/request-preparation.ts tests/anthropic/resolve-sanitized-ttls.unit.test.ts
git commit -F - -- src/lib/anthropic/request-preparation.ts tests/anthropic/resolve-sanitized-ttls.unit.test.ts <<'EOF'
feat: collectPerLayerClientTtls（sanitize 前置每层 ttl 快照）
EOF
```

---

### Task 0.4：sanitize 分支改用新原语（保留 ttl + 剥非白名单子字段）

**Files:**
- Modify: `src/lib/anthropic/request-preparation.ts`（[applyCacheControlMode:924-928](../../../src/lib/anthropic/request-preparation.ts#L924) sanitize 分支）
- Test: `tests/anthropic/cache-control-sanitize.unit.test.ts`（改 golden 断言为新行为 + 加跨层用例）

**Interfaces:**
- Consumes: `resolveSanitizedTtls`、`collectPerLayerClientTtls`（Task 0.2/0.3）、现有 `walkCacheControl`（[:1173](../../../src/lib/anthropic/request-preparation.ts#L1173)）。

- [ ] **Step 1：改 golden 测试为新行为 + 加跨层矩阵**

把 Task 0.1 的现状断言改为新行为，并补跨层：

```ts
describe("sanitize 收窄（新行为）", () => {
  test("保留客户端 ttl:1h（extended 未激活，不再误降 5m）", () => {
    setStateForTests({ cacheControlMode: "sanitize", copilotToken: "t", vsCodeVersion: "1.100.0", accountType: "individual" })
    const prepared = prepareAnthropicRequest(payloadWith([
      { type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } as never },
    ]))
    const sys = prepared.wire.system as Array<{ cache_control?: unknown }>
    expect(sys[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
  })

  test("剥 scope 子字段、保留 ttl", () => {
    setStateForTests({ cacheControlMode: "sanitize", copilotToken: "t", vsCodeVersion: "1.100.0", accountType: "individual" })
    const prepared = prepareAnthropicRequest(payloadWith([
      { type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h", scope: "global" } as never },
    ]))
    const sys = prepared.wire.system as Array<{ cache_control?: unknown }>
    expect(sys[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
  })

  test("C1 跨层：system=5m + messages=1h → messages 降到 5m（排序守卫）", () => {
    setStateForTests({ cacheControlMode: "sanitize", copilotToken: "t", vsCodeVersion: "1.100.0", accountType: "individual" })
    const prepared = prepareAnthropicRequest({
      model: "claude-opus-4-8", max_tokens: 1024,
      system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } as never }],
      messages: [{ role: "user", content: [{ type: "text", text: "m", cache_control: { type: "ephemeral", ttl: "1h" } as never }] }],
    })
    const sys = prepared.wire.system as Array<{ cache_control?: unknown }>
    const msg = (prepared.wire.messages as Array<{ content: Array<{ cache_control?: unknown }> }>)[0].content
    expect(sys[0].cache_control).toEqual({ type: "ephemeral" })
    expect(msg[0].cache_control).toEqual({ type: "ephemeral" }) // 被降到 ≤system
  })
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `bun test tests/anthropic/cache-control-sanitize.unit.test.ts`
Expected: FAIL（现状仍降 ttl / 不保留 1h）。

- [ ] **Step 3：改 sanitize 分支**

替换 [applyCacheControlMode](../../../src/lib/anthropic/request-preparation.ts#L924) 的 sanitize case（现在用 `messagesEphemeral`/`toolsSystemEphemeral`）：

```ts
case "sanitize": {
  const clientMax = collectPerLayerClientTtls(wire)
  const ttls = resolveSanitizedTtls(clientMax, extendedTtlActive, { toolsSystem, messages: messagesTtl })
  // 同层统一为 effective ttl（规范化语义）；只挑 type+ttl 重建 → scope 等非白名单子字段自动剥除。
  walkCacheControl(wire, (_current, section) => ephemeralFor(ttls[section]))
  break
}
```

注意：`toolsSystem` / `messagesTtl` 是分支上方 [:912](../../../src/lib/anthropic/request-preparation.ts#L912) 已解析的层 TTL；`extendedTtlActive` 同 [:911](../../../src/lib/anthropic/request-preparation.ts#L911)。`ephemeralFor`（[:159](../../../src/lib/anthropic/request-preparation.ts#L159)）只产 `{type,ttl?}`，天然剥 scope。

- [ ] **Step 4：跑测试确认通过 + 全量回归**

Run: `bun test tests/anthropic/cache-control-sanitize.unit.test.ts && bun test tests/anthropic/`
Expected: PASS（新行为 + 现有 46 场景 it 测试不回归；若 `anthropic-request-preparation.it.test.ts` 有 sanitize 相关断言假设旧降级行为，须一并更新为新行为并在 commit 说明）。

- [ ] **Step 5：typecheck + 提交**

```bash
bun run typecheck
git add -- src/lib/anthropic/request-preparation.ts tests/anthropic/cache-control-sanitize.unit.test.ts
git commit -F - -- src/lib/anthropic/request-preparation.ts tests/anthropic/cache-control-sanitize.unit.test.ts <<'EOF'
feat: sanitize 收窄——保留客户端 ttl + 跨层单调化 + 剥非白名单子字段
EOF
```

---

### Task 0.5：proxied 复用原语 + 头部 delta 断言（消除三站点各自为政）

**Files:**
- Modify: `src/lib/anthropic/request-preparation.ts`（[proxied 分支:930-940](../../../src/lib/anthropic/request-preparation.ts#L930)）
- Test: `tests/anthropic/cache-control-sanitize.unit.test.ts`（追加头部 delta + proxied 用例）

**Interfaces:**
- Consumes: `resolveSanitizedTtls`。proxied 现用 `ephemeralFor(toolsSystem/messages)` 注入（[:938-939](../../../src/lib/anthropic/request-preparation.ts#L938)），改为经原语取层 ttl（proxied 客户端断点全删、clientMax 全空，故等价于 extended floor + 单调化——行为不变但收口到单一 owner）。

- [ ] **Step 1：写头部 delta 测试（M2）**

```ts
test("头部 delta：sanitize 保留 1h → 发 extended-cache-ttl beta（旧语义降 5m 不发）", () => {
  setStateForTests({ cacheControlMode: "sanitize", copilotToken: "t", vsCodeVersion: "1.100.0", accountType: "individual" })
  const prepared = prepareAnthropicRequest(payloadWith([
    { type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } as never },
  ]))
  expect(prepared.headers["anthropic-beta"] ?? "").toContain("extended-cache-ttl-2025-04-11")
})
```

- [ ] **Step 2：跑测试确认通过（Task 0.4 已使 body 保留 1h → wireHasOneHourTtl=true → 头部已 mirror）**

Run: `bun test tests/anthropic/cache-control-sanitize.unit.test.ts -t "头部 delta"`
Expected: PASS（[wireHasOneHourTtl:192](../../../src/lib/anthropic/request-preparation.ts#L192) → [ctx.wroteExtendedTtl:952](../../../src/lib/anthropic/request-preparation.ts#L952) 逻辑不变，自动生效）。若 FAIL 说明 mirror 断链，需排查。

- [ ] **Step 3：proxied 分支收口到原语**

```ts
case "proxied": {
  walkCacheControl(wire, () => undefined) // 全删客户端断点
  const ttls = resolveSanitizedTtls({}, extendedTtlActive, { toolsSystem, messages: messagesTtl })
  addMessageCacheControl(wire.messages as Array<MessageParam> | undefined, ephemeralFor(ttls.messages))
  addToolsAndSystemCacheControl(wire, ephemeralFor(ttls.tools)) // tools/system 同层用 ttls.tools（=ttls.system，单调化后相等或 tools≥system）
  break
}
```

注意：proxied 全删后 clientMax={}，`resolveSanitizedTtls({}, ...)` = 纯 extended floor + 单调化，与旧 `ephemeralFor(toolsSystem)`/`ephemeralFor(messagesTtl)` 在合法 extended 配置下**等价**（现有 `resolveExtendedTtls` 已保证 messages≤toolsSystem）。golden 须证等价。

- [ ] **Step 4：proxied 等价回归**

Run: `bun test tests/anthropic/`
Expected: PASS（proxied 现有测试不回归——收口是重构，行为等价）。

- [ ] **Step 5：typecheck + lint + 提交**

```bash
bun run typecheck && bunx eslint src/lib/anthropic/request-preparation.ts
git add -- src/lib/anthropic/request-preparation.ts tests/anthropic/cache-control-sanitize.unit.test.ts
git commit -F - -- src/lib/anthropic/request-preparation.ts tests/anthropic/cache-control-sanitize.unit.test.ts <<'EOF'
refactor: proxied 复用 resolveSanitizedTtls（TTL 决策收口单一 owner）
EOF
```

---

## Phase 0 完成判据

- `resolveSanitizedTtls` 是 sanitize + proxied 的唯一 TTL 决策点（extended clamp 逻辑内聚）。
- sanitize 保留客户端合法 ttl、剥 scope、跨层满足递减。
- 头部 mirror 逻辑不变（body 有 1h → 发 beta）。
- 现有 anthropic 测试套件不回归（旧 sanitize 降级断言若存在须更新为新行为）。
