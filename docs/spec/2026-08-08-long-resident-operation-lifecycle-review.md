# 超长驻留 operation 生命周期规格评审

## 评审对象

- 规格：`docs/spec/2026-08-08-long-resident-operation-lifecycle.md`
- 首轮冻结 commit：`bcd1fbda8196ce14404c2f0f178051dce2b94a11`
- Reviewer：Claude `reviewer`，只读 `Read/Bash`
- 首轮 verdict：0 blocker／5 major
- 异模型补充评审：GPT reviewer 在生成中发生 `Server error mid-response`，未产生有效报告，不能计入评审结论。

## 首轮命题核验

| 命题 | Reviewer 结论 | 主会话复核 |
|---|---|---|
| C1 shutdown 默认 drain `getTrackedOperations()` | 通过 | 已对照 `src/lib/shutdown.ts` 确认 |
| C2 logical settle 后保留 tracked operation 至 finalizer 收口 | 通过 | 已对照 `src/lib/context/manager.ts` 确认 |
| C3 canonical finalizer 等 operation quiescence 且需要 delivery notification | 通过 | 已对照 `src/lib/context/request.ts` 确认 |
| C4 recovery 最终报告承认全量 reviews 未收口 | 通过 | 已对照 `task-4.3b-implementation-report.md` 确认 |
| C5 分支包含 settlement-before-request-finalization 修复 | 通过 | `298b48fc` 存在，已核 commit subject 与代码方向 |
| C6 buffered／translated B2 与 A4 有正式边界 | 部分不成立 | buffered 与 A4 有正式入口；translated B2 当时只在 plan／report 叙述，没有 backlog SSOT |
| C7 `/api/status.activeRequests.count` 读取 `activeCount` | 通过 | 已对照 `src/routes/status/route.ts` 确认 |
| C8 shutdown 把 tracked operation 误称 active request | 通过 | 已对照 `formatActiveRequestsSummary` 与 Step 2 日志确认 |

## 发现处置

所有发现均属于会落入可逆文档产物的 C 级裁定。主会话按实际代码独立复核后全部采纳；没有暂定驳回。

| ID | 级别 | 发现 | 处置 | 修订 |
|---|---|---|---|---|
| R1 | major | Delivery 只有 `open/finalizing/finalized`，无法表达 `settleFinal()` rejection | 采纳（C） | 改成带 outcome 的联合，新增 `failed + error + failureRegistered`；规定 failure 仍是可 join terminal、唤醒 canonical、另行使 shutdown 失败 |
| R2 | major | Blocker 只看 `childCount`，漏 `sealed=false, childCount=0` | 采纳（C） | `operation-body` 改按 `!operationScope.quiesced`；新增删除／漏接 `seal()` mutation |
| R3 | major | “唯一合法终止顺序”把独立事实误写成总序 | 采纳（C） | 改成偏序：candidate／dispatch 先闭合；operation 与 delivery 并行；canonical join 二者；manager 最后 release |
| R4 | major | Translated B2 没有规格声称的正式 backlog SSOT | 采纳（C） | 在 `docs/todo/deferred-backlog.md` 新增 translated publication 条目，写根因、现状、理想架构、暂缓理由与触发条件 |
| R5 | major | Lifecycle 验收集中在 direct recovery，漏通用 SSE、WS 与非流式 producer | 采纳（C） | 新增 delivery producer 接线矩阵，要求先 AST／TypeScript resolver 枚举生产者，并为每类做漏 notification mutation |

## 首轮 reviewer 原始摘要

Reviewer 判断 0 blocker／5 major，修复 major 后可进入实施计划。它确认 `canonical: failed` 后 `blocker: none` 可以成立，条件是 failure registration、状态发布与 registry release 形成不可分割的 manager 接缝；也确认 status 从 registry snapshot 即时聚合不会引入第二份可变真相源。

## 复评要求

复评必须在修订 commit 上逐条确认 R1～R5 已关闭，并重新检查：

1. Delivery failure 是否既可 join、又不会伪装成功；
2. `sealed=false, childCount=0` 是否稳定判为 `operation-body`；
3. 偏序是否允许正确并行，同时禁止 premature canonical publish；
4. Translated B2 backlog 是否成为稳定可达入口；
5. Producer 矩阵是否覆盖 SSE、WS、recovery 和非流式，并具有目标 mutation；
6. 修订本身是否引入新的 blocker／major。
