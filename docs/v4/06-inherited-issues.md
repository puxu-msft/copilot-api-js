# 06 — 继承问题台账（docs/audits 吸收）

把 `docs/audits/` 的历史审查发现吸收进 v4 视野的统一台账。

**来源**：[`archive/non-ws-module-audit-2026-06-03.md`](./archive/non-ws-module-audit-2026-06-03.md)（非 WS 审查）+ [`archive/deferred-engineering-items-2026-06-03.md`](./archive/deferred-engineering-items-2026-06-03.md)（DI-1~14），均为 **2026-06-03**；已被本台账全盘吸收后移入 `archive/` 归档。
**复核**：2026-06-16 经 5 路 subagent **实测当前代码**逐项核对（不信旧 file:line），结论如下（"真实未决"表的"复核结论/v4 落点"列即此轮，属 v4 **实施前的预期**）。
**v4 后落地核对**：2026-07-21 v4 P0-P3 + Stage A/B 全部完成后，主线自查当前代码，把 A/B 类"预期 v4 会解决"裁决成实测状态——见下方「v4 后落地核对」段。原 audit 文档保留为历史归档，本台账是其活跃续档。

---

## 复核汇总

| 类别 | 数量 | 项 |
|---|---|---|
| ✅ 已修（闭合） | 12 | H4 · DI-6 · M1 · L2 · H3 · M5 · M4 · M7 · M8 · M6 · L1 · M3 |
| ⏳ 已过时（闭合） | 2 | DI-11 · DI-12 |
| 🔴 真实未决 | 8 | DI-3(+M2) · DI-2 · DI-10 · DI-9 · DI-14 · DI-8 · DI-5 · DI-4 · DI-7/M9 · DI-13 |

> 注：真实未决项 8 个语义簇（M2 并入 DI-3；M9=DI-7）。

---

## ✅ 已闭合（已修，带实测证据）

| 项 | 内容 | 修复证据（当前 file:line） |
|---|---|---|
| H4 | mark…Unsupported 依赖缓存重读的隐式耦合 | 改用 PrepareHints 显式传递：`unsupported-beta-retry.ts:153,176`、`context-management-retry.ts:115`，消费 `request-preparation.ts:113,135,172` |
| DI-6 | wire-mutate 泄漏回 payload | `request-preparation.ts:216` `DEEP_CLONE_FIELDS` + `:221` structuredClone，wire 完全隔离 |
| M1 | complete() 就地改写 caller response | `context/request.ts:397` spread 新对象 |
| L2 | pipeline 非 Error 包成 "Unknown error" | `pipeline.ts:390` `safeStringifyUnknown` |
| H3 | rate-limiter recovering 并发竞态 | `adaptive-rate-limiter.ts:258` leaky-bucket 槽位预约 + 回归测试 `rate-limiter.unit.test.ts:426` |
| M5 | sqlite sessions double-count | `sqlite/write.ts:73` recompute-from-entries + 回归测试 `write-read.unit.test.ts:184` |
| M4 | preview/search 每 update 重算 | `in-flight.ts:9` WeakMap memo |
| M7 | 空 assistant turn 丢失 | `cc-to-responses.ts:177` 注入占位+warn |
| M8 | 全空消息删不掉 | `sanitize.ts:44` 返回 null 整条删 |
| M6 | tool_call_id 缺失默默空串 | `cc-to-responses.ts:205` 抛 HTTPError 400 |
| L1 | ensureOpenAIStartsWithUser 死代码 | 已接线 `sanitize.ts:145` |
| M3 | 事件监听器静默吞错 | `observability/bus.ts:112` consola.warn |

## ⏳ 已闭合（过时，模块已变）

| 项 | 内容 | 过时原因 |
|---|---|---|
| DI-11 | TUI 漏传 reasoning_tokens | `consumers.ts`/`lib/tui` 已删，ConsoleSink 取代且不显示 token usage；reasoning_tokens 经 HistorySink 完整透传——旧路径整体消失 |
| DI-12 | resolver chained alias + family fallback 反直觉跳转 | family-level fallback 已**整体移除**（`resolver.ts:236` "No family-level propagation"）；链式 override 已有 `visited` 防环（`:255`） |

---

## 🔴 真实未决 — 按与 v4 的关系分类

### A 类：v4 直接解决/吸收（实施 v4 时自然消除或顺带统一）

