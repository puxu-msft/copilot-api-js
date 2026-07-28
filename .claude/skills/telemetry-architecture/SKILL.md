---
name: telemetry-architecture
description: 当在 copilot-api-js 扩展/重构可扩展持久遥测（request-telemetry registry、维度/度量、histogram、成本拆分、分层 SQLite 存储 telemetry.db）或消费 /api/status /api/stats model 维度时使用——registry 框架三支柱（提取下沉 sink 层、开放 counters bag + 泛型复制器零版本 bump、聚合后不可重算的因子拆最细）、histogram count/sum 须同批观测、基数 cap per-store 独立解析、model 维度 key 成功/失败分裂（成功=规范名/失败=客户端别名）须双侧 normalizeModelId + unmatched 可见；2026-07-14 存储层从单 JSON 迁独立 telemetry.db（三层 rollup + DDSketch + 全可配 + 双轨 + 单轨收敛），registry 定义零改动只换存储层。是 richest-data-flow 在遥测域的实例。
---

# 遥测架构：可扩展 registry + model 维度归一

本项目遥测层的架构教训：**registry 框架三支柱**（把硬编码维度重构成可扩展 registry，2026-06-23 落地，权威设计 `docs/spec/operational-stats-and-lineage-removal.md`）、**/api/status model 维度 key 成功/失败分裂**（消费遥测 join 目录时的坑）、**分层 SQLite 存储**（2026-07-14 存储层从单 JSON 迁 telemetry.db，§三）。

> **存储层已换（2026-07-14）**：registry 定义（维度/度量/histogram extractor）**零改动**、三支柱仍是设计；但**存储层从单 JSON 迁到分层 SQLite `telemetry.db`**（§三）。故下方 §一 里凡涉「持久 envelope V3」「`__histograms` sibling round-trip」「JSON persist」「`≥200` 硬编码 cap」的**存储实现**描述已被 §三 取代（三支柱的架构原则不变、落地介质变了）。

## 一、可扩展持久遥测 registry 框架的三支柱

把 5 硬编码维度 + 6 处手抄指标的 `request-telemetry.ts` 重构成 dimension/measure registry 框架时的可复用架构教训。

### 支柱 1 — 提取下沉到 sink 层、聚合叶子保持 type-light
维度 = 注册的 key-extractor `(entry, ctx) => string|string[]|null`，放在 `observability/telemetry-dimensions.ts`（entry/ctx 类型 in-scope）；`request-telemetry.ts` 只收 `Record<dimName, key>` key-bag，永不 import entry/ctx。加维度 = 在包侧 `dimension-names.ts` 加一条 spec + 在 core 侧提取器表加一个 extractor（表是按 spec 名字 union 键控的穷尽 `Record`，漏写直接编译不过），record/persist/load/breakdown 全靠遍历 registry，零其它编辑。

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

REFERENCE（实测确证）：`/api/status` 的 `requestTelemetry` model 维度 key **随成功/失败分裂**——`extract: (entry) => entry.model?.resolved ?? entry.model?.requested ?? "unknown"`（`src/lib/observability/telemetry-dimensions.ts:173`；2026-07-07 history 数据模型重构后从旧 `entry.outboundResponse?.model ?? entry.inboundRequest.model` 迁到 `model{}` 归拢键，语义不变）。

- **成功腿** key = `model.resolved` = `normalizeModelId(上游返回名)`（`request.ts` settle 处归一化，对齐 `/models` id；Claude 规范名可 join）。
- **失败腿**（上游 4xx/5xx，无成功 resolve） key = 回落 `model.requested` = **客户端逐字别名**（`opus`、date 后缀 `claude-opus-4-8-20250514`、override 名）。
- `normalizeModelId`（`src/lib/models/resolver.ts`）**只归一化 Claude 版本号 pattern**（`claude-{family}-{major}-{minor}(-date)` → dot 形），非 Claude / 老式 `claude-3.x-sonnet`（数字在族名前）/ 大小写变体 **原样返回**。

**后果**：同一逻辑模型的成功与失败遥测落在**不同 key**；直接按 `model.id` join `/models` 目录会**静默丢失失败腿计数 + 别名遥测**（failure 系统性偏低）。

