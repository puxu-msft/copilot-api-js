# Plan：把 telemetry 域抽成独立包 `@hsupu/ghc-proxy-telemetry`

> **状态：定稿**（architect-advisor 调研产出 → GPT 异模型对抗审 0-blocker/3-MAJOR/2-MINOR → 主会话独立核实证据后折入 → 用户裁定 D1=(b) 全域一包）。这是 spec §7.2 阶段 4+「core 内部增量解环」的**第二个领域包剥离**，模板承自 [plan-token-package.md](plan-token-package.md) 的「通用 DomainPeel Contract」+ 执行技巧记忆 `methodology-domain-peel-execution-techniques`。索引 [README.md](README.md)、spec [../../spec/2026-07-22-monorepo-workspace-split.md](../../spec/2026-07-22-monorepo-workspace-split.md)、SCC 基线 [../../../tests/architecture/circular-deps-baseline.json](../../../tests/architecture/circular-deps-baseline.json)。
>
> **评审折入摘要（2026-07-23）**：GPT reviewer 确认 (b) 范围正确、三环 #34/#35/#36 确实被打断（无残留回边、无 config 双 SoT），并抓出 3 个 architect 漏项——① JSON backfill 是 post-listen 生命周期调用（§3 runtime API 补 `runJsonBackfill` + §4 矩阵补 start.ts:593 + §6 T2 保序）；② telemetry 无 token 式 setStateForTests-shim，~21 测试直调 lifecycle/record API，删导出与「零 churn」矛盾（§5 补 package-owned `testing` 入口 + 迁移表）；③ `sketchGamma` 是 DB-open 时冻结的数据正确性不变量、**不能**当 live config 值（§3.1 补逐字段 config 生命周期分类 + `effectiveSketchGamma` runtime 私有）。2 MINOR：边界守卫改 allowlist（§7）、config 字段 11 非 12。均已折入。
>
> **⏳ 实施状态（2026-07-23）**：**T0 已 landed**（`8a762437`，`sqlite/{driver,compression}` 上提 foundation，test:backend 6317/0），在 **worktree `.worktrees/telemetry-peel` 分支 `feat/telemetry-package`**（从 master `8d156969` 起，含 A 的 SCC 守卫 + 本 plan）。**剩余 T1→T2→T3→T4→T5 待续**（见 §6 闭合 commit DAG）。执行前核实已做：D3 `lib/sqlite` 无并发占用 ✓、madge 三环含 telemetry ✓、D5 坐实 `ui-v4/src/types/status.ts` import `~backend/lib/request-telemetry`（T5 须同步 ui-v4 别名）。**T0 尚未合 master**（留分支等续跑，或经用户许可先合——它独立、利好 history）。接手 kickoff 见文末。
>
> **调研基座（2026-07-23，worktree `feat/monorepo-scc-guards` == master + 两条新 SCC 守卫）**：本 plan 的依赖盘点、消费者矩阵、SCC 归属均 grep 实测带 `file:line`；核心结论 = telemetry 与 token 在**所有权形态**上根本不同（telemetry 是 config 的**只读消费者**、不 own 任何 `state` 字段），因此**无 token C5 式的 SoT 反转**，但**有 token 没有的 module-split**（`telemetry-dimensions.ts` 须劈成 name-registry ⊂ package + extractors ⊂ core）。
>
> **判据（本 plan 一律按此，禁 ROI/YAGNI 砍范围）**：长远正确 + 完整 > 短期省事；架构健康 / 边界硬度 > 向后兼容 / 回归风险 / 迁移麻烦。承重 invariant：抽出包**对 core 零依赖**（机器可验证边界守卫）、单一 SoT（无双 SoT）、行为逐字节不变。

## 0. TL;DR（给裁决者的三行）

- **中心分叉**：storage-only 剥离**干净但 0 环削减**（`src/lib/telemetry/*` 不是 SCC 成员）；真正削 SCC 的价值在**把 registry（`request-telemetry.ts`）+ dimensions name-registry 一并剥出**——削 **3 条环 / 2 个环成员**（73→70 环、63→61 成员），机器可验证。
- **推荐 = Option (b) 全域一包**（storage + registry + name-registry 合成**一个** `@hsupu/ghc-proxy-telemetry`），**sink（`observability/sinks/telemetry.ts`）与 dimension extractors 留 core**。理由见 §2。
- **与 token 的关键差异**：① 无 SoT 反转（telemetry 读 config、不 own state）→ 无 `setStateForTests`-shim 涟漪；② 但需 `telemetry-dimensions.ts` 的 name/extractor 劈裂（token 无此）；③ 前置需把 `sqlite/{driver,compression}` 上提 foundation（利好 history，非 telemetry 私有）。

## 1. 依赖盘点（完整 import 清单，grep 实测带 file:line）

域内文件三层：**storage**（`src/lib/telemetry/*.ts`，8 文件）· **registry**（`src/lib/request-telemetry.ts`）· **sink+dimensions**（`src/lib/observability/{sinks/telemetry,telemetry-dimensions}.ts`）。

### 1.1 storage 层 `src/lib/telemetry/*.ts`（全部 domain-owned，随包搬）

| 文件 | 跨域 import（`~/lib/*` / external） | 分类 |
|---|---|---|
| `db.ts:14` | `~/lib/config/paths` → `PATHS`（`TELEMETRY_DB` 默认路径） | **injected-core-capability**（`TelemetryPaths` 角色对象） |
| `db.ts:15-19` | `~/lib/sqlite/driver` → `createDatabase` / `SqliteDatabase` | **foundation-hoist**（见 §1.4） |
| `read.ts:23` · `rollup.ts:24` · `store.ts:16-21` | `~/lib/sqlite/compression` → `decompressBytes` / `compressBytes` | **foundation-hoist**（见 §1.4，解决被 mask 的 `decompressBytes`） |
| `migrate-json.ts:36-38` · `rollup.ts:22` | `consola` / `node:fs` / `node:path` | external（package deps 显式声明 `consola`） |
| `sketch.ts:11` | `@datadog/sketches-js` | external（package deps 显式声明） |
| `dictionary.ts` · `sketch-blob.ts` | 仅 `./db` / `./sketch`（域内相对） | **domain-owned**（纯叶子） |

storage 层**内部相对 import 全闭合**（`./db` `./dictionary` `./rollup` `./store` `./sketch` `./sketch-blob` `./migrate-json` `./read` 互引）。**结论：storage 层的全部跨域依赖仅 3 类——`config/paths`（注入）+ `sqlite/driver`（foundation）+ `sqlite/compression`（foundation）**，且**均非 SCC 成员**（storage 是 acyclic 近叶）。

