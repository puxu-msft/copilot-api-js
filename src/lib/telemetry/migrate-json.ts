/**
 * telemetry.db 迁移（P6）—— 把旧 `request-telemetry.json`（V3 envelope，及结构上兼容的
 * V2 modelBuckets / V1 accepted）历史**全量吸收**进 telemetry.db，绝不丢弃（用户决策）。
 * 为 P7「dimBuckets 重建源翻转 JSON→SQLite」铺路：P7 rebuild 前 tel_raw 必须已含旧历史，
 * 否则 rebuild 丢迁移前数据。
 *
 * ## 承重不变量（双计防护）
 *
 * - **legacy JSON（启动前数据）与 dual-write tel_raw（启动后 outbox 增量）是不相交请求集**：
 *   dual-write outbox 只累积本进程启动后的新请求，故迁移首启时 tel_raw 只有启动后数据、
 *   JSON 有启动前数据。同一 current 5min 桶 = JSON 的启动前部分 + dual-write 的启动后部分
 *   = **加性正确总和**（互斥请求集）。当前桶在其 hour 封口前不会被 rollup 上卷，所以 backfill
 *   种子的 rollup 也绝不会把「尚在累加的当前桶」提前卷走（{@link rollup.ts} 封桶边界守卫）。
 * - **唯一双计风险 = backfill 重跑**（重复导入 JSON）→ `tel_meta` **version 守卫**
 *   （`json_backfill_version`，完成后短路，re-run no-op）。version 守卫与全部写入落在**同一
 *   事务**内原子提交：崩溃则整批回滚、下次重跑同批不双计；成功则守卫置位、re-run 短路。
 * - **in-memory dimBuckets 与 tel_raw 是不同 store**：backfill 写 tel_raw，不碰 dimBuckets
 *   （后者 P6 期仍从 JSON 载、P7 才翻转）。二者无双计（不同存储）。
 *
 * ## 固定桶历史无损性（HIGH-1：SQLite 无固定桶列）
 *
 * 旧 JSON 的 `__histograms`（固定桶）**不映射进 SQLite**（schema 只存 DDSketch hist_blob、
 * 无固定桶列，见 {@link db.ts}）。旧固定桶无原始逐值、无法无损重建 sketch，故迁移前时段的
 * tel_raw 桶 `hist_blob` 为 NULL（sketch 层对迁移前时段从空开始）。历史固定桶的无损性由
 * **旧 JSON 归档保留**承担（{@link cleanupOrphanTelemetryTmpFiles} 只删 `.tmp.*` 孤儿、
 * 绝不删 JSON 本体）。迁移边界记 `tel_meta['json_backfill_boundary_ts']`，`/api/stats` 据此
 * 让迁移前 sketch 缺失可辨识（{@link read.ts} readJsonBackfillBoundaryTs，richest-data-flow 对称面）。
 *
 * ## 可恢复骨架
 *
 * 因源是单文件一次读入内存后逐 dim 处理，**keyset cursor 非必需**（不像 history 扫大表需分页
 * 续跑）——但 version 守卫（防重跑双计）+ never-throw（背景工作、逃逸 rejection 崩进程）+
 * cooperative-stop（匹配 shutdown phase）**必须**。cost float→micro 用 `round(cost*1e6)`
 * 逐字段缩放，对齐 dual-write 写路径的 `microCost`（{@link request-telemetry.ts}）。
 */
import consola from "consola"
import fs from "node:fs/promises"
import path from "node:path"

import { type TelemetryDatabase } from "./db"
import {
  //
  internDim,
  internKey,
} from "./dictionary"
import {
  //
  type RollupConfig,
  runRollupTick,
} from "./rollup"
import {
  //
  incrementCumulativeAccepted,
  readMetaInt,
  type SettledMeasures,
  upsertAccepted,
  upsertCumulative,
  upsertSettledTier,
  writeMetaInt,
} from "./store"

