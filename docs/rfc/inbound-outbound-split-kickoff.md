# Kickoff：继续 InboundCodec/OutboundLeg 重构（RFC v2 → plan → C1-C6 实现）

> 交接给新会话执行。前置会话已完成 RFC v1 + 三轮对抗 review + 设计转向,产物 durable 在 `docs/rfc/2026-07-13-inbound-codec-outbound-leg-split.md`。**先读那份 RFC 的 §0/§0.1（三轮裁决 = v2 设计蓝图,是权威）+ 本 kickoff,再动手。**

## 背景（为什么做这个重构）

Phase 7 修了一个真实生产 bug:前向翻译腿(anthropic 客户端用 OpenAI 模型)生产全 500——`strategy-registry` 只注册 MESSAGES builder、CC/Responses 从没注册,每个 phase 推给下一个、测试用 `strategies:[]`/dry-run 绕过真工厂。用户认定这不是偶然,而是**对象模型的结构性轴错配**:通用翻译矩阵的两轴洞察(clientFormat 入站 × targetEndpoint 出站)只活在数据层(env 两字段),对象层只有一根轴(`FormatCodec` by clientFormat),出站关切被打散进 `{strategy-registry 供料袋 + 4 handler 供料工厂 + codec 跨格 delegate + codec 内 isForwardTranslateLeg 分叉}`。用户授权**全拆分、长远正确**、评审委托 agents。

## 已完成（前置会话）

1. **RFC v1**（`InboundCodec ⊥ OutboundLeg` 两正交对象族）。
2. **三轮并行对抗 review**（遗漏关切 / cutover 过渡态 / 接口契约）——**决定性证伪 v1 的"⊥ 正交"框架**,主会话亲手复核 file:line 属实。
3. **设计转向 v2**:记录在 RFC §0/§0.1（详尽的裁决表 + 修正方向,是 v2 蓝图）。

## v2 设计核心（详见 RFC §0.1,此处摘要）

**证伪"正交"的三个 BLOCK**（两轴在对象层纠缠,不可干净正交）:
- 策略装配是 **2D**（clientFormat × targetEndpoint）:同 `/chat/completions` 腿,CC direct 走 auto-truncate+maxRetries=N、Responses fallback 走无-auto-truncate+maxRetries=1。
- 策略供料是 **parse 捕获的入站态**（truncate baseline / resanitize）,env 里没有、retry 已变异不可复原。
- per-request exchange 态（responseId/itemId）**跨轴共享**（出站 prepareWire + 入站 render 都消费）。

**v2 正确方向**（不是"两正交对象族",而是）:
- **集中化 2D cell 装配**:把"这个 (clientFormat × targetEndpoint) cell 需要什么"的知识收到**单一装配解析器**（键 = cell 两轴,非单轴）。入站供"策略语义 spec"（要不要 auto-truncate/maxRetries）、腿供"wire 策略",装配器组合。
- **跨轴态用显式载体**（env / prepareHints / ctx),非 codec 闭包 accessor:parse 捕获态经 prepareHints/ctx 流到装配器;exchange 态住 ctx（两侧从 ctx 读）;side-channel recordings（pipelineInfo 重建的 4 个 accessor）统一写 ctx。
- **核心承诺仍成立**（review 核实）:cell-keyed `Record` 穷尽把 Phase 7 的静态 throw 转**编译错**;"cell 需要什么"收敛为单一事实源。但诚实标注:类型穷尽只覆盖"cell 存在性",`env.body:unknown` 腿形维度仍靠 assembly 内三方约定 + L1 测试守卫。
- **betaProbe 写死惰性引用读**（非 eager 快照,否则重造 Phase-7 级隐蔽 bug）;betaProbe 种子（anthropic-beta）经 env/prepareHints 从 parse 流入。
- **createAccumulator 二选一定死**（pump 消费它 / 删它,不搬家——唯一"搬家非消除"实锤）。
- **gemini via-responses 上游是 Responses 形非 CC**:须把 `renderResponsesFrameToCc`+`createStreamTranslator`（Responses→CC 逐帧原语）提取进 hub,gemini InboundCodec 才能独立持中间 translator 态、delegate 才删得掉。

## 剩余任务（按序）

### T1. 重写 RFC §2-§10（按 §0.1 裁决）
v1 正文（§2-§10）仍描述"⊥ 正交",须重写为 v2"集中化 2D cell 装配":
- §2 目标:措辞收敛（"cell 存在性由类型消灭、腿形约定由测试守卫",别过度承诺"类型消灭复发源"）。
- §3 架构:`CellAssembly`（2D 键装配器）+ InboundCodec + 显式跨轴载体（env/prepareHints/ctx 各承载什么,画清）+ 依赖方向。§3.1 明写"正交指主分派轴、非数据隔离,两族都从 env 读另一轴作次要输入"。
- §4 接口契约:`CellAssembly` 接口（translateOut/requestRewrites/prepareWire/buildStrategies/responseRewrites/preSend/sampleWireTrack,持 betaProbe 惰性引用）+ InboundCodec 接口（parse/renderToClient **流式** + renderNonStreaming **非流式**两入口/flushResponse/getStreamMeta/formatError/getContext/sampleClientTrack）+ exchange 态 ctx 载体 + side-channel recordings 写 ctx 的契约。补 M2/M3/M4 漏项（reverse-terminal 响应侧散布、renderNonStreaming、getContext）。
- §5 cutover:**显式 hybrid dispatch 规则**（driver 5 构造点、单槽派发、按 targetEndpoint 在 cell-assembly 与旧 codec 间二选一,跨 3 commit）+ 逐 cell 迁移 + **C0 补 3 条 byte golden**（keepalive-ON anchored direct 流式 / reverse @messages 转发逐帧 / responses-ws + gemini 两跳终帧）+ reverse-sanitize 单次守卫（orphan-strip 计数不翻倍）+ pipelineInfo 从 ctx 读的回归（direct anthropic 重试后 messageMapping/cacheControlStripped 非空,正样本证触达）。
- §6 三层文档结构、§7 验证、§8 OQ（解掉已决的 gemini/exchange 归属）、§9-10。

