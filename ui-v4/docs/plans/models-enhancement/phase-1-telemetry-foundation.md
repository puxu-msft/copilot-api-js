# Phase 1 — 遥测地基（解耦 + 归一化 join）

> **实施状态：已完成**
> **落地**：2026-07 · commits `6865f0b` / `e7639e5` / `7aae293`（best-effort）
> **现状锚点**：[ui/src/composables/telemetry-parse.ts](../../../../ui/src/composables/telemetry-parse.ts) · [model-telemetry-join.ts](../../../../ui/src/composables/model-telemetry-join.ts)
> **备注**：audit 后补 date-suffix golden 测试硬化 §4.2 核心。

> 总纲见 [README.md](README.md)。本 phase **纯逻辑、全 bun 测、无 UI 改动**。Global Constraints 隐含适用。
> 交付：`telemetry-parse.ts`（从 `useDashboardStatus` 抽出的纯 parse + 类型 SSOT）、`model-telemetry-join.ts`（`normalizeModelId` 双侧归一化 join + unmatched 收集）。下游 Phase 2 的 `useModelDetail` 消费本 phase 的 join 核。

## 背景（为何做）

遥测 `model` 维度 key 分裂（已核验，spec §4.2）：成功腿 key = 上游规范名（`normalizeModelId` 归一化），失败腿 key = 客户端逐字别名（`opus`）。直接按 `model.id` join 会静默丢失失败腿 + 别名遥测。本 phase 把 parse 从 `useDashboardStatus`（带 WS）解耦成纯函数，并建"双侧 `normalizeModelId` 归一化 + 聚合 + unmatched 收集"的 join 核。

## 文件结构

- Create `ui/src/composables/telemetry-parse.ts` — `parseRequestTelemetry` 纯函数 + 遥测类型定义（从 `useDashboardStatus` 迁入，成 SSOT）。
- Modify `ui/src/composables/useDashboardStatus.ts` — 删内联 parse，改 import 纯函数 + re-export 类型。
- Create `ui/src/composables/model-telemetry-join.ts` — `buildModelTelemetryIndex`。
- Create `ui/tests/telemetry-parse.test.ts`、`ui/tests/model-telemetry-join.test.ts`。

---

### Task 1: 抽出 `parseRequestTelemetry` 纯函数（含类型 SSOT）

把 `useDashboardStatus.ts:209-280` 的 `requestTelemetry` computed 内联 parse 逻辑逐字节等价地抽成纯函数，并把遥测类型定义迁到新文件成为单一源。

**Files:**
- Create: `ui/src/composables/telemetry-parse.ts`
- Modify: `ui/src/composables/useDashboardStatus.ts`（删 parse helper + 类型定义，改 import + re-export；`requestTelemetry` computed 改为 `parseRequestTelemetry(status.value?.requestTelemetry)`）
- Test: `ui/tests/telemetry-parse.test.ts`

**Interfaces:**
- Produces:
  - `export interface RequestTelemetryModelStats { model: string; requestCount: number; successCount: number; failureCount: number; totalDurationMs: number; averageDurationMs: number; usage: TelemetryUsage }`
  - `export interface TelemetryUsage { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; reasoningTokens: number }`
  - `export interface RequestTelemetryModelBucket { timestamp: number; requestCount: number; successCount: number; failureCount: number; totalDurationMs: number; averageDurationMs: number; usage: TelemetryUsage }`
  - `export interface RequestTelemetryBucket { timestamp: number; count: number }`
  - `export interface RequestTelemetrySnapshot { acceptedSinceStart: number; bucketSizeMinutes: number; windowDays: number; totalLast7d: number; buckets: Array<RequestTelemetryBucket>; modelsSinceStart: Array<RequestTelemetryModelStats>; modelsLast7d: Array<RequestTelemetryModelStats & { buckets: Array<RequestTelemetryModelBucket> }> }`
  - `export function parseRequestTelemetry(raw: unknown): RequestTelemetrySnapshot | null`