/** tel_meta 键：JSON 全量吸收 backfill 的完成 version 守卫（防重跑双计）。 */
const JSON_BACKFILL_VERSION_KEY = "json_backfill_version"
/** tel_meta 键：迁移边界时间戳（= backfill 时的 now）。`/api/stats` 据此标注迁移前 sketch 缺失。 */
export const JSON_BACKFILL_BOUNDARY_TS_KEY = "json_backfill_boundary_ts"

/**
 * 当前 JSON 全量吸收 backfill 的 schema 版本。完成后写入 `tel_meta['json_backfill_version']`；
 * 下次启动读到相等即短路 no-op（re-run 幂等）。若未来 backfill 逻辑变更需重跑，bump 此值。
 */
export const TELEMETRY_JSON_BACKFILL_VERSION = 1

/**
 * legacy 扁平 counters 名（camelCase）→ SQLite 可加列（snake_case）+ 是否 cost（float→micro）的
 * 前向映射。逐条是 {@link read.ts} 的 `COUNTER_PROJECTIONS`（micro→float 读向）的**逆变换**：
 * cost 列 `Math.round(v * 1e6)`（对齐 dual-write 的 `microCost`）、其余列 `Math.round(v)`
 * （legacy 计数本就整数，round 只防历史非整值残留）。18 项对齐 `MEASURE_NAMES`（BASE9+COST5+
 * EXTRA1+FEATURE3）。缺省字段（JSON 里没有该 counter）视为 0、不写入 measures（加性 UPSERT 只加提供的）。
 */
const COUNTER_TO_COLUMN: ReadonlyArray<{ counterName: string; sqlCol: keyof SettledMeasures; cost: boolean }> = [
  { counterName: "requestCount", sqlCol: "req_count", cost: false },
  { counterName: "successCount", sqlCol: "success_count", cost: false },
  { counterName: "failureCount", sqlCol: "failure_count", cost: false },
  { counterName: "totalDurationMs", sqlCol: "total_duration_ms", cost: false },
  { counterName: "queueWaitMs", sqlCol: "queue_wait_ms", cost: false },
  { counterName: "inputTokens", sqlCol: "input_tok", cost: false },
  { counterName: "outputTokens", sqlCol: "output_tok", cost: false },
  { counterName: "cacheReadInputTokens", sqlCol: "cache_read_tok", cost: false },
  { counterName: "cacheCreationInputTokens", sqlCol: "cache_creation_tok", cost: false },
  { counterName: "reasoningTokens", sqlCol: "reasoning_tok", cost: false },
  { counterName: "costInputTokens", sqlCol: "cost_input_micro", cost: true },
  { counterName: "costOutputTokens", sqlCol: "cost_output_micro", cost: true },
  { counterName: "costCacheReadInputTokens", sqlCol: "cost_cache_read_micro", cost: true },
  { counterName: "costCacheCreationInputTokens", sqlCol: "cost_cache_creation_micro", cost: true },
  { counterName: "costReasoningTokens", sqlCol: "cost_reasoning_micro", cost: true },
  { counterName: "thinkingBlocksNonEmpty", sqlCol: "thinking_nonempty", cost: false },
  { counterName: "thinkingBlocksEmptySigned", sqlCol: "thinking_empty_signed", cost: false },
  { counterName: "thinkingBlocksEmptyUnsigned", sqlCol: "thinking_empty_unsigned", cost: false },
]

/**
 * 把一个 legacy 扁平 counters bag 映射成 {@link SettledMeasures}（snake_case、cost→micro）。
 * `__histograms` sibling（固定桶）**不导入**（HIGH-1：SQLite 无固定桶列、无法无损重建 sketch），
 * 也绝不当可加列——只遍历白名单 {@link COUNTER_TO_COLUMN}，未知/保留字段天然被忽略。0 值不写入
 * （加性 UPSERT 只加提供的字段，缺省即 0）。
 */