### 1.2 registry `src/lib/request-telemetry.ts`（domain-owned，随包搬）

| import（file:line） | 符号 | 分类 |
|---|---|---|
| `:1-2` | `consola` / `node:fs` | external |
| `:4-7` | `~/lib/atomic-fs` → `createSerializedAsyncFn` | **foundation**（已在 `packages/foundation/src/atomic-fs.ts`，改包名 import） |
| `:13` | `./config/paths` → `PATHS` | **injected**（`TelemetryPaths`） |
| `:15-19` | `./state` → `state`（value）+ `onTelemetryConfigChange`（value） | **injected-core-capability**（`TelemetryConfigView` + config-change 订阅端口——**非 SoT 反转**，见 §3） |
| `:9` | `./history/store` → `UsageData`（**type-only**） | **not-yet-severable / 需裁决**（§1.5：redefine 包内 or foundation-hoist；type-only 边仍被 madge 计环） |
| `:10` · `:14` | `./observability/telemetry-dimensions` → `ThinkingBlockCounts`（type）+ `CAPPED_DIMENSION_NAMES`（value） | **module-split**（name-registry 入包，见 §1.3） |
| `:11,20,21-49` | `./telemetry/{db,dictionary,migrate-json,read,rollup,sketch,sketch-blob,store}` | **domain-owned**（storage 层，随包搬） |

registry 读 **11 个 `state.telemetry*` config 字段**（`telemetryEnabled` / `telemetryDbPath` / `telemetryPersistInterval` / `telemetryRollupInterval` / `telemetryCardinalityCap` / `telemetrySketchGamma` / `telemetryCumulative` / `telemetryRawResolutionMinutes` / `telemetryRawRetentionDays` / `telemetryHourlyRetentionDays` / `telemetryDailyRetentionDays`；实测 `state.ts:1554-1569` `setTelemetryConfig` 接收这 11 个 key、`:705-727` 定义、`request-telemetry.ts` 内 ~20 处读点如 `:1064,1220,1361,1826`）——**全部是 config 只读投影**，SoT 在 config（`config/config.ts:930` → `setTelemetryConfig` → state）。registry **不 own 任何 state 字段**：其运行时状态（accumulators / `telemetryDb` handle / persist+rollup timer）是 **module-local**、已有 `_resetRequestTelemetryForTests` 复位缝。（两个路径 `TELEMETRY_DB`/`REQUEST_TELEMETRY` 归 `TelemetryPaths`、**不计入** config projection。）

> **⚠️ `sketchGamma` 是 DB-lifetime 冻结值、不是 live config（评审 MAJOR-3，承重数据正确性不变量）**：`telemetrySketchGamma` 在 DB open 时写/读 `tel_meta`、冻结为 `effectiveSketchGamma`（`request-telemetry.ts:1220-1239`），每次构造 DDSketch 用**冻结值**、明确禁用 live state gamma（`:583-590`）。机械把所有 `state.telemetry*` 换成 `deps.config.*` 会让运行中 gamma 热变更把新 gamma 的 delta merge 进旧 gamma 的持久 blob → 写失败 + outbox foldback + 可能持续无法落盘。故 `sketchGamma` **必须**走 DB-frozen 语义、`effectiveSketchGamma` 是 runtime 私有（不经 config view 重解析）——见 §3.1 逐字段生命周期分类。

### 1.3 sink + dimensions（**不整体搬**——sink 留 core、dimensions 劈裂）

`observability/sinks/telemetry.ts`（bus→registry 适配器）imports：
- `:17` `~/lib/request-telemetry` → `recordSettledRequest`（value，将变 core→package 合法下行边）
- `:19-23` `../index` → `ObservabilityBus` / `ObservabilityEvent`（type，observability 域）
- `:25-29` `../telemetry-dimensions` → `CAPPED_DIMENSION_NAMES` / `extractTelemetryKeys` / `extractThinkingBlockCounts`

sink 的职责是**读 bus 事件的 `entry`+`ctx`、调 extractor 算出 `keys`、再喂 registry**（`sinks/telemetry.ts:56-97` 实测）。它**内在依赖 entry/ctx/observability 类型**——**留 core**。

`observability/telemetry-dimensions.ts` 是**混合文件**，须劈裂：
- **name-registry 部分（entry/ctx-free → 入包）**：`ThinkingBlockCounts` type（`:115`）、`CAPPED_DIMENSION_NAMES`（`:182`）、`TELEMETRY_DIMENSION_NAMES`（`:185`）、以及 `StatDimension` 的 name/cardinality 元数据（`:46`）。
- **extractor 部分（读 entry/ctx → 留 core）**：`extractTelemetryKeys(entry,ctx)`（`:188`）、`extractToolNames(entry)`（`:79`）、`normalizeClient(headers)`（`:64`）、`extractThinkingBlockCounts(entry)`（`:129`）、`TELEMETRY_DIMENSIONS` 数组里的 `.extract` 闭包（`:168-179`）。这些 import `~/lib/context/types`（`HistoryEntryData` type，`:32`）、`~/lib/observability/events`（`RequestContextSnapshot` type，`:33`）、`~/lib/fetch-utils`（`getHeaderCaseInsensitive` **value**，`:35`）。

**劈裂难点**：`TELEMETRY_DIMENSIONS`（`:168`）当前把 `{name, cardinality, extract}` 三合一绑在一个数组里，`CAPPED_DIMENSION_NAMES`/`TELEMETRY_DIMENSION_NAMES` 从它 derive。劈裂后包侧持 **name+cardinality 规格表**（`TELEMETRY_DIMENSION_SPECS: [{name,cardinality}]`），core 侧 extractor registry 按 name 配 `extract(entry,ctx)`、从包 import name 表。这正是该模块 docstring 自陈的设计意图（`:1-30`「registry type-light；extractor knows entry/ctx」）——劈裂只是把它落成包边界。

### 1.4 被 mask 的 `decompressBytes` 溯源（裁决点）

`decompressBytes` / `compressBytes` 定义在 **`src/lib/sqlite/compression.ts`**（实测 imports 仅 `node:util` `promisify` + `node:zlib` `gzip/gunzip/zstd*`——**纯**、**非任何 SCC 成员**）。同目录 `sqlite/driver.ts`（`createDatabase`）imports 仅 `node:module`——同样纯、非环成员。**spec §3 已把 `sqlite(driver+compression)` 明确划入 foundation**；2026-07-23 commit `73feee44` 已把它们从 history 迁到 `lib/sqlite/`（相对 foundation-ready）。**结论：`decompressBytes` foundation-able，是 telemetry 剥离的前置 foundation-hoist（连带利好 history/v3——history 也用 `lib/sqlite/*`，非 telemetry 私有）。**