- Consumes: 无（纯函数，只吃 `unknown` 原始 `status.requestTelemetry`）。

- [ ] **Step 1: 写失败测试**

创建 `ui/tests/telemetry-parse.test.ts`：

```ts
import { describe, expect, test } from "bun:test"

import { parseRequestTelemetry } from "@/composables/telemetry-parse"

describe("parseRequestTelemetry", () => {
  test("returns null when raw is null/undefined/non-object", () => {
    expect(parseRequestTelemetry(null)).toBeNull()
    expect(parseRequestTelemetry(undefined)).toBeNull()
    expect(parseRequestTelemetry(42)).toBeNull()
  })

  test("parses a full snapshot with model stats + usage, defaulting missing numbers to 0", () => {
    const raw = {
      acceptedSinceStart: 10,
      bucketSizeMinutes: 5,
      windowDays: 7,
      totalLast7d: 100,
      buckets: [{ timestamp: 1, count: 3 }, { timestamp: 2 /* count missing */ }],
      modelsSinceStart: [
        { model: "claude-opus-4.8", requestCount: 5, successCount: 4, failureCount: 1, totalDurationMs: 5000, averageDurationMs: 1000, usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cacheReadInputTokens: 10, cacheCreationInputTokens: 5, reasoningTokens: 20 } },
      ],
      modelsLast7d: [
        { model: "claude-opus-4.8", requestCount: 5, usage: {}, buckets: [{ timestamp: 1, requestCount: 2, usage: {} }] },
      ],
    }
    const snap = parseRequestTelemetry(raw)
    expect(snap).not.toBeNull()
    expect(snap!.acceptedSinceStart).toBe(10)
    expect(snap!.buckets).toEqual([{ timestamp: 1, count: 3 }, { timestamp: 2, count: 0 }])
    expect(snap!.modelsSinceStart[0].usage.reasoningTokens).toBe(20)
    // missing numeric fields default to 0
    expect(snap!.modelsLast7d[0].successCount).toBe(0)
    expect(snap!.modelsLast7d[0].usage.totalTokens).toBe(0)
    expect(snap!.modelsLast7d[0].buckets[0].requestCount).toBe(2)
  })

  test("non-array models/buckets degrade to empty arrays", () => {
    const snap = parseRequestTelemetry({ modelsSinceStart: "nope", modelsLast7d: null, buckets: 5 })
    expect(snap!.modelsSinceStart).toEqual([])
    expect(snap!.modelsLast7d).toEqual([])
    expect(snap!.buckets).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test:ui:bun 2>&1 | grep telemetry-parse`
Expected: FAIL（`Cannot find module '@/composables/telemetry-parse'`）。

- [ ] **Step 3: 写 `telemetry-parse.ts`**

把 `useDashboardStatus.ts:209-280` 的 `parseUsage`/`parseModelStats`/`parseModels`/`parseModelSeries` + 顶层字段解析**逐字节搬**进纯函数（逻辑不变，只是从 computed body 提升为 module 函数），并把类型定义一并迁入：

