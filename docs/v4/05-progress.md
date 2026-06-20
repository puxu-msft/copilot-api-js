# 05 — 开发进度看板

跟踪 [04-migration-plan.md](./04-migration-plan.md) 的 commit 序列。每个 commit 完成后在此打勾并记录验证结果。

**图例**：⬜ 未开始 · 🟡 进行中 · ✅ 完成 · ⚠️ 完成但有遗留

---

## ▶ 当前位置 / 下一步（防呆——每会话先看这里）

- **已完成到**：**P2 全部完成（P2.1-P2.6 ✅，6/6）**。P0/P1/P2 ✅。P2.6（Anthropic 切 driver）RFC 已 4 轮收敛（[docs/rfc/p2.6-anthropic-driver-migration.md](../rfc/p2.6-anthropic-driver-migration.md)，§12 round-4 裁决）。C0-C5 全部提交：`80a2157` C0（共享 driver 契约）、`044e895` C1（transport rewriteShutdownAbort hook）、`c4a2786` C2（codec+8 策略）、`db8e67b` **C3a**（streaming-pump.ts 抽取,纯移动）、`f7f2f4c` **C3b**（handler-v4 + route flag OFF）、`9d51857` 等价测试（15 测试）、`b8adf80` **review 修复**（web_search 路由校验对齐 legacy）、`94d6a23` 测试加固、`977a634` **C4**（flag ON）。每 commit subagent review + 主线亲自核验,**全 backend 2707 pass / 0 fail 经 v4**（另有 2 个无关 FileSink 预存失败,属 observability-rewrite WIP 域,非本迁移引入）。
- **下一步**：**P3 统一收尾**（4 codec 已齐、4 格式全在 driver 上、flag 全 ON）。P3.1 透传统一进 decideRoute / P3.2 数据采集全下沉 driver（含 P3.2b 删各 handler 手动 setter + 补 sseEvents 缺口）/ P3.3 删旧 handler + flag + 死代码 / P3.4 更新 DESIGN.md 指向 v4。续接 prompt 见 [prompts/P3-unify.md](prompts/P3-unify.md)。
- **✅ P2.6 已完成,P3 解除封锁**：4 格式（CC/Responses/Gemini/Anthropic）codec 齐、全在 driver 上、flag 全默认 ON,legacy handler 仍在树（可 toggle 回切）待 P3.3 删。P3.1（透传统一,需 4 codec 齐）与 P3.3（删 handler）的前置条件均已满足,**现在可粘 `prompts/P3-unify.md`**。P2.6 遗留见 P2.6-D1～D4。
- **排程已重排（2026-06-17，architect subagent 验证）**：原计划把「driver 自动采样」整体放 P3.2（所有格式迁完后）。重排为——**P3.2 拆两半**：`P3.2a`（driver 加采样，共享机件，**提前到 P2.3 收尾**做一次 4 格式同受益）+ `P3.2b`（删各 handler 手动 setter，**锚定各格式迁移点**，不可提前——删不了还在 legacy 的格式的 setter）。`P3.1`（透传统一）**不提前**（需 4 codec 齐）。**翻 flag ON 的硬 gate = L1 行为等价 ∧ L2 记录等价**，逐格式各过各的 gate。详见 P2.3-L1/L2。

### P2.3 收尾排程（重排后，已落地）

| 步 | 内容 | 状态 | 备注 |
|---|---|---|---|
| **P2.3-S**（=原 P3.2a，提前） | driver 请求侧双轨采样（effectiveRequest/wireRequest）+ queueWaitMs；响应侧上游 sseEvents（改进）+ 删 handler-v4 setter | ⚠️ **请求侧 ✅**（codec `sampleRequest` + driver per-attempt + transport queueWaitMs；L2 双轨等价测试齐；O10 双轨语义裁决——只落 wire 轨；HIGH-1 退避计入修复）。**响应侧上游 sseEvents（改进，非等价项，legacy CC 也空）+ 删 handler-v4 response setter → 归 P3.2b（跨格式一次做）** | |
| **P2.3-H**（=L1 边缘） | abort/idle/shutdown + auto-truncate 标记等价 | ✅ **由「全套件经 v4」满足**——翻 flag ON 后现有 CC 全套件（含 shutdown-mid-stream 等）经 driver 跑、2584 全绿；handler-v4 流式 catch→error-frame 路径经 shutdown(v4) 覆盖，idle 走同代码路径。**可接受次要缺口**（legacy-parity）：abort-return 委托分支（326-327，委托已测的 `settleStreamingFailure`）、auto-truncate marker（verbose-only，legacy 亦无 http 测）、防御性 JSON.parse catch | |
| **P2.3-ON** | `driver-flags.ts "openai-cc": true`（默认 ON）；测试隔离修复（v4 测试 afterEach 还原默认值，不泄漏 false） | ✅ | 全套件 2584 pass/0 fail 经 v4 = 宽 oracle 综合等价；legacy handler 仍在树（可 toggle 回切），P3.3 删 |