| 项 | 复核结论 | v4 落点 | 处置 |
|---|---|---|---|
| **DI-3 (+M2)** | **仍在**：messages/cc/responses handler 仍 in-place mutate `payload.model/.system/.messages`（`messages/handler.ts:158,164,225` 等），靠入口 `structuredClone` 快照缓解（M2 脏快照隐患已闭合，但 mutate 写法仍在） | **v4 S1-S3 核心**（`01-architecture` §2）。DI-3 的"理想架构"`pipe(resolveModel, processSystem, preprocessMessages)`≈ v4 stage 链 | **写入 P2 各格式迁移目标**：codec.parse + S1-S3 用 immutable transform 替代 in-place mutate；完成后 structuredClone snapshot 可删 |
| **DI-2** | **仍在**：4+ handler 入口无条件 `structuredClone`（`messages/handler.ts:150` 等），无性能基线（vision 4-20MB） | 与 DI-3 联动——v4 immutable transform 后 inbound 快照可能不再需要无条件 clone（DI-3 称"snapshot 不再需要"） | **随 DI-3**：v4 S1 改 immutable 后，评估能否去掉无条件 clone；补 vision payload 性能基线测试 |
| **DI-10** | **部分修/仍在**：sanitize（删空消息）与 cc-to-responses（保 turn）哲学已收敛但分属不同管线，**跨路径无统一契约**（sanitize 仅 CC 路径、Responses 不经它） | v4 **改写 registry 化**（P1）+ codec 化（P2）统一空消息策略 | **写入 P1**：注册空消息 transform 时定一个原则（保留 turn vs 删除），跨格式一致 |
| **DI-9** | **仍在**：cc-to-responses 缺 tool_call_id 抛 400 但**无 message index**（`cc-to-responses.ts:205`，`convertToolMessage` 不接 index） | v4 **codec 化**（P2.2/2.4）翻译层重组 | **写入 P2.2/2.4**：codec 翻译时给错误带 message index |
| **DI-14** | **仍在**：message-mapping 仍用前 100 字符 prefix fingerprint（`message-mapping.ts:23`），prefix 相同消息 false-positive；fallback 语义已变（-1→lastMatched） | v4 **Anthropic codec**（P2.6）触及 message-mapping | **写入 P2.6**：改 hash/完整比对 |

### B 类：v4 触及可顺带（迁移时补测试/小修）

| 项 | 复核结论 | v4 落点 | 处置 |
|---|---|---|---|
| **DI-8** | **部分修**：Azure channel + HTTP 测试存在，但**未断言 originalRequest.model==原值**（channel 设计核心语义），且 **responses 路径无测试覆盖** | v4 **P2.3/2.4** 迁 CC/Responses 时验证 Azure 注入 | **写入 P2.3/2.4 invariant**：补 Azure 端到端测试断言双轨 model（原始 vs deployment）+ responses 路径覆盖 |

### C 类：与 v4 正交（独立 backlog，v4 不碰 history/context 核心）

| 项 | 复核结论 | 处置 |
|---|---|---|
| **DI-5** | **仍在**：finalizeEntry 持久化失败仍 `warn`+`removeInFlight`（entry 永久丢失），warn 缺 id/endpoint/model 上下文（`entries.ts:139`） | ✅ **方案已定**（append-only recovery log，见下方「DI-5 已定方案」）——升级为优先独立 backlog |
| **DI-4** | **部分修**：finalizeEntry docstring 有动机但未显式声明幂等契约（`entries.ts:105`） | **独立 backlog**（小）：docstring 显式声明幂等 + 双调用/不存在 id 测试 |
| **DI-7/M9** | **部分修**：reaper 间隔已派生 clamp（`manager.ts:157` `computeReaperIntervalMs`）但**未 export、无边界单测** | **独立 backlog**（小）：export + 派生公式/clamp 边界单测 |
| **DI-13** | **仍在**：in-flight 模块级单例 Map + WeakMap memo，`clearInFlight` 不清 WeakMap、无 `clearSummaryTextCache`（`in-flight.ts:7,21,58`） | **独立 backlog**：显式 cache-clear API 或 factory 注入（测试隔离） |

> DI-1（HistoryEntry DeepReadonly 类型保护）未单独复核，与 DI-3 同源（类型层不可变）；v4 envelope 不可变约定（`03-spec/envelope-driver.md` §1）部分覆盖，但未强制 DeepReadonly——归 C 类独立 backlog。

### DI-5 已定方案 — 持久化失败的 append-only 恢复（用户 2026-06-16 定夺）