```ts
export interface TelemetryUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  reasoningTokens: number
}

export interface RequestTelemetryModelStats {
  model: string
  requestCount: number
  successCount: number
  failureCount: number
  totalDurationMs: number
  averageDurationMs: number
  usage: TelemetryUsage
}

export interface RequestTelemetryModelBucket {
  timestamp: number
  requestCount: number
  successCount: number
  failureCount: number
  totalDurationMs: number
  averageDurationMs: number
  usage: TelemetryUsage
}

export interface RequestTelemetryBucket {
  timestamp: number
  count: number
}

export interface RequestTelemetrySnapshot {
  acceptedSinceStart: number
  bucketSizeMinutes: number
  windowDays: number
  totalLast7d: number
  buckets: Array<RequestTelemetryBucket>
  modelsSinceStart: Array<RequestTelemetryModelStats>
  modelsLast7d: Array<RequestTelemetryModelStats & { buckets: Array<RequestTelemetryModelBucket> }>
}

const num = (v: unknown, d = 0): number => (typeof v === "number" ? v : d)

function parseUsage(rawValue: unknown): TelemetryUsage {
  const usage = (rawValue && typeof rawValue === "object" ? rawValue : {}) as Record<string, unknown>
  return {
    inputTokens: num(usage.inputTokens),
    outputTokens: num(usage.outputTokens),
    totalTokens: num(usage.totalTokens),
    cacheReadInputTokens: num(usage.cacheReadInputTokens),
    cacheCreationInputTokens: num(usage.cacheCreationInputTokens),
    reasoningTokens: num(usage.reasoningTokens),
  }
}

function parseModelStats(entry: Record<string, unknown>): RequestTelemetryModelStats {
  return {
    model: typeof entry.model === "string" ? entry.model : "unknown",
    requestCount: num(entry.requestCount),
    successCount: num(entry.successCount),
    failureCount: num(entry.failureCount),
    totalDurationMs: num(entry.totalDurationMs),
    averageDurationMs: num(entry.averageDurationMs),
    usage: parseUsage(entry.usage),
  }
}

const asRecords = (v: unknown): Array<Record<string, unknown>> =>
  (Array.isArray(v) ? v : []).filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object")

export function parseRequestTelemetry(raw: unknown): RequestTelemetrySnapshot | null {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null
  if (!source) return null

  const buckets = asRecords(source.buckets).map((b) => ({ timestamp: num(b.timestamp), count: num(b.count) }))
  const modelsSinceStart = asRecords(source.modelsSinceStart).map(parseModelStats)
  const modelsLast7d = asRecords(source.modelsLast7d).map((entry) => ({
    ...parseModelStats(entry),
    buckets: asRecords(entry.buckets).map((b) => ({
      timestamp: num(b.timestamp),
      requestCount: num(b.requestCount),
      successCount: num(b.successCount),
      failureCount: num(b.failureCount),
      totalDurationMs: num(b.totalDurationMs),
      averageDurationMs: num(b.averageDurationMs),
      usage: parseUsage(b.usage),
    })),
  }))

  return {
    acceptedSinceStart: num(source.acceptedSinceStart),
    bucketSizeMinutes: num(source.bucketSizeMinutes, 5),
    windowDays: num(source.windowDays, 7),
    totalLast7d: num(source.totalLast7d),
    buckets,
    modelsSinceStart,
    modelsLast7d,
  }
}
```

- [ ] **Step 4: 改 `useDashboardStatus.ts` 用纯函数 + re-export 类型**

删掉 `useDashboardStatus.ts` 里的 5 个遥测 interface 定义（`TelemetryUsage` 未定义过则忽略）+ `requestTelemetry` computed 内的 parse helper，改为：

```ts
import {
  parseRequestTelemetry,
  type RequestTelemetryBucket,
  type RequestTelemetryModelBucket,
  type RequestTelemetryModelStats,
  type RequestTelemetrySnapshot,
} from "@/composables/telemetry-parse"

// re-export 保持既有消费者(useModelTelemetry.ts import from "./useDashboardStatus")不破
export type { RequestTelemetryBucket, RequestTelemetryModelBucket, RequestTelemetryModelStats, RequestTelemetrySnapshot }

// ... 内部：
const requestTelemetry = computed<RequestTelemetrySnapshot | null>(() => parseRequestTelemetry(status.value?.requestTelemetry))
```

**注**：`RequestTelemetryModelStats` 若 `useDashboardStatus` 原来还有 `QuotaItem` 等其它 export，保持不动。只迁遥测 5 类型。

- [ ] **Step 5: 跑 bun 测 + typecheck**

Run: `bun run test:ui:bun 2>&1 | tail -5 && bun run typecheck:ui 2>&1 | tail -3`
Expected: telemetry-parse 测试 PASS；typecheck 0 error（`useModelTelemetry.ts` 的 `import type { RequestTelemetrySnapshot } from "./useDashboardStatus"` 经 re-export 仍解析）。

- [ ] **Step 6: 提交**

