# RFC：集中化 (clientFormat × targetEndpoint) cell 装配 —— 消灭出站关切的散布

日期：2026-07-13｜状态：**v2 转向中**（三轮对抗 review 证伪 v1 的"⊥ 正交对象族"框架 → 转向"集中化 2D 缝合装配"；§3-§5 待按下方裁决重写 → 第二轮 review）
需求源：Phase 7 前向腿生产 500 bug 暴露的结构性错配（`docs/plan/anthropic-via-openai-translation/prompts/phase-7.md`）
前置：[通用翻译矩阵 RFC](2026-07-11-anthropic-via-openai-translation.md)（§3.1 **缝合模型**二维门控——本 RFC 把那个洞察落到"集中化装配"对象）

---

## 0. TL;DR（v2 已转向——下方 §0.1 是三轮 review 的裁决,§2-§10 的 v1 正文尚未按此重写,读时以 §0.1 为准）

**问题（不变,经三轮 review 核实属实）**：RFC §3.1 的两轴洞察只活在**数据层**（env 有 clientFormat + targetEndpoint 两字段），对象层只有一根轴（`FormatCodec` by clientFormat）。出站关切被打散进 `{strategy-registry 供料袋 + 4 handler 供料工厂 + codec 跨格 delegate + codec 内 isForwardTranslateLeg 分叉}`。Phase 7 的 500 bug 是这个错配的必然产物,且每加一个格子都复发。

**v1 方案（已被证伪）**：拆成 `InboundCodec ⊥ OutboundLeg` 两个**正交**对象族。

**v2 转向（三轮对抗 review 用 file:line 证伪"正交",见 §0.1）**：两轴在对象层**纠缠**,不可干净正交。正确方向是把"这个 (clientFormat × targetEndpoint) cell 需要什么"的知识**集中到单一 2D 装配解析器**,并把跨轴态改由**显式载体**（env / prepareHints / ctx）承载,而非 codec 闭包 accessor。**核心承诺经 review 核实成立**：漏一个 cell = 编译错（消灭 Phase 7 静态 throw）+ "cell 需要什么"收敛为单一事实源。

## 0.1 三轮对抗 review 裁决（v1,全部采纳,v2 正文按此重写）

**三个 BLOCK 证伪 v1 的"⊥ 正交"（主会话亲手复核 file:line 属实）**：
- **BLOCK-1 策略装配是二维**（clientFormat × targetEndpoint,非 targetEndpoint 一元）：同一 `/chat/completions` 腿,CC 客户端 direct → `buildOpenAiCcStrategies`（auto-truncate + maxRetries=N,`chat-completions/handler-v4.ts:180`）;Responses 客户端 fallback → `buildOpenAiResponsesStrategiesForEnv`（**无** auto-truncate + maxRetries=**1**,`responses/handler-v4.ts:168`）。策略栈**形状**由 clientFormat 决定。`OUTBOUND_LEGS[X]().buildStrategies` 产唯一栈 → 违反逐字节等价。Record 穷尽对此**零保护**（漏的是 client×leg 组合,非 leg）。→ **v2：装配键 = cell（两轴）**;入站供"策略语义 spec"（要不要 auto-truncate / maxRetries）、腿供"wire 策略",装配器组合。
- **BLOCK-2 策略供料是 parse 捕获的入站态,env 里没有**：`getTruncateBaseline`/`getResanitize`（`anthropic/codec.ts:432/473`,pre-sanitize 快照,retry 已变异 env.body 不可复原）。"从 env 自建"不可能——是跨两族真实数据依赖。→ **v2：parse 捕获态经显式载体（prepareHints / ctx）流到装配器,非闭包 accessor**。
- **BLOCK-3 per-request exchange 态跨轴共享**：Responses fallback / reverse 二跳的 `responseId/itemId`（`openai-responses/codec.ts:216`）被出站 prepareWire **和**入站 render 同时消费。§3.4 的"住进 leg 闭包"对它无效。→ **v2：exchange 态住 ctx（per-request,两侧都从 ctx 读）**。

**承重 HIGH（全采纳）**：
- **pipelineInfo 隐藏耦合**（cutover + 遗漏 reviewer 双双命中）：`recordRetryPipelineStateV4`（`messages/handler-v4.ts:732`）读 4 个 codec accessor（getTruncateBaseline/getLatestEffectiveMessages/getInitialSanitizationInfo/getLatestStrippedCacheControlSubfields）,其中 2 个由 **prepareWire/sampleRequest 写**（迁 OutboundLeg 后不在 codec）→ 静默变空、污染 master 上 4 个 peer-D2 pipelineInfo fail 基线的可辨识性。→ **v2：side-channel recordings 统一写 ctx,pipelineInfo 从 ctx 读、消灭 accessor 群**。
- **betaProbe 惰性引用读（P2a,最该挡下）**：现状 `getProbeCandidates: () => betaProbe.getCandidates()`（`anthropic/strategies.ts:126`）是**惰性引用读**,非构造期快照;driver strategies 工厂 per-request 解析一次（`driver.ts:202`）、prepareWire per-attempt 调（`:309`,先 strategies 后 prepareWire）。照字面 eager-snapshot 实现会重造 Phase-7 级隐蔽 bug。→ **v2 写死：betaProbe 引用共享 + retry 时惰性 getCandidates()**。
- **betaProbe 种子跨轴（P2b）**：`clientAnthropicBeta`（Anthropic 客户端 `anthropic-beta` 头）+ `clientRequestHeaders` 是 clientFormat 轴输入,parse 捕获。→ **v2：经 env/prepareHints 从 parse 流到装配器**。
- **cutover 是跨 8+ 文件 lockstep + hybrid dispatch**：driver **5 构造点**（messages:419/chat:151/responses:140/gemini:113/ws:232）、出站派发是**单槽 + codec 内 if 分叉**、`/v1/messages` 腿被 **4 codec/4 handler** 触达。"driver 单点原子切"是错的;真过渡机制是"driver 按 targetEndpoint 在 cell-assembly 与 codec 间 hybrid 派发、跨 3 commit"。漏删 handler reverse 供料 = **双 sanitize**（orphan-strip 翻倍）。→ **v2 §5：显式 hybrid dispatch 规则 + 逐 cell 迁移 + reverse-sanitize 单次守卫（断言 orphan-strip 计数不翻倍）**。
- **byte golden 缺口**：`direct-stream-golden-phase4` 实测**关了心跳**（`:20` 注释）→ anchored 心跳/reconcile 字节没被锁;reverse **无逐帧 byte golden**（reverse-cc-messages 用 inspectRequest + accumulator,非转发 SSE 逐帧）。→ **v2 §5 C0：进 C1 前必补 3 条 byte golden（keepalive-ON anchored direct 流式 / reverse @messages 转发逐帧 / responses-ws + gemini 两跳终帧）**。