### 1.5 `UsageData` type 溯源（裁决点）

`request-telemetry.ts:9 import type { UsageData }` 来自 `history/store` barrel（re-export，真定义在 history 域）。registry 仅用它作 `SettledTelemetryInput.usage?: UsageData`（`:334`）读 token 计数字段。三选一（§开放问题 Q3）：(a) 包内自定义结构型 `TelemetryUsage`（推荐——registry 只读几个数值字段、结构解耦）；(b) 上提 foundation 作共享 usage 类型；(c) 保留 type-only 边（但 madge 计环 → 环削减不达标，否决）。

## 2. Scope analysis + 推荐（中心分叉）

### 2.1 三个选项的量化权衡

| 维度 | (a) storage-only | (b) 全域一包【推荐】 | (c) 分两次剥离 |
|---|---|---|---|
| 范围 | `src/lib/telemetry/*`（8 文件） | storage + registry + dimensions name-registry（合一包） | 先 storage、后 registry（两 plan） |
| **SCC 环削减** | **0**（storage 非环成员，实测基线 `members` 无 `lib/telemetry/*`） | **3 环 / 2 成员**（削 baseline #34/#35/#36；`request-telemetry.ts` + `observability/telemetry-dimensions.ts` 出 members） | 最终同 (b)，但 storage 步 0、registry 步才削 |
| 外部消费者 | storage 的域外直接消费者**仅 2**：registry（留 core）+ `routes/stats/route.ts:51`（`~/lib/telemetry/read`）。**storage 独立成包 → 与其 owner（registry）跨包 chatty** | registry 域外消费者 7（见 §4 矩阵）、storage 消费者内聚包内 | storage 步造出一个「只有 registry 一个真消费者」的孤包，registry 步再吸收——**两倍搬迁 ceremony + 中途 chatty 边界** |
| SoT 反转 | 无 | **无**（telemetry 读 config，不 own state——与 token C5 根本不同） | 无 |
| module-split（dimensions 劈裂） | 无 | **有**（唯一真难点，§1.3） | registry 步才有 |
| 测试涟漪 | 低（transitional alias `~/lib/telemetry/*` → 0 改动） | 低（同上 + registry 已有 `_resetRequestTelemetryForTests`、config 留 state 故 `setStateForTests` 不动） | 低但重复两轮 |
| blast-radius | 极小 | 中（config 注入端口铺开 + dimensions 劈裂 + 7 消费者过 barrel） | 中（分摊两次、但总和更大） |
| 架构价值 | **≈0**（不削环、造孤包） | **高**（削 SCC + 领域自治 + config 注入范式复用 token） | 高但过程冗余 |

### 2.2 推荐：Option (b) 全域一包，sink+extractors 留 core

**推荐把 storage + registry + dimensions name-registry 合成一个 `@hsupu/ghc-proxy-telemetry`，一个 plan、内部 DAG 排序（foundation-hoist → storage substrate → registry+config 注入 → dimensions 劈裂 → git mv）。** 理由（按判据）：

1. **storage-only（a）不削环、造孤包——违「有意义且完整 > 最小能交付」**。storage 层的 owner/brain 就是 registry；把它俩拆两包，得到一个「唯一真消费者是另一个 core 模块」的孤儿包 + 一条 chatty 跨包边界。这是「为简单而砍范围」的反面教材，判据明令禁止。storage 独立**只在 registry 也剥出后**才有意义（那时它是 registry 的包内 substrate）。
2. **(b) 是唯一产出机器可验证架构价值的范围**：削 baseline `#34`（`request-telemetry > history/store`）、`#35`（`request-telemetry > telemetry-dimensions > context/types`）、`#36`（`request-telemetry > state`）三环，`request-telemetry.ts` 与 `observability/telemetry-dimensions.ts` 双双出 `members`（63→61）。这正是 spec §6 措施 2 ratchet 要奖励的方向。
3. **(b) 的所有权面比 token 简单**（无 SoT 反转），**难点是 dimensions 劈裂**——但该劈裂是模块自陈设计意图的落地、长远正确（registry type-light、extractor 知 entry/ctx 的边界本就该是包边界）。
4. **(c) 分两次**违「完整 > 最小」且制造冗余 ceremony + 中途 chatty 边界；除非 storage 劈裂本身风险大到需要单独 land（实测不然——storage 依赖仅 3 类、纯度高），否则不值。**唯一采纳 (c) 的条件**：foundation-hoist sqlite 若因 history 域并发占用无法即时做，可先在包内**临时**经 transitional alias 引 `~/lib/sqlite/*`（短期编译中间态），但这属执行期战术、非范围决策。

### 2.3 交回裁决者的分叉点

- **D1（范围）**：确认 Option (b)（全域一包）而非 (a)/(c)。**推荐 (b)**。
- **D2（sink 归属）**：确认 sink（`sinks/telemetry.ts`）+ dimension extractors **留 core**（本 plan 前提）。若裁决者想把 extractor 也塞包，则包会反向依赖 `context/types`/`observability/events`/`fetch-utils`——**拽 history/context 进 telemetry 依赖面、边界守卫必红**，强烈不建议。
- **D3（前置 foundation-hoist sqlite 时机）**：`sqlite/{driver,compression}` 上提 foundation 是前置（也利好 history）。确认现在做、还是先临时 alias（见 §2.2 条 4）。**推荐现在做**（一次性、利好面更大）。
- **D4（`UsageData` 归属）**：§1.5 三选一。**推荐 (a) 包内 `TelemetryUsage` 结构型**。

## 3. Composition root（承重设计——与 token 的最大差异：config 注入而非 SoT 反转）

telemetry 包唯一公开装配入口，覆盖**唯一 production 构造点**（实测 `packages/cli/src/start.ts:394 initRequestTelemetry()` + `:400 attachTelemetrySink(bus)`——比 token 的 5 条 CLI 链简单）：

