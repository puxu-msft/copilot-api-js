# Master Plan：InboundCodec / CellAssembly 重构（C0-C6）

设计源（WHY+契约）：[RFC 2026-07-13](../rfc/2026-07-13-inbound-codec-outbound-leg-split.md)——**权威读 §0.1（三轮裁决）+ §11（定稿设计 v2）+ §11.9（v3 修订,含 HIGH-A/HIGH-B 红线）**。§2-§10 是被取代的 v1。
本文（HOW+锚点）：每 commit 的 factory 锚点表 + TDD 步骤 + commit invariant。per-commit kickoff 见 [prompts/](prompts/)。
状态：设计收敛（两轮对抗 review,第二轮判"可进 plan"）→ 待 subagent 逐 commit 实现。

## 全局 commit invariant（每 commit 终态）
1. `bun run typecheck` 0 + `bun test` 全套件通过（**base 6 例外**:UI shell 404 / negotiation / 4 peer-D2 pipelineInfo——非本重构引入,别动）。
2. **现状 6 格 + 前向 + 反向腿行为逐字节/oracle 等价**（golden 锁,含 C0 补的 3 条 byte golden）——纯结构重构,直到某处被有意改。
3. **无双活过渡态**（hybrid dispatch 互斥,旧路径同 commit dead）。
4. 细粒度 pathspec 提交,conventional commits,无模型署名。

## 红线（RFC §11.9,写进每个相关 prompt）
- **R1（HIGH-A）**：**绝不把 auto-truncate 当 clientFormat 标量**。`RETRY_SEMANTICS[cf](env)` 读 `env.targetEndpoint`——`(openai-responses, /v1/messages)` cell auto-truncate **ON**、其 direct 腿 **OFF**。C2/C4 必为该 corner cell 加"auto-truncate 在栈内"golden。
- **R2（HIGH-B）**：请求生命周期稳定态（truncateBaseline / resanitize / betaProbe 句柄 / anthropic-beta 种子）住 **`env.requestState` 新 readonly 字段**,**绝不入 replace-semantics 的 `prepareHints`**（会被首次带 hint 的 retry 清空）。
- **R3（betaProbe）**：betaProbe 引用共享 + retry 时**惰性** `getCandidates()`,**绝非构造期 eager 快照**（重造 Phase-7 隐蔽 bug）。
- **R4（真工厂,Phase 7 教训）**：**绝不用 `strategies:[]` 注入 / `inspectRequest` dry-run 绕过真装配器**——IT 真驱动 `resolveCellAssembly`→`buildStrategies` 到 mock transport + 负样本对照证真捕获。
- **R5（byte-critical）**：转发客户端 SSE 逐字节 golden 硬 gate;上游 wire/history 用结构/GHC oracle（`large-refactor` §7）。

## Cell 空间（12 活 cell,第二轮 reviewer 核过的真实策略栈）
| clientFormat | targetEndpoint | wire builder | RETRY_SEMANTICS(cf,te) | maxRetries |
|---|---|---|---|---|
| anthropic | /v1/messages | Anthropic | auto-truncate ✓ | 5 |
| anthropic | /chat,/responses (前向) | CC | ✓ | 5 |
| openai-cc | /chat,/responses | CC | ✓ | 5 |
| openai-cc | /v1/messages (反向) | Anthropic | ✓ | 5 |
| gemini | /chat,/responses | CC | ✓ | 5 |
| gemini | /v1/messages (反向) | Anthropic | ✓ | 5 |
| **openai-responses** | **/responses,/chat (direct/fallback)** | **Responses** | **✗（R1 corner）** | **1** |
| **openai-responses** | **/v1/messages (反向)** | **Anthropic** | **✓（R1 corner）** | **1** |