**HIGH（归属修正,全采纳）**：
- **gemini via-responses 上游是 Responses 形非 CC**（HIGH-1）：gemini render 是 (Responses|CC)→CC→Gemini 两跳,Responses→CC 是**响应侧有状态翻译**（`renderResponsesFrameToCc`+`createStreamTranslator`,`openai-cc/codec.ts:607/265` 私有）。→ **v2 §6：把这个 Responses→CC 逐帧原语提取进 hub,gemini InboundCodec 才能独立持中间 translator 态,delegate 才删得掉**。同时这半验证 hub-and-spoke（gemini 无需 gemini 专属 OutboundLeg,出站纯 CC/Responses）。
- **render 读两轴**（HIGH-2/P3+P4）：renderToClient/translateOut 都读 env 的**两根轴**（translateOut 读 sourceFormat 选翻译器、renderToClient 读 targetEndpoint 定上游腿形——`hub-translate.ts:88/163` 签名两参数）。→ **v2 §3.1：正交指"方法的主分派轴"、非数据隔离;两族都从 env 读另一轴作次要输入**。
- **createAccumulator 化石搬家（P7b/M1,唯一"搬家非消除"实锤）**：`createResponseAccumulator` 全仓无生产消费者（pump 内联建）,v1 §4.1 又列进 OutboundLeg = 搬家。→ **v2 §3.7 二选一定死：pump 改消费 `assembly.createAccumulator()`（真消灭 inline 分叉）,或直接不放进 assembly（承认归 pump）**。

**CONFIRM（核心承诺成立）**：
- **Record/cell 穷尽真防 Phase 7**（契约 reviewer P1 核实）：Phase 7 是"switch 缺 case → default throw",cell-keyed `Record` 穷尽把它转**编译错**,承诺成立。**但须诚实标注**：类型穷尽只覆盖"cell 存在性";"env.body 是 cell canonical 形"这一维仍 unchecked（`body:unknown`）,靠 assembly 内 translateOut↔strategies↔prepareWire 三方约定 + §7 的 L1"buildStrategies 非空"测试兜底。→ v2 §2 措辞收敛。
- 依赖无环（P5）、preSend 归 OutboundLeg（Task4）、exchange ctx 落 InboundCodec 可推导（P6）——保留。
- **M2/M3/M4 补漏**：§1 债务清单漏了响应侧 reverse 散布（`classifyReverseAnthropicTerminal` 3 handler 用）、`renderResponseNonStreaming` 是独立第二 render 入口（吃整 response + `recordFeature` 副作用）、`getContext()` 被 4 handler ~20 处用于失败 settle——v2 §1/§4 补全。

---

## 1. 事实基础：当前对象模型的两轴散布（`file:line` 债务清单）

`FormatCodec`（`src/lib/pipeline/types.ts`）是**唯一**的 codec 抽象，按 `clientFormat` 建（anthropic/openai-cc/openai-responses/openai-gemini 四份）。它同时承担入站关切**和**出站关切，后者的处理被散布如下：

### D1. 出站策略供料散在 registry + 4 handler（O(handler × leg)）
- `strategy-registry.ts:60-75`：`StrategySupply` 是个**可选槽袋** `{anthropic?, cc?}`，`assembleStrategiesForEndpoint(targetEndpoint, supply)` 只是 `switch`——**真正填哪个槽、从哪取料，甩给每个 handler**。
- `messages/handler-v4.ts:364` `buildMessagesDriverStrategies`：填 `{anthropic}`（direct）**和**（Phase 7 前向腿）`{cc}`。
- `chat-completions/handler-v4.ts:143-180`：建 `reverseBetaProbe` + `reverseMapperHolder` + 填 `{anthropic}`（反向 @messages）**和** `buildOpenAiCcStrategies`（direct）。
- `responses/handler-v4.ts:131-160` + `gemini/handler-v4.ts`：同构重复。
- **后果**：同一个"targetEndpoint=X 需要什么供料"的知识，在 registry（槽定义）+ 4 handler（填料）里各写一遍。漏填 = 深埋 handler 的路径 → registry `default: throw` → **静默 500**（Phase 7 根因）。

### D2. betaProbe 是"跨组件句柄"被 handler 在三方之间穿线
- `betaProbe`（RFC §2.4）：handler 建一次，注入 codec（`prepareWire` 写 outbound betas）**和** strategies 供料（unsupported-beta 读）。反向腿还要建**第二个** `reverseBetaProbe`（`chat-completions/handler-v4.ts:143`）。它本质是**出站 Anthropic 腿的 per-request 状态**，却住在 handler、穿过 codec + registry + strategies 三方。

### D3. codec 持另一个 codec（跨格式 delegate）
- `anthropic/codec.ts:206` `ccDelegate = () => createOpenAiCcCodec()`：anthropic codec 内部持 cc codec，7 个方法（translateOut/renderResponse/renderResponseNonStreaming/prepareWire/preSend/sampleRequest/flushResponse，`:283-358`）用 `isForwardTranslateLeg(env.targetEndpoint)` 分叉"我自己处理 direct / 委托 cc delegate 处理 translate"。
- 反向对称：cc/responses/gemini 的反向 @messages 腿需要 Anthropic sanitize，靠 `codec/openai-cc/reverse-anthropic-rewrite.ts` 的 `ReverseAnthropicMapperHolder` + 独立 rewrite，由 handler 注入。
- gemini codec 持 cc delegate（`openai-gemini/codec.ts`），cc delegate 又可能……**delegate 就是"手工内联的 OutboundLeg"**——每个跨格子腿都手搓一遍委托。

### D3.5. `createResponseAccumulator` 是按 targetEndpoint 分派的死方法
- `anthropic/codec.ts:375` 按 `targetEndpoint` 返 CC/Responses/Anthropic accumulator——但**全仓无生产消费者**（Phase 4 M1 / Phase 5 review 实测），pump 各自内联建。这是"出站关切被塞进 inbound codec 接口、又没人真用"的化石。

### D4. prepareWire / renderResponse 的 per-leg `if` 分叉遍布每个 codec
- 每个 codec 的 `prepareWire`（`openai-cc/codec.ts:369`、`anthropic/codec.ts:309` 等）都有 `if (targetEndpoint===X) ... else if ... else throw`——**出站腿的 wire 逻辑按 targetEndpoint 分叉，却写在按 clientFormat 建的对象里**。这是轴错配最直白的形态。