```ts
// ── 注入端口（角色/视图对象，非裸字段、非位置参——遵 token DI 范式） ──
export interface TelemetryPaths {
  readonly telemetryDbPath: string   // PATHS.TELEMETRY_DB 默认
  readonly requestTelemetryJsonPath: string // PATHS.REQUEST_TELEMETRY（legacy JSON，仅迁移/backfill 读）
}
/** core-owned config，registry 只读、live 投影（热重载须读到新值）。 */
export interface TelemetryConfigView {
  readonly enabled: boolean
  readonly dbPath: string
  readonly persistInterval: number
  readonly rollupInterval: number
  readonly cardinalityCap: number
  readonly sketchGamma: number
  readonly cumulative: boolean
  readonly rawResolutionMinutes: number
  readonly rawRetentionDays: number
  readonly hourlyRetentionDays: number
  readonly dailyRetentionDays: number
}
/** config-change 订阅端口（对应 state.onTelemetryConfigChange——registry 用它热重载重调 persist/rollup timer）。 */
export interface TelemetryConfigSubscription {
  onChange(listener: () => void): () => void
}
export interface TelemetryRuntimeDependencies {
  readonly paths: TelemetryPaths
  readonly config: TelemetryConfigView           // live 视图（getter over state）
  readonly configSubscription: TelemetryConfigSubscription
}

// ── runtime 门面（承载 timer/db handle 生命周期——5 阶段，见 §3.2） ──
export interface TelemetryRuntime {
  initialize(): Promise<void>                     // = 现 initRequestTelemetry（从 SQLite 重建内存 7d 窗口 + init 冻结 pre-startup legacy-JSON snapshot）
  runJsonBackfill(now?: number): void             // = 现 runTelemetryJsonBackfill（POST-listen：server 监听后才吸收 legacy JSON，避免阻塞启动、保持与启动后 tel_raw 写入的结构互斥——评审 MAJOR-1）
  recordAccepted(timestamp?: number): void        // = recordAcceptedRequest（context/manager 调）
  recordSettled(keys, opts, capped?): void        // = recordSettledRequest（sink 调）
  getSnapshot(): RequestTelemetrySnapshot          // routes/status
  getDimensionBreakdown(...): DimensionBreakdownSnapshot // routes/stats + /metrics
  getTelemetryDb(): TelemetryDatabase | null       // routes/stats
  getThinkingBlockTotals(): ...                    // routes/status
  persist(): Promise<void>                         // = persistRequestTelemetry
  stopBackgroundWork(): void                        // = stopTelemetryBackgroundWork（restart Phase1）
  dispose(): Promise<void>                          // = shutdownRequestTelemetry（先退订 config listener 再 flush await——见 commit 71168666）
}
export function createTelemetryRuntime(deps: TelemetryRuntimeDependencies): TelemetryRuntime

// ── 进程单例生命周期（同 token 范式） ──
export function installTelemetryRuntime(rt: TelemetryRuntime): void   // 装到 LIVE 之上须先 dispose，否则 throw
export function getTelemetryRuntime(): TelemetryRuntime               // fail-fast（未装配 throw，无模块级静默兜底）
export function peekTelemetryRuntime(): TelemetryRuntime | undefined  // 容忍腿（请求/关停：init 前 no-op 语义正确）
export function resetTelemetryRuntimeForTests(): Promise<void>        // dispose 当前（停 timer + flush）+ 清单例，登记 RESETTERS
```

**关键差异记录**：token 的 composition root 承担了**凭据 SoT 反转**（credentials 从 state 迁进 token store）；telemetry **没有 SoT 可反转**——它的 config SoT 恒在 core-config，registry 永远是**只读消费者**。所以 telemetry 的 composition root 只做**两件事**：① 注入 config live 视图 + change 订阅（替 `state`/`onTelemetryConfigChange` 两个 value import）；② 把 timer/db handle 的进程单例生命周期收进 runtime。**peek/get 容忍分层**（记忆技巧 3）：`start.ts` 构造用 `getTelemetryRuntime()` fail-fast；`sink.recordSettled` / `shutdown.dispose` / `routes` 读用 `peekTelemetryRuntime()?.op()`（避免逼每个 http 测试装 dummy）。

**ambient 端口 floor preload（记忆技巧 2，承重）**：registry 的 `recordAcceptedRequest`/`recordSettledRequest`/`persist`/`initialize` 是**自由函数**、被直接调（非经 runtime 对象）。抽包后它们失去 `~/lib/state` import、需 ambient 安装的默认 config 端口才能解析。加**第二个 bunfig preload**（排在 fs sandbox floor 之后），全局 install 一个默认 `TelemetryConfigView`（**getter over live `state.telemetry*`**）+ 默认 `TelemetryPaths`（读 live `PATHS`）——每个测试（含直调自由函数、不走 isolated-fixture 的）都解析。config 视图是无状态 adapter（读时取 live state）→ floor 装一次、永不 reset；per-test reset 的是 runtime 单例（`resetTelemetryRuntimeForTests`）+ 已有的 `_resetRequestTelemetryForTests`。**这保证 `setStateForTests({telemetryEnabled})` 照旧穿透**（config 留 state、视图 live 读）。

### 3.1 config 逐字段生命周期分类（评审 MAJOR-3——机械替换会坏 DDSketch，必须分类）

`TelemetryConfigView` 是 **live getter over state**，但**不同字段的「live」语义不同**——注入时必须按下表逐字段落地，禁止「一律 live-per-use」或「一律订阅后重建资源」的机械处理：

| 字段 | 生命周期语义 | 依据（file:line） |
|---|---|---|
| `enabled` · `persistInterval` · `rollupInterval` | **timer-reconfigure**：change 时经 `configSubscription` 通知 → 重调 persist/rollup timer。当前**仅这三个**触发 `onTelemetryConfigChange` listener | `state.ts:1572-1579`（仅这三个 fire listener） |
| `cardinalityCap` · `cumulative` · `rawResolutionMinutes` · `rawRetentionDays` · `hourlyRetentionDays` · `dailyRetentionDays` | **next-record / next-tick live read**：无需订阅，下一次 record/rollup 读 live 值即生效 | registry 内直接读 `config.*` 于 record/tick 路径 |
| `sketchGamma` | **DB-lifetime FROZEN**：DB open 时冻结进 `tel_meta` 为 `effectiveSketchGamma`；**运行中永不重读 live 值**；`effectiveSketchGamma` 是 **runtime 私有状态、不经 config view 暴露/重解析** | `request-telemetry.ts:1220-1239`（冻结）、`:583-590`（构造 sketch 用冻结值、禁 live） |
| `dbPath`（及 `TelemetryPaths` 两路径） | **init-only path selection**：仅 initialize 时选库；热更新**不** close/reopen DB（当前行为，byte-preserved 须保留、不得暗示所有 config 更新触发生命周期重建） | init 路径读一次 |

**落地约束**：`TelemetryConfigView` 只暴露前两类字段作 live 视图；`sketchGamma` 经 config 传入 initialize 作**候选**、由 runtime 在 DB open 时冻结成私有 `effectiveSketchGamma`，之后 record 路径读私有值不读 config。**回归测试（必加）**：初始化已有 gamma 的 DB → 改 config gamma → 继续 record+persist → 断言写入成功且用**原 DB gamma**；并保留现有 timer 热重载测试。

