# Size-Aware Calibration Learning —— 实施计划

> **2026-07-13 后续变更**：见对应 spec 头部注 + RFC `2026-07-13-remove-auto-truncate-keep-calibration`——auto-truncate 截断本体已移除，calibration 保留并重定位为本地计数增强；本计划 Task 里的 pre-flight/preSend、`calculateTokenLimit`、`onTokenLimitExceeded`、`computeSafetyMargin` 均已删除或改齐。当前架构以 DESIGN.md 为准。

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐 task 实施。步骤用 checkbox（`- [ ]`）跟踪。
>
> **实施状态**：**已实施完成**（Tasks 1-10，subagent-driven，各 task 经独立 subagent review 审干净；分支 `feat/size-aware-calibration`，commit 范围 `07fd968b..09eae78d`——Phase 1 = size-aware 模型/seed/迁移/CalibrationSink/backfill，Phase 2 = `d40f8e02` config flag + `7d9a3964` pre-flight hook + `09eae78d` 降级兜底；per-task 审查账本见 `.superpowers/sdd/handoff/`）。见 [docs/spec/2026-07-11-size-aware-calibration-learning.md](../spec/2026-07-11-size-aware-calibration-learning.md)。

**Goal**：把 auto-truncate calibration 从「单标量、仅从 400 学」改成「size-aware per-bucket 滑动加权均值、也从成功请求学 + history backfill 冷启动」，并加主路径 pre-flight（Phase 2，门控 OFF）。

**Architecture**：`src/lib/auto-truncate/engine.ts` 的标量 `calibrationFactor` 换成 per-bucket `{sumReal,sumEst,sampleCount,meanEst}` 模型（factor=Σreal/Σest，log 插值，WEIGHT_CAP=2000 滑动窗）；成功腿新增 observability `CalibrationSink`（订阅 `request.completed`）、400 腿改现有 `onTokenLimitExceeded`；出厂 bake-in seed 表 + 后台 backfill 冷启动；Phase 2 pre-flight 走 codec async pre-send hook。

**Tech Stack**：TypeScript / Bun、Zod（config schema）、bun:sqlite（history）、zstd/gzip（blob）、observability bus。

## Global Constraints

- **口径不变量**：`countTotalTokens` = **gpt 口径**；`learned.tokenLimit` / 400 报 current / `calibrate()` 输出 = **anthropic 口径**。pre-flight 判超限在 anthropic 口径，但传给 `autoTruncateAnthropic` 的 `targetTokenLimit` 必须 gpt 口径（`limit/factor`）。
- **BUCKET_BOUNDS** = `[0, 15_000, 30_000, 60_000, 120_000, 240_000, Infinity]`（6 桶），`WEIGHT_CAP = 2000`，`CALIBRATION_MIN=0.5` / `CALIBRATION_MAX=3.0`（沿用）。
- **DEFAULT_FACTOR_SEED["claude-opus-4.8"]**（全量 4000 样本训练，`{factor, meanEst}`，[0,15k) 为 null）：`[null, {1.284,23877}, {1.313,48784}, {1.434,85238}, {1.625,163889}, {1.826,333152}]`。
- **never-throw**：CalibrationSink 与 backfill 是 fire-and-forget 背景工作，绝不抛（escaped rejection 会崩进程 — skill `debugging-server-crashes`）。
- **测试隔离**：`resetAllLimitsForTesting()` + `setLearnedLimitsPathForTests(临时路径)`，**never 碰真实 $HOME**（skill `test-isolation`）。持久化异步不变量见 skill `persistence-async-invariants`。
- **提交纪律**：conventional commits、显式 pathspec（`git add -- <精确路径>`）、无模型署名。
- **no-auto-server**：不跑 `bun run dev/start`；用 `bun test` / `bun run typecheck` / `bunx eslint <path>` 验证。

---

# Phase 1 —— size-aware 学习 + backfill（可独立落地验证）

价值：count_tokens 端点精度（factor 从 50% 高估降到 ~7%，不再误触发过早客户端压缩）。

> **⚠️ ATOMIC GROUP：Task 1-4 是一次原子迁移，必须合并提交。**
> `ModelLimits` 形状变更牵一发动全身——engine.ts 内 `onTokenLimitExceeded`/`loadPersistedLimits`/`persistLimits` 与外部消费者（`anthropic/auto-truncate.ts`、`openai/auto-truncate.ts`、`truncation.ts`）全都读旧标量 `calibrationFactor`/`sampleCount`。**中途整站 typecheck 必然红**，这是 schema 迁移的固有原子性，不是缺陷。
> 规则：Task 1-3 各步用 **`bun test <目标测试文件>`** 验证（bun test 逐文件转译、不整站 typecheck，故其它文件的类型错不阻塞目标测试）；**`bun run typecheck`（整站绿）+ `git commit` 只在 Task 4 Step 5 一次性做**（覆盖 engine + 全部消费者的原子提交）。Task 1-3 结束时**不提交**。

## Task 1: factor 模型数据结构 + bucketIndex + factorAt（log 插值）

**Files:**
- Modify: `src/lib/auto-truncate/engine.ts`（替换 `ModelLimits` 定义 §55-69、`calibrate`/`updateCalibration` §137-170）
- Test: `src/lib/auto-truncate/engine.factor-model.test.ts`（新建）

**Interfaces:**
- Produces:
  - `const BUCKET_BOUNDS: ReadonlyArray<number>`、`const WEIGHT_CAP = 2000`、`const FACTOR_BOUNDS_VERSION = 1`
  - `interface FactorBucket { sumReal: number; sumEst: number; sampleCount: number; meanEst: number }`
  - `interface FactorModel { boundsVersion: number; buckets: Array<FactorBucket> }`
  - `interface ModelLimits { tokenLimit?: number; factorModel: FactorModel; liveSampleCount: number; updatedAt: number }`
  - `function bucketIndexFor(est: number): number`
  - `function emptyFactorModel(): FactorModel`（6 个零桶）
  - `function factorAt(modelId: string, est: number): number`（log 插值，空→1.0）

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/auto-truncate/engine.factor-model.test.ts
import { afterEach, describe, expect, test } from "bun:test"

