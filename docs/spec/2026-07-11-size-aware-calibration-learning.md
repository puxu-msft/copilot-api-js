# Spec：auto-truncate calibration —— size-aware 学习 + 从成功请求学习 + history backfill

**日期**：2026-07-11
**状态**：**已实施**（Phase 1 + Phase 2 均落地，分支 `feat/size-aware-calibration`）。原草案 v2 已过两轮 subagent 对抗审查 + 全部 BLOCKER/I 级修订并经用户确认。
**关联**：认知底稿 [docs/sync-ghc-api/token-counting.md](../sync-ghc-api/token-counting.md)；离线验证 [exp/token-calibration-size-aware/CONCLUSIONS.md](../../exp/token-calibration-size-aware/CONCLUSIONS.md)；交接底稿 [docs/todo/better-count-tokens.md](../todo/better-count-tokens.md)。

## 1. 问题与目标

### 1.1 现状与根因

auto-truncate 用本地 o200k（gpt-tokenizer）估算 Anthropic 请求 token 数，靠一个 per-model **calibration factor** 校正 o200k 与 Claude 原生 tokenizer 的**词表失配**（非结构开销，已被实测证伪结构假说，见底稿）。

当前 factor **只从 400 token-limit 错误学习**（`onTokenLimitExceeded`）。400 只发生在巨型超限请求上——采样偏差。实测 `learned-limits.json`：opus-4.8 **factor 2.202 / 397 samples**，只覆盖 factor 谱最大端。

**离线实测（800 条真实 opus-4.8 completed，wire payload 口径）证实两点**：

1. factor 是请求规模的**干净单调函数**（`corr(factor, log(localEstimate))=0.78`）：`[30k,60k)≈1.32 → [60k,120k)≈1.42 → [120k,240k)≈1.62 → [240k,inf)≈1.84`。
2. 当前生产固定 2.202 对典型请求**高估约 50%**（MAPE 50.1%，median 50.6%）。

### 1.2 消费者与真实价值

learned `calibrationFactor` 的**唯一消费者**是 `checkNeedsCompactionAnthropic`（`calibrate()`），被两处调用（另 OpenAI 侧 `checkNeedsCompaction` 也调 `calibrate`，openai/auto-truncate.ts:150，§8 覆盖）：

- **`count-tokens` route**（`/v1/messages/count_tokens`）——真实用户价值：Claude Code CLI 调它决定**客户端自动 compact**。无 anthropic key 时完全靠本地 o200k + factor。当前 factor 2.2 高估典型请求 → 误报超限 → 返回 inflate 的 95% 计数 → **触发过早的客户端压缩**。
- `debug` route。

**反应式截断路径不消费全局 factor**（用 per-request `ratio = reportedCurrent / gptCount`），主 `/v1/messages` 路径当前也不做 pre-check——所以改进 factor 对主路径截断**无直接影响，除非新增 pre-flight**（§6）。

### 1.3 目标

1. calibration 改为 **size-aware**（per-bucket factor），消除单标量对典型/巨型请求二选一的固有损失。
2. 让 calibration **也从成功请求学习**（成功 usage 是无采样偏差、丰富得多的信号），与 400 学习统一进同一套 per-bucket EWMA。
3. **出厂 bake-in 默认桶 factor**（离线训练结果）实现冷启动瞬时收敛。
4. **backfill 现有 history**（批统计 seed，幂等可重跑）在用户真实数据上精修。
5. **主路径 pre-flight**（Phase 2，config 门控）用 learned factor 预判超限、预截断，省掉必然失败的 400 往返。

### 1.4 离线验证结论（决策依据）

| 模型 | MAPE | median | p90 |
|---|---|---|---|
| 当前生产（固定 2.202，仅 400 学） | 49.4% | 48.8% | 77.7% |
| 单标量（成功学习 ~1.5） | 12.8% | 10.7% | 26.2% |
| **size-bucketed（log 插值）** | **6.9%** | 4.8% | 17.6% |
| size-bucketed（时间留出集，后 30% 未来请求） | **6.4%** | 3.9% | 17.5% |

size-aware 把误差从 50% 砍到 6.9%，且在**未来请求**上同样成立（6.4%）——稳定可靠、非过拟合。残差 ~7% 是规模无法解释的 tool 密度噪声，对两消费者配安全边际均可接受。