### 3.2 telemetry runtime 5 阶段生命周期表（评审建议——固定 timer/db/snapshot/drain 的 owner 契约）

| 阶段 | runtime 方法 | 消费点 | 契约 |
|---|---|---|---|
| ① initialize | `initialize()` | `start.ts:394`（listen 前） | 从 SQLite 重建 7d 窗口 + 冻结 `effectiveSketchGamma` + 冻结 pre-startup legacy-JSON snapshot |
| ② post-listen backfill | `runJsonBackfill()` | `start.ts:593`（**listen 后**） | 吸收 legacy JSON、非阻塞启动、与启动后 tel_raw 写入结构互斥 |
| ③ Phase-1 stop | `stopBackgroundWork()` | `shutdown.ts`（restart Phase1） | 停 persist/rollup timer、不 flush（幂等，见 `telemetry-stop-on-phase1` 测试） |
| ④ final shutdown | `dispose()` | `shutdown.ts:405,460` | 先退订 config listener → flush await → close db（顺序见 commit 71168666） |
| ⑤ test reset | `resetTelemetryRuntimeForTests()` | RESETTERS / fixture | dispose 单例 + 清空 + 复位 module-local（配合 `_resetRequestTelemetryForTests`） |

## 4. 所有权 / 消费者矩阵（config 只读，无字段删除）

telemetry 包**不删任何 state 字段**（config 归 config）。下列消费点迁为经 telemetry 包 barrel API / runtime，**禁 deep import**：

| 消费点（file:line） | 现引用 | 迁为 |
|---|---|---|
| `packages/cli/src/start.ts:394` | `initRequestTelemetry()` | `getTelemetryRuntime().initialize()`（装配点构造 runtime） |
| `packages/cli/src/start.ts:593`（**listen 后**，评审 MAJOR-1） | `runTelemetryJsonBackfill()` | `getTelemetryRuntime().runJsonBackfill()`——**T2 必须保持 init→listen→backfill 顺序**，`tests/telemetry/backfill-wiring.unit.test.ts`（若无则新建）列为不可省略的生产接线 oracle |
| `packages/cli/src/start.ts:400` · `:53` | `attachTelemetrySink(bus)`（sink 留 core） | 不变（sink 在 core、import 包的 `recordSettled`） |
| `src/lib/context/manager.ts:30` | `recordAcceptedRequest` | `peekTelemetryRuntime()?.recordAccepted()` |
| `src/lib/observability/sinks/telemetry.ts:17` | `recordSettledRequest` | `peekTelemetryRuntime()?.recordSettled(...)`（sink 留 core） |
| `src/routes/status/route.ts:29-33` | `getRequestTelemetrySnapshot` / `getThinkingBlockTotals` | 包 barrel（经 `peek`） |
| `src/routes/stats/route.ts:34-40` · `:51` | `DEFAULT_BREAKDOWN_LIMIT` / `getDimensionBreakdown` / `getTelemetryDb` + `~/lib/telemetry/read` + `TELEMETRY_DIMENSION_NAMES` | 全经包 barrel（`read` 变包内部、`TELEMETRY_DIMENSION_NAMES` 从包 name-registry） |
| `src/lib/metrics-exposition.ts:22-36` | `DimensionBreakdownSnapshot`/`HistogramSummary`(type) + `getDimensionBreakdown`/`getRequestTelemetrySnapshot`/`TELEMETRY_HISTOGRAMS`/`TELEMETRY_MEASURE_NAMES` + `TELEMETRY_DIMENSION_NAMES` | 全经包 barrel |
| `src/lib/shutdown.ts:51-53` · `:405,460` | `shutdownRequestTelemetry` / `stopTelemetryBackgroundWork` | `peekTelemetryRuntime()?.dispose()` / `.stopBackgroundWork()`（shutdown 已有 `shutdownRequestTelemetryFn` 注入缝 `:279`，天然适配） |
| `src/lib/config/paths.ts` | `TELEMETRY_DB` / `REQUEST_TELEMETRY` 常量 | 留 core（config 域）；经 `TelemetryPaths` 注入包 |

**类型 SSOT（`~backend` 前端消费，spec §9 陷阱 1）**：`RequestTelemetrySnapshot` / `DimensionBreakdownSnapshot` / `LearnedSnapshot` 等前端经 `~backend/*` re-export 的纯类型若随 registry 迁进 telemetry 包，**须同步改 `ui-v4/vite.config.ts` + `ui-v4/tsconfig*.json` 两处别名**、且包须出 `src/types.ts` 纯类型 barrel（防拉入后端运行时依赖）。**执行前 grep `~backend` 命中的 telemetry 类型清单**，`build:ui-v4` + `typecheck:ui-v4` 双验。

## 5. 测试隔离契约（比 token 轻——无 SoT 反转）