import {
  bucketIndexFor,
  factorAt,
  resetAllLimitsForTesting,
} from "./engine"

afterEach(() => resetAllLimitsForTesting())

describe("bucketIndexFor", () => {
  test("maps estimate to the right bucket", () => {
    expect(bucketIndexFor(0)).toBe(0) // [0,15k)
    expect(bucketIndexFor(14_999)).toBe(0)
    expect(bucketIndexFor(15_000)).toBe(1) // [15k,30k)
    expect(bucketIndexFor(85_000)).toBe(3) // [60k,120k)
    expect(bucketIndexFor(5_000_000)).toBe(5) // [240k,inf)
  })
})

describe("factorAt", () => {
  test("empty model → 1.0 (no-op)", () => {
    expect(factorAt("unknown-model", 50_000)).toBe(1.0)
  })
  // NOTE: 插值（多锚点）测试在 Task 2（需 learnCalibration 建锚点）。本 task 只验空模型分支。
})
```

（import 里暂不需要 `learnCalibration`/`WEIGHT_CAP`——Task 1 测试只用 `bucketIndexFor`/`factorAt`/`resetAllLimitsForTesting`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/lib/auto-truncate/engine.factor-model.test.ts`
Expected: FAIL（`bucketIndexFor`/`factorAt`/`emptyFactorModel` 未导出）

- [ ] **Step 3: 实现数据结构 + bucketIndexFor + emptyFactorModel + factorAt**

在 engine.ts 替换旧 `ModelLimits`（§57-69）与 calibration 区（§133-170）：

```ts
export const BUCKET_BOUNDS: ReadonlyArray<number> = [0, 15_000, 30_000, 60_000, 120_000, 240_000, Infinity]
export const WEIGHT_CAP = 2000
export const FACTOR_BOUNDS_VERSION = 1
const CALIBRATION_MIN = 0.5
const CALIBRATION_MAX = 3.0

export interface FactorBucket {
  sumReal: number
  sumEst: number
  sampleCount: number
  meanEst: number
}
export interface FactorModel {
  boundsVersion: number
  buckets: Array<FactorBucket>
}
export interface ModelLimits {
  /** Only set once a 400 taught us the real cap; seed-only models leave it undefined
   *  so calculateTokenLimit falls back to model capabilities. */
  tokenLimit?: number
  factorModel: FactorModel
  /** LIVE learning events only (success + 400); seed/backfill do NOT bump it.
   *  Drives computeSafetyMargin so synthetic priors never collapse the margin. */
  liveSampleCount: number
  updatedAt: number
}

export function emptyFactorModel(): FactorModel {
  return {
    boundsVersion: FACTOR_BOUNDS_VERSION,
    buckets: Array.from({ length: BUCKET_BOUNDS.length - 1 }, () => ({ sumReal: 0, sumEst: 0, sampleCount: 0, meanEst: 0 })),
  }
}

export function bucketIndexFor(est: number): number {
  for (let i = 0; i < BUCKET_BOUNDS.length - 1; i++) {
    if (est >= BUCKET_BOUNDS[i] && est < BUCKET_BOUNDS[i + 1]) return i
  }
  return BUCKET_BOUNDS.length - 2
}

/** Read a bucket's factor = clamp(Σreal/Σest). Undefined when the bucket is empty. */
function bucketFactor(b: FactorBucket): number | undefined {
  if (b.sampleCount === 0 || b.sumEst <= 0) return undefined
  return Math.max(CALIBRATION_MIN, Math.min(CALIBRATION_MAX, b.sumReal / b.sumEst))
}

/** size-aware factor via log-linear interpolation between populated bucket anchors
 *  (anchor x = bucket.meanEst, y = bucketFactor). Empty model → 1.0 (no-op). */
export function factorAt(modelId: string, est: number): number {
  const limits = learnedLimits.get(modelId)
  if (!limits) return 1.0
  const anchors: Array<{ x: number; y: number }> = []
  for (const b of limits.factorModel.buckets) {
    const y = bucketFactor(b)
    if (y !== undefined && b.meanEst > 0) anchors.push({ x: b.meanEst, y })
  }
  if (anchors.length === 0) return 1.0
  anchors.sort((a, b) => a.x - b.x)
  if (est <= anchors[0].x) return anchors[0].y
  if (est >= anchors[anchors.length - 1].x) return anchors[anchors.length - 1].y
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i]
    const b = anchors[i + 1]
    if (est >= a.x && est <= b.x) {
      const t = (Math.log(est) - Math.log(a.x)) / (Math.log(b.x) - Math.log(a.x))
      return a.y + t * (b.y - a.y)
    }
  }
  return anchors[anchors.length - 1].y
}
```

（`learnCalibration` 在 Task 2 加；本步先让 test 的 import 存在——可先加一个抛错的 stub，Task 2 落实现。若逐 task 严格 TDD，可把 Task1 测试里的 learnCalibration 调用推迟到 Task 2，Task1 只测 bucketIndexFor + factorAt(empty)。）

- [ ] **Step 4: 跑测试确认通过（bucketIndexFor + factorAt empty）**

Run: `bun test src/lib/auto-truncate/engine.factor-model.test.ts`
Expected: PASS

- [ ] **Step 5: 不提交（ATOMIC GROUP）**

Task 1-4 是原子迁移。此时 engine.ts 内 `onTokenLimitExceeded`/`loadPersistedLimits` 仍读旧字段 → 整站 typecheck 红是预期的。**不跑 `bun run typecheck`、不 commit**，直接进 Task 2。（`bun test <file>` 能过是因为 bun 逐文件转译。）

## Task 2: learnCalibration（滑动加权均值 + WEIGHT_CAP）+ calibrate 重写

**Files:**
- Modify: `src/lib/auto-truncate/engine.ts`
- Test: `src/lib/auto-truncate/engine.factor-model.test.ts`（补测）

**Interfaces:**
- Produces:
  - `function learnCalibration(modelId: string, localEstimate: number, realTokens: number, opts: { isLive: boolean }): void`
  - `function calibrate(modelId: string, gptEstimate: number): number`（签名不变，内部改 `factorAt`）
  - `function ensureModelLimits(modelId: string): ModelLimits`（新建 + seed 填充，见 Task 3 的 seed；本 task 先空模型）