## Factory 锚点表（C2-C4 是**提取不重写**,原样搬算法核）
| 搬去 | 算法核（file:line,原样搬）|
|---|---|
| `AnthropicCellAssembly` (/v1/messages) | `buildAnthropicStrategies`（`codec/anthropic/strategies.ts:95`）、`createAnthropicSanitizeRewrite`（`codec/anthropic/request-rewrite-adapter.ts:57`,order 300）、`runAnthropicPayloadRewrites`（`anthropic/payload-rewrites.ts:154`）、`prepareAnthropicRequest`（`anthropic/request-preparation.ts:520`）、反向 `reverse-anthropic-rewrite.ts`（3 export:`createReverseAnthropicMapperHolder:55`/`buildReverseResanitize:73`/`createReverseAnthropicSanitizeRewrite:82`）|
| `OpenAiCcCellAssembly` (/chat/completions) | `buildOpenAiCcStrategies`（`codec/openai-cc/strategies.ts:48`）、`prepareChatCompletionsRequest`（`openai/request-preparation.ts:41`）|
| `OpenAiResponsesCellAssembly` (/responses+ws) | `buildOpenAiResponsesStrategiesForEnv`（`codec/openai-responses/strategies.ts:53`）、`translateChatCompletionsToResponses`（`openai/translate/cc-to-responses.ts:53`）、`prepareResponsesRequest`（`openai/request-preparation.ts:64`）|
| `hub`（HIGH-1 提取）| `renderResponsesFrameToCc`（`codec/openai-cc/codec.ts:607`,私有→hub）+ `createStreamTranslator`（`openai/translate/responses-to-cc-stream.ts:28`）——gemini/cc via-responses 的 Responses→CC 逐帧原语 |
| `RETRY_SEMANTICS[cf](env)` | 从 4 handler 的 strategies 工厂提取语义 spec（auto-truncate/maxRetries/label,R1 读 env.targetEndpoint）|

## Commit 序（DAG + TDD,详见 prompts/）
- **C0（前置,最关键）**：① 跑通现有 79 golden 锁行为;② **补 3 条缺失 byte golden**——(a) **keepalive-ON** anchored direct 流式（`direct-stream-golden-phase4` 关了心跳,anchored/reconcile 字节没锁）、(b) reverse @messages **转发逐帧** byte（现 reverse-cc-messages 用 inspectRequest+accumulator,非 SSE 逐帧）、(c) responses-ws + gemini 两跳终帧。**在改动前 HEAD 跑通、锁定**。
- **C1**：`CellAssembly` 接口 + `OUTBOUND_LEGS`/`RETRY_SEMANTICS` 两穷尽 Record（占位 throw）+ driver `resolveCellAssembly` + **hybrid dispatch shim**（具名"已迁腿集合"常量,初值空）。**未接线,过渡态无害**。+ `env.requestState` readonly 字段（R2）。
- **C2**：`AnthropicCellAssembly` 提取 + driver 对 /v1/messages 腿的 **4 route 全切**（messages direct + cc/responses/gemini 反向）+ 同 commit 删 4 handler 的 reverse 供料/betaProbe/mapperHolder + anthropic codec direct 分支。守卫:`grep createReverseAnthropicSanitizeRewrite/prepareReverseAnthropicWire` 归零 + **reverse orphan-strip 不翻倍** + **pipelineInfo 经 ctx 非空**（direct anthropic 重试后 messageMapping/cacheControlStripped 正样本）+ **R1 corner golden**（openai-responses 反向 auto-truncate 在栈）。
- **C3**：`OpenAiCcCellAssembly` + driver 切 cc direct + anthropic/gemini 前向 @cc + 删 cc wire 分支 + anthropic ccDelegate 前向分支。
- **C4**：`OpenAiResponsesCellAssembly`（含 CC→Responses wire + ws）+ driver 切 responses direct + 前向/反向 @responses + **R1 corner**（responses direct auto-truncate OFF golden）。exchange 载体（R2/§11.2c:responseId/itemId/**rebuiltMessages**,per-request scratch）。
- **C5**：InboundCodec 收敛（去已迁出站方法,补 renderNonStreaming/getContext）+ 删 strategy-registry 供料袋/`assembleStrategiesForEndpoint`/`createResponseAccumulator` 死方法 + hybrid shim 退化。**前置门（机检）**：`grep assembleStrategiesForEndpoint/StrategySupply/ccDelegate/isForwardTranslateLeg` 归零 + hybrid"已迁腿集合"= 全集 → 断言 shim 收敛。
- **C6**：清理 + **gemini 命名剥前缀**（`OpenAiGemini*`→`Gemini*`,`codec/openai-gemini/`→`codec/gemini/`,dry-run `openai-gemini`→`gemini`,零数据迁移,见 kickoff §命名）+ doc-sync（DESIGN.md 翻译矩阵行改 cell-assembly 架构 + 记忆 stub）。

## 测试锚点
- Golden 预捕获点：C0（3 条 byte golden + 现有 79）。
- 独立 oracle：真装配器 IT（负样本对照,R4）、Anthropic SDK（流式）、reverse 消费者累加器、R1 corner auto-truncate-在栈。
- L1 存在性守卫：每 cell resolveCellAssembly 成功 + buildStrategies 非空不 throw（Phase 7 bug 直接守卫）。
- 隔离:DI/fetch-mock、useIsolatedRuntime、活服务器实测用隔离 XDG_DATA_HOME。
