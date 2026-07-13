# Telemetry Tiered-Storage Implementation Plan

> **实施状态（2026-07-13）**：worktree `.worktrees/telemetry-storage/` @ `feat/telemetry-tiered-storage`。**P0 ✅**（sketch）、**P1 ✅**（schema+dictionary+paths）、**P2 ✅**（config 5 触点全接线）、**P3 T3.1 ✅**（store 写原语 `upsertSettledTier/upsertCumulative/upsertAccepted` 加性 UPSERT `7c10ce35`）。全 telemetry+config 套件绿（12 提交）。**P3 待做：sketch blob merge（cumulative read-merge-write）、T3.3 加性双写接线（request-telemetry.ts flush→SQLite，保内存路径不动、读 P5 才翻转——这是最需干净上下文的深集成，触 live persist）、T3.4 cap 重启重建**。然后 P4-P7。用 [prompts/kickoff.md](prompts/kickoff.md) 续。GPT 异模型 review infra-blocked（已自扮补位）。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **每 task 的逐字节 bite-sized TDD 步骤在执行期由 per-task subagent 即时展开**——本 plan 给出每 task 的文件/接口/测试 oracle/不变量/验收，Phase 0 附全套 bite-sized 模板。

**Goal:** 把遥测从单 27MB JSON 文件迁到独立 `telemetry.db`（SQLite 分层保留 + DDSketch 分布 + 全可配 `telemetry.*`），保持 `/metrics` 与 `/api/status.requestTelemetry` 客户端契约逐字节不变。

**Architecture:** 三层 rollup（raw 5min / hourly / daily）+ 终身累计层，纯聚合层（行级明细委托 History DB）。可加度量走 INTEGER/scaled-int 列精确 SUM，分布度量走 DDSketch 手动 DenseStore 序列化 BLOB（zstd 压缩）。双轨计数（进程内 process-lifetime 归零 + 持久 cumulative lifetime）。registry（维度/度量定义）零改动，仅替换存储读写层。

**Tech Stack:** Bun 1.3.14（主）/ Node 24.16（compat），`bun:sqlite`/`node:sqlite`，`@datadog/sketches-js@2.1.1`（零依赖），Umzug hybrid forward-runner，`node:zlib` zstd **raw-bytes**（评审 MEDIUM-1：`compression.ts` 的 `compress()` 是 `JSON.stringify` 帧、对二进制 sketch blob 不可用；用 `zstdCompressSync(bytes,ZSTD_OPTS)`/`zstdDecompressSync` 直压，或加 `compressBytes/decompressBytes` 变体。各层均压 ~3x，PoC 结论 5）。

**权威依据：** spec [docs/spec/2026-07-13-telemetry-tiered-storage.md](../../spec/2026-07-13-telemetry-tiered-storage.md)（2 轮评审 + 用户 3 决策）、PoC [exp/telemetry-storage/CONCLUSIONS.md](../../../exp/telemetry-storage/CONCLUSIONS.md)（全绿）。

## Global Constraints（每 task 隐含继承）

