# Phase 1 (Backend): 反应式学习记录 TTL 生命周期 + /api/negotiation 管理 API

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 或 executing-plans。先读 [README.md](./README.md)（Global Constraints / 红线 / 冻结契约）与 [spec](../../spec/2026-07-08-negotiation-learning-lifecycle.md)。逐任务 TDD。

**Goal:** feature-negotiation 缓存获得 per-entry `{firstLearnedAt, lastConfirmedAt, pinned?, manuallyExpired?, migrated?}` 元数据、按分类可配 TTL（默认 30d）自动过期、pin 永不过期；暴露 `/api/negotiation`。

**测试运行**：`bun test tests/anthropic/<file>` / `bun test tests/routes/<file>`；类型 `bun run typecheck`；lint 单文件 `bunx eslint <path>`（无缓存）。

---

## 文件结构

- Create `src/lib/anthropic/negotiation-lifecycle.ts` — 生命周期 primitive：`LearnedEntryMeta`、`NegotiationCategory`（10 值联合）、`NEGOTIATION_CATEGORIES`（值数组，供穷尽/遍历）、`isEntryActive`、`entryStatus`、`categoryTtlMs`、`nowMs`。**无副作用、可独立测**。
- Modify `src/lib/anthropic/feature-negotiation.ts` — 10 个内存 Map 升级 `Map<string, Map<string, LearnedEntryMeta>>`；扁平集合升 `Map<string, LearnedEntryMeta>`；efforts 升 `Map<string, {values, meta}>`；`addToSetMap`→`recordEntry`（meta-aware）；migration；reader 门控；mutations + resolver + snapshot/export；reset 助手。
- Create `src/routes/negotiation/route.ts` — OpenAPIHono 路由。
- Modify `src/routes/index.ts` — 挂 `/api/negotiation`（须在 `registerOpenApiDocs` 前）。
- Modify `src/lib/config/schema.ts` — 加 `negotiation_learning` 到 `ConfigSchema`（顶层）。
- Modify `src/lib/config/config.ts` — `applyConfigToState` 接线。
- Modify `src/lib/state.ts` — `MutableState` 两字段 + `CONFIG_MANAGED_DEFAULTS` 两默认 + setter + clone 站点。
- Modify `src/routes/config/route.ts` — `mergeConfigIntoDocument` 专用分支。
- Tests: `tests/anthropic/negotiation-lifecycle.unit.test.ts`、扩 `tests/anthropic/feature-negotiation.unit.test.ts`、`tests/routes/negotiation-route.http.test.ts`、扩 config guard 测试。

---

## Task B1: 生命周期 primitive（negotiation-lifecycle.ts）

**Files:**
- Create: `src/lib/anthropic/negotiation-lifecycle.ts`
- Test: `tests/anthropic/negotiation-lifecycle.unit.test.ts`

**Interfaces:**
- Produces:
  - `interface LearnedEntryMeta { firstLearnedAt: number; lastConfirmedAt: number; pinned?: boolean; manuallyExpired?: boolean; migrated?: boolean }`
  - `type NegotiationCategory = "features" | "betas" | "efforts" | "effortUnsupported" | "deferredTools" | "serverTools" | "partnerFeatures" | "systemRejectModels" | "serverToolDowngrade" | "toolFields"`
  - `const NEGOTIATION_CATEGORIES: ReadonlyArray<NegotiationCategory>`
  - `type EntryStatus = "active" | "expired" | "pinned" | "manually_expired"`
  - `function nowMs(): number`
  - `function categoryTtlMs(category: NegotiationCategory): number`（读 state；`Infinity`=never）
  - `function isEntryActive(meta: LearnedEntryMeta, category: NegotiationCategory, now: number): boolean`
  - `function entryStatus(meta: LearnedEntryMeta, category: NegotiationCategory, now: number): EntryStatus`
  - `function entryExpiresAt(meta: LearnedEntryMeta, category: NegotiationCategory): number | null`（派生；pin/never→null）

- [ ] **Step 1: 写失败测试**

`tests/anthropic/negotiation-lifecycle.unit.test.ts`:
```ts
import { describe, expect, test } from "bun:test"

import {
  categoryTtlMs,
  entryExpiresAt,
  entryStatus,
  isEntryActive,
  type LearnedEntryMeta,
  NEGOTIATION_CATEGORIES,
} from "~/lib/anthropic/negotiation-lifecycle"

const DAY = 86_400_000
function meta(over: Partial<LearnedEntryMeta> = {}): LearnedEntryMeta {
  return { firstLearnedAt: 0, lastConfirmedAt: 0, ...over }
}

describe("negotiation-lifecycle", () => {
  test("NEGOTIATION_CATEGORIES has all 10", () => {
    expect(NEGOTIATION_CATEGORIES.length).toBe(10)
    expect(new Set(NEGOTIATION_CATEGORIES).size).toBe(10)
  })

  test("default TTL is 30d for an unconfigured category", () => {
    expect(categoryTtlMs("features")).toBe(30 * DAY)
  })

  test("active within TTL, expired past it", () => {
    const m = meta({ lastConfirmedAt: 0 })
    expect(isEntryActive(m, "features", 29 * DAY)).toBe(true)
    expect(isEntryActive(m, "features", 31 * DAY)).toBe(false)
  })

  test("pinned is always active + status pinned + no expiry", () => {
    const m = meta({ pinned: true, lastConfirmedAt: 0 })
    expect(isEntryActive(m, "features", 999 * DAY)).toBe(true)
    expect(entryStatus(m, "features", 999 * DAY)).toBe("pinned")
    expect(entryExpiresAt(m, "features")).toBeNull()
  })

  test("manuallyExpired is dead + status manually_expired (pin overrides)", () => {
    expect(isEntryActive(meta({ manuallyExpired: true }), "features", 0)).toBe(false)
    expect(entryStatus(meta({ manuallyExpired: true }), "features", 0)).toBe("manually_expired")
    // pin wins over manuallyExpired
    expect(isEntryActive(meta({ manuallyExpired: true, pinned: true }), "features", 0)).toBe(true)
  })

  test("entryStatus active vs expired by time", () => {
    expect(entryStatus(meta(), "features", 10 * DAY)).toBe("active")
    expect(entryStatus(meta(), "features", 40 * DAY)).toBe("expired")
  })
})
```

- [ ] **Step 2: 跑红**

Run: `bun test tests/anthropic/negotiation-lifecycle.unit.test.ts`
Expected: FAIL — Cannot find module `negotiation-lifecycle`.

- [ ] **Step 3: 实现**

`src/lib/anthropic/negotiation-lifecycle.ts`:
```ts
/**
 * 反应式学习记录的生命周期 primitive（单一过期判据）。
 *
 * 无副作用、不改内存缓存 —— 纯函数 + 读 state 的 TTL 配置。所有消费点经
 * `isEntryActive` 判定过期，不各自判。`categoryTtlMs` 读运行时 config（hot-reload）。
 */
import { state } from "~/lib/state"

export interface LearnedEntryMeta {
  /** 首次学到（epoch ms）。migrated 记录为迁移时刻，非真实首学。 */
  firstLearnedAt: number
  /** 最后确认（epoch ms）。上游再拒 / 用户续约时刷新 —— TTL 基准。 */
  lastConfirmedAt: number
  /** true = 永不过期（无视 TTL / manuallyExpired）。 */
  pinned?: boolean
  /** 立即失效：强制过期但保留行；再确认 / 续约时清除。 */
  manuallyExpired?: boolean
  /** 由 v1 永久记录迁移而来 —— firstLearnedAt 非真实首学时刻。 */
  migrated?: boolean
}

export type NegotiationCategory =
  | "features"
  | "betas"
  | "efforts"
  | "effortUnsupported"
  | "deferredTools"
  | "serverTools"
  | "partnerFeatures"
  | "systemRejectModels"
  | "serverToolDowngrade"
  | "toolFields"

/** 全部 10 个分类 —— 遍历 / 穷尽用。顺序即 UI/快照展示顺序。 */
export const NEGOTIATION_CATEGORIES: ReadonlyArray<NegotiationCategory> = [
  "features",
  "betas",
  "efforts",
  "effortUnsupported",
  "deferredTools",
  "serverTools",
  "partnerFeatures",
  "systemRejectModels",
  "serverToolDowngrade",
  "toolFields",
]

export type EntryStatus = "active" | "expired" | "pinned" | "manually_expired"

export function nowMs(): number {
  return Date.now()
}

/**
 * 分类的 TTL（ms）。读 state 的 negotiation 配置切片：per-category 覆盖优先，
 * 否则默认。`Number.POSITIVE_INFINITY` = never（不自动过期）。
 */
export function categoryTtlMs(category: NegotiationCategory): number {
  const override = state.negotiationTtlOverridesMs[category]
  if (override !== undefined) return override
  return state.negotiationDefaultTtlMs
}

export function isEntryActive(meta: LearnedEntryMeta, category: NegotiationCategory, now: number): boolean {
  if (meta.pinned) return true
  if (meta.manuallyExpired) return false
  const ttl = categoryTtlMs(category)
  if (ttl === Number.POSITIVE_INFINITY) return true
  return now <= meta.lastConfirmedAt + ttl
}

export function entryStatus(meta: LearnedEntryMeta, category: NegotiationCategory, now: number): EntryStatus {
  if (meta.pinned) return "pinned"
  if (meta.manuallyExpired) return "manually_expired"
  return isEntryActive(meta, category, now) ? "active" : "expired"
}

/** 派生过期时刻（epoch ms）；pin 或 never → null（不适用）。 */
export function entryExpiresAt(meta: LearnedEntryMeta, category: NegotiationCategory): number | null {
  if (meta.pinned) return null
  const ttl = categoryTtlMs(category)
  if (ttl === Number.POSITIVE_INFINITY) return null
  return meta.lastConfirmedAt + ttl
}
```

