# History Persistence Worker —— 特性文档索引

**这是本特性的唯一文档落点。** 与它相关的 spec、plan、进度、评审、收尾报告全部放在本目录，**新产出也直接写在这里**（用户 2026-08-11 裁决：本任务是系列任务，相关文档集中到 `docs/<topic>/`）。

**当前活路径的权威不在本目录**——是 [../DESIGN.md](../DESIGN.md) 的「活的架构现状」表里 `src/lib/history/` 那一行。本目录记的是**这个特性怎么一步步做成的**，两者冲突时以 DESIGN.md 为准。

## 常驻文档

| 文件 | 是什么 |
|---|---|
| [spec.md](spec.md) | 行为规格（冻结契约）。实现与它冲突时先停下核对，不自行改动 |
| [plan.md](plan.md) | 分批实施计划。**批次是否完成看标题下的 `状态：` 行，不看复选框**——原因写在文件开头 |
| [plan-kickoff.md](plan-kickoff.md) | 起一轮执行用的 kick-off 提示词 |

## 批次执行记录（按时间）

进度文件记的是 git 记不下的三样：剩余项及验收、在途意图、已作废路线。

| 批次 | 进度文件 | 评审与收尾 |
|---|---|---|
| Batch 0 / 1a | [2026-08-07-history-worker-progress-impl-1.md](2026-08-07-history-worker-progress-impl-1.md) | [1a 复评](2026-08-08-history-worker-batch-1a-rereview.md) |
| Batch 1b | [2026-08-08-history-worker-progress-impl-1b.md](2026-08-08-history-worker-progress-impl-1b.md) | [处置表](2026-08-08-history-worker-batch-1b-review-dispositions.md) · [收尾终审](2026-08-08-history-worker-batch-1b-closeout-review-final.md) · [终稿报告](2026-08-08-history-worker-batch-1b-terminal-report.md) · [临时清单](2026-08-08-history-worker-batch-1b-temp-manifest.md) |
| Batch 2a | [2026-08-08-history-worker-progress-impl-2a.md](2026-08-08-history-worker-progress-impl-2a.md) | — |
| Batch 2b | [2026-08-09-history-worker-progress-impl-2b.md](2026-08-09-history-worker-progress-impl-2b.md) | [GPT 评审](2026-08-09-batch2b-review-gpt.md) · [假绿专项](2026-08-09-batch2b-review-testing.md) · [收尾报告](2026-08-10-batch2b-closeout.md) · [对账](2026-08-10-batch2b-closeout-review-reconciliation.md) · [目录绑定审计](2026-08-10-batch2b-closeout-review-cwd-audit.md) · [临时清单](2026-08-10-batch2b-closeout-tmp-manifest.md) |

## 计划对账（2026-08-10）

Batch 2b 落地后，后续批次的部分计划陈述已失效。**动手做任何未执行批次之前先读对应的 `2b 后对账` 横幅**（就在 plan.md 各 Task 标题下），逐条证据在这两份：

- [2026-08-10-plan-recon-4a-4b.md](2026-08-10-plan-recon-4a-4b.md) —— 4a／4b 逐 Step 判定
- [2026-08-10-plan-recon-3a-3b-5-6.md](2026-08-10-plan-recon-3a-3b-5-6.md) —— 3a／3b／5／6 前置复核

## 已知代价与暂缓项

本特性引入的、尚未闭合的用户可见缺口登记在 [../todo/deferred-backlog.md](../todo/deferred-backlog.md)：`POST /api/entries/:id/{pin,unpin}` 在 2b→6 窗口期返回 503（Batch 6c 恢复），以及 `/api/status` 与 metrics 仍上报 `backend: "legacy"`。