**何时 sqlite 写失败**（finalizeEntry → insertCompletedEntry 抛错）：
- 磁盘满 ENOSPC
- SQLite 锁争用 / BUSY（bun:sqlite 虽串行，WAL / 外部进程占用仍可触发）
- 数据库损坏 SQLITE_CORRUPT
- 权限 / 底层 I/O 错误（EACCES / 磁盘故障）
- 进程在 finalize 中途被 kill（此类靠 sqlite reaper 的 pending→interrupted 回收兜底，append-only 不覆盖）

**方案**：
1. insert 失败 → `consola.warn` 补 **id / endpoint / model / error** 上下文（补足现状 warn 缺上下文的缺口）
2. 把该 entry **append 到 append-only 恢复文件**（NDJSON，每行一条完整 `HistoryEntryData`，原子 append）
3. **仍 `removeInFlight`**（防内存无界堆积）
4. 程序**启动时**（`sqlite/connection.ts` 初始化后）读恢复文件，逐条 `insertCompletedEntry` 注入 sqlite；全部成功后截断 / 删除恢复文件，部分失败的保留待下次

**效果**：entry 不再永久丢失（磁盘临时故障 / 崩溃后可恢复），且内存不堆积。可复用 `src/lib/atomic-fs.ts` 或新增 `appendNdjson` 工具。
**归类**：C 类（history 层，v4 正交），但方案已定 + 用户主动提出 → **优先独立 backlog**，可独立于 v4 实施。
**若做需改什么**：`history/entries.ts:finalizeEntry`（catch 分支：warn 补上下文 + append）、`sqlite/connection.ts`（启动注入 + 截断）、新增恢复文件路径（`config/paths.ts`）、append 工具（`atomic-fs.ts`）。

---

## v4 后落地核对（2026-07-21，主线自查当前代码）

v4 P0-P3 + Stage A/B 全部完成后，逐项实测 A/B 类"预期 v4 会解决"的真实状态。**总纲结论**：只有 DI-3 的症状随 v4 架构消除；DI-2/9/10/14 **未解决**、DI-8 **仍部分**——因为 v4 迁移的**字节等价铁律**（每 commit golden 逐字节等价）恰好把"改客户端可观测行为"的项挡在门外（改错误信息/消息结构/映射结果都不是等价重构，迁移期故意不碰）。印证 [[feedback-pass-null-clean-not-self-validating]]：预期≠已解决。

| 项 | v4 后实测裁决 | 证据（当前 file:line） |
|---|---|---|
| **DI-3** | ⚠️ **症状闭合、理想架构未达成**：in-place mutate 已消除（全 src 无 `payload.model/.system/.messages=` 赋值；codec.parse 用 `{ ...incoming, model }` 不可变构造）；但手段是 **clone-based 隔离**非 immutable-transform——各 codec 仍 `structuredClone(clientBody)` 做 originalSnapshot、driver 还新增 per-stage envelope clone。DI-3 原文"完成后 snapshot 可删"**未达成**（snapshot 保留供 history 原始快照） | `codec/anthropic/codec.ts:396,408`（4 codec 同构）、`driver.ts:391`、`pipeline/types.ts:714` |
| **DI-2** | ❌ **未解决、反加重**：无条件 clone 未随 immutable 消除，driver 每 stage clone envelope body + 各 codec parse 无条件 clone；仍无 vision（4-20MB）性能基线 | `driver.ts:391,511`、各 codec `parse` |
| **DI-10** | ❌ **仍未统一**：`sanitize.ts:48,83` 走"删除"（`return null`）、cc-to-responses 走"注入占位保 turn"；Stage A registry 化未统一这两哲学（各在各路径） | `openai/sanitize.ts:48,83` vs `cc-to-responses.ts:190` |
| **DI-9** | ❌ **未解决**：cc-to-responses 缺 tool_call_id 抛 400 仍无 message index | `cc-to-responses.ts:216-224` |
| **DI-14** | ❌ **未解决**：message-mapping 仍 `slice(0,100)` prefix 比较；模块还在 `anthropic/` 老位置（P2.6 未迁进 codec） | `anthropic/message-mapping.ts:20` |
| **DI-8** | ⚠️ **部分**：Azure deployment→model 注入 / URL override / 400 端点已测，但**仍未断言 history 双轨**（originalRequest.model==body 原值 vs effective==deployment），且**无 responses 路径覆盖** | `tests/openai/azure-openai-compat.http.test.ts:140,160,188`（仅 chat+embeddings） |

