# Task 4 提前实施争议裁决

## 争议清单与资格

1. 在 commit `638f6f3c898f7562fc086bfb2c5f1f4b04a5b5ad` 上，冻结计划 Task 4 是否已被部分提前实施。
2. 若 Task 4 未越界，“新 owner 接线与 owner 外 write helper 并存”是否仍是结构问题及其级别。

裁决资格：具备。我未参与甲方、乙方或已披露第三个 agent 的本轮评审，且不把受污染的第三票计入证据。

## 独立证据

### E1：冻结计划对 Task 3／Task 4 的边界

`git show 638f6f3c898f7562fc086bfb2c5f1f4b04a5b5ad:docs/plan/2026-08-07-mandatory-block-delivery-h2-observability/plan-1-sse-and-delivery-foundation.md` 显示：Task 4 的定义性交付包括在既有 session 内增加 candidate-local staging／outcome consumption（第 87 行）、把 `runResponseBufferedSink` 改为通过 owner 消费 grammar outcomes（第 88 行）、删除 owner 外真实写出 helper（第 89 行）、增加 `consume(outcome, adapter)` 与 `runSyntheticResponse`（第 83 行、第 90 行）。同一计划明确把 serializer、wire state、allocation port、terminal fence 称为 Task 4 要“复用”的既有组件（第 87 行）。因此，仅发现 allocation port 或既有 session 已接入生产路径，不能单独证明 Task 4 已开始；必须观察到 Task 4 所定义的 migration delta。

### E2：双方引用的生产接线确实存在，但其形状仍是旧写路径

在 baseline object 中逐行读取后，甲方引用基本准确：`src/lib/pipeline/driver.ts:1109-1114`、`:1314-1324`、`:1410-1420` 通过 `wireAllocationPort`／session lookup 执行 `beginLeg`、`noteWinner` 和 owner failure mapping；`src/routes/messages/handler-v4.ts:1920-1922`、`:1965-1975`、`:2280-2282`、`:2317-2318` 把 allocation port 传入 driver，并在 route 的 anchor-close 路径处理 owner failure。与此同时，driver 的 hedge winner 仍在 `:1117`、`:1129`、`:1146` 直接调用旧 helper；helper 定义仍在 `:1215-1220`，其行为是直接 `sink.write`。这些事实证明“owner 基础设施与 owner 外写 helper 并存”，但尚未回答它是 Task 4 的增量还是 Task 4 明说要复用并最终消除的前置状态。

### E3：定义性 Task 4 接口与迁移均不存在

在 commit `638f6f3c` 的 `src/` 范围运行 `git grep -F`，`consume(outcome`、`runSyntheticResponse`、`BlockDeliveryOwner` 均为零命中；`git cat-file -e 638f6f3c:src/lib/pipeline/delivery/synthetic.ts` 明确返回 path 不存在。`runResponseBufferedSink` 仍按 compatibility fields／frame buffer 驱动，而非让 owner 消费 typed grammar outcomes；旧 helper 仍生产可达。乙方所列四项 Task 4 交付物未出现，且计划第 67 行规定 owner consumption 与 compatibility projection 删除须同一 commit，baseline 的 Task 3 进度也明确记录“Task 4 才允许删除 compatibility projections并让唯一 delivery owner 直接消费 outcomes”。

### E4：甲方所指接线的历史 provenance 不是 Task 4 实施

`git blame 638f6f3c` 显示 allocation-port 接线来自 `1c40f768`／`79700269`／`ebc863af`（2026-08-02），owner failure mapping 来自 `6333d800`（2026-08-03），handler 的 `wireAllocationPort`／`closeAnchorViaOwner` 接线来自最迟 2026-08-06 的既有 recovery 工作；冻结计划本身由 `82cd9123` 于 2026-08-07 10:15 UTC 加入。`delivery/session.ts` 最初由 `786929b5` 于 2026-07-17 创建；`owner-failure.ts` 由 `6333d800` 于 2026-08-03 创建。`git log 82cd9123..638f6f3c -S wireAllocationPort -- src` 为空，证明计划冻结后没有引入或移除该接线。计划第 87 行又明确说 Task 4 要“复用” allocation port。因此该接线是 Task 4 的前置底座，不是 Task 4 migration delta。

## 裁决

### [1] Task 4 是否已部分提前实施——支持乙方（乙方成立）

判据：所谓“部分实施 Task 4”必须至少观察到冻结计划为 Task 4 定义的 migration delta，而不能把计划明确要求复用的既有底座反标为该任务的实施。独立证据 E1～E4 表明，甲方正确识别了 baseline 的混合写路径现状，却把前置 infrastructure／legacy state 错归为 Task 4 增量；baseline 上没有 owner consumption、synthetic owner API、sole-write cutover 或 helper retirement。故“Task 4 owner migration 已部分落地”不成立。后续影响：撤销这条 BLOCKER；Task 3 仍按计划保留 compatibility projection，Task 4 后续必须完整执行定义性交付。承接建议：无需因本争议修改代码；实施 Task 4 时由 `gpt-souls:implementer` 按冻结计划完成迁移。

### [2] 混合所有权状态本身——结构问题，Major（非本轮 blocker）

判据：`DownstreamDeliverySession` 已承载 serializer／allocation／terminal 等 owner 职责，但 production winner frames 仍可经 driver helper 直接写 `ClientSink`，属于职责分裂与 owner abstraction leak；这是长期架构上的实质问题。级别定为 Major，因为它破坏目标 single-write-owner 形状并横跨 live／hedge／buffered 路径；但它是冻结计划明确列入 Task 4 的已知、受控阶段性债务，Task 3 还明确要求保留 compatibility，因此不能升级为当前 Task 3 的 blocker，也不应另建重复条目。后续影响：保留 Task 4 现有记录并在该任务完成时消除；不要把它表述为“Task 4 已提前实施”。

## 附带观察

无。未评价用户明确排除的 Anthropic delivery adapter 缺陷及其修复。
