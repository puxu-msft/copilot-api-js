# 05 — 开发进度看板

跟踪 [04-migration-plan.md](./04-migration-plan.md) 的 commit 序列。每个 commit 完成后在此打勾并记录验证结果。

**图例**：⬜ 未开始 · 🟡 进行中 · ✅ 完成 · ⚠️ 完成但有遗留

---

## 总体进度

| 阶段 | commits | 完成 | 状态 |
|---|---|---|---|
| 设计文档 | — | — | ✅ |
| P0 地基 | 4 | 4/4 | ✅ |
| P1 改写 registry 化（请求侧） | 4 | 4/4 | ✅ |
| P1.5/P1.6（响应侧）→ 折入 P2 | — | — | ↪ 见 P1.5-SCOPE |
| P2 driver + 逐格式 | 6 | 1/6 | 🟡 |
| P3 统一收尾 | 4 | 0/4 | ⬜ |

> **P1 范围修订（2026-06-16，调研后）**：P1 原计划 6 commit。请求侧 4 个（P1.1 接口 + P1.2/P1.3 Anthropic full + P1.4 OpenAI focused）有干净 seam，已全部完成、字节等价、subagent reviewed。**响应侧 P1.5（响应改写注册）/ P1.6（错误帧→codec.formatError）经调研判定折入 P2**——其消费者（P1.5 的 S5 per-frame chain、P1.6 的 codec）是 P2 的交付物，强塞进 P1 = 半重构 byte-critical 流式 pump（forwarded SSE 字节风险）+ 过早造 codec stub，且与 P2.6 重叠。详见 P1.5-SCOPE / P1.5-OQ1（heartbeat 已裁决 option ①）。P1.1 的 `ResponseRewrite` 接口已前瞻定义 + 测试，P2 落地即消费。

---

## P0 — 地基

| # | commit | 状态 | invariant 验证 | 备注 |
|---|---|---|---|---|
| P0.1 | pipeline/envelope.ts + types.ts 接口定义 | ✅ | typecheck 绿；无消费者（grep 确认）；subagent review 无 CRITICAL/HIGH | R1 已解决（transport 侧 `WireRequest`→`PreparedRequest`）；RouteDecision 采 codec.md 版（无 from） |
| P0.2 | transport/send.ts 提取，client 改调用 | ✅ | 字节等价（手工逐行 + subagent review + 复核 combineAbortSignals 过滤 undefined）；全 offline 套件 2480 pass/0 fail；typecheck+eslint 绿 | 范围限定 OpenAI 两 client（关键坑）；Anthropic 待 P0.4 |
| P0.3 | observability 双轨收敛为单 bus 通道 | ✅ | golden fixture（context-bus-stream，改前改后皆过 + 连跑 10×）守 bus 事件流字节等价；全 offline 套件 2480 pass/0 fail；subagent review（git diff 逐项对照）无 CRITICAL/HIGH | ctx 直接 publish 所有 request.*；删 handleContextEvent/listeners/on/off；activeContexts 经 onSettled 回调；snapshotWithSummary 抽入 activity-summary 共享 |
| P0.4 | Anthropic effort 内循环 → effort-learning strategy | ✅ | strategy 单测连跑 15× 确定性；全 offline 套件 2489 pass/0 fail；subagent review（git diff 对照）结果等价、client 单次收发字节不变、无 CRITICAL/HIGH | client 删 2-attempt 循环（纯 dedent）；strategy 用 DI 注入 learn 避免 cache 污染；挂 token-refresh 后/body-field 前，与其它 400 策略消息互斥 |

## P1 — 改写 registry 化

