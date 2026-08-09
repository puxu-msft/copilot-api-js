# 项目现状 stub（从 [MEMORY.md](MEMORY.md) 分出）

权威看正式归属（`docs/DESIGN.md` 活架构表 / spec / ADR / git log）；本页只作触发指针，**状态断言可能过期，动手前按 git 复核**。

- [领域包剥离执行技巧（token·telemetry landed）](methodology-domain-peel-execution-techniques.md) — 两型模板+共通技巧+ratchet 与守卫两类坑
- [state 降 foundation 叶子（landed `9ec79010`）](project-state-to-foundation-handover.md) — 实质产出是判据形状的演化；方法 → skill `reshaping-a-bypassed-guard`
- [续写重试（P2 landed de37feff，P3-P7 待续）](project-continuation-retry-sequential-anchor.md) — 首块后 cut 合成 continuation 缝合
- [max_tokens 续传 + keepalive 边界](project-max-tokens-continuation-spec.md) — P0 landed 3bb1262a·P1 未开工；截断三分型；inter-block allocator 方案 A 实施中，见 [timeout-safety](project-keepalive-unconditional-timeout-safety-landed.md)；接手先读 `docs/plan/2026-07-27-handover-max-tokens-and-keepalive.md`
- [History 三件](project-history-search-out-of-process.md) — 搜索 sidecar=独立常驻 systemd 服务；[三层归档](project-history-tiered-archive.md) move 永不真删；[client-upstream 双腿](project-history-client-upstream-legs-landed.md) clientRequest/Response+model{}+attempts[]
- [合成/改写帧 forwarded 轨完整性（landed）](project-synthetic-frame-forwarded-track-completeness-spec.md) — Unit1 前提被 V3 实测推翻
- [Responses 三件（buffered-merge landed）](project-responses-buffered-merge-landed.md) — 托管 reducer+两旋钮；[tier-1 硬化 + runtime-split](reference-undici-websocket-runtime-split-bun-vs-node.md) Bun 原生 WS 有 ping / Node undici 无 ping
- [transport 配置三轴归位 2c19c7cf](project-transport-config-three-axis-reorg.md) — timeouts/upstream_transport/responses_ws；[h2 池按容量选路 36cf45bf](project-h2-pool-capacity-routing-and-pre-response-retry.md)
- [上游静默 commit 时机与 direct live B2](project-upstream-silence-commit-timing-spec.md) — 已本地集成，buffered/translated 待续；接手看 `docs/plan/2026-07-23-handover-h2-pool-and-silence-spec.md`
- [对称四点 hook 架构 v3 2a77bf7c](project-symmetric-four-point-hooks.md) — client/upstream×in/out+exchange；[v2 中间件已退役](project-upstream-hook-middleware.md)；hook 帧进上游轨必打 synthetic 标记
- [请求生命周期 cancel/settle/quiesce（landed）](project-request-lifecycle-cancel-settle-quiesce.md) — 多根因；[首包时序埋点 f982e0e3](project-request-timing-instrumentation-landed.md) 上游4刻/客户端3刻/DDSketch
- [AskUserQuestion 顶层 question 键抢救（landed）](methodology-plan-verify-interface-location-and-wiring-channel.md) — salvage→兜底 header→strip
- [block 级缓冲重试 c2012555（landed）](project-block-level-buffered-retry-execution.md) — 默认值分 vendor：Anthropic `protect_streaming_generation` false / Responses·CC `buffered_retry` **true**（`config.yaml` 为准，DESIGN.md 该行已漂移）；[上游错误→客户端形态整形 5202f110](project-upstream-error-client-shaping.md) 按 commit 阶段分治
- [翻译四件（均 landed）](project-universal-translation-matrix.md) — 4入站×3出站 hub-spoke·反向绝不合成 thinking；[直接桥](project-anthropic-responses-direct-bridge.md)；[reasoning 透传](project-reasoning-passthrough-synthetic-thinking.md) 标签封装签名 round-trip；[codec cell-assembly](project-inbound-outbound-cell-assembly-refactor.md) 双轴穷尽 Record
- [unknown endpoint 日志（权威 spec）](../spec/2026-07-14-unknown-endpoint-logging.md) — 404/405/route-owned 三态；[auto-truncate 移除 06c56644](project-remove-auto-truncate-keep-calibration.md)；[web_search 双跳退役](project-web-search-double-hop-retired.md) 称职实现≠有需求
- [遥测分层持久化（landed）](project-telemetry-tiered-storage.md) — telemetry.db 三层 rollup+DDSketch；cost 防 2^53
- [交互式 TUI live 面板（P0 merge，P1/P2 待做）](project-tui-interactive-live-panel.md) — 折叠 footer↔面板↔detail
- [ui-v4 shadcn 重设计（未实施）](project-ui-v4-shadcn-redesign-decisions.md) — new-york+锐角+Amber+布局 A；[代码由 agent 协作编写](feedback-ui-v4-code-authored-by-agents.md)；[样式分叉先问](feedback-discuss-styling-before-deciding.md) 列选项+推荐再 AskUserQuestion
- [v4 流水线重构（landed）](project-v4-pipeline-rearchitecture.md) — v4 P0-P3+response-pipeline Stage A/B；[GHC 三特性对齐](project-ghc-feature-alignment-landed.md) tool-search default-allow·extended-cache-ttl·memory tool；[thinking 400 三层修复](../spec/2026-07-07-thinking-signature-quarantine.md) 根因=相邻性
- [反应式学习 TTL 生命周期 67afa1af](project-negotiation-learning-lifecycle-landed.md) — per-entry TTL+pin；[后台 agent 结果 surfacing 故障](methodology-background-agent-result-surfacing-failure.md) result 正文空且救不回

## 已删除记忆的话题去向

通用工作原则 → user-rule + CLAUDE.md + skill `closing-a-development-session` / `writing-handover-docs` / `git-preference`。完成叙事 → `docs/archive/memory/`。调试参考 → on-demand skills（`bun-node-runtime-gotchas` / `debugging-*` / `ghc-*`）。
**两个从未存在的 memory 已改指正式归属**（2026-08-02）：语言规则 → user-rule `10-text-formatting`；`project-unknown-endpoint-logging` → [spec](../spec/2026-07-14-unknown-endpoint-logging.md) + `DESIGN.md` 活架构表。
