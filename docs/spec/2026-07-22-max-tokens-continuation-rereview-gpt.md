# 复审报告（异模型对抗）：`max_tokens` 续传 spec 修订版

> 评审范围：`/home/xp/src/copilot-api-js/docs/spec/2026-07-22-max-tokens-continuation.md` 修订版，重点复核上轮 blocker/major 消化、用户裁决后的 transparent-stitch、后端忠实记录和多策略配置。
>
> 已核实证据：当前 master `src/lib/pipeline/driver.ts`、`src/routes/messages/handler-v4.ts`、`src/routes/chat-completions/handler-v4.ts`、`src/routes/responses/handler-v4.ts`、`src/lib/pipeline/delivery/session.ts`、各格式 streaming translator、`src/lib/pipeline/generation/coordinator.ts`、`src/lib/context/{model-operation-record,request}.ts`、`exp/continuation-shape/FINDINGS.md`。当前 `feat/continuation-retry` 的历史已合入 master，实际代码中已存在 continuation driver 分支、`continued` verdict 与 `runContinuation`。

**总体 verdict**：上轮的核心 blocker 与三个 major 已大体被认真消化，但修订版新增/暴露出 3 个会让 plan 走向错误实现的 major 矛盾。**暂不认可原样进入 plan 阶段**；修正下列 major 后可进入 plan，且无需重开用户已裁决的 Q1/Q2。

**blocker 数量**：0。

---

## 上轮发现消化核对

- **已消化**：虚构的 `ln` 已改为真实变量 `committedAny`。当前代码实际为 `src/lib/pipeline/driver.ts:1366` 的 `&& !committedAny`；变量名判断正确。
- **已消化**：§5.1 已将 success-side continuation 的 settle/finalize 问题提升为承重架构项，并明确依赖 `continued` verdict 的接口形状，非简单“姊妹 spec 是否 landed”的二元依赖。当前 master 也确有该接口：`src/lib/context/model-operation-record.ts:246,250` 定义 `continued`，`src/lib/pipeline/generation/coordinator.ts:143-154` 的 `runContinuation` 结算 parent 后建立 continuation candidate，`src/lib/context/request.ts:690` 已改为消费 `DispatchVerdict`。
- **已消化，但须在计划首步定案**：§11 已诚实揭示 P0 分型不应假装依赖 master 尚不存在的 ledger，并提出独立轻量累积器路线 (a)。这消除了原先“P0 无依赖”与“判定依赖 ledger”的自相矛盾；建议 plan 第一项将 (a) 明确裁决为唯一实现路线，并为其与 canonical ledger 的不同职责写边界测试，防止两者未来漂移。
- **已消化**：§3.2 已正确以 `exp/continuation-shape/FINDINGS.md:9` 的 G3 PASS 替代“完整 tool_use 前缀未验证”旧说法，并准确保留“完整块前缀接受 ≠ 丢弃 partial 后的 B 类重生成不会发散”的区分。
- **已消化**：§4/§9 把用户的透明呈现裁决与后端 richest-data-flow 完整记录分离，`perRoundStopReason`、`clientVisibleStopReason`、`suppressedMaxTokens` 的双视角要求是正确且必要的。

## 事实性发现

### [MAJOR] §5.2 的 `B-closed` 动作与姊妹 continuation 机制的 D3 硬门、以及 tool-use 的客户端语义冲突

- **问题**：§5.2 表把“已闭合 tool_use 后立即撞预算”的 `B-closed` 写成“等同 A 语义可续”，并仍称受“完整 tool_use 块作前缀未验证门”约束。前者与当前已经合入的姊妹机制冲突，后者与本 spec §3.2 已更正的 G3 PASS 自相矛盾。
- **代码证据**：`src/lib/pipeline/driver.ts:1416-1423` 的 continuation gate 明确要求 `!hasCompleteInteractiveToolUse(ledger.snapshot())`；`src/lib/pipeline/committed-blocks-ledger.ts:40` 的 predicate 用于阻止“完整、客户端须执行的 tool_use”后继续。`src/lib/pipeline/generation/coordinator.ts:143-154` 的 continuation 只是将未完成的逻辑生成交给新 exchange，不会也不应跳过客户端执行一个完整工具调用的回合边界。
- **失败场景**：模型已完整发出 client-interactive `tool_use`，客户端应执行工具并在下一回合带 `tool_result` 返回。若 proxy 因同一轮随后撞 `max_tokens` 而继续模型生成，模型会在没有 tool_result 的情况下越过合法 agent-loop turn boundary，得到的文本/下一工具调用没有可用的工具结果作为前提。这不是“像 text 一样可续”的情况。
- **建议**：删除 `B-closed = 等同 A 可续`。把它定义为“已形成完整 interactive tool_use 的正常 client turn boundary：转发 `tool_use`（以及该轮真实 max_tokens 终止形态），不自动 continuation；由客户端执行工具并接续”。如未来要支持 server_tool_use 或非交互工具的特殊情况，必须按工具类型另立分型与 PoC，不能复用 A 类。

