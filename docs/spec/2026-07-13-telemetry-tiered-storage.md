# Spec: 遥测分层持久化 + `telemetry.*` 可配置化

- **状态**：草案 v2（已过 2 轮 subagent 对抗评审并采纳 2 BLOCKER + 6 HIGH + MEDIUM，待用户审 → plan）
- **日期**：2026-07-13
- **相关**：brainstorming 本会话、[docs/DESIGN.md](../DESIGN.md)「类型架构 / 活的架构现状 / config 5 触点」、skill `telemetry-architecture`（registry 三支柱 + model key 分裂 + histogram `_sum`/`_count` 同批坑 + cap per-store 重启坑）、skill `history-sqlite-schema`（Umzug hybrid + zstd + STRICT/WITHOUT ROWID）、skill `history-backfill`（可恢复 backfill：keyset + meta-flag 守卫 + cooperative-stop）、ADR [richest-data-flow](../decisions/2026-07-05-richest-data-flow.md)、记忆 [[feedback-config-philosophy-separate-compat-and-warn-continue]]、[[methodology-plan-verify-interface-location-and-wiring-channel]]（config→state mandatory 5 触点）、proxy-api-reference skill

## 背景与问题

本会话对遥测子系统实测体检，暴露三个结构性问题：

1. **遥测无任何配置面。** 窗口 `WINDOW_MS=7d`、桶 `BUCKET_MS=5min`、基数 `CARDINALITY_CAP=200`、breakdown `limit=20`、持久化路径与间隔——全是 `request-telemetry.ts` 模块级 `const`。对照 History 的 `HistoryConfigSchema`，遥测配置覆盖为**零**。

2. **存储形态不可扩展。** 遥测持久化是**单个 27.6MB JSON**（`request-telemetry.json`，V3 envelope：顶层 `buckets`（accepted 流）+ `dimensions`（settled 流）两字段），每次 persist **整文件重写**、无索引。`dimSinceStart`（进程生命周期累计）**不持久**，重启即丢。磁盘上另有 **7 个泄漏的 `.tmp` 原子写残余**。

3. **保留硬顶 7d。** 实测确认遥测聚合**准确**（History 完整窗口逐字节吻合 request count + token sum），但只保 7 天，无法跨月/季做成本问责、趋势、审计、故障回溯。

**职责划分洞察**：History DB 现配置无限保留（`success_limit: 0`），是**逐请求行级明细**单一事实源。故遥测定位为**纯聚合层**（维度×度量×分布），行级审计委托 History，两层正交。**推论（评审 richest-data-flow 对齐）**：遥测 distribution 用有损 sketch **不违反** richest-data-flow「后端完整存」——因原始逐值观测由 History 完整保留，遥测层本就是 lossy summary。

## 目标

1. 新增 **`telemetry.*` config section**，窗口/分辨率/保留/基数/路径/开关/间隔全可配，**近期与远期均可配**。遵循项目 config **5 触点**（`schema.ts` + `config.ts` apply + `state.ts` + bundled `config.yaml` 双语注释 + 运行时选项表），warn-continue 复用既有 `nullableSection`+`.strict()`+`cleanInvalidPaths` 模式（无需另造机制）。
2. 遥测数据迁到**独立 SQLite 库** `telemetry.db`，**分层保留**：近期高分辨率 + 中远期降采样 rollup + 终身累计永久。
3. 分布度量用 **DDSketch**（`@datadog/sketches-js` 2.1.1，零依赖、原生 TS）出**高精度分位供 `/api/stats`**；**可加度量走精确整数/scaled-int 列**（跨层精确 SUM）。
4. 遥测纯聚合层，行级明细委托 History。
5. **对客户端可观测契约不变**：`/metrics` 与 `/api/status.requestTelemetry` payload **逐字节兼容**（见下方双存储决策）；`/api/stats` 扩 window 路由（新增能力，非破坏）。
6. 清理 `.tmp` 残余 + 原子写加固（SQLite 事务替代 write-rename）。

## 非目标（延后不砍，记 backlog）

- **外部 TSDB / 列式（DuckDB / ClickHouse / Parquet）**：实测规模满 cap 上界**低百万级（~2M 行）**，列式优势摸不到；DuckDB 原生插件 Bun 兼容死穴、Parquet 无原地 upsert。SQLite 是该量级教科书答案。
- **rollup 分辨率任意自定义**：本轮固定 1h/1d（仅保留时长可配、raw 分辨率可配）。
- **新增遥测维度/度量**：本轮存储层替换 + 可配化，registry 定义零改动。error 分类维度、transport 指标记 backlog。
- **History 与遥测统一查询门面**。

