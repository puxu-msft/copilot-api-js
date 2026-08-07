---
name: feedback-layered-iterative-delivery-not-all-at-once
description: 一定规模项目采用分层迭代交付，不做无限扩张的 all-in-once；每批自洽可验收，后续正确事项明确落盘且不因分批被删范围
metadata:
  node_type: memory
  type: feedback
  originSessionId: 2684f077-d2ec-4112-9456-3371f8cb7f9d
  modified: 2026-08-06T20:11:19.799Z
---

对于任何具备一定规模、会在实施中持续发现新问题的项目，默认采用**分层迭代交付**，而不是 all-in-once：先交付一批边界清楚、内部自洽、已验证、可独立产生价值的核心改进；新增发现按依赖关系、阻塞性和验收边界进入后续批次。

分批的机械边界：① 当前批必须有独立可运行的验收门，不能把编译中间态或缺腿实现冒充阶段成果；② 会阻断当前批正确性、数据完整性或合并安全的问题必须留在当前批闭合；③ 不阻断当前批的后续正确事项必须立即写入明确的 plan／backlog／todo 载体，含验收判据与证伪方式；④ 下一批可以调整顺序，但不得以“先交付”为名静默删除正确范围。

**Why:** all-in-once 会让持续发现的新问题无限扩大当前批，延迟已经自洽且急需的价值；反过来只做眼前核心却不落盘后续项，又会把“迭代”退化成范围丢失。2026-08-06 的 History strict list-search 实例中，第一批核心修复已通过全 backend／UI／typecheck／mutation controls 并先合入 `master`，随后发现的 recent／persisted overlay 边界被明确降为下一批待验证项，未阻塞功能恢复，也未静默遗忘。

**How to apply:** 计划与实施过程中维护批次表；每个新发现当场判定“阻塞当前批／后续批”，写明依据。当前批通过自身验收后立即提交／集成；后续批的载体必须在本轮结束前可发现。评审时同时查两个方向：当前批是否被错误缩小到不自洽，以及后续正确事项是否只是口头说“以后做”却没有落盘。

**Related:** [[feedback-slam-dunk-fixes-do-immediately]]、[[methodology-cross-phase-integration-seam-only-caught-at-merged-state]]、[[methodology-plan-drift-scales-with-rework-reconcile-per-contract]]