- [ ] **Step 1: 写失败测试（滑动窗 + 成功/400 同桶 + liveSampleCount 分离）**

```ts
test("learnCalibration accumulates tok-weighted factor in the right bucket", () => {
  learnCalibration("m", 80_000, 112_000, { isLive: true }) // factor 1.4, bucket3
  expect(factorAt("m", 80_000)).toBeCloseTo(1.4, 2)
  learnCalibration("m", 100_000, 160_000, { isLive: true }) // factor 1.6, same bucket3
  // tok-weighted mean = (112k+160k)/(80k+100k) = 272/180 ≈ 1.511
  expect(factorAt("m", 90_000)).toBeCloseTo(1.511, 2)
})

test("log-interpolates between adjacent populated bucket anchors (moved from Task 1, P-Y2)", () => {
  learnCalibration("m", 85_238, Math.round(85_238 * 1.434), { isLive: true }) // bucket3 anchor
  learnCalibration("m", 163_889, Math.round(163_889 * 1.625), { isLive: true }) // bucket4 anchor
  expect(factorAt("m", 50_000)).toBeCloseTo(1.434, 2) // below first anchor → clamp
  expect(factorAt("m", 300_000)).toBeCloseTo(1.625, 2) // above last anchor → clamp
  const mid = Math.exp((Math.log(85_238) + Math.log(163_889)) / 2)
  const f = factorAt("m", mid)
  expect(f).toBeGreaterThan(1.434)
  expect(f).toBeLessThan(1.625)
})

test("clamps factor to [0.5, 3.0]", () => {
  learnCalibration("m", 10_000, 100_000, { isLive: true }) // raw 10.0 → clamp 3.0
  expect(factorAt("m", 10_000)).toBeCloseTo(3.0, 2)
})

test("isLive:false does not bump liveSampleCount (margin source)", () => {
  learnCalibration("m", 80_000, 112_000, { isLive: false })
  expect(getLearnedLimits("m")?.liveSampleCount).toBe(0)
  learnCalibration("m", 80_000, 112_000, { isLive: true })
  expect(getLearnedLimits("m")?.liveSampleCount).toBe(1)
})

test("sliding window caps weight at WEIGHT_CAP", () => {
  for (let i = 0; i < WEIGHT_CAP + 500; i++) learnCalibration("m", 80_000, 112_000, { isLive: true })
  expect(getLearnedLimits("m")!.factorModel.buckets[3].sampleCount).toBe(WEIGHT_CAP)
})
```

- [ ] **Step 2: 跑确认失败**

Run: `bun test src/lib/auto-truncate/engine.factor-model.test.ts`
Expected: FAIL（`learnCalibration` 未定义）

- [ ] **Step 3: 实现 learnCalibration + calibrate + ensureModelLimits**

```ts
export function ensureModelLimits(modelId: string): ModelLimits {
  let limits = learnedLimits.get(modelId)
  if (!limits) {
    limits = { factorModel: seedFactorModel(modelId), liveSampleCount: 0, updatedAt: Date.now() }
    learnedLimits.set(modelId, limits)
  }
  return limits
}

/** Feed one (localEstimate, realTokens) sample into its size bucket as a
 *  ~WEIGHT_CAP sliding tok-weighted mean. Success + 400 legs share this. */
export function learnCalibration(modelId: string, localEstimate: number, realTokens: number, opts: { isLive: boolean }): void {
  if (localEstimate <= 0 || realTokens <= 0) return
  const limits = ensureModelLimits(modelId)
  const b = limits.factorModel.buckets[bucketIndexFor(localEstimate)]
  const effWeight = b.sampleCount
  if (effWeight >= WEIGHT_CAP) {
    const decay = WEIGHT_CAP / (WEIGHT_CAP + 1)
    b.sumReal *= decay
    b.sumEst *= decay
  }
  b.sumReal += realTokens
  b.sumEst += localEstimate
  const w = Math.min(effWeight, WEIGHT_CAP)
  b.meanEst = (b.meanEst * w + localEstimate) / (w + 1)
  b.sampleCount = Math.min(b.sampleCount + 1, WEIGHT_CAP)
  if (opts.isLive) limits.liveSampleCount++
  limits.updatedAt = Date.now()
  schedulePersist()
}

/** Apply size-aware calibration to a gpt-tokenizer estimate. Signature unchanged;
 *  an unlearned/empty model returns the estimate unchanged (factorAt → 1.0). */
export function calibrate(modelId: string, gptEstimate: number): number {
  return Math.ceil(gptEstimate * factorAt(modelId, gptEstimate))
}
```

`seedFactorModel(modelId)` 在 Task 3 落实（本 task 先 `return emptyFactorModel()` 占位，Task 3 替换为 seed 查表）。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/lib/auto-truncate/engine.factor-model.test.ts`
Expected: PASS（全部）

- [ ] **Step 5: 不提交（ATOMIC GROUP）**

`bun test src/lib/auto-truncate/engine.factor-model.test.ts` 应全绿。仍**不 typecheck、不 commit**（消费者未改，整站红）——进 Task 3。

## Task 3: 持久化 v2 + DEFAULT_FACTOR_SEED + v1→v2 迁移

**Files:**
- Modify: `src/lib/auto-truncate/engine.ts`（`LearnedLimitsFile`、`persistLimits`、`loadPersistedLimits` §197-277；新增 `DEFAULT_FACTOR_SEED` + `seedFactorModel`）
- Test: `src/lib/auto-truncate/engine.persist.test.ts`（新建）

**Interfaces:**
- Produces:
  - `const DEFAULT_FACTOR_SEED: Record<string, Array<{ factor: number; meanEst: number } | null>>`
  - `function seedFactorModel(modelId: string): FactorModel`
  - `LearnedLimitsFile { version: 2; limits: Record<string, ModelLimits> }`

- [ ] **Step 1: 写失败测试（seed 填充 + v1→v2 迁移 + round-trip）**

```ts
// src/lib/auto-truncate/engine.persist.test.ts
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { factorAt, getLearnedLimits, loadPersistedLimits, resetAllLimitsForTesting, seedFactorModel, setLearnedLimitsPathForTests } from "./engine"

