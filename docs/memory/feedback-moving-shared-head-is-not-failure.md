---
name: feedback-moving-shared-head-is-not-failure
description: 特性已确认合并且有验收证据后，共享主线仅因 peer 提交前进不触发反复全量复验；真实失败或相关变化才升级调查
metadata:
  type: feedback
---

特性提交已确认合并且已有验收证据后，共享主线仅因无关 peer commit 持续前进，不会自动使原证据失效，也不构成一个又一个新的收尾边界。先信任已合并结果；只有出现实际测试／构建／运行失败、相互矛盾的证据、相关路径／契约／测试基础设施变化、异常合并结果，或用户明确要求核验时，才复验受影响范围。项目要求的交付／发布门在真正交付点运行一次，不随每个 HEAD 变化重跑。

**Why:** 2026-08-08 HTTP 408 修复合并后，主线在收尾期间不断被并发会话推进。我反复把“HEAD 变化”本身当成旧验证失效，连续重跑 typecheck、靶向测试与全 backend；用户明确裁决：“跳过主线验证，视为成功，先相信再质疑，主线前进除非真有问题，用户会回来找你的。”

**How to apply:** 先确认 feature commit 已进入主线并保留原验收证据。之后 peer 前进时按相关路径／契约判断影响；无真实失败信号就继续收尾，不追逐移动 HEAD。若用户后来报告故障，把该报告作为新信号进入系统排查。全局权威规则是 user-rule `01-core-principles` 的 `trust-first-but-keep-eyes-open`／`moving-shared-head-is-not-failure`。

**Related:** [[feedback-network-failure-resume-does-not-invalidate-success]]、[[methodology-cross-phase-integration-seam-only-caught-at-merged-state]]