- **runtime**：Bun 主 / Node compat；PoC 证 STRICT INTEGER 拒 REAL、BLOB 往返、sketch 序列化**两 runtime 一致**，无需 runtime-conditional 分支。
- **DDSketch**：`relativeAccuracy` 默认 **0.01**；config `sketch_gamma` **下限 ~0.005**（PoC：0.001→6909 bin>2048 塌缩）。**手动序列化 DenseStore**（`{gamma,offset,minKey,maxKey,bins,zeroCount,count,min,max,sum}`），**绝不用 `toProto`/`fromProto`**（拉 protobufjs + 丢 min/max）。
- **cost 列**：**scaled-int micro**（`round(cost*1e6)`、列名 `cost_*_micro`、INTEGER），绝不 STRICT INTEGER 直存 REAL（PoC 证抛异常）。计数/token/ms 用 INTEGER。**micro 非 nano**（评审 HIGH-2）：cost=`整数 tokens×multiplier`、最小非零=`1×min_multiplier`（1e-4→micro 给 100，永不 round 到 0）故下限够；nano(1e9) 使**永久 cumulative**撞 `Number.MAX_SAFE_INTEGER`(9e15/1e9=仅 900 万 token-当量)→静默丢精度。回归 spec 的 1e6。
- **分布存储归属**（评审 HIGH-1 架构澄清）：**SQLite 只存 DDSketch**（供 `/api/stats` 分位）；`/metrics` 用**进程内内存固定桶**（process-lifetime、重启归零、`buildMetricsExposition` 读 `getDimensionBreakdown(...,"sinceStart")` **不读 SQLite**）；`/api/stats` 持久窗口**返 sketch 分位（p50/p90/p99+count/sum/min/max），不再返原始固定桶数组**。SQLite **无固定桶列**。
- **表**：`STRICT, WITHOUT ROWID`，字典编码 dim/key（整数替代重复字符串）。
- **config 5 触点**（DESIGN.md:241）：`schema.ts` + `config.ts`(apply) + `state.ts` + bundled `config.yaml`（双语注释）+ 运行时选项表，缺一不可。warn-continue 复用 `nullableSection`+`.strict()`+`cleanInvalidPaths`。
- **承重不变量**（spec §承重不变量 1-8）：两流分立 / model key 分裂 / 可加精确+分布误差界不混 / `/metrics` 精确固定桶且 `_sum`_`_count` 同批 / cumulative 永久且双轨 / cap 重启从 DB 重建 / agentKind 锚点三性质 / `/api/status.requestTelemetry` 逐字节兼容。
- **提交**：细粒度显式 pathspec（`git commit -- <精确路径>`）、conventional commits、无模型署名。隔离 worktree `.worktrees/telemetry-storage/` + 分支（并发会话隔离）。
- **测试隔离**：DI 注入临时 `db_path`（skill `test-isolation`，Bun `os.homedir()` 忽略 `env.HOME`）；不碰 4141 主服务器。

## 文件结构（decomposition 锁定）

**新建：**
- `src/lib/telemetry/sketch.ts` — DDSketch 封装：`createSketch(gamma)` / `serializeSketch` / `deserializeSketch` / `mergeSketch` / `quantile` / `sketchBucketCounts(boundaries)`（供固定桶导出）。纯函数、无 IO。
- `src/lib/telemetry/db.ts` — `telemetry.db` 打开/迁移/schema（Umzug hybrid，`tel_meta` 账本）。
- `src/lib/telemetry/store.ts` — 存储读写层：`upsertSettled` / `upsertAccepted` / `readDimensionBreakdown` / `readRequestTelemetrySnapshot` / `readCumulative`。替代旧 JSON persist。
- `src/lib/telemetry/rollup.ts` — rollup tick：`runRollupTick`（raw→hourly→daily，封桶水位、幂等、时钟回跳、TTL 裁剪）。
- `src/lib/telemetry/dictionary.ts` — dim/key 字典编码 `internDim`/`internKey`/`resolveKey`。
- `src/lib/telemetry/migrate-json.ts` — 旧 JSON 全量吸收 backfill（可恢复骨架，走 history-backfill 模式）。
- `src/lib/telemetry/config.ts` — `telemetry.*` config→state 映射 + γ 下限/resolution 整除校验。
- `ui-v4/src/types/telemetry.ts`（或 `~backend` re-export 点）— SSOT 类型收敛。

**修改：**
- `src/lib/request-telemetry.ts` — 存储读写从内存 bag/JSON 切到 `store.ts`；保留进程内 process-lifetime 计数（双轨）；registry/measure/dimension 定义**不动**。
- `src/lib/config/schema.ts` — 加 `TelemetryConfigSchema` + 挂 top-level。
- `src/lib/config/config.ts` + `src/lib/state.ts` — apply + state 键。
- `config.yaml`（bundled）— telemetry section 双语注释。
- `src/lib/metrics-exposition.ts` — `/metrics` 读精确固定桶（非 sketch）+ accepted，双轨来源。
- `src/routes/stats/route.ts` — window 路由扩层选择（raw/hourly/daily/lifetime）。
- `src/routes/status/route.ts` — requestTelemetry payload 由 store 重建（逐字节兼容）。
- `src/lib/config/paths.ts` — `TELEMETRY_DB` 常量 + 保留 `REQUEST_TELEMETRY`（迁移读旧）。

## Phase DAG（依赖顺序）

```
P0 sketch 封装 (纯，PoC 已证)
   └─> P1 db+schema+dictionary ──> P2 config(5触点)
                                      └─> P3 写路径(store.upsert + 双轨) ──> P4 rollup tick
                                                                              └─> P5 读路径迁移(snapshot/breakdown/metrics/stats 逐字节兼容)
                                                                                    └─> P6 旧JSON全量吸收backfill + .tmp清理
                                                                                          └─> P7 SSOT类型收敛 + 切换删旧JSON路径
```

