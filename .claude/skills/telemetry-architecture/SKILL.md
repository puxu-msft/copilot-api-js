---
name: telemetry-architecture
description: 当在 copilot-api-js 扩展/重构可扩展持久遥测（request-telemetry registry、维度/度量、histogram、成本拆分）或消费 /api/status /api/stats model 维度时使用——registry 框架三支柱（提取下沉 sink 层、开放 counters bag + 泛型复制器零版本 bump、聚合后不可重算的因子拆最细）、histogram count/sum 须同批观测、基数 cap per-store 独立解析、model 维度 key 成功/失败分裂（成功=规范名/失败=客户端别名）须双侧 normalizeModelId + unmatched 可见。是 richest-data-flow 在遥测域的实例。
---

# 遥测架构：可扩展 registry + model 维度归一

本项目遥测层两组架构教训：**registry 框架三支柱**（把硬编码维度重构成可扩展 registry，2026-06-23 落地，权威设计 `docs/spec/operational-stats-and-lineage-removal.md`）、**/api/status model 维度 key 成功/失败分裂**（消费遥测 join 目录时的坑）。

## 一、可扩展持久遥测 registry 框架的三支柱

把 5 硬编码维度 + 6 处手抄指标的 `request-telemetry.ts` 重构成 dimension/measure registry 框架时的可复用架构教训。

### 支柱 1 — 提取下沉到 sink 层、聚合叶子保持 type-light
维度 = 注册的 key-extractor `(entry, ctx) => string|string[]|null`，放在 `observability/telemetry-dimensions.ts`（entry/ctx 类型 in-scope）；`request-telemetry.ts` 只收 `Record<dimName, key>` key-bag，永不 import entry/ctx（只 import `UsageData`）。加维度 = registry push 一行，record/persist/load/breakdown 全靠遍历 registry，零其它编辑。

### 支柱 2 — 开放 counters bag + 泛型 (de)serializer = 零持久版本 bump
`StatAccumulator.counters: Record<string,number>` 是开放 bag；持久 envelope V3 泛型迭代所有维度名（无 allow-list，未知未来维度 round-trip forward-compat）；loader/serializer 用 `{...acc.counters}` 泛型复制而非字段枚举。加 measure / 加维度 = 数据，不 bump version、不加 loader 分支。
**坑**：本项目 tsconfig 无 `noUncheckedIndexedAccess`，`Record<string,number>` 索引类型是 `number`（非 `|undefined`），`counters[name] ?? 0` 被 lint 判死代码——靠 `createAccumulator` 把全 measure 初始化为 0（结构性保证）让类型谎言变诚实，而非到处 `?? 0`；需 `|undefined` 窄化的循环用 `Map.get()` 构建。

### 支柱 3 — 聚合后无法重算的 per-request 因子 → 拆到最细分量存
成本拆 per-token-type（`costInputTokens`/`costOutputTokens`/…）而非单标量 `estCost`：billing `multiplier` per-request 变化，一旦把 `tokens×multiplier` 求和就再也分不出各 token 类型的贡献，故 per-type 拆分是唯一能保留"未来差异化定价"的形态。是 **richest-data-flow**（后端完整存，ADR `docs/decisions/2026-07-05-richest-data-flow.md`）在"可变因子 + 聚合"场景的实例：判据 = 该分解在聚合后能否重建，不能则必须在聚合前就拆开存。

### 配套坑
- **基数 cap**（capped 维度 key 数 ≥200 并入 `"other"`）**按 store 独立解析**——`dimSinceStart` 与目标 bucket 各为自己的 cap 权威，每个 bucket 独立有界 CAP+1 且无视进程重启。**坑**：用单一 `dimSinceStart` 权威会在重启后破功——load 时 sinceStart 清空但 buckets 保留满 keys，新流量绕过 cap 把 bucket 撑爆（对抗 subagent audit 发现 C1 + 探针实测 401 确认后改 per-store）。
- **重构前先在旧码锁 golden 字节等价**（见 skill `large-refactor`）。
- **改 schema/telemetry 后跑全套件**才暴露隐藏消费者（`computeStats` 的 `SELECT FROM sessions` 只在 179 测试连环挂时现形，子域测试抓不到，见 skill `empirical-verification` 的"通过/空不自证"）。
- **histogram（latency/queue/token 分布）已落地**（开放 bag 容下 `{buckets,sum}` per (dim,key)、零版本 bump、走 `__histograms` sibling round-trip、`/metrics` 出标准 Prometheus histogram）。**关键坑（支柱 3 的实例）：histogram 的 count（桶和）与 sum 必须来自同一批观测**，sum 自 track（不复用 totalDurationMs 等 sibling counter），否则聚合一个横跨"pre-histogram→post-histogram 升级边界"的 7d 窗口时 count 取新格式 buckets、sum 取全格式 counter → desync、average 放大、Prometheus `_sum`/`_count` 契约破裂（对抗 audit 抓到、探针实测 `count=2/sum=100100/avg=50050ms`→修后 `50`）。

开放 bag + 泛型复制器使其当初零 foreclose——验证了"不铺投机表面但开放结构不挡未来"的判断。

## 二、/api/status model 维度 key 成功/失败分裂

REFERENCE（实测确证）：`/api/status` 的 `requestTelemetry` model 维度 key **随成功/失败分裂**——`extract: (entry) => entry.outboundResponse?.model ?? entry.inboundRequest.model ?? "unknown"`（`src/lib/observability/telemetry-dimensions.ts:110`）。

- **成功腿** key = `outboundResponse.model` = `normalizeModelId(上游返回名)`（`request.ts` settle 处归一化，对齐 `/models` id；Claude 规范名可 join）。
- **失败腿**（上游 4xx/5xx，无 outboundResponse） key = `inboundRequest.model` = **客户端逐字别名**（`opus`、date 后缀 `claude-opus-4-8-20250514`、override 名）。
- `normalizeModelId`（`src/lib/models/resolver.ts`）**只归一化 Claude 版本号 pattern**（`claude-{family}-{major}-{minor}(-date)` → dot 形），非 Claude / 老式 `claude-3.x-sonnet`（数字在族名前）/ 大小写变体 **原样返回**。

**后果**：同一逻辑模型的成功与失败遥测落在**不同 key**；直接按 `model.id` join `/models` 目录会**静默丢失失败腿计数 + 别名遥测**（failure 系统性偏低）。

**正解**（`ui/src/composables/model-telemetry-join.ts` 的 `buildModelTelemetryIndex`）：telemetry key 与 `model.id` **双侧都过 `normalizeModelId`** 再匹配，归一到同值的成功 + 失败腿聚合合并（平均时延用 total/count 重算）；归一后仍无 catalog 匹配的行进 **`unmatched` 列表可见呈现**（richest-data-flow，绝不静默丢弃）。测试用 date-suffix 正样本钉死（`ui/tests/model-telemetry-join.test.ts`），否则 `VERSIONED_RE` 改动会静默破坏合并。

设计与失配形态清单见 `docs/spec/2026-07-05-ui-v4-models-enhancement.md` §4.2。任何消费 `/api/status` 或 `/api/stats?dimension=model` 遥测并要 join 目录的工作都会踩此坑。

## 相关
- richest-data-flow（后端完整存、unmatched 可见）：ADR `docs/decisions/2026-07-05-richest-data-flow.md`。
- 重构 golden 等价、sed/grep 工具箱：skill `large-refactor`。
- 全套件才现形的隐藏消费者、探针实测：skill `empirical-verification`。