- **config 留 state → `setStateForTests({telemetry*})` 零改动**（实测 `tests/telemetry/dual-write.unit.test.ts:161` / `cumulative-cap-authority.unit.test.ts:106` / `rollup-timer.unit.test.ts:57` 等直接写 `telemetryEnabled/telemetryDbPath/...`——这些字段**不迁走**，snapshot/restoreStateForTests 照旧覆盖）。**无 token 式 `setStateForTests`-shim 涟漪**。
- **registry 运行时状态复位缝已存在**：`_resetRequestTelemetryForTests` / `_setRequestTelemetryFilePathForTests`（实测 `tests/pipeline/request-telemetry.unit.test.ts:14-16`）。抽包后这些随包走、继续登记 RESETTERS。新增 `resetTelemetryRuntimeForTests()`（dispose 单例：停 persist+rollup timer + flush）登记 RESETTERS + fixture afterEach。
- **transitional alias 保 import 路径、但删掉的 lifecycle/record API 需 package-owned `testing` 入口（评审 MAJOR-2，token 无此涟漪）**：加 `~/lib/telemetry/*` + `~/lib/request-telemetry` → 包别名保**路径**解析；但 T2 删除的**生产公共导出**（`initRequestTelemetry`/`recordSettledRequest`/`shutdownRequestTelemetry`/`stopTelemetryBackgroundWork` 等）不再存在，而实测 ~21 个测试文件**直接调**它们 + test hooks——例如 `tests/routes/stats.http.test.ts:27-33`（`_setTelemetryDbForTests`/`_resetRequestTelemetryForTests`/`recordSettledRequest`）、`tests/telemetry/rollup-timer.unit.test.ts:30-34`（`initRequestTelemetry`/`shutdownRequestTelemetry`）、`tests/restart/telemetry-stop-on-phase1.unit.test.ts:3-9`（`stopTelemetryBackgroundWork` 幂等）。**终态选择（不再承诺「删 API + 零 churn」二者兼得）**：建包内**显式 `testing` entrypoint**（`@hsupu/ghc-proxy-telemetry/testing`，`packages/telemetry/src/testing.ts`）暴露 package-owned test runtime factory + 全部 test hooks；把这 ~21 个测试逐一迁到该入口（import 测试工厂/hook，而非生产 barrel）或迁到 runtime 实例。**这是真实 churn、不回避**——config 留 state 那部分（`setStateForTests({telemetry*})`）零改动，但直调 lifecycle/record 的那部分测试必须迁 `testing` 入口。**禁**保留无约束自由函数当兜底（违 T2 收敛目标）。
- **test-only hooks 全纳入隔离契约**：`_setTelemetryDbForTests` / `_getTelemetryDbForTests` / `_runRollupTickForTests` / `_isRollupTimerArmedForTests` / `_getEffectiveSketchGammaForTests` / `_getCumulativeCapKeysForTests` / `_setRequestTelemetryFilePathForTests` / `_resetRequestTelemetryForTests`——随包搬进 `testing` 入口、继续登记 RESETTERS/EXEMPT（L1 `resetters-complete` 守卫扫 `packages/*/src`，须核对）。加**「同一 runtime 被 production 与测试 accessor 共用」的正向测试**（不能只测 `peek/get` 的未安装语义）。
- **dimensions 劈裂的测试连带**：`tests/observability/telemetry-dimensions.unit.test.ts` + `history/p4c1`（import `TELEMETRY_DIMENSIONS`）+ `history/p4a` + `telemetry/cumulative-cap-authority`（import `CAPPED_DIMENSION_NAMES`）——劈裂后 name-registry 符号从包来、extractor 符号从 core 来。若两处 alias 都保留（`~/lib/observability/telemetry-dimensions` 保为 core extractor 文件 + 包内 name-registry 有独立路径），需**逐测试核对它 import 的是 name 还是 extractor**（正向控制：故意断言 `CAPPED_DIMENSION_NAMES` 来自包、`extractTelemetryKeys` 来自 core）。
- **正向隔离测试**：测试 A 开 telemetry 写若干桶、测试 B 断全复位（无残留 timer / 无跨测试 db handle 泄漏）；`peekTelemetryRuntime()` 未装配时 no-op（容忍腿正确）、`getTelemetryRuntime()` 未装配 fail-fast。

## 6. 闭合 commit DAG（每步同一 commit 内闭合、终态绿）

- **T0（前置 · 冷）foundation-hoist sqlite**：`sqlite/{driver,compression}` 上提 `packages/foundation/src/`（纯、非环成员、spec §3 已划定）；tsconfig path + 消费者（telemetry storage + history/v3）改 `@hsupu/ghc-proxy-foundation/*` 或经 transitional alias；foundation 边界守卫扫。**invariant**：foundation 零 core import；`test:backend` 绿；此步**利好 history**、非 telemetry 私有（可独立先 land）。
- **T1（seam）composition root 骨架**：建 `createTelemetryRuntime` + 全部注入端口 + 视图接口（纯新增文件、零撞行）；旧 `initRequestTelemetry`/`recordAccepted*`/`shutdownRequestTelemetry` **façade 委托** runtime（同 commit 不改消费者）。
- **T2（inject）收敛消费者 + config 注入**：**同一 commit** 把 §4 矩阵全部消费点收敛到 `get/peekTelemetryRuntime()`；registry 内 `state.telemetry*` 读改经 `deps.config`（**按 §3.1 逐字段生命周期——`sketchGamma` 走 DB-frozen 不进 live view**）、`onTelemetryConfigChange` 改经 `deps.configSubscription`；装配层（`start.ts`）构造 runtime 注入 live config 视图（getter over state）+ PATHS，**并保持 `init（listen 前）→ server listen → runJsonBackfill（listen 后）` 顺序**（评审 MAJOR-1）。**删 `initRequestTelemetry`/`recordAcceptedRequest`/`recordSettledRequest`/`shutdownRequestTelemetry`/`stopTelemetryBackgroundWork` 模块级公共导出**（escape hatch）→ 直调它们的 ~21 测试迁 package-owned `testing` 入口（§5）。ambient floor preload 装默认端口。**invariant**：registry 内零 `state` value import；backfill 接线 oracle 绿。
- **T3（module-split）dimensions 劈裂**：`telemetry-dimensions.ts` → name-registry 部分（`TELEMETRY_DIMENSION_SPECS`/`CAPPED_DIMENSION_NAMES`/`TELEMETRY_DIMENSION_NAMES`/`ThinkingBlockCounts`）移入待抽包区；extractor 部分（`extractTelemetryKeys`/`extractToolNames`/`normalizeClient`/`extractThinkingBlockCounts` + `.extract` 闭包）留 core、import 包的 name 表。registry + metrics-exposition + stats route 的 name-registry 引用改指包。sink 的 extractor 引用留 core。**invariant**：`request-telemetry` 不再 import `observability/telemetry-dimensions` 的任何 value；SCC ratchet 应见 `#35` 消失。
- **T4（`UsageData` 解耦）**：按 D4 裁决落地（推荐包内 `TelemetryUsage` 结构型），删 `request-telemetry.ts:9` 的 `./history/store` type import。**invariant**：SCC ratchet 应见 `#34` 消失。
- **T5（git mv）物理抽包**：`git mv src/lib/telemetry → packages/telemetry/src/telemetry` + `src/lib/request-telemetry.ts → packages/telemetry/src/request-telemetry.ts` + name-registry 文件；`package.json`（声明 `consola` + `@datadog/sketches-js` + `@hsupu/ghc-proxy-foundation`）+ tsconfig；transitional alias `~/lib/telemetry`+`~/lib/telemetry/*`+`~/lib/request-telemetry` → 包；包内 import 收敛相对、对 foundation 用包名。
  - **边界守卫**（复用 `package-boundaries.unit.test.ts` 手法）：扫 `packages/telemetry/src`，**拒所有 `~/`**、只许相对 + `@hsupu/ghc-proxy-foundation` + bare external（consola/`@datadog/sketches-js`）+ `node:`；**正样本对照**证 `~/lib/state` / `~/lib/config/paths` / `~/lib/observability/telemetry-dimensions` / `~/lib/history/store` / `@hsupu/ghc-proxy-core` 会被命中。ESLint 镜像同规则、全 import 形态（`from`/side-effect/dynamic/`require`，记忆技巧 7）。
  - **ratchet 重冻结**：T3/T4 削环后 `bun run scripts/update-circular-deps-baseline.ts` 重生 baseline（预期 73→70 环、63→61 成员，`request-telemetry.ts` + `observability/telemetry-dimensions.ts` 出 `members`），同 commit 提交。**先跑 ratchet 确认只减不增**再重冻结。
  - smoke：`bun run build:backend`（tsdown 内联 telemetry）+ bin `--help` + `GET /api/stats` / `/metrics` / `/api/status` 端点表面不变。