> 此后 P2.4-2.6 建立在「请求侧已采样 + 已 canary 压实」的 driver 上：codec 提供 `sampleRequest`/`createResponseAccumulator`（复用 driver 采样）+ 各写格式 oracle；各格式翻 ON 同样过 L1∧L2。响应侧采样下沉（上游 sseEvents + 删 handler setter）跨格式统一在 P3.2b。

---

## 总体进度

| 阶段 | commits | 完成 | 状态 |
|---|---|---|---|
| 设计文档 | — | — | ✅ |
| P0 地基 | 4 | 4/4 | ✅ |
| P1 改写 registry 化（请求侧） | 4 | 4/4 | ✅ |
| P1.5/P1.6（响应侧）→ 折入 P2 | — | — | ↪ 见 P1.5-SCOPE |
| P2 driver + 逐格式 | 6 | 6/6 | ✅ |
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
| P2.2 | codec/openai-cc.ts | ✅ | codec 30 单测 pass（unit：decideRoute 矩阵/translateOut=identity/prepareWire 两分派+dropped 去重+normalizeCallIds gating/renderResponse 3 循环行为+function_call 跨帧+completed 双帧/formatError 三类型/createResponseAccumulator；it：parse env 字段+azure override+model 解析+tool-name mapper+orphan 过滤+未知模型）；全 offline 2561 pass/0 fail；typecheck+eslint 绿 | per-request 有状态工厂 `createOpenAiCcCodec()`（闭包持 translator 状态）；translateOut=identity + CC→Responses 落 prepareWire（auto-truncate strategy 契约强制，见 P2.2-D1）。stream-error.ts 抽 `streamErrorKindToOpenAIErrorType`（DRY）；RawHttpRequest +method/+path。**不接线**（旧 handler 仍在用）。5 条遗留见下 |
| P2.3 | **CC 切 driver**（flag 可回切） | ✅ | v4 路径全接线 + 7 http 等价测试逐项 v4↔legacy 字节等价（client 输出 + outbound wire）；**收尾 S/H/ON 后 flag ON、全套件 2584 pass/0 fail 经 v4**；typecheck+eslint 绿 | 分 5 commit：transport adapter（fd6c637）+ env-strategy bridge（2d8967e）+ 路由接线（2790d50）+ ctx-settle review 修复（6dbe053）+ **P2.3-S 请求侧双轨采样（6cc8b9c）+ 本（隔离修复+翻 flag ON）**。driver +策略工厂+per-attempt 采样；codec +`getTruncateBaseline`/`getContext`/originalBodyForHistory/preResolved/`sampleRequest`；driver-flags **默认 ON**；handler-v4 含 D3/D6/D2/S5 tool-restore/失败 settle。收尾详情见顶部「P2.3 收尾排程」（S 请求侧✅响应侧→P3.2b / H 经全套件满足 / ON 默认 ON）|
| P2.4 | codec/openai-responses.ts + Responses 切 driver | ✅ | v4 路径全接线 + 14 http 等价测试逐项 v4↔legacy 等价（直连流式/非流式 + fallback(Responses→CC) + Google force-fallback + stream-id-sync + normalizeCallIds + reject + network-retry + L2 双轨 + 上游 WS）；**flag ON、全套件 2598 pass/0 fail 经 v4**；流式/WS/fallback 连跑 15× 确定；typecheck+eslint 绿；subagent review + 亲自实测复核（C1 假阳性、M1 已修+回归测试） | per-request 工厂 `createOpenAiResponsesCodec()`；**translateOut=identity + Responses→CC fallback 落 prepareWire**（保 effective 轨=openai-responses，对齐 legacy pipeline，openai-cc P2.2-D1 同构）；上游 WS-attempt 抽 `upstream-ws-attempt.ts` 与 legacy `createResponses` 共享（字节等价，client it-test 守）；`translateCCStreamToResponsesStream` 重构为逐帧 `createCCToResponsesStreamTranslator`（translate+flush）供 codec 复用（oracle: responses-to-cc-request unit）；客户端 WS 复用同 driver（含 fallback，CC-only/Google 经 WS 现可用）。5 条遗留见下 |
| P2.5 | codec/gemini.ts + Gemini 切 driver | ✅ | v4 全接线 + 7 http 等价测试（generateContent 非流/流 + via-responses(Gemini→CC→Responses) + Gemini-shape error frame + dropped-params 警告 + L2 双轨 + completed 终态）；**flag ON、全套件 2606 pass/0 fail 经 v4**；Gemini 流式连跑 12× 确定；typecheck+eslint 绿；subagent review + 亲自核验（HIGH stream.onAbort 已修+回归、2 LOW 已处理） | **薄翻译层委托范式**：gemini codec 持内部 `createOpenAiCcCodec()` 实例，decideRoute/translateOut/prepareWire/renderResponse/renderResponseNonStreaming/sampleRequest/createResponseAccumulator **全委托 cc**（不调 cc.parse——这些方法对 env 纯，唯一 cc 闭包态是 via-responses translator，lazily 建于 cc.renderResponse）；codec 只自做 parse(Gemini→CC + gemini-generate-content ctx + Gemini-shape original + O10 fill) + Gemini error。**renderResponse 产 CC 帧**（非 Gemini）——CC→Gemini 整流翻译留 handler-v4（`translateOpenAIStreamToGemini` 不重构、零字节风险，同 legacy）。countTokens 仍 legacy（本地 tokenizer，无管线）。复用 createUpstreamHttpTransport + CC strategies。3 条遗留见下 |
| P2.6 | **codec/anthropic.ts + Anthropic 切 driver** | ✅ | v4 全接线 + 15 http 等价测试逐项 v4↔legacy 字节等价（直连流/非流 + thinking+signature_delta 逐字 + alias + network-retry + L2 双轨含 payload 内容 + sseEvents/inboundResponse 双轨 + reject 双路 + **reject→failed 忠实 middleware** + **H2 终态 error 帧恰转发一次→ctx.fail 非 throw** + **H3 mid-stream throw→pump catch 合成 error 帧** + deferred-tool 往返 非流/流 + /anthropic 别名）；**flag ON、全套件 2707 pass/0 fail 经 v4**；流式/时序连跑 15× 确定；typecheck+eslint 绿；subagent review（实现+测试双视角）+ 亲自核验每条 file:line（M1 web_search 路由校验已修+回归、H1/H2 driver 层分歧已文档化、C1 oracle 可信度已修） | 最复杂。**bypass-direct 格式**：codec translate/render=identity,driver 逐字透传上游 Anthropic SSE,handler-v4 复用 streaming-pump byte-critical 原语,只换流源为 driver.runResponse + 内联 parse+accumulate+break（guard 由 transport 承担）。C0(80a2157)+C1(044e895)+C2(c4a2786)+C3a(db8e67b pump 抽取)+C3b(f7f2f4c)+等价测试(9d51857)+review 修复(b8adf80)+加固(94d6a23)+C4(977a634)。H1 transport shutdown→529 在 http-transport.it 层覆盖。4 条遗留见 P2.6-D1～D4 |

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

