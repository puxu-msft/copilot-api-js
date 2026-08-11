# Mandatory Block Delivery 实施计划评审——实施者视角

> 状态：最终轮 `0 blocker / 0 major`，可定稿。
>
> 评审对象：Plan Mode 原文件 `/home/xp/.claude/plans/sparkling-juggling-whistle.md`；归档后对应本目录 README、四份阶段计划与 KICKOFF。
>
> 来源：原 reviewer `a6196146d7153db1e` 通过工具回传；Plan Mode 中 reviewer 无法直接写仓库，本文件由主会话逐轮转录并按当前计划处置表核对。

## 核验方法

Reviewer 读取冻结 spec 与当前源码接缝，重点核验现有 `DownstreamDeliverySession`、`CandidateBoundaryClassifier`、response processor、dispatch scheduler、`TransportDispatchOptions`、terminal bus、History state 与 Umzug migration registry；每轮按实施者第一人称模拟 Task 顺序、每 commit 可编译／可绿、ownership 和交接可执行性。

## 第一轮：`0 blocker / 1 major`

- **M1：Task 8 需要 scheduler→RequestContext dispatch capability→H2 lease install，但 RequestContext／ModelOperationDispatch API 被推迟到 Task 9。** 按原计划 Task 8 只能留 stub、绕过 RequestContext 或提前实现未定义接口，违反“ledger 与 lease install 同 commit 接通”。
- **处置（C，采纳）：** 经后续 persistence finding 一并重排为 Task 8 inert ledger、Task 9 storage substrate、Task 10 单一 production activation；`src/lib/history/state.ts` 路径与 terminal-bus sink 也明确到具体文件／调用点。

## 第二轮：`0 blocker / 1 major`

- **M1：Task 2 在 Task 3 adapters 建立 grammar input source 前，就把 `CandidateBoundaryClassifier` 改成 outcome projection。** Task 2 会让 readiness 恒空，或被迫复制第二 classifier。
- **处置（C，采纳）：** Task 2 只新增纯 grammar；Task 3 在 adapter／candidate session 产出真实 outcome 的同一 commit 才切 classifier，并保留 compatibility projection 到 Task 4 owner cutover。

## 第三轮：`0 blocker / 2 major`

- **M1：Task 7 的完整 termination snapshot 引用了 Task 8 才定义的 GOAWAY schema。** Task 7 无法独立绿，或会复制两套 union。
- **处置（C，采纳）：** Task 7 新建唯一 `http2-observation-types.ts` 与 generic `GoawaySnapshotSource`；Task 8 只导入并实现 lease source；Task 10 只接线。
- **M2：Task 5 要分 4 个绿色 migration commit，却提前启用全量 11-pump hard guard。** 前三批必红或 guard 被迫放宽。
- **处置（C，采纳）：** 建 Batch 0～4 exact strict／pending ratchet；pending 从差集派生，每批同 commit 转移成员，最终 pending 空才切全量 hard guard。

## 第四轮：`0 blocker / 1 major`

- **M1：Task 7 recorder 依赖 Task 10 才创建的 dispatch port。** 即使 ordinary-zero default source 已定义，Task 7 仍无法在 `http2Fetch` 独立产出 snapshot。
- **处置（C，采纳）：** Task 7 前移通用 `Http2TerminationCommitPort` 与 per-request local port；Task 10 用 RequestContext port 替换实现而不改 recorder。

## 第五轮：`0 blocker / 1 major`

- **M1：local port callback 与 recorder observer 形成双通知通道。** 单次 terminal 可能通知两次，或 port callback 抛错阻断 consumer terminal。
- **处置（C，采纳）：** Local port 无 callback／snapshot store／observer，只做 CAS→freeze→builder；recorder 是 `onTermination` 唯一调用者，并隔离 observer 异常。补成功一次、拒绝零次、throw 不影响 close／error 三控。

## 最终轮：`0 blocker / 0 major`

Reviewer 对最新单文件计划确认：

- Task 7 可独立编译／运行；local port 只 CAS、freeze、builder，recorder 独占 observer。
- Task 10 只替换 port 实现；RequestContext 独占 real source，CAS 拒绝不 freeze，成功原子保存 snapshot + operation lease。
- Task 8／9 仍是 inert substrate，Task 10 是唯一 production activation commit。
- Task 5 Batch 0～4 ratchet 对未知 root、未迁、漏移、回退均当批变红，正确中间 commit 可绿。
- Coverage、verification、progress、归档拆分和 KICKOFF 无旧 DAG／ownership 语义残留。

**最终 verdict：`0 blocker / 0 major`。**
