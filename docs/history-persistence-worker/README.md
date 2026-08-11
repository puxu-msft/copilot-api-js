# History Persistence Worker —— 特性文档索引

**这是本特性的唯一文档落点。** 与它相关的 spec、plan、进度、评审、收尾报告全部放在本目录，**新产出也直接写在这里**（用户 2026-08-11 裁决：本任务是系列任务，相关文档集中到 `docs/<topic>/`）。

**当前活路径的权威不在本目录**——是 [../DESIGN.md](../DESIGN.md) 的「活的架构现状」表里 `src/lib/history/` 那一行。本目录记的是**这个特性怎么一步步做成的**，两者冲突时以 DESIGN.md 为准。

## 常驻文档

**目录分两层**：本层放**还在用的**（规格、计划、下一批的输入）；[archive-2026-08-11/](archive-2026-08-11/) 放**已完成批次**（0/1a、1b、2a、2b）的进度文件与评审／收尾报告。归档只是位置变了，内容一字未改，仍是那些批次的证据来源。

| 文件 | 是什么 |
|---|---|
| [spec.md](spec.md) | 行为规格（冻结契约）。实现与它冲突时先停下核对，不自行改动 |
| [plan.md](plan.md) | 分批实施计划。**批次是否完成看标题下的 `状态：` 行，不看复选框**——原因写在文件开头 |
| [plan-kickoff.md](plan-kickoff.md) | 起一轮执行用的 kick-off 提示词 |

## 批次执行记录（按时间，全部已归档）

进度文件记的是 git 记不下的三样：剩余项及验收、在途意图、已作废路线。

| 批次 | 进度文件 | 评审与收尾 |
|---|---|---|
| Batch 0 / 1a | [2026-08-07-history-worker-progress-impl-1.md](archive-2026-08-11/2026-08-07-history-worker-progress-impl-1.md) | [1a 复评](archive-2026-08-11/2026-08-08-history-worker-batch-1a-rereview.md) |
| Batch 1b | [2026-08-08-history-worker-progress-impl-1b.md](archive-2026-08-11/2026-08-08-history-worker-progress-impl-1b.md) | [处置表](archive-2026-08-11/2026-08-08-history-worker-batch-1b-review-dispositions.md) · [收尾终审](archive-2026-08-11/2026-08-08-history-worker-batch-1b-closeout-review-final.md) · [终稿报告](archive-2026-08-11/2026-08-08-history-worker-batch-1b-terminal-report.md) · [临时清单](archive-2026-08-11/2026-08-08-history-worker-batch-1b-temp-manifest.md) |
| Batch 1b 收尾评审（多轮） | — | [终审](archive-2026-08-11/2026-08-08-batch-1b-closeout-final-review.md) · [Round 4](archive-2026-08-11/2026-08-08-batch-1b-closeout-review-round4.md) · [Round 5](archive-2026-08-11/2026-08-08-batch-1b-closeout-review-round5.md) · [stage8 裁决](archive-2026-08-11/2026-08-08-batch-1b-stage8-adjudication.md) |
| Batch 2a | [2026-08-08-history-worker-progress-impl-2a.md](archive-2026-08-11/2026-08-08-history-worker-progress-impl-2a.md) | — |
| Batch 2b | [2026-08-09-history-worker-progress-impl-2b.md](archive-2026-08-11/2026-08-09-history-worker-progress-impl-2b.md) | [GPT 评审](archive-2026-08-11/2026-08-09-batch2b-review-gpt.md) · [假绿专项](archive-2026-08-11/2026-08-09-batch2b-review-testing.md) · [收尾报告](archive-2026-08-11/2026-08-10-batch2b-closeout.md) · [对账](archive-2026-08-11/2026-08-10-batch2b-closeout-review-reconciliation.md) · [目录绑定审计](archive-2026-08-11/2026-08-10-batch2b-closeout-review-cwd-audit.md) · [临时清单](archive-2026-08-11/2026-08-10-batch2b-closeout-tmp-manifest.md) |

**读归档里的评审报告时注意**：它们是**当时那一刻**的判断，内容按纪律原样冻结、不回改。里面的 `file:line` 引用指向当时的行号，被引文件后续若有增删就会漂；把它们当线索，不当当前事实。判**现在**是什么样，回到 [../DESIGN.md](../DESIGN.md)。

## 计划对账（2026-08-10）

Batch 2b 落地后，后续批次的部分计划陈述已失效。**动手做任何未执行批次之前先读对应的 `2b 后对账` 横幅**（就在 plan.md 各 Task 标题下），逐条证据在这两份：

- [2026-08-10-plan-recon-4a-4b.md](2026-08-10-plan-recon-4a-4b.md) —— 4a／4b 逐 Step 判定
- [2026-08-10-plan-recon-3a-3b-5-6.md](2026-08-10-plan-recon-3a-3b-5-6.md) —— 3a／3b／5／6 前置复核

## 已知代价与暂缓项

本特性引入的、尚未闭合的用户可见缺口登记在 [../todo/deferred-backlog.md](../todo/deferred-backlog.md)：`POST /api/entries/:id/{pin,unpin}` 在 2b→6 窗口期返回 503（Batch 6c 恢复），以及 `/api/status` 与 metrics 仍上报 `backend: "legacy"`。