## 架构

### 两条独立数据流（评审 H2：必须分立建模）

遥测有两条正交流，**绝不混淆**：
- **settled 流**（`recordSettledRequest`，terminal 事件、per-dimension×measure×分布）——喂 `/api/stats` + `/api/status.requestTelemetry.models*` + `/metrics` per-(dim,key)。
- **accepted 流**（`recordAcceptedRequest`，accept-time、**无维度**全局计数 + 5min sparkline）——喂 `/api/status.requestTelemetry.{acceptedSinceStart,buckets,totalLast7d}` + `/metrics` `accepted_requests_total`。

### 分层数据形态

| 层 | 分辨率 | 默认保留 | 用途 |
|---|---|---|---|
| **raw** | 5min（可配 `raw.resolution_minutes`） | 7d（可配） | 近期审计 + 故障回溯 |
| **hourly** | 1h（固定） | 90d（可配） | 中期趋势 |
| **daily** | 1d（固定） | 永久（`daily.retention_days: 0`） | 长期趋势 |
| **cumulative** | 无时间维 | 永久 | 成本/用量问责终身总量 |

**rollup 语义（评审 MEDIUM：消歧为持续并行）**：hourly/daily 是 raw 的**持续并行 rollup**（数据**重叠**——同一时段 raw 与 hourly 并存），非「过期迁移」。查询按窗口选**单一完整覆盖层**（`≤raw.retention` 走 raw；否则 hourly；更长 daily；`lifetime` 走 cumulative），无需跨层拼接。

### rollup tick 正确性（评审 H6：新增，防重放翻倍）

复用 reaper 式定时器，独立 `rollup_interval`（默认 ≫ `persist_interval`；评审建议直接定为架构决策）。三条约束：
1. **封桶边界**：rollup 只消费**已封口**的源桶（`bucket_ts < 当前分辨率对齐桶`），绝不上卷仍在累加的当前桶。
2. **幂等水位线**：`tel_meta` 存每层 `last_rolled_ts`；上卷按水位**单调推进**，重跑/崩溃恢复不双计（DDSketch merge 与 SUM 均非幂等，重放必翻倍）。参照 skill `history-backfill` 的 keyset + meta-flag 守卫。
3. **时钟回跳**：`< 水位` 的迟到写**拒绝或路由到 `late` 处理**（计入 cumulative 但不回改已裁层），绝不落进已被消费/裁剪的旧桶。本会话实测过时钟坑。

### 度量二分：可加 vs 分布

- **可加度量**（评审 BLOCKER-1 修正类型）：
  - 计数/token（`req_count`/`input_tok`/…/`reasoning_tok`）、时长 ms（`total_duration_ms`/`queue_wait_ms`）、feature tallies → **INTEGER** 列，跨层精确 SUM。
  - **成本 `cost_*`** → **scaled-int**（micro-cost = `round(cost × 1e6)` 存 INTEGER），跨层 SUM 精确且规避浮点求和漂移，导出时缩放。**绝不用 STRICT INTEGER 直存浮点 cost**（会报错或截断→成本问责系统性偏低）。
- **分布度量**（`duration_ms`/`queue_wait_ms`/`input_tokens`/`output_tokens` 分布）→ **DDSketch**，**手动序列化 DenseStore**（`gamma` + bin 计数数组 + `offset` + `zeroCount` + `min/max/count/sum`）为紧凑二进制。**不用 `toProto`/`fromProto`**（评审 H3：protobuf 路径要拉 protobufjs 破「零依赖」，且 `fromProto` 丢 min/max）——手动序列化真零依赖 + 保 min/max。zstd 叠加**存疑**（评审：小 blob 收益低），实现期基准测定，倾向 raw/hourly 不压、仅 cumulative 单行压。

**DDSketch 正确性边界（评审建议：成文防误判）**：
- 同 γ bin 对齐时 merge 精确、跨层上卷**零累积误差**（daily quantile 与全量单 sketch 在同 ε 内一致）；不同 γ merge 会**抛异常**（fail-loud）。
- 但 `DEFAULT_BIN_LIMIT=2048`：γ=0.01（默认 1%）下值域 bin 数 ~640-700 不塌缩、保证成立；**若配紧 γ（如 0.001）bin 数逼近 2048 触发塌缩 → 跨层分位不再严格等价**。故 config 给 γ **下限约束**（保证值域 bin < 2048）或文档化此边界。

