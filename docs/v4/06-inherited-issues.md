# 06 — 继承问题台账（docs/audits 吸收）

把 `docs/audits/` 的历史审查发现吸收进 v4 视野的统一台账。

**来源**：[`archive/non-ws-module-audit-2026-06-03.md`](./archive/non-ws-module-audit-2026-06-03.md)（非 WS 审查）+ [`archive/deferred-engineering-items-2026-06-03.md`](./archive/deferred-engineering-items-2026-06-03.md)（DI-1~14），均为 **2026-06-03**；已被本台账全盘吸收后移入 `archive/` 归档。
**复核**：2026-06-16 经 5 路 subagent **实测当前代码**逐项核对（不信旧 file:line），结论如下。原 audit 文档保留为历史归档，本台账是其活跃续档。

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

## 处置落地

- **A 类（DI-3/2/10/9/14）**：已在本台账标注 v4 阶段落点。实施对应 P 阶段时，prompts/ 提示词应引用本台账相应项（P1 → DI-10；P2.2/2.4 → DI-9/DI-8；P2.6 → DI-14；P2 各格式 → DI-3/2）。
- **B 类（DI-8）**：作为 P2.3/2.4 的 invariant 补充。
- **DI-5**：方案已定（append-only recovery log，见上），升级为优先独立 backlog，可独立于 v4 实施。
- **C 类（DI-4/7/13/1）**：v4 外独立维护，**继续保留完整上下文**于 [`archive/deferred-engineering-items-2026-06-03.md`](./archive/deferred-engineering-items-2026-06-03.md)（用户定夺：留文档，不单独排期）。
- **原 audits 文档**：已全盘吸收，移入 `archive/` 归档，头部加指针指向本台账。

---

## 已定决策（2026-06-16）

1. **DI-5** → append-only recovery log（见上方方案），entry 不再永久丢失；优先独立 backlog。
2. **C 类（DI-4/7/13/1）** → 留在 [`archive/deferred-engineering-items-2026-06-03.md`](./archive/deferred-engineering-items-2026-06-03.md)，不单独排期，继续作为暂缓决策上下文。
