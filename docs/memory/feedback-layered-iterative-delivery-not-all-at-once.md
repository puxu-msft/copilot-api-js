---
name: feedback-layered-iterative-delivery-not-all-at-once
description: 一定规模项目采用分层迭代交付，不做无限扩张的 all-in-once；每批自洽可验收，后续正确事项明确落盘且不因分批被删范围
metadata:
  node_type: memory
  type: feedback
  originSessionId: 2684f077-d2ec-4112-9456-3371f8cb7f9d
  modified: 2026-08-06T20:11:19.799Z
---

分层迭代交付的执行规则已下沉到项目 skill [delivering-in-validated-batches](../../.claude/skills/delivering-in-validated-batches/SKILL.md)：批次／阶段／父项目三道完成门、新发现分流、后续项记录契约、事件型复议、依赖可达性与真实转移闭环均以该 skill 为单一事实源。

**Why:** 2026-08-06 的 History strict list-search 实例中，第一批核心修复已独立产生价值，后续又发现 recent／persisted overlay 边界；只做 all-in-one 会无限推迟已自洽成果，只留一句“以后做”又会丢失正确范围。后续评审进一步实测出两个绕过：把正确事项长期留在 todo 后仍关闭父项目，以及用空壳父项转移关闭责任。

**How to apply:** 出现多语义阶段、scope creep、deferred follow-up、all-in-one 压力或父项目关闭时，加载上述 skill；本 memory 只保留来源战例，不复述执行判据。

**Related:** [[feedback-slam-dunk-fixes-do-immediately]]、[[methodology-cross-phase-integration-seam-only-caught-at-merged-state]]、[[methodology-plan-drift-scales-with-rework-reconcile-per-contract]]