每 phase 终态：typecheck 绿 + 该 phase 测试绿 + 不引入半坏中间态（commit invariants）。P3 起需 worktree 隔离。

---

## Phase 0 — DDSketch 封装（纯函数，PoC 已验证形状）

**Files:** Create `src/lib/telemetry/sketch.ts` + `tests/unit/telemetry/sketch.test.ts`. Modify `package.json`（`bun add @datadog/sketches-js@2.1.1`）。

**Interfaces — Produces:**
- `createSketch(gamma?: number): DDSketch`（默认 0.01）
- `serializeSketch(s: DDSketch): Uint8Array`（DenseStore 手动序列化，含 min/max）
- `deserializeSketch(bytes: Uint8Array): DDSketch`
- `mergeSketch(into: DDSketch, from: DDSketch): void`（同 γ，异 γ 抛）
- `quantile(s: DDSketch, q: number): number`
- `sketchBucketCounts(s: DDSketch, boundaries: readonly number[]): number[]`（cumulative `count(≤le)`，供固定桶导出对照——注：此仅供诊断/交叉验，`/metrics` 用独立精确固定桶）

- [ ] **Step 1 — 装依赖 + 失败测试**：`bun add @datadog/sketches-js@2.1.1`；写 `tests/unit/telemetry/sketch.test.ts`：`serialize→deserialize` 后 `quantile(0.99)` 与原 sketch **完全相等**、`min`/`max` 保留；对 5000 随机值，sketch quantile vs **exact-quantile oracle**（排序数组精确百分位）relErr ≤ 1%。
- [ ] **Step 2 — 跑测试证失败**：`bun test tests/unit/telemetry/sketch.test.ts` → FAIL（`sketch.ts` 不存在）。
- [ ] **Step 3 — 实现**：`sketch.ts`，序列化/反序列化按 PoC `exp/telemetry-storage/probe.mjs` 已验证的字段与重建法（`new DDSketch({relativeAccuracy})` 后覆写 `store.{offset,minKey,maxKey,bins,count}` + `{zeroCount,count,min,max,sum}`）；二进制编码（非 JSON——用 DataView 紧凑编 int 数组）。
- [ ] **Step 4 — 跑测试证通过**。
- [ ] **Step 5 — merge 测试**：加 `mergeSketch` 测试——12 sketch merge 后 `count` 精确、p99 vs exact oracle relErr ≤1%；异 γ merge 抛。跑绿。
- [ ] **Step 6 — γ 下限测试**：`createSketch(0.001)` 对值域 1..1e6 断言 bin 跨度 >2048（文档化塌缩边界）；`createSketch(0.01)` <2048。
- [ ] **Step 7 — Commit**：`git commit -- src/lib/telemetry/sketch.ts tests/unit/telemetry/sketch.test.ts package.json bun.lock`（`feat(telemetry): DDSketch wrapper with manual DenseStore serialization`）。

**Invariant P0：** sketch.ts 纯函数无 IO；序列化保 min/max；跨层 merge 零累积（PoC 已证）。

---

## Phase 1 — telemetry.db schema + 字典 + 迁移账本

**Files:** Create `src/lib/telemetry/db.ts` `src/lib/telemetry/dictionary.ts` + tests. Modify `src/lib/config/paths.ts`（`TELEMETRY_DB`）。

**Interfaces — Consumes:** none. **Produces:** `openTelemetryDb(path): Db` / `internDim(db,name):number` / `internKey(db,dim,key):number` / `resolveKey(db,id):{dim,key}`。

**Tasks（right-sized）：**
- **T1.1 schema 迁移**：Umzug hybrid forward-runner（复用 history-sqlite-schema 模式）建 `tel_dim`/`tel_key`/`tel_raw`/`tel_hourly`/`tel_daily`/`tel_cumulative`/`tel_accepted`/`tel_meta`（STRICT, WITHOUT ROWID，schema 见 spec §物理 schema，cost 列 **micro** scaled-int）。测试：迁移幂等（跑两次不报错）、跨-runtime（bun+node）建表一致。
- **T1.2 字典编码**：`internDim`/`internKey`（UNIQUE 约束 + upsert-returning-id）；`resolveKey` 反查。测试：同 (dim,key) 返同 id；并发 intern 无重复（小并发即可）。
- **T1.3 paths**：`TELEMETRY_DB = path.join(APP_DIR,"telemetry.db")`，保留 `REQUEST_TELEMETRY`（迁移读旧）。
- **Commit**：`feat(telemetry): telemetry.db schema + dictionary encoding + Umzug migration`。