### P2.6-D1 — web_search 双跳整条留 legacy ctx,绕过 v4 driver（暂缓）

- **发现于**：P2.6 RFC §1/§12.7 设计裁决 + C3 实现。
- **根因**：web_search 双跳（拦截含 native web_search server tool 的请求 → 真实搜索 → 主模型二次生成）是一条与单跳 driver 编排正交的控制流,搬进 driver 需为 driver 引入"双跳"概念。RFC 裁定整条 web_search 留 legacy `handleWebSearchCompletion` + legacy 轻量 ctx,作 P2.6 暂缓项。
- **当前行为**：v4 route 在 `state.webSearchEnabled && payloadHasWebSearch(wireBody)` 时复现 legacy 轻量 ctx（`createWebSearchContext`）并调 `handleWebSearchCompletion`,**不进 codec/driver**。与 codec.parse 的小重复（ctx 创建）被接受。**review 修复（b8adf80）**：web_search 分支前补回 `supportsDirectAnthropicApi` 路由校验,对齐 legacy 在 ctx 创建前的无条件校验（否则非 Anthropic 模型 + web_search 会绕过校验静默进双跳）。
- **理想架构**：driver 支持多跳编排,或 web_search 作为一种 codec 变体。
- **为何暂缓**：web_search 是低频 opt-in 特性（`webSearchEnabled` 默认 false）,搬进 driver 的收益 < 给 driver 引入多跳复杂度的成本,且与 P2.6 主线（单跳 byte 等价）正交。
- **若做需改什么**：driver 增多跳 step 或 codec 多跳变体;handler-v4 删 web_search 拦截分支;web_search 等价测试纳入 v4 canary（当前 `webSearchEnabled=true` 时 canary 覆盖不完整,因该路径不经 v4）。

### P2.6-D2 — driver `onMeta`（仅 meta 存在时触发）vs legacy `onRetry`（无条件触发）的 retry 可观测性分歧（driver 层,跨 4 格式）