afterEach(() => {
  resetAllLimitsForTesting()
  setLearnedLimitsPathForTests(undefined)
})

test("seedFactorModel populates opus-4.8 buckets with factor+meanEst", () => {
  const fm = seedFactorModel("claude-opus-4.8")
  expect(fm.buckets[3].sampleCount).toBeGreaterThan(0) // [60k,120k) seeded
  expect(fm.buckets[3].meanEst).toBeCloseTo(85_238, -2) // anchor x shipped
  expect(fm.buckets[0].sampleCount).toBe(0) // [0,15k) null → empty
})

test("v1 file migrates: scalar → max bucket, sampleCount → liveSampleCount", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cal-"))
  const path = join(dir, "learned-limits.json")
  // A v1 model WITHOUT a seed entry — scalar lands in the top bucket only.
  writeFileSync(path, JSON.stringify({ version: 1, limits: { "claude-mystery": { tokenLimit: 900_000, calibrationFactor: 2.2, sampleCount: 40, updatedAt: 1 } } }))
  setLearnedLimitsPathForTests(path)
  await loadPersistedLimits()
  const lim = getLearnedLimits("claude-mystery")
  expect(lim?.liveSampleCount).toBe(40)
  expect(lim?.tokenLimit).toBe(900_000)
  expect(factorAt("claude-mystery", 400_000)).toBeCloseTo(2.2, 1) // top bucket
})
```

- [ ] **Step 2: 跑确认失败**

Run: `bun test src/lib/auto-truncate/engine.persist.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 seed 表 + seedFactorModel + v2 persist + 迁移**

```ts
export const DEFAULT_FACTOR_SEED: Record<string, Array<{ factor: number; meanEst: number } | null>> = {
  "claude-opus-4.8": [
    null,
    { factor: 1.284, meanEst: 23_877 },
    { factor: 1.313, meanEst: 48_784 },
    { factor: 1.434, meanEst: 85_238 },
    { factor: 1.625, meanEst: 163_889 },
    { factor: 1.826, meanEst: 333_152 },
  ],
}

/** Synthetic seed weight — small enough that real live/backfill data dominates
 *  within a few hundred samples, non-zero so the anchor exists pre-backfill. */
const SEED_WEIGHT = 500

export function seedFactorModel(modelId: string): FactorModel {
  const fm = emptyFactorModel()
  const seed = DEFAULT_FACTOR_SEED[modelId]
  if (!seed) return fm
  seed.forEach((s, i) => {
    if (!s) return
    fm.buckets[i] = { sumEst: SEED_WEIGHT * s.meanEst, sumReal: SEED_WEIGHT * s.meanEst * s.factor, sampleCount: SEED_WEIGHT, meanEst: s.meanEst }
  })
  return fm
}
```

`persistLimits`（§237）改写 `data`：`{ version: 2, limits: Object.fromEntries(learnedLimits) }`，interface `LearnedLimitsFile { version: 2; limits: Record<string, ModelLimits> }`。

`loadPersistedLimits`（§255-277）改：
```ts
const data = JSON.parse(raw) as { version: number; limits: Record<string, unknown> }
if (data.version === 2) {
  for (const [modelId, lim] of Object.entries(data.limits as Record<string, ModelLimits>)) {
    // boundsVersion 不匹配 → 丢桶重 seed（保留 tokenLimit/liveSampleCount）
    const fm = lim.factorModel?.boundsVersion === FACTOR_BOUNDS_VERSION ? lim.factorModel : seedFactorModel(modelId)
    learnedLimits.set(modelId, { ...(lim.tokenLimit !== undefined && { tokenLimit: lim.tokenLimit }), factorModel: fm, liveSampleCount: lim.liveSampleCount ?? 0, updatedAt: lim.updatedAt ?? Date.now() })
  }
} else if (data.version === 1) {
  for (const [modelId, lim] of Object.entries(data.limits as Record<string, { tokenLimit: number; calibrationFactor: number; sampleCount: number }>)) {
    const fm = DEFAULT_FACTOR_SEED[modelId] ? seedFactorModel(modelId) : seedTopBucketOnly(lim.calibrationFactor)
    learnedLimits.set(modelId, { ...(lim.tokenLimit > 0 && { tokenLimit: lim.tokenLimit }), factorModel: fm, liveSampleCount: lim.sampleCount ?? 0, updatedAt: Date.now() })
  }
}
```
`seedTopBucketOnly(factor)`：`emptyFactorModel()` 后把最大桶设 `{sumEst: SEED_WEIGHT*300_000, sumReal: SEED_WEIGHT*300_000*factor, sampleCount: SEED_WEIGHT, meanEst: 300_000}`。

同时把 Task 2 的 `ensureModelLimits` 里 `seedFactorModel(modelId)` 接线正式生效（替换占位）。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/lib/auto-truncate/engine.persist.test.ts`
Expected: PASS

- [ ] **Step 5: 不提交（ATOMIC GROUP）**

`bun test src/lib/auto-truncate/engine.persist.test.ts` 应全绿。仍**不 typecheck、不 commit**——进 Task 4（消费者 rewire 后整站才绿，一次性原子提交 Task 1-4）。

## Task 4: 消费者更新（去 sampleCount 守卫、margin 改 liveSampleCount、tokenLimit>0 守卫、400 腿 rewire + N1）

**Files:**
- Modify: `src/lib/anthropic/auto-truncate.ts:442`、`src/lib/openai/auto-truncate.ts:96,150`、`src/lib/anthropic/auto-truncate/truncation.ts:152-156`、`src/lib/auto-truncate/engine.ts`（`onTokenLimitExceeded` §94-122、`updateCalibration` 删除或转发、`computeSafetyMargin` 调用面）
- Test: `src/lib/auto-truncate/engine.consumers.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1-3 的 `factorAt`/`calibrate`/`learnCalibration`/`ModelLimits.liveSampleCount`/`ModelLimits.tokenLimit?`
- Produces: `onTokenLimitExceeded` 内部改调 `learnCalibration(modelId, estimatedTokens, reportedCurrent, {isLive:true})`