```bash
git add -- ui/src/composables/telemetry-parse.ts ui/src/composables/useDashboardStatus.ts ui/tests/telemetry-parse.test.ts
git commit -F - <<'MSG'
refactor(ui): extract parseRequestTelemetry pure function

Move the /api/status telemetry parse (+ its type definitions) out of
useDashboardStatus into telemetry-parse.ts so the Models page can build
a telemetry snapshot from a one-shot fetchStatus without pulling in the
dashboard's WS lifecycle. useDashboardStatus re-exports the types;
behavior is byte-equivalent (covered by new bun tests).
MSG
```

---

### Task 2: 归一化聚合 join 核 `buildModelTelemetryIndex`

建"双侧 `normalizeModelId` 归一化 + 同 key 聚合 + unmatched 收集"的纯函数。这是 spec §4.2 的核心，独立于 UI。

**Files:**
- Create: `ui/src/composables/model-telemetry-join.ts`
- Test: `ui/tests/model-telemetry-join.test.ts`

**Interfaces:**
- Consumes: `RequestTelemetrySnapshot`（Task 1）、`Model`（`~backend/lib/models/client`）、`normalizeModelId`（`~backend/lib/models/resolver`）。
- Produces:
  - `export interface JoinedModelTelemetry { last7d: RequestTelemetryModelStats | null; sinceStart: RequestTelemetryModelStats | null }`
  - `export interface UnmatchedTelemetryRow { model: string; normalizedKey: string; last7d: RequestTelemetryModelStats | null; sinceStart: RequestTelemetryModelStats | null }`
  - `export interface ModelTelemetryIndex { byId: Map<string, JoinedModelTelemetry>; unmatched: Array<UnmatchedTelemetryRow> }`
  - `export function buildModelTelemetryIndex(snapshot: RequestTelemetrySnapshot | null, models: Array<Model>): ModelTelemetryIndex`
  - `byId` 的 key = `normalizeModelId(model.id)`；页面查询用 `index.byId.get(normalizeModelId(model.id))`。

- [ ] **Step 1: 写失败测试**

创建 `ui/tests/model-telemetry-join.test.ts`。**核心场景是成功/失败 key 分裂 + 别名 + unmatched**：