| # | commit | 状态 | invariant 验证 | 备注 |
|---|---|---|---|---|
| P1.1 | rewrite-registry.ts 接口 + 装配器 | ✅ | 纯新增；8 unit pass/100% cov；typecheck+eslint 绿；subagent review 无 CRITICAL/HIGH（3 前瞻缺口已处置，见下） | 接口忠实 spec §1/§2；createState? + DI registry 参数两处刻意补充已文档化；M1/M3 钉进 JSDoc，M2 记入遗留 |
| P1.2 | Anthropic 请求改写注册（T*/A*） | ✅ | sanitize 输出 golden 逐字节（"装配==手写组合 oracle"自洽，10 scenario pass，5 带 didWork 反假绿）；全 offline 套件 2506 pass/0 fail；typecheck+eslint 绿；subagent review 无 CRITICAL/HIGH | 按**内聚函数边界**拆 3 模块（非 §4 sub-step）：sanitizeAnthropicMessages(A3-9) 被 web_search 复用 + stats 是整链残差，故不再细拆。模块在 MessagesPayload 层（P2 driver 用 env adapter 包成 RequestRewrite）。web_search 路径未动 |
| P1.3 | Anthropic prepare 子步骤注册（B*） | ✅ | wire+headers 字节等价由既有 prepare 套件守（anthropic-request-preparation.it + coerce-adaptive-thinking.it 共 46 scenario 全 pass）；新增 step-order + runner↔STEPS 耦合 4 unit pass；全 offline 2510 pass/0 fail；typecheck+eslint 绿；subagent review（逐行 diff 对照确认 buildAnthropicHeaders 逐字抽取）无 CRITICAL/HIGH | prepare 是**固定无过滤管线**→用数组声明序而非 P1.2 的 order-keys+appliesTo+sort（去 cargo-cult）。`PrepareStep`+`PrepareContext`；body B3-6 为 4 命名 step + buildWirePayload(B1-2) 作 ctx init + buildHeaders(B7-12) 内聚末 step（B8<B9<B10 留其内，同 A6<A8）。`steps` DI 参数（P2 prepareWire 复用 + rewrite_applied） |
| P1.4 | OpenAI CC/Responses 请求改写注册（O*） | ✅（聚焦） | O10 抽取为 `fillMaxCompletionTokens` + oracle 对比 5 unit pass；既有 CC/Responses 套件守 sanitize/prepare 字节等价；全 offline 2519 tests/0 fail；typecheck+eslint 绿；subagent review 无 CRITICAL/HIGH | **范围决策见下 P1.4-SCOPE**：OpenAI 改写已是命名函数 + handler 分散点应用 + prepare 极简，无单一组合可注册化；P1.4 只抽唯一内联的 O10，不强推单一链 registry（会改 cadence/byte），注册化下沉 P2 driver |
| P1.5 | 响应改写注册（A1-4/C1-2/P1-2） | ↪ 折入 P2 | — | **调研后折入 P2 的 S5 chain 重建**（P1.5-SCOPE）：响应改写已是命名 factory，应用在 byte-critical 交织流式 pump（raw-record/repetition/accumulate + A1/A2/A3 + setTimeout heartbeat），强推 run-registry = forwarded SSE 字节风险 + heartbeat misfit（P1.5-OQ1 裁决 option ①）。per-frame ResponseRewrite 接口由 P2 driver 真正消费 |
| P1.6 | 错误帧 formatter → codec.formatError | ↪ 折入 P2 | — | **折入 P2**：`codec.formatError` 需 P2 的 codec 存在（codec 是 P2 交付物）。三协议错误帧 formatter（`anthropicStreamErrorType`/`streamErrorToOpenAIErrorType`/`geminiStreamErrorStatus`）已共享 `classifyStreamError`、已是命名函数；P2 建 codec 时一并收进各 codec.formatError |

## P2 — driver + 逐格式迁移