### T2. 第二轮对抗 review（≥2 视角,resume 首轮 agents 优先）
按 `resume-agent-via-SendMessage` 唤醒首轮三个 reviewer 复审 v2（它们有上下文）。主会话复核发现。重复到零 FAIL/WARN（`large-refactor` §1,通常 2-4 轮）。

### T3. 三层 plan（design/plan/prompts,`large-refactor` §5）
- factory 锚点表:C2-C4 是**提取不重写**——Anthropic sanitize 链、buildOpenAiCcStrategies、buildOpenAiResponsesStrategiesForEnv、prepareAnthropicRequest、CC→Responses wire、Responses→CC 逐帧原语等算法核**原样搬**,plan 给每个被搬函数 file:line。
- prompts/README 的 DAG + 通用红线（byte golden gate / hybrid dispatch lockstep 同 commit / 无双活）。

### T4. C0 → C1-C6 实现（byte-critical,逐 commit subagent + review）
- **C0**:先在改动前 HEAD 补 3 条 byte golden + 跑通现有 79 golden（锁行为）。
- **C1-C6**:逐 cell 原子迁移,每 commit hybrid dispatch 无双活 + golden 逐字节 + typecheck 绿。每 commit subagent 实现 + 独立 review（P3/P5/Phase-7 教训:主会话亲手复核承重断言、别信自证、别用 strategies:[] 绕过真工厂）。
- 隔离 worktree（`.worktrees/`）+ 独立分支。

### T5. 合并 + doc-sync + 记忆
- 合并回 master（rebase/FF 或 --no-ff 脱离 peer 竞态）。
- DESIGN.md「活的架构现状」翻译矩阵行改为 cell-assembly 架构。
- 记忆 stub 记本次重构 + 教训（"两轴在对象层纠缠、正交是过度简化、集中化 2D 装配才对";"RFC-first 三轮 review 挡下 v1 根本性过度简化"）。

## 承重约束 / 红线
- **行为逐字节/oracle 等价**是硬 gate（纯结构重构,现状 6 格 + 前向 + 反向腿全不变）。转发客户端 SSE 死磕字节,上游 wire/history 用结构/GHC oracle（`large-refactor` §7）。
- **无双活过渡态**:每 cell 迁移原子（删旧供料 + 加新装配同 commit）,reverse-sanitize/双 sanitize 守卫。
- **betaProbe 惰性引用读**（别 eager 快照,重造 Phase-7 bug）。
- **别用 strategies:[]/dry-run 绕过真工厂**（Phase 7 教训:真驱动生产接缝 + 负样本对照）。
- **no-auto-server**;绝不 kill 4141;活服务器实测用隔离 XDG_DATA_HOME 测试服务器。
- 细粒度 pathspec 提交、无模型署名、并发 peer 行级共存。
- **命名按纯 clientFormat、剥实现细节前缀**（用户 2026-07-13 决定,折进本重构一起做,不单独提交）:gemini 的 InboundCodec 命名 `GeminiInboundCodec` / `createGeminiInboundCodec`（clientFormat=`"gemini"`）,**不沿用** `OpenAiGemini*` 旧名——旧前缀是"委托 openai-cc"这个**出站实现细节**的化石,T1 §6 删 delegate 后前缀零依据。与 ADR [`2026-07-11-route-decision-separated-from-format-codec`](../decisions/2026-07-11-route-decision-separated-from-format-codec.md)「codec 是纯 format 翻译器」同向:codec 身份纯由入站格式定,内部委托谁不进名字。连带 `codec/openai-gemini/` 目录 → `codec/gemini/`、`OpenAiGeminiCodec` 类型 → `GeminiInboundCodec`、dry-run-pipeline 的 `openai-gemini` 参数别名 → `gemini`。**零数据迁移**:持久值 `EndpointType="gemini-generate-content"` 与 `ClientFormat="gemini"` 均不受影响,`openai-gemini` 仅存于符号/目录/注释/debug 参数（探证:`grep -rn '"openai-gemini"'` 无 history/wire 持久命中）。

## 必读
- `docs/rfc/2026-07-13-inbound-codec-outbound-leg-split.md` §0/§0.1（权威 v2 蓝图）+ §1 债务清单。
- 前置翻译矩阵 RFC `docs/rfc/2026-07-11-anthropic-via-openai-translation.md` §3.1（缝合模型二维门控）。
- skill `large-refactor`（RFC-first / commit invariant / golden 预捕获 / 三层文档 / 批量工具箱）、`empirical-verification`、`verifying-authoritative-claims`。
- 关键 file:line（§0.1 已列）:driver.ts:202/309（strategies 先于 prepareWire）、anthropic/strategies.ts:126（betaProbe 惰性读）、hub-translate.ts:88/163/278（翻译两轴签名）、strategy-registry.ts:90（Phase 7 throw）、openai-responses/codec.ts:216（reverseExchange）、chat-completions:180 vs responses:168（策略 2D）、messages/handler-v4.ts:732（pipelineInfo 重建 accessor 群）、5 driver 构造点（messages:419/chat:151/responses:140/gemini:113/ws:232）。