**总结**：RFC §3.1 的"两正交轴"只活在**数据层**（`env` 有 `clientFormat` + `targetEndpoint` 两字段），对象层只有一根轴（FormatCodec by clientFormat）。出站轴的所有关切被迫寄生在 inbound codec 的方法分叉 + handler 供料 + registry 槽 + 跨格 delegate 里。

---

> ⚠️ **§2-§10 是 v1（"⊥ 正交对象族"）正文,已被三轮 review 证伪 → 由文末 [§11 定稿设计（v2）](#11-定稿设计v2集中化-2d-cell-装配) 取代。** 以下 v1 正文保留仅作演化脉络对照,**权威以 §0.1 + §11 为准**（`dont-lose-history`：不删 v1,标注取代）。

## 2. 目标 / 非目标（v1，见 §11 修正）

**目标**：
1. 把 codec 对象模型沿两轴拆成 `InboundCodec`（by clientFormat）⊥ `OutboundLeg`（by targetEndpoint）两个正交对象族。
2. "targetEndpoint=X 需要什么"收敛为**单一事实源** `OutboundLeg[X]`——消灭 D1 供料散布、D3 跨格 delegate、D4 per-leg if 分叉。
3. driver 按 `decision.targetEndpoint` 解析 `OutboundLeg`、与 `clientFormat` 的 `InboundCodec` 组合；**handler 退回只管入站 + 写出**（不填供料袋、不建 reverseBetaProbe/mapperHolder）。
4. **漏一个腿 = 一处、显式、启动即暴露**（driver 解析缺失/类型系统穷尽），而非深埋 handler 的静默 500。
5. **行为逐字节 / oracle 等价**（§7）：现状 6 现状格 + 前向 + 反向腿全部 landed 行为不变。这是纯结构重构。

**非目标**：
- 不改路由决策逻辑（router.ts 的 decideRoute 不动）。
- 不改翻译语义（hub-translate 的翻译函数不动，只改谁调它）。
- 不改 wire/history 数据模型。
- 不引入新的 client format 或 outbound leg（现状 4×3 不变）。

---

## 3. 架构：两个正交对象族 + hub 是显式的缝

### 3.1 两个对象族的职责边界（严格按 §3.1 两轴切）

```
InboundCodec (by clientFormat)              OutboundLeg (by targetEndpoint)
─────────────────────────────              ────────────────────────────────
parse(raw) → env{clientFormat, body(入站形)}  translateOut(env) → env{body(腿 canonical 形)}
renderToClient(upstreamFrame, env)          requestRewrites: ReadonlyArray<RequestRewrite>
  → client frame(s)  (响应翻译方向)          prepareWire(env) → PreparedRequest
flushResponse?(env) / getStreamMeta?()      buildStrategies(env) → RetryStrategy[]  (betaProbe 内含)
heartbeat/anchor/sink policy               responseRewrites: ReadonlyArray<ResponseRewrite>
formatError(err, env) → client frame        createAccumulator(env) → ResponseAccumulator
sampleClientTrack(...)                      preSend?(env) → env  (腿专属 pre-flight，如 Anthropic 截断)
                                            sampleWireTrack(wire, env)
        \                                  /
         \____ hub-translate (唯一显式的缝) ____/
              body/response 在两轴 canonical 形之间翻译（现有 translateRequestVia /
              renderResponse*Via / createForward|ReverseStreamTranslator，不动语义）
```

**判据（哪个方法归哪族）= 它门控在哪根轴**（§3.1 已逐条核过）：
- 门控在 `clientFormat`（面向客户端）→ InboundCodec：parse、render 给客户端的帧、心跳/anchor/sink、客户端 formatError、客户端轨采样。
- 门控在 `targetEndpoint`（面向上游 wire）→ OutboundLeg：translateOut、请求改写链、prepareWire、策略栈（含 betaProbe）、上游响应改写、上游 accumulate、上游截断保护、wire 轨采样。

### 3.2 数据流（driver 组合两族）

```
S1  inbound.parse(raw) → env{clientFormat, body:入站形}
S2  router.decideRoute(env) → targetEndpoint     (不变)
    outboundLeg = resolveOutboundLeg(targetEndpoint)   ← driver 单点解析
S2' env = outboundLeg.translateOut(env)          (经 hub 翻到腿 canonical 形)
S3  for rw in outboundLeg.requestRewrites: env = rw(env)
S4  wire = outboundLeg.prepareWire(env)
    strategies = outboundLeg.buildStrategies(env)
S5  上游交换（retry loop 用 strategies）
    for rw in outboundLeg.responseRewrites: frame = rw(frame)   (作用上游帧)
    acc = outboundLeg.createAccumulator(env)
S6  clientFrames = inbound.renderToClient(frame, env)   (上游腿形→入站形，经 hub)
    handler: inbound 的心跳/sink 策略写出
```

**关键**：`resolveOutboundLeg(targetEndpoint)` 是 driver 内**唯一**解析点，返回一个自足的 `OutboundLeg`。它从 `env`（translateOut 后 body 已是腿 canonical 形）就能建出自己的一切——不需要 handler 供料。

### 3.3 依赖方向（无环）

```
routes/*/handler   →  driver  →  { InboundCodec[clientFormat], OutboundLeg[targetEndpoint] }
                                        ↓ 两者都依赖 ↓
                                   hub-translate（翻译原语，叶子）
```
- driver 持两个 registry：`INBOUND_CODECS: Record<ClientFormat, () => InboundCodec>`、`OUTBOUND_LEGS: Record<UpstreamEndpoint, () => OutboundLeg>`。**类型系统穷尽**（`Record` 全键必填）→ 漏一个腿 = 编译错，非运行时 throw（消灭 D1 静默 500）。
- **codec 不再 import 另一个 codec**（D3 delegate 全删）；跨格翻译只经 hub。
- handler 只 `createDriver({ inbound, ... })`——不建 betaProbe/mapperHolder/供料（D2 内收进 OutboundLeg）。

### 3.4 betaProbe / mapperHolder 的归宿（消 D2）
- `AnthropicOutboundLeg` **自己持** per-request 的 `betaProbe`——`prepareWire` 写、`buildStrategies` 读（同一对象内闭包，不再穿线）。反向腿与前向腿用**同一个** `AnthropicOutboundLeg`（同一 targetEndpoint=/v1/messages），故不再有 direct/reverse 两个 betaProbe。
- Anthropic sanitize 的 tool-name mapper：`AnthropicOutboundLeg` 从 `env`（腿 body + resolvedName + vendor）自建 `buildAnthropicToolNameMapper`——不再需要 handler 的 `reverseMapperHolder` 穿线；正向 direct（客户端就是 Anthropic）与反向（客户端 CC/gemini）走同一构造，mapper 源都是**腿 body 的 tools**（translateOut 后已归一）。

---

## 4. 接口契约

### 4.1 `OutboundLeg`（新，by targetEndpoint）
```ts
interface OutboundLeg {
  endpoint: UpstreamEndpoint
  /** 入站 canonical body → 本腿 canonical body（经 hub；identity 当已是腿形）。 */
  translateOut(env: RequestEnvelope): RequestEnvelope
  /** S3 请求改写链（本腿的上游 wire 改写；Anthropic 腿=sanitize 链，CC/Responses 腿=CC 改写）。 */
  requestRewrites(): ReadonlyArray<RequestRewrite>
  /** S4 wire（本腿的 prepareWire；持 per-request betaProbe/mapper 闭包）。 */
  prepareWire(env: RequestEnvelope): PreparedRequest
  /** S4 重试策略栈（从 env 自建供料，不再靠外部 supply 袋）。 */
  buildStrategies(env: RequestEnvelope): ReadonlyArray<RetryStrategy>
  /** S5 上游响应改写（本腿 wire 的改写册）。 */
  responseRewrites(): ReadonlyArray<ResponseRewrite>
  /** S5 上游帧累加器（上游腿形——Anthropic/CC/Responses acc）。 */
  createAccumulator(): ResponseAccumulator
  /** 可选：腿专属 pre-flight（Anthropic 截断 preSend）。 */
  preSend?(env: RequestEnvelope): Promise<RequestEnvelope>
  /** wire 轨采样（history 上游腿形）。 */
  sampleWireTrack(wire: PreparedRequest, env: RequestEnvelope): WireRequest
}
```
三份实现：`AnthropicOutboundLeg`（/v1/messages）、`OpenAiCcOutboundLeg`（/chat/completions）、`OpenAiResponsesOutboundLeg`（/responses + ws:/responses）。

### 4.2 `InboundCodec`（= 现 FormatCodec 去掉出站关切）
```ts
interface InboundCodec {
  format: ClientFormat
  parse(raw: RawHttpRequest): RequestEnvelope
  /** 上游 canonical 响应帧 → 客户端格式帧（经 hub 的 render*Via；含响应翻译方向的流式 translator）。 */
  renderToClient(frame, env): ClientFrame[]
  flushResponse?(env): ClientFrame[]
  getStreamMeta?(): StreamMeta
  formatError(err, env): ClientFrame
  sampleClientTrack(env): { effective: EffectiveRequest }   // 客户端腿形（effectiveRequest）
  // 心跳/anchor/sink 策略：见 §4.3
}
```

### 4.3 心跳/sink 策略归属（承重设计点，见 OQ1）
现状心跳/anchor/sink 逻辑在 handler（`makeAnchoredSseSink` 等）。它门控在 **clientFormat**（Anthropic 客户端有 anchored 心跳、CC/Responses/Gemini 无）——故属 InboundCodec 关切。但它与 handler 的 streamSSE 生命周期强耦合。**本 RFC 提议**：InboundCodec 暴露一个声明式 `streamPolicy: { heartbeat, anchor, keepaliveFrame }`（数据，非行为），handler 的通用 pump 读它决定挂不挂 anchored sink——把"哪个客户端要心跳"的知识从 4 个 handler 的 pump 分叉收进 InboundCodec。**OQ1**：这层是否本 RFC 做，还是留作后续（心跳缝合是 byte-critical，风险高）。

### 4.4 registry（driver 持，类型穷尽）
```ts
const OUTBOUND_LEGS: Record<UpstreamEndpoint, () => OutboundLeg> = {
  "/v1/messages": () => createAnthropicOutboundLeg(),
  "/chat/completions": () => createOpenAiCcOutboundLeg(),
  "/responses": () => createOpenAiResponsesOutboundLeg(),
  "ws:/responses": () => createOpenAiResponsesOutboundLeg(),
}
const INBOUND_CODECS: Record<ClientFormat, () => InboundCodec> = { ... }  // 4 键穷尽
```
`Record<全键, ...>` 缺一个 = **编译错**（消灭 D1 静默 throw）。

---

## 5. Cutover（按 commit，带 invariant）

**全局 commit invariant（每 commit 终态）**：
1. `bun run typecheck` 0 + `bun test` 全套件通过（除 base 预存在的 UI shell 404 / negotiation / peer-D2 pipelineInfo 4 例外）。
2. **现状 6 格 + 前向 + 反向腿行为逐字节/oracle 等价**（golden 锁，§7）——直到某处被有意改。
3. 中间态**显式无害**（§过渡）：新 OutboundLeg 与旧 codec-translate 分支**不双跑**——driver 在同一 commit 原子切换该腿的调用点，旧分支同 commit 变 dead（`isForwardTranslateLeg` 分叉逐腿删）。
4. 细粒度 pathspec 提交，conventional commits，无模型署名。

**过渡态无害（§large-refactor 3）**：OutboundLeg 与旧 codec-translate 分支处理同一上游 wire——若同一 commit 窗口两者都活，会双发/双累加。故**每腿的迁移是原子的**：引入 `OpenAiCcOutboundLeg` 的 commit **同时**把 driver 对 CC 腿的调用从"codec.prepareWire + handler 供料"切到"leg.prepareWire + leg.buildStrategies"，旧路径同 commit 变 dead code（下一 commit 删）。不存在"leg 已建但 driver 还没切"的双活窗口。

**Golden 预捕获（改动前，§large-refactor 4）**：
- C0：在改动前 HEAD 锁定全部行为 oracle——router golden 52（不动，路由不变）、全部翻译 IT（forward-leg-strategies / reverse-cc/responses/gemini-messages / anthropic-stream-roundtrip / anthropic-nonstream-roundtrip）、byte-critical SSE golden（direct-stream-golden-phase4 / reverse 逐帧）。这些是"结构重构后仍须逐字节/oracle 通过"的硬证。**先在改动前跑通、锁定**。

**commit 序（草案，DAG 见 plan）**：
- **C1**：定义 `OutboundLeg` 接口 + `OUTBOUND_LEGS` registry（空实现/throw 占位）+ driver 加 `resolveOutboundLeg`（**仅新增，未接线**，过渡态无害=没人调）。typecheck 绿。
- **C2**：实现 `AnthropicOutboundLeg`（从 anthropic codec 的 direct 分支 + strategy-registry 的 anthropic supply + reverse-anthropic-rewrite **提取**，不重写算法核）；driver 对 `/v1/messages` 腿**原子切**到 leg（messages direct + cc/responses/gemini 反向 @messages 都走它）；删 anthropic codec 的 direct-wire 分支 + 3 handler 的 reverse supply/betaProbe/mapperHolder。golden：direct 流式逐字节 + 反向三格 IT 全过。
- **C3**：实现 `OpenAiCcOutboundLeg`（从 openai-cc codec + buildOpenAiCcStrategies 提取）；driver 对 `/chat/completions` 腿原子切（cc direct + anthropic/gemini 前向 @cc）；删 cc codec 的 wire 分支 + handler cc 供料 + anthropic codec 的 ccDelegate 前向分支。golden：cc direct + 前向 @cc IT 全过。
- **C4**：实现 `OpenAiResponsesOutboundLeg`（含 CC→Responses wire + ws 传输）；driver 切 `/responses`+ws；删 responses codec wire 分支 + 前向 @responses 供料。golden：responses direct + 前向/反向 @responses + ws IT。
- **C5**：`InboundCodec` 收敛——FormatCodec 去掉已迁走的出站方法（translateOut/prepareWire/buildStrategies/createResponseAccumulator/requestRewrites/responseRewrites），只留 parse/renderToClient/flushResponse/getStreamMeta/formatError；删 strategy-registry 供料袋 + `assembleStrategiesForEndpoint`（driver 直接 `leg.buildStrategies`）+ `createResponseAccumulator` 死方法。typecheck 绿 = 无残留调用。
- **C6**：清理——删 `isForwardTranslateLeg`、reverse-anthropic-rewrite 的 holder 穿线残留、handler 的 strategies 工厂（`buildMessagesDriverStrategies` 等）；心跳策略（OQ1 若做）。doc-sync。

每个 C2-C4 都是"原子切一个腿 + 删该腿旧路径"，终态 golden 全过、无双活。

---

## 6. 三层文档结构（本重构交独立实现者）

按 §large-refactor 5，本 RFC 产物拆三层，放 `docs/rfc/inbound-outbound-split/`（或沿用现 `docs/rfc/2026-07-13-*.md` + `docs/plan/inbound-outbound-split/`）：
- `design.md`（本 RFC）：WHY + 接口契约 + 依赖方向 + cutover invariant。
- `plan.md`：每 commit 的 TDD 步骤 + **factory 锚点表**（从哪些现有 `file:line` 提取，order 常量）。
- `prompts/`：per-commit kickoff（self-contained）+ README（DAG + 红线）。
- **factory 锚点原则**：C2-C4 是**提取不重写**——Anthropic sanitize 链、buildOpenAiCcStrategies、prepareAnthropicRequest、CC→Responses wire 等算法核**原样搬进 OutboundLeg**，只改"谁持有 + 谁调"。plan 必给每个被搬函数的 `file:line`。

---

## 7. 验证（行为等价的 oracle）

- **router golden 52**：不动（路由不变）——每 commit 必过。
- **翻译 IT**（forward-leg-strategies / reverse-*-messages / *-roundtrip）：结构+独立消费者 oracle，每 commit 必过。
- **byte-critical SSE golden**（direct-stream-phase4 / reverse 逐帧 / cc-to-anthropic-stream SDK oracle）：**逐字节**，每 commit 必过（§7 消费者校准：转发给客户端的 SSE 死磕字节；上游 wire 用 GHC/结构 oracle）。
- **新增守卫**：`OUTBOUND_LEGS`/`INBOUND_CODECS` 的 `Record` 穷尽性（漏腿=编译错）+ 一条"每个 targetEndpoint 都能 resolveOutboundLeg 且 buildStrategies 非空"的 L1 存在性测试（正是 Phase 7 那类 bug 的守卫）。
- **活服务器实测**（收尾，用户/主会话）：`gpt-5.6-sol` 无后缀 + `@messages` 反向 + 各 direct 腿端到端（隔离 XDG_DATA_HOME 测试服务器，不碰 4141）。

---

## 8. Open Questions（写码前须解）

- **OQ1（心跳/sink 策略归属）**：§4.3 的声明式 streamPolicy 是否本 RFC 做？心跳缝合是 byte-critical（Anthropic anchored + 300s + reconcile 三方），风险高。**倾向**：本 RFC 只做 InboundCodec/OutboundLeg 的**请求+响应翻译+策略**拆分，心跳策略收敛留作后续小 RFC（handler pump 暂保留现状 clientFormat 分派，但读 InboundCodec 的 policy 数据）。待 review 裁。
- **OQ2（web_search 旁路）**：web_search 双跳走 legacy `executeRequestPipeline`（`[bypass]`），不进 driver。它对 OutboundLeg 抽象免疫吗？（现状 messages handler 的 web_search 门在 driver 前，用 decideRoute——不碰 codec 出站方法，故应免疫，但须核实。）
- **OQ3（gemini 两跳）**：gemini 反向 @messages 是最长链（Anthropic→CC→Gemini），现靠 codec delegate 组合。OutboundLeg 是 /v1/messages（产 CC-canonical 上游响应），gemini InboundCodec 的 renderToClient 做 CC→Gemini——两跳的接缝在 InboundCodec.renderToClient 内经 hub，delegate 删得掉吗？须核实 gemini renderToClient 的两段翻译能否纯经 hub。
- **OQ4（sampleRequest 双轨）**：effectiveRequest（客户端腿形）归 InboundCodec、wireRequest（上游腿形）归 OutboundLeg——现状 sampleRequest 一个方法产两轨。拆开后两族各产一轨，history sink 组装。核实 history 数据模型接得住。

---

## 9. 范围外
- 路由决策、翻译语义、wire/history 数据模型、新格式/新腿。
- 心跳策略完整收敛（OQ1 倾向留后续）。
- web_search 旁路迁 driver（独立债，`docs/todo/`）。

---

## 10. 为什么值得（诚实取舍）
- **当前设计不烂**——有两轴洞察、hub、registry 机制。只是没把对象模型切到底。所以 Phase 7 能小改修好，不是打补丁。
- **但轴错配是结构性复发源**：每加一个格子，D1 供料散布 + D4 per-leg if 都要在多处重演，且漏填=静默 500。全拆分把复发源一次性消除，符合 `long-term-wins` + `architecture-health-first`。
- **风险**：driver 是 byte-critical 热路径，5 codec + 4 handler 全动。故 RFC-first + 逐腿原子 cutover + golden 逐字节锁 + ≥3 轮对抗 review。

---

# 11. 定稿设计（v2）：集中化 2D cell 装配

> 取代 v1 的 §2-§10。综合 §0.1 三轮裁决。**核心转向**：不追求"两正交对象族"（被证伪），而是**把散布的"cell 需要什么"知识集中到单一 2D 装配器 + 用显式载体承载跨轴态**。

## 11.1 目标（措辞按 P1 收敛）
1. 把散布在 `{strategy-registry 供料袋 + 4 handler 供料工厂 + codec 跨格 delegate + codec 内 isForwardTranslateLeg 分叉}` 的"(clientFormat × targetEndpoint) cell 需要什么"知识,收敛为**单一 2D 装配解析器**——单一事实源。
2. **腿/cell 存在性由类型消灭复发**（cell-keyed `Record` 穷尽 → 漏 = 编译错,精确命中 Phase 7 那类"缺 case → default throw"）。**诚实边界**：类型穷尽**只覆盖 cell 存在性**;"`env.body` 是该 cell 的 canonical 形"这一维仍 unchecked（`env.body:unknown`,`envelope.ts:103`）,靠 assembly 内 `translateOut↔buildStrategies↔prepareWire` 三方约定 + §11.6 的 L1"每 cell buildStrategies 非空 + 不 throw"测试守卫。
3. handler 退回只管入站+写出:不填供料袋、不建 reverseBetaProbe/reverseMapperHolder、不持跨格 delegate。codec 不 import codec。
4. **行为逐字节/oracle 等价**（纯结构重构,现状 6 格+前向+反向腿全不变）。

**非目标**：路由决策、翻译语义、wire/history 数据模型、新格式/新腿、心跳策略完整收敛（§11.7 OQ1 留后续小 RFC）、web_search 旁路迁 driver。

## 11.2 三个对象 + 显式跨轴载体

```
InboundCodec (主分派轴 clientFormat)      CellAssembly[cf][te] (2D 键,driver 解析)
──────────────────────────────────       ──────────────────────────────────────
parse(raw) → env (写 prepareHints:         translateOut(env)          ← 读 env.clientFormat 选翻译器
  clientAnthropicBeta / clientHeaders /    requestRewrites()          (本腿上游 wire 改写链)
  truncateBaseline / resanitize 种子)      prepareWire(env)           ← 写 betaProbe.recordOutbound
renderStreamToClient(frame, env)                                        + 写 ctx side-channel(strippedCC…)
  ← 读 env.targetEndpoint 定上游腿形        buildStrategies(env)       ← 读 prepareHints 供料 + env.clientFormat
renderNonStreaming(resp, env)                                          选策略语义 + betaProbe 惰性引用
flushResponse?/getStreamMeta?             responseRewrites()
formatError / getContext / sampleClient   createAccumulator()        (§11.5 二选一)
  (exchange 态 responseId/itemId 住 ctx)   preSend?(env)              (Anthropic 截断)
        \                                  sampleWireTrack(wire, env) → 写 ctx.effectiveMessages…
         \____ hub-translate (叶子原语) ____/
```

**关键洞察（回应 P3+P4/HIGH-2）**：**正交的是"方法的主分派轴",不是数据隔离。** InboundCodec 的方法主键 clientFormat（但 render 读 env.targetEndpoint 作次要输入定上游腿形）;CellAssembly 主键 cell 两轴（translateOut 读 env.clientFormat 选翻译器）。两者都从 env 读另一根轴——这**不是缺陷**（env 携两轴）,但 RFC 不再声称"数据隔离的正交对象族"。

**跨轴态的三个显式载体（回应 BLOCK-2/BLOCK-3/HIGH-3/P2b,消灭闭包 accessor 群）**：
| 态 | v1（闭包 accessor,被证伪）| v2 载体 |
|---|---|---|
| parse 捕获的策略供料（truncateBaseline / resanitize 种子）| `codec.getTruncateBaseline()/getResanitize()` | **`env.prepareHints`**（parse 写、CellAssembly.buildStrategies 读）|
| betaProbe 种子（clientAnthropicBeta / clientRequestHeaders）| anthropic codec 闭包 | **`env.prepareHints`**（parse 写、prepareWire 读 seed betaProbe / 透传头）|
| side-channel recordings（pipelineInfo 重建的 effectiveMessages / initialSanitizationInfo / strippedCacheControl）| `codec.getLatestEffectiveMessages()` 等 4 accessor | **`ctx`**（prepareWire/sampleWireTrack/requestRewrites **写 ctx**,handler 的 `recordRetryPipelineStateV4` 从 **ctx 读**）|
| exchange 态（responseId / itemId / clientModel）| responses codec 闭包 | **`ctx`**（InboundCodec 建、prepareWire 与 render 两侧从 ctx 读）|

**betaProbe 生命周期写死（回应 P2a,本轮最该挡下）**：CellAssembly[/v1/messages] **per-request 建一次并贯穿整个 retry loop**（driver `resolveAssembly` per-request 解析一次,同实例 prepareWire 逐 attempt 调）。betaProbe 是 assembly 持的实例:`prepareWire` 调 `betaProbe.recordOutbound`（逐 attempt 累积）,`buildStrategies` 把**同一引用**传进 unsupported-beta strategy,strategy 在 **retry-handle 时惰性** `getCandidates()`——**绝非构造期快照**（照字面 eager-snapshot 会重造 Phase-7 级隐蔽 bug）。driver 顺序:`buildStrategies` 先于第一次 `prepareWire`（`driver.ts:202` vs `:309`）→ 靠"引用共享 + 惰性读"而非"先写后读"。

## 11.3 CellAssembly 的 2D 装配（回应 BLOCK-1）

策略栈**形状由 clientFormat 决定、wire 由 targetEndpoint 决定**——是二维函数。故装配分两半、由装配器组合:

```ts
// 入站供"策略语义 spec"(要不要 auto-truncate / maxRetries / label)——由 InboundCodec 或其 spec 表提供
interface RetrySemanticsSpec { autoTruncate: boolean; maxRetries: number; label: string; /* … */ }
const RETRY_SEMANTICS: Record<ClientFormat, (env) => RetrySemanticsSpec>  // anthropic/cc/gemini=auto-truncate+N; responses=no-truncate+1

// 腿供"wire 策略构造"——由 CellAssembly(by targetEndpoint)提供
// CellAssembly.buildStrategies(env) = 组合(RETRY_SEMANTICS[env.clientFormat](env), 本腿的 wire strategy builder, prepareHints 供料)
```
- **Responses fallback → /chat/completions** 与 **CC direct → /chat/completions** 命中同一 CellAssembly[/chat/completions] 但 `RETRY_SEMANTICS[openai-responses]`≠`RETRY_SEMANTICS[openai-cc]` → 策略栈不同,**逐字节等价保住**（现状 `responses:168` vs `chat:180` 的差异被 spec 表显式编码）。
- **装配解析器实现**：`resolveCellAssembly(clientFormat, targetEndpoint)` — 内部 `OUTBOUND_LEGS[targetEndpoint]`（wire 侧,Record 穷尽）× `RETRY_SEMANTICS[clientFormat]`（语义侧,Record 穷尽）。两个 `Record` 各自穷尽 → **cell 缺失 = 编译错**（BLOCK-1 的"漏的是 client×leg 组合"由两个正交 Record 的笛卡尔积覆盖,组合非法在 buildStrategies 内 fail-loud + L1 测试守卫）。

## 11.4 依赖方向（回应 P5,无环,保留 v1 §3.3）
```
routes/*/handler → driver → { InboundCodec[cf], resolveCellAssembly(cf, te) → CellAssembly }
                                        ↓ 都依赖 ↓          ↓ RETRY_SEMANTICS[cf] ↓
                                   hub-translate（叶子原语,不 import codec——P5 核实无环）
```
codec 不再 import codec（D3 delegate 全删）;gemini via-responses 的 Responses→CC 逐帧原语（`renderResponsesFrameToCc`+`createStreamTranslator`）**提取进 hub**（回应 HIGH-1）,gemini InboundCodec 独立持中间 translator 态 → delegate 才删得掉。

## 11.5 createAccumulator（回应 P7b,唯一"搬家非消除"实锤,二选一定死）
**裁定：删,不搬家。** `createResponseAccumulator` 全仓无生产消费者（pump 内联建）。v2 **不**把它放进 CellAssembly——accumulator 归 pump（handler),pump 按 targetEndpoint 内联建上游腿形 acc（现状即如此,保留）。§4.1 v1 把它列进 OutboundLeg 是错的,v2 撤回。（若未来 driver 接管 accumulate 是独立行为变更,超本重构范围。）

