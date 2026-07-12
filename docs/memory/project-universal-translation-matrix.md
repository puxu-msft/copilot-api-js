---
name: project-universal-translation-matrix
description: 通用入站×出站翻译矩阵大特性——设计定稿(4轮review)+Phase 0-5 landed(4入站×3出站全矩阵前向+反向全通:非流式+流式),仅 Phase 6 doc-sync 待做,权威看 RFC/ADR/plan
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
- **Phase 5 已 landed master（FF `b00d52e2`，反向格子全通——4入站×3出站全矩阵前向+反向端到端可用）**：新 `anthropic-to-cc-stream.ts` 反向流式 translator（逐帧穷举表：丢弃块 delta swallow / CC tool index 独立计数器逆折叠 / thinking·server_tool_use drop / message_delta→finish+usage gross-up / ping swallow / error→CC error chunk / F2 截断）+ cc/responses/gemini 三 codec MESSAGES 腿五方法接线（translateOut 经 hub 产 Anthropic body / prepareWire 产 Anthropic wire / renderResponse 驱动反向 translator / createResponseAccumulator 返 Anthropic acc / sampleRequest Anthropic 形）+ 三 handler **专属反向 pump**（无心跳，`onUpstreamFrame`→Anthropic 累加器记 honest outbound，非复用现状 pump）+ 反向专属 `reverse-anthropic-rewrite.ts`（Anthropic mapper，**非**复用读 CC mapper 的 `createAnthropicSanitizeRewrite`）+ responses reverse-exchange（`TranslateExchangeContext` 穿流式+非流式）。**W2 门控 CLEARED**（探针实测 GHC Anthropic 腿接受任意前缀入站 tool_use.id，`call_*` verbatim 透传成立）。
  - **kickoff 对抗审查（交付前）抓 4 BLOCK + 2 MEDIUM 全采纳**：① 反向 pump 非平凡复用（须专属 pump，`createResponseAccumulator` 实测无生产消费者、改它无用）② responses 二跳 translator 吃 `TranslateExchangeContext` 非 modelId ③ 反向 sanitize 不能复用闭包 CC mapper 的 rewrite ④ resanitize 内联 Anthropic mapper 同源 ⑤ 帧表 swallow（server_tool_use 的 input_json_delta）⑥ usage helper export + 流式组装。
  - **实现后独立 code review（主会话补，非自派）抓 HIGH-1 + MEDIUM-1，已修（`b00d52e2`）**：三反向 pump 缺 `anthropicAcc.streamError` 门（H2 终端上游 error 帧被误判截断→吞真实 code/message + 客户端双 error 终止帧，never-swallow 违规），直连 Anthropic pump 有此门反向没有。修=抽共享 `classifyReverseAnthropicTerminal`（upstream-error→truncated→complete 优先序，`fix-all-comparison-sites` 单一事实源防三 pump 漂移）+ 单测正样本对照（error 帧 sawMessageStop=false 须分类 upstream-error 非 truncated）；MEDIUM-1 统一截断信号为 `!sawMessageStop`（对齐直连 pump，cc/responses 原用 finishReason 会漏「message_delta 后 message_stop 前被切」）。**教训：现有反向 IT 只覆盖正常 message_delta+message_stop 流，无终端 error 帧用例——otherwise-green 掩盖 error 分支缺陷。**
- **Phase 6 doc-sync 待做**：DESIGN.md 活的架构现状加反向格子行 + 矩阵表 + 二维门控轴 + @messages 后缀语法 + NIT-E「thinking signature 硬约束天然规避」点明；消化 M1/M2 待办（见 plan Phase 4 记录）。
- **反向 L2 buffered-retry 截断重试暂缓（OQ6，RFC §7.3 记录的独立工作）**：反向上游 Anthropic 截断经 `classifyReverseAnthropicTerminal` → ctx.fail 无自动重试，记 `docs/todo/deferred-backlog.md`。
- **执行教训**：subagent 自派的 review 独立性不足（P3 它漏了 B1；P5 反向 pump 缺 streamError 门也是自派测试盲区）——主会话必补独立 code review + 亲自复证 reviewer 断言（读 file:line、跑测试）；usage 净值是 spot-unneeded-homegrown 高发点（翻译层重演）。P4/P5 并发合并：peer 高频提交下 rebase→FF-only 陷无限竞态 → 隔离 worktree rebase（干净处理冲突）+ 主树 FF（peer WIP 不重叠时安全）或 `--no-ff` merge 脱离；文件显 ` M` 但 `git diff HEAD`=0 是 stat 噪声；**`master..HEAD` 在 peer 前进后显假象删除（peer 新增文件在我分支点后），真实净改动看 `mergeBase..HEAD`**。**PROBE-FINDINGS.md 是被跟踪的（记忆旧述"gitignored"过时，exp/ 匹配 gitignore 但该文件已被跟踪、修改照常提交）。**

**每 phase 执行范式**（已跑通 3 次）：写 self-contained kickoff → 隔离 worktree(`.worktrees/`)+node_modules symlink → subagent 实现逐 commit → **主会话亲自核实承重断言**（golden 零回归/typecheck/红线非空洞，不信自证）→ 独立 code review → rebase+FF 合并 → 清理 worktree + doc-sync 记录偏离。

**承重设计约束**（实现时勿违）：反向请求侧绝不合成 Anthropic thinking 块（无 signature 撞 GHC 400/毒化 [[project-universal-translation-matrix]] 见 skill `ghc-anthropic-upstream`）；反向流式 Anthropic→CC 逐帧表须覆盖 server_tool_use/content_block_stop/error/ping（真实帧集 [stream-accumulator.ts:156-334](../../src/lib/anthropic/stream-accumulator.ts#L156)）；Google `/responses` 坏腿 force-fallback 按 targetEndpoint 拦截。

**方法论收获**（RFC-first 价值实证）：四轮对抗 review FAIL 数 5→3→2→2 递减、性质从架构缺陷降到落地完整性；两个隐蔽承重 FAIL（handler 崩坏、reasoning 撞 300s 断连）全在写代码前挡下 → skill `large-refactor`。
