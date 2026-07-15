# RFC：对称四点 hook 模型 + 统一翻译进 driver

> 状态：**已实施**（2026-07-14→15，worktree `feat/hook-symmetric-4point`，7 phase 提交 e4e01b76→a05436a9；1 轮对抗评审 + verifier 验收）。大型架构重构，走 RFC-first（skill `large-refactor`）。实施期修正：① loader 从 data-URL 改项目内唯一文件（data-URL 不解析 `~/` 别名，spec 头部详）；② 各格式 config-freshness 前置按「parse 是否读 config 态」分治（cc 无条件 applyConfigToState / anthropic 条件 `if(payload.system)` / responses·gemini 不加）。
> 关联：hook 机制细节权威 [spec 2026-07-12-upstream-hook-middleware.md](../spec/2026-07-12-upstream-hook-middleware.md)（v3）；可行性实测 [PoC FINDINGS](../../exp/hook-symmetric-4point/FINDINGS.md)；shipped v2 ADR [2026-07-12-driver-orchestrated-upstream-hooks.md](../decisions/2026-07-12-driver-orchestrated-upstream-hooks.md)；被本 RFC 吸收/升级的重命名 plan [2026-07-14-upstream-hook-v3-rename-migration.md](../plan/2026-07-14-upstream-hook-v3-rename-migration.md)。

## 1. 动机与决策

**起点**：需求方要「按内容剥离客户端注入的消息块（TodoWrite `role:system` 样板）」，并要求用编程 hook 而非 config+regex 落地。深入后发现：hook 中间件机制**已实施合并 master（`118a9c33`）但无使用方**，且其请求侧挂载点 `onRequest` 在 sanitize/translate **之后**，拿不到客户端原生形状——剥客户端噪声必须在客户端原生形状上匹配才准。

**需求方的架构模型（本 RFC 的核心决策）**：每个改写点由数据在请求-响应生命周期里所处的**格式位置**定义，共**对称四点**：

| Hook 点 | 生命周期位置 | 数据格式 | 调用基数 |
|---|---|---|---|
| `client.inbound` | 请求刚 parse、任何翻译之前 | **客户端原生** | 每逻辑请求一次 |
| `upstream.outbound` | 请求 prepareWire 后、send 前 | 上游 wire | 每 attempt 一次 |
| `upstream.inbound` | 上游响应刚收、S5 前 | 上游原始 frame | 每 upstream frame |
| `client.outbound` | S6 render 后、投递客户端前 | **客户端协议** frame | 每 client frame |

`client|upstream`=body 形状、`inbound|outbound`=相对 proxy 方向。`hooks.exchange`（带 `next`）是跨在 upstream.outbound→upstream.inbound 之间的非方向性拦截器，单列。

**决策（需求方 2026-07-14 拍板）**：**方案 A——统一翻译进 driver + 四点全做**。四点全落在 driver 同一套边界、每格式 parse 都产出客户端原生形状。理由：长远正确、消除孤例、driver 成唯一边界权威；新增格式可复制模型。（方案 B「hook 按真实格式边界放、gemini 两端留 route」not-adopted——gemini 永久例外、特例扩散到 hooks/dry-run/history/render，见 FINDINGS 对比表。）

## 2. 根因：为何当前不对称（评审 HIGH-1 修正——非 gemini 局部，是四格式通病）

