# Mandatory Block Delivery 与 HTTP/2 终止观测 —— 特性文档索引

**这是本特性的唯一文档落点。** 与它相关的 spec、plan、进度、评审、收尾报告全部放在本目录，**新产出也直接写在这里**（用户 2026-08-11 裁决：本任务是系列任务，相关文档集中到 `docs/<topic>/`）。

**当前活路径的权威不在本目录**——是 [../DESIGN.md](../DESIGN.md) 的「活的架构现状」表。本目录记的是**这个特性怎么一步步做成的**，两者冲突时以 DESIGN.md 为准。

**当前状态的权威是 [progress-ledger.md](progress-ledger.md)**（SDD 进度账本）：哪个 Task 已闭合、哪个被什么挡着、门禁证据是什么，都以它为准，别从计划文档的复选框推断。

## 常驻文档

| 文件 | 是什么 |
|---|---|
| [spec.md](spec.md) | 行为规格（冻结契约）。实现与它冲突时先停下核对，不自行改动 |
| [plan.md](plan.md) | 实施计划总纲：全局约束、**冻结的跨层接口**、commit invariants、阶段 DAG、spec 覆盖对账、验证矩阵。⚠️ 头部状态行 `approved-not-implemented` 写于计划定稿时，**早已过期**——当前进度看账本 |
| [plan-1-sse-and-delivery-foundation.md](plan-1-sse-and-delivery-foundation.md) | Task 1～4：SSE、typed grammar、adapter、唯一 owner |
| [plan-2-production-pump-migration.md](plan-2-production-pump-migration.md) | Task 5～6：11 pumps ratchet 迁移与配置双轨退役 |
| [plan-3-http2-observation.md](plan-3-http2-observation.md) | Task 7～9：termination contract、ordered ledger、History storage substrate |
| [plan-4-history-and-verification.md](plan-4-history-and-verification.md) | Task 10～12：production activation、runtime／performance harness、merged-state 验收 |
| [plan-kickoff.md](plan-kickoff.md) | 起一轮执行用的 kick-off 提示词 |
| [progress-ledger.md](progress-ledger.md) | SDD 进度账本 —— **当前状态的权威来源** |

## 规格与计划的评审记录

| 对象 | 评审 |
|---|---|
| spec | [事实与判据证伪](2026-08-06-spec-review-falsification.md) · [实施者走查](2026-08-06-spec-review-implementer.md) |
| plan（单文件版转录） | [事实与判据证伪](2026-08-07-plan-review-falsification.md) · [实施者走查](2026-08-07-plan-review-implementer.md) |
| plan（拆分后复核） | [事实与判据证伪](2026-08-07-plan-review-split-falsification.md) · [实施者走查](2026-08-07-plan-review-split-implementer.md) |
| 本目录这次归并本身 | [归并重组评审](2026-08-11-docs-consolidation-review.md)（0 blocker / 0 major / 0 minor） |

## 各 Task 执行记录（按时间）

进度文件记的是 git 记不下的三样：剩余项及验收、在途意图、已作废路线。

| Task | 进度文件 | 评审、验证与探针 |
|---|---|---|
| Task 1b（Parsed SSE） | [进度](2026-08-07-progress-task-1b.md) · [接力](2026-08-07-progress-task-1b-continuation.md) | [代码评审](2026-08-07-task-1b-review-code.md) · [代码复评](2026-08-07-task-1b-review-code-rereview.md) · [验收复评](2026-08-07-task-1b-review-acceptance-rereview.md) · [验证](2026-08-07-task-1b-verification.md) |
| Task 3（delivery adapter 接缝） | [进度](2026-08-07-progress-task-3.md) | [代码评审](2026-08-07-task-3-review-code.md) · [验收复评](2026-08-07-task-3-review-acceptance-rereview.md) |
| Task 8（inert GOAWAY ledger） | [进度](2026-08-07-progress-task-8.md) | —— |
| Task 9（History V3 evidence 存储） | [进度](2026-08-07-progress-task-9.md) · [ready 快照](2026-08-08-progress-task-9-ready-snapshot.md) · [Range A 接力](2026-08-08-progress-task-9-range-a-continuation.md) | [规格符合性](2026-08-08-task-9-review-spec.md) · [验收](2026-08-08-task-9-review-acceptance.md) · [SQLite 驱动调研](2026-08-07-task-9-review-sqlite-driver-research.md) · [SQLite authority PoC](2026-08-07-task-9-review-sqlite-authority-poc.md) · [summary 完整性架构](2026-08-07-task-9-summary-integrity-architecture.md) · [summary 完整性评审](2026-08-07-task-9-review-summary-integrity.md) · [FK 终态探针](2026-08-08-task-9-probe-fk-final-state.md) |
| Task 37（Task 1b × Task 3 合并态接缝） | [进度](2026-08-08-progress-task-37-seam.md) | [待核验命题清单](2026-08-09-task-37-review-seam-claims.md) · [drift／consumer-walk](2026-08-09-task-37-review-seam-drift.md) · [不变量证伪](2026-08-09-task-37-review-seam-invariants.md) · [处置表](2026-08-09-task-37-review-seam-dispositions.md) · [D1 裁决](2026-08-09-task-37-review-d1-arbitration.md) · [grammar 终态评审](2026-08-09-task-37-review-grammar-terminal.md) |
| 跨 Task 上下文接力 | [接力记录](2026-08-08-progress-context-continuation.md) | —— |

## Task 37 收尾（2026-08-09 ～ 08-10）

Task 37 的合并态复审门以 **0 blocker** 关闭，并在过程中撞出并修掉一个真实生产缺陷（上游终态 `event: error` 被当截断重试四次、客户端收到两个终止符）。收尾件：

- [终态报告](2026-08-10-task-37-closeout-terminal-report.md) —— **先读这份**：逐条当前状态断言 + 证据 + 该证据是复用还是新取
- [证据清单](2026-08-09-task-37-closeout-evidence-manifest.md) · [job tmp 冻结清单（427 行）](2026-08-09-task-37-closeout-job-tmp-inventory.md) · [清单评审](2026-08-09-task-37-closeout-review-manifest.md)
- 终报评审：[判据证伪视角](2026-08-10-task-37-closeout-review-draft-claims.md) · [接手方走查视角](2026-08-10-task-37-closeout-review-draft-successor.md) · [清理增量评审](2026-08-10-task-37-closeout-review-cleanup-increment.md)

配套实验产物按项目约定**留在 `exp/` 就地**，不搬进本目录：[exp/task37-anthropic-error-boundary/](../../exp/task37-anthropic-error-boundary/README.md)（error 帧分类边界探针）、[exp/task37-closeout-inventory/](../../exp/task37-closeout-inventory/README.md)（收尾清单对账脚本）。

## 已知代价与陷阱

- **`plan.md` 的头部状态行是陈旧的。** 它写于计划定稿、尚未实施时；此后 Task 1b／3／8／9／37 已落地。当前状态一律看 [progress-ledger.md](progress-ledger.md)。
- **账本原先在 `.superpowers/sdd/progress.md`**，2026-08-11 迁入本目录。那个旧路径**被历次 SDD 运行反复复用**——仓库里其他文档提到它时，指的多半是各自当时的另一份账本，不是本系列的。旧路径留了一行指针 stub 说明这件事。
- **进度文件的日期前缀是它落盘的日期，不是任务的日期。** 同一 Task 的多份进度文件按接力顺序排。
- 本目录的评审报告一律**保持原样**，只在必要时补时间点头部——它们的价值是「在哪个 commit 上发现了什么、以及为什么先前没看见」，重写成终态就把这层信息销毁了。