**DAG 说明**：T0 可独立先 land（利好 history）；T1→T2→T3→T4→T5 顺序依赖（seam→inject→split→type-decouple→mv）。T3/T4 是**削环的两步**，须实测 ratchet 变化（记忆 `plan-red-green-mutation-prediction-can-be-wrong-verify`——预测的环削减可能不咬，执行期真跑 madge 验证，不咬别提交假绿）。

## 7. 边界守卫 + ratchet（机器护栏）

- **包边界守卫（allowlist，非复用 token 的 core|server|cli denylist——评审 MINOR-4）**：`tests/architecture/package-boundaries.unit.test.ts` 加 `telemetryHasForbiddenImport`。**不复用 token detector 的 `SIBLING_CORE_SERVER_CLI` denylist**（它只拒 core/server/cli，会错误放行 `@hsupu/ghc-proxy-token` 等其他 sibling 包）。改 **allowlist**：只许 ① 相对 `./`/`../` ② `@hsupu/ghc-proxy-foundation`（含子路径）③ `node:` ④ 已声明 external（`consola`/`@datadog/sketches-js`）；**拒所有其他 `@hsupu/ghc-proxy-*`**（含 token）+ 所有 `~/`。正样本对照证 `~/lib/state` / `~/lib/config/paths` / `~/lib/observability/telemetry-dimensions` / `~/lib/history/store` / `@hsupu/ghc-proxy-core` / **`@hsupu/ghc-proxy-token`** 会被命中；反样本证 `@hsupu/ghc-proxy-foundation/ghc-http-primitives` / `./db` / `consola` / `@datadog/sketches-js` / `node:fs` 不被命中。ESLint 镜像同 allowlist、全 import 形态（`from`/side-effect/dynamic/`require`，记忆技巧 7）。package.json 断言 name/private + deps 含 `consola`+`@datadog/sketches-js`+`@hsupu/ghc-proxy-foundation`。
- **SCC ratchet**：`circular-deps-ratchet.unit.test.ts` 无需改逻辑（它只比 baseline）；**baseline 在 T5 重冻结**。预期削 `#34`/`#35`/`#36` 三环。**内容级验收（评审建议——防总数恰降但非预期三环消失的假阳性）**：除断言 `73→70` / `63→61` 数字外，加断言**新 baseline 的 `members` 不再含 `lib/request-telemetry.ts` 或旧 `lib/observability/telemetry-dimensions.ts`**（若这两个仍在 members，说明环只是被搬走没被打断）。**风险**：若实测发现它俩还卷在**别的**未列环里（本调研仅见这 3 条，madge 全跑为准），则削环数不足——执行期以 `computeCircularSnapshot()` 实测 diff 为准，别信本 plan 的预测数。
- **madge 计 type-only 边（已实测确认）**：`request-telemetry.ts:9 import type UsageData` 与 `telemetry-dimensions.ts:32 import type HistoryEntryData` 均为 type-only、却出现在 baseline `#34`/`#35`——证明 `circular-deps-snapshot.ts` 的 madge 配置**未设 `skipTypeImports`**、type-only 边照计环。**故 T4 的 `UsageData` 解耦是削 `#34` 的必要步**（不能只当「反正 type-only 无运行时环」略过）。

## 8. 风险 + 回滚

- **最危险 = T3 dimensions 劈裂**（唯一真 module-split）。缓解：先在 core 内把 name-registry 与 extractor 拆成两文件（同 commit 内、行为不变）、正样本证符号来源，再随 T5 把 name-registry 移入包。
- **T2 config 注入的热重载正确性**：`TelemetryConfigView` 必须是 **live getter over state**（非快照）——否则热重载改 `telemetryPersistInterval` 后 timer 不重调。测试：改 config → 断言 registry 读到新值 + timer 重调（复用现有 `rollup-timer` / `config-hot-reload` 测试）。
- **T0/T5 sqlite runtime 分流**（spec §9 陷阱 7）：`driver.ts` 靠 `typeof globalThis.Bun` 分流 `bun:sqlite`/`node:sqlite`、`neverBundle` external。迁 foundation 后**必跑真实 server（非 4141 端口）+ Node 双 runtime 冒烟**，不只信 typecheck。
- 隔离 worktree、每 commit 自足绿、可 `git revert`。

## 9. 决策记录（D1-D4 已裁定 · D5-D6 待执行期定）

1. **D1 范围 — ✅ 用户裁定 Option (b) 全域一包**（storage+registry+name-registry），而非 (a) storage-only（0 环削减）或 (c) 分两次。
2. **D2 sink/extractor 归属 — ✅ 留 core**（本 plan 前提，GPT reviewer 确认：塞包会拽 `context/types`/`observability/events`/`fetch-utils` 进 telemetry 依赖面、边界守卫必红）。
3. **D3 前置 foundation-hoist sqlite 时机 — ✅ 现在做**（主会话已实测 `history-cas-stage` worktree 无 `lib/sqlite` 未提交改动、master..分支无 `lib/sqlite` divergence → 无并发占用，collision-safe；一次性、利好 history）。执行 T0 前仍 `git log --oneline -5 -- src/lib/sqlite` + `git worktree list` 现场复核一次。
4. **D4 `UsageData` 归属 — ✅ 包内 `TelemetryUsage` 结构型**（GPT reviewer 确认 registry 仅结构读 `input_tokens`/`output_tokens`/`cache_read_input_tokens`/`cache_creation_input_tokens`/`output_tokens_details?.reasoning_tokens`，无 history value 依赖；sink 调用点加 TypeScript assignability 测试锁契约）。
5. **D5 dimensions name-registry 物理落点 — ⏳ 执行期定**：劈裂后 name-registry 是 `packages/telemetry/src/dimensions-registry.ts`（包内）、core extractor 保 `observability/telemetry-dimensions.ts` 引包。**执行 T3 前 grep `~backend` 确认** `TELEMETRY_DIMENSION_NAMES` 等是否被前端消费——若是则须进包 `types.ts` barrel + 改 `ui-v4` 两处别名（§4 类型 SSOT）。
6. **D6 与 spec §7.2 阶段 0d 的关系 — ⏳ 执行期对齐**：本 plan T2 的 config 注入即「telemetry 消费端从 `import { state }` 迁窄接口」——**吸收/替代** spec 阶段 0d 的 telemetry-state 迁移。定稿后同步 spec §7.2 口径（把 telemetry-0d 标为「经本 telemetry peel T2 落地」），避免双 SoT 叙事。