**v4 后处置**（据实测重新归类，均不再依赖 v4）：
- **DI-3** → 症状闭合，"snapshot 可删/immutable-transform 彻底化"降为**可选优化**（做了连带 DI-2）；非 bug、不紧急。
- **DI-2/9/10/14** → v4 没碰，**转独立 backlog**：都是脱离等价约束后可单独做的小改进（DI-9 错误带 index、DI-14 改 hash/全比对、DI-10 定统一空消息契约、DI-2 性能基线 + 评估 driver per-stage clone 开销）。
- **DI-8** → **小测试任务**：补 Azure history 双轨 model 断言 + responses 路径覆盖。

### 本轮清理（2026-07-21，commit `c3fd9867` + 核对）

修完后独立 backlog 收窄：
- **DI-9** ✅ **修**：cc-to-responses 缺 tool_call_id 的 400 带 conversation index + 内容摘要；该分支此前**零测试覆盖**，补 TDD。
- **DI-7** ✅ **修**：`computeReaperIntervalMs` 从 manager 闭包提为模块级参数化纯函数（导出 MIN/MAX 常量）+ 边界单测（/3 公式、两 clamp 边缘、disabled→MAX）。
- **DI-13** ✅ **修**：`clearInFlight` 一并重置 `summaryTextCache` WeakMap（`let` 化），测试隔离显式确定。
- **DI-4** ✅ **被 History V3 顺带解决**（核对发现）：`finalizeEntry` 已不存在，被 `v3/store.ts:604 commitPreparedOperation` 取代——它显式返回 `"inserted" | "idempotent"`（内容寻址 revision+digest 比对），正是 DI-4 想要的**判别式幂等契约**，比原建议更强。又一个"预期≠实测"的正向例（V3 重构顺带闭合了它）。

**剩余 backlog 决策（2026-07-21，用户拍板）**：
- **DI-8** ✅ **补测**（commit `e97f535f`）：codec.parse 下 originalRequest.model=URL deployment（Azure 权威）+ body 原值保留在 payload snapshot（richest-data-flow 满足，**疑点证伪、非 bug**）；responses codec parse 同构（`openai-responses/codec.ts:422`），冗余不另测。
- **DI-5** ▶ **做**（进行中）：唯一"真实缺陷+方案就绪"三合一——持久化失败 entry 永久丢失、方案已定（append-only NDJSON + 启动重放）；用户要求**加相关配置项**。
- **DI-10** ▶ **做**（进行中）：用户方向 = **空消息 sanitize 移入 hook、由配置决定**（不硬编码删/保 turn），统一两管线哲学。
- **DI-2** ⏸ 长期最优的观测前提：先加 vision payload（4-20MB）clone 性能基线，**数据证实是热点再优化**。
- **DI-3** ⏸ **绑定 DI-2 之后**：immutable-transform 能省 driver per-stage clone（`driver.ts:391`），但 history originalSnapshot clone 是 richest-data-flow 硬需求省不掉；性能收益幅度未知、待 DI-2 基线数据，别盲目优化。
- **DI-14** ⏹ **闭合·不修（刻意设计）**：prefix fingerprint 是刻意启发式（sanitize 改内容→完整比较反 false-negative）、仅诊断映射、错时安全 fallback；改 hash 收益极小还可能引 false-negative。
- **DI-1** ⏹ **闭合·不修（锦上添花）**：clone 隔离已缓解 mutate 症状，DeepReadonly 成本高（几十处 cast 失败）收益低。

---

（下方为历史，2026-07-21 前）

**剩余 backlog**（需决策或较大工程）：
- **DI-14**：prefix fingerprint 是**刻意启发式**（sanitize 会改内容，完整比较反而 false-negative），且仅用于 history 诊断映射（错时 fallback，低危）——不能反射式改，需先懂 buildMessageMapping 消费者再定。
- **DI-10**：空消息"删除 vs 保 turn"两哲学统一——**改客户端可观测行为**，需用户定夺方向。
- **DI-8**：深入发现可能牵出 **richest-data-flow 缺陷**——Azure 下 `codec.parse` 用 `raw.modelOverride ?? incoming.model`，`originalRequest.model` 可能记 deployment 而非客户端 body 原值（丢原始信息），待核实；若属实则超出"补测试"，是真 bug。
- **DI-2 / DI-3 / DI-5**：较大工程（clone 优化 / immutable-transform 彻底化 / recovery log），非紧急 bug。