- **发现于**：P2.6 C3 subagent review（实现视角）+ 亲自核验 effort-learning-retry.ts:74 / driver.ts:217 / pipeline.ts:368,377 / handler.ts:368-408。
- **根因**：legacy pipeline `onRetry` 在每次被预算门接受的 retry **无条件**触发,其回调 `recordRetryPipelineState` 总是重建 messageMapping + recordFeature；且 `setAttemptSanitization` 在 `action.meta?.sanitization` 存在时记 per-attempt。v4 driver 的 `onMeta` 仅在 `action.meta` 存在时触发（driver.ts:217 `if (action.meta)`）,而 effort-learning 策略返回无 meta 的 retry。
- **当前行为**：(a) 无-meta retry（effort-learning）在 v4 不触发 `recordRetryPipelineStateV4`。**实际影响微**:effort-learning 的 payload 不变（仅重新 prepare effort）,故 messageMapping 对初始/retry 等同、thinking 初始已记,**唯一差异 = legacy 在无-meta retry 记一个误导性的 `truncated` feature tag（else 分支）,v4 不记（v4 反更正确）**。(b) auto-truncate retry（有 meta.sanitization）在 v4 经 onMeta 记**聚合** `setPipelineInfo.sanitization`,但不记 legacy 的 **per-attempt** `setAttemptSanitization`——**信息保留**（聚合里有）,仅 per-attempt 副本缺。
- **理想架构**：driver 区分"无条件 per-retry 钩子"（重建聚合 pipeline-info + per-attempt sanitization）与"meta-gated 钩子",或把 per-attempt sanitization 记录下沉 driver（与 `setAttemptEffectiveRequest`/`setAttemptWireRequest` 并列,driver.ts:162-166 已 per-attempt 记这两轨）。
- **为何暂缓**：这是 **driver 层跨 4 格式的 P2.3 既定 onMeta 契约**,非 P2.6 anthropic 引入——CC/Responses/Gemini 早已 flag ON 用同样 pattern 过 canary。改 driver retry 钩子语义影响全 4 格式,需独立的跨格式 RFC + 重验,不在 P2.6 anthropic C3 范围。且两项实际影响小（(a) v4 更正确;(b) 信息聚合保留）。
- **若做需改什么**：driver.ts 加无条件 onRetry 钩子 + 把 per-attempt sanitization 记录搬进 `runExchange` 的 retry 分支;4 格式 handler-v4 各自的 onMeta 回调相应调整;回归 4 格式 L2 双轨测试。建议归 P3.2（数据采集下沉 driver）一并处理。

### P2.6-D3 — reject（不支持的模型）在 v4 记一条 `failed` history entry,legacy 不记任何 entry（与 CC P2.4-D3 一致,有意）

- **发现于**：P2.6 C3 review + RFC §11.5,与 `mem:` P2.4-D3 同构。
- **根因**：legacy 路由校验在 ctx 创建前（handler.ts:169）,reject 时 entry 从未插入。v4 codec.parse **无条件**先建 ctx（触发 history insert）,再 decideRoute reject。
- **当前行为**：v4 reject → handler `c.set("requestContext", ctx)` 后 throw HTTPError → observabilityMiddleware 经 4xx `completeFromHttpStatus` 把 ctx fail → **failed entry（非 dangling）**。legacy reject → 无 entry。**已由装 middleware 的忠实 app 测试裁决**（`anthropic-v4.http.test.ts` reject→failed,替代需起服务器的实测,守 no-auto-server）。
- **为何接受**：与 CC/Responses/Gemini 一致（P2.4-D3 已定为有意分歧,richest-data-flow——v4 记更多）。理想态由 P3.1 透传统一时整体复核 4 格式 reject 形态。

### P2.6-D4 — 等价测试经 mock-fetch 绕过生产上游 transport（handler-equivalence 范围,可接受）

- **发现于**：P2.6 等价测试 subagent review（测试视角）。
- **根因**：`anthropic-v4.http.test.ts` 经 `applyFetchMock` 把上游桥到 mock,真实 `transport/upstream-fetch.ts` / `http2-client.ts` / undici dispatcher 路径不被调用（与 CC/Responses/Gemini v4 测试同范式）。
- **当前行为**：测试验证 handler/pump 层 v4↔legacy 等价,**不覆盖 transport 层 framing**。H1（transport shutdown→529 `rewriteShutdownAbort`,v4 专属 opt-in）由 `tests/transport/http-transport.it.test.ts:118-193` 在忠实 transport 层覆盖三态,handler-v4 已 opt-in;故 transport 层分歧在其专属测试覆盖,不在 handler-equivalence 文件重复。
- **为何接受**:handler-equivalence 测试的目的是 handler/pump 层等价;transport 层有独立 it-test。两层各测各的,无覆盖洞。

### P2.5-D1 — Gemini codec 委托内部 cc codec（不调 cc.parse），renderResponse 产 CC 帧而非 Gemini 帧

- **发现于**：P2.5 设计 + subagent review（重点核验「cc 委托无 parse 的健全性」，确认 sound）
- **根因**：Gemini 是薄翻译层（codec.md §3「委托 openai-cc 处理 CC payload，自己只负责 parse/render 外壳」）。gemini codec 持 `createOpenAiCcCodec()` 实例，把 decideRoute/translateOut/prepareWire/renderResponse/renderResponseNonStreaming/sampleRequest/createResponseAccumulator **全转发给 cc**——但**不调 cc.parse**（自己的 parse 建 Gemini ctx + Gemini→CC）。
- **当前行为**：健全。被委托的 cc 方法对 `env`（+wire/upstream/frame）纯；唯一用到的 cc 闭包态是 via-responses 的 Responses→CC stream translator，它 lazily 建于 `cc.renderResponse`（非 cc.parse），故 via-responses 流式在只调 cc.renderResponse 时正常工作。cc 自己的 truncateBaseline/requestContext 闭包态不被任何委托方法读取（gemini 提供自己的 getContext/getTruncateBaseline）。
- **renderResponse 产 CC 帧的契约弯折**：`translateOpenAIStreamToGemini` 是有状态整流生成器（tool-call 配对 + usage/finishReason meta）。把它重构成逐帧 = 字节等价风险。故 codec.renderResponse/renderResponseNonStreaming **只归一到 CC**（cc 处理 via-responses 的 Responses→CC 腿），handler-v4 做最终 CC→Gemini 整流——与 legacy 同流（legacy renderGeminiStreaming 也是包 CC 流）。clientFormat=gemini 但 renderResponse 产 CC 是有意弯折，已在 codec 顶部文档化。
- **理想架构**：P3 可评估把 cc codec 的可复用核（decideRoute/prepareWire/via-responses translator/sampleRequest）抽为共享纯函数，gemini 直接组合而非持 cc 实例；但当前「持实例 + 转发」DRY 且零风险，无需提前抽取。