### 物理 SQLite schema

```sql
-- 字典编码（避免每行重复存字符串——列式压缩核心手法的 SQLite 手动版）
CREATE TABLE tel_dim (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL) STRICT;
CREATE TABLE tel_key (id INTEGER PRIMARY KEY, dim INTEGER NOT NULL, key TEXT NOT NULL, UNIQUE(dim, key)) STRICT;

-- settled 流 per-dimension（raw/hourly/daily 同构）
CREATE TABLE tel_raw (
  bucket_ts   INTEGER NOT NULL,
  dim         INTEGER NOT NULL,   -- → tel_dim.id
  key_id      INTEGER NOT NULL,   -- → tel_key.id
  req_count   INTEGER NOT NULL,
  input_tok   INTEGER NOT NULL, output_tok INTEGER NOT NULL, /* … 计数/token INTEGER */
  cost_input_micro INTEGER NOT NULL, /* … cost scaled-int */
  total_duration_ms INTEGER NOT NULL,
  hist_blob   BLOB,               -- DDSketch DenseStore 手动序列化（多分布打包）
  PRIMARY KEY (dim, bucket_ts, key_id)
) STRICT, WITHOUT ROWID;           -- 主键即覆盖索引、按 (dim,bucket_ts) 聚簇

-- tel_hourly / tel_daily 同构
CREATE TABLE tel_cumulative ( dim INTEGER, key_id INTEGER, /* 同度量列 */ hist_blob BLOB,
  PRIMARY KEY (dim, key_id) ) STRICT, WITHOUT ROWID;   -- 永久、只增

-- accepted 流（评审 H2：无维度独立表）
CREATE TABLE tel_accepted (bucket_ts INTEGER PRIMARY KEY, count INTEGER NOT NULL) STRICT, WITHOUT ROWID;
-- accepted 终身累计标量存 tel_meta

CREATE TABLE tel_meta (key TEXT PRIMARY KEY, value TEXT) STRICT;  -- 迁移账本 + last_rolled_ts + accepted cumulative + cap 权威种子
```

**列序取舍（评审建议）**：`(dim, bucket_ts, key_id)` 优化 `/api/stats` 范围扫（聚簇），代价是插入非单调（可忽略，每 tick 数百行）。`hist_blob` 每 rollup tick read→merge→write（cumulative 一行永久反复重写），DDSketch bin 有界故 blob 有界，可接受。

**measure 扩展诚实说明（评审 MEDIUM 纠正）**：新维度/key = 零迁移（写 `tel_dim`/`tel_key` 数据行）；**新 measure = 一次 DDL 迁移**（`ALTER TABLE ADD COLUMN` + `tel_meta` 账本），**非「零 bump」**——保 `WITHOUT ROWID` 覆盖索引 + 精确 SUM，胜过 EAV 旁表（破聚簇 + 每 measure join）。measure 新增频率极低，一次迁移可接受。

### 消费端迁移（评审 H1/H4：读路径非「零改动」）

**「registry 定义零改动、读写实现均需迁移」**（纠正原「仅 sink 层」）。逐消费者裁定：

| 消费者 | 现读 | 迁移后读 | 语义变化 |
|---|---|---|---|
| `/api/status.requestTelemetry`（**主 FE 路径**，ui-v4 model join 唯一源，`model-telemetry.ts:88`）| `getRequestTelemetrySnapshot`（内存）| 从 SQLite 重建同形状（`buildFilledBuckets` 0 填充 sparkline + `buildLast7dModelSnapshots` per-bucket series + `models{SinceStart,Last7d}`）| **payload 逐字节兼容**（承重不变量） |
| `/metrics` per-(dim,key) + `accepted_total`（`metrics-exposition.ts`）| `dimSinceStart` 内存（**重启归零**，Prometheus `rate()` 靠此）| 见下「counter-reset 抉择」 | 需裁定 |
| `/api/status.thinking_blocks`（`getThinkingBlockTotals:794`「since restart」）| `dimSinceStart.get("agentKind")` | 需裁定读进程内还是持久层 | 「since restart」语义可能漂移 |
| `/api/stats sinceStart`/`lifetime` | `dimSinceStart` | `tel_cumulative` | lifetime（正确，本是修复） |

