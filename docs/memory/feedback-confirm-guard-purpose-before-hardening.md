---
name: feedback-confirm-guard-purpose-before-hardening
description: 把观测指标升级成阻断 guard 时，若目的、false-red 成本或判定粒度尚无用户／spec／契约裁决，先确认再实施；不得擅自升级成复杂度证明
metadata:
  node_type: memory
  type: feedback
  originSessionId: 32630e1d-bf0b-4a6c-baa8-80afb3446c1e
  modified: 2026-08-07T00:00:00.000Z
---

把一个指标或测试升级成会阻断合并的 guard 时，先查用户裁决、冻结 spec 与外部契约；若它们尚未决定以下任一项，才向用户确认：① guard 要防的具体失败；② false-red 的可接受成本；③判定粒度是粗安全上限、趋势预警，还是可证明的结构不变量。已有裁决时直接遵循，不重复询问。不得由模型自行把“防止明显失控”升级成“证明算法复杂度”。

**Why:** 2026-08-07 的 `canonical-performance` 事故中，用户只需要代表性 workload 在正常时间范围完成。模型没有询问本意，先把 wall-clock ratio 做成合并门；它在全 backend 负载下 false-red 后，又连续多轮引入 production work observer、resetter 与手写 AST SCC guard，试图证明线性复杂度。该 guard 既可被不经 observer 的复制与 alias 绕过，又会因合法 rename 假红；直到用户追问“它是什么用途，是限制合并吗”，才发现整个精确证明目标从未被用户要求。最终按用户裁决用 `c3f15c2c` 删除 212 行、增加 9 行，撤销过度守卫，只保留三个代表性 workload 总耗时 `<10s`、测试硬 timeout `15s`，性能明细仅报告。

**How to apply:** 新增或加固阻断式 gate 时，先写一行“用户可观察的失败 → gate 目的 → 判定粒度”。如果目的只是防挂死或数量级失控，采用宽松绝对上限并让明细只报告；只有用户、冻结 spec 或外部契约明确要求复杂度／结构证明时，才引入确定性 work oracle 或静态结构 guard。若 reviewer 开始连续加固一个越来越精巧的门，先回查“这个门的精度是谁裁决的”，不要直接进入下一轮形态修补。

**Related:** [[methodology-relocate-invariant-when-guard-cannot-keep-up]]、[[feedback-layered-iterative-delivery-not-all-at-once]]、[[feedback-subagent-review-before-any-user-facing-proposal]]