## 2. Non-Goals / 暂缓

- **组成/tool-密度感知 factor**（超越纯 size 的第二维）：残差 ~7% 来自此，但当前精度已足够两消费者。暂缓项，记 `docs/todo/deferred-backlog.md`。
- **非 Claude 模型的 size-aware**：OpenAI 路径 factor 机制独立（`src/lib/openai/auto-truncate.ts`），本 spec 只改共享 engine + Anthropic 侧；OpenAI 侧沿用共享 engine 的 size-aware API（factor 模型对所有模型生效，只是 seed 表仅有 claude 数据）。
- **反应式 per-request ratio 路径**：已是 per-request 最优，不动。
- **count_tokens 走 Anthropic API 的分支**：有 key 时仍优先真 API（§5.1 不变）。

## 3. factor 模型（size-aware）

### 3.1 数据结构

用 per-bucket **cumulative tok-weighted** factor 取代标量 `calibrationFactor`。桶存累计 `sumReal/sumEst` 而非 EWMA——因为离线验证的模型正是 tok-weighted 桶均值（`Σreal/Σest`），backfill 批统计与 live 增量遂成**同一估计量**、seam 自洽（闭合 review I3；EWMA(alpha=0.3) 有效窗~5 会让运行态偏离被验证模型、随近期组成抖动）。

```ts
/** 全局桶边界常量（localEstimate 阈值，log 间隔）。版本化——变更须升 boundsVersion。 */
const BUCKET_BOUNDS = [0, 15_000, 30_000, 60_000, 120_000, 240_000, Infinity] // 6 桶

interface FactorBucket {
  sumReal: number      // Σ real_tokens（seed/backfill/live 累加）
  sumEst: number       // Σ local_estimate；factor = clamp(sumReal / sumEst, 0.5, 3.0)（读时算）
  sampleCount: number  // 该桶样本数（含 seed + backfill + live，供 §3.3 anchor 空桶判定）
  meanEst: number      // 该桶样本 est 的累计均值（= 插值锚点 x，闭合 review I4 顶桶中心）
}
interface ModelLimits {
  tokenLimit?: number             // 可选：仅从 400 学到才有；缺失(seed-only)时 calculateTokenLimit 回退 capabilities（闭合 review B2）
  factorModel: {
    boundsVersion: number         // load 时不匹配则丢弃桶重 seed
    buckets: Array<FactorBucket>  // 长度 = BUCKET_BOUNDS.length - 1
  }
  /** 仅 LIVE 学习事件（success + 400）累加；seed/backfill 不计。驱动 computeSafetyMargin——
   *  合成先验不该让安全边际立刻坍缩（over-truncation 不可逆，闭合 review I2；richest-data-flow「合成物打标记」）。 */
  liveSampleCount: number
  updatedAt: number
}
```

- **x 轴统一为 localEstimate（o200k 计数）**：学习/查询同口径落桶，无需换算。
- 空桶（`sampleCount==0`）不参与 §3.3 插值。

### 3.2 学习（落桶滑动加权均值）

```
learnCalibration(modelId, localEstimate, realTokens, { isLive }):
  确保 modelId 有 ModelLimits（新模型：seed 填充 + factorModel 初始化，见 §5）
  b = bucketIndex(localEstimate)
  // 强制窗口衰减（见下「为何强制 CAP」）：达权重上限前纯累加，之后按比例衰减保持有效窗 ≈ CAP
  effWeight = bucket[b].sampleCount           // 权重 ≈ 样本数
  if effWeight >= WEIGHT_CAP:
     decay = WEIGHT_CAP / (WEIGHT_CAP + 1)
     bucket[b].sumReal *= decay ; bucket[b].sumEst *= decay ; effWeight = WEIGHT_CAP
  bucket[b].sumReal += realTokens ; bucket[b].sumEst += localEstimate
  bucket[b].meanEst = (bucket[b].meanEst * effWeight + localEstimate) / (effWeight + 1)   // 锚点 x 同窗滑动
  bucket[b].sampleCount = min(bucket[b].sampleCount + 1, WEIGHT_CAP)
  if isLive: model.liveSampleCount++          // seed/backfill 传 isLive=false（不计入 margin）
```