---

## 处置落地

> ⚠️ **下列为 v4 实施前（2026-06-16）的规划语气；v4 已完成，A/B 类实测落地见上方「v4 后落地核对」——DI-3 症状闭合、DI-2/9/10/14 未随 v4 解决 + DI-8 仍部分、均转独立 backlog。**

- **A 类（DI-3/2/10/9/14）**：（v4 前规划）已在本台账标注 v4 阶段落点。实施对应 P 阶段时，prompts/ 提示词应引用本台账相应项（P1 → DI-10；P2.2/2.4 → DI-9/DI-8；P2.6 → DI-14；P2 各格式 → DI-3/2）。
- **B 类（DI-8）**：作为 P2.3/2.4 的 invariant 补充。
- **DI-5**：方案已定（append-only recovery log，见上），升级为优先独立 backlog，可独立于 v4 实施。
- **C 类（DI-4/7/13/1）**：v4 外独立维护，**继续保留完整上下文**于 [`archive/deferred-engineering-items-2026-06-03.md`](./archive/deferred-engineering-items-2026-06-03.md)（用户定夺：留文档，不单独排期）。
- **原 audits 文档**：已全盘吸收，移入 `archive/` 归档，头部加指针指向本台账。

---

## 已定决策（2026-06-16）

1. **DI-5** → append-only recovery log（见上方方案），entry 不再永久丢失；优先独立 backlog。
2. **C 类（DI-4/7/13/1）** → 留在 [`archive/deferred-engineering-items-2026-06-03.md`](./archive/deferred-engineering-items-2026-06-03.md)，不单独排期，继续作为暂缓决策上下文。

---

## DI-5 实施落地 + 对抗审查（2026-07-22）

**实测收敛**：原方案「独立 append-only NDJSON recovery log」经亲核代码**被推翻为过度设计**——V3 写路径本身是 journal-first（`commitPreparedOperation`：tx 外 `INSERT OR REPLACE` self-contained v3_journal 行、tx 内写 operations 并 DELETE journal；`recoverV3Journal` 启动重放），已覆盖 tx 失败/崩溃。**真 gap** = `runDrain` 对 persist-guard 已分类的 `transient`（WAL BUSY/LOCKED/IOERR）无条件丢弃 entry、不 retry。

**已实施**（commit `5c164f0e`）：`runWithTransientRetry`（transient→线性退避有界重试，permanent/conflict 不重试，maxAttempts 软上限）+ config `history.persist_retry {max_attempts,backoff_ms}`。全套 TDD：纯 helper unit + end-to-end drain（正样本对照 maxAttempts=1 证掉 entry）+ persist-guard-wiring 真 SQLite trigger + config wiring。DI-5 台账状态 → **transient-retry 已修**（原 NDJSON 方案作废）。

**GPT 对抗审查结论**（`gpt-souls:reviewer`，主线批判复核）：
- 幂等 **OK**（tx 回滚 + INSERT OR REPLACE，重试不双写，实测验证）。
- 测试真伪 **无假绿**（正样本对照 + 真 trigger 双手法，injector 生产 null 无泄漏）。
- **MEDIUM（待修，交接）**：`max_attempts/backoff_ms` 无**总耗时上限**（schema 仅非负校验），配合 shutdown drain 无 signal（避 store→shutdown→state 循环）设计，极端配置（如 max_attempts=100/backoff=1000）可让 `drainV3Writer` 卡到分钟级。修法：drain 侧加独立总耗时软 timeout（不引入 shutdown 依赖）。
- **HIGH（既有 bug，非 DI-5 引入，但动摇本 commit 论证前提）**：`recoverV3Journal` 反序列化的 record 丢失了 `attempts` 非枚举 getter（`store.ts:1228` JSON.parse 后未过 `withDispatchAlias`）→ `prepareModelOperation`→`projection.ts:201/246` 读 `record.attempts`/`.length` 抛错 → **recovery 恒返回 0**。即"journal-first 已兜底 tx/崩溃失败"这个 DI-5 论证前提**当前不成立**（journal recovery 本身坏了）。交叉验证：`tests/history/v3/store.it.test.ts:311`「recovers a self-contained uncommitted journal」+「keeps newly imported」两测当前红，5c164f0e 与父 commit 均红 = 早于 DI-5。**修法**：`recoverV3Journal` 反序列化后过 `withDispatchAlias` 补回 attempts 别名再传 `prepareModelOperation`；并更正 5c164f0e commit message 的"journal-first 已覆盖"断言（应加"前提是 recovery bug 先修"）。

