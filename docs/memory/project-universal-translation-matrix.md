---
name: project-universal-translation-matrix
description: 通用入站×出站翻译矩阵大特性——设计定稿(4轮review)+Phase 0 landed，Phase 1-6 待做，权威看 RFC/ADR/plan
metadata:
  type: project
---

**通用 4 入站 × 3 出站翻译矩阵**（让任意客户端 SDK 用任意 GHC 模型）。源起：用户想让 Claude Code（Anthropic 客户端）的 subagent 用 gpt-5.5——现状 Anthropic `/v1/messages` 见非-Anthropic vendor 直接 400（[features.ts:40](../../src/lib/anthropic/features.ts#L40)），因 Anthropic codec 是 bypass-direct 无翻译能力。

**架构（3 ADR，都 Accepted）**：
- codec 纯化：`decideRoute` 从 FormatCodec 拆到 `src/lib/pipeline/router.ts` 自由函数 → [ADR](../decisions/2026-07-11-route-decision-separated-from-format-codec.md)。
- 全矩阵 hub-and-spoke：openai-cc 是翻译 hub，anthropic 是唯一孤岛；核心增量=一对 Anthropic↔CC 双向翻译器让 anthropic 接入 hub，逆用同时使能反向格子 → [ADR](../decisions/2026-07-11-universal-codec-translation-matrix.md)。
- 缝合模型 + 二维门控轴：**入站(clientFormat)定 parse/render/心跳，出站(targetEndpoint)定改写/策略/prepareWire/上游 accumulate**；改写 appliesTo 从 clientFormat 改 targetEndpoint（6 个 Anthropic 改写全是上游 wire 处理）。非「gemini 镜像」（gemini 客户端非 Claude Code、无心跳，而翻译路径客户端仍是 Claude Code、撞 300s 断连）。

**权威文档**：[RFC v5](../rfc/2026-07-11-anthropic-via-openai-translation.md)（四轮对抗 review 消解 10+ FAIL）+ [review 记录](../spec/anthropic-via-openai-translation-review.md) + [三层 plan](../plan/anthropic-via-openai-translation/plan.md)（7 phase + prompts/）+ 探针 `exp/anthropic-via-openai-translation/`（gitignored；cc 腿 claude 返 `toolu_*` 透传自洽、responses 腿 `call_*`、cc 腿 text/tool 拆多 choices）。

**进度**：
- **Phase 0 已 landed master**（`7d6b68f2`..`1c1891b5`，8 commit）：decideRoute→router 纯重构，golden 锁等价（52 pass）。两处自觉偏离记 [plan.md](../plan/anthropic-via-openai-translation/plan.md) 实施记录（router 保 env 签名非 RouteInput、DI seam `DriverDeps.decideRoute?`——RouteInput/routeOverride 解耦推 Phase 1）。
- **Phase 1-6 待做**：1 路由骨架+二维门控切换、2 hub+请求翻译、3 非流式响应、4 流式两向+handler 缝合(最难 byte-critical)、5 反向格子接线、6 doc-sync。DAG：0-4 串行 byte-critical、5 部分并行。每 phase kickoff 在 `prompts/`（仅 phase-0 已写，后续推进时展开）。

**承重设计约束**（实现时勿违）：反向请求侧绝不合成 Anthropic thinking 块（无 signature 撞 GHC 400/毒化 [[project-universal-translation-matrix]] 见 skill `ghc-anthropic-upstream`）；反向流式 Anthropic→CC 逐帧表须覆盖 server_tool_use/content_block_stop/error/ping（真实帧集 [stream-accumulator.ts:156-334](../../src/lib/anthropic/stream-accumulator.ts#L156)）；Google `/responses` 坏腿 force-fallback 按 targetEndpoint 拦截。

**方法论收获**（RFC-first 价值实证）：四轮对抗 review FAIL 数 5→3→2→2 递减、性质从架构缺陷降到落地完整性；两个隐蔽承重 FAIL（handler 崩坏、reasoning 撞 300s 断连）全在写代码前挡下 → skill `large-refactor`。