`factor = clamp(sumReal / sumEst, 0.5, 3.0)`（读时算）。这是 **~WEIGHT_CAP 样本的滑动 tok-weighted 加权均值**。

**为何强制 CAP（闭合 review 重要-2）**：cumulative 纯累加 + 覆盖式 backfill 会让 live 学习冻结——主力桶 backfill 后 `sumEst≈1671×90k≈1.5e8`，一条 live 样本只挪 factor ~6e-6，live 形同死代码，且与「live 精修覆盖」矛盾。**强制 CAP** 二者兼得：`WEIGHT_CAP`（定 **2000**）下，桶内 stddev 0.1 / √2000 ≈ 0.002 抖动可忽略（稳定，无 EWMA 的 recency 抖），但若 tokenizer 真变（新模型版本换 tokenizer）live 能在 ~2000 请求内漂移适应（不冻结）。backfill 若已写满 2000 权重则 live 立即进入滑动窗，与 backfill 同一估计量、无缝接管。

**成功样本与 400 样本喂同一套 per-bucket 累计**——400 天然落最大桶、成功横跨全桶，size 分桶自动隔离两个 regime，交接文档 #4「成功 vs 400 共用 factor」张力**由分桶结构消解**。

**两条 live 学习腿的接线**（闭合 review S1）：
- **成功腿**：§4 `CalibrationSink`，`isLive=true`。
- **400 腿**：现 `onTokenLimitExceeded`→`updateCalibration(actualTokens, estimatedTokens)`（engine.ts:94/148）切成 `learnCalibration(modelId, estimatedTokens/*localEstimate*/, actualTokens/*real*/, {isLive:true})`——注意**参序调整**（localEstimate 在前）+ 400 自然落顶桶。新模型首个 400 建 ModelLimits 时须初始化 `factorModel`（含 seed），否则空模型。
  **N1（tokenLimit 可选的交互）**：`onTokenLimitExceeded` 的降值守卫 `reportedLimit < existing.tokenLimit`（engine.ts:99）在 seed 建了 `existing.tokenLimit===undefined` 时会 `< undefined` → NaN → false → **400 学到的 tokenLimit 永不写入**。须改为 `existing.tokenLimit === undefined || reportedLimit < existing.tokenLimit`。
- **口径对齐**（闭合 review S2）：成功腿 real = `input_tokens + cache_read + cache_creation`（整 prompt 口径）；400 腿 `reportedCurrent` 来自错误文案「current: N」。两腿须同为整 prompt 口径才能同桶累计——实施时对拍一条真实 400 确认 N 含缓存（Claude Code 缓存占比大，若 N 只含非缓存 input 则 cache-heavy 请求两腿偏）。

### 3.3 查询（`calibrate` 内部改，签名保持）

`calibrate(modelId, gptEstimate)` **对外签名不变**，但语义上不再有「sampleCount==0 才 no-op」的外部守卫——内部空模型返回 gptEstimate 原值（factor=1.0）。消费者侧须相应**去掉 `learned.sampleCount>0 ? calibrate() : raw` 的守卫**改为直接 `calibrate()`（见 §8，**非零改动**）。

```
calibrate(modelId, gptEstimate):
  return ceil(gptEstimate * factorAt(modelId, gptEstimate))   // x 即 gptEstimate 自身

factorAt(est):
  anchors = 各【已填充】桶的 {x: bucket.meanEst, y: clamp(sumReal/sumEst)}，按 x 升序
  空 anchors（新模型无 seed 无学习）→ 1.0（no-op）
  est ≤ 首 anchor.x → 首 anchor.y（端点 clamp）
  est ≥ 末 anchor.x → 末 anchor.y
  否则 → 相邻两 anchor 间 log(est) 线性插值
```

**锚点 x = 桶实际 est 均值（`meanEst`）**，非桶几何中心——数据驱动，规避 [0,15k)/[240k,inf) 的中心退化（闭合 review I4）。**log 插值经离线实测背书**（闭合 review B3-arch）：插值 MAPE 7.4% / median 4.9%，优于分段常数 8.0% / 6.1%，时间留出集 6.2% vs 7.0%（见 CONCLUSIONS「落地算法裁决」）。

## 4. 学习入口 `CalibrationSink`（成功请求）