**counter-reset 抉择（评审 H4，需用户/plan 拍板）**：`/metrics` 若改读持久 cumulative，则跨重启不再归零 → `rate()` 语义变（更正确但**是行为变更**）。**倾向**：`/metrics` 与 `thinking_blocks` 保留一个**进程内 process-lifetime 计数**（内存，重启归零，契约不变）+ 持久 cumulative 另供 `/api/stats lifetime`。即**内存 process-lifetime 与持久 lifetime 双轨并存**，各服务不同契约。

### `/metrics` 双存储（评审 BLOCKER-2：sketch 不能替换固定桶）

DDSketch **无 CDF/count-below 公共方法**，且对数 bin 的 `count(≤le)` 与旧精确固定桶**数值不等** → 「sketch 逐字节兼容」不可达。**决策：固定桶与 sketch 并存**：
- `/metrics` 继续读**精确固定桶计数器**（便宜 INTEGER 列，cumulative-able、字节精确、`_sum`/`_count` 从同一批固定桶观测得——满足 skill 支柱 3「同批观测」不变量）。
- DDSketch **仅供 `/api/stats`** 出任意高精度分位。
- 两者都存（符合「完整存」）。`hist_blob` 存 sketch；固定桶计数存 measure 列（或 sibling）。

## `telemetry.*` config 面

```yaml
telemetry:
  enabled: true                     # 总开关（默认 true）
  db_path: <APP_DIR>/telemetry.db
  persist_interval: 60              # raw 落盘间隔秒
  rollup_interval: 3600             # rollup 上卷间隔秒（独立，≫ persist）
  cardinality_cap: 200
  sketch_gamma: 0.01                # DDSketch 相对误差（默认 1%）；下限约束保 bin<2048
  tiers:
    raw: { resolution_minutes: 5, retention_days: 7 }
    hourly: { retention_days: 90 }
    daily: { retention_days: 0 }    # 0 = 永久
  cumulative: true
```

**config 纪律**：全新 section 无旧键兼容负担；未知/无效 tier 键 warn-continue（复用 `cleanInvalidPaths`）；`resolution_minutes` 非整除 1h → 警告回落 5min（apply-layer 业务校验，非 zod）；`cardinality_cap` 热重载调小仅约束新增、不回溯裁已存 cumulative；仅启动期可 fail-fast（`db_path` 不可写），运行时热重载绝不因配置杀进程。

**SSOT-types（评审建议：借重构收敛）**：新遥测查询类型（DDSketch summary / tier config / snapshot）在后端 `request-telemetry`/新模块**定义一次**、ui-v4 经 `~backend/*` re-export，把遥测类型从当前 frontend-loose（`ui-v4/src/types/status.ts` 自承 ideal）收敛到 SSOT。

## 迁移

- **schema**：复用 History 的 Umzug hybrid forward-runner，`telemetry.db` 独立账本 `tel_meta`。
- **旧 JSON 全量吸收，绝不丢弃（用户决策）**。利用双存储（固定桶本就保留）达成无损吸收：
  - **可加计数 + accepted buckets**：精确 backfill 进 `tel_raw`/`tel_accepted` + 上卷种子（走 skill `history-backfill` 可恢复骨架）。
  - **旧固定桶直方图**：**无损映射进新的固定桶列**（`_bucket{le}` 计数一一对应）——因 BLOCKER-2 已决定保留固定桶，历史直方图完整保住，`/metrics` 历史区间字节精确。
  - **DDSketch 分位层**：旧固定桶无原始逐值，无法无损重建 sketch → **仅 sketch 分位层对迁移前时段从新建开始**；该时段 `/api/stats` 分位**回落到固定桶分辨率并标注「pre-migration 固定桶近似」**（合成物可辨识，richest-data-flow 对称面）。**这不是丢弃**——历史直方图在固定桶列完整保留，只是迁移前那段缺 sketch 级精度。
- **`.tmp` vs 旧 JSON 删除（评审 LOW：区分）**：`.tmp` 孤儿启动即清理（明确垃圾、安全）；**旧 JSON 是用户数据，默认不自动删**（归档保留 + 手动/超长阈值 + 显式开关），避免 no-destructive-workspace-loss 冲突。

## 测试（TDD）