- [ ] **Step 1: 写失败测试（tokenLimit>0 守卫 + N1 降值守卫 + 400 落桶）**

```ts
// engine.consumers.test.ts
test("seed-only model has undefined tokenLimit → calculateTokenLimit falls back to capabilities", () => {
  ensureModelLimits("claude-opus-4.8") // seeded, no 400 yet
  expect(getLearnedLimits("claude-opus-4.8")?.tokenLimit).toBeUndefined()
})

test("N1: first 400 on a seeded model writes tokenLimit despite undefined start", () => {
  ensureModelLimits("claude-opus-4.8")
  onTokenLimitExceeded("claude-opus-4.8", 900_000, 950_000, 500_000)
  expect(getLearnedLimits("claude-opus-4.8")?.tokenLimit).toBe(900_000)
})

test("400 leg feeds learnCalibration into the size bucket (isLive)", () => {
  onTokenLimitExceeded("m", 900_000, 950_000, 480_000) // real 950k / est 480k ≈ 1.979, bucket5
  expect(factorAt("m", 480_000)).toBeCloseTo(1.979, 1)
  expect(getLearnedLimits("m")?.liveSampleCount).toBe(1)
})
```

- [ ] **Step 2: 跑确认失败**

Run: `bun test src/lib/auto-truncate/engine.consumers.test.ts`
Expected: FAIL

- [ ] **Step 3: 改 engine 与消费者**

`onTokenLimitExceeded`（§94-122）：
- 降值守卫改 N1：`if (existing.tokenLimit === undefined || reportedLimit < existing.tokenLimit)`；用 `ensureModelLimits(modelId)` 建条目（含 seed），设 `limits.tokenLimit = reportedLimit`。
- 校准腿：`if (reportedCurrent !== undefined && estimatedTokens !== undefined && estimatedTokens > 0) learnCalibration(modelId, estimatedTokens, reportedCurrent, { isLive: true })`。删除旧 `updateCalibration`（或保留为 `learnCalibration` 的薄封装以防其它引用 — grep 确认无其它引用后删）。

`calculateTokenLimit`（truncation.ts:152-156）：
```ts
const learned = getLearnedLimits(model.id)
if (learned?.tokenLimit !== undefined && learned.tokenLimit > 0) {
  const margin = computeSafetyMargin(learned.liveSampleCount) // ← liveSampleCount
  return Math.floor(learned.tokenLimit * (1 - margin))
}
// fall through to capabilities（原 §158-162 不变）
```

`anthropic/auto-truncate.ts:442` + `openai/auto-truncate.ts:150`：
```ts
const currentTokens = calibrate(model.id, rawTokens) // 去掉 learned && learned.sampleCount>0 守卫
```
`openai/auto-truncate.ts:96`：`computeSafetyMargin(learned.liveSampleCount)`（原读 `sampleCount`）。

- [ ] **Step 4: 跑测试 + 全量 auto-truncate 单测**

Run: `bun test src/lib/auto-truncate/ src/lib/anthropic/auto-truncate.test.ts src/lib/openai/`
Expected: PASS（注意既有测试若断言旧 `sampleCount`/`calibrationFactor` 字段需同步更新——按 skill `debugging-test-pollution` 判定是测试过时而非源码错）

- [ ] **Step 5: 整站 typecheck 绿（首次）+ 原子提交 Task 1-4**

此时 engine + 全部消费者已自洽，整站 typecheck 应绿。

```bash
bun run typecheck
git add -- src/lib/auto-truncate/engine.ts src/lib/auto-truncate/engine.factor-model.test.ts src/lib/auto-truncate/engine.persist.test.ts src/lib/auto-truncate/engine.consumers.test.ts src/lib/anthropic/auto-truncate.ts src/lib/openai/auto-truncate.ts src/lib/anthropic/auto-truncate/truncation.ts
git commit -m "feat(calibration): size-aware per-bucket factor model (buckets+interp+sliding-window), v2 persistence+seed+migration, consumer rewire"
```

> **S2 实测（此 task 内做）**：对拍一条真实 400 的 `reportedCurrent` 是否含缓存 token（整 prompt 口径），确认 400 腿与成功腿同口径。可从 history 查一条 opus-4.8 `failed` 且 upstream 400 的 entry，读其错误文案 current vs 该请求 usage 的 input+cache。若不含缓存则记入 spec §11 待处理。

## Task 5: CalibrationSink（成功腿）

**Files:**
- Create: `src/lib/observability/sinks/calibration.ts`、`src/lib/observability/sinks/calibration.test.ts`
- Modify: `src/start.ts`（import + `attachCalibrationSink(bus)` 于 §369 后）

**Interfaces:**
- Consumes: `learnCalibration`（Task 2）、`countTotalTokens`（`~/lib/anthropic/auto-truncate`）、`request.completed` 事件的 `entry: HistoryEntryData`
- Produces: `class CalibrationSink`、`function attachCalibrationSink(bus): () => void`

- [ ] **Step 1: 写失败测试**

```ts
// calibration.test.ts — feed a fake request.completed entry, assert the bucket learned.
// 用 makeBus() 测试替身 + 构造 entry.attempts[-1].{upstreamRequest:{format,body}, upstreamResponse:{usage}}
test("learns from a completed anthropic-messages request", async () => {
  const bus = makeTestBus()
  attachCalibrationSink(bus)
  bus.publish({ kind: "request.completed", ctx: fakeCtx(), entry: fakeEntry({
    format: "anthropic-messages",
    body: { model: "claude-opus-4.8", messages: [{ role: "user", content: "x".repeat(200_000) }] },
    usage: { input_tokens: 60_000, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 0 },
  }) })
  await tick() // fire-and-forget countTotalTokens
  expect(getLearnedLimits("claude-opus-4.8")?.liveSampleCount).toBe(1)
})

test("skips non-anthropic-messages format", async () => { /* format:"openai-chat" → no learn */ })
test("never throws on malformed entry", async () => { /* attempts:[] → no crash */ })
```

- [ ] **Step 2: 跑确认失败**