**转交接的两项**（原会话不继续——工作区被并发 stash 误 apply 污染、且上下文已满）：
1. **DI-5-followup-1（HIGH）** journal recovery `withDispatchAlias` 修复 + store.it 两红测转绿——**这是先决**，修好 DI-5 的"journal-first 兜底"前提才真成立。
2. **DI-5-followup-2（MEDIUM）** drain retry 总耗时软上限（防极端配置 shutdown wedge）。

### 两 followup 落地（2026-07-22，续接会话）

两项均已实现，全套 TDD，`bun run typecheck` 绿、history+config 全套件 1238 pass/0 fail。

- **followup-1（HIGH）✅ 修**（commit `e75db9bb`）——**根因判定修正**：交接 kickoff 建议"在 `recoverV3Journal` 反序列化后过 `withDispatchAlias`"，亲核后判定**不完整**。真根因在消费端 `projection.ts:246` 读被弃用的**非枚举别名** `record.attempts.length`，而同函数兄弟行（`:201`/`:248`）早已读规范字段 `record.dispatches`。关键反证：第二个红测「keeps newly imported records」（`store.it.test.ts:136-148`）直接 `prepareModelOperation(JSON.parse(...))`、**根本不经过 `recoverV3Journal`**，故 recovery-only 修法救不了它。改 `projection.ts:246` → `record.dispatches.length`（规范字段，跨 JSON round-trip 存活；对活的带别名 record 值等价，因 `attempts` getter 即返回 `dispatches`）**同时**修好两个红测。全仓 grep 确认 `projection.ts:246` 是唯一 reachable 的"读 record 的 `attempts` 别名"站点（`entry-view.ts`/`recovery.ts` 读的是 `HistoryEntry.attempts` 真实数组字段、不同类型、合法）。→ 教训同 [[methodology-broken-reference-supply-vs-delete]] / [[feedback-fix-all-comparison-sites]]：修消费端根因、别只补一个调用点。
  - **对 `5c164f0e` commit message 的更正**：其"journal-first 已覆盖 tx/崩溃失败"断言的**前提**（`recoverV3Journal` 能正常重放）此前不成立——recovery 因 `projection.ts:246` 读别名恒抛错、返回 0。followup-1 修好后该前提才真成立。DI-5 论证链现完整。
- **followup-2（MEDIUM）✅ 修**（commit `07302136` + `e9da3ec0`）：`runWithTransientRetry` 加 `maxTotalMs` **墙钟总耗时**软上限——经异模型 reviewer MINOR 指正后从"名义 backoff 累计"改为**真实墙钟**（`now()` clock seam，默认 `Date.now`、测试注入确定性计数器），**计入每次 `attempt()` 自身阻塞**（SQLite `busy_timeout` 等待才是真实 wedge 主体，名义值看不见）+ 预测下一次 backoff。封住线性退避和的平方增长（`backoffMs·n(n-1)/2`），极端 config（max_attempts=100/backoff=1000）或慢 attempt 不再能把 drain→shutdown 拖到分钟级。**无 shutdown 依赖**（不碰 store→shutdown→state 循环）。加 `TransientRetryOutcome.capReason`（`max-attempts`|`max-total-ms`）经 drain 的 `lastError` 透出，可观测哪个 cap 丢的 entry。config `history.persist_retry.max_total_ms`（默认 30000，`0`=关闭）。TDD：慢-attempt 用例证 attempt 阻塞计入（名义证不了）+ frozen-clock 证预测项 + 正样本对照 + 0-关闭 + 次数 cap 更紧时胜出（均断 capReason）；it 端到端边界安全（max_total_ms=2500 vs backoff 1000）证 maxTotalMs 触达 drain + `lastError` 带 `max-total-ms`。

DI-5 台账状态 → **完成**（transient-retry + journal-recovery 前提 + drain 总耗时上限三者齐备）。

→ 自包含 kickoff：[docs/plan/2026-07-22-di5-journal-recovery-and-retry-cap-kickoff.md](../plan/2026-07-22-di5-journal-recovery-and-retry-cap-kickoff.md)（现状锚点 + 根因亲核 + 修法 + 验收 + 先决顺序）。
