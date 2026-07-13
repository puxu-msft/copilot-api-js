---
name: project-upstream-error-client-shaping
description: 上游错误→客户端可行动形态整形大特性（spec v2.3 定稿 + 分阶段 plan 落盘，评审中，未实现）
metadata: 
  node_type: memory
  type: project
  originSessionId: 1a1428a4-9c8e-4a9d-98f3-08d5bf495030
---

**上游报错时不再拼「普通 text/error 帧让 CC 停下」，而是按 commit 阶段分治整形**成客户端会妥当处理的形态。源起用户诉求：可重试的触发客户端重试、不可重试且用户可动作的包装成 AskUserQuestion。

**权威**：spec [docs/spec/2026-07-13-upstream-error-client-shaping.md](../../docs/spec/2026-07-13-upstream-error-client-shaping.md)（v2.3，四轮对抗评审全闭合）；plan [docs/plan/2026-07-13-upstream-error-client-shaping/](../../docs/plan/2026-07-13-upstream-error-client-shaping/)（9 文件，Phase 0-5 独立可交付 + Phase 6 GATED）；调研底座 [exp/cc-error-retry-surface/](../../exp/cc-error-retry-surface/)（FINDINGS 源码穷举 + REPORT 真 CC 实测 + 可复跑 fake server harness）。

**承重设计结论**（实测 + 源码 + 对抗评审三方收敛）：
- **无单一万能手段**，能否触发客户端重试完全由 commit 阶段决定。pre-commit（真实 status/`x-should-retry` 头，`Bo()`=false 门开）= 主力可靠；post-commit 客户端重试窗口窄到「第一个 `content_block_stop`（含合成 anchor 空 text 块、含 thinking）之前」，真实流一旦完成任何块即关窗。
- **post-commit 可重试错误按到达形态分三路**：runRequest 阶段→既有 S4 请求侧策略；响应流截断/RST→block-level buffered retry（依赖其 P1 落地，G-4 前置）；上游流内 `event:error` 帧→`sawUpstreamError` commit+fail 不重放→本特性做 canonical 终局帧整形。
- **不可重试+用户可动作**（content_filtered/402/403-permission）→ AskUserQuestion（config 门控默认关、仅交互式、纯信息展示、按 `ApiError.status` 分流 auth）。
- **自愈委派可配置**（按反应式策略名）：语义匹配 CC 自愈腿的 400 透传让 CC 自剥重发（sig-conv 端到端实测证；不碰 always-on quarantine）。

**关键实测数**（REPORT）：post-commit overloaded 完成块后不重试(hits=1)/未完成才重试(hits=3)；api_error 零客户端重试；TCP-reset 越过 thinking 块但空 text anchor stop 仍关窗；自愈委派 thinking-signature 6-7ms 立即重发+body 变小。

**跨特性依赖**：Phase 6 依赖 [[project-block-level-buffered-retry-execution]] 的 P1 默认翻转（gated 于用户 keepalive 实证门）；Phase 3 canonical 尾帧与 block-level P1 Task 6 有跨 worktree 同行冲突风险，缓解=封装单一纯函数 `buildCanonicalErrorFrame`。

方法论教训见 [[methodology-exhaust-then-choose-over-single-solution]]。