镜像 `src/lib/observability/sinks/telemetry.ts`：新增 observability sink，订阅 bus 的 **`request.completed`** 事件，在 `start.ts` 加一行 `attachCalibrationSink(bus)` 注册。

**取数入口**（闭合 review B2/B3——事件只带 `{ctx: RequestContextSnapshot, entry}`，快照**不含 attempts/wireRequest**，故不能读 `ctx.currentAttempt.wireRequest`）：从 **`entry.attempts.at(-1)`** 取（成功请求的最后一条 attempt = 成功腿，与 TelemetrySink 读 usage 同款）：

- **realTokens** = `attempts.at(-1).upstreamResponse.usage` 的 `input_tokens + cache_read + cache_creation`。
- **localEstimate** = `countTotalTokens(attempts.at(-1).upstreamRequest.body)`——`.body` 即 wire payload（`legFromUpstreamRequest` 存的 `wp.payload`，request.ts:131），与 usage 同 attempt、同口径。
- **格式门控**（闭合 review I1）：只处理 `attempts.at(-1).upstreamRequest.format === "anthropic-messages"`——claude 模型经 OpenAI/Responses 端点或 via-chat-completions-fallback 时 wire 非 Anthropic 形状，`countTotalTokens` 会误算污染 factor。**按 format 门控，不是按模型名**。
- realTokens/localEstimate 低于地板（如 <1000 / <500）跳过（噪声）。`learnCalibration(..., {isLive:true})` 后 `schedulePersist()`。

**buffered-retry 安全**（闭合 review B3-arch）：`request.completed` 由 ctx 的 `settled` 守卫**只 fire 一次**，且我们取 `attempts.at(-1)` = 最终成功那条腿——不会重复学习、不会用错 attempt。

- **fire-and-forget never-throw**：sink 天然隔离（bus 单订阅者异常不影响其他 sink）。
- **重算成本**：Phase 1 每条 completed 在后台 sink 重跑一次 `countTotalTokens`（post-response、不阻塞客户端）。Phase 2 pre-flight 已算过同一 wire 的 est，可经 ctx→entry 投影复用免重算（作 Phase 2 顺带优化，非 Phase 1 依赖）。

**为何是 sink 不是 handler 内联**：complete 有 ≥3 站点（streaming pump / 非流式 render / web_search），单一汇聚点避免散落漏点；`request.completed` 是 committed settle 点，符合 `persistence-async-invariants`「信号在 committed outcome 记录」。

## 5. 持久化 v2 + 迁移 + 出厂 seed

### 5.1 schema v2

`LearnedLimitsFile.version: 2`，`ModelLimits.calibrationFactor`（标量）→ `factorModel` + `liveSampleCount`（§3.1）。持久化沿用 `persistLimits`（`createSerializedAsyncFn` + `atomicWriteJson` + debounce + never-throw + persistFailureLogged 一次告警）。`loadPersistedLimits` 现有的硬校验 `calibrationFactor ∈ [MIN,MAX]`（engine.ts:262）须改为 v2 结构校验。

### 5.2 出厂 bake-in 默认表

离线**全量 3848 样本**训练得到的 per-bucket `{factor, meanEst}` 作为**代码内常量默认表**。**必须同时 ship 每桶 `meanEst`（插值 x 锚点，闭合 review 重要-1）**——否则 seed-only 模型在 backfill 跑完前 `factorAt` 无合法 x、插值退化。analyze.ts 的「SEED TABLE」小节现成 emit（见 CONCLUSIONS）：

```ts
// factor = tok-weighted Σreal/Σest；meanEst = 该桶样本 est 均值（插值锚点 x）。全量 4000 样本训练
DEFAULT_FACTOR_SEED = {
  "claude-opus-4.8": [
    /*[0,15k)*/    null,
    /*[15k,30k)*/  { factor: 1.284, meanEst: 23877 },
    /*[30k,60k)*/  { factor: 1.313, meanEst: 48784 },
    /*[60k,120k)*/ { factor: 1.434, meanEst: 85238 },
    /*[120k,240k)*/{ factor: 1.625, meanEst: 163889 },
    /*[240k,inf)*/ { factor: 1.826, meanEst: 333152 },
  ],
}
```