**Invariant P1：** 迁移账本独立 `tel_meta`；STRICT 表拒类型漂移；cost 列 INTEGER(micro)。

---

## Phase 2 — `telemetry.*` config（5 触点）

**Files:** Modify `schema.ts`/`config.ts`/`state.ts`/`config.yaml`; Create `src/lib/telemetry/config.ts` + test.

**Tasks：**
- **T2.1 schema**：`TelemetryConfigSchema`（`enabled`/`db_path`/`persist_interval`/`rollup_interval`/`cardinality_cap`/`sketch_gamma`/`tiers.{raw.{resolution_minutes,retention_days},hourly.retention_days,daily.retention_days}`/`cumulative`），`nullableSection`+`.strict()`，挂 top-level `Config`。测试：未知 tier 键 `cleanInvalidPaths` strip+warn+continue。
- **T2.2 apply + state**：`config.ts` applyConfigToState 映射到 `state.ts` 键（mandatory 非「若有」）。测试：config→state 全键映射。
- **T2.3 业务校验**：`config.ts`（telemetry/config.ts）`sketch_gamma` <0.005 警告回落 0.01；`resolution_minutes` 非整除 60 警告回落 5。测试：两回落分支 + 热重载不杀进程。
- **T2.4 bundled config.yaml**：telemetry section 双语注释 + 运行时选项表更新。
- **Commit**：`feat(config): telemetry.* section with tiered retention knobs`。

**Invariant P2：** 5 触点齐；warn-continue；仅启动期 fail-fast（db_path 不可写）。

---

## Phase 3 — 写路径（store.upsert + 双轨计数）

**Files:** Create `src/lib/telemetry/store.ts`（写半）+ test. Modify `src/lib/request-telemetry.ts`（sink 存储切换，保留进程内计数）。

**Interfaces — Produces:** `upsertSettled(db, bucketTs, dimKeys, measures, sketchInputs)` / `upsertAccepted(db, bucketTs)`。**Consumes:** P0 sketch, P1 dict.

**Tasks：**
- **T3.1 upsertSettled**（✅ landed `7c10ce35`）：写 `tel_raw`（可加列加性累加）+ `tel_cumulative`（同）。cost 用 **micro** scaled-int（列名 `cost_*_micro`）。**SQLite 无固定桶列**（评审 HIGH-1：固定桶只活在 `/metrics` 内存路径，SQLite 只存 DDSketch）；sketch blob read-merge-write 拆为后续 slice（P3-a）。测试：多次 upsert 同 (dim,bucket,key) 加性累加正确。
- **T3.2 upsertAccepted**：写 `tel_accepted` + cumulative accepted（tel_meta）。测试：accept 计数不与 settled 混。
- **T3.3 加性双写**（评审 HIGH-3，非「切换」）：**完整保留现有内存路径**（`dimSinceStart`+`dimBuckets`+`bucketCounts`+JSON persist）作累加缓冲与读源不变；另在 `persist_interval` flush 时把脏桶 `upsertSettled`/`upsertAccepted` 到 SQLite（**store.upsert 由周期 flush 驱动、非 `recordSettledRequest` 每请求调**——兑现 persist_interval 批量语义）。读路径 P5 才翻转、JSON persist P7 才删。这消半坏中间态（P3→P5 间 7d/status 视图仍活）+ 让 P5 golden 有活内存快照可比。测试：flush 后 SQLite 桶与内存 `dimBuckets` 一致；进程内计数重启归零、DB cumulative 跨重启保留。
- **T3.4 cap 重启重建**：启动时从 `tel_cumulative` 载入 capped 维度已存 key 集作 cap 权威。测试：重启后第 201 个 client key 归 `other`。
- **Commit**：`feat(telemetry): SQLite write path + dual-track counters`（隔离 worktree 起）。

**Invariant P3：** 两流分立；registry 定义不动；固定桶 `_count`/`_sum` 同批；cap 重启从 DB 重建；agentKind 锚点三性质保持。

---

## Phase 4 — rollup tick（降采样 + 保留裁剪）