Run: `bun test src/lib/observability/sinks/calibration.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 sink（镜像 telemetry.ts）**

```ts
// calibration.ts
import consola from "consola"

import { countTotalTokens } from "~/lib/anthropic/auto-truncate"
import { learnCalibration } from "~/lib/auto-truncate"
import { state } from "~/lib/state"
import type { MessagesPayload } from "~/types/api/anthropic"

import type { ObservabilityBus, ObservabilityEvent } from "../index"

const REAL_FLOOR = 1000
const EST_FLOOR = 500

export class CalibrationSink {
  private readonly unsubscribe: () => void
  constructor(bus: ObservabilityBus) {
    this.unsubscribe = bus.subscribe(
      (event) => void this.handle(event),
      (event) => event.kind === "request.completed",
    )
  }
  destroy(): void { this.unsubscribe() }

  private async handle(event: ObservabilityEvent): Promise<void> {
    try {
      if (event.kind !== "request.completed") return
      const attempt = event.entry.attempts?.at(-1)
      const req = attempt?.upstreamRequest
      const usage = attempt?.upstreamResponse?.usage
      if (!req || !usage || req.format !== "anthropic-messages") return
      const real = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
      if (real < REAL_FLOOR) return
      const body = req.body as MessagesPayload | undefined
      if (!body?.model) return
      // P-B1: RequestContextSnapshot.resolvedModel is a STRING, not a Model. The
      // Model (with capabilities.tokenizer) comes from the resolved index by name.
      const model = state.modelIndex.get(body.model)
      if (!model) return
      const est = await countTotalTokens(body, model)
      if (est < EST_FLOOR) return
      learnCalibration(model.id, est, real, { isLive: true })
    } catch (err) {
      consola.debug("[calibration-sink] skipped", err) // never throw (fire-and-forget)
    }
  }
}
export function attachCalibrationSink(bus: ObservabilityBus): () => void {
  const sink = new CalibrationSink(bus)
  return () => sink.destroy()
}
```
> `req.body` 的 `.model` 是 wire body 的模型名（resolved dotted name，如 `claude-opus-4.8`），`state.modelIndex` 以此为键。`countTotalTokens(body, model)` 的 model 带 `capabilities.tokenizer`。

- [ ] **Step 4: 跑测试通过 + 注册**

`src/start.ts`：import `attachCalibrationSink` + 在 §369 `attachTelemetrySink(bus)` 后加 `attachCalibrationSink(bus)`。
Run: `bun test src/lib/observability/sinks/calibration.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck + 提交**

```bash
bun run typecheck
git add -- src/lib/observability/sinks/calibration.ts src/lib/observability/sinks/calibration.test.ts src/start.ts
git commit -m "feat(calibration): CalibrationSink learns from completed requests"
```

## Task 6: history backfill（批统计 seed）

**Files:**
- Create: `src/lib/history/sqlite/calibration-backfill.ts`、`src/lib/history/sqlite/calibration-backfill.test.ts`
- Modify: `src/lib/history/sqlite/serialize.ts:805`（`decodeStageRows` 加 `export`）、`src/lib/history/index.ts` + `src/lib/history/state.ts`（导出 `runCalibrationBackfill`/`stopCalibrationBackfill` + 接入 backfill 链）、`src/start.ts`（背景启动）

**Interfaces:**
- Consumes: `getMeta`/`setMeta`（meta.ts）、`decodeStageRows`（serialize.ts，export 后）、`decompress`（compression.ts）、`countTotalTokens`、`learnCalibration`
- Produces: `async function runCalibrationBackfill(db): Promise<void>`、`function stopCalibrationBackfill(): void`

- [ ] **Step 1: 写失败测试（幂等 + tok-weighted 累计对拍 oracle）**

```ts
// calibration-backfill.test.ts — 建临时 DB，插几条 completed opus-4.8 entry（含 request_group stage），
// 跑 backfill，断言桶 factor ≈ 手算 Σreal/Σest；再跑一次断言幂等（version flag 短路，结果不变）。
test("backfill aggregates tok-weighted factor idempotently", async () => {
  const db = makeTempHistoryDb()
  seedEntries(db, [/* {est-controlling body, usage} pairs in bucket3 */])
  await runCalibrationBackfill(db)
  const f1 = factorAt("claude-opus-4.8", 85_000)
  await runCalibrationBackfill(db) // version flag → no-op
  expect(factorAt("claude-opus-4.8", 85_000)).toBe(f1)
})
```

- [ ] **Step 2: 跑确认失败**

Run: `bun test src/lib/history/sqlite/calibration-backfill.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 backfill（镜像 usage-normalize-backfill 骨架 + 内存累加批写）**

**关键（闭合复审 P-B5/B6）**：**不**逐条调 `learnCalibration`（其 WEIGHT_CAP 滑动窗顺序敏感 → 大桶重跑不幂等，且与收尾缩放双重限幅）。改为**内存累加原始 Σreal/Σest**、跑完**按桶覆盖**（仅有数据的桶）。

先在 engine.ts 加批写原语（Task 6 顺带交付）：
```ts
/** Overwrite selected buckets from batch aggregates (backfill). Per-bucket:
 *  only buckets present in `agg` are replaced (empty/sparse buckets keep their
 *  seed — P-B6). Weight capped at WEIGHT_CAP so live learning stays live (P-B5).
 *  isLive=false: does NOT touch liveSampleCount. */
