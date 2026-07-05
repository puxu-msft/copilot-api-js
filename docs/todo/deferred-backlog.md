# 暂缓 backlog（从记忆库归位）

从记忆库降为引用层（2026-07-05）时归位的活 backlog。每条：现状 / 暂缓原因 / 若做需改什么。

## GHC memory_tool 默认关 — CAPI 接受性待探针

- **现状**：`anthropic.memory_tool` 默认关。GHC 只在 BYOK 直连注入 `memory_20250818`、CAPI 路径不注入，故本项目经 CAPI 发该 server-tool 类型 + `context-management` beta 的**接受性未实测**。
- **若做**：先用探针 / history `sseEvents` 实测 CAPI 是否接受（见 skill `empirical-verification`）；被拒时 `unsupported-beta-retry` 只自愈 beta、body 里的 tool 类型无自愈（属未来工作）。保持关直到实测接受。
- **权威现状**：skill `ghc-api-reference` + `docs/plan/ghc-feature-alignment-tool-search-cache-ttl-memory.md`。

## context-edits 回执 telemetry（7d 分布）

- **现状**：`applied_edits` 诊断回执已落地（commit f55fd93，`src/lib/anthropic/applied-context-edits.ts`，流式经 accumulator `message_delta` / 非流式经 handler 顶层，两路发 `recordFeature("context-edits-applied", {count, clearedInputTokens, types})`），进 observability feature 维度计数。
- **暂缓**（用户 2026-06-29"暂时不做"）：接进 `request-telemetry` 做 7d 持久分布（现只 feature 维度计数，无 cleared token 量直方图）；实证开启 `protectStreamingEscalateContext` / `contextEditingMode` 后真有非空 `applied_edits`（当前样本 req_1782713407242_1 全空回执）。
- **原因**：命中率 / 价值未知，先收集 feature 计数再决定是否加 telemetry 维度（YAGNI）。遥测架构见 skill `telemetry-architecture`。

## RFC 数据模型裁剪审计 — 剩余低信号

- **现状**：12 个优先 RFC 已审（2026-06-24，4 并行 subagent + 主线核验）零 richest-data-flow 裁剪违规，3 个 SHOULD-BUILD 全实现（非流式语义残缺检测 / 顶层 `failureReason` 投影 / HTTP2 trailers 捕获，commit `0284935`/`6fd6d4d`/`e30ca33`）。判据已内化进 ADR `docs/decisions/2026-07-05-richest-data-flow.md`。完整审计叙事见 `docs/archive/memory/project-audit-rfcs-data-model-pruning.md`。
- **未审（低信号）**：非优先 RFC（p2.6 / upstream-http2 / tool-call-text-recovery）、observability sinks 的 filter 逻辑、dry-run `fidelity.caveats`（subagent 判为诚实文档非裁剪，可复核）。
- **判据**：字段 / 腿 / per-attempt 描述真实可观测阶段即须完整存（前端可不展示）；区分「裁剪数据模型」（禁止）vs「收敛捕获机制 / 单一 owner」（允许）。