**Files:** Create `src/lib/telemetry/rollup.ts` + test. Modify `request-telemetry.ts`（定时器接线，独立 `rollup_interval`）。

**Tasks：**
- **T4.1 上卷**：`runRollupTick` raw→hourly→daily，可加列 SUM + sketch merge。**只消费已封口桶**（`bucket_ts < 当前分辨率对齐桶`）。测试：上卷后可加 SUM 与逐 raw 相等、分布 merge quantile 正确。
- **T4.2 幂等水位线**：`tel_meta` 存每层 `last_rolled_ts`，单调推进。测试：重放同 tick **不双计**（count 不翻倍）。
- **T4.3 时钟回跳**：`< 水位` 迟到写拒绝/路由 late（计 cumulative 不回改已裁层）。测试：模拟时钟回跳不落已裁桶。
- **T4.4 TTL 裁剪**：各层按 config retention 裁旧，`daily.retention_days:0` 永不裁，cumulative 永不裁。测试：各层 TTL 边界 + 永久层。
- **Commit**：`feat(telemetry): rollup tick with watermark + retention pruning`。

**Invariant P4：** 封桶边界；幂等（重放不双计）；时钟回跳不破坏已裁层；cumulative/daily(0) 永久。

---

## Phase 5 — 读路径迁移（逐字节兼容）

**Files:** Modify `store.ts`（读半）`request-telemetry.ts`（getRequestTelemetrySnapshot/getDimensionBreakdown 改 DB 源）`metrics-exposition.ts`（固定桶+accepted）`routes/stats/route.ts`（window 层路由）`routes/status/route.ts`。

**Tasks：**
- **T5.1 snapshot 重建**：`readRequestTelemetrySnapshot` 从 SQLite 重建 `getRequestTelemetrySnapshot` 形状（`buildFilledBuckets` 0 填充 + `buildLast7dModelSnapshots` per-bucket series + `models{SinceStart,Last7d}`）。**Golden 等价 oracle**：与旧内存快照逐字段字节兼容。
- **T5.2 dimension breakdown**：`readDimensionBreakdown(dim,window,limit)` 层路由（≤raw→raw、≤hourly→hourly、更长→daily、lifetime→cumulative）。cap `other` 折叠保持。测试：各 window 选层正确 + other 折叠。
- **T5.3 /metrics 双存储**：读**精确固定桶**（非 sketch）+ accepted_total；`_sum`/`_count` 同批固定桶来源。**逐字节 golden**：exposition 与旧格式兼容（Prometheus 严格解析）。
- **T5.4 /api/stats window enum 扩展**：加 `lifetime` + 层选择。测试：query 路由 + 未知 window 400。
- **T5.5 thinking_blocks 双轨**：`getThinkingBlockTotals` 读进程内（since restart 契约不变）。测试：重启归零。
- **Commit**：`feat(telemetry): SQLite read path — byte-compat /metrics + /api/status + tier routing`。

**Invariant P5：** `/api/status.requestTelemetry` + `/metrics` 逐字节兼容；window 层路由正确；thinking_blocks 双轨归零。

---

## Phase 6 — 旧 JSON 全量吸收 backfill + .tmp 清理

**Files:** Create `src/lib/telemetry/migrate-json.ts` + test. Modify 启动接线。

**Tasks：**
- **T6.1 可加+accepted backfill**：旧 JSON `dimensions`/`buckets` 精确导入 `tel_raw`/`tel_accepted` + 上卷种子（可恢复骨架：keyset + meta-flag 守卫 + cooperative-stop + never-throw）。测试：backfill 后可加 SUM 与旧 JSON 相等；续跑幂等。
- **T6.2 固定桶无损映射**：旧固定桶直方图 → 新固定桶列（一一对应）。测试：历史 `_bucket{le}` 计数字节精确。
- **T6.3 sketch 层标记**：迁移前时段 sketch 层新建、`/api/stats` 该段分位标注「pre-migration 固定桶近似」（合成可辨识）。测试：标注存在。
- **T6.4 .tmp 清理**：启动清理 `request-telemetry.json.tmp.*` 孤儿（安全）；旧 JSON **不自动删**（归档保留 + 显式开关）。测试：.tmp 删、JSON 留。
- **Commit**：`feat(telemetry): full-absorption backfill from legacy JSON + tmp cleanup`。