seed 写桶时以合成权重 `W`（定 = `WEIGHT_CAP` 的一部分，如 500，使真实 live/backfill 能在合理样本内主导）落 `sumEst=W, sumReal=factor×W, meanEst=表值, sampleCount=W`，`liveSampleCount` **不加**（seed 不驱动 margin，§3.1/I2）。`null` 桶（[0,15k)）留空、查询向 [15k,30k) 锚点外推。

**理由**（用户决策）：factor 由 opus-4.8 原生 tokenizer 词表失配驱动、是模型固有属性、跨用户可泛化，故离线结果可作出厂 seed。启动 `loadPersistedLimits` 后，对**未持久化或空桶**的 (model,bucket) 用 seed 填充；backfill/live 随后精修。

### 5.3 factor 模型与 tokenLimit 解耦（闭合 review B2）

**关键**：seed 只建 `factorModel`，**不设 `tokenLimit`**（留 `undefined`）。但现 `calculateTokenLimit`（truncation.ts:153）逻辑是「`getLearnedLimits` 非空 → 走 `learned.tokenLimit`」——seed 条目 tokenLimit 缺失会返回 0 → 所有请求判超限 → count-tokens 恒 inflate（方向反）。故须改：

```
calculateTokenLimit:
  if config.targetTokenLimit !== undefined: return targetTokenLimit
  learned = getLearnedLimits(model.id)
  if learned?.tokenLimit > 0:                       // ← 加 tokenLimit>0 守卫（原来只判 learned 非空）
     return floor(learned.tokenLimit * (1 - computeSafetyMargin(learned.liveSampleCount)))
  return capabilities 回退（max_context_window_tokens × (1 - safetyMarginPercent/100)）
```

这样 seed-only 模型走 capabilities 上限（opus ~1M），count-tokens pre-check 用**准确的** calibrated currentTokens（~1.4x）对比 1M，典型请求 `needed:false` → 返回诚实计数（正是目标）。`computeSafetyMargin` 改喂 **`liveSampleCount`**（seed/backfill 不收窄 margin，I2）。（注：现逻辑对 tokenLimit 缺失实际返回 `floor(undefined×…)=NaN` 而非 0，`tokenLimit>0` 守卫同样堵住 NaN。）

### 5.4 v1→v2 迁移（load 时）

`loadPersistedLimits` 读到 `version:1`：
- 保留 `tokenLimit`（从 400 学的，机制不变）。
- 旧标量 `calibrationFactor`（如 opus-4.8 2.202/397）是 400-偏置的巨型请求 factor，**不铺满所有桶**——**优先用 §5.2 seed 表**填该模型桶（含 meanEst 锚点）；seed 表没有的模型，把旧标量只填进**最大桶**（400 真实归属桶）、给该桶一个合理 meanEst（如 300k），其余桶留空待学（单锚点时插值退化为常数，自洽）。旧 `sampleCount` → `liveSampleCount`（保留已有 margin 收窄）。
- 只写 v2。`boundsVersion` 不匹配（未来改桶边界）同样丢弃桶、重 seed。

## 6. backfill 冷启动（批统计 seed）

启动后**非阻塞后台**跑，`history-backfill` 骨架（skill `history-backfill`；`usage-normalize-backfill.ts:300-357` 有完整 pattern 可照搬）：