### P2.5-D2 — CC→Gemini stream-id/响应翻译仍在 handler，非 S5 registry（与 CC/Responses 同）

- **根因**：同 P2.4-D2——响应侧 finishing（CC→Gemini 整流翻译 + forwarded 采样 + complete）留 handler-v4 `pumpGeminiStreamingV4`，非 driver S5 registry。Gemini 无 stream-id-sync（那是 Responses 直连专属）；CC→Gemini 翻译是整流的（`translateOpenAIStreamToGemini`），本就不适配逐帧 S5 ResponseRewrite。
- **当前行为**：正确（全套件经 v4 绿）。
- **理想架构**：响应侧采样下沉跨格式统一在 P3.2b。CC→Gemini 整流翻译因其整流 + meta 性质，大概率保持 handler-side（如 Anthropic heartbeat 的 handler-side 旁路 P1.5-OQ1），不强进逐帧 registry。

### P2.5-D3 — Gemini 双重翻译 Gemini→CC（route 建 wire body + codec 重译取 droppedParams）

- **根因**：codec.parse 同步，dropped-params 警告需 ctx（parse 建）+ droppedParams（Gemini→CC 翻译产）。route 已翻译（建 wire body + system-prompt），codec.parse 又翻译一次仅为取 droppedParams——避免给 RawHttpRequest 加 Gemini 专属字段穿透。
- **当前行为**：droppedParams 是 `LOSSY_TOP_LEVEL_KEYS` 在 body 顶层键的存在性的纯函数（convert-request.ts:111），与 stream/顺序/ID 无关；`convertGeminiRequestToOpenAI` 非 mutating（subagent 核验）。两次翻译 args 一致（model + stream），droppedParams 一致。重译开销小、确定性。
- **为何暂缓**：避免 RawHttpRequest 加格式专属字段（泄漏）。重译纯 + 廉价。
- **若做需改什么**：若未来 Gemini→CC 翻译变重，可给 RawHttpRequest 加可选 `derivedDiagnostics`（route 填 droppedParams），或把警告记录移到 route 后置（route 持 codec.getContext()）。

### P2.4-D1 — 客户端 WS 复用 driver 带来两处「改进型」行为变化（fallback + tool-name restore）

- **发现于**：P2.4 WS 迁移 + subagent review
- **根因**：legacy 客户端 WS（`handleResponseCreate`）是较旧/较简路径——只支持直连 `/responses`（`isResponsesSupported` 不过即 `sendErrorAndClose`），**不做** fallback、**不做** tool-name 清洗/还原。v4 WS（`handleResponseCreateV4`）复用同一 driver，故自动获得：① Responses→CC fallback（CC-only / Google 模型经 WS 现可用）；② 请求侧 tool-name 清洗（codec.parse）+ 响应侧还原（`restoreWsStreamData`）。
- **当前行为**：默认配置下**与 legacy 完全一致**——`sanitizeToolNames` 默认 false → mapper=null → 还原是 no-op；直连路径仍走 `/responses`。差异仅在 ① CC-only/Google 经 WS（legacy 拒绝/发往坏上游，v4 fallback 可用）② `sanitizeToolNames=true` 且有非法工具名（v4 清洗+还原，legacy 透传）。两者皆**严格改进**，非回归；无现有 WS 测试覆盖这些边。
- **为何归类遗留而非「修」**：这是架构统一的正向副作用（原则7/8），不是缺陷。文档化以备 review 与未来对照。
- **若要回退到 legacy WS 语义**：在 WS v4 入口前置 `isResponsesSupported` 检查 + 对非直连决策 error+close（但不建议——会丢掉 fallback 能力）。

### P2.4-D2 — stream-id-sync + tool-name restore 仍在 handler/WS-pump 内联（非 S5 registry，与 openai-cc 同）