**正解**（`ui/src/composables/model-telemetry-join.ts` 的 `buildModelTelemetryIndex`）：telemetry key 与 `model.id` **双侧都过 `normalizeModelId`** 再匹配，归一到同值的成功 + 失败腿聚合合并（平均时延用 total/count 重算）；归一后仍无 catalog 匹配的行进 **`unmatched` 列表可见呈现**（richest-data-flow，绝不静默丢弃）。测试用 date-suffix 正样本钉死（`ui/tests/model-telemetry-join.test.ts`），否则 `VERSIONED_RE` 改动会静默破坏合并。

设计与失配形态清单见 `docs/spec/2026-07-05-ui-v4-models-enhancement.md` §4.2。任何消费 `/api/status` 或 `/api/stats?dimension=model` 遥测并要 join 目录的工作都会踩此坑。

## 二·五、包边界（2026-07-27 抽包 `@hsupu/ghc-proxy-telemetry`）

遥测域已是独立 workspace 包，**对 core 零依赖**（机器守卫：`tests/architecture/package-boundaries.unit.test.ts` 的 allowlist 检测器 + ESLint 镜像 + `tests/architecture/telemetry-domain-surface.unit.test.ts`）。动这块代码前先知道三件事：

- **拿不到 core**。包里不能 `import "~/lib/..."`，也不能引任何别的 `@hsupu/*`（foundation 除外）。要 core 的东西就走注入端口 `TelemetryPaths` / `TelemetryConfigView` / `TelemetryConfigSubscription`，由 core 侧 composition root `src/lib/telemetry-assembly.ts` 装配（生产在 `start.ts` listen 前装、测试地板在 bunfig preload 装 ports、fixture 每测试装 runtime）。
- **config 是只读投影，逐字段生命周期不同**（跟 token 的凭据 SoT 反转根本不同——遥测**不拥有**任何 config）。`enabled`/`persist_interval`/`rollup_interval` 靠订阅重调 timer；cap/cumulative/retention 是 next-record live 读；`db_path` 只在 init 选库；**`sketch_gamma` 是 DB-open 冻结的候选值**（端口字段就叫 `sketchGammaCandidate`，别当 live 读——理由见 §三 的 γ 冻结不变量）。
- **只有一个生产表面**：包 barrel 导出的 `TelemetryRuntime`。registry 的自由函数（`initRequestTelemetry`/`recordSettledRequest`/`getDimensionBreakdown`…）是包内部，**加新导出到 barrel 会被守卫拦**。测试驱动 registry 走包自有的 `@hsupu/ghc-proxy-telemetry/testing` 入口。读路径（`/api/status`·`/api/stats`·`/metrics`）用 fail-fast `getTelemetryRuntime()`（未装配是接线 bug，绝不返回伪造零值），记录腿与 shutdown 用容忍 `peekTelemetryRuntime()?.op()`。
- **维度 registry 是劈开的**：名字 + 基数类在包（`dimension-names.ts`），提取器留 core（要看 entry/ctx）。加维度要两边都动，类型系统会逼你。

## 三、分层 SQLite 存储（telemetry.db，2026-07-14 存储层替换）

单 27MB JSON（整文件重写、无索引、硬顶 7d）→ 独立 `telemetry.db`（`packages/telemetry/src/telemetry/`）。**纯聚合层**、行级明细委托 History DB。权威 spec `docs/spec/2026-07-13-telemetry-tiered-storage.md` + DESIGN.md「活的架构现状」telemetry.db 行。

**形态**：三层 rollup（`tel_raw` 5min / `tel_hourly` / `tel_daily`，链式 raw→hourly→daily）+ 终身 `tel_cumulative` + 无维 `tel_accepted` + 字典 `tel_dim`/`tel_key` + 账本 `tel_meta`（Umzug hybrid）。可加度量 INTEGER 精确 SUM、分布 DDSketch BLOB（`hist_blob`）。