function countersToMeasures(counters: Record<string, unknown>): SettledMeasures {
  const measures: SettledMeasures = {}
  for (const { counterName, sqlCol, cost } of COUNTER_TO_COLUMN) {
    const raw = counters[counterName]
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw === 0) continue
    measures[sqlCol] = cost ? Math.round(raw * 1e6) : Math.round(raw)
  }
  return measures
}

/** legacy JSON 的最小结构投影（防御性：全部字段可选、运行时逐层校验，不信任 JSON.parse 的 unknown 形状）。 */
interface LegacyTelemetryJson {
  buckets?: Record<string, unknown>
  dimensions?: Record<string, unknown>
  modelBuckets?: Record<string, unknown>
}

/** V2 → 迁移用的 model 维度名（对齐 request-telemetry.ts 的 `MODEL_DIMENSION`）。 */
const MODEL_DIMENSION = "model"

/**
 * 把旧 `request-telemetry.json` 的 **init 时刻快照** 全量吸收进 telemetry.db。version 守卫 +
 * never-throw + 可选 cooperative-stop。
 *
 * **结构性 disjointness（根因）**：本函数吸收的是调用方在 init 时刻读入并冻结的 JSON 字符串
 * `snapshotJson`，**绝不在 backfill 时刻重读可变文件**。这把「legacy JSON（启动前）与 dual-write
 * tel_raw（启动后 outbox 增量）不相交」从**时序保证升为结构保证**：若 backfill 时重读文件，某个
 * post-listen persist tick 可能已把 dual-write 已写进 tel_raw 的 post-startup 请求并回同一 JSON 文件，
 * 于是 backfill 会把它们再导一次、当前桶双计。消费 init 快照后，backfill 见到的**恰是 pre-startup
 * 那一刻的内容**、永不含任何 post-startup persist 写入 → disjointness 结构成立。快照的读取 / 缺失 /
 * 损坏判定与「读一次、消费后清空」的生命周期由调用方（`request-telemetry.ts`）负责。
 *
 * 解析失败（理论上不该发生——init 已验证可解析后才 stash）→ warn + skip（不设守卫、可重试）。
 * 空但可解析（零 settled 行）→ 设 version 守卫（已处理、不再重扫）但**不设 boundary_ts**（无迁移前
 * settled 数据、避免 lifetime `preMigrationSketchGap` 假阳性）。成功吸收 ≥1 settled 行后调
 * {@link runRollupTick} 把 backfilled raw 种子上卷进 hourly/daily，使长窗 `/api/stats` 立即可见历史。
 *
 * @param snapshotJson init 时刻冻结的 JSON 文件内容（调用方保证非 null——缺失/损坏时不调用本函数）。
 * @param now 迁移边界时间戳（生产传 `Date.now()`、测试传固定值）：写入 boundary_ts + 传给 rollup。
 * @param shouldStop 可选 cooperative-stop getter（匹配 shutdown phase）：置位则在写入前优雅放弃（不设守卫、下次重试）。
 */