- **可恢复**：`history_meta` 存 `calibration_backfill_v1` 完成 flag + `(started_at, id)` keyset 续跑游标；跑完置 flag，重启不重跑。
- **协作 stop**：匹配 shutdown phase，never-throw，分批（每批 200）让出事件循环。
- **数据来源**（闭合 review Y1——`upstream_request` 在盘上被打包进 `request_group` zstd 帧、非独立 stage）：`entries_v2`（`status=completed` ∧ claude ∧ `input_tokens` 非空）读列 `input_tokens/cache_read/cache_creation`（**短列名**，schema.ts:25-26）；stage blob 经 **export 后的 `decodeStageRows`** 展开 `request_group` 帧取 member `{stage,attemptIndex,payload}`，用 **`decompress()` 双格式嗅探**（zstd 新 / gzip legacy，compression.ts）——非单纯 zstd。取最后一个 `upstream_request` member 的 `.body`（`format==="anthropic-messages"` 门控，同 §4）→ `countTotalTokens` → 累加桶 `sumReal/sumEst`。
- **批统计 seed（`isLive=false`）**（用户决策）：按桶累计真实 `Σreal / Σest` + `mean(est)`，一次性写桶。**写入权重封顶 `WEIGHT_CAP`**（§3.2）：若某桶真实样本 > CAP，则按比例缩放 `sumReal/sumEst` 使 `sampleCount=CAP` 而 factor 不变——这样 live 学习**立即进入滑动窗**、不在 backfill 后再冻结一段。**幂等**（重跑同库同结果、不受顺序影响、不双计），`liveSampleCount` 不加。写入**覆盖** §5.2 出厂 seed（用户真实数据 > 泛化值）。
- **覆盖率**（闭合 review S3）：历史早期行可能只有 legacy `outbound_request`、无 `upstream_request`（新腿 restructure 后才写）→ 会被跳过。实施时**显式打 skip 计数 / 覆盖率**评估老数据 seed 是否变薄；必要时经 legacy 腿适配。

## 7. pre-flight（Phase 2，config 门控默认 OFF）

### 7.1 集成点（闭合 review B4/I5——主路径是 v4 driver，非同步 `prepareAnthropicRequest`）

主 `/v1/messages` 走 **v4 driver**（`handler-v4.ts` → `driver.ts`），当前**完全不 tokenize**。真实 post-preprocessTools wire 在 `codec.prepareWire(current)`（driver.ts:256）产生、`transport.send(wire)`（driver.ts:268）发送。pre-flight 须落在这两者间的**异步接缝**——但 driver 是格式无关的、`wire` 是 `WireEnvelope`（headers 为 `Headers`），而 `autoTruncateAnthropic` 吃 Anthropic `MessagesPayload`。故：

- 新增一个 **codec 级 async pre-send hook**（Anthropic codec 实现、其他 codec no-op，如可选 `preSend?(env): Promise<RequestEnvelope>`），在 driver `prepareWire → send` 之间调用；hook 内对 `env.body`（MessagesPayload）判超限、超则截断并经 `env.with({body})` 回灌 + 重跑 `prepareWire`（`prepareWire` 契约声明幂等不写回 env.body）。这样把 Anthropic 专属截断收进 codec、不污染通用 driver。
- **N2（触发时机）**：driver 主循环 `for(;;)`（driver.ts:255）每轮 `prepareWire→send`；hook 若插循环内则每次重试都重跑 `countTotalTokens`（反应式补截时冗余）。须**仅首 attempt 触发**（或进入重试循环前一次性执行）——pre-flight 是「首发前预截」，反应式已接管后续重试。
- 精确接缝（哪个 driver 方法插 hook、截断后 env 如何回灌）留给实施计划钉死，避免双重预处理 / 口径漂移。

判超限逻辑（口径不变量见下）：

```
est = countTotalTokens(env.body)             // gpt 口径；顺带存 est 供 §4 复用（Phase2 优化）
factor = factorAt(model.id, est)
predicted = ceil(est * factor)               // anthropic 口径（= calibrate(est)）
limit = calculateTokenLimit(model, cfg)      // anthropic 口径（§5.3）
if predicted > limit:
   targetGpt = floor(limit / factor)          // 换算回 gpt 口径
   env.body = autoTruncateAnthropic(env.body, { targetTokenLimit: targetGpt }); 重跑 prepareWire
```

**口径不变量（易埋 bug）**：`learned.tokenLimit`/400 报的 current 是 **anthropic/GHC 口径**；`countTotalTokens` 是 **gpt 口径**。判超限在 anthropic 口径（`predicted` vs `limit`），但 `autoTruncateAnthropic` 内部 binary search 用 gpt 口径 `countPerMessageTokens`，故 `targetTokenLimit` 必须 **gpt 口径**（`limit / factor`）——否则 anthropic limit（~900k）远高于 gpt 累计（~450k），truncate 判「everything fits」欠截。此换算与反应式 strategy 的 `reportedTarget / ratio` 同构（ratio ≈ factor）。