**承重不变量（漏一条→静默数据丢失/崩溃/降级，全是对抗审查逼出的）**：
- **cost scaled-int micro**（`round(cost*1e6)` **per-request round-then-sum**，绝不 REAL/STRICT INTEGER 存浮点）。micro 非 nano：nano(1e9) 使永久 cumulative 撞 `Number.MAX_SAFE_INTEGER`（9e15/1e9=仅 900 万 token-当量）静默丢精度。
- **SQLite 只存 DDSketch、无固定桶列**（HIGH-1）：固定桶只活 `/metrics` 进程内内存路径。DDSketch 手动 DenseStore 序列化保 min/max，绝不 `toProto`/`fromProto`（拉 protobufjs + 丢 min/max）。
- **γ 建库冻结**（`tel_meta['sketch_gamma']`，非 live config）：DDSketch merge 要求同 γ；若 addToOutboxEntry 读 live config γ，热重载改 γ → 新 delta merge 进旧 γ permanent cumulative blob → fail-loud 抛 → 若 drain 是单事务 all-or-nothing + 无限 foldback 则**永久 wedge 静默丢全部写入**（MAJOR-2）。→ **值绑 artifact 生命周期非 live config**，drain 两阶段 poison 隔离（见 skill `persistence-async-invariants` §4）。
- **双轨计数**：进程内 `dimSinceStart`/`acceptedSinceStart`/thinking（重启归零、`/metrics` + `thinking_blocks` 契约）+ 持久 cumulative（`tel_cumulative`/`tel_meta` 跨重启）。**别混**：`/metrics` 只读 dimSinceStart（Prometheus counter 单调性靠重启归零）。
- **cap 可配 + DB-seeded**：`state.telemetryCardinalityCap`（别硬编码常量——死钮违「全可配」）；cumulative 腿 cap 权威**从 tel_cumulative 重建**（`seedCumulativeCapKeys`）抗重启。**集成缝**：backfill 写 cumulative **必须应用与 live 同一 cap 折叠**，否则 legacy >cap 键全写入 → seed 继承 over-cap 集 → 重启后 live `size>=cap` 恒真 → **停止跟踪新 key（活路径降级）**（合并态评审抓，per-task 看不到）。
- **rollup watermark 幂等**：`tel_meta` 存每层 watermark、只卷 `> watermark 且已封口` 源桶、watermark 推进与写目标**同事务**（DDSketch merge + SUM 非幂等、重放必翻倍）。封桶边界 + 时钟回跳守卫 + TTL 裁剪不领先上卷。

**两个用户决策（塑造读/写路径形状）**：
1. **读源方案 2「dimBuckets 存活作 live cache」**：现有端点读**内存**（dual-write 下 SQLite 落后 outbox ≤persist_interval、纯读 SQLite 违 byte-compat）→ byte-compat 平凡、零改动；新能力（`/api/stats` lifetime/30d/90d + sketch 分位）才读 SQLite。
2. **P7 单轨收敛 + 不保护旧 UI**：翻转 dimBuckets 重建源 JSON→SQLite（`rebuildDimBucketsFromRaw`，counters+series 精确、histograms 空）+ 删 JSON 写（JSON 本体 no-destructive 保留、仅首启读一次 stash 给 backfill）。**两腿 histograms 命运分裂**：sinceStart 腿 histograms 保留（喂 `/metrics` 活功能）、7d 腿（dimBuckets）histograms 退役出空 stub（old `ui/` 专用、当前 ui-v4 不用——删除按消费者契约裁决）。

**写路径 = 加性双写 pending-delta outbox**（sink→内存 dimBuckets/dimSinceStart 不变 + outbox 累积增量 → persist_interval flush 两阶段 drain）；sketch 从**原始观测值**喂（内存只存有损固定桶、重建不出精确 sketch）。详见 skill `persistence-async-invariants` §4（防双计 snapshot-swap + never-throw + 两阶段 poison 隔离）+ `history-backfill`（backfill disjointness 结构化 + cap 一致）。


- 重构 golden 等价、sed/grep 工具箱：skill `large-refactor`。
- 全套件才现形的隐藏消费者、探针实测：skill `empirical-verification`。