## 11.6 Cutover（回应 cutover reviewer 全部 HIGH）

**driver 5 构造点 + 单槽派发 + hybrid dispatch（承重,v1 藏在"原子切"三字里）**：driver 的出站派发是单槽（`deps.codec.prepareWire`/`deps.strategies`/`deps.requestRewrites`…）,`/v1/messages` 腿被 **4 codec/4 handler** 触达。cutover 真机制 = driver 在 C2-C4 期间**按 targetEndpoint 在 `resolveCellAssembly(...)` 与旧 `codec.*/deps.*` 间二选一派发**（hybrid dispatch shim,互斥非叠加）,逐 cell 迁移、跨 3 commit。

- **C0（进 C1 前必做）**：① 跑通现有 79 golden 锁行为;② **补 3 条缺失 byte golden**——(a) keepalive-ON anchored direct 流式（`direct-stream-golden-phase4` 关了心跳,anchored/reconcile 字节没锁）、(b) reverse @messages 转发逐帧字节（现 reverse-cc-messages 用 inspectRequest+accumulator,非转发 SSE 逐帧）、(c) responses-ws + gemini 两跳终帧。
- **C1**：定义 `CellAssembly` 接口 + `OUTBOUND_LEGS`/`RETRY_SEMANTICS` 两 Record（占位 throw）+ driver `resolveCellAssembly` + hybrid dispatch shim（**未接线任何 cell,过渡态无害=没人走 leg 分支**）。
- **C2**：实现 `AnthropicCellAssembly`(/v1/messages)——从 anthropic codec direct 分支 + strategy-registry anthropic supply + reverse-anthropic-rewrite **提取**;driver 对 /v1/messages 腿的 **4 route（messages direct + cc/responses/gemini 反向 @messages）全部**切到 assembly、**同 commit 删各 handler 的 reverse supply/betaProbe/mapperHolder + anthropic codec direct 分支**。**守卫（回应双 sanitize）**：C2 后 `grep createReverseAnthropicSanitizeRewrite / prepareReverseAnthropicWire / reverse assembleStrategiesForEndpoint(MESSAGES)` 归零 + 回归断言"reverse @messages 的 orphan-strip 计数不翻倍";**pipelineInfo 回归**（回应 HIGH pipelineInfo）:direct anthropic 重试后 `ctx` 的 messageMapping/cacheControlStripped 非空（正样本证 side-channel 经 ctx 触达,防静默变空污染 peer-D2 基线）。
- **C3**：`OpenAiCcCellAssembly`(/chat/completions)——driver 切 cc direct + anthropic/gemini 前向 @cc;删 cc codec wire 分支 + handler cc 供料 + anthropic ccDelegate 前向分支。
- **C4**：`OpenAiResponsesCellAssembly`(/responses+ws,含 CC→Responses wire)——driver 切 responses direct + 前向/反向 @responses;删 responses codec wire 分支。
- **C5**：InboundCodec 收敛（FormatCodec 去掉已迁走的出站方法,补 renderNonStreaming/getContext）+ 删 strategy-registry 供料袋/`assembleStrategiesForEndpoint`/`createResponseAccumulator` 死方法 + hybrid dispatch shim（此时所有 cell 已切,shim 退化）。**C5 前置门（可机检）**：`grep assembleStrategiesForEndpoint / StrategySupply / ccDelegate / isForwardTranslateLeg` 调用点归零。
- **C6**：清理 + gemini 命名剥前缀（`OpenAiGemini*`→`Gemini*`,`codec/openai-gemini/`→`codec/gemini/`,dry-run `openai-gemini`→`gemini`,零数据迁移——见 kickoff §命名）+ doc-sync。

