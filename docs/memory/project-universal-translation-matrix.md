---
name: project-universal-translation-matrix
description: 通用入站×出站翻译矩阵大特性——设计定稿(4轮review)+Phase 0/1/2/3/4 landed(前向腿全通:非流式+流式),Phase 5-6 待做,权威看 RFC/ADR/plan
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
- **Phase 0/1/2/3 已 landed master**：
  - P0（decideRoute→router 纯重构，golden 锁等价）：偏离 router 保 env 签名 + DI seam。
  - P1（路由骨架+二维门控切换）：resolveModelTarget 后缀双层剥离 + RouteInput 全矩阵决策树 + 改写 appliesTo clientFormat→targetEndpoint + registry 全格式装配 + routeOverride 观测落库。**翻译腿 fail-fast**（未接翻译前 throw，不返回坏数据）。code-review 修 WARN-1（反向 @messages 静默降级→对称响亮 throw）。
  - P2（hub 共享层 + 一对 Anthropic↔CC 请求翻译器）：`hub-translate.ts` 全矩阵分派 fail-loud + `anthropic-to-cc-request.ts`（spec §6 全表）+ `cc-to-anthropic-request.ts`（WARN-E 红线：绝不合成 thinking）。anthropic translateOut 委托 hub 产 CC wire（dry-run 验），响应侧 Phase 2 仍 fail-fast。
  - P3（非流式响应两向）：`cc-to-anthropic.ts` + `anthropic-to-cc.ts`（多 choices 折回 + tool-input-repair 降级 + refusal 转发）。renderResponseNonStreaming 委托 hub → **anthropic→cc 非流式端到端通**（流式仍 fail-fast，Phase 4）。**双 reviewer 抓 B1**（usage 净值双计，hand-rolled 绕过 battle-tested netInputTokens；false-green 单测钉死错值）→ 复用 netInputTokens 修正、反向对称 gross-up（W-rev）。T3.4 createResponseAccumulator 生产零调用 → 推 Phase 4。
- **Phase 4 已 landed（merge commit 5146d893，最难 byte-critical）**：`cc-to-anthropic-stream.ts` 正向流式 translator（单一单调 block-index 计数器 W1 / reasoning 识别丢弃不合成 thinking W2 / message_start input_tokens:0 占位复用 netInputTokens W3 / 多 choices 折叠 / N1 全合成点 anthropicSseFrame）+ handler `pumpTranslateLegStreamingV4`（**direct pump byte-critical 逐字节不动**，翻译腿复用同一 makeAnchoredSseSink 心跳+live-reconcile，非镜像 gemini 无心跳）+ createResponseAccumulator(env) 按腿分派 + cc 单跳/responses 二跳。反向流式仍 fail-fast（Phase 5）。**三轮独立 review 收敛 APPROVE**，2 轮独立收敛同一 CRITICAL（flush 收尾帧原写裸 sink 绕过 reconcile +1 remap → empty_text anchor 下悬挂块崩 SDK MessageStream，主场景零覆盖）已修+回归测试。M1/M2/N1 记 plan 待办。
- **Phase 5-6 待做**：5 反向格子接线(cc/responses/gemini→messages)、6 doc-sync。每 phase kickoff 在 `prompts/`（phase-0/1/2/3/4 已写）。
- **Phase 5 前置门控**（P2 review 记 plan）：W2 OQ3 inbound 接受性须探针（只测过 outbound）、W3 反向 empty/占位守卫、W4 @responses 端到端 IT。
- **执行教训**：subagent 自派的 review 独立性不足（P3 它漏了 B1）——主会话必补独立 code review；usage 净值是 spot-unneeded-homegrown 高发点（翻译层重演）。P4 并发合并：peer 高频提交下 rebase→FF-only 陷无限竞态（每次 rebase 后 master 又前进）→ 用 `--no-ff` merge 脱离（不要求 base=master、零重叠不冲突）；文件显 ` M` 但 `git diff HEAD`=0 是 stat 噪声（subagent 碰过 mtime 变、内容同），别误判为 peer WIP 而阻塞。

**每 phase 执行范式**（已跑通 3 次）：写 self-contained kickoff → 隔离 worktree(`.worktrees/`)+node_modules symlink → subagent 实现逐 commit → **主会话亲自核实承重断言**（golden 零回归/typecheck/红线非空洞，不信自证）→ 独立 code review → rebase+FF 合并 → 清理 worktree + doc-sync 记录偏离。

**承重设计约束**（实现时勿违）：反向请求侧绝不合成 Anthropic thinking 块（无 signature 撞 GHC 400/毒化 [[project-universal-translation-matrix]] 见 skill `ghc-anthropic-upstream`）；反向流式 Anthropic→CC 逐帧表须覆盖 server_tool_use/content_block_stop/error/ping（真实帧集 [stream-accumulator.ts:156-334](../../src/lib/anthropic/stream-accumulator.ts#L156)）；Google `/responses` 坏腿 force-fallback 按 targetEndpoint 拦截。

**方法论收获**（RFC-first 价值实证）：四轮对抗 review FAIL 数 5→3→2→2 递减、性质从架构缺陷降到落地完整性；两个隐蔽承重 FAIL（handler 崩坏、reasoning 撞 300s 断连）全在写代码前挡下 → skill `large-refactor`。