### [MAJOR] §6 `visibility:passthrough` 的定义与同一 SSE 流自动续写在协议上不可同时成立

- **问题**：§6 将 `visibility:"passthrough"` 定义为“永不缝合、始终透传 max_tokens”，同时 `classes.text:"continue"` 又可要求自动续写。但一旦把 Anthropic `message_delta{stop_reason:max_tokens}` + `message_stop`、CC `finish_reason:length` 加 `[DONE]`、或 Responses `response.incomplete` 转给客户端，该客户端流已经合法终止，不能再在同一连接里附加 continuation 内容。
- **代码证据**：`src/lib/pipeline/delivery/session.ts:155` 把 `message_stop` 与 `response.completed` 标为 `terminalWritten`；Anthropic terminal 由 `src/routes/messages/handler-v4.ts:1404-1450` 以 `acc.sawMessageStop` 为完成判据；Chat Completions 在 `src/routes/chat-completions/handler-v4.ts:628-654` 结束时写 `[DONE]`；Responses 以 `response.completed/.incomplete/.failed` 为 lifecycle terminal（`src/routes/responses/handler-v4.ts:470-490`）。
- **失败场景**：实现者若按“passthrough 也仍继续”理解，在已写出的 `message_stop`/`[DONE]`/`response.incomplete` 后再写帧，会产生协议违规的双终局流；若不写续写帧，则 `classes.*:"continue"` 被静默忽略，配置语义不诚实。
- **建议**：在 spec 固化配置组合矩阵。推荐明确为：`visibility:transparent|marker` 才允许同一客户端流 continuation；`visibility:passthrough` 时自动 continuation **不启动**，该轮终止如实交给客户端（除非另行定义真实 side-channel API，该 API 当前不是本 spec 目标）。配置解析应拒绝或显式降级 `passthrough + classes.*:continue/retry_with_budget` 的组合，并在 history/telemetry 记录“strategy prevented stitch”，不得静默吞掉用户的 `continue` 设置。

### [MAJOR] §5.3 将“各格式 terminator 抑制点”等同于“该格式 commit-boundary 的终止帧”，与实际 pipeline 架构不符，尤其会误导 Anthropic/Chat/Responses 的实现挂点

- **问题**：§5.3:154 声称“各格式 terminator 抑制点 = 该格式 commit-boundary 的终止帧”。实际 pipeline 中，commit boundary、upstream termination detection、client-facing terminal emission 是不同层、不同时间点的概念；不能把它们合并成一个机制。
- **代码证据**：
  - Anthropic `src/lib/codec/anthropic/commit-boundaries.ts:1-30` 只把 `content_block_stop` 和 `error` 当 commit boundary，明确把 `message_stop` 排除；`message_delta/message_stop` 留在 terminal drain。当前 driver 在 `src/lib/pipeline/driver.ts:1327-1358` 发现 `sawMessageStop()` 后无条件 `flushBufferedFrames(buffer, true)`，所以 transparent-stitch 需要在“terminal drain 写客户端前”插入截获分支，不能改 `commitBoundaries` 就完成。
  - Chat Completions 对 Anthropic 上游的 `message_delta` 在 `src/lib/openai/translate/anthropic-to-cc-stream.ts:238-254` 当场翻译成 finish chunk；`message_stop` 自身不产生 CC 帧（:257-260），最终 `[DONE]` 又由 handler 在 `src/routes/chat-completions/handler-v4.ts:628-654` 单独补写。因此需同时拦住 inline finish/usage emission 与 handler 的 `[DONE]` synthesis，不能只说“抑制末 chunk”。
  - Responses 的不同腿也不同：`responses-to-cc-stream.ts:113-130` 直接在 `response.incomplete` 产出 CC finish；`anthropic-to-responses-stream.ts:472-490` 则在 flush 阶段合成 `response.completed`。这不是一个统一的 `response.incomplete` 写点。