**初稿误判**：初稿说「gemini 是唯一孤例」。评审 + 主会话 grep 双重核实证伪——**四格式的 async system-prompt 注入全部在 route 层、早于 `codec.parse`/client.inbound**：
- **openai-cc**：[chat-completions/handler-v4.ts:157](../../src/routes/chat-completions/handler-v4.ts#L157) `await processOpenAIMessages(...,"openai-cc")`。
- **openai-responses**：[responses/handler-v4.ts:141](../../src/routes/responses/handler-v4.ts#L141) `await processResponsesInstructions(...)`。
- **anthropic**：[messages/handler-v4.ts](../../src/routes/messages/handler-v4.ts) `wireBody.system = await processAnthropicSystem(...)`。
- **gemini**：[gemini/handler-v4.ts:152](../../src/routes/gemini/handler-v4.ts#L152) `await processOpenAIMessages(...,"gemini")`。

`processOpenAIMessages`（[override.ts:131](../../src/lib/system-prompt/override.ts#L131)）首步 `await applyConfigToState()`，然后对既有 system/developer 消息**逐条跑 `applyOverrides`** + prepend/append 配置块——全在 route 层、早于 parse。

**双重症状**：
1. **gemini 独有的额外一步**：入站还多做**格式翻译** `Gemini→CC`（故 gemini 的 client 原生 `contents[]` 在 driver 之外）。
2. **四格式共有**：async system-prompt 注入在 route 层，故 spec §3.2 定位在「parse 后」的 `client.inbound` 对**任何格式**拿到的都是 **post-injection、既有 system 消息已被 `applyOverrides` 变换过**的 body，**不是纯 client-native**。

**为何是正确性问题（非风格）**：直接冲击核心动机——「剥客户端注入的 TodoWrite `role:system` 块必须在客户端原生形状上匹配才准」。当用户配了 `systemPromptOverride` 且正则命中 TodoWrite 文本时，`applyOverrides` 会在 client.inbound **之前**改写它，剥块 predicate 匹配不到——正是 RFC 要解决的「上游处理已把 role:system 转走」问题，只是元凶从 sanitize 换成 processOpenAIMessages。默认空配置下「四格式 client.inbound provenance 测」会**假绿**、有 system-prompt 配置时才暴露。

reviewer 曾据 gemini 症状判「client.inbound 只有三真相域」——**那是将就症状**。本 RFC 治的根因升级为：**四格式的 async 入站处理（翻译 + system-prompt 注入）统一下沉进 driver S1b、置于 client.inbound 之后**，让四点模型真正成立、client.inbound 对四格式都真 client-native。

## 3. 架构决策：独立 async `translateInbound` / 入站预处理阶段（S1b）

**核心决策（PoC 实测 + 评审 HIGH-1 泛化）**：新增一个 driver S1b 异步阶段，承接**四格式共有**的 async 入站处理，语义「客户端原生 envelope → driver 的 outbound-canonical envelope」：
- gemini：`Gemini→CC` 翻译 + `processOpenAIMessages`；
- openai-cc：`processOpenAIMessages`；
- openai-responses：`processResponsesInstructions`；
- anthropic：`processAnthropicSystem`（+ 现有同步 `preprocessAnthropicMessages` 保持其位）。

接口：`FormatCodec.translateInbound?(env): Promise<RequestEnvelope>`（gemini 含翻译，余格式仅 system-prompt 注入；纯同步无预处理的格式可省略=no-op）。**不改 `codec.parse` 为 async**：
- ① 会把「客户端原生 parse 边界」与「async 翻译/config reload」混成一个不可观察步骤，违反四点模型；② `inspectRequest` 当前同步（[types.ts:618](../../src/lib/pipeline/types.ts#L618)）复刻 S1–S3，改 async parse 会破坏性异步化 inspect/debug API（MEDIUM-1 详）；③ 四 codec 及大量直接 parse 测试都要迁移。独立 S1b 阶段让各格式按需 opt-in、阶段语义清晰、不污染 parse 合约。

**driver 请求侧新顺序**：
```
S1a parse（同步 native，四格式都产出客户端原生 body）
  → client.inbound hook（真 client-native，一次性，含防御性 body snapshot）
  → S1b await translateInbound（四格式 async 入站处理：gemini 翻译 + 各格式 system-prompt 注入）
  → S2 route + translateOut
  → S3 rewrite-in
  → upstream.outbound hook（旧 onRequest 位置，上游格式，一次性）
  → S4 exchange（含 exchange hook、upstream.inbound hook）
  → S5 rewrite-out → S6 renderResponse → client.outbound hook（见 §5 前置条件）→ sink
```

**承重红线**：
1. **`translateInbound` 必须在 retry loop 外**（一次性）——否则 buffered re-exchange 会重复触发 `processOpenAIMessages`、重复注入 system prompt。测试直接断言调用次数 == 1（PoC 已证机制）。
2. **model resolution 时序保持**：现 gemini route 在 await 注入前先 resolve model 并 `preResolved` 固化；S1a 须保留等价时序，否则 `applyConfigToState()` 后配置变化可能改 model lookup。
3. **history 双轨**：S1a 后 `client.inbound` 见客户端原生、`clientRequest` 原样轨记 native（parse 自然捕获，不再靠 gemini 专用 `originalBodyForHistory` 补偿）；S1b 后 effective/wire 轨记 CC/target-leg body。
4. **client.inbound 防御性 body snapshot = defense-in-depth**（spec §3.5，评审已核实）：真 codec 已 `structuredClone` orig.payload、`clientRequest` 结构性安全；snapshot 防未来非-clone codec + 落实不可变返回。测试直测「hook 收到的 body 与下游 parsed 引用独立」，非拿 clientRequest 当 oracle。
5. **hook cardinality 写进 API 类型 + 文档**：一次请求 / 每 attempt / 每 frame，防作者误用（有状态 hook 在 exchange 会被调 L1×L2 次）。

## 4. 各 route 的 async 入站处理下沉（四格式，非 gemini-only）

评审 HIGH-1 泛化后，本节从「gemini 重排」扩为**四格式统一下沉**：

- **各 route 收缩为 HTTP/lifecycle owner**：删 route 内的 `processOpenAIMessages`/`processResponsesInstructions`/`processAnthropicSystem`（[chat-completions:157](../../src/routes/chat-completions/handler-v4.ts#L157)、[responses:141](../../src/routes/responses/handler-v4.ts#L141)、[messages](../../src/routes/messages/handler-v4.ts)、[gemini:152](../../src/routes/gemini/handler-v4.ts#L152)）；gemini 另删 route 内 `convertGeminiRequestToOpenAI` + `originalBodyForHistory` 补偿。保留 Hono `c.json`、header/status capture、truncation 判断、`ctx.complete/fail`。
- **各 codec `translateInbound` 内做本格式的 async 入站处理**：gemini = 翻译 + `processOpenAIMessages` + 现 parse 内 sanitize/`fillMaxCompletionTokens`/`droppedParams`/truncate-baseline；openai-cc = `processOpenAIMessages`；responses = `processResponsesInstructions`；anthropic = `processAnthropicSystem`。
- **gemini 非流式出站下沉**：`renderResponseNonStreaming` 内做 `convertOpenAIResponseToGemini`（流式出站 render 已在 codec）。
- **model resolution 时序保持（承重红线 2，评审已核实成立）**：model 解析留在 **parse/S1a**（`parseGemini` 经 `raw.preResolved ?? resolveModelTarget`，[codec.ts:258](../../src/lib/codec/gemini/codec.ts#L258)），**先于** S1b `translateInbound` 的 `applyConfigToState` config reload——即便 route 收缩后不再传 `preResolved`，parse 自身 fallback 仍在 S1a 解析、时序天然保持。**RFC 显式声明：勿靠 route 传 preResolved 来保时序**。

## 5. client.outbound 的架构前置条件（评审 MEDIUM-2——无单一 egress choke point）

`client.outbound`（响应发客户端前、客户端格式、逐 client-frame）**没有单一 egress choke point**，这是评审核实的承重约束，不能当普通 hook 点接线：

- [renderFrames 注释](../../src/lib/pipeline/driver.ts#L1028)是一条 load-bearing 架构约束：「forwarded-frame sampling 留在 handler 侧……gemini 整流翻译器 + anthropic timer 驱动 heartbeat 不流经这个 yield 点、无法表达为 per-frame rewrite，故 driver 无法拥有 forwarded sampling 而不重引入被推迟的 byte-critical 风险」。
- 客户端帧分散多层产出：渲染帧经 `renderFrames`→sink.write；handler 后处理 `onRenderedFrame`（tool-name restore）；**sink 层合成帧** `writeSynthetic`（错误终止帧）/`writeAnchor`/heartbeat ping **不经 renderFrames**。
- 「S6 render 后」这个点**看不到 sink 层注入的合成/心跳帧**，与「每 client frame」自相矛盾。唯一见全量 client 字节的点是 **sink write 串行层**,但那里 provenance（真实 vs 合成）已混杂,且必然继承 spec §9 已记录的 forwarded 标记覆盖缺口（Responses `restoreAndAccumulate` 丢标、translate 腿累加器标记 ill-defined）。

**决策修正**：`client.outbound` 的正确实现**依赖一个前置条件——sink egress 统一化**（把所有 client 帧汇聚到单一可挂载的串行点）。故 `client.outbound` **拆为独立后续 phase、门槛设为 sink egress 统一**，不塞进四点首版一次做完。这是对初稿「对称四点缺一不可、首版全做」的修正——**对称四点是设计目标（命名 + 语义都到位）；`client.outbound` 的接线晚一个 phase、有明确前置**。（此点触及需求方「四点全做」的显式决策，见本 RFC 末「待需求方确认」。）

## 6. 与 shipped v2 + 重命名 plan 的关系

本 RFC **吸收并升级** [重命名 plan](../plan/2026-07-14-upstream-hook-v3-rename-migration.md)：命名迁移（旧三名 → 嵌套 `hooks.{client,upstream}.{inbound,outbound}`+`exchange`）成为一个 phase；`client.inbound` 从「S2 前但 gemini 特例」升级为「S1a 后 + S1b 使全格式 client-native」；`client.outbound` 命名/语义到位、接线拆到有 sink-egress 前置的后续 phase（§5）。spec §12 迁移面仍有效。

## 7. 分 phase 提议（每 phase 带 commit invariant）

- **Phase 0**：预捕获 passthrough golden（hook 未配置=字节等价）+ **四格式**现状 golden（尤其 gemini Gemini→CC→Gemini round-trip、及各格式带 systemPromptOverride 配置的注入结果）作跨重构 oracle。*终态：新增测试全绿。*
- **Phase 1**：命名迁移（shipped 三名 → 嵌套分组）——纯重命名，**commit invariant 原子**（改接口同 commit 改 driver wire + loader + 全测试 fixture，含 spec §12 触点 + `anthropic-cli.e2e.test.ts:56`）。*终态：typecheck 绿、passthrough golden 守恒、旧名零残留。*
- **Phase 2**：引入 driver S1b + `FormatCodec.translateInbound?`（先四 codec no-op 占位）**+ inspectRequest async 化全套**（评审 MEDIUM-1，必须全做非"或"）：① `withCapturingManager` 改 async-aware（try 内 await fn 结果，否则同步窗口在 async 副作用执行前关闭、隔离失效）；② `inspectRequest` 返回 `Promise<RequestInspection>`、dry-run 所有调用点补 await；③ `RequestInspectStage`（现 `parse|translate|rewrite-in|prepare-wire`）增列 S1b stage 或声明折叠语义；④ 记录 gemini dry-run `parse` stage 输出从 CC 变 native 的契约变更。*终态：typecheck 绿、dry-run 测试全绿、no-op translateInbound 不改行为、golden 守恒。*
- **Phase 3**：四格式 async 入站处理下沉（route→S1b translateInbound：gemini 翻译 + 各格式 system-prompt 注入 + gemini 非流式出站）。**commit invariant（评审 LOW）：每格式的「route 删预处理」与「codec translateInbound 加预处理」必须同一 commit 原子**（先加不删=双重注入违反红线 1；先删不加=丢处理请求崩）；Phase 0 golden 跨此 commit 守恒作守卫。*终态：typecheck 绿、四格式 golden 守恒、processOpenAIMessages 每请求调用==1。*
- **Phase 4**：client.inbound + upstream.outbound/inbound + exchange 四点接线（client.inbound 真 client-native + 防御性 snapshot + cardinality 类型）+ 四格式 client.inbound provenance 测（**含带 systemPromptOverride 配置的用例**，证 client.inbound 见 pre-injection 原生 body）。client.outbound **不在此 phase**（§5 前置）。*终态：typecheck 绿、四格式 provenance 测全绿。*
- **Phase 5**：四格式剥块 helper + 剥 TodoWrite 示例 hook（四格式现在都在客户端原生形状上，四 accessor 名副其实）。*终态：四格式剥块测全绿。*
- **Phase 6（gated）**：sink egress 统一化 → client.outbound 接线（§5 前置满足后）。*终态：sink 单一 egress 点 + client.outbound provenance 测。*
- **Phase 7**：文档同步（spec/ADR/DESIGN/backlog/skill/memory）+ verifier 穷尽审计 + dry-run/E2E 复验。

## 8. Open questions（评审后更新）

1. `translateInbound` 后 `env.body` 从 native 变 canonical——history「effective」轨是否需新增「S1b 后」快照，还是复用现有 stages？（评审建议：若四格式统一下沉，此快照点从 gemini-only 泛化为四格式共有，一并设计。）
2. ~~inspectRequest async 隔离~~ → 已升级为 Phase 2 的确定性工作项（评审 MEDIUM-1），非 open question。剩余：`processOpenAIMessages` 的 config reload 在 dry-run 下是否该 mock（避免 inspect 触发真实 config 副作用）？
3. `client.outbound` 的 sink egress 统一化具体形状（Phase 6 前置）：把 renderFrames + sink 合成/心跳帧汇聚到单一可挂载串行点的最小改动，以及其继承的 §9 forwarded 标记覆盖缺口如何处理。
4. ~~cc/responses 是否有 async 入站预处理~~ → 已核实**四格式都有**（评审 HIGH-1），非 open question，已并入 §2/§3/§4 决策。

## 9. Not-adopted 记录

- config+regex 声明式消息块过滤引擎（灵活性不足，需求方否决 → 编程 hook）。
- `parse(): Promise<RequestEnvelope>`（破坏同步 inspectRequest + 全 codec 迁移，独立 S1b 阶段更小按需）。
- 方案 B（gemini 两端留 route）——永久例外、特例扩散。
- ~~client.outbound 首版全做~~ → 修正为「命名/语义到位、接线拆到有 sink-egress 前置的 Phase 6」（评审 MEDIUM-2，无单一 egress choke point）。

## 10. 需求方确认记录

- **client.outbound 接线晚一个 phase（2026-07-14 需求方拍板）**：对称四点的**命名/类型/语义首版全到位**（四个 hook 都声明、类型存在），但 `client.outbound` 的**实际逐帧接线放 Phase 6**、前置是 sink egress 统一化（§5/Phase 6）。其余三点 + 剥块功能先落地。**非砍掉、非无限延后**——有明确前置的排期。（备选「sink 统一化前移、四点同批真接线」not-adopted：sink egress 统一化本身是有 byte-critical 风险的重构，[renderFrames 注释](../../src/lib/pipeline/driver.ts#L1028)明言推迟过，同批会抬高工程量与风险。）