```ts
import type { Model } from "~backend/lib/models/client"
import type { RequestTelemetryModelStats, RequestTelemetrySnapshot } from "@/composables/telemetry-parse"

import { describe, expect, test } from "bun:test"

import { buildModelTelemetryIndex } from "@/composables/model-telemetry-join"

const usage = () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 })
function stats(model: string, over: Partial<RequestTelemetryModelStats> = {}): RequestTelemetryModelStats {
  return { model, requestCount: 0, successCount: 0, failureCount: 0, totalDurationMs: 0, averageDurationMs: 0, usage: usage(), ...over }
}
function model(id: string): Model {
  return { id, name: id, vendor: "Anthropic", object: "model", preview: false, model_picker_enabled: true, is_chat_default: false, is_chat_fallback: false, version: "1" } as Model
}
function snap(last7d: Array<RequestTelemetryModelStats>, sinceStart: Array<RequestTelemetryModelStats> = []): RequestTelemetrySnapshot {
  return { acceptedSinceStart: 0, bucketSizeMinutes: 5, windowDays: 7, totalLast7d: 0, buckets: [], modelsSinceStart: sinceStart, modelsLast7d: last7d.map((s) => ({ ...s, buckets: [] })) }
}

describe("buildModelTelemetryIndex", () => {
  test("returns empty index for null snapshot", () => {
    const idx = buildModelTelemetryIndex(null, [model("claude-opus-4.8")])
    expect(idx.byId.size).toBe(0)
    expect(idx.unmatched).toEqual([])
  })

  test("joins canonical telemetry key to matching model.id", () => {
    const idx = buildModelTelemetryIndex(snap([stats("claude-opus-4.8", { requestCount: 5 })]), [model("claude-opus-4.8")])
    expect(idx.byId.get("claude-opus-4.8")?.last7d?.requestCount).toBe(5)
    expect(idx.unmatched).toEqual([])
  })

  test("aggregates success (canonical) + failure (alias) legs that normalize to the same id", () => {
    // 成功腿 key = 上游规范名 "claude-opus-4-8" → normalizeModelId → "claude-opus-4.8"
    // 失败腿 key = 客户端别名 "claude-opus-4-8" (date-less) 同样归一 → 合并
    const idx = buildModelTelemetryIndex(
      snap([
        stats("claude-opus-4-8", { requestCount: 4, successCount: 4 }),
        stats("claude-opus-4.8", { requestCount: 2, failureCount: 2 }),
      ]),
      [model("claude-opus-4.8")],
    )
    const joined = idx.byId.get("claude-opus-4.8")
    expect(joined?.last7d?.requestCount).toBe(6)
    expect(joined?.last7d?.successCount).toBe(4)
    expect(joined?.last7d?.failureCount).toBe(2)
    expect(idx.unmatched).toEqual([])
  })

  test("recomputes averageDurationMs after aggregation", () => {
    const idx = buildModelTelemetryIndex(
      snap([
        stats("claude-opus-4.8", { requestCount: 2, totalDurationMs: 2000 }),
        stats("claude-opus-4.8", { requestCount: 2, totalDurationMs: 6000 }),
      ]),
      [model("claude-opus-4.8")],
    )
    // (2000+6000) / (2+2) = 2000
    expect(idx.byId.get("claude-opus-4.8")?.last7d?.averageDurationMs).toBe(2000)
  })

  test("telemetry with no matching model.id goes to unmatched (never dropped)", () => {
    const idx = buildModelTelemetryIndex(
      snap([stats("opus", { requestCount: 3, failureCount: 3 })]), // pure alias, never normalizes to a catalog id
      [model("claude-opus-4.8")],
    )
    expect(idx.byId.size).toBe(0)
    expect(idx.unmatched).toHaveLength(1)
    expect(idx.unmatched[0].model).toBe("opus")
    expect(idx.unmatched[0].last7d?.failureCount).toBe(3)
  })

  test("joins sinceStart + last7d windows independently onto the same model", () => {
    const idx = buildModelTelemetryIndex(
      snap([stats("claude-opus-4.8", { requestCount: 7 })], [stats("claude-opus-4.8", { requestCount: 99 })]),
      [model("claude-opus-4.8")],
    )
    const joined = idx.byId.get("claude-opus-4.8")
    expect(joined?.last7d?.requestCount).toBe(7)
    expect(joined?.sinceStart?.requestCount).toBe(99)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test:ui:bun 2>&1 | grep model-telemetry-join`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写 `model-telemetry-join.ts`**