- **可加精确性**：raw→hourly→daily SUM 与逐 raw 相等；cost scaled-int 往返无漂移。
- **DDSketch（评审 LOW：独立 oracle 非 sketch-vs-sketch）**：**对原始观测值数组算 exact quantile**，验 sketch quantile 落在 γ 相对误差界内；跨层 merge 同理。
- **`/metrics` 契约**：固定桶 exposition 逐字节兼容（Prometheus 严格解析器）；`_sum`/`_count` 同一批固定桶来源。
- **`/api/status.requestTelemetry` golden 等价**：SQLite 重建的 payload 与旧内存快照逐字段字节兼容（含 sparkline 0 填充 + per-bucket series）。
- **accepted 流分立**：accept-time 计数不与 settle 混淆。
- **cap 重启重建**：重启后第 N+1 个 capped key 正确归 `other`（评审 H5）。
- **rollup 幂等**：重放同 tick 不双计；封桶边界不吞当前桶；迟到写不落已裁层。
- **config**：未知键 warn-continue、非整除 resolution 回落、热重载不杀进程。
- **隔离**：DI 注入临时 `db_path`（skill `test-isolation`，Bun `os.homedir()` 忽略 `env.HOME`）。
- **迁移**：跨-runtime e2e（bundle）、可恢复续跑、可加等价 oracle、分布层新建（不 backfill）。

## 承重不变量（实现期 commit invariants）

1. `recordSettledRequest` 单采集点 + terminal-only + 排除 aborted；`recordAcceptedRequest` 独立 accept-time 流——**两流分立**。
2. 成功/失败 model key 分裂语义不变（成功=规范名、失败=客户端别名）。
3. 可加度量跨层 SUM 精确（cost 用 scaled-int）；分布度量跨层 merge 在 γ 误差界内——**两类不混用**。
4. `/metrics` 用**精确固定桶**（非 sketch），`_sum`/`_count` 同一批观测；exposition 字节契约不破。
5. **持久 cumulative 永久跨重启**（修复 `dimSinceStart` 不持久）；但 `/metrics` + `thinking_blocks` 保留**进程内 process-lifetime 计数**（重启归零，契约不变）——双轨。
6. **持久 store 的基数 cap 权威须重启后从 DB 重建**（cumulative 永久，内存视图重启为空会破 cap）；capped 维度重启后第 N+1 key 归 `other`。
7. **`agentKind` 锚点三性质**（never-null / single-key-per-request / never-capped）在 cumulative 层保持——`getThinkingBlockTotals` 依赖，cap 绝不把 agentKind 折进 `other`。
8. `/api/status.requestTelemetry` payload 逐字节兼容（主 FE 消费路径）。

## 待确认 / open questions（plan 前 / PoC 解决）

- **✅ PoC 已完成**（`exp/telemetry-storage/CONCLUSIONS.md`，Bun 1.3.14 + Node 24.16 双验，全绿无 runtime 分歧）：
  - ① DDSketch 零依赖确证（`bun add` 装 1 package）；手动 DenseStore 序列化往返 p99 完全相等、**保 min/max**（优于 protobuf `fromProto`）、vs exact oracle relErr ≤1%；跨层 12 桶 merge count 精确、p99 relErr 0.4%。
  - ② `STRICT INTEGER` 拒 REAL **确证抛异常**（`cannot store REAL value in INTEGER column`，两 runtime 一致）→ cost 用 scaled-int 必需且可行。
  - ③ BLOB(Uint8Array) 两 runtime 字节精确往返。
  - ④ 小 sketch blob zstd **~3x**（非边际）→ 各层均压。
  - **γ 下限确证**：默认 0.01（692 bin）安全、≥0.005 安全、<~0.003 塌缩 → config `sketch_gamma` 加下限校验 ~0.005。
- **plan 定**：cost scaled-int 缩放因子（1e6 精度地板可能不足极小成本，**建议 1e9/nano** 或按 multiplier 量级基准定）。
- **留实现期**：生产真实 blob 的 zstd 比复测、字典表并发锁、Umzug hybrid 跨-runtime e2e。

**已决策（用户）**：`/metrics` + `thinking_blocks` 进程内计数 + 持久 cumulative **双轨并存**（不变量 5）；旧 JSON **全量吸收不丢弃**（固定桶无损映射、仅 sketch 分位层对迁移前时段新建）；PoC 已完成。