> **Note（B6 依赖）**：本文件读 `state.negotiationDefaultTtlMs` / `state.negotiationTtlOverridesMs`。这两个字段在 B6 加入 state。**B1 与 B6 有序**：若先做 B1，须先在 `src/lib/state.ts` 的 `CONFIG_MANAGED_DEFAULTS` + `MutableState` 落这两字段的默认值（B6 Step-defaults，见 B6），再补 config 接线。推荐执行序：先做 B6 的 state-默认部分 → B1 → 回 B6 补 config。

- [ ] **Step 4: 跑绿**

Run: `bun test tests/anthropic/negotiation-lifecycle.unit.test.ts`
Expected: PASS（需 state 两字段已存在 —— 见上 Note，先落 B6 state 默认）。

- [ ] **Step 5: 提交**

```bash
git add -- src/lib/anthropic/negotiation-lifecycle.ts tests/anthropic/negotiation-lifecycle.unit.test.ts
git commit -F - -- src/lib/anthropic/negotiation-lifecycle.ts tests/anthropic/negotiation-lifecycle.unit.test.ts <<'EOF'
feat: negotiation-lifecycle primitive (isEntryActive/TTL/status)

Single expiry adjudicator for reactive learning records: per-entry meta,
per-category TTL (default 30d, Infinity=never), pinned/manuallyExpired.
EOF
```

---

## Task B2: v2 元数据存储 + v1→v2 迁移（feature-negotiation.ts 核心升级）

改内存表示为 meta-aware，并保证旧 `negotiation-states.json` 无损迁移。**这是最大一步**，逐子步做。

**Files:**
- Modify: `src/lib/anthropic/feature-negotiation.ts`（内存 Map 类型 + `addToSetMap`→`recordEntry` + `NegotiationStateFile` v2 + persist/load + migration）
- Test: `tests/anthropic/feature-negotiation.unit.test.ts`（新增迁移/持久化断言；现有断言须继续绿）

**Interfaces:**
- Consumes: B1 的 `LearnedEntryMeta` / `NEGOTIATION_CATEGORIES` / `nowMs`。
- Produces（内部，供 B3–B5）：
  - `Map<string, Map<string, LearnedEntryMeta>>` for features/betas/deferredTools/serverTools/partnerFeatures/toolFields。
  - `Map<string, LearnedEntryMeta>` for effortUnsupported/systemRejectModels/serverToolDowngrade。
  - `Map<string, { values: Array<string>; meta: LearnedEntryMeta }>` for efforts。
  - `function recordEntry(map: Map<string, Map<string, LearnedEntryMeta>>, key: string, value: string, now: number): boolean` —— 新建 firstLearnedAt+lastConfirmedAt，re-hit 刷新 lastConfirmedAt + 清 manuallyExpired；**返回值 = 「value 是否此前不存在」**（保 addToSetMap 原语义）。
  - `function touchFlagMeta(meta: LearnedEntryMeta, now: number): void` —— re-hit 刷新（lastConfirmedAt=now、清 manuallyExpired）。

- [ ] **Step 1: 写失败测试（迁移 + v2 持久化）**

追加到 `tests/anthropic/feature-negotiation.unit.test.ts`（沿用文件既有 beforeAll/afterEach 沙箱 harness）:
```ts
import { getGroupedSnapshot } from "~/lib/anthropic/feature-negotiation" // B5 导出；B2 阶段先只测 migration+persist

describe("v1 → v2 migration", () => {
  test("loads a legacy v1 file and stamps migrated meta", async () => {
    clearAnthropicFeatureNegotiationForTests()
    const v1 = {
      version: 1,
      features: { "url|anthropic-messages|opus": ["context_management"] },
      betas: {},
      efforts: { opus: ["low", "high"] },
      effortUnsupported: ["haiku"],
      deferredTools: {},
      serverTools: {},
      partnerFeatures: {},
      systemRejectModels: [],
      serverToolHistoryDowngrade: ["sonnet"], // legacy key
      toolFields: {},
    }
    await fs.writeFile(PATHS.NEGOTIATION_STATES, JSON.stringify(v1))
    await loadPersistedFeatureNegotiation()
    // learned facts survive
    expect(isAnthropicFeatureUnsupported("opus", "context_management")).toBe(true)
    expect(getSupportedEfforts("opus")).toEqual(["low", "high"])
    expect(isEffortUnsupported("haiku")).toBe(true)
    expect(isServerToolDowngradeLearned("sonnet")).toBe(true) // legacy key read
  })

  test("persist writes version 2 and drops legacy key", async () => {
    clearAnthropicFeatureNegotiationForTests()
    markServerToolDowngrade("sonnet")
    await persistFeatureNegotiation()
    const raw = JSON.parse(await fs.readFile(PATHS.NEGOTIATION_STATES, "utf8"))
    expect(raw.version).toBe(2)
    expect(raw.serverToolHistoryDowngrade).toBeUndefined()
    // v2 shape: value → meta object with timestamps
    const key = Object.keys(raw.serverToolDowngrade)[0]
    expect(typeof raw.serverToolDowngrade[key].firstLearnedAt).toBe("number")
    expect(typeof raw.serverToolDowngrade[key].lastConfirmedAt).toBe("number")
  })
})
```

- [ ] **Step 2: 跑红**

Run: `bun test tests/anthropic/feature-negotiation.unit.test.ts -t "migration"`
Expected: FAIL（version 仍 1；v2 shape 不匹配；getGroupedSnapshot import 缺 —— 若 B5 未做，先删该 import，只保留 migration 断言）。

- [ ] **Step 3: 实现（feature-negotiation.ts 结构升级）**