- **根因**：spec rewrite-registry 把 `responses-stream-id`(P1)/`responses-tool-name-restore`(P2) 列为 S5 ResponseRewrite。但 openai-cc（P2.3）已确立「响应侧 finishing 留 handler」的范式（P2-era division of labor），P2.4 沿用：codec.renderResponse 直连=identity；`fixStreamEventIds`（仅直连）+ tool-name restore + forwarded 采样在 handler-v4 `pumpStreamingV4` / ws.ts `handleResponseCreateV4` 内联。
- **当前行为**：S5 ResponseRewrite registry（`RESPONSE_REWRITES`）对 openai-responses 仍空；行为正确（全套件经 v4 绿）。
- **理想架构**：P2.6（Anthropic，响应改写最重）重建 S5 chain 时，把 stream-id-sync / tool-name restore 注册为 ResponseRewrite，handler 退化为纯采样 + 转发。
- **若做需改什么**：注册 `responses-stream-id`（appliesTo: openai-responses ∧ targetEndpoint=/responses ∧ fixResponsesStreamIds）+ `responses-tool-name-restore`（appliesTo: mapper 非空）到 registry；handler 删内联。

### P2.4-D3 — reject 在 v4 记一条 `failed` history entry（legacy 无），由中间件收尾、非悬挂（与 CC 一致，已实测裁决）

- **发现于**：P2.4 subagent review（报为 CRITICAL「悬挂 pending 泄漏」）→ **主线实测裁决为假阳性**
- **根因**：legacy `handleResponses` 在 `manager.create()` **之前** reject（handler.ts:145），故无 ctx、无 entry。v4 codec.parse 先建 ctx（→ history insert），decideRoute 才 reject；handler-v4 `!result.ok` 分支 throw HTTPError **不自 settle ctx**，依赖 `observabilityMiddleware`（server.ts:73）POST 分支 `completeFromHttpStatus(400)`→`fail()` 收尾。
- **当前行为（实测）**：带中间件的 app（=生产）下 reject entry 终态 = **`failed`**（已收尾，非悬挂）。subagent 与初次探针看到的 `pending` 是**测试 harness artifact**——`createFullTestApp` **不注册** observabilityMiddleware（只 server.ts 注册）。与 openai-cc（P2.3）**完全一致**（同 codec-creates-ctx-in-parse 模式，CC handler-v4 reject 分支逐字相同）。
- **与 spec 的偏差**：envelope-driver §3 写「reject 不建悬挂 history」，但 codec-在-parse-建-ctx 的范式（CC 确立）产生「finalized failed entry」而非「无 entry」。后者反而更符合原则7（记录原始信息，rejected 请求可诊断）。
- **为何不改**：非泄漏（中间件收尾）、与 CC 一致、更可诊断。WS 路径因中间件豁免 WebSocket（middleware.ts:82）必须自 settle（已正确：ws.ts `!result.ok` 调 `ctx.fail`），HTTP 靠中间件——二者终态皆 `failed`，不对称是有意的。

### P2.4-D4 — 响应侧采样下沉（上游原始 sseEvents + 删 handler/WS 手动 setter）→ 归 P3.2b 跨格式统一

- **根因**：与 openai-cc（P2.3-S）同——driver 请求侧双轨采样已下沉（codec.sampleRequest + driver per-attempt + transport queueWaitMs，L2 双轨等价测试齐）。响应侧上游原始 `sseEvents`（outboundResponse 轨）+ 删 handler-v4/ws.ts 手动 `setForwardedResponse({sseEvents})` setter **未下沉**——这是跨格式统一改进，锚定 P3.2b。
- **当前行为**：handler-v4 `pumpStreamingV4` + ws.ts `handleResponseCreateV4` 手动收集 `forwardedSseEvents`（客户端实收侧，inboundResponse 轨）并 `setForwardedResponse`。上游原始 sseEvents（outboundResponse）仍缺（legacy Responses 直连也仅采上游帧于 handler，非 driver 统一）——P3.2b 由 driver S4 出口对所有格式统一采样补齐。
- **若做需改什么**：P3.2b 在 driver S4 出口采上游原始帧（`request.upstream_frame`）+ S5/S7 采 forwarded（`request.forwarded_frame`），HistorySink 经 codec.createResponseAccumulator 重建双轨；删 handler/ws 手动 setter。

### P2.4-D5 — instructions 的 config-reload 在 reject 路径上比 legacy 早触发一次（CC 一致、幂等、低危）

- **根因**：`processResponsesInstructions`（→ `applyConfigToState` 真 I/O 热重载）async + 非幂等，必须在 sync codec.parse **之前**由 route 跑（与 CC `processOpenAIMessages` 同）。legacy 在 reject **之后** 跑 instructions（handler.ts:152），故被拒模型不触发 reload；v4 在 parse/decideRoute 之前跑，故被拒模型也触发一次 reload。
- **当前行为**：幂等（同 config → 同 state），无害；与 openai-cc 一致。
- **为何不改**：要在 reject 之前跳过 instructions，需在 instructions 之前做完整模型解析 + 端点检查（重复 decideRoute 逻辑）。收益（被拒请求省一次幂等 reload）不抵复杂度。

### P2.3-L1 — flag 默认 OFF + 边缘等价待补后翻 ON（→ 重排为 P2.3-H/P2.3-ON）

