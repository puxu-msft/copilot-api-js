---
name: project-upstream-error-client-shaping
description: 上游错误→客户端可行动形态整形大特性（Phase 0-5 实现落地+全过审、Phase 6 GATED 骨架；隔离 worktree 未合 master）
metadata: 
  node_type: memory
  type: project
  originSessionId: 1a1428a4-9c8e-4a9d-98f3-08d5bf495030
---

**上游报错时不再拼「普通 text/error 帧让 CC 停下」，而是按 commit 阶段分治整形**成客户端会妥当处理的形态。源起用户诉求：可重试的触发客户端重试、不可重试且用户可动作的包装成 AskUserQuestion。

**实施状态（2026-07-14）**：Phase 0-5 **全部实现 + 逐 task 过审 + 终局 whole-branch review 通过**，Phase 6 GATED 骨架（依赖 block-level P1）。隔离 worktree `feat/upstream-error-client-shaping`（~35 commit，16 生产文件 +900 行），**未合 master**——待用户定合并时机（与并发 block-level P1 在 handler-v4.ts 有冲突面，`buildCanonicalErrorFrame` 单函数收窄到调用点）。执行期修复：Phase 3 fix 循环（refusal 回归锁 + translate 腿 G-3 收编）、Phase 4 **Critical wire bug**（AUQ options 应为 CC schema `{label,description}` 对象非字符串）、终局观测面接线（3 死枚举→真产出）。**已知敞口 MED-3**：AUQ 交互式渲染未实测、上线前需人工验收。

**权威**：spec [docs/spec/2026-07-13-upstream-error-client-shaping.md](../../docs/spec/2026-07-13-upstream-error-client-shaping.md)（v2.3，四轮评审全闭合）；plan [docs/plan/2026-07-13-upstream-error-client-shaping/](../../docs/plan/2026-07-13-upstream-error-client-shaping/)（含头部实施状态注解 + progress ledger）；调研 [exp/cc-error-retry-surface/](../../exp/cc-error-retry-surface/)（FINDINGS 源码穷举 + REPORT 真 CC 实测 + fake server harness）；DESIGN.md 配置键表已加 error_shaping_* 4 键行。

**承重设计结论**（实测 + 源码 + 对抗评审三方收敛）：
- **无单一万能手段**，能否触发客户端重试完全由 commit 阶段决定。pre-commit（真实 status/`x-should-retry` 头）= 主力可靠；post-commit 客户端重试窗口窄到「第一个 `content_block_stop`（含合成 anchor 空 text 块、含 thinking）之前」，真实流一旦完成任何块即关窗。
- **post-commit 可重试错误按到达形态分三路**：runRequest 阶段→既有 S4 请求侧策略；响应流截断/RST→block-level buffered retry（Phase 6 GATED 依赖其 P1）；上游流内 `event:error` 帧→`sawUpstreamError` commit+fail 不重放→本特性 canonical 终局帧整形（S5 rewrite errorFrameCanonical order=50 + 六 raw-stream 终点收编）。
- **不可重试+用户可动作**（content_filtered/402/403-permission）→ AskUserQuestion（config 门控默认关、仅交互式、options 是 CC schema `{label,description}` 对象、按 `ApiError.status` 分流 auth）。
- **自愈委派可配置**（按反应式策略 `.name` 带 `-retry` 后缀）：透传匹配 CC 自愈腿的 400 让 CC 自剥重发；只过滤反应式 `RetryStrategy`、不碰 always-on quarantine。

**跨特性依赖**：Phase 6 依赖 [[project-block-level-buffered-retry-execution]] 的 P1 默认翻转（gated）；Phase 3 canonical 尾帧与 block-level P1 Task 6 有跨 worktree 同行冲突风险。

方法论教训见 [[methodology-exhaust-then-choose-over-single-solution]]（调研穷举）+ [[methodology-cross-phase-integration-seam-only-caught-at-merged-state]]（执行期跨 phase 缝 + Critical wire bug）。