**Invariant P6：** 旧数据全量吸收不丢弃；可加精确、固定桶无损、sketch 段标记；旧 JSON 不自动删（no-destructive）。

---

## Phase 7 — SSOT 类型收敛 + 切换删旧路径

**Files:** Create/Modify `ui-v4/src/types/telemetry.ts`（→ `~backend/*` re-export）。Modify `request-telemetry.ts`（删旧 JSON persist 路径）。

**Tasks：**
- **T7.1 SSOT 类型**：新遥测查询类型（sketch summary / tier config / snapshot）后端定义一次，ui-v4 经 `~backend/*` re-export（收敛 frontend-loose）。**必跑 `typecheck:ui-v4`**（根 typecheck 不覆盖 ui-v4）+ `build:ui-v4`（`~backend` 须纯，不 import `~/lib/state`）。
- **T7.2 切换**：确认 SQLite 路径生产可用后，删旧 JSON persist 写路径（读旧仅 migrate 用）。measure/dimension registry 仍不动。
- **T7.3 DESIGN.md 同步**：「活的架构现状」加 telemetry-storage 行 + 「类型架构」节更新；DESIGN.md config 5 触点清单加 telemetry 键。
- **Commit**：`refactor(telemetry): converge SSOT types + retire legacy JSON write path`。

**Invariant P7：** ui-v4 typecheck+build 绿；旧 JSON 写路径退役、单轨 SQLite；DESIGN.md 同步。

---

## Self-Review（spec 覆盖核对）

- ✅ spec 目标 1（config 5 触点）→ P2；目标 2（分层 SQLite）→ P1/P3/P4；目标 3（DDSketch + scaled-int）→ P0/P3；目标 4（纯聚合层）→ 全程委托 History；目标 5（`/metrics`+`/api/status` 逐字节）→ P5；目标 6（.tmp 清理）→ P6。
- ✅ 2 BLOCKER：cost scaled-int → P0/P1/P3；`/metrics` 双存储固定桶 → P3(写)/P5(读)。
- ✅ 6 HIGH：手动序列化 P0；读路径迁移 P5；cap 重建 P3.4；rollup 幂等/水位/时钟 P4；分布层迁移标记 P6；accepted 流 P3.2 + agentKind 锚点 P3。
- ✅ 承重不变量 1-8 分布于各 phase invariant。
- ✅ 4 PoC 项已在实现前验证（exp/）。
- **Type consistency**：`upsertSettled`/`readDimensionBreakdown`/`readRequestTelemetrySnapshot`/`internKey`/`mergeSketch` 命名跨 phase 一致。

## 评审采纳修订（plan review 第 1 轮，全部采纳）

- **HIGH-1（分布存储归属）**：见 Global Constraints 新增行。连带修订：**T5.3** 实质=「保留 `/metrics` 现有内存渲染、**不**改成读 SQLite」（措辞从「SQLite read path」剥离）；**T6.2 固定桶无损映射作废**（`/metrics` 是 process-lifetime 内存、无历史区间，旧固定桶无 SQLite 落点；迁移前分布段 `/api/stats` 直接缺 sketch、留标注）；P1 schema **不加固定桶列**。
- **HIGH-2（cost micro）**：见 Global Constraints；列名 `cost_*_micro`；spec §物理schema 的 `cost_input_micro` 命名正确、值改 1e6。
- **HIGH-3（加性双写）**：见 T3.3 重写。
- **MEDIUM-1（compression raw-bytes）**：见 Tech Stack。
- **MEDIUM-3（agentKind 永不 capped 测试）**：**T3.4 追加**测试「cumulative cap-rebuild 后 agentKind 全 key 保留、绝不折 other」；不变量 2（model key 分裂）加一句回归断言。
- **不变量 20 澄清**：`/metrics` 固定桶是**进程内内存**（非 SQLite）；`_sum`/`_count` 同批仍守。
- **建议采纳**：① **P5 拆 ≥2 commit**（`/api/status`+snapshot 一提交、`/metrics`+`/api/stats` 一提交）；② worktree **从 P0 起**隔离（已建 `.worktrees/telemetry-storage/`）；③ **T4 追加** zstd 各层策略实测 + 字典表并发锁测 + Umzug 跨-runtime e2e 三 task（PoC §未覆盖承接）；④ 固定桶/写模型等结构决策已在 plan 层锁死（不留给 per-task 展开）。

## Kickoff

见 [prompts/kickoff.md](prompts/kickoff.md)。