- **config 键**：`auto_truncate.preflight`（bool，默认 `false`）——归 **`auto_truncate.*`** section 与既有 auto-truncate 配置一致（闭合 review Y3；非 `anthropic.*`）。默认 OFF → Phase 2 落地零行为变化。
- **反应式 strategy 保留为兜底**（pre-flight 漏判/欠截 → 400 → 反应式补截）。
- **误截风险**：pre-flight 只在 `predicted > limit` 触发——这些请求当前**必然 400**，pre-flight 至多提前做同一件事；唯一风险是 factor 高估把真能通过的请求判超限（7% MAPE + margin 下概率低，且反应式无法补救 over-truncation）→ 故默认 OFF、用户按需开，margin 用 `liveSampleCount` 驱动（真实确认前保守）。

### 7.2 价值

省掉大请求那次必然失败的 400 往返（几十秒）。仅对预测超限请求生效，happy path 多一次 `countTotalTokens`（Phase 2 可被 §4 复用抵消）。

## 8. 消费者影响（更正 review B1——非「零改动」）

| 消费者 | 改动 | 效果 |
|---|---|---|
| `count-tokens` route | 去掉 `sampleCount>0` 语义假设；`calculateTokenLimit` 加 tokenLimit>0 守卫（§5.3） | factor 从 50% 高估 → 7% → 不再误触发过早客户端压缩 |
| `debug` route | 无（透过 `checkNeedsCompactionAnthropic`） | 更准 |
| `anthropic/auto-truncate.ts:442` / `openai/auto-truncate.ts:150` | **去掉 `learned.sampleCount>0 ? calibrate() : raw` 守卫**，直接 `calibrate()`（内部空模型自 no-op） | 一致的 size-aware |
| `computeSafetyMargin` 调用方（truncation.ts:154 / openai:96） | 改喂 `learned.liveSampleCount`（原 `sampleCount`） | seed/backfill 不误收窄 margin（I2） |
| pre-flight（新，Phase 2） | codec pre-send hook | 主路径省 400 往返 |
| 反应式 strategy | 无 | 不消费全局 factor，不受影响（已核实 strategies/auto-truncate.ts:93-95） |
| OpenAI checkNeedsCompaction | 沿用共享 engine | seed 表无 OpenAI 数据 → 全空桶 → factor 1.0（no-op），行为不退化 |

## 9. 分阶段

- **Phase 1**（可独立落地验证）：§3 factor 模型 + §5 v2/迁移/seed + §4 CalibrationSink + §6 backfill。价值：count_tokens 端点精度。
- **Phase 2**：§7 pre-flight（门控 OFF）。价值：主路径省往返。

> **实施状态**：Phase 1 + Phase 2 均已实施（分支 `feat/size-aware-calibration`）。pre-flight 走 `src/lib/codec/anthropic/codec.ts` 的 `preSend` hook（driver 主循环首轮、`prepareWire` 之前），config `auto_truncate.preflight` 默认 OFF、opt-in，pre-flight 抛错降级为反应式兜底。

## 10. 测试（TDD）

隔离用 `autoRestoreState()` / `resetAllLimitsForTesting()` / 临时持久化路径（`setLearnedLimitsPathForTests`），**never 碰真实 $HOME**（skill `test-isolation`）。持久化异步不变量见 skill `persistence-async-invariants`。

- **单元**：`bucketIndex` 边界；`factorAt` **log 插值**（相邻 anchor、空桶跳过、端点外推、全空→1.0、meanEst 锚点）；cumulative 落桶（`sumReal/sumEst`、clamp 在读时、软上限衰减）；成功+400 同桶累计；`liveSampleCount` 只计 live（seed/backfill 不加）；`calculateTokenLimit` 的 tokenLimit>0 守卫（seed-only → capabilities 回退）；v1→v2 迁移（旧标量入最大桶 / seed 表优先 / sampleCount→liveSampleCount / boundsVersion 不匹配重 seed）。
- **集成**：CalibrationSink 从 `entry.attempts.at(-1).{upstreamRequest.body, upstreamResponse.usage}` 落桶；`format!=="anthropic-messages"` 跳过；buffered-retry 只学一次；never-throw（sink 异常不影响其他 sink）；持久化 v2 round-trip（serialized+atomic）；消费者去守卫后空模型 `calibrate()` no-op。
- **backfill**：批统计幂等（重跑同结果）；keyset 续跑；`decodeStageRows` 展开 `request_group` + `decompress()` 双格式；缺 `upstream_request`/legacy 行跳过 + skip 覆盖率；协作 stop；`Σreal/Σest` 累计正确性（独立 oracle 对拍 `exp/.../analyze.ts`）。
- **pre-flight**：codec pre-send hook `predicted>limit` 触发预截断 + 重跑 prepareWire / 否则直发；口径换算（targetGpt=limit/factor）；默认 OFF 零行为变化；反应式兜底仍触发。

