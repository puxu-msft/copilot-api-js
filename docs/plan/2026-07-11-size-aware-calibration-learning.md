# Size-Aware Calibration Learning —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐 task 实施。步骤用 checkbox（`- [ ]`）跟踪。
>
> **实施状态**：未开始（spec 已定稿 + 用户批准，见 [docs/spec/2026-07-11-size-aware-calibration-learning.md](../spec/2026-07-11-size-aware-calibration-learning.md)）。

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
  emptyFactorModel,
  factorAt,
  learnCalibration,
  resetAllLimitsForTesting,
  WEIGHT_CAP,
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

  test("log-interpolates between adjacent populated bucket anchors", () => {
    // two anchors: bucket3 meanEst≈85k factor 1.434, bucket4 meanEst≈164k factor 1.625
    learnCalibration("m", 85_238, Math.round(85_238 * 1.434), { isLive: true })
    learnCalibration("m", 163_889, Math.round(163_889 * 1.625), { isLive: true })
    // below first anchor → clamp to first factor
    expect(factorAt("m", 50_000)).toBeCloseTo(1.434, 2)
    // above last anchor → clamp to last factor
    expect(factorAt("m", 300_000)).toBeCloseTo(1.625, 2)
    // midpoint in log space between the two anchors → between the two factors
    const mid = Math.exp((Math.log(85_238) + Math.log(163_889)) / 2)
    const f = factorAt("m", mid)
    expect(f).toBeGreaterThan(1.434)
    expect(f).toBeLessThan(1.625)
  })
})
```

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

- [ ] **Step 4: 跑测试确认通过（bucketIndexFor + factorAt empty 分支）**

Run: `bun test src/lib/auto-truncate/engine.factor-model.test.ts -t bucketIndexFor`
Expected: PASS

- [ ] **Step 5: typecheck + 提交**

```bash
bun run typecheck
git add -- src/lib/auto-truncate/engine.ts src/lib/auto-truncate/engine.factor-model.test.ts
git commit -m "feat(calibration): size-aware factor model — buckets + log-interp factorAt"
```

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

- [ ] **Step 5: typecheck + 提交**

```bash
bun run typecheck
git add -- src/lib/auto-truncate/engine.ts src/lib/auto-truncate/engine.factor-model.test.ts
git commit -m "feat(calibration): learnCalibration sliding tok-weighted mean + calibrate rewrite"
```

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

- [ ] **Step 5: 全量单测 + typecheck + 提交**

```bash
bun test src/lib/auto-truncate/
bun run typecheck
git add -- src/lib/auto-truncate/engine.ts src/lib/auto-truncate/engine.persist.test.ts
git commit -m "feat(calibration): v2 persistence, bake-in seed table, v1->v2 migration"
```

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

- [ ] **Step 5: typecheck（全站）+ 提交**

```bash
bun run typecheck
git add -- src/lib/auto-truncate/engine.ts src/lib/anthropic/auto-truncate.ts src/lib/openai/auto-truncate.ts src/lib/anthropic/auto-truncate/truncation.ts src/lib/auto-truncate/engine.consumers.test.ts
git commit -m "feat(calibration): rewire consumers to size-aware model + liveSampleCount margin + N1 guard"
```

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
      const model = event.ctx.resolvedModel // {id, capabilities} — confirm accessor at impl time
      if (!body || !model) return
      const est = await countTotalTokens(body, model as never)
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
> 实施注意：`event.ctx` 上 model 的确切 accessor（`resolvedModel`/`model`）+ 是否带 `capabilities.tokenizer` 需在实现时对 `RequestContextSnapshot` 核实（B3 复审确认 usage/body/format 可达，但 model 对象口径要落实）。若快照不带 capabilities，改从 `state.modelIndex.get(req.body.model)` 取 Model。

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

- [ ] **Step 3: 实现 backfill（镜像 usage-normalize-backfill 骨架）**

要点（完整代码按 `usage-normalize-backfill.ts:295-367` 骨架改写）：
- `CALIBRATION_BACKFILL_VERSION_KEY = "calibration_backfill_version"`、`CURSOR_KEY = "calibration_backfill_cursor"`、`VERSION = 1`。version 命中 → return。
- 首次运行（cursor==0）：对 seed 目标模型的桶**清零**（`ensureModelLimits(model).factorModel.buckets` 重置为空），避免叠加出厂 seed。
- keyset：`SELECT id, started_at, model, input_tokens, cache_read, cache_creation FROM entries_v2 WHERE status='completed' AND model LIKE 'claude%' AND input_tokens IS NOT NULL AND (started_at > ? OR (started_at=? AND id>?)) ORDER BY started_at, id LIMIT ?`。
- 每行：读 `entry_stages` 的 `request_group` blob → `decompress()`（双格式）→ `decodeStageRows()` 展开 → 取最后一个 `stage==="upstream_request"` member 的 `payload.body`（`format==="anthropic-messages"` 门控）→ `countTotalTokens` → `learnCalibration(model, est, real, { isLive: false })`。缺 `upstream_request`（legacy）→ `counts.skipped++`。
- 每批 setMeta cursor；`await sleep(0)` 让出；协作 `isStopRequested()`；never-throw（顶层 try/catch consola.warn）。
- 收尾（未被 stop）：对每个 seed 目标模型的桶按 `sampleCount>WEIGHT_CAP` 比例缩放到 CAP（让 live 立即进滑动窗）；setMeta version；`schedulePersist()`；log skip 覆盖率。

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
  - `driver.ts`：在 `for(;;)` 循环**首 attempt**（`attempt===0`）、`prepareWire` 前或 `prepareWire→send` 之间：`if (attempt === 0) current = await deps.codec.preSend?.(current) ?? current`。
  - Anthropic `codec.ts` `preSend`：
    ```ts
    async preSend(env) {
      if (!state.autoTruncatePreflight) return env
      const body = env.body as MessagesPayload
      const model = env.model // ResolvedModel → Model
      const est = await countTotalTokens(body, model)
      const factor = factorAt(model.id, est)
      const predicted = Math.ceil(est * factor)
      const limit = calculateTokenLimit(model, DEFAULT_AUTO_TRUNCATE_CONFIG)
      if (limit === undefined || predicted <= limit) return env
      const targetGpt = Math.floor(limit / factor)
      const truncated = await autoTruncateAnthropic(body, model, { checkTokenLimit: true, targetTokenLimit: targetGpt })
      return truncated.wasTruncated ? env.with({ body: truncated.payload }) : env
    }
    ```
    （截断后 driver 循环下一步的 `prepareWire(current)` 会用新 body 重建 wire —— 无需 hook 内重跑 prepareWire。核实 driver 循环顺序确保 preSend 在 prepareWire 之前。）

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
- S2（400 cache 口径实测）→ Task 4 实施时对拍一条真实 400（记 §11）；S3（backfill skip 覆盖率）→ Task 6 Step 3 skip 计数 ✓