---

**Self-Review**：3 层依赖全 grep 实测带 file:line ✓；`decompressBytes` 溯源解 mask（`sqlite/compression.ts`、纯、foundation-able）✓；中心分叉三选项量化（环削减 0 vs 3 vs 分摊）+ 用户裁定 (b) ✓；与 token 差异点名（无 SoT 反转 + 有 module-split）✓；composition root 覆盖唯一构造点 + **post-listen backfill 生命周期** + peek/get 分层 + ambient floor ✓；**config 逐字段生命周期分类（sketchGamma DB-frozen）** ✓；测试隔离契约（config 留 state 零 churn + **直调 API 的 ~21 测试迁 package-owned `testing` 入口**）✓；闭合 DAG T0-T5 + ratchet 重冻结（**内容级验收**）+ type-only 计环实测 ✓；**边界守卫 allowlist 正反控制** ✓；决策 D1-D4 已裁、D5-D6 执行期定 ✓。**GPT 异模型评审 3 MAJOR + 2 MINOR + 3 建议已全折入**（评审折入摘要见头部）。**执行前必做的未验证项**：madge 全跑确认仅 #34/#35/#36 三环含 telemetry（本 plan 预测数不自证）、`~backend` 消费的 telemetry 类型清单、`history-cas-stage` 是否并发占用 `lib/sqlite` 现场复核。

## 提示词

```
继续 telemetry 域抽包 @hsupu/ghc-proxy-telemetry 的执行（T1–T5）。工作在隔离 worktree
.worktrees/telemetry-peel 分支 feat/telemetry-package（T0 已 landed：sqlite/{driver,compression}
上提 foundation）。权威 plan = docs/plan/monorepo-split/plan-telemetry-package.md（自足规格：§6
闭合 commit DAG、评审 3 MAJOR+2 MINOR 已折入、逐字段 config 生命周期表在 §3.1）。

【起步前必做——并发重叠，别跳】
1. 先把当前 master merge 进本分支（peer 的 max_tokens continuation 特性活跃，commit 4652090b
   改过 telemetry-dimensions.ts＝我 T3 的劈裂目标）：`git merge master`，解冲突、typecheck+
   test:backend 绿。
2. 重跑 madge 确认削环目标仍是 baseline #34/#35/#36（`request-telemetry.ts`＋
   `observability/telemetry-dimensions.ts` 出 members）：读 tests/architecture/circular-deps-baseline.json，
   用 computeCircularSnapshot() 实测 diff 为准，别信 plan 预测数（记忆
   plan-red-green-mutation-prediction-can-be-wrong-verify）。
3. 重核 telemetry-dimensions.ts 现状（peer 加了 max_tokens 维度）——name/extractor 劈裂归属
   可能变，逐个确认 name-registry（entry/ctx-free→入包）vs extractor（读 entry/ctx→留 core）。
4. D5 坐实：ui-v4/src/types/status.ts import `~backend/lib/request-telemetry`——T5 git mv 后须同步
   ui-v4 别名（vite.config + tsconfig）+ 包出 types.ts 纯类型 barrel，build:ui-v4+typecheck:ui-v4 双验。

【闭合 commit DAG（每步同一 commit 内闭合、终态 typecheck+test:backend 绿+精确 pathspec lint）】
T1 seam：createTelemetryRuntime 骨架 + 注入端口(TelemetryPaths/TelemetryConfigView/
  TelemetryConfigSubscription)+ TelemetryRuntime 接口(含 runJsonBackfill 五阶段 §3.2)；旧
  initRequestTelemetry/recordAccepted*/shutdownRequestTelemetry 等 façade 委托单一 runtime，不改消费者。
T2 inject（承重）：收敛 §4 全消费者到 get/peekTelemetryRuntime；registry 内 state.telemetry* 读改
  deps.config——但按 §3.1 逐字段：enabled/persistInterval/rollupInterval 走 configSubscription 重调
  timer、cardinality/cumulative/retention 走 next-record live read、**sketchGamma 走 DB-frozen
  effectiveSketchGamma（runtime 私有、不进 live view，否则坏 DDSketch）**、dbPath init-only；装配层
  start.ts 保 init(listen 前)→listen→runJsonBackfill(listen 后) 顺序；删模块级导出 →直调它们的 ~21
  测试迁 package-owned testing 入口(@hsupu/ghc-proxy-telemetry/testing)；ambient config floor preload。
T3 dimensions 劈裂：先在 core 内把 name-registry 与 extractor 拆两文件（同 commit、行为不变、正样本证
  符号来源）验证 #35 可消，再随 T5 把 name-registry 移入包；core extractor 反向 import 包 name 表（合法单向边）。
T4 UsageData 解耦：包内 TelemetryUsage 结构型替 request-telemetry.ts:9 的 history/store type import，削 #34。
T5 git mv：src/lib/telemetry+request-telemetry+name-registry → packages/telemetry/src；package.json
  声明 consola+@datadog/sketches-js+@hsupu/ghc-proxy-foundation；tsconfig transition alias；边界守卫用
  **allowlist**（只许 relative+foundation+node:+已声明 external，拒所有其他 @hsupu/*含 token，正样本对照
  加 @hsupu/ghc-proxy-token）+ ESLint 全 import 形态镜像；ratchet 重冻结（先跑确认只减不增+内容级断言
  members 不再含那俩文件，再 bun run scripts/update-circular-deps-baseline.ts）；ui-v4 ~backend 别名；
  build:backend + bin --help + /api/stats //metrics //api/status 端点表面不变 smoke。

【判据 + 纪律】长远正确+完整>省事，禁 ROI/YAGNI 砍范围；承重 invariant=包对 core 零依赖(机器守卫)+
无双 SoT+行为逐字节不变。执行技巧记忆 methodology-domain-peel-execution-techniques（setStateForTests
config 留 state 零 churn、ambient floor、peek/get 分层、foundation 裸包名需 tsconfig path）。收尾走
session-closeout 五步。文档定稿先合 master 再执行（CLAUDE.md docs-merge-before-execute）。
```
