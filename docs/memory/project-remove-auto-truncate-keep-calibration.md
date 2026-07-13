---
name: project-remove-auto-truncate-keep-calibration
description: auto-truncate 截断本体已移除、calibration 重定位为本地计数增强（已实施完成，未合并 master）
metadata: 
  node_type: memory
  type: project
  originSessionId: 68b74fa0-5d30-4697-b816-b37fa7063b7d
---

移除 auto-truncate 截断本体（反应式截断/压缩请求 payload，破坏 KV cache、效果差、CC 自理），**保留 calibration 因子模型并重定位为「本地 token 计数准确度增强」**。隔离 worktree `feat/remove-auto-truncate`，Phase 0-8 全落地、inline 执行。

**三承重决策**（用户裁定）：① 共享重试预算 `autoTruncateMaxRetries`→`maxReactiveRetries`/config `retry.max_reactive_retries`（实为 17→16 策略后仍全策略共享、非截断专属，经 `adapt` 闭包喂每策略，绝不能删只能改名）；② 400 学习腿从内嵌 `onTokenLimitExceeded`（随反应式截断策略删）解耦为独立 `CalibrationFailureSink`（订阅 `request.failed` statusCode 400，`extractTokenLimitFromResponseText(rawBody)` fallback `parseTokenLimitError`）；③ 新 config `anthropic.use_upstream_count_tokens`（默认 on）。

**caliber 统一**（RFC §3.4）：成功腿/400腿/count-tokens 消费腿三方 est 一律 `countTotalInputTokens`（input-only，对齐上游 `usage.input_tokens`），顺带修 landed 成功腿的 `countTotalTokens` 潜在错配。**calibrate() 活消费者**=count-tokens 本地兜底 + debug `/api/debug/calibration-probe`（原 `/dry-run-truncate` 重写），否则死代码。

**承重坑**：① 冷启动 `start.ts` 的 `loadPersistedLimits()` 原被 `state.autoTruncate` 门控——删标志须改**无条件**否则 seed/持久化不加载、`calibrate` 退化恒等（reviewer HIGH-1）；② `"truncated"` 字面量重载——FeatureKind `"truncated"`（删）vs `TerminalOutcome.kind:"truncated"`（**留**，删了打爆 4 流式路径），不能 grep 一把梭。

**RFC-first**：spec→RFC→plan 各经独立对抗 review（3 HIGH+3 MEDIUM 亲手复核属实后采纳）。**遗留 deferred**（`docs/todo/deferred-backlog.md`）：orphan-filter 五函数 + `preSend?` 缝 + `PipelineInfo.truncation` 字段现死代码、待单独 review 裁决删除。

**并发教训**：分支从旧 master `df3cfb1f` branch，master 已 +35 commit（config/state/handler/DESIGN 大量重叠），rebase 有真冲突风险；全量 `bun test` 6 个 pre-existing 失败（负 negotiation 类别数 + 4 request-rewrite golden 的 `streamIdleTimeoutMs` + design-doc-tree 的 poisoned/web-search 路径）均 master 先失败、非本分支引入。

权威看 RFC/plan `docs/{rfc,plan}/2026-07-13-remove-auto-truncate-keep-calibration.md` + `docs/DESIGN.md`「token-count calibration」行。相关 [[project-universal-translation-matrix]]（strategy stack）。