| # | commit | 状态 | invariant 验证 | 备注 |
|---|---|---|---|---|
| P2.1 | driver.ts + stages/* 骨架 | ✅ | driver 单测 mock codec/transport 15 pass（编排 S1-S7 + 重试循环 + S3/S5 改写链 + buffer/flush + 非流式）；全 offline 2532 pass/0 fail；typecheck+eslint 绿；subagent review（逐行对照 retry-transport §2 + budget off-by-one 与 legacy 等价）无 CRITICAL/HIGH | `createPipelineDriver(deps)`：consume codec/transport/strategies/registry 为 opaque deps。FormatCodec 接口追加 types.ts。abort 抛原始 error（legacy parity，非 spec 草案的 action.error）；strategy.handle 抛错降级原始 error（try/catch）；reject carry reason 由 route/codec 成形（不在 driver 做格式决策）。observability 自动采样占位待 P3.2 |
| P2.2 | codec/openai-cc.ts | ⬜ | codec 单测 | |
| P2.3 | **CC 切 driver**（flag 可回切） | ⬜ | CC e2e+golden 等价；CC 现也记上游 sseEvents | |
| P2.4 | codec/openai-responses.ts + Responses 切 driver | ⬜ | Responses 等价（含 ws/force-fallback/stream-id） | |
| P2.5 | codec/gemini.ts + Gemini 切 driver | ⬜ | Gemini 等价（dropped params/sidecar error） | |
| P2.6 | **codec/anthropic.ts + Anthropic 切 driver** | ⬜ | thinking signature 往返；web_search 双跳等价 | 最复杂 |

## P3 — 统一收尾

| # | commit | 状态 | invariant 验证 | 备注 |
|---|---|---|---|---|
| P3.1 | 透传判断统一进 decideRoute | ⬜ | 表驱动 (格式×模型) 矩阵 | 3 非一致默认显式保留 |
| P3.2 | 数据采集全下沉 driver，删 handler 手动调用 | ⬜ | 所有格式双轨记录 | 补齐 sseEvents 缺口 |
| P3.3 | 删旧 handler + flag + 死代码 | ⬜ | knip 无悬空、全测试绿 | |
| P3.4 | 更新 docs/DESIGN.md 指向 v4 | ⬜ | 文档代码一致 | |

---

## 关键不变量检查清单（每 commit 必过）

- [ ] `bun run typecheck` 绿
- [ ] `bun run test:backend` 绿
- [ ] `eslint --fix` 无新增 warning
- [ ] `/history/api/entries/:id` 仍返回全量双轨 HistoryEntry
- [ ] `/api/logs` + `/api/status` 形状不变
- [ ] WS wire 协议不变
- [ ] 该 commit 可独立 revert（不依赖后续）
- [ ] golden fixture 无 diff（改写/wire/SSE/错误帧）

---

## 遗留与决策追踪

> 实现过程中发现的、需用户定夺或暂缓的项记录在此（参照"deferred items 完整文档化"原则：根因、当前行为、理想架构、为何暂缓、若做需改什么）。

### P2.1-M2 — 多 buffering rewrite 链的 flush 顺序未定义（P2.6 接响应改写前锁定）

- **发现于**：P2.1（subagent review M2）
- **根因**：driver 的 `flushChain`（driver.ts）按 rewrite index 升序 drain，flushed 帧穿过其后的 rewrites。当**两个** rewrite 都 buffering 时，「靠后 buffer 自己累积的帧」vs「靠前 buffer flush 后被靠后 rewrite emit 的迟到帧」的相对顺序未定义。
- **当前行为**：S5 响应改写 registry 在 P2 才填充；现实场景**至多一个 buffering rewrite**（tool-input-decode 独此一家），单 buffer 链的 buffer+flush + flush-threading 已测覆盖且正确。
- **为何暂缓**：P2.1 是骨架、registry 为空、无多 buffer 链；该顺序契约要等 P2.6 注册真实响应改写时才需锁定。JSDoc（flushChain）已注明此假设。
- **若做需改什么**：P2.6 注册响应改写时，若出现多个 buffering rewrite，补一条 buffer→buffer 链测试明确顺序契约（或保证设计上至多一个 buffering rewrite）。

### P1.4-SCOPE — OpenAI 请求改写为何不强推单一链 registry（聚焦抽取 O10）

- **背景**：P1.2 把 Anthropic 请求改写注册化，因为有干净的单一组合 `directSanitize = sanitize(toolName(preprocess(p)))`（per-request 复用）。
- **OpenAI 侧结构现实**（实测 chat-completions/handler.ts:187-216、responses/handler.ts:116-192）：
  - 改写**已是命名导出函数**（`applyChatCompletionsToolNameSanitization`/`sanitizeOpenAIMessages`/`stripImageGenerationTool`/`normalizeCallIds`/`applyResponsesToolNameSanitization`），唯一**内联**的是 CC 的 O10（max_completion_tokens 填充）。
  - 它们**分散一次性点应用**于 handler 各处，与 snapshot / ctx 创建 / 模型解析 / system-prompt 交织（如 O7 tool-name `mutate originalPayload.messages/tools` 就地改 snapshot 源；O11 strip-image 在 snapshot 后 ctx 前；O12 normalize-call-ids 在 system-prompt 后）。**不存在单一组合**。
  - prepare（O8 normalizeMaxTokens + O9/O14 headers）**极简**（2 步），不像 Anthropic 的 12 步 prepare。
- **决策**（用户确认"聚焦抽取 O10 + 文档化"）：P1.4 只把唯一内联的 O10 抽为命名可测函数 `fillMaxCompletionTokens`。**不**把已命名的点应用改写强行重组进单一链 registry——那会：① 改变它们相对 snapshot/ctx 创建的执行时机 → 动 history snapshot/行为；② 字节等价回归面大；③ 对已命名函数是投机性泛化（原则8 YAGNI）。
- **下沉 P2**：OpenAI 的 S3 请求改写注册化由 P2 driver 落地——driver 重构 handler 流程时本就要把这些点应用步骤归位到 S3 阶段，届时用 env adapter 包成统一 rewrite 链（与 P1.2 的 payload 模块 + env adapter 同构）。prepare（O8/O9/O14）极简，P2 prepareWire 直接调现有 `prepareChatCompletionsRequest`/`prepareResponsesRequest`，无需 step 列表（不同于 Anthropic B*）。

### P2-MUSTFIX1 — sanitize 模块 `changed` 信号不完整（P2 消费 rewrite_applied 前必修）

- **发现于**：P1.2（subagent review MEDIUM-1）
- **根因**：`request-rewrites.ts` 的 `sanitize-messages` 模块用 stats 信号推 `changed`（`totalBlocksRemoved>0 || systemReminderRemovals>0 || fixedNameCount>0 || inlineSystemConverted>0`）。但**改 payload 却不增删 block、不计入这四项**的改写（如 `rewriteHistoryServerTools:"downgrade"` 把 server_tool_use→tool_use 并拆分 assistant turn——block 总数不变）会被误报为 `changed:false`。
- **当前行为**：无功能影响——`changed` 在 P1.2 **不被消费**（JSDoc 已标 best-effort；`request.rewrite_applied` 事件化是 P2/P3）。
- **理想架构**：P2 用 `changed` 喂 `request.rewrite_applied{name, changed, stats}` 前，sanitize 模块的 `changed` 须准确。两条路：① `sanitizeAnthropicMessages` 多透一个 `changed`/`mutated` 信号（在它内部已知是否改过 messages）；② runner 对 sanitize 模块做 `result.payload` vs 输入 payload 的结构比较。倾向 ①（避免每请求 deep-compare 成本）。
- **为何暂缓**：P1.2 不消费 `changed`，准确化无当前收益且需改 sanitize 返回契约或加 deep-compare 成本。
- **若做需改什么**：P2 driver 接 rewrite_applied 时，按 ① 给 `sanitizeAnthropicMessages` 返回加 `changed` 字段并在 sanitize 模块透传；tool 模块的 `next !== payload` 已准确（preprocessTools/applyToolName 在 no-op 时返回同引用）。

### P2-CHECKPOINT1 — env-adapter 落地验证（pre-env transform 模块的回收保险）

- **发现于**：P1.2（subagent review MEDIUM-2）
- **背景**：P1.2 的 Anthropic 请求改写在 **MessagesPayload 层**（pre-env 形态），注册表 + appliesTo + order 是为 P2 driver 的 env-based `RequestRewrite` 铺路（trivial adapter：`apply(env) => env.with({body: module.apply(env.body, ctx).payload})`）。
- **checkpoint**：P2 落地 driver 时必须真正用上这层（payload 模块 → env adapter），否则注册表/appliesTo/order 对 3 个静态模块（2 个 `appliesTo:()=>true`）是投机性泛化（YAGNI），需回收为直接函数组合。CC/Responses（P1.4）的同形模块同此约束。

### P1.5-OQ1 — heartbeat 定时器注入无法用 per-frame `transform` 表达 ✅ 已裁决（option ①，2026-06-16）

- **发现于**：P1.1（subagent review M2）；**裁决于** P1.5 调研（实读 `startForwardedSseHeartbeat` 的 `setTimeout` 注入代码 handler.ts:935-970 坐实）
- **根因**：spec §4 把 `heartbeat(A4, order 999)` 列进 `ResponseRewrite` 表，但它由**独立定时器**触发——上游静默期（opus adaptive thinking 在 `content_block_start` 后停滞几十秒~数百秒）**没有上游帧到达**，而 heartbeat 恰恰要在静默期注入 `event: ping`。`ResponseRewrite.transform(frame, state)` 是严格「每来一个上游帧调用一次」模型，无法被定时器/idle 驱动。
- **裁决：option ①**——heartbeat **保留 handler-side 定时器旁路**，spec §4 表里那行降级为「概念归类」而非「真走 `ResponseRewrite` 接口」。理由：option ②（扩接口加 `onIdle` hook）为一个本质上是传输层 keepalive 的关注点污染响应改写接口；heartbeat 与「逐帧改写转发字节」是正交的两套机制（前者是 idle-driven keepalive、后者是 frame-driven transform），强行统一不健康。`truncation-marker(C2)` 是首帧触发，**可**用 transform 表达，不受影响。
- **P2 落地**：driver 的 S5 流式循环保留对 heartbeat 的独立装配（在 race idle-timeout 点注入），不进 ResponseRewrite chain。

### P1.5-SCOPE — 响应改写侧缺乏 P1 干净 seam，注册化下沉 P2 的 S5 chain 重建

- **背景**：P1.2/P1.3（Anthropic 请求侧）有干净的单一组合/固定管线可注册化（directSanitize / prepare steps）。
- **响应侧结构现实**（实测 messages/handler.ts:530-650 流式 pump、:995-1026 非流式序列、chat-completions/responses handler 同形）：
  - 流式：`processOneStreamEvent` 是 **byte-critical 手写 pump**，把 raw-record + token 计数 + repetition 检测 + A3(thinking-sig) + A2(tool-input-decode buffer/flush) + A1(server-tool-filter suppress/emit) + heartbeat(setTimeout) **交织**在一起。响应改写已是命名 factory（`createServerToolBlockFilter`/`createToolInputStreamDecoder`/`applyThinkingSignatureCompat`/`restoreStreamToolNames`/`fixStreamEventIds`）。
  - heartbeat（A4）定时器注入**不适配** per-frame `ResponseRewrite.transform`（见 P1.5-OQ1）。
  - 非流式：handler:995-1026 是清晰内联序列（marker→filterServerTool→recoverToolCallText→restoreNames→decodeToolInput），但与 P1.1 的 per-frame `ResponseRewrite` 是**不同 shape**（whole-response vs per-frame）。
- **决策**：把 per-frame 响应改写**强行重组进 run-registry** 会改 byte-critical 流式 pump（forwarded SSE 字节等价回归面极大）、撞 heartbeat misfit、且对已命名 factory 是投机泛化——与 P1.4 OpenAI 请求侧同一判定，但因 pump 交织 + timer 更甚。故响应改写注册化**下沉 P2 的 S5 chain 重建**：P2 driver 把 pump 拆成 S5（per-frame ResponseRewrite chain）+ 旁路观测（accumulator→subscriber）+ heartbeat 独立装配，届时 P1.1 的 `ResponseRewrite` 接口被真正消费。P1 阶段的 registry 化价值集中在**请求侧**（已完成：P1.2/P1.3 full + P1.4 focused）。
- **P1.1 接口已被前瞻验证**：buffer/flush（tool-input-decode）、suppress/emit（server-tool-filter）、createState 均已在 P1.1 JSDoc + rewrite-registry.unit.test 覆盖语义；P2 落地即消费。

### P1.2-INV1 — system-prompt override 须经 `env.body` 表达（注册 system-override 时钉成显式不变量）

- **发现于**：P1.1（subagent review L2）
- **背景**：spec §4 把 `system-override`（S1/S2/S3，order 000）列为 `RequestRewrite`。**注**：P1.2 只注册 T/A（tool + sanitize）；system-override 是独立 group，现在 handler 入口 `processAnthropicSystem`（messages/handler.ts:159）一次性跑（**非幂等**，prepend/append 每次都加），尚未注册化。待它注册时，能表达的前提是 **system prompt 在 `env.body` 内**——Anthropic 顶层 `system` / OpenAI `messages[0]` 均在 wire body JSON 内，故 `with({body})` 足够，**非 blocker**。
- **行动**：P1.2 落地 `system-override` 时用一条测试确证「system 改写经 `with({body})` 表达」，把这个隐式假设钉成显式不变量。S1-S3 **非幂等**（prepend/append 每次都加），只能 S3 入口跑一次，**绝不**进 S4 attempt 循环。

### R1 — `WireRequest` 同名两类型 ✅ 已解决（2026-06-16）

- **发现于**：P0.1（subagent review）
- **根因**：P0.1 按 retry-transport.md §3 新增 `src/lib/pipeline/types.ts` 的 transport 侧 `WireRequest`（`{ url, headers: Headers, body, stream }`，transport 实际发送字节）。`src/lib/context/types.ts:46` 已存在一个**不同形状**的 history 侧 `WireRequest`（`{ model, messages, payload, headers: Record<string,string>, format }`，per-attempt 记录快照，与 `EffectiveRequest`/`ResponseData` 构成 `Attempt` 对称三元组，被 `setAttemptWireRequest` 消费）。
- **决策**：改 **transport 侧**（新、零消费者、零风险）为 `PreparedRequest`，而非破坏 history 的对称三元组。理由：① transport 侧无消费者，改名零破坏（P0.2 的 `transport/send.ts` 尚未 adopt Transport 契约，无引用）；② history 侧 `WireRequest` 与 `EffectiveRequest` 在 attempt 记录语境对称、9+ 消费者、是合理既有设计；③ `PreparedRequest` 精确表达"`prepareWire` 产出的待发送 HTTP 请求"，与 `prepareWire` 呼应。
- **实施**：`pipeline/types.ts` 的 `WireRequest`→`PreparedRequest`（interface + `Transport.send` 签名 + JSDoc）；同步 `retry-transport.md`、`P0-foundation.md`。typecheck 绿，全 src 无残留引用（grep 确认）。
- **P2 派生方向（保留）**：transport 落地后，driver 从 `PreparedRequest` + env 派生 history 快照（model←env、messages/payload←body、format←env、headers←headers），消除 6 处 handler 手动 `setAttemptWireRequest` 构造（呼应 envelope-driver §4 自动采样 + 06-inherited-issues DI-3、原则7 统一数据源）。已写入 `PreparedRequest` 的 JSDoc。