export function applyBackfillBuckets(
  modelId: string,
  agg: Array<{ sumReal: number; sumEst: number; count: number; meanEst: number } | null>,
): void {
  const limits = ensureModelLimits(modelId)
  agg.forEach((a, i) => {
    if (!a || a.count === 0 || a.sumEst <= 0) return
    const scale = a.count > WEIGHT_CAP ? WEIGHT_CAP / a.count : 1
    limits.factorModel.buckets[i] = {
      sumReal: a.sumReal * scale,
      sumEst: a.sumEst * scale,
      sampleCount: Math.min(a.count, WEIGHT_CAP),
      meanEst: a.meanEst,
    }
  })
  limits.updatedAt = Date.now()
  schedulePersist()
}
```

backfill 主体（`usage-normalize-backfill.ts:295-367` 骨架）：
- version key `calibration_backfill_version` / cursor key `calibration_backfill_cursor` / `VERSION=1`。version 命中 → return。
- **per-model 内存累加器** `Map<modelId, Array<{sumReal,sumEst,count,meanEst}>>`（6 桶）。**resumable 累加持久到 meta**：每批把累加器 JSON setMeta（`calibration_backfill_accum`），启动时从 meta 恢复（cursor>0 时）——避免中断丢进度。**不动内存 learnedLimits 桶**（P-B6：跑完才 apply，绝不中途清零/写活桶，避开与 CalibrationSink live 并发）。
- keyset：`SELECT id, started_at, model, input_tokens, cache_read, cache_creation FROM entries_v2 WHERE status='completed' AND model LIKE 'claude%' AND input_tokens IS NOT NULL AND (started_at>? OR (started_at=? AND id>?)) ORDER BY started_at, id LIMIT ?`。real = `input_tokens+cache_read+cache_creation`（短列名）；real<1000 跳过。
- wire：查该 entry 的 `entry_stages` 原始行组 `StageRow[]`（含 `blob_gz`）→ **直接 `decodeStageRows(rows)`**（它内部已 `decompress` 双格式 + 展开 request_group，**不要预先 decompress** —— P-Y1）→ 取最后一个 `stage==="upstream_request"` member 的 `payload.body`；`body.format`... 实为 `payload.format==="anthropic-messages"` 门控（核实 member payload 形状：`.body` 是 Anthropic payload、`.format` 在 member 层）→ `countTotalTokens(body, state.modelIndex.get(model))`（est<500 跳过）→ 累加到 `accum[model][bucketIndexFor(est)]`（sumReal+=real, sumEst+=est, count++, meanEst 增量均值）。缺 `upstream_request`（legacy）→ `counts.skipped++`。
- 每批 setMeta cursor + accum；`await sleep(0)`；协作 `isStopRequested()`；顶层 try/catch never-throw（consola.warn）。
- 收尾（未 stop）：对每个 model 调 `applyBackfillBuckets(model, accum[model])`；setMeta version；清 accum meta；log `skipped/total`（覆盖率）。

- [ ] **Step 4: 跑测试通过 + 接线背景启动**

`serialize.ts:805` 加 `export`。`state.ts` 仿 `startSearchIndexBackfill` 加 `startCalibrationBackfill()`（`void runCalibrationBackfill(getDatabase()).catch(...)`），接到 backfill 链尾（response-preview 之后）或独立 fire。`start.ts` 调用点同其它 backfill。
Run: `bun test src/lib/history/sqlite/calibration-backfill.test.ts`
Expected: PASS

- [ ] **Step 5: 全量 history 单测 + typecheck + 提交**

```bash
bun test src/lib/history/
bun run typecheck
git add -- src/lib/history/sqlite/calibration-backfill.ts src/lib/history/sqlite/calibration-backfill.test.ts src/lib/history/sqlite/serialize.ts src/lib/history/index.ts src/lib/history/state.ts src/start.ts
git commit -m "feat(calibration): recoverable history backfill (batch-stat seed)"
```

## Task 7（Phase 1 收尾）: 活文档同步

**Files:** Modify: `docs/DESIGN.md`（「活的架构现状」加 calibration size-aware 行）、`docs/sync-ghc-api/token-counting.md`（「待改进」节标注已实现 + 链到 spec）、`docs/todo/deferred-backlog.md`（组成感知 factor 暂缓项）、删/改 `docs/todo/better-count-tokens.md`（交接完成，归档或标注已实施）。

- [ ] **Step 1**：DESIGN.md 活架构现状表加行：calibration = size-aware per-bucket 滑动加权均值 + 成功腿 CalibrationSink + backfill；引用 spec。
- [ ] **Step 2**：token-counting.md「待改进」节改为「已实现（Phase 1）」+ 链 spec + plan。
- [ ] **Step 3**：deferred-backlog.md 加「组成/tool-密度感知 factor（残差 ~7%）」暂缓项（根因/当前行为/理想架构/为何暂缓）。
- [ ] **Step 4**：`better-count-tokens.md` 头部标注「已实施，见 spec/plan」或移 `docs/archive/`。
- [ ] **Step 5**：提交 `docs: sync live docs for size-aware calibration (Phase 1)`。

---

# Phase 2 —— 主路径 pre-flight（config 门控，默认 OFF）

价值：主路径省掉大请求那次必然失败的 400 往返（几十秒）。依赖 Phase 1 落地。

## Task 8: config 键 `auto_truncate.preflight`

**Files:**
- Modify: `src/lib/config/schema.ts:648-660`（`AutoTruncateConfigSchema` 加 `preflight: nullableBoolean()`）、`src/lib/config/config.ts:660-668`（读入 state）、`src/lib/state.ts`（加 `autoTruncatePreflight: boolean` 默认 false + setter）、bundled `config.yaml`（注释项）
- Test: `src/lib/config/config.test.ts`（补测 preflight 读入）

- [ ] **Step 1**：写失败测试——config `auto_truncate.preflight: true` → `state.autoTruncatePreflight === true`；缺省 false。
- [ ] **Step 2**：跑确认失败。
- [ ] **Step 3**：schema 加 `preflight: nullableBoolean()` + 注释；config.ts 加 `if (a.preflight !== undefined) setAutoTruncateConfig({ autoTruncatePreflight: a.preflight })`；state.ts 加字段 + 默认 false + `setAutoTruncateConfig` 白名单；config.yaml 加注释项。
- [ ] **Step 4**：跑测试通过 + typecheck。
- [ ] **Step 5**：提交 `feat(config): auto_truncate.preflight flag (default off)`。

## Task 9: codec pre-send hook + Anthropic 实现 + driver 接缝

**Files:**
- Modify: `src/lib/pipeline/types.ts`（`FormatCodec` 加 `preSend?(env): Promise<RequestEnvelope>`）、`src/lib/pipeline/driver.ts:256-268`（首 attempt 调 `await codec.preSend?.(current)`）、`src/lib/codec/anthropic/codec.ts`（实现 `preSend`）
- Test: `src/lib/codec/anthropic/preflight.test.ts`（新建）

**Interfaces:**
- Consumes: `factorAt`/`calibrate`/`calculateTokenLimit`（Phase 1）、`autoTruncateAnthropic`、`countTotalTokens`、`state.autoTruncatePreflight`
- Produces: `FormatCodec.preSend?`、Anthropic codec 的 preSend 实现

- [ ] **Step 1**：写失败测试——
  - `state.autoTruncatePreflight=false` → preSend no-op（env.body 不变）。
  - `predicted > limit` → env.body 被截断（messages 变少）；`predicted <= limit` → 不变。
  - 口径：传给 `autoTruncateAnthropic` 的 targetTokenLimit == `floor(limit/factor)`（gpt 口径）。

- [ ] **Step 2**：跑确认失败。

- [ ] **Step 3**：实现——
  - `types.ts`：`FormatCodec` 加 `preSend?(env: RequestEnvelope): Promise<RequestEnvelope>`（可选，其它 codec 省略）。
  - `driver.ts`（闭合复审 P-B2/B3）：循环内**没有 `attempt` 变量**（只有 `normalRetries`/`learningRetries`）。preSend 须**仅首轮**且**在 `const wire = deps.codec.prepareWire(current)`（driver.ts:256）之前**（否则 wire 已用未截断 body 建好、当轮截断不生效）。用循环前 `let preflightDone = false` 守卫：
    ```ts
    let preflightDone = false
    for (;;) {
      if (!preflightDone) {
        preflightDone = true
        if (deps.codec.preSend) current = await deps.codec.preSend(current)
      }
      const wire = deps.codec.prepareWire(current)   // 现 driver.ts:256，preSend 之后
      ...
    ```
  - Anthropic `codec.ts` `preSend`：
    ```ts
    async preSend(env) {
      if (!state.autoTruncatePreflight) return env
      const body = env.body as MessagesPayload
      const model = env.model // ResolvedModel = Model（envelope.ts:29/90，带 .id + capabilities）
      const est = await countTotalTokens(body, model)
      const factor = factorAt(model.id, est)
      const predicted = Math.ceil(est * factor)
      const limit = calculateTokenLimit(model, DEFAULT_AUTO_TRUNCATE_CONFIG)
      if (limit === undefined || predicted <= limit) return env
      const targetGpt = Math.floor(limit / factor)
      const truncated = await autoTruncateAnthropic(body, model, { checkTokenLimit: true, targetTokenLimit: targetGpt })
      return truncated.wasTruncated ? env.with({ body: truncated.payload }) : env  // env.with 真实 API（envelope.ts:108）
    }
    ```
    截断后循环下一行 `prepareWire(current)` 用新 body 重建 wire —— 无需 hook 内重跑 prepareWire。

- [ ] **Step 4**：跑测试通过 + 全量 pipeline/codec 单测 + typecheck。

- [ ] **Step 5**：提交 `feat(calibration): main-path pre-flight truncation via codec pre-send hook`。

## Task 10（Phase 2 收尾）: 文档 + backlog

- [ ] DESIGN.md 活架构现状加 pre-flight 行（门控 OFF）；spec 头部标 Phase 2 已实施；提交。

---

## Self-Review 覆盖核对（spec → task）

- §3 factor 模型 → Task 1（结构+factorAt）+ Task 2（learnCalibration+calibrate）✓
- §4 CalibrationSink → Task 5 ✓
- §5 持久化/seed/迁移/解耦 → Task 3（v2+seed+迁移）+ Task 4（tokenLimit>0 守卫）✓
- §6 backfill → Task 6 ✓
- §7 pre-flight → Task 8（config）+ Task 9（hook）✓
- §8 消费者非零改动 → Task 4 ✓
- §11 暂缓项 → Task 7 Step 3 ✓
- §12 N1（降值守卫）→ Task 4 ✓；N2（首 attempt）→ Task 9 Step 3 ✓；重要-1（meanEst ship）→ Task 3 seed ✓；重要-2（WEIGHT_CAP）→ Task 2 ✓
- S2（400 cache 口径实测）→ Task 4 Step 5 实测一条真实 400 ✓；S3（backfill skip 覆盖率）→ Task 6 Step 3 skip 计数 ✓

## 计划复审处置（subagent，2026-07-11）

一轮可行性复审（代码签名锚定）抓出 6 BLOCKER + 2 minor，全部已核实并修：
- **P-B1**：Task 5 `event.ctx.resolvedModel` 是 string 非 Model → 改 `state.modelIndex.get(body.model)`（已亲验 events.ts:81）。
- **P-B2/B3**：driver 循环无 `attempt` 变量、preSend 须在 `prepareWire`（driver.ts:256）之前 → Task 9 用循环前 `preflightDone` 守卫、插在 prepareWire 之前（已亲验 driver.ts:248-256）。
- **P-B4**（最关键）：Task 1-3 的整站 typecheck 绿灯门在 Task 4 前不可达（ModelLimits 形状迁移固有原子性）→ Task 1-4 标 **ATOMIC GROUP**，中途只 `bun test <file>`，Task 4 Step 5 一次性整站 typecheck + 原子提交。
- **P-B5**：Task 6 逐条 `learnCalibration`（滑动窗顺序敏感）破坏幂等 → 改内存累加 Σreal/Σest + `applyBackfillBuckets` 批写。
- **P-B6**：Task 6 全清桶丢稀疏桶 seed → 改 per-bucket 覆盖（仅有数据的桶）、跑完才 apply（不中途碰活桶，避开与 live 并发）。
- **P-Y1**：`decodeStageRows` 内部已 decompress → 不预解压，直接传 `StageRow[]`（已亲验 serialize.ts:805-809）。
- **P-Y2**：Task 1 插值测试依赖 Task 2 的 learnCalibration → 移到 Task 2。

已核实正确、无需改：Task 9 `env.model`(=Model)/`env.with`、`calculateTokenLimit` 守卫、`onTokenLimitExceeded` 参序、config 全路径、ESLint 边界、`decodeStageRows`/`decompress`/`StageRow` export 状态、`countTotalTokens` re-export。