export function migrateJsonToTelemetryDb(
  db: TelemetryDatabase,
  snapshotJson: string,
  now: number,
  rollupConfig: RollupConfig,
  shouldStop?: () => boolean,
): void {
  try {
    // ── version 守卫：完成过则短路 no-op（防重跑双计）。 ──
    if (readMetaInt(db, JSON_BACKFILL_VERSION_KEY) === TELEMETRY_JSON_BACKFILL_VERSION) return
    if (shouldStop?.()) return

    let parsed: LegacyTelemetryJson
    try {
      parsed = JSON.parse(snapshotJson) as LegacyTelemetryJson
    } catch (err) {
      // 理论上不可达（调用方 init 已成功 parse 后才 stash）；防御性 never-throw、不设守卫、下次可重试。
      consola.warn(`[telemetry] json backfill skipped — snapshot is not parseable (${err instanceof Error ? err.message : String(err)})`)
      return
    }

    if (shouldStop?.()) return

    // ── 全部写入 + version 守卫 + boundary_ts 落在同一事务：原子提交（崩溃整批回滚、不半坏、不双计）。 ──
    db.transaction(() => {
      let acceptedTotal = 0

      // accepted 流（任何版本共有的 `buckets`）：bucketTs → accept 计数。
      if (parsed.buckets && typeof parsed.buckets === "object") {
        for (const [tsStr, count] of Object.entries(parsed.buckets)) {
          const bucketTs = Number(tsStr)
          if (!Number.isFinite(bucketTs) || typeof count !== "number" || !Number.isFinite(count) || count <= 0) continue
          upsertAccepted(db, bucketTs, count)
          acceptedTotal += count
        }
      }
      if (acceptedTotal > 0) incrementCumulativeAccepted(db, acceptedTotal)

      // settled 可加维度：V3 generic `dimensions`（结构优先），否则 V2 `modelBuckets` → model 维度。
      // 结构判定（非仅靠 version tag）与内存 loader 的防御式检查同构，对任何版本鲁棒、全量吸收不丢。
      // 返回实际写入的 settled 行数——boundary_ts 只在真吸收过 pre-migration settled 数据时才记（见下）。
      let settledRows = 0
      if (parsed.dimensions && typeof parsed.dimensions === "object") {
        settledRows = absorbDimensions(db, parsed.dimensions)
      } else if (parsed.modelBuckets && typeof parsed.modelBuckets === "object") {
        settledRows = absorbModelBuckets(db, parsed.modelBuckets)
      }

      // 完成守卫（同事务原子）：re-run 短路——**无条件**置位（空 JSON 也算「已处理」、不再重扫）。
      writeMetaInt(db, JSON_BACKFILL_VERSION_KEY, TELEMETRY_JSON_BACKFILL_VERSION)
      // 迁移边界：**仅当**真吸收过 ≥1 settled 行才记（让迁移前 sketch 缺失可辨识）。零 settled 行的空
      // backfill 不记 boundary，否则 lifetime 的 `preMigrationSketchGap = boundary!==null` 会在「实际吸收
      // 零条 pre-migration settled 数据」时假报 true。
      if (settledRows > 0) writeMetaInt(db, JSON_BACKFILL_BOUNDARY_TS_KEY, now)
    })()

    // ── rollup 种子（事务已提交，raw 对 rollup 的独立事务可见）：把 backfilled raw 卷进 hourly/daily，
    //    使长窗 `/api/stats`（30d/90d/lifetime 读 SQLite 层）立即可见历史。runRollupTick 自身 never-throw。 ──
    runRollupTick(db, now, rollupConfig)
  } catch (err) {
    // 顶层 never-throw：背景工作逃逸的 rejection 会变 unhandledRejection 崩进程。事务已原子回滚，
    // 未设守卫 → 下次启动可重试；DB 在脚下关闭（shutdown race）同样在此优雅收敛。
    consola.warn("[telemetry] json backfill aborted (error — startup continues)", err)
  }
}

/**
 * 吸收 V3 generic `dimensions[dim].buckets[ts][key] = countersBag` 进 tel_raw + tel_cumulative
 * （逐 dim intern、逐桶可加）。返回实际写入的 settled 行数（供 boundary_ts 门控）。
 */
function absorbDimensions(db: TelemetryDatabase, dimensions: Record<string, unknown>): number {
  let settledRows = 0
  for (const [dimName, dimValue] of Object.entries(dimensions)) {
    if (!dimValue || typeof dimValue !== "object") continue
    const buckets = (dimValue as { buckets?: unknown }).buckets
    if (!buckets || typeof buckets !== "object") continue
    const dimId = internDim(db, dimName)
    for (const [tsStr, keysValue] of Object.entries(buckets as Record<string, unknown>)) {
      const bucketTs = Number(tsStr)
      if (!Number.isFinite(bucketTs) || !keysValue || typeof keysValue !== "object") continue
      for (const [key, counters] of Object.entries(keysValue as Record<string, unknown>)) {
        if (!counters || typeof counters !== "object") continue
        if (upsertKeyMeasures(db, dimId, key, bucketTs, counters as Record<string, unknown>)) settledRows += 1
      }
    }
  }
  return settledRows
}

