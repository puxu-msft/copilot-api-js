# History 数据模型重构 —— 实施计划导航（README）

> 三层文档结构（large-refactor §5）：**design**=[RFC](../../rfc/2026-07-07-history-data-model-restructure.md)（WHY + 契约）· **plan**=[plan.md](plan.md)（HOW + 锚点 + TDD）· **prompts**=[prompts/](prompts/)（可粘给独立实现者的 per-phase kick-off）。

把 history 记录的 `inbound/outbound/wire/effective` 命名坐标系重构为 **client/upstream 双腿 + 逐 attempt 上游轨**，分离两条正交轴（attempt 成败 / entry 客户端结局），`clientResponse` 提为一等公民。目标结构见 RFC §3。

## Phase 导航 + 依赖 DAG

| Phase | 交付物 | 前置 | 可并行 |
|---|---|---|---|
| **P0** golden 预捕获 | 在**旧代码**上锁 `assembleFullEntry` 输出 + `EntryRow` 列 + `rewrites-req` 索引快照 | — | 独立、最先做 |
| **P1** 新 type 并存 | RFC §3 全字段 type，旧字段留 deprecated 别名 | P0 | — |
| **P2** serialize/assemble 新 stage 语义 | 上游帧统一进 attempt、clientResponse 独立 stage、success/trailers/rawBody/format/messages 投影落 stage | P1 | — |
| **P2.5** 生产者对齐（**承重、严格串行**） | `fail()`/`abort()` → `setAttemptResponse`（final settled attempt 恒载裁决）+ sink 双写方对齐 | P2 | 不可与 P2.6 并行 |
| **P2.6** consumer re-point | `buildHeadRow`/`deriveBytes`/`toHistoryEntry` 重指向 `attempts[final]` | **P2.5** | 不可提前于 P2.5 |
| **P3** clientResponse 捕获 | `clientResponse.status`/`body` 显式捕获（transport/route 层新捕获点） | P1 | **共享 `request.ts`（新 setter）与 P2.5/P2.6**——非「不同文件」，见下红线 |
| **P4** 消费者迁移 + 删旧顶层 | 迁 62 文件消费者（含 search-index rewrites-req）、删顶层 leg + 投影逻辑 | P2.6 + P3 | 格式独立的消费者组可并行 |
| **P5** doc-sync + golden 回归 | DESIGN.md 类型架构 + history.md + skill 同步；P0 golden 全绿 | P4 | 收尾 |

**红线 DAG**：`P2.5 → P2.6` 是**字节等价严格串行**——RFC §6 invariant ②（`EntryRow` 序列化前后逐列等价）在生产者对齐前对失败/中止条目必破，**绝不可把 P2.6 提到 P2.5 前、或二者并行**。**P3 与 P2.5/P2.6 共享 `request.ts`**（新 setter + fail/abort + toHistoryEntry 分属不同区域）——并行的真实依据是「`request.ts` 内不重叠行 + 其余文件 disjoint + 显式 pathspec commit」，**不是「不同文件」**（WARN-2）；稳妥起见 P3 可排在 P2.6 后串行。

## 通用红线（各 phase 引用，不在 prompt 里重复）

1. **no-auto-server**：不跑 `bun run dev`/`start`、不 `kill`/`pkill` 本项目实例。可跑 `bun run typecheck` / `bun test <path>` / `bunx eslint <path>`（单文件核查须无缓存）。
2. **git**：显式 pathspec（`git add -- <精确路径>`、`git commit -F <msgfile> -- <精确路径>`），每语义单元一提交，conventional commits，无模型署名。untracked 文件先 `git add -- <该文件>` 再 commit。`git diff --cached --stat` 逐文件对账、防裹入 peer 在飞工作；污染用 `git reset -q HEAD -- <file>`（不 checkout）。
3. **golden gate**：P0 的 golden（`EntryRow` 逐列 / `assembleFullEntry` 结构 / `rewrites-req` 索引）是 P2.6/P4 的**硬 gate**——改后须逐字节/结构等价，不等价即回归。
4. **测试隔离**：新增 module-global 单例走 `useIsolatedRuntime`/`RESETTERS`；DB 测试用临时目录 DI（skill `test-isolation`）。不碰真实 `~/.local/share/copilot-api/history.db`。
5. **richest-data-flow**：后端存完整，不为 DRY/无消费者裁剪；但**不建 aspirational 空槽**——`model.capabilities`/raw upstream model 已撤到 RFC §5 future enrichment，本计划**不实现**。
6. **subagent 全量工具**：派出的实现/审查 subagent 一律给 Bash 等全量工具。

## 通用必读（各 phase 实现者先读）

- [RFC](../../rfc/2026-07-07-history-data-model-restructure.md) §2 决策 / §3 结构 / §4 迁移映射 / §6 cutover。
- [plan.md](plan.md) §「Factory / 锚点表」+ 本 phase 的 Task 段。
- skill `history-sqlite-schema`（表/stage/blob 布局）、`persistence-async-invariants`（settle 冻结快照三处同步）、`large-refactor`（§2 commit invariants / §4 golden 预捕获 / §6 sed 踩坑）。

## Factory / 锚点表

见 [plan.md §Factory](plan.md#factory--锚点表)——所有被改/复用的函数 `file:line`（生产者 `context/request.ts` + 写入方 `observability/sinks/history.ts` + serialize + 消费者），实现以该表为准。