- **失败场景**：按当前 spec 的笼统“终止帧等于 commit boundary”实施，可能仍让 translator/handler 写出一个 `finish_reason:length` 或 `[DONE]`，而后 driver 继续写 continuation；也可能错误吞掉为完成流所必需的 flush 生命周期帧。这会产生客户端协议破坏或卡死。
- **建议**：把 §5.3 升格为“每个 `(inbound format × outbound client format × direct/translate/fallback/WS)` leg 的 terminal ownership matrix”。每格明确四件事：① upstream completion 信号在哪里被 accumulator 记录；② client-visible terminator 由哪个 codec/translator/handler 构造；③ transparent 分支在该构造之前在哪一层截获；④ continuation 最终 completion 时谁且只谁发一个终局。P3 的 CC/Responses/WS 不能只靠“per-format PoC”，必须先完成这张矩阵和 producer-wire tests。Anthropic direct 可作为 P1/P2 独立先行，但也须指定 terminal-drain 拦截点。

### [MEDIUM] §11、§15、§12 仍有会导向错误实现的陈旧表述

- **问题与位置**：
  1. §11 P1 写“visibility 契约（§4，默认 marker）”，但 §4/§6/§13 Q1 已裁决默认是 `transparent`。
  2. §15 `visibility 契约` 仍写“P1/P2/P3”，但当前正式策略是 `transparent/passthrough/marker`，旧候选命名已不适用。
  3. §12 门 B 仍写“续写 spec 已标 tool_use 前缀未验证”，与 §3.2 和 `exp/continuation-shape/FINDINGS.md:9` 的 G3 PASS 冲突。
- **建议**：统一替换上述陈旧文字。尤其 §11 P1 的默认策略会直接改变 plan 的 wire 行为与验收目标，不能当作术语 nit。

### [LOW] 文件锚点与未决项清理不完整

- **问题**：§1.3/§5.1 指 `driver.ts:1283`，当前 master 重试门实际在 `src/lib/pipeline/driver.ts:1366`；§1.3 指 ledger 为 `driver.ts:1233/1255`，当前实际是 :1274（喂养）/:1299（记录）。§13 Q4 重复两次（:265-266）；Q3/Q4 虽写“待确认”，但 YAML 已给出 `text:"continue"` 与 `max_rounds:1` 默认值，当前是“已设定又未裁决”的歧义。
- **建议**：行号改为稳定的符号/语义锚点，或同步到现行行号；删去重复 Q4。将 Q3/Q4 明确为“已决定的初始默认，未来通过观测再调整”，或真正列为必须用户裁决的问题。后者会阻塞 plan，前者不应再伪装为未决。

## 对透明 stitch、usage 与后端忠实的判断

- **透明策略本身认可**：在用户已明确接受超预算输出与额外计费、且默认 `enabled:false` 保持字节等价的前提下，transparent-stitch 是符合项目功能优先、richest-data-flow 与无兼容包袱立场的合法产品决策。`usage.output_tokens` 报各轮真实总和也比伪造为请求上限更正确。
- **后端忠实设计认可**：§9 区分 `perRoundStopReason`（真实）、`clientVisibleStopReason`（呈现）和 `suppressedMaxTokens`，并要求 attempts[] 保留真实 upstream request/response，是正确的最低基线。实现计划必须把“后端 history oracle”与“客户端 SDK wire oracle”分开，不能以客户端顺利消费反推 history 已完整。
- **尚不可背书的点**：透明 stitch 当前只是目标行为，不是现有实现能力。当前 driver 的 continuation 实现处理的是“无 terminal 的 transport cut”后 append（`src/lib/pipeline/driver.ts:1401-1453`）；对已收到 `message_stop` 的 max_tokens 成功路径，当前 :1327-1358 会直接 terminal flush。因此 plan 必须新增成功 terminal interception，不能把现存 continuation-retry 的 append 测试当作 transparent max_tokens wire 正确性的证明。

## 可否进入 plan 阶段

**结论：暂不可原样进入 plan 阶段；修复 3 个 MAJOR 后可进入。**

无需重新讨论用户已裁决的 Q1 transparent 默认或 Q2 多策略。阻断原因是：`B-closed` 的动作错误、`passthrough` 与同流 continuation 的配置语义不可兼容、以及 §5.3 把真实不同层的 terminal ownership 错误折叠成 commit-boundary 概念。它们若不先写清，计划必然无法唯一决定 Anthropic/CC/Responses 的 wire 拦截点和终局行为，属于承重设计而非实现细节。

建议的最小修订顺序：先修 §5.2 `B-closed`、§6 visibility × class 策略矩阵、§5.3 terminal ownership matrix 交付物定义；再同步清理 §11/§12/§15 的陈旧默认和术语。完成后，P0 独立分型观测与仅 Anthropic direct 的 transparent A 类可以作为 plan 前两阶段，CC/Responses/WS 以已明确的 matrix + producer/client oracles 进入后续阶段。