**每 commit invariant**：typecheck 0 + `bun test`（除 base 6 例外:UI shell/negotiation/4 peer-D2 pipelineInfo）+ 全 golden（含 C0 补的 3 条）逐字节 + **无双活**（hybrid dispatch 互斥,旧路径同 commit dead）。

## 11.7 OQ 裁定（v1 §8 的 OQ 大多已被 review 解掉）
- **OQ1 心跳/sink 策略归属**：留后续小 RFC。C2-C6 handler pump **保留现状 clientFormat 分派不动**（direct Anthropic anchored 心跳仍在 handler）——但 C0 已补 keepalive-ON byte golden 兜底（否则"不动"也无 oracle）。
- **OQ2 web_search 旁路**：免疫（门在 driver 前用 decideRoute,不碰 codec 出站方法,§9 核实）。
- **OQ3 gemini 两跳 / exchange 归属**：**已决**——exchange 态住 ctx（InboundCodec 建、两侧读）;gemini Responses→CC 逐帧原语提取进 hub（§11.4）。
- **OQ4 sampleRequest 双轨**：effectiveRequest（客户端形）归 InboundCodec.sampleClientTrack、wireRequest（上游形）归 CellAssembly.sampleWireTrack;side-channel recordings 走 ctx（§11.2 载体表）。