- **发现于**：P2.3 路由接线
- **当前行为**：`driver-flags.ts` 的 `openai-cc` flag **默认 OFF**——prod 仍走 legacy handler，v4 路径已全接线 + 主路径等价测试（7 http + 2 history）。
- **重排后落地（见顶部「P2.3 收尾排程」）**：边缘等价（auto-truncate 标记 + abort/idle/shutdown）归 **P2.3-H**（用格式无关 harness 骨架，CC 叶子 oracle）；翻 ON 归 **P2.3-ON**，硬 gate = **L1 行为等价 ∧ L2 记录等价**。
- **若做需改什么**：P2.3-S（采样）+ P2.3-H（边缘 L1）全绿 → `driver-flags.ts` 的 `"openai-cc": false` 改 `true`（一行）；P3.3 删 legacy handler + flag。**翻 ON 后现有全套 CC 测试自动经 v4 = 宽 oracle 回归。**

### P2.3-L2 — v4 缺 per-attempt 双轨 + queueWaitMs（→ 重排为 P2.3-S，原 P3.2 的 driver-采样半提前）

- **发现于**：P2.3 subagent review（HIGH-1 + LOW）；**重排确认于** architect subagent（2026-06-17）
- **根因**：legacy 经 pipeline（`setAttemptEffectiveRequest`）+ client `onPrepared`（`setAttemptWireRequest`）+ `addQueueWaitMs` 记录每 attempt 的 effective/wire request + 排队时长。driver 路径**尚未**采样（driver.ts:119/:219 是 P3.2 占位）。
- **当前行为**：经 v4 的 history entry 其 `effectiveRequest`/`outboundRequest` 双轨为空、`queueWaitMs`=0。**flag OFF 不影响线上**；client 响应 + 终态 state + forwardedResponse 已正确记录（已测）。
- **重排裁决**：原 P3.2 整体放「所有格式迁完后」过度保守——driver 加采样是**共享机件**（4 格式都缺），且只依赖 driver+ctx（不依赖其它格式在 driver 上，driver.ts 采样占位只读 env.ctx）。故**拆半**：`P3.2a`（driver 加采样）**提前为 P2.3-S** 做一次、4 格式同受益；`P3.2b`（删各 handler 手动 setter）锚定各格式迁移点不可提前（删不了仍在 legacy 的格式的 setter）。**无双写风险**：route.ts:13 进程级互斥 flag，单请求单路径，P2.3-S 同 commit 内「driver 加采样 + 删 handler-v4 手动 setter」，无新旧并写窗口。
- **若做需改什么（P2.3-S）**：driver 在 S4 每 attempt 从 `PreparedRequest`+env 派生 wireRequest、从 env.body 派生 effectiveRequest，S4/S5/S7 采样 sseEvents/forwarded，transport 暴露 queueWaitMs → ctx；删 handler-v4 手动 setter（仅 CC）。**必须补 v4↔legacy history 双轨等价测试**（当前 9 个定向测试不覆盖 history 字段，是 canary 基线正确性的前置）。

### P2.3-L3 — adaptLegacyStrategy 的 attempt 计数 off-by-one（功能惰性）

- **发现于**：P2.3 subagent review（LOW）
- **根因**：`adaptLegacyStrategy` 每次 handle 后 `attemptRef.value++`（含被 budget gate 丢弃的终态尝试、含 abort）；legacy pipeline 仅在 retry 通过 budget gate 后 `execIndex++`。预算耗尽的终态尝试上 v4 多加一次。
- **当前行为**：`context.attempt` 仅用于 auto-truncate 日志行 `Attempt N/M` + `meta.attempt`；多加只影响一个永不发生的后续 handle。CC 路径功能惰性、无可观测影响。
- **为何暂缓**：无功能/可观测影响；adapter docstring 已自称「approximating」。
- **若做需改什么**：若未来 strategy 依赖精确 attempt，改为仅在 driver 接受 retry（过 budget gate）后递增——需 driver 把"本次 retry 是否被接受"回传给 adapter。

### P2.2-D1 — prepareWire 内做 CC→Responses 全翻译（偏离 retry-transport §3「裁剪」语义；P2.3 接 driver 时复核）

- **发现于**：P2.2（codec 设计 + Plan agent 校验）
- **根因**：driver 阶段序 `translateOut`(S2) 先于 `runRewriteIn`(S3)，而 auto-truncate strategy（retry-transport §2.2 表末行）truncate `env.body.messages` **假设 CC 形态**；strategy 接口 `handle(error, env)` 只拿到 env、够不到 CC-original。若 translateOut 在 S2 翻成 Responses，truncate 崩。故 CC→Responses 翻译被迫放进 `prepareWire`（S4）。
- **当前行为**：openai-cc 的 `translateOut`=identity；`prepareWire` 在 targetEndpoint=`/responses` 时做 `translateChatCompletionsToResponses`+normalizeCallIds+`prepareResponsesRequest`。幂等性满足（§3）但「完整格式翻译」不属 §3 定义的「header+body 裁剪」。
- **理想架构（选项 Y）**：CC→Responses 作为一条 S3 RequestRewrite（`appliesTo: targetEndpoint==="/responses"`），prepareWire 退回纯 O8-O10 裁剪。但 truncate strategy「重跑 S3 改写链」要能在 CC-original 上重新翻译——**需先给 strategy 持有 CC-original 的能力**（改 strategy 接口/env）。
- **为何暂缓**：当前 strategy 接口下 prepareWire 是唯一不破坏 auto-truncate 的放置；选项 Y 要动 strategy 契约，超出 P2.2 范围。
- **若做需改什么**：P2.3 接 driver + auto-truncate strategy 落地时评估选项 Y；若仍走 prepareWire，则在 retry-transport §3 显式登记此例外。