```ts
import type { Model } from "~backend/lib/models/client"

import { normalizeModelId } from "~backend/lib/models/resolver"

import type { RequestTelemetryModelStats, RequestTelemetrySnapshot } from "./telemetry-parse"

export interface JoinedModelTelemetry {
  last7d: RequestTelemetryModelStats | null
  sinceStart: RequestTelemetryModelStats | null
}

export interface UnmatchedTelemetryRow {
  model: string
  normalizedKey: string
  last7d: RequestTelemetryModelStats | null
  sinceStart: RequestTelemetryModelStats | null
}

export interface ModelTelemetryIndex {
  byId: Map<string, JoinedModelTelemetry>
  unmatched: Array<UnmatchedTelemetryRow>
}

/** Sum two model-stats rows; recompute averageDurationMs from the summed totals. */
function mergeStats(a: RequestTelemetryModelStats, b: RequestTelemetryModelStats): RequestTelemetryModelStats {
  const requestCount = a.requestCount + b.requestCount
  const totalDurationMs = a.totalDurationMs + b.totalDurationMs
  return {
    model: a.model,
    requestCount,
    successCount: a.successCount + b.successCount,
    failureCount: a.failureCount + b.failureCount,
    totalDurationMs,
    averageDurationMs: requestCount > 0 ? totalDurationMs / requestCount : 0,
    usage: {
      inputTokens: a.usage.inputTokens + b.usage.inputTokens,
      outputTokens: a.usage.outputTokens + b.usage.outputTokens,
      totalTokens: a.usage.totalTokens + b.usage.totalTokens,
      cacheReadInputTokens: a.usage.cacheReadInputTokens + b.usage.cacheReadInputTokens,
      cacheCreationInputTokens: a.usage.cacheCreationInputTokens + b.usage.cacheCreationInputTokens,
      reasoningTokens: a.usage.reasoningTokens + b.usage.reasoningTokens,
    },
  }
}

/** Aggregate raw telemetry rows by normalizeModelId(row.model). Keeps the first-seen
 *  original model string as the representative label (for unmatched display). */
function aggregateByNormalizedKey(rows: Array<RequestTelemetryModelStats>): Map<string, RequestTelemetryModelStats> {
  const out = new Map<string, RequestTelemetryModelStats>()
  for (const row of rows) {
    const key = normalizeModelId(row.model)
    const prev = out.get(key)
    out.set(key, prev ? mergeStats(prev, row) : row)
  }
  return out
}

export function buildModelTelemetryIndex(snapshot: RequestTelemetrySnapshot | null, models: Array<Model>): ModelTelemetryIndex {
  const byId = new Map<string, JoinedModelTelemetry>()
  const unmatched: Array<UnmatchedTelemetryRow> = []
  if (!snapshot) return { byId, unmatched }

  const last7d = aggregateByNormalizedKey(snapshot.modelsLast7d)
  const sinceStart = aggregateByNormalizedKey(snapshot.modelsSinceStart)
  const catalogKeys = new Set(models.map((m) => normalizeModelId(m.id)))

  const allKeys = new Set<string>([...last7d.keys(), ...sinceStart.keys()])
  for (const key of allKeys) {
    const l = last7d.get(key) ?? null
    const s = sinceStart.get(key) ?? null
    if (catalogKeys.has(key)) {
      byId.set(key, { last7d: l, sinceStart: s })
    } else {
      unmatched.push({ model: (l ?? s)!.model, normalizedKey: key, last7d: l, sinceStart: s })
    }
  }
  // Stable ordering for deterministic rendering/tests.
  unmatched.sort((a, b) => a.normalizedKey.localeCompare(b.normalizedKey))
  return { byId, unmatched }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test:ui:bun 2>&1 | grep -A3 model-telemetry-join`
Expected: 全 PASS（含 key 分裂聚合、unmatched、双窗口、平均时延重算）。

- [ ] **Step 5: typecheck**

Run: `bun run typecheck:ui 2>&1 | tail -3`
Expected: 0 error（`~backend/lib/models/resolver` 的 `normalizeModelId` 经前端 `~backend` alias 解析）。

- [ ] **Step 6: 提交**

```bash
git add -- ui/src/composables/model-telemetry-join.ts ui/tests/model-telemetry-join.test.ts
git commit -F - <<'MSG'
feat(ui): normalized model telemetry join with unmatched collection

buildModelTelemetryIndex aggregates /api/status model-dimension rows by
normalizeModelId on BOTH sides (telemetry key and model.id), merging the
success (canonical) and failure (alias) legs that the split-key defect
otherwise scatters. Telemetry that normalizes to no catalog id is
surfaced in `unmatched` rather than silently dropped (richest-data-flow).
MSG
```

---

## Phase 1 收尾

- `bun run test:ui:bun`（telemetry-parse + model-telemetry-join 全绿）+ `bun run typecheck:ui`（0 error）。
- 派 subagent audit（裁判轴：join 归一化是否覆盖 spec §4.2 全部失配形态、unmatched 是否真的不丢数据、parse 抽取是否逐字节等价；**非** ROI/最小化）。
- 交付给 Phase 2：`buildModelTelemetryIndex` + `parseRequestTelemetry` 已就绪，`useModelDetail` 直接消费。