## 11.8 验证（消费者校准,`large-refactor` §7）
- router golden 52 + 现有翻译 IT + byte-critical SSE golden（含 C0 补的 3 条）——每 commit 逐字节/oracle 等价。
- **新增守卫**：两 Record 穷尽性（编译）+ L1"每 cell resolveCellAssembly 成功且 buildStrategies 非空不 throw"（Phase 7 那类 bug 的直接守卫）+ reverse-sanitize 单次 + pipelineInfo 经 ctx 非空。
- 活服务器实测（收尾,隔离 XDG_DATA_HOME）:各 direct + 前向 gpt 无后缀 + 反向 @messages 端到端。

## 11.9 v3 修订（第二轮 review,7 项,主会话 file:line 复核属实,全采纳）

第二轮 reviewer 核了全部 12 个活 cell 的真实策略栈,总判"需 v3 局部修订、核心 RESOLVED"。下列**进 plan 前必解**:

**HIGH-A（§11.3 照字面即 BLOCK,已复核属实）**：auto-truncate 的有无**不是 clientFormat 标量**——`(openai-responses, /v1/messages)` 反向腿 auto-truncate **ON**（走 `buildAnthropicStrategies`-17,`responses/handler-v4.ts:157-165`）,而 `(openai-responses, /chat|/responses)` direct **OFF**（`buildOpenAiResponsesStrategiesForEnv`-3,`:168`,driver maxRetries=1）。**任一轴单独都拆不开**（对称:同 `/responses` 腿 cc/gemini/anthropic-forward 含 auto-truncate、唯 responses 客户端不含）。→ **v3 定稿**：`RETRY_SEMANTICS` 类型是 `Record<ClientFormat, (env) => RetrySemanticsSpec>`——语义半**显式读 `env.targetEndpoint`**（`RETRY_SEMANTICS[openai-responses](env)` 对 MESSAGES 腿返 auto-truncate:true+maxRetries:N、对 CC/Responses 腿返 false+maxRetries:1）。穷尽性内核不变（两 keyed Record 笛卡尔积覆盖全 cell 空间 → 漏=编译错）,但**撤回"干净语义×wire 二分"的修辞**——承认语义半是 2D 函数（读两轴）。**plan 必为 `(openai-responses,/v1/messages)` cell 补"auto-truncate 在栈内"回归/golden**（唯一同时击穿两轴标量的角落,最易漏）。**红线写进 plan：绝不把 autoTruncate 当 clientFormat 标量实现。**