3a. 改 10 个内存声明（[feature-negotiation.ts:74-100](../../../src/lib/anthropic/feature-negotiation.ts#L74-L100)）：
```ts
import { type LearnedEntryMeta, NEGOTIATION_CATEGORIES, nowMs } from "~/lib/anthropic/negotiation-lifecycle"

/** features[modelKey] = Map<field, meta> */
const unsupportedFeatures = new Map<string, Map<string, LearnedEntryMeta>>()
const unsupportedBetas = new Map<string, Map<string, LearnedEntryMeta>>()
/** efforts[model] = { ordered supported list, meta } */
const supportedEfforts = new Map<string, { values: Array<string>; meta: LearnedEntryMeta }>()
/** flat membership sets → Map<model, meta> */
const effortUnsupportedModels = new Map<string, LearnedEntryMeta>()
const stickyUndeferredTools = new Map<string, Map<string, LearnedEntryMeta>>()
const unsupportedServerTools = new Map<string, Map<string, LearnedEntryMeta>>()
const unsupportedPartnerFeatures = new Map<string, Map<string, LearnedEntryMeta>>()
const learnedSystemRejectModels = new Map<string, LearnedEntryMeta>()
const serverToolDowngradeModels = new Map<string, LearnedEntryMeta>()
const unsupportedToolFields = new Map<string, Map<string, LearnedEntryMeta>>()
```

3b. `addToSetMap` → `recordEntry`（meta-aware）+ `touchFlagMeta`（扁平集合 re-hit）:
```ts
/**
 * 记录一条 (key, value) 学习条目，返回「value 此前是否不存在」（保 addToSetMap 原语义，
 * 供依赖该布尔的策略）。副作用：新建设 first+last；re-hit 刷新 lastConfirmedAt + 清 manuallyExpired。
 */
function recordEntry(map: Map<string, Map<string, LearnedEntryMeta>>, key: string, value: string, now: number): boolean {
  let inner = map.get(key)
  if (!inner) {
    inner = new Map()
    map.set(key, inner)
  }
  const existing = inner.get(value)
  if (existing) {
    existing.lastConfirmedAt = now
    delete existing.manuallyExpired
    return false
  }
  inner.set(value, { firstLearnedAt: now, lastConfirmedAt: now })
  return true
}

/** 扁平集合 / efforts 的 meta re-confirm：刷新 lastConfirmedAt + 清 manuallyExpired。 */
function touchFlagMeta(meta: LearnedEntryMeta, now: number): void {
  meta.lastConfirmedAt = now
  delete meta.manuallyExpired
}
```

3c. `NegotiationStateFile` v2 + snapshot/load 迁移（替换 [feature-negotiation.ts:363-500](../../../src/lib/anthropic/feature-negotiation.ts#L363-L500) 区段）:
```ts
type MetaRecordMap = Record<string, Record<string, LearnedEntryMeta>>
type MetaFlatMap = Record<string, LearnedEntryMeta>

interface NegotiationStateFileV2 {
  version: 2
  features: MetaRecordMap
  betas: MetaRecordMap
  efforts: Record<string, { values: Array<string>; meta: LearnedEntryMeta }>
  effortUnsupported: MetaFlatMap
  deferredTools: MetaRecordMap
  serverTools: MetaRecordMap
  partnerFeatures: MetaRecordMap
  systemRejectModels: MetaFlatMap
  serverToolDowngrade: MetaFlatMap
  toolFields: MetaRecordMap
}

function snapshotRecordMap(map: Map<string, Map<string, LearnedEntryMeta>>): MetaRecordMap {
  const out: MetaRecordMap = {}
  for (const [key, inner] of map) {
    if (inner.size === 0) continue
    const o: Record<string, LearnedEntryMeta> = {}
    for (const [v, meta] of inner) o[v] = meta
    out[key] = o
  }
  return out
}
function snapshotFlatMap(map: Map<string, LearnedEntryMeta>): MetaFlatMap {
  const out: MetaFlatMap = {}
  for (const [key, meta] of map) out[key] = meta
  return out
}
```

persist（替换现 `persistFeatureNegotiation` body 的 `data`）:
```ts
  const data: NegotiationStateFileV2 = {
    version: 2,
    features: snapshotRecordMap(unsupportedFeatures),
    betas: snapshotRecordMap(unsupportedBetas),
    efforts: Object.fromEntries([...supportedEfforts].map(([k, { values, meta }]) => [k, { values: [...values], meta }])),
    effortUnsupported: snapshotFlatMap(effortUnsupportedModels),
    deferredTools: snapshotRecordMap(stickyUndeferredTools),
    serverTools: snapshotRecordMap(unsupportedServerTools),
    partnerFeatures: snapshotRecordMap(unsupportedPartnerFeatures),
    systemRejectModels: snapshotFlatMap(learnedSystemRejectModels),
    serverToolDowngrade: snapshotFlatMap(serverToolDowngradeModels),
    toolFields: snapshotRecordMap(unsupportedToolFields),
  }
```

load（替换 `loadPersistedFeatureNegotiation`）—— **同时接受 v1（数组）与 v2（meta）**：
```ts
function toMeta(now: number, migrated: boolean): LearnedEntryMeta {
  return migrated ? { firstLearnedAt: now, lastConfirmedAt: now, migrated: true } : { firstLearnedAt: now, lastConfirmedAt: now }
}

/** v1 数组 或 v2 {value:meta} → Map<value, meta>。 */
function loadRecordInner(source: unknown, now: number): Map<string, LearnedEntryMeta> {
  const inner = new Map<string, LearnedEntryMeta>()
  if (Array.isArray(source)) {
    for (const v of source) if (typeof v === "string" && v) inner.set(v, toMeta(now, true))
  } else if (source && typeof source === "object") {
    for (const [v, m] of Object.entries(source as Record<string, unknown>)) {
      inner.set(v, coerceMeta(m, now))
    }
  }
  return inner
}
function coerceMeta(m: unknown, now: number): LearnedEntryMeta {
  if (m && typeof m === "object" && typeof (m as LearnedEntryMeta).lastConfirmedAt === "number") {
    return m as LearnedEntryMeta
  }
  return toMeta(now, true)
}
function loadRecordMap(target: Map<string, Map<string, LearnedEntryMeta>>, source: Record<string, unknown> | undefined, now: number): void {
  if (!source) return
  for (const [key, values] of Object.entries(source)) {
    const inner = loadRecordInner(values, now)
    if (inner.size > 0) target.set(key, inner)
  }
}
function loadFlatMap(target: Map<string, LearnedEntryMeta>, source: unknown, now: number): void {
  if (Array.isArray(source)) {
    for (const v of source) if (typeof v === "string" && v) target.set(v, toMeta(now, true))
  } else if (source && typeof source === "object") {
    for (const [k, m] of Object.entries(source as Record<string, unknown>)) target.set(k, coerceMeta(m, now))
  }
}

export async function loadPersistedFeatureNegotiation(): Promise<void> {
  try {
    const raw = await fs.readFile(PATHS.NEGOTIATION_STATES, "utf8")
    const data = JSON.parse(raw) as Record<string, unknown>
    if (data.version !== 1 && data.version !== 2) return
    const now = nowMs()
    loadRecordMap(unsupportedFeatures, data.features as Record<string, unknown> | undefined, now)
    loadRecordMap(unsupportedBetas, data.betas as Record<string, unknown> | undefined, now)
    // efforts: v1 = model→string[]; v2 = model→{values, meta}
    if (data.efforts && typeof data.efforts === "object") {
      for (const [model, val] of Object.entries(data.efforts as Record<string, unknown>)) {
        if (Array.isArray(val)) {
          const clean = val.filter((v): v is string => typeof v === "string" && v.length > 0)
          if (clean.length > 0) supportedEfforts.set(model, { values: clean, meta: toMeta(now, true) })
        } else if (val && typeof val === "object" && Array.isArray((val as { values?: unknown }).values)) {
          const vv = val as { values: Array<string>; meta?: unknown }
          supportedEfforts.set(model, { values: [...vv.values], meta: coerceMeta(vv.meta, now) })
        }
      }
    }
    loadFlatMap(effortUnsupportedModels, data.effortUnsupported, now)
    loadRecordMap(stickyUndeferredTools, data.deferredTools as Record<string, unknown> | undefined, now)
    loadRecordMap(unsupportedServerTools, data.serverTools as Record<string, unknown> | undefined, now)
    loadRecordMap(unsupportedPartnerFeatures, data.partnerFeatures as Record<string, unknown> | undefined, now)
    loadFlatMap(learnedSystemRejectModels, data.systemRejectModels, now)
    loadFlatMap(serverToolDowngradeModels, data.serverToolDowngrade ?? data.serverToolHistoryDowngrade, now)
    loadRecordMap(unsupportedToolFields, data.toolFields as Record<string, unknown> | undefined, now)
  } catch {
    // 文件不存在或损坏 — 从零开始
  }
}
```

3d. 更新 `clearNegotiationMaps`（[feature-negotiation.ts:508-519](../../../src/lib/anthropic/feature-negotiation.ts#L508-L519)）：类型不变（仍 `.clear()`），10 个 map 名不变 —— 无需改逻辑，仅确认编译通过。

> B2 阶段 marker/reader 尚未改（B3/B4 做）。为让文件编译，本步同时把 `addToSetMap` 调用替换为 `recordEntry(map, key, value, nowMs())`（6 处），把扁平 `.add` / `.has` marker 暂保持行为（B3 补 meta 刷新）。**具体**：`markX` 里 `addToSetMap(map, key, val)` → `recordEntry(map, key, val, nowMs())`；`markEffortUnsupported`/`markSystemRejectModel`/`markServerToolDowngrade` 的 `set.has/add` → `map.has/set(key, {firstLearnedAt:now,lastConfirmedAt:now})`；`setSupportedEfforts` 存 `{values, meta}`。reader 的 `.get(k)?.has(v)` 仍可用（Map.has，B4 加门控）；record getter `[...set]` → `[...inner.keys()]`。
>
> **L2（务必改）**：`getAllLearnedEfforts`（[feature-negotiation.ts:190-194](../../../src/lib/anthropic/feature-negotiation.ts#L190-L194)）现 `out[key] = [...value]`，v2 下 `value` 是 `{ values, meta }` → 改 `out[key] = [...value.values]`，否则编译错。此 reader 保持**原始**（无 live 消费者、供快照/导出），不加门控。
>
> **L4（务必保留）**：重写 `loadPersistedFeatureNegotiation` 时保留末尾的载入计数日志（原 [:494-496](../../../src/lib/anthropic/feature-negotiation.ts#L494-L496)）：迁移/加载后累加各 map size，`consola.info` 打 `Loaded ${total} negotiated entries`。

- [ ] **Step 4: 跑绿（迁移测试 + 全部既有测试）**

Run: `bun test tests/anthropic/feature-negotiation.unit.test.ts`
Expected: PASS（迁移新测 + 所有既有 mark/check/golden 测试继续绿 —— 既有测试是 B2 无回归的 oracle）。

- [ ] **Step 5: typecheck + lint + 提交**

Run: `bun run typecheck && bunx eslint src/lib/anthropic/feature-negotiation.ts`
```bash
git add -- src/lib/anthropic/feature-negotiation.ts tests/anthropic/feature-negotiation.unit.test.ts
git commit -F - -- src/lib/anthropic/feature-negotiation.ts tests/anthropic/feature-negotiation.unit.test.ts <<'EOF'
feat: v2 meta storage + v1→v2 migration for negotiation cache

Maps hold LearnedEntryMeta per value; load accepts legacy arrays (stamped
migrated) + v2 objects; persist writes version 2, drops legacy key.
EOF
```

---

## Task B3: markX 再确认（meta 刷新 vs changed 返回值分离，10 入口）

**Files:**
- Modify: `src/lib/anthropic/feature-negotiation.ts`（10 个 mark 入口 + efforts 互斥删除）
- Test: `tests/anthropic/feature-negotiation.unit.test.ts`

**Interfaces:**
- Consumes: B2 的 `recordEntry` / `touchFlagMeta` / `nowMs`。
- 红线（README #2）：re-hit 刷新 meta 是**副作用**；返回值语义不变。

- [ ] **Step 1: 写失败测试**
```ts
describe("markX re-confirm refreshes meta without changing return contract", () => {
  test("re-marking a feature refreshes lastConfirmedAt + clears manuallyExpired", async () => {
    clearAnthropicFeatureNegotiationForTests()
    markAnthropicFeatureUnsupported("m", "context_management")
    // simulate manual expire + time passing via snapshot inspection (B5), so here assert via persist:
    await persistFeatureNegotiation()
    const t1 = JSON.parse(await fs.readFile(PATHS.NEGOTIATION_STATES, "utf8"))
    const key1 = Object.keys(t1.features)[0]
    const first = t1.features[key1].context_management.lastConfirmedAt
    await new Promise((r) => setTimeout(r, 5))
    markAnthropicFeatureUnsupported("m", "context_management") // re-hit
    await persistFeatureNegotiation()
    const t2 = JSON.parse(await fs.readFile(PATHS.NEGOTIATION_STATES, "utf8"))
    expect(t2.features[key1].context_management.lastConfirmedAt).toBeGreaterThanOrEqual(first)
    expect(t2.features[key1].context_management.firstLearnedAt).toBe(t1.features[key1].context_management.firstLearnedAt)
  })

  test("setSupportedEfforts returns false on unchanged ACTIVE whitelist but still refreshes meta", async () => {
    clearAnthropicFeatureNegotiationForTests()
    expect(setSupportedEfforts("m", ["low", "high"])).toBe(true)
    expect(setSupportedEfforts("m", ["low", "high"])).toBe(false) // active + unchanged → false (loop guard)
    expect(getSupportedEfforts("m")).toEqual(["low", "high"])
  })

  test("setSupportedEfforts returns true when reviving an EXPIRED entry (H3)", () => {
    clearAnthropicFeatureNegotiationForTests()
    setSystemTime(new Date(0))
    setSupportedEfforts("m", ["low", "high"])
    setSystemTime(new Date(31 * 86_400_000)) // expired (default 30d)
    // same whitelist, but entry was inactive → revival → true (else effort strategy would abort)
    expect(setSupportedEfforts("m", ["low", "high"])).toBe(true)
    expect(getSupportedEfforts("m")).toEqual(["low", "high"]) // active again
    setSystemTime(new Date())
  })

  test("markEffortUnsupported drops sibling efforts meta (mutual exclusivity)", () => {
    clearAnthropicFeatureNegotiationForTests()
    setSupportedEfforts("m", ["low"])
    markEffortUnsupported("m")
    expect(getSupportedEfforts("m")).toBeUndefined()
    expect(isEffortUnsupported("m")).toBe(true)
  })
})
```

- [ ] **Step 2: 跑红** — Run: `bun test tests/anthropic/feature-negotiation.unit.test.ts -t "re-confirm"`. Expected: 部分 FAIL（efforts 互斥 meta 未清 / meta 未刷新）。

- [ ] **Step 3: 实现**

3a. 6 个走 `recordEntry` 的 marker：已在 B2 Step-3d 改为 `recordEntry(...)`，其 re-hit 刷新已含。确认 `markAnthropicFeatureUnsupported`/`markAnthropicBetaUnsupported`/`markToolUndeferred`/`markAnthropicServerToolUnsupported`/`markAnthropicPartnerFeatureUnsupported`/`markAnthropicUnsupportedToolFields` 各调 `recordEntry` 并 `schedulePersist()`（返回 true 或 false 都 persist，因 re-hit 刷了 meta）—— 现状仅 `if(changed) schedulePersist`，改为**始终 `schedulePersist()`**（re-hit 刷新也需落盘）。

3b. `setSupportedEfforts`（[feature-negotiation.ts:173-183](../../../src/lib/anthropic/feature-negotiation.ts#L173-L183)）—— 分离 meta 与返回值，**并处理过期条目复活**（H3，关键）:

> **H3 根因**：B4 门控 `getSupportedEfforts` 后，一条**已过期**的 effort 条目被上游以**相同**白名单再拒时，若仍返 false，则 `learnEffortsFromError`（[request-preparation.ts:685-688](../../../src/lib/anthropic/request-preparation.ts#L685-L688)）返 false → effort retry 策略（[effort-learning-retry.ts:73-77](../../../src/lib/request/strategies/effort-learning-retry.ts#L73-L77)）**放弃**，客户端吃 400——尽管重新准备本会 clamp 成功。且正常活跃期 `clampEffortLevel` 预剥、上游从不 400 → `lastConfirmedAt` 永不刷新 → effort 条目**每 ~30d 必过期一次**、下次请求失败一次。这是 efforts 独有（其余 void marker 的策略无条件重试、同请求自愈）。修法：条目**此前不活跃（复活）**时返 true（重新准备会不同），仅「此前活跃 + 白名单未变」才返 false（真正的 loop 守卫）。

```ts
import { isEntryActive } from "~/lib/anthropic/negotiation-lifecycle"

export function setSupportedEfforts(modelName: string, supported: Array<string>): boolean {
  const key = effortKey(modelName)
  const now = nowMs()
  effortUnsupportedModels.delete(key) // 互斥：设白名单撤销 unsupported（连 meta 一起删）
  const existing = supportedEfforts.get(key)
  if (existing) {
    const wasActive = isEntryActive(existing.meta, "efforts", now) // 复活判定须在 touchFlagMeta 之前
    const same = existing.values.length === supported.length && existing.values.every((e, i) => e === supported[i])
    touchFlagMeta(existing.meta, now) // 副作用：始终刷新 meta（含 re-hit / 复活）
    if (same && wasActive) {
      schedulePersist()
      return false // 真 loop 守卫：条目仍活跃却被同白名单再拒 = 无前进
    }
    // 白名单变了，或条目此前已过期（复活）—— 重新准备会不同，值得重试
    if (!same) existing.values = [...supported]
    schedulePersist()
    return true
  }
  supportedEfforts.set(key, { values: [...supported], meta: { firstLearnedAt: now, lastConfirmedAt: now } })
  schedulePersist()
  return true
}
```

3c. `markEffortUnsupported` / `markSystemRejectModel` / `markServerToolDowngrade`（扁平集合，[:204-211](../../../src/lib/anthropic/feature-negotiation.ts#L204-L211) / [:298-303](../../../src/lib/anthropic/feature-negotiation.ts#L298-L303) / [:320-325](../../../src/lib/anthropic/feature-negotiation.ts#L320-L325)）—— re-hit 刷新 + 互斥:
```ts
export function markEffortUnsupported(modelName: string): void {
  const key = effortKey(modelName)
  const now = nowMs()
  supportedEfforts.delete(key) // 互斥：连 sibling meta 一起删
  const existing = effortUnsupportedModels.get(key)
  if (existing) touchFlagMeta(existing.meta ?? existing, now) // flat map stores meta directly
  else effortUnsupportedModels.set(key, { firstLearnedAt: now, lastConfirmedAt: now })
  schedulePersist()
}
```
（`markSystemRejectModel` / `markServerToolDowngrade` 同构，无互斥删除，仅 re-hit 刷新 or 新建 + `schedulePersist()`。注意扁平 map 的值**就是** meta，故 `existing` 即 meta，`touchFlagMeta(existing, now)`。上例 `existing.meta ?? existing` 写错——扁平 map 值是 meta，直接 `touchFlagMeta(existing, now)`。）

修正版：
```ts
  const existing = effortUnsupportedModels.get(key)
  if (existing) touchFlagMeta(existing, now)
  else effortUnsupportedModels.set(key, { firstLearnedAt: now, lastConfirmedAt: now })
  schedulePersist()
```

- [ ] **Step 4: 跑绿** — Run: `bun test tests/anthropic/feature-negotiation.unit.test.ts`. Expected: PASS（全部，含既有）。

- [ ] **Step 5: typecheck + lint + 提交**
```bash
git add -- src/lib/anthropic/feature-negotiation.ts tests/anthropic/feature-negotiation.unit.test.ts
git commit -F - -- src/lib/anthropic/feature-negotiation.ts tests/anthropic/feature-negotiation.unit.test.ts <<'EOF'
feat: markX re-confirm refreshes meta, preserves changed-return contract

Re-hit refreshes lastConfirmedAt + clears manuallyExpired (side effect);
setSupportedEfforts still returns false on unchanged whitelist (retry driver);
effort ⇄ effortUnsupported mutual-exclusivity drops sibling meta.
EOF
```

---

## Task B4: reader 门控（12 个 exported reader 加 isEntryActive）

过期条目在**每个** reader 读作「未学过」。快照/导出（B5）读原始，不经此门控。

**Files:**
- Modify: `src/lib/anthropic/feature-negotiation.ts`（12 readers）
- Test: `tests/anthropic/feature-negotiation.unit.test.ts`（每分类一条过期守卫）

**门控 reader 清单**（红线 README #3）：`isAnthropicFeatureUnsupported`、`getUnsupportedFeatures`、`isAnthropicBetaUnsupported`、`getSupportedEfforts`、`isEffortUnsupported`、`isToolStickyUndeferred`、`getStickyUndeferredTools`、`getUnsupportedServerToolTypes`、`isAnthropicPartnerFeatureUnsupported`、`isSystemRejectModelLearned`、`isServerToolDowngradeLearned`、`getUnsupportedToolFields`。`getAllLearnedEfforts` 保持**原始**（快照/导出用，不门控）。

- [ ] **Step 1: 写失败测试（每分类一条；用 config TTL=Infinity 之外的可控法：直接把 lastConfirmedAt 推到过去不可行——meta 私有。改用「manuallyExpired 经 mutation」验门控」）**

> 门控由 TTL 时间驱动，但测试不宜依赖真实 30d。用 **B5 的 `expireEntry`**（manuallyExpired=true）作过期注入 oracle（manuallyExpired 也走 isEntryActive→false）。故本守卫测试依赖 B5 的 mutation。**执行序**：B4 先加门控代码，守卫测试在 B5 落地后补齐（B5 Step 增「每分类门控守卫」）。B4 阶段用一条 fake-timers 版验时间维度：

```ts
import { setSystemTime } from "bun:test"
describe("reader gating by TTL (features)", () => {
  test("feature reads active within TTL, not-learned past it", () => {
    clearAnthropicFeatureNegotiationForTests()
    setSystemTime(new Date(0))
    markAnthropicFeatureUnsupported("m", "context_management")
    expect(isAnthropicFeatureUnsupported("m", "context_management")).toBe(true)
    setSystemTime(new Date(31 * 86_400_000)) // 31d later, default 30d TTL
    expect(isAnthropicFeatureUnsupported("m", "context_management")).toBe(false)
    setSystemTime(new Date()) // restore
  })
})
```
（其余 9 分类同构，各一条：betas/efforts/effortUnsupported/deferredTools/serverTools/partnerFeatures/systemRejectModels/serverToolDowngrade/toolFields。**M1 注意 shipped 默认非一律 30d**：`toolFields` 默认 90d → 该分类守卫用 `>90d`（如 `new Date(91 * DAY)`）;`partnerFeatures` 默认 never（Infinity）→ 时间维度无法过期，改用 B5 的 `expireEntry` 注入过期（见 B5 Step-5 每分类守卫），或该测试前 `setNegotiationConfig({ negotiationTtlOverridesMs: { partnerFeatures: 30 * 86_400_000 } })` 覆到有限值。`clearAnthropicFeatureNegotiationForTests` 只清 map、不清 config，故 config 默认在测试中生效。）

- [ ] **Step 2: 跑红** — Expected: FAIL（31d 后仍返 true —— 无门控）。

- [ ] **Step 3: 实现（每 reader 包 isEntryActive）**。示例（其余同构）:
```ts
import { isEntryActive, nowMs } from "~/lib/anthropic/negotiation-lifecycle"

export function isAnthropicFeatureUnsupported(modelId: string, feature: AnthropicNegotiatedFeature): boolean {
  const meta = unsupportedFeatures.get(modelKey(modelId))?.get(feature)
  return meta ? isEntryActive(meta, "features", nowMs()) : false
}

export function getUnsupportedFeatures(modelId: string): Array<string> {
  const inner = unsupportedFeatures.get(modelKey(modelId))
  if (!inner) return []
  const now = nowMs()
  return [...inner].filter(([, meta]) => isEntryActive(meta, "features", now)).map(([v]) => v)
}
```
逐一改：betas（category `"betas"`）、`getSupportedEfforts`（efforts；`const e = supportedEfforts.get(key); return e && isEntryActive(e.meta, "efforts", nowMs()) ? [...e.values] : undefined`）、`isEffortUnsupported`（effortUnsupported）、deferredTools 两 reader、serverTools getter、partnerFeatures、systemRejectModels、serverToolDowngrade、toolFields getter。分类字面量对应 map。

- [ ] **Step 4: 跑绿** — Run: `bun test tests/anthropic/feature-negotiation.unit.test.ts`. Expected: PASS（含既有——既有 mark/check 在 t=now 仍活跃，不受影响）。

- [ ] **Step 5: grep 消费点核对 + 提交**

Run: `grep -rn "isAnthropicFeatureUnsupported\|getUnsupportedFeatures\|isAnthropicBetaUnsupported\|getSupportedEfforts\|isEffortUnsupported\|isToolStickyUndeferred\|getStickyUndeferredTools\|getUnsupportedServerToolTypes\|isAnthropicPartnerFeatureUnsupported\|isSystemRejectModelLearned\|isServerToolDowngradeLearned\|getUnsupportedToolFields" src/ | grep -v feature-negotiation.ts`
Expected: 每个消费点现在自动获得门控（门控在 reader 内，调用方无需改）。核对无遗漏 reader。
```bash
git add -- src/lib/anthropic/feature-negotiation.ts tests/anthropic/feature-negotiation.unit.test.ts
git commit -F - -- src/lib/anthropic/feature-negotiation.ts tests/anthropic/feature-negotiation.unit.test.ts <<'EOF'
feat: gate all 12 negotiation readers by isEntryActive (expiry)

Expired entries read as not-learned at every consume site; snapshot/export
stay raw. Per-category TTL guard tests (fake system time).
EOF
```

---

## Task B5: mutations + resolver + snapshot/export

**Files:**
- Modify: `src/lib/anthropic/feature-negotiation.ts`（resolver + `renewEntry`/`expireEntry`/`setPinned`/`deleteEntry`/`getGroupedSnapshot`/`exportAll`）
- Test: `tests/anthropic/feature-negotiation.unit.test.ts`

**Interfaces:**
- Consumes: B1（`NegotiationCategory`/`entryStatus`/`entryExpiresAt`/`nowMs`/`NEGOTIATION_CATEGORIES`）。
- Produces（B7 消费）：
  - `interface LearnedEntryView { category: NegotiationCategory; key: string; value: string; detail?: unknown; firstLearnedAt: number; lastConfirmedAt: number; expiresAt: number | null; status: EntryStatus; pinned: boolean; migrated: boolean }`
  - `interface LearnedSnapshot { categories: Array<{ category: NegotiationCategory; ttlMs: number | null; entries: Array<LearnedEntryView> }> }`
  - `function getGroupedSnapshot(): LearnedSnapshot`
  - `function exportAll(): NegotiationStateFileV2`
  - `function renewEntry(category, key, value): LearnedEntryView | null` / `expireEntry(...): LearnedEntryView | null` / `setPinned(category, key, value, pinned): LearnedEntryView | null` —— 命中则返回更新后的 view（richest-data-flow，履行冻结契约 `{ok, entry}`），未命中返 `null`（→ 404）。`deleteEntry(category, key, value): boolean`（删后无 view，返是否命中）。

- [ ] **Step 1: 写失败测试**
```ts
import {
  deleteEntry, expireEntry, exportAll, getGroupedSnapshot, renewEntry, setPinned,
} from "~/lib/anthropic/feature-negotiation"

describe("mutations + snapshot", () => {
  test("snapshot groups all 10 categories with ttl + entries", () => {
    clearAnthropicFeatureNegotiationForTests()
    markAnthropicFeatureUnsupported("m", "context_management")
    const snap = getGroupedSnapshot()
    expect(snap.categories.length).toBe(10)
    const feat = snap.categories.find((c) => c.category === "features")!
    expect(feat.entries[0].value).toBe("context_management")
    expect(feat.entries[0].status).toBe("active")
  })

  test("expireEntry sets manually_expired, keeps row; miss returns null", () => {
    clearAnthropicFeatureNegotiationForTests()
    markAnthropicBetaUnsupported("m", "beta-x")
    expect(expireEntry("betas", "", "beta-x")).toBeNull() // wrong key (betas needs real modelKey) → miss
    const e = getGroupedSnapshot().categories.find((c) => c.category === "betas")!.entries[0]
    const view = expireEntry("betas", e.key, e.value)
    expect(view?.status).toBe("manually_expired") // row kept, view returned
  })

  test("efforts addressing: key='' value=model; setPinned returns updated view", () => {
    clearAnthropicFeatureNegotiationForTests()
    setSupportedEfforts("opus", ["low"])
    expect(setPinned("efforts", "", "opus", true)?.status).toBe("pinned")
    const snap = getGroupedSnapshot()
    expect(snap.categories.find((c) => c.category === "efforts")!.entries[0].status).toBe("pinned")
  })

  test("delete removes; missing entry returns false", () => {
    clearAnthropicFeatureNegotiationForTests()
    markSystemRejectModel("m")
    expect(deleteEntry("systemRejectModels", "", "m")).toBe(true)
    expect(deleteEntry("systemRejectModels", "", "m")).toBe(false)
  })

  test("exportAll returns version 2 dataset", () => {
    clearAnthropicFeatureNegotiationForTests()
    markAnthropicFeatureUnsupported("m", "f")
    expect(exportAll().version).toBe(2)
  })
})
```
> **寻址修正**（README 契约 + spec §4.4）：features/betas/deferredTools/serverTools/partnerFeatures/toolFields → `key=<内部 map key>`（modelKey/endpointKey）、`value=<叶子值>`；efforts/effortUnsupported/systemRejectModels/serverToolDowngrade → `key=""`、`value=<model>`。上面 `expireEntry("betas","","beta-x")` 传空 key 对 betas 是**未命中**（betas 需真实 modelKey）。测试用 snapshot 回读的 `entry.key` 作寻址入参更稳（见下）。改测试：先 `getGroupedSnapshot()` 取 `entry.key`，再 `expireEntry(category, entry.key, entry.value)`。

- [ ] **Step 2: 跑红** — Expected: FAIL（函数未导出）。

- [ ] **Step 3: 实现（resolver + mutations + snapshot）**
```ts
import { entryExpiresAt, entryStatus, type EntryStatus, type LearnedEntryMeta, type NegotiationCategory, NEGOTIATION_CATEGORIES, categoryTtlMs, nowMs } from "~/lib/anthropic/negotiation-lifecycle"

export interface LearnedEntryView {
  category: NegotiationCategory
  key: string
  value: string
  detail?: unknown
  firstLearnedAt: number
  lastConfirmedAt: number
  expiresAt: number | null
  status: EntryStatus
  pinned: boolean
  migrated: boolean
}
export interface LearnedSnapshot {
  categories: Array<{ category: NegotiationCategory; ttlMs: number | null; entries: Array<LearnedEntryView> }>
}

/** 分类 → meta 定位。record 类：(key,value)；flat/efforts：value=model, key 忽略。返回 meta 或 undefined。 */
function locateMeta(category: NegotiationCategory, key: string, value: string): LearnedEntryMeta | undefined {
  switch (category) {
    case "features": return unsupportedFeatures.get(key)?.get(value)
    case "betas": return unsupportedBetas.get(key)?.get(value)
    case "deferredTools": return stickyUndeferredTools.get(key)?.get(value)
    case "serverTools": return unsupportedServerTools.get(key)?.get(value)
    case "partnerFeatures": return unsupportedPartnerFeatures.get(key)?.get(value)
    case "toolFields": return unsupportedToolFields.get(key)?.get(value)
    case "efforts": return supportedEfforts.get(value)?.meta
    case "effortUnsupported": return effortUnsupportedModels.get(value)
    case "systemRejectModels": return learnedSystemRejectModels.get(value)
    case "serverToolDowngrade": return serverToolDowngradeModels.get(value)
    default: { const _exhaustive: never = category; return _exhaustive } // L1: 编译期穷尽守卫
  }
}

/** efforts 的 detail（values）供 view 用；其余分类无 detail。 */
function locateDetail(category: NegotiationCategory, value: string): unknown {
  return category === "efforts" ? supportedEfforts.get(value)?.values : undefined
}

/** 命中则构建更新后的 view（renew/expire/pin 履行 {ok, entry} 契约）。 */
function viewFor(category: NegotiationCategory, key: string, value: string): LearnedEntryView | null {
  const meta = locateMeta(category, key, value)
  if (!meta) return null
  return viewOf(category, key, value, meta, nowMs(), locateDetail(category, value))
}

function deleteLocated(category: NegotiationCategory, key: string, value: string): boolean {
  switch (category) {
    case "features": return unsupportedFeatures.get(key)?.delete(value) ?? false
    case "betas": return unsupportedBetas.get(key)?.delete(value) ?? false
    case "deferredTools": return stickyUndeferredTools.get(key)?.delete(value) ?? false
    case "serverTools": return unsupportedServerTools.get(key)?.delete(value) ?? false
    case "partnerFeatures": return unsupportedPartnerFeatures.get(key)?.delete(value) ?? false
    case "toolFields": return unsupportedToolFields.get(key)?.delete(value) ?? false
    case "efforts": return supportedEfforts.delete(value)
    case "effortUnsupported": return effortUnsupportedModels.delete(value)
    case "systemRejectModels": return learnedSystemRejectModels.delete(value)
    case "serverToolDowngrade": return serverToolDowngradeModels.delete(value)
    default: { const _exhaustive: never = category; return _exhaustive } // L1: 编译期穷尽守卫
  }
}

export function renewEntry(category: NegotiationCategory, key: string, value: string): LearnedEntryView | null {
  const meta = locateMeta(category, key, value)
  if (!meta) return null
  meta.lastConfirmedAt = nowMs()
  delete meta.manuallyExpired
  schedulePersist()
  return viewFor(category, key, value)
}
export function expireEntry(category: NegotiationCategory, key: string, value: string): LearnedEntryView | null {
  const meta = locateMeta(category, key, value)
  if (!meta) return null
  meta.manuallyExpired = true
  schedulePersist()
  return viewFor(category, key, value)
}
export function setPinned(category: NegotiationCategory, key: string, value: string, pinned: boolean): LearnedEntryView | null {
  const meta = locateMeta(category, key, value)
  if (!meta) return null
  if (pinned) meta.pinned = true
  else delete meta.pinned
  schedulePersist()
  return viewFor(category, key, value)
}
export function deleteEntry(category: NegotiationCategory, key: string, value: string): boolean {
  const hit = deleteLocated(category, key, value)
  if (hit) schedulePersist()
  return hit
}
```

snapshot（读原始 map，逐分类构 view）:
```ts
function ttlOrNull(category: NegotiationCategory): number | null {
  const ttl = categoryTtlMs(category)
  return ttl === Number.POSITIVE_INFINITY ? null : ttl
}
function viewOf(category: NegotiationCategory, key: string, value: string, meta: LearnedEntryMeta, now: number, detail?: unknown): LearnedEntryView {
  return {
    category, key, value, detail,
    firstLearnedAt: meta.firstLearnedAt,
    lastConfirmedAt: meta.lastConfirmedAt,
    expiresAt: entryExpiresAt(meta, category),
    status: entryStatus(meta, category, now),
    pinned: Boolean(meta.pinned),
    migrated: Boolean(meta.migrated),
  }
}

export function getGroupedSnapshot(): LearnedSnapshot {
  const now = nowMs()
  const recordMaps: Array<[NegotiationCategory, Map<string, Map<string, LearnedEntryMeta>>]> = [
    ["features", unsupportedFeatures], ["betas", unsupportedBetas], ["deferredTools", stickyUndeferredTools],
    ["serverTools", unsupportedServerTools], ["partnerFeatures", unsupportedPartnerFeatures], ["toolFields", unsupportedToolFields],
  ]
  const flatMaps: Array<[NegotiationCategory, Map<string, LearnedEntryMeta>]> = [
    ["effortUnsupported", effortUnsupportedModels], ["systemRejectModels", learnedSystemRejectModels], ["serverToolDowngrade", serverToolDowngradeModels],
  ]
  const byCategory = new Map<NegotiationCategory, Array<LearnedEntryView>>()
  for (const [cat, map] of recordMaps) {
    const entries: Array<LearnedEntryView> = []
    for (const [key, inner] of map) for (const [value, meta] of inner) entries.push(viewOf(cat, key, value, meta, now))
    byCategory.set(cat, entries)
  }
  for (const [cat, map] of flatMaps) {
    const entries: Array<LearnedEntryView> = []
    for (const [value, meta] of map) entries.push(viewOf(cat, "", value, meta, now))
    byCategory.set(cat, entries)
  }
  const effortEntries: Array<LearnedEntryView> = []
  for (const [model, { values, meta }] of supportedEfforts) effortEntries.push(viewOf("efforts", "", model, meta, now, values))
  byCategory.set("efforts", effortEntries)

  return {
    categories: NEGOTIATION_CATEGORIES.map((category) => ({
      category, ttlMs: ttlOrNull(category), entries: byCategory.get(category) ?? [],
    })),
  }
}

export function exportAll(): NegotiationStateFileV2 {
  // 与 persist 同形（原始，不门控）——复用 persist 的 data 构造。抽出共享 `buildV2Snapshot()`：
  return buildV2Snapshot()
}
```
> 重构 persist：把 `persistFeatureNegotiation` 里的 `data` 构造抽成 `function buildV2Snapshot(): NegotiationStateFileV2 { return { version: 2, ... } }`，persist 与 exportAll 共用（DRY）。

- [ ] **Step 4: 跑绿** — Run: `bun test tests/anthropic/feature-negotiation.unit.test.ts`. Expected: PASS。

- [ ] **Step 5: 补 B4 的每分类「manually_expired 门控」守卫（用 expireEntry 注入）+ 提交**
```ts
test("every category: expireEntry makes reader read not-learned", () => {
  clearAnthropicFeatureNegotiationForTests()
  markAnthropicFeatureUnsupported("m", "f")
  const e = getGroupedSnapshot().categories.find((c) => c.category === "features")!.entries[0]
  expireEntry("features", e.key, e.value)
  expect(isAnthropicFeatureUnsupported("m", "f")).toBe(false) // manually_expired → reader gated
})
```
```bash
git add -- src/lib/anthropic/feature-negotiation.ts tests/anthropic/feature-negotiation.unit.test.ts
git commit -F - -- src/lib/anthropic/feature-negotiation.ts tests/anthropic/feature-negotiation.unit.test.ts <<'EOF'
feat: negotiation mutations + resolver + grouped snapshot/export

renew/expire/setPinned/deleteEntry via (category,key,value) resolver;
getGroupedSnapshot (raw, all 10 categories) + exportAll (v2 dataset).
EOF
```

---

## Task B6: config TTL 五触点（negotiation_learning）

**Files:**
- Modify: `src/lib/config/schema.ts`（`ConfigSchema` 加 `negotiation_learning`）
- Modify: `src/lib/state.ts`（`MutableState` 两字段 + `CONFIG_MANAGED_DEFAULTS` 两默认 + `setNegotiationConfig` setter + 4 clone 站点）
- Modify: `src/lib/config/config.ts`（`applyConfigToState` 接线）
- Modify: `src/routes/config/route.ts`（`mergeConfigIntoDocument` 专用分支）
- Test: `tests/anthropic/feature-negotiation.unit.test.ts`（TTL 生效）、扩 config guard 测试

**配置形状**（顶层键，天为单位；`0` = never）:
```yaml
negotiation_learning:
  default_ttl_days: 30
  ttl_days:
    toolFields: 90
    partnerFeatures: 0   # 0 = never（不自动过期）
```
> 分类键用**内部 category id**（camelCase，如 `toolFields`）——它们是标识符非散文，避免 snake_case↔camelCase 映射层漂移。

- [ ] **Step 1（state 默认，B1 前置）**：`src/lib/state.ts`
  - `MutableState` 加：
    ```ts
    /** 反应式学习记录默认 TTL（ms）。hot-reloadable。 */
    readonly negotiationDefaultTtlMs: number
    /** per-category TTL 覆盖（ms；Infinity=never）。键=NegotiationCategory id。hot-reloadable，整体替换。 */
    readonly negotiationTtlOverridesMs: Record<string, number>
    ```
  - `CONFIG_MANAGED_DEFAULTS` 加：
    ```ts
    negotiationDefaultTtlMs: 30 * 86_400_000,
    negotiationTtlOverridesMs: { toolFields: 90 * 86_400_000, partnerFeatures: Number.POSITIVE_INFINITY } as Record<string, number>,
    ```
  - clone 站点（**H1，两类不同**）：
    - `state.ts:868`（`cloneState`）+ `:920`（`cloneStatePatch`）**spread `...source`/`...patch`** —— 标量 `negotiationDefaultTtlMs` 自动带过，**只需**给 record 字段 `negotiationTtlOverridesMs` 加浅拷贝分支（仿 `effortsOverrides`：`if ("negotiationTtlOverridesMs" in patch) cloned.negotiationTtlOverridesMs = patch.negotiationTtlOverridesMs ? { ...patch.negotiationTtlOverridesMs } : undefined`）。
    - `state.ts:1447`（`resetConfigManagedState` 内）+ `:1590`（初始 `mutableState` 字面量）**逐字段显式枚举、不 spread** —— 因 `negotiationDefaultTtlMs` 是**非可选** `readonly number`，这两处**必须同时列** `negotiationDefaultTtlMs: CONFIG_MANAGED_DEFAULTS.negotiationDefaultTtlMs` **和** `negotiationTtlOverridesMs: { ...CONFIG_MANAGED_DEFAULTS.negotiationTtlOverridesMs }`，否则 `:1590` tsc 报 "Property 'negotiationDefaultTtlMs' is missing"、`:1447` 热重载 reset 不还原默认。**先 `git status` 查 state.ts 外来改动**。
  - setter：
    ```ts
    export function setNegotiationConfig(patch: Partial<Pick<MutableState, "negotiationDefaultTtlMs" | "negotiationTtlOverridesMs">>): void {
      updateState(patch)
    }
    ```
- [ ] **Step 2（schema）**：`src/lib/config/schema.ts`，`ConfigSchema.object({...})` 内加（`anthropic` 之后）:
```ts
    negotiation_learning: z
      .object({
        default_ttl_days: z.number().int().nonnegative().nullable().optional(),
        ttl_days: z.record(z.string(), z.number().int().nonnegative()).optional(),
      })
      .strict()
      .optional(),
```
- [ ] **Step 3（config→state 接线）**：`src/lib/config/config.ts`，`applyConfigToState` 内（顶层 config，非 `a.` anthropic 块）:
```ts
if (config.negotiation_learning) {
  const nl = config.negotiation_learning
  const toMs = (days: number): number => (days <= 0 ? Number.POSITIVE_INFINITY : days * 86_400_000)
  if (nl.default_ttl_days != null) setNegotiationConfig({ negotiationDefaultTtlMs: toMs(nl.default_ttl_days) })
  if (nl.ttl_days) {
    const overrides: Record<string, number> = {}
    for (const [cat, days] of Object.entries(nl.ttl_days)) overrides[cat] = toMs(days)
    setNegotiationConfig({ negotiationTtlOverridesMs: overrides })
  }
}
```
- [ ] **Step 4（merge 分支，nested ttl_days round-trip）**：`src/routes/config/route.ts` `mergeConfigIntoDocument` 加（`anthropic` 块后）:
```ts
if (hasOwn(body, "negotiation_learning")) {
  const nl = body.negotiation_learning as Config["negotiation_learning"] | null
  if (nl === null) {
    doc.deleteIn(["negotiation_learning"])
  } else if (nl) {
    if (hasOwn(nl, "default_ttl_days")) setScalar(doc, ["negotiation_learning", "default_ttl_days"], nl.default_ttl_days)
    if (hasOwn(nl, "ttl_days")) {
      // nested map: replace the whole ttl_days node so removed categories drop
      if (nl.ttl_days == null) doc.deleteIn(["negotiation_learning", "ttl_days"])
      else doc.setIn(["negotiation_learning", "ttl_days"], nl.ttl_days)
    }
  }
}
```
- [ ] **Step 5（effective-config 守卫）**：`negotiationDefaultTtlMs` / `negotiationTtlOverridesMs` 在 `CONFIG_MANAGED_DEFAULTS` → `buildEffectiveConfig` 自动 emit（无需改 route）。跑既有守卫测试确认：`bun test tests/routes/config-effective-route.http.test.ts`（完备性守卫应因 CONFIG_MANAGED_DEFAULTS 新键自动通过；若守卫断言固定键数，更新其期望）。
  > **L3（预期行为）**：`negotiationTtlOverridesMs` 里的 `Number.POSITIVE_INFINITY`（如 `partnerFeatures`）经 `c.json` → `JSON.stringify(Infinity)` = `null`，故 `/api/config` 显示 `partnerFeatures: null`。这是**有意的**——`null` = never（自文档化），守卫只查键存在性、不受影响。无需 sentinel。
- [ ] **Step 6（TTL 生效测试）**：
```ts
test("per-category TTL override changes expiry (toolFields 90d)", () => {
  clearAnthropicFeatureNegotiationForTests()
  setNegotiationConfig({ negotiationTtlOverridesMs: { toolFields: 90 * 86_400_000 } })
  setSystemTime(new Date(0))
  markAnthropicUnsupportedToolFields(["eager_input_streaming"])
  setSystemTime(new Date(60 * 86_400_000)) // 60d: default 30d would expire, but toolFields=90d
  expect(getUnsupportedToolFields()).toContain("eager_input_streaming")
  setSystemTime(new Date())
})
```
- [ ] **Step 7**：typecheck + lint（`bunx eslint src/lib/config/schema.ts src/lib/config/config.ts src/lib/state.ts src/routes/config/route.ts`）+ 提交（pathspec，state.ts 只含本任务行）:
```bash
git add -- src/lib/config/schema.ts src/lib/config/config.ts src/lib/state.ts src/routes/config/route.ts tests/anthropic/feature-negotiation.unit.test.ts
git commit -F - -- src/lib/config/schema.ts src/lib/config/config.ts src/lib/state.ts src/routes/config/route.ts tests/anthropic/feature-negotiation.unit.test.ts <<'EOF'
feat: negotiation_learning config (per-category TTL, hot-reloadable)

default_ttl_days (30) + ttl_days per category (0=never); five touch points:
schema, state slice + CONFIG_MANAGED_DEFAULTS + clones, config wiring,
mergeConfigIntoDocument nested branch, effective-config auto-emit.
EOF
```

---

## Task B7: /api/negotiation 路由 + 挂载

**Files:**
- Create: `src/routes/negotiation/route.ts`
- Modify: `src/routes/index.ts`（挂载，在 `registerOpenApiDocs` 前）
- Test: `tests/routes/negotiation-route.http.test.ts`

**Interfaces:** Consumes B5 导出（`getGroupedSnapshot`/`exportAll`/`renewEntry`/`expireEntry`/`setPinned`/`deleteEntry`）+ B1 `NEGOTIATION_CATEGORIES`。

- [ ] **Step 1: 写失败测试**（Hono `.request()` 集成，no-server）:
```ts
import { describe, expect, test, beforeEach } from "bun:test"
import { negotiationRoutes } from "~/routes/negotiation/route"
import { clearAnthropicFeatureNegotiationForTests, markAnthropicFeatureUnsupported } from "~/lib/anthropic/feature-negotiation"

describe("/api/negotiation", () => {
  beforeEach(() => clearAnthropicFeatureNegotiationForTests())

  test("GET / returns grouped snapshot", async () => {
    markAnthropicFeatureUnsupported("m", "context_management")
    const res = await negotiationRoutes.request("/")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.categories.length).toBe(10)
  })

  test("POST /renew revives a manually-expired entry", async () => {
    markAnthropicFeatureUnsupported("m", "f")
    const snap = await (await negotiationRoutes.request("/")).json()
    const e = snap.categories.find((c: any) => c.category === "features").entries[0]
    const res = await negotiationRoutes.request("/renew", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "features", key: e.key, value: e.value }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  test("POST /entry/delete missing → 404", async () => {
    const res = await negotiationRoutes.request("/entry/delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "features", key: "nope", value: "nope" }),
    })
    expect(res.status).toBe(404)
  })

  test("GET /export returns v2 dataset with attachment header", async () => {
    markAnthropicFeatureUnsupported("m", "f")
    const res = await negotiationRoutes.request("/export")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-disposition")).toContain("attachment")
    expect((await res.json()).version).toBe(2)
  })
})
```

- [ ] **Step 2: 跑红** — Expected: FAIL（module 缺）。

- [ ] **Step 3: 实现** `src/routes/negotiation/route.ts`（handler-side safeParse 约定，仿 debug 路由；**内联 try/catch 不抽 parseRef helper** —— M3：`.openapi` 重载泛型，`Parameters<>` 取 Context 不可靠）:
```ts
/** 反应式学习记录（feature-negotiation 缓存）的查看 / 编辑管理 API。 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"

import {
  deleteEntry, expireEntry, exportAll, getGroupedSnapshot, renewEntry, setPinned,
} from "~/lib/anthropic/feature-negotiation"
import { type NegotiationCategory, NEGOTIATION_CATEGORIES } from "~/lib/anthropic/negotiation-lifecycle"

export const negotiationRoutes = new OpenAPIHono()

const AnyJson = z.record(z.string(), z.unknown())
const ErrorSchema = z.object({ error: z.string() }).openapi("NegotiationError")
// H2：保留 NegotiationCategory 联合（勿退化成 string，否则传给 mutator 报 TS2345）
const CategoryEnum = z.enum(NEGOTIATION_CATEGORIES as unknown as readonly [NegotiationCategory, ...Array<NegotiationCategory>])
const EntryRefSchema = z.object({ category: CategoryEnum, key: z.string(), value: z.string() }).strict()
const PinSchema = EntryRefSchema.extend({ pinned: z.boolean() })

const getRoute = createRoute({
  method: "get", path: "/", tags: ["negotiation"],
  summary: "Grouped snapshot of reactive learning records",
  responses: { 200: { description: "snapshot", content: { "application/json": { schema: AnyJson } } } },
})
negotiationRoutes.openapi(getRoute, (c) => c.json(getGroupedSnapshot()))

function refRoute(path: string, summary: string) {
  return createRoute({
    method: "post", path, tags: ["negotiation"], summary,
    responses: {
      200: { description: "ok", content: { "application/json": { schema: AnyJson } } },
      400: { description: "bad request", content: { "application/json": { schema: ErrorSchema } } },
      404: { description: "not found", content: { "application/json": { schema: ErrorSchema } } },
    },
  })
}

// 每 handler 内联 body 解析（仿 debug/route.ts:136-145），避免脆弱的 Context 泛型标注。
negotiationRoutes.openapi(refRoute("/renew", "Renew (extend expiry) an entry"), async (c) => {
  let raw: unknown
  try { raw = await c.req.json() } catch { return c.json({ error: "Invalid JSON body" }, 400) }
  const p = EntryRefSchema.safeParse(raw)
  if (!p.success) return c.json({ error: "Invalid request" }, 400)
  const entry = renewEntry(p.data.category, p.data.key, p.data.value)
  return entry ? c.json({ ok: true, entry }) : c.json({ error: "entry not found" }, 404)
})
negotiationRoutes.openapi(refRoute("/expire", "Expire now (keep row)"), async (c) => {
  let raw: unknown
  try { raw = await c.req.json() } catch { return c.json({ error: "Invalid JSON body" }, 400) }
  const p = EntryRefSchema.safeParse(raw)
  if (!p.success) return c.json({ error: "Invalid request" }, 400)
  const entry = expireEntry(p.data.category, p.data.key, p.data.value)
  return entry ? c.json({ ok: true, entry }) : c.json({ error: "entry not found" }, 404)
})
negotiationRoutes.openapi(refRoute("/pin", "Pin/unpin (never expire)"), async (c) => {
  let raw: unknown
  try { raw = await c.req.json() } catch { return c.json({ error: "Invalid JSON body" }, 400) }
  const p = PinSchema.safeParse(raw)
  if (!p.success) return c.json({ error: "Invalid request" }, 400)
  const entry = setPinned(p.data.category, p.data.key, p.data.value, p.data.pinned)
  return entry ? c.json({ ok: true, entry }) : c.json({ error: "entry not found" }, 404)
})
negotiationRoutes.openapi(refRoute("/entry/delete", "Delete an entry"), async (c) => {
  let raw: unknown
  try { raw = await c.req.json() } catch { return c.json({ error: "Invalid JSON body" }, 400) }
  const p = EntryRefSchema.safeParse(raw)
  if (!p.success) return c.json({ error: "Invalid request" }, 400)
  const ok = deleteEntry(p.data.category, p.data.key, p.data.value)
  return ok ? c.json({ ok: true }) : c.json({ error: "entry not found" }, 404)
})

const exportRoute = createRoute({
  method: "get", path: "/export", tags: ["negotiation"],
  summary: "Export full v2 negotiation dataset (JSON attachment)",
  responses: { 200: { description: "v2 dataset", content: { "application/json": { schema: AnyJson } } } },
})
negotiationRoutes.openapi(exportRoute, (c) => {
  c.header("Content-Disposition", 'attachment; filename="negotiation-states.json"')
  return c.json(exportAll())
})
```

- [ ] **Step 4: 挂载** `src/routes/index.ts`（import + 在 `/api/*` 群、`registerOpenApiDocs` 调用前）:
```ts
import { negotiationRoutes } from "./negotiation/route"
// ... 与其他 /api 挂载一起：
app.route("/api/negotiation", negotiationRoutes)
```

- [ ] **Step 5: 跑绿 + typecheck + lint + 提交**

Run: `bun test tests/routes/negotiation-route.http.test.ts && bun run typecheck && bunx eslint src/routes/negotiation/route.ts src/routes/index.ts`
```bash
git add -- src/routes/negotiation/route.ts src/routes/index.ts tests/routes/negotiation-route.http.test.ts
git commit -F - -- src/routes/negotiation/route.ts src/routes/index.ts tests/routes/negotiation-route.http.test.ts <<'EOF'
feat: /api/negotiation management route (snapshot/renew/expire/pin/delete/export)
EOF
```

---

## Task B8: reset 助手确认 + 全量回归

**Files:** Modify（如需）: `src/lib/anthropic/feature-negotiation.ts`（`resetAnthropicFeatureNegotiationForTesting` / `clearAnthropicFeatureNegotiationForTests` 注释「10 collections」保持）；确认 RESETTERS 注册无变。

- [ ] **Step 1**: 确认 `clearNegotiationMaps` 仍清 10 个 map（类型变了但 `.clear()` 通用）。若 isolated-fixture 的 `RESETTERS` 列了 negotiation reset，确认签名未变。
- [ ] **Step 2**: 全量回归：`bun test tests/anthropic/ tests/routes/negotiation-route.http.test.ts tests/routes/config-effective-route.http.test.ts` + `bun run typecheck` + `bun run lint:all`。
- [ ] **Step 3**: 消费点最终 grep 审计（B4 Step-5 清单）确认 0 遗漏 reader。
- [ ] **Step 4**: 提交（若有改动）:
```bash
git commit -F - -- src/lib/anthropic/feature-negotiation.ts <<'EOF'
chore: confirm negotiation reset helpers cover v2 map shapes
EOF
```

---

## Phase 1 自查（对照 spec）

- AC1 迁移 → B2 ✓；AC2 过期消费 → B4 ✓；AC3 pin → B1+B5 ✓；AC4 再确认 → B3 ✓；AC5 编辑动作 → B5+B7 ✓；AC6 导出 → B5+B7 ✓；AC7 UI → Phase 2；AC8 config → B6 ✓。
- 门控完整性（红线 #3）：B4 12 readers + B5 每分类守卫 ✓。
- meta/返回值分离（红线 #2）：B3 setSupportedEfforts 测试 ✓。
