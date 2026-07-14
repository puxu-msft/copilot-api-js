# Kickoff: History 三层降温归档实施

复制本 prompt 到新会话（或用于 subagent-driven-development 编排）启动实施。

---

你要实施 History 三层降温归档特性。**先读**：

1. **spec（冻结）**：[docs/spec/2026-07-14-history-tiered-archive.md](../../spec/2026-07-14-history-tiered-archive.md) —— 经三轮 GPT 对抗评审、3 BLOCKER + 8 HIGH + 2 MEDIUM + 2 LOW 全吸收、判可进 plan。**§10 评审台账**是每个决策的 why + 处置。
2. **plan**：[docs/plan/2026-07-14-history-tiered-archive/plan.md](plan.md) —— 阶段 DAG + 全局约束（逐字复制自 spec）+ 文件结构 + 全阶段任务。
3. **现状 skill**：`history-sqlite-schema`（schema/驱动/迁移/内容寻址）、`history-backfill`（可恢复骨架三铁律）、`persistence-async-invariants`（异步落盘不变量）、`test-isolation`（DI 隔离、别碰 4141）、`empirical-verification`（连跑证确定性）。

**红线（Global Constraints，绝不违反）：**
- **永不真删**：生产路径无 `DELETE FROM entries_v2`（唯一例外=move 语义校验后删 HOT 副本）；delete 原语保留 test-only、移除 HTTP 路由。
- **move 严格顺序**：先写 archive（单库事务）→ 多子表校验 → 才删 HOT；幂等恢复走完整 verify→delete。
- **msg_blob 复制非移动**（INSERT OR IGNORE，防搜索静默丢）。
- **pinned 完全豁免**（永驻 HOT）。
- **视图分域**（HOT 与归档绝不同列）。
- **绝不碰 4141 主服务器**（测试服务器用非 4141 端口 + PID 精确清理）。

**执行顺序（DAG）：**
1. **Phase 0 打头**（format-agnostic，全 bite-sized 已在 plan 展开）——PoC 实测裁决 tier-2 格式（候选 A Parquet vs 候选 B SQLite sealed），产出 `exp/tiered-archive-format/FINDINGS.md`。**这是格式门，GATES P6。** 若候选 B 相近或更优 → 采 B（零依赖）。
2. P1 config → P2 archive.db 骨架 → **P3 搬迁+reaper 改造（承重、最高风险，崩溃注入 + 连跑 10 次）** → P4 读路径视图分域 → P5 移除 delete + 立即归档 → **P6 封存（Phase 0 结论后展开采纳候选的 bite-sized）** → P7 ui → P8 启动接线 + 合并态 + doc-sync。
3. P6 详细步骤**必须等 Phase 0 FINDINGS 裁决后**由 per-task subagent 即时展开——格式未定前写详细代码违反 empirical-verification。

**工作方式：**
- 隔离 worktree `.worktrees/tiered-archive/` + 分支 `feat/history-tiered-archive`（并发会话隔离）。
- 每 task TDD（测试先行）→ 细粒度显式 pathspec 提交（conventional commits、无模型署名）。
- per-task subagent 展开 bite-sized 步骤；高风险 task（P3 全部）+ 阶段收尾 subagent review；合并态评审（P8.2）专抓跨 phase 集成缝。
- 派 subagent 时**显式写裁判轴**：长远正确 + 完整 > 短期将就；永不真删红线；empirical（实测 > 文档 > 声称）。reviewer 的绝对断言亲自对照代码复核。

从 **Phase 0 Step 1** 开始。
</content>