## 11. 风险与暂缓记录

- **残差 ~7%**（size 无法解释的 tool 密度噪声）→ 组成感知 factor 作暂缓项入 `docs/todo/deferred-backlog.md`。
- **桶边界固定**：`boundsVersion` 支持未来重划；当前 6 桶 log 间隔够用。
- **新模型冷启动**：无 seed 无 history → 全空桶 → factor 1.0（no-op），live 学习逐步填充；不退化。
- **over-truncation 不可逆**：故 pre-flight 默认 OFF、`liveSampleCount` 驱动 margin（真实确认前保守），反应式兜底覆盖 under-truncation 但不覆盖 over。
- **400 腿 cache 口径待实测确认**（S2）：实施时对拍一条真实 400 确认 `reportedCurrent` 含缓存 token。
- **backfill 老数据覆盖率**（S3）：legacy 无 `upstream_request` 行被跳过，须打 skip 计数评估。

## 12. 审查意见处置（record-not-adopted）

两轮 subagent 对抗审查（架构 + 可行性）+ 复审的处置：

**第一轮已采纳并修订**：B1（schema 删字段打爆消费者→§8 明列非零改动 + `liveSampleCount` 分离）、B2（seed→tokenLimit=0 反向→§5.3 解耦 + tokenLimit>0 守卫）、B3-feasibility（wire 入口错→§4 改 `entry.attempts.at(-1)`）、B3-arch（验证≠落地算法→离线实测插值 7.4% 背书，§3.3）、B4/I5（主路径 v4 driver→§7.1 codec pre-send hook）、I1（format 门控，§4）、I2（seed 不驱动 margin→`liveSampleCount`）、I3（EWMA→cumulative tok-weighted，§3.1）、I4（顶桶中心→meanEst 锚点）、S1（400 腿参序，§3.2）、S2（cache 口径实测，§11）、S3（legacy 覆盖率，§6/§11）、S4（§1.2 措辞已含 OpenAI）、Y1（decode 展开+双格式+短列名，§6）、Y3（config 归 `auto_truncate.*`，§7.1）。

**第二轮复审（修订自身引入）已闭合**：
- N1（feasibility）：`onTokenLimitExceeded` 降值守卫对 seed 建的 `tokenLimit===undefined` 会 NaN 短路 → §3.2 补 `=== undefined || <` 守卫。
- N2（feasibility）：pre-flight hook 在 driver `for(;;)` 每轮触发 → §7.1 限「仅首 attempt」。
- 重要-1（architecture）：seed/迁移缺 `meanEst` 插值锚点 → §5.2 seed 表 ship `{factor, meanEst}`、§5.4 迁移最大桶给 meanEst。
- 重要-2（architecture）：cumulative + 覆盖式 backfill 让 live 冻结、与「精修」矛盾、软上限未定义 → §3.2 **软上限转正为强制 `WEIGHT_CAP=2000` 滑动窗**（稳定 + 不冻结二者兼得），§6 backfill 写入权重封顶 CAP 使 live 立即进滑动窗。

**未采纳/暂缓**（附理由）：
- 组成/tool-密度感知 factor（超越 size 的第二维，解释残差 ~7%）：暂缓项，精度已足够两消费者（§2、§11）。
- 6 桶固定边界加维度：`boundsVersion` 留后路，当前够用，两审查者均认可暂不加。
- 「backfill 定盘、live 只填空桶」（重要-2 选项 a）：**未采纳**，改选项 b（WEIGHT_CAP 滑动窗）——让 live 学习真正有意义（tokenizer 变更可漂移适应），而非冻结成死代码，符合 long-term-correct。
- reviewer 建议「桶用更小 alpha」：直接改 cumulative tok-weighted（不用 EWMA），比调 alpha 更根本，采纳其意图而非字面手段。