### P2.2-D2 — via-responses 流末 `[DONE]` 合成不在 codec（P2.3 driver 流末补）

- **根因**：逐帧 `renderResponse` 的闭包 translator **永不产** `[DONE]`——现状 `translateResponsesStream` 在上游循环**之后**无条件 yield `[DONE]`（translator 之外）。per-frame 模型无「流末」信号。
- **当前行为**：codec via-responses renderResponse 只产 CC chunk，不产 `[DONE]`。passthrough 的 `[DONE]` 来自上游帧、identity 透传，不受影响。
- **P2.3 落地**：driver 流末合成 `[DONE]`，候选 = 一条 S5 terminal ResponseRewrite（`appliesTo: clientFormat==="openai-cc" && targetEndpoint==="/responses"`，`flush()` 产 `[{data:"[DONE]"}]`，复用 driver `flushChain`）。
- **若漏**：via-responses 客户端流缺尾 `[DONE]`，SDK 可能挂起等待终止——P2.3 golden 必覆盖。

### P2.2-D3 — async system-prompt 注入归宿（P2.3 前置：route 在 parse 前 await 改 raw.body）

- **根因**：`FormatCodec.parse` 签名**同步**，而 `processOpenAIMessages`（system-prompt override）是 async（`await applyConfigToState` 真 I/O 热重载）+ 非幂等。parse 物理上无法 await。
- **当前行为**：P2.2 codec.parse **不含** system-prompt；env.body 缺 system-prompt 注入。**不接线所以不爆**（旧 handler 仍在用）。
- **P2.3 前置**：route 在 `codec.parse(raw)` **之前** `await processOpenAIMessages` 改 `raw.body`（保 parse 同步纯）。否则 driver 的 runRequest 一气呵成无 async hook 可插。**P2.3 接 CC 路由时必须先解决此点**，否则上游 body 缺 system-prompt。

### P2.2-D4 — formatError 锁定签名只给 kind、丢 raw error message（P2.3 driver S7 接线时复核）

- **根因**：`FormatCodec.formatError(err: ClassifiedStreamError)` 只拿到分类后的 kind（idle-timeout/shutdown/client-abort/other），拿不到原始 error 的 `.message`。现状 CC handler 错误帧用 `rawError.message`。
- **当前行为**：codec.formatError 产 kind 派生消息（"Stream idle timeout" 等）+ kind→type（共享 `streamErrorKindToOpenAIErrorType`）。type 等价，message 退化。
- **为何暂缓**：driver S7（runResponse 错误处理）P2.1 尚未接线，formatError 当前无真实消费者。
- **若做需改什么**：P2.3 接 driver S7（持有 raw error）时跨三协议统一裁决——大概率给 formatError 传 raw error/message，或 driver 在帧成形后注入 message。

### P2.2-D5 — env.model 非可选 vs OpenAI 未知 gpt-* fallback 模型（P2.3 评估放宽）

- **根因**：`RequestEnvelope.model: ResolvedModel`（非可选，Anthropic 中心假设），但 CC 支持索引外的未知 gpt-* fallback（`modelIndex.get` 返回 undefined）。
- **当前行为**：parse 把（可能 undefined 的）selectedModel cast 为 ResolvedModel 存 env.model；所有消费者（decideRoute/prepareWire）传给接受 `Model | undefined` 的 helper（`isEndpointSupported` 等），运行时正确，仅静态类型 over-claim。
- **若做需改什么**：P2.3 可评估把 envelope.model 放宽为 `ResolvedModel | undefined`（待 Anthropic 非可选假设一并复核）。

### P2.2-D6 — decideRoute 是纯函数，`recordFeature("via-responses")` 须由 P2.3 driver/route 在 translate 决策时补发

- **发现于**：P2.2（subagent review HIGH-1a，主线复核确认归属）
- **根因**：现状 handler 在走 via-responses 分支时 `recordFeature("via-responses")`（handler.ts:299）。codec 的 `decideRoute` 按 spec 是**纯函数**（返回 RouteDecision，不碰 ctx；observability 归 driver/P3.2），故不发该特性标记。
- **当前行为**：codec 不发 `via-responses` 标记（codec 未接线，无影响）。
- **P2.3 落地**：driver/route 在 `decision.kind==="translate"`（→/responses）时补 `recordFeature("via-responses")`，否则 history/TUI 的 via-responses 标记对每个 Responses-bridged 请求静默消失（可观测性回归）。**P2.3 接 CC 路由的 golden/e2e 必须断言此标记存在。**

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