**HIGH-B（§11.2(a) 载体选型,已复核属实）**：`PrepareHints`（`pipeline.ts:244`）契约是 **Replace semantics + attempt 0 清空**（每次 retry 完整覆盖）。把请求生命周期**稳定**态（truncateBaseline / resanitize 闭包 / betaProbe **可变句柄** / clientAnthropicBeta 种子）塞进 prepareHints → 首次带 hint 的 retry（如 unsupported-beta 返 `{excludeBetas}`）**整体覆盖**清空稳定基线 → auto-truncate under-truncate / prepareWire wrong-wire;betaProbe 可变句柄放 replace-semantics 直接自相矛盾。→ **v3 定稿**：请求生命周期稳定态住 **`RequestEnvelope` 新 readonly 顶层字段 `requestState`**（与 `model` 同级,`envelope.ts:86`,`with()` 浅拷贝保留引用）,**与 per-attempt 的 prepareHints 分开**。§11.2 载体表 row1/row2 的"prepareHints"改为"`env.requestState`"。

**MEDIUM（进 plan 前应解）**：
- **§11.2(b) ctx read-back surface**：`recordRetryPipelineStateV4` 读的 4 值,ctx 现有 `setAttemptCacheControlStripped`/`setAttemptEffectiveRequest`（write-only,`context/types.ts:448-449`）但**无 getter**,且 `truncateBaseline`/`initialSanitizationInfo` 在 ctx 上**无家**。→ plan 显式列要新增的 **ctx read-back getter + state**（truncateBaseline/initialSanitizationInfo）;`truncateBaseline` 是 **parse 输出**（非 prepareWire 写）,归 `env.requestState`（同 HIGH-B）非 ctx。**不违"非目标不改数据模型"**（加 ctx API 面 ≠ 改 history 持久 schema）,但须显式列 surface。
- **§11.2(c) exchange 载体补全 + 论证**：§11.2 漏了 `rebuiltMessages`（fallback 从 session history 重建的会话数组,prepareWire 必读,`openai-responses/codec.ts:488`）——载体必含。且 responseId/itemId/rebuiltMessages 是 **openai-responses 专属**态,plan 须论证 **ctx vs per-request `exchange scratch`（keyed off env）** 哪个更干净,别默认塞共享 ctx（4 格式共享的 lifecycle 对象挂格式专属 scratch 是泄漏）。**倾向 per-request exchange scratch**（InboundCodec 持,prepareWire 经 env 读）。
- **§11.6 hybrid shim 具名化**：driver 的"已迁腿集合"做成**具名常量 + 断言 C5 收敛为空**（C2:{MESSAGES}→C3:+{CC}→C4:+{RESPONSES,ws}）,别把二选一派发藏散文;C0 的 3 条 byte golden 须覆盖 shim **两分支**（assembly 路径 + codec 路径）。这是 `large-refactor` 认可的短命显式过渡态,非新 BLOCK。
- **§11 M2 补一句**：reverse 响应侧终端分类（`classifyReverseAnthropicTerminal`,**已是共享 leaf** `pipeline/reverse-terminal.ts`,非散布,不搬）+ reverse 非流式 render（`renderReverse*NonStreamingV4`）+ reverse honest-outbound 累加（pump `onUpstreamFrame`→Anthropic acc）**留 handler/pump 侧**——§11 显式写明,兑现 §0.1 对 M2 的承诺,免 plan 再争。

**LOW（文档一致性）**：§11.2 CellAssembly 方法图删掉 `createAccumulator()`（与 §11.5"删不搬家"矛盾;实测唯一调用点 `openai-gemini/codec.ts:214` 是 codec 内部 delegate,无 pump 消费,§11.5 删的裁定正确）。

**已 RESOLVED（第二轮确认 §11 真接住首轮）**：BLOCK-1 穷尽性内核、betaProbe 惰性生命周期、cutover 4-route 原子机制、gemini HIGH-1、render-两轴 HIGH-2、byte golden C0、createAccumulator 删裁定、**OQ1 心跳无耦合**（第二轮实测证伪"C2 迁 prepareWire 扰动 anchor 时序"——anchored sink 不读 betaProbe/recordFeature,prepareWire 在请求交换期跑、anchor 在响应 pump 跑,时间不重叠,零耦合）。

**总门槛**：HIGH-A + HIGH-B 必须在 plan 里落死（尤其 HIGH-A 的"语义半读两轴 + responses-reverse auto-truncate golden"红线）。核心设计（集中化 2D cell 装配 + 双 Record 穷尽）**站得住,可进 plan**——v3 是措辞精修 + 载体选型,非推倒重来。