/**
 * 吸收 V2 legacy `modelBuckets[ts][model] = PersistedModelTelemetry` → model 维度（对齐内存
 * loadV2ModelBuckets）。返回实际写入的 settled 行数（供 boundary_ts 门控）。
 */
function absorbModelBuckets(db: TelemetryDatabase, modelBuckets: Record<string, unknown>): number {
  const dimId = internDim(db, MODEL_DIMENSION)
  let settledRows = 0
  for (const [tsStr, modelsValue] of Object.entries(modelBuckets)) {
    const bucketTs = Number(tsStr)
    if (!Number.isFinite(bucketTs) || !modelsValue || typeof modelsValue !== "object") continue
    for (const [model, counters] of Object.entries(modelsValue as Record<string, unknown>)) {
      if (!counters || typeof counters !== "object") continue
      if (upsertKeyMeasures(db, dimId, model, bucketTs, counters as Record<string, unknown>)) settledRows += 1
    }
  }
  return settledRows
}

/**
 * 把一个 (dim,key,bucket) 的 legacy counters 映射成 measures，写 tel_raw（分桶可加）+ tel_cumulative
 * （Σ 7d 窗，是我们唯一有的 lifetime 种子——JSON 不含进程生命周期 dimSinceStart，故这是**诚实的部分累计**，
 * 无法恢复 pre-7d lifetime；见模块头 richest-data-flow）。全 0 的 key 跳过（不建空行）、返回 false。sketch
 * 不写（HIGH-1：迁移前时段无 hist_blob）。返回 true 当且仅当实际写入了一行（供 boundary_ts 门控计数）。
 */
function upsertKeyMeasures(db: TelemetryDatabase, dimId: number, key: string, bucketTs: number, counters: Record<string, unknown>): boolean {
  const measures = countersToMeasures(counters)
  // 空 measures（全 0 或只有 __histograms）→ 不建行（加性 UPSERT 会 INSERT 一个全 0 行，无意义且污染 key 集）。
  if (Object.keys(measures).length === 0) return false
  const keyId = internKey(db, dimId, key)
  upsertSettledTier(db, "tel_raw", bucketTs, dimId, keyId, measures)
  upsertCumulative(db, dimId, keyId, measures)
  return true
}

/**
 * 启动清理孤儿 `request-telemetry.json.tmp.*`（原子写残余，见 {@link atomic-fs.ts} 的 tmp 命名
 * `<base>.tmp.<pid>.<ts>.<seq>.<random>`）。**精确前缀匹配** `<base>.tmp.`：只删失败的临时写残余，
 * **绝不删** JSON 本体、`.corrupted.*` 归档、`.migrated.*` 或任何非 `.tmp.` 后缀文件（no-destructive）。
 * never-throw（背景清理、逃逸 rejection 崩进程）：目录不存在 / unlink 失败逐个吞掉。
 */
export async function cleanupOrphanTelemetryTmpFiles(jsonPath: string): Promise<void> {
  const dir = path.dirname(jsonPath)
  const base = path.basename(jsonPath)
  const tmpPrefix = `${base}.tmp.`
  let entries: Array<string>
  try {
    entries = await fs.readdir(dir)
  } catch {
    // 目录不存在（首启前）/ 读失败 → 无孤儿可清，静默返回。
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(tmpPrefix)) continue
    try {
      await fs.unlink(path.join(dir, entry))
    } catch (err) {
      // 单个 unlink 失败（并发已被别的进程清走 / 权限）不阻塞其余，也绝不崩。
      consola.debug(`[telemetry] failed to remove orphan tmp file ${entry}`, err)
    }
  }
}
