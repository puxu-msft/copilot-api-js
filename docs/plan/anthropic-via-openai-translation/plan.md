# Master Plan：通用翻译矩阵实施计划

设计源（WHY+契约）：[RFC v5](../../rfc/2026-07-11-anthropic-via-openai-translation.md)｜ADR [decideRoute 拆分](../../decisions/2026-07-11-route-decision-separated-from-format-codec.md) + [全矩阵](../../decisions/2026-07-11-universal-codec-translation-matrix.md)
本文（HOW+锚点）：每 phase 的 TDD task 步骤 + factory/锚点表 + commit invariant。per-phase kickoff 见 [prompts/](prompts/)。
状态：待 subagent review → 逐 phase 实现。

## 全局 commit invariant（每 commit 终态）
1. `bun run typecheck` 绿 + `bun test` 全套件通过。
2. **现状 4×3 矩阵已有 6 格行为逐字不变**（golden 锁）——直到该格被有意扩展。
3. 中间态绝不半坏（过渡态显式无害：dead code / silent flag）。
4. 细粒度 pathspec 提交（`git commit -F msg -- 精确路径`），conventional commits，无模型署名。

## Phase 依赖 DAG
```
Phase 0 (codec 纯化) ──前置阻塞全部──┐
                                      ▼
Phase 1 (路由骨架+二维门控) ─→ Phase 2 (hub+请求翻译) ─→ Phase 3 (非流式响应)
                                      │
                                      ▼
                              Phase 4 (流式两向+handler缝合) [byte-critical 串行]
                                      │
                                      ▼
Phase 5 (反向格子接线) [格式独立可并行,除 gemini→messages] ─→ Phase 6 (doc-sync)
```
Phase 0-4 严格串行（byte-critical）；Phase 5 各反向格子（cc/responses→messages 可并行，gemini→messages 依赖 hub 两段 translator 组合）；Phase 6 收尾。

---

## Phase 0：FormatCodec 纯化（decideRoute → router 自由函数）

**目标**：`decideRoute` 从 5 codec 拆到 `src/lib/pipeline/router.ts` 自由函数，`FormatCodec` 接口去 `decideRoute`。**行为逐字节等价**（纯重构）。

**Golden 预捕获（改动前，large-refactor §4）**：
- T0.0 写 `tests/pipeline/router-golden.it.test.ts`：对 4 端点 × 全场景（每 vendor 的 passthrough/translate/reject + Google force-fallback + @后缀）断言 `RouteDecision`。**在改动前的 HEAD 上跑通**（锁定现状）。

**Task（每个一 commit）**：
- T0.1 建 `router.ts`：`decideRoute(RouteInput): RouteDecision` + 搬 **anthropic** 的 `supportsDirectAnthropicApi` 逻辑；driver 单调用点（[driver.ts:144](../../../src/lib/pipeline/driver.ts#L144)，`deps.codec.decideRoute` 影响全格式）改 `router.decideRoute`，**router 按 clientFormat 分派：anthropic 走新逻辑、cc/responses/gemini 走过渡桥委托回各 codec 仍 live 的 decideRoute**（守全套件绿，桥随 T0.2-0.4 逐格移除）。anthropic codec decideRoute 留 dead。全 4 格 golden 过。
- T0.2 搬 **openai-cc** 的 `decideOpenAiCcRoute`（[openai-cc/codec.ts:354](../../../src/lib/codec/openai-cc/codec.ts#L354)）→ router，移 cc 过渡桥。golden 全过。
- T0.3 搬 **openai-responses** 的 `decideOpenAiResponsesRoute`（[openai-responses/codec.ts:381](../../../src/lib/codec/openai-responses/codec.ts#L381)，**含 Google force-fallback**）→ router，移 responses 桥。golden 全过。
- T0.4 搬 **gemini**（委托 cc 的 decideRoute）→ router，移 gemini 桥。golden 全过。
- T0.5 `FormatCodec` 接口删 `decideRoute`（[types.ts:626](../../../src/lib/pipeline/types.ts#L626)）+ 删 5 codec 实现 + driver `inspectRequest`([:202](../../../src/lib/pipeline/driver.ts#L202)) 同步 + dry-run-pipeline 消费点。此时桥已全移除。typecheck 绿 = 无残留调用。
- **factory 锚点**：`supportsDirectAnthropicApi`([features.ts:38](../../../src/lib/anthropic/features.ts#L38))、`decideOpenAiCcRoute`、`decideOpenAiResponsesRoute`、`shouldForceChatCompletionsFallback`([fallback.ts](../../../src/routes/responses/fallback.ts))、`isEndpointSupported`/`isResponsesSupported`([endpoint.ts](../../../src/lib/models/endpoint.ts))。
- **invariant**：**5 decideRoute 对 codec 闭包纯**（已核实，只读 env.model）→ 可无损搬无状态 router。

**Phase 0 实施记录（2026-07-11，landed）**：
- 两处对书面 plan 的自觉偏离（`sync-plan-with-impl`，均无害且更忠实）：① **router 签名保留 `decideRoute(env: RequestEnvelope)` 而非窄类型 `RouteInput`**——原 `codec.decideRoute(env)` 就吃 env，保 env 输入使 golden 逐字节等价 + DI seam 与旧接口对称；`RouteInput`/`routeOverride` 解耦推迟到 **Phase 1**（加 openai-anthropic 翻译真正需要 routeOverride 时引入，env 签名带全上下文、更有能力，不阻塞）。② **新增 DI 测试 seam `DriverDeps.decideRoute?`**——自由函数 router 绕过 mock，编排单测经此注入固定决策；生产 8 处 createPipelineDriver 均不设、走真 router（路由正确性由 golden 独占覆盖 + http reject 测试覆盖生产接缝）。
- 交付：7 commit（T0.0 golden→T0.5 删接口+doc），typecheck 0 / golden 52 pass / pipeline 558 pass，decideRoute 零残留，code review 无 BLOCK。

---

## Phase 1：路由骨架 + 二维门控切换

**目标**：resolveModelTarget 后缀 + routeOverride 通路 + router 全矩阵决策树 + 改写/策略 appliesTo 轴切换。**现状默认腿零回归**。

**Task**：
- T1.1 `resolveModelTarget(model):{name,routeOverride}`（[resolver.ts](../../../src/lib/models/resolver.ts)）：入口剥顶层后缀（W-c 客户端直发）+ `resolveOverrideTarget`([:218](../../../src/lib/models/resolver.ts#L218)) 递归内每环剥（FAIL-1）；后缀枚举 3 值 `{cc,responses,messages}`。`resolveModelName=resolveModelTarget(_).name` 薄封装。单测：modifier+@cc、override 链、客户端直发、@messages、`@xxx` 不识别。
- T1.2 `RequestEnvelope`/`RawHttpRequest.preResolved` 加 `routeOverride?`（W-b 通路）；各 route 调 `resolveModelTarget` 经 preResolved 线程化。
- T1.3 router 全矩阵决策树（[RFC §4.3](../../rfc/2026-07-11-anthropic-via-openai-translation.md)）：候选 targetEndpoint 解析 + **force-fallback 移 targetEndpoint 解析后统一拦截**（FAIL-Google-2）+ 每入站 W-priority 序 + FAIL-3 严格 gate + W4 legacy 放行。单测全矩阵决策树。
- T1.4 **改写/策略 registry 全格式装配**（FAIL-P）：driver S3/S5 从 `{targetEndpoint→改写册}` 全格式表 assemble（取代 per-route 单格式注入 `BUILTIN_*=[]`）。6 Anthropic 改写 appliesTo `clientFormat==="anthropic"`→`targetEndpoint==="/v1/messages"`（[request-rewrite-adapter.ts:60](../../../src/lib/codec/anthropic/request-rewrite-adapter.ts#L60)、[response-rewrite-adapters.ts:96](../../../src/lib/codec/anthropic/response-rewrite-adapters.ts#L96) ANTHROPIC）；CC 改写册 appliesTo 扩 `targetEndpoint∈{cc,responses}`。单测：二维门控每腿 fire 正确册。
- T1.4b **策略 stack 按 targetEndpoint 供料**（WARN-1/W-strategies-builder）：driver 按 targetEndpoint 装配 strategies——Anthropic strategy 的 `resanitize`/`betaProbe` 供料由**共享 registry 提供格式专属 builder，不依赖 route 自有 codec**（反向 cc/responses→messages 走非-messages route 时也能拿到 Anthropic strategy 料）。单测：反向腿上游 Anthropic sanitize 有料。
- T1.5 web_search 前置步先 router.decideRoute（[handler-v4.ts:225](../../../src/routes/messages/handler-v4.ts#L225)）+ reject 经 ctx（FAIL-2/W-d）。
- T1.6 **可观测性落库**（WARN-2/W6/W-reject-obs）：history 记录 `model{}` 的 **routeOverride + 实际出站腿** + **翻译腿 format 标签**（镜像 openai-gemini `ENDPOINT_TYPE`，区分翻译 vs direct）+ reject 经 ctx 有记录 + **sampleRequest 按 targetEndpoint**（翻译腿采 CC wire，N-sampleRequest）。符合 richest-data-flow（后端完整存）。
- **invariant**：现状各格式默认腿 passthrough 零变（golden T0.0 仍全过，含 Google force）；anthropic-direct 二维门控翻转等价（Phase 1 期间翻译腿未出现，`clientFormat==="anthropic" ⟺ targetEndpoint==="/v1/messages"` 恒真，逐字节等价）。

**Phase 1 实施记录（2026-07-12，landed，分支 `feat/translation-matrix-phase1`）**：
- 交付 8 commit（T1.1 `ef85e446` → T1.2 `55135823` → T1.3 `6da7b837` → T1.4 `1e4e7e74` → T1.4b `e8990cb7` → T1.5 `46019395` → T1.6 `101528b9` → lint `72719840`）。每 commit `bun run typecheck` 0 error + Phase 0 golden 52 pass（逐 commit 实测过）+ 全套件绿（仅预存在 UI shell 404 例外）。
- 对书面 plan 的自觉偏离 / 补充（`sync-plan-with-impl`）：
  1. **T1.4 补 `quarantine-proactive-filter` 的轴切换**：plan/RFC 列举「6 个 Anthropic 改写」（1 请求 sanitize + 5 响应）成文早于 `thinking-quarantine-proactive`（order 250）落地。该 filter 同样处理上游 Anthropic `/v1/messages` 请求 wire，按 §3.1 同理应门控 `targetEndpoint===MESSAGES`。已一并切换（Phase 1 co-true 逐字节等价），否则 Phase 5 反向腿会漏 strip、正向 anthropic→cc 腿会误 strip。测试 env 同步补 `targetEndpoint`。
  2. **T1.3 显式腿 gate 用「语义正确的 per-leg 支持检查」而非 RFC §4.3 字面 `isEndpointSupported(model,leg)`**：`/v1/messages`→`supportsDirectAnthropicApi`（真 direct-Anthropic gate，非裸端点列表）、`/responses`→`isResponsesSupported`（含 ws 传输）、`/chat/completions`→`isEndpointSupported`。force-fallback→CC 豁免 CC 支持检查（对齐 `decideOpenAiResponsesRoute` 的 `forceFallback || isEndpointSupported`，Google 元数据不可靠）。
  3. **T1.3 force-fallback 统一拦截「只在显式后缀路径」**：no-suffix 路径直接 reduce 回 Phase 0 的 per-inbound 函数（golden 逐字节）。把 §4.3 的「universal force-fallback 拦截」用于 no-suffix cc/gemini 腿会翻掉 golden 的 `google-resp` cc/gemini 格（`/responses`→CC），故留作 Phase 2+ 的有意行为变更（已注释标注）。
  4. **T1.4b 只注册 `/v1/messages` builder**：CC/Responses 的 builder 供料（尤其翻译后 CC body 的 truncate 基线）要等 hub 产出（Phase 2+），现注册即臆测；已在 registry 里对未落地腿 throw 明确报错、不静默。
     - **已知 Phase-1 fail-fast（对抗审查 A1，非回归）**：anthropic 入站 + `@cc`/`@responses`，且解析模型（经 `model_overrides` 映射到 CC/Responses-capable 模型）通过 strict gate → router 返 `translate` → driver strategies 工厂命中 registry default 分支 throw → **500**（而非干净 400）。仅经新 `@` 后缀可达、无既有请求命中（纯 Anthropic 模型在 strict gate 先被干净 400 拒），故零回归成立；且 anthropic→cc 正向翻译本就 Phase 2 才落地（Phase 1 `translateOut` 恒 identity，即便不 throw 上游也会拒）。本项目为内部开发工具（clear-error 500 可接受），故不加 Phase-1-only 的 throwaway 400 逻辑，接受 fail-fast，Phase 2 接正向翻译后自然消解。
     - **反向对称已修（WARN-1，code-review 后补 commit `b6d53b24`）**：cc/responses/gemini 入站 + `@messages` → Anthropic-capable 模型时，router 同样返 `translate`，但反向腿走各 route 自有 strategies（不经 registry）、且 `prepareOpenAiCcWire`/`prepareOpenAiResponsesWire` 原 else 兜底会**静默降级**成默认腿 wire + `setRouteInfo` 记 `translated:true` 说谎。修法：两个 prepareWire 对未接线 targetEndpoint **对称 throw**（与正向 registry-throw 500 一致），never-swallow。至此正反向所有未接线 translate 腿都响亮失败，Phase 5 接反向翻译后消解。
  5. **T1.6 `sampleRequest 按 targetEndpoint` 属 Phase 2+**：Phase 1 无翻译腿，各 codec 的 sampleRequest 采 direct wire 即正确；已落地的是 `model{}` 的 `routeOverride`/`outboundEndpoint`/`translated` 三字段（存 blob，无 allowlist 需改）。
- 新增测试：`tests/pipeline/route-explicit-leg.it.test.ts`（全矩阵显式腿）、`tests/pipeline/two-axis-gating.it.test.ts`（targetEndpoint 轴门控每腿 fire 正确册 + 反向/正向腿形状）、`tests/pipeline/strategy-registry.unit.test.ts`、`tests/models/model-resolver.it.test.ts`（+11 resolveModelTarget 双层剥离）、`tests/context/request-context.unit.test.ts`（+2 观测投影）、`tests/anthropic/web-search/web-search.http.test.ts`（+1 reject-via-ctx）。
- 预存在遗留（非本 phase 引入）：① `bun test` 的 UI shell 404（kickoff 已豁免）；② `typecheck:ui-v4` 的 `EntrySummary.responsePreviewText` 错（并发会话遗留，stash 本 phase 改动后仍复现，与本 phase 无关）；③ `request.ts:696`（现 698）`no-unnecessary-condition` lint（base 已存在于 `failed()` 方法，非本 phase 代码）。

---

## Phase 2：hub 共享翻译层 + Anthropic↔CC 请求翻译

**目标**：抽 hub 共享层 + 一对请求翻译器，anthropic codec 翻译腿委托 hub。

**Task**：
- T2.1 建 `src/lib/pipeline/hub-translate.ts`：`(sourceFormat, targetEndpoint, env)→wire + 反向 render` 委托层。内部持 CC↔Anthropic + CC↔Responses primitive。
- T2.2 `anthropic-to-cc-request.ts`（正向，[openai/translate/](../../../src/lib/openai/translate/)）：Anthropic Messages→CC（继承 spec §6 映射表 + 多 choices 感知）。单测各 block 类型。
- T2.3 `cc-to-anthropic-request.ts`（反向）：CC→Anthropic Messages，**含 WARN-E 硬约束清单**（thinking 绝不合成红线、tool_use.id 格式、cache_control 不注入、server tools 剥离）。单测 + 反向硬约束逐项。
- T2.4 anthropic codec `translateOut`/`prepareWire` 按 targetEndpoint 委托 hub（翻译腿产 CC wire）；truncate 基线取 translateOut 后 CC body（W-truncate-baseline）。
- **factory 锚点**：`responses-to-cc-request.ts`（对称参照）、gemini `convert-request.ts`、openai-cc codec `prepareWire`。

**Phase 2 实施记录（2026-07-12，landed，分支 `feat/translation-matrix-phase2`）**：
- 交付 4 commit：T2.2 正向翻译器（`feat(translate): Anthropic Messages → CC ...`）→ T2.3 反向翻译器 + WARN-E 红线（`feat(translate): CC → Anthropic Messages ...`）→ T2.1 hub（`feat(pipeline): hub shared request-translation layer`）→ T2.4 codec 委托（`feat(codec): anthropic codec ... delegate the forward leg to the hub`）。每 commit `bun run typecheck` 0 error + Phase 0 golden 52 逐字节 pass + 相关套件全绿。
- **对书面 plan 的自觉偏离 / 说明**（`sync-plan-with-impl`）：
  1. **实现顺序 T2.2→T2.3→T2.1→T2.4（非编号顺序）**：hub（T2.1）依赖两个纯翻译器，故先落地翻译器再落 hub，每步 commit 终态自洽。
  2. **hub `translateRequestVia` 只做请求侧；响应侧 `renderResponseVia` 是 Phase 3/4 骨架、直接 throw**——这是 Phase 2 最微妙的 commit invariant 的落地：翻译腿端到端仍 fail-fast（响应未翻译前绝不返回坏 CC）。codec 的 `renderResponse`/`renderResponseNonStreaming` 对翻译腿对称 throw。
  3. **hub 只翻到 CC-canonical、不含 CC→Responses wire 步**：沿用 openai-cc P2.2-D1，`/responses` 正向腿的 CC→Responses wire 翻译留在 codec 的 `prepareWire`（env.body 保持 CC 形，供 CC 请求改写 + auto-truncate）。
  4. **codec 持内部 openai-cc delegate**（镜像 gemini codec）：正向翻译腿的 `prepareWire`/`preSend`/`sampleRequest` 委托 cc delegate；`translateOut` 委托 hub 产 CC body。`isForwardTranslateLeg` 守卫把 `/v1/messages` 与 **undefined**（隔离单测 env）都当 direct/identity 路径，只有显式 CC/Responses 腿走翻译分支——现状 codec 单测（targetEndpoint 未设）逐条零回归。
  5. **W-truncate-baseline 由 cc delegate 天然承载**：翻译腿的 truncate 基线 = cc delegate 对 CC body 的自有 baseline（无需 anthropic codec 额外接线）。
  6. **端到端 runRequest 正向腿仍在 Phase-1 strategy registry fail-fast**（无 CC strategy builder，A1 已记录）——发生在 prepareWire 之前。故 Phase 2 的 wire 验证走 **dry-run inspector（`driver.inspectRequest`，不建 strategies、不发上游）**，实测正向腿产正确 CC wire（`stopAfter=prepare-wire` → `/chat/completions`、system 折叠成 system message、tools 映射、thinking/Anthropic 字段不泄漏）；运行期正向腿在 Phase 3+ 接响应翻译 + CC strategy builder 后完整打通。
- 新增测试：`tests/openai/anthropic-to-cc-request.unit.test.ts`（24，spec §6 全表 + 多 choices 折叠）、`tests/openai/cc-to-anthropic-request.unit.test.ts`（14，含 WARN-E 红线：输出零 thinking 块 + 无 cache_control）、`tests/pipeline/hub-translate.unit.test.ts`（9，分派矩阵 + fail-fast 骨架）、`tests/anthropic/anthropic-codec-forward-leg.it.test.ts`（5，dry-run wire 验证 + 响应侧 fail-fast）。
- 现状零回归：Phase 0 golden 52 逐 commit 全过；现状 anthropic codec 单测 / it 测全过（direct 路径 identity 不变）。

---

## Phase 3：非流式响应两向

**Task**：
- T3.1 `cc-to-anthropic`（非流式）：CC choices→Anthropic content[]（tool_calls→tool_use、finish_reason→stop_reason、usage、toolu_ 透传、多 choices 折叠）。
- T3.2 `anthropic-to-cc`（非流式，反向）：Anthropic content[]→CC choices（thinking 丢弃、tool_use→tool_calls、stop_reason→finish_reason）。
- T3.3 anthropic codec `renderResponseNonStreaming` 按 targetEndpoint；OQ4 错误透传非流式两路。
- **T3.4（Phase 2 review 揪出的 latent gap，承接 RFC §4.1）** anthropic codec `createResponseAccumulator` 须按出站腿分派：翻译腿上游是 CC 形，须委托 `ccDelegate().createResponseAccumulator()`（现状恒返 Anthropic accumulator，若喂 CC 帧会产畸形/空 `outboundResponse`，违 richest-data-flow「后端存储必须完整」）。**但当前 `FormatCodec.createResponseAccumulator()` 无 `env` 参**（Phase 0/1 接口态），而 RFC §4.1 明确签名是 `createResponseAccumulator(env)`——故 Phase 3 须先恢复 `env` 参（改接口 + 5 codec + 调用方），再按 `targetEndpoint` 分派。Phase 2 不受影响（翻译腿在 renderResponse 之前 fail-fast，accumulator 不可达），故推迟至此、不在请求侧 Phase 2 扩接口。
- 单测 + @responses 四跳往返 oracle。

**Phase 3 实施记录（2026-07-12，landed，分支 `feat/translation-matrix-phase3`）**：
- 交付 3 commit：T3.1 CC→Anthropic 非流式翻译器（`feat(translate): CC → Anthropic Messages non-streaming response`）→ T3.2 Anthropic→CC 非流式翻译器（`feat(translate): Anthropic Messages → CC non-streaming response`）→ T3.3 codec 委托 hub + OQ4 + 端到端往返（`feat(codec): anthropic renderResponseNonStreaming delegates to the hub`）。每 commit `bun run typecheck` 0 error + Phase 0 golden 52 逐字节 pass + 相关套件全绿。
- **对书面 plan 的自觉偏离 / 说明**（`sync-plan-with-impl`）：
  1. **T3.4 判定为 Phase 4，本 phase 不改 `createResponseAccumulator` 接口**（kickoff 明确要求先判断再动）：经全仓核实，`FormatCodec.createResponseAccumulator()` 在生产端**零调用**——driver/HistorySink 均不调用它，gemini codec 仅内部委托 cc 的（`openai-gemini/codec.ts:200`），而 anthropic 的流式 handler（streaming-pump / web-search-*）**直接** `createAnthropicStreamAccumulator()` 不经 codec 方法。**非流式路径**（`renderNonStreamingV4`）根本不消费 accumulator——它直接读 `response.usage`/`stop_reason`/`content` 喂 `ctx.complete/fail`。故 accumulator 是纯**流式/history** 关切，Phase 3 非流式不可达。**结论**：恢复 `createResponseAccumulator(env)` 签名 + 按 targetEndpoint 分派委托 cc accumulator 属 **Phase 4**（流式 handler 缝合时随 CC 帧累积一并接线），Phase 3 不擅自扩接口。RFC §4.1 的 `(env)` 签名仍待 Phase 4 恢复。
  2. **CC→Anthropic 响应用本地输出类型 + 边界 cast 而非严格 SDK `Message`**：SDK 响应类型过严（`ToolUseBlock.caller`/`TextBlock.citations`/`container`/`stop_details`/`Usage` 多 null 字段全 required），沿用 `web-search/synthesize.ts` 先例（`as unknown as AnthropicMessageResponse`）。翻译器返回本地 `TranslatedAnthropicResponse`（用项目 `TextBlockParam`/`ToolUseBlockParam` 拼 content[]，wire-optional 字段的严格 SDK 类型不入侵），codec 边界 cast。CC→Anthropic 请求侧的 `ChatCompletionResponse`（Anthropic→CC 方向）是项目自有宽松类型，直接强类型返回无需 cast。
  3. **N3 content_filter 可辨识标记 = ctx feature 而非污染 wire**：Anthropic 无 content_filter stop_reason，wire 降级为 `end_turn`；纯翻译器返回 `contentFiltered` 布尔（保持 translator ctx-free），codec 的 `renderResponseNonStreaming` 据此 `env.ctx.recordFeature("translated-content-filter")`（新增 FeatureKind + TUI tag，richest-data-flow 观测）。客户端拿到合法 end_turn 响应，运维侧仍可辨识降级发生。
  4. **OQ4 非流式错误透传由既有 route 错误边界天然承载，无需新代码**：上游 CC 腿 4xx/5xx → transport 抛 `HTTPError`（携 CC error body）→ 在 `renderResponseNonStreaming` **之前**沿 runExchange/runRequest 传播（翻译腿的错误永不到达响应翻译）→ messages route 的 `forwardError(c, error)`（默认 format=anthropic）经 `mapHttpErrorToEnvelope` 整形成 Anthropic error envelope。`mapHttpErrorToEnvelope` 对上游原始 body 格式无关（提取 message），故 CC error → Anthropic error 天然成立。已加端到端测试实证（429 CC error → `rate_limit_error` Anthropic 型）。
  5. **端到端往返走真 codec+driver+router、mock transport**（no-auto-server / 省配额）：`strategies:[]` 注入绕过 Phase-1 A1 的 CC strategy builder fail-fast（那是 handler `deps.strategies` 工厂的关切，Phase 4 handler 缝合时接；Phase 3 聚焦翻译往返，路由正确性由 golden + route-explicit-leg 独占覆盖）。@cc 单跳 + @responses 四跳（Anthropic→CC→Responses 请求 / Responses→CC→Anthropic 响应）均实测形状正确 + N1 多 choices 折回（text+tool_use 都在）。
- **流式仍 fail-fast 确认**：`renderResponse`（逐帧）对翻译腿仍 throw（消息改为 STREAMING/Phase 4 措辞）；hub 的 `renderResponseVia` 收窄为流式骨架仍 throw。非流式解锁**未误开**流式路径（IT 测试同时守 streaming-throws + non-streaming-translates）。
- 新增测试：`tests/openai/cc-to-anthropic.unit.test.ts`（19，正向各字段 + N1 多 choices 折回 + arguments repair 降级 + finish_reason 映射 + N3）、`tests/openai/anthropic-to-cc.unit.test.ts`（18，反向各 block + thinking/server-tool 丢弃 + stop_reason + usage）、`tests/pipeline/hub-translate.unit.test.ts`（+3 非流式两向 dispatch）、`tests/anthropic/anthropic-codec-forward-leg.it.test.ts`（改写 T2.4 fail-fast 节为 T3.3：非流式翻译 + 流式 throw + 双向 identity）、`tests/anthropic/anthropic-nonstream-roundtrip.it.test.ts`（4，@cc 往返 + @responses 四跳 oracle + OQ4 错误透传）。
- 现状零回归：Phase 0 golden 52 逐 commit 全过；`bun test`（1984 across 169 files）全绿（仅预存在 UI shell 404 例外）。

---

## Phase 4：流式两向 translator + handler 缝合（最难 byte-critical）

**Task**：
- T4.1 `cc-to-anthropic-stream.ts`（正向）：`renderFrame/flush/getMeta` 自供（WARN-C）；W1 block-index 分配器 + W2 thinking-first + W3 message_start usage 占位 + 多 choices 折叠 + N1 event-line 全合成点。**golden 预捕获 + 独立 Anthropic SDK oracle**。
- T4.2 anthropic 入站 handler 缝合（[RFC §7.2](../../rfc/2026-07-11-anthropic-via-openai-translation.md)）：翻译分支入站 CC acc（onRenderedFrame）+ 出站 Anthropic 心跳（`makeAnchoredSseSink` 复用）+ prelude/translator/reconcile 三方 message_start（NIT-H：reconcile 现状机制已适配 render 后帧，无需改识别）+ 截断读 getStreamMeta().finishReason（F2）。
- T4.3 cc 腿单跳 vs responses 腿二跳区分（WARN-F）；responses 腿 getStreamMeta 信号链（Responses翻译→CC帧→累积）。
- T4.4 **流式 reasoning 实测**（OQ1 剩余，golden 预捕获时探针）。
- **invariant**：anthropic-direct 流式 golden 逐字节不变（心跳/anchor/reconcile 复用不回归）。

**Phase 4 实施记录（2026-07-12，landed，分支 `feat/translation-matrix-phase4`）**：
- 交付 6 commit：T4.0 direct-流式 byte golden 预捕获（`test(anthropic): T4.0 ...`）→ T4.1 CC→Anthropic 流式 translator + SDK oracle（`feat(translate): CC → Anthropic Messages streaming ...`）→ T4.2/T4.3 codec + handler 缝合（`feat(codec,pipeline): stream-translate the forward leg + handler seam`）→ doc-sync → lint → **subagent 审查发现的 CRITICAL 修复**（`fix(anthropic): route translate-leg flush frames through live-reconcile`，见下「审查结论」）。每 commit `bun run typecheck` 0 error + direct-流式 golden 逐字节 + Phase 0 router golden 52 全过。
- **T4.0 golden 预捕获**（`tests/anthropic/direct-stream-golden-phase4.http.test.ts`）：改动前 HEAD 锁 direct `/v1/messages` 流式的 thinking→text→tool_use→terminal 混合流逐字节输出（identity 转发）+ N1 event-line 扫描。改动后逐字节不变（零回归硬证）。
- **T4.1 translator**（`src/lib/openai/translate/cc-to-anthropic-stream.ts`）：`renderFrame/flush/getMeta` 自供（WARN-C）。W1 = **单一单调计数器**跨 text+tool 块（CC `tool_calls[].index` 首现时分配 Anthropic index，前导 text 占 0 → 首 tool 落 1）；W2 = reasoning delta **识别并丢弃**（累积 reasoning_tokens 进 usage，绝不合成无 signature thinking——反向红线）；W3 = message_start `input_tokens:0` 占位 + flush 的 message_delta 补正净 usage（复用 `netInputTokens`，B1 不双计 cached）；多 choices 折叠（走每 choice 非仅 choices[0]）；N1 全合成点经 `anthropicSseFrame`。
  - **独立 Anthropic SDK oracle**（`tests/openai/cc-to-anthropic-stream.unit.test.ts`）：合成帧喂真 `@anthropic-ai/sdk` 的 `Stream.fromSSEResponse`（真 SSEDecoder，静默丢 event-less 帧）重建 Message 验证幸存；**含正样本对照**（剥掉 event 行的帧被 SDK 丢弃 → 重建 text 为空，证 oracle 非 no-op）。
- **T4.2/T4.3 缝合**：
  - hub `createForwardStreamTranslator(targetEndpoint, modelId)` 统一分派——cc 腿单跳（CC→Anthropic）、responses 腿二跳（Responses→CC→Anthropic 在 hub 内组合，WARN-F 信号链 Responses翻译→CC帧→累积）；替换 Phase-4 `renderResponseVia` throw 骨架，反向腿仍 throw（Phase 5）。
  - codec：`renderResponse`（流式）翻译腿驱动 per-request forward translator（原 fail-fast throw）；加 `flushResponse`（终止 message_delta+message_stop）+ `getStreamMeta`；**`createResponseAccumulator(env)` 签名恢复**（RFC §4.1 / T3.4）+ 按腿分派（direct→Anthropic、cc→CC、responses→Responses 累加器，outboundResponse 存「上游腿形」）；其余 4 codec + FormatCodec 接口同步加 `env`（对它们 leg-independent）。
  - handler：`pumpAnthropicStreamingDispatch` 按 targetEndpoint 分派——**direct 腿 byte-critical pump 完全不动**；翻译腿走新 `pumpTranslateLegStreamingV4`，**复用同一 anchored keepalive sink + live reconcile**（心跳复用不镜像 gemini 无心跳——客户端仍是 Claude Code 300s 断连），累积原始上游进 per-leg outbound 累加器，drain flushResponse，按 getStreamMeta 结算（F2 截断 = 干净 drain 无 stop_reason → 合成 Anthropic error 帧 + fail）。
- **对书面 plan 的自觉偏离 / 说明**（`sync-plan-with-impl`）：
  1. **T4.2 用独立翻译腿 pump 而非在 `pumpAnthropicStreamingV4` 内分支**：direct pump 是 byte-critical，翻译腿的上游帧类型（CC/Responses）+ 累加器 + 终止符时序均不同；独立 pump 保 direct 路径逐字节零改动（golden 硬证），翻译腿复用共享原语（sink/reconcile/closeAnchorIfOpen/keepalive）不重写。
  2. **T4.2 `onUpstreamFrame` 累积原始上游而非 `onRenderedFrame`**：plan 提「入站 CC acc（onRenderedFrame）」，但 driver 的 `onRenderedFrame` 是 forwarded 侧转换钩子；上游原始累积（outboundResponse honest）该用 `onUpstreamFrame`（render 前 raw 帧，RFC §4.A1），与 direct pump 对称。已用 onUpstreamFrame。
  3. **T4.4 OQ1 流式 reasoning 未活服务器实测**：no-auto-server + 运行中 4141 仅 anthropic-messages 流量（零翻译腿/CC/Responses 流式条目），无法只读观测原始流式 reasoning 帧。translator 的 best-effort 丢弃已实现且正确（不依赖帧形态实测），活服务器验证留用户。记 `docs/todo/deferred-backlog.md`。
  4. **翻译腿流式 L2 缓冲重试暂缓**：终止符时序不同（flush 后合成 message_stop）需专门 gate 接线，LIVE 路径已完整解锁正向流式，buffered 是正交 opt-in（默认 OFF）。记 `docs/todo/deferred-backlog.md`。
- **反向流式仍 fail-fast**：`createForwardStreamTranslator` 对 `/v1/messages` 腿 throw（Phase 5）；hub `translateRequestVia` 反向请求侧仍在（Phase 2 落地），反向响应流式未接。
- 新增测试：`direct-stream-golden-phase4.http.test.ts`（T4.0 byte golden）、`cc-to-anthropic-stream.unit.test.ts`（11，W1/W2/W3/多choices/SDK oracle + 正样本对照）、`anthropic-stream-roundtrip.it.test.ts`（2，cc/responses 腿端到端 + 真 SDK 解码 oracle）、`hub-translate.unit.test.ts`（+3 forward stream dispatch）、`anthropic-codec.unit.test.ts`/`anthropic-codec-forward-leg.it.test.ts`/`openai-cc-codec.unit.test.ts`（per-leg accumulator + 流式 translate 更新）。
- 现状零回归：direct-流式 golden + Phase 0 golden 52 逐 commit 全过；`bun test` 全绿（仅预存在 UI shell 404 例外）。
- **审查结论（两位 subagent 独立 + 对抗，共识 APPROVE）**：两位审查者**独立收敛到同一条 CRITICAL**——翻译腿 `pumpTranslateLegStreamingV4` 的 `flushResponse` 收尾帧原先写裸 sink、绕过 live-reconcile 的 +1 block-index remap。默认 `empty_text` anchor 下（预响应停顿注入合成块@0、真实块 remap +1），translator 只在 flush 才关最后一个块（finish_reason 帧不关块），该 `content_block_stop` 落未 remap 的原 index → 真实块开在 wire index 1 但 stop 落 index 0 → 悬挂块 + anchor 块@0 被关两次，破坏 Anthropic「每 start 有同 index stop / 同时只开一块」不变量，@anthropic-ai/sdk `MessageStream` 崩。**触发条件正是 Phase 4 主场景**（默认 empty_text + 首内容前长 thinking 停顿 + 翻译腿），且此路径此前**零测试覆盖**（translator 单测不经 pump+reconcile+flush 缝合）。修复（commit `b1a0868a`）=把 flush 帧（干净完成 + 截断两分支）也过同一 `liveReconcilingSink`（message_delta/message_stop 无 index 透传、无 anchor 时透传字节等价）+ 加回归 `tests/anthropic/translate-leg-flush-reconcile.unit.test.ts`（真 translator + `makeReconcilingSink`，empty_text 场景断言 start@1/stop@1 平衡 + 无 anchor 透传；正样本对照已验证测试能抓该 bug）。其余审查项（W1/W2/W3/多choices/per-leg accumulator/心跳缝合/direct 零回归/F2 截断/错误处理/SDK oracle）两位均核实通过，0 其他 BLOCK/HIGH/MEDIUM。
- **主会话补第三轮独立 review（byte-critical 高风险 + Phase 3 曾漏 BLOCK 教训）**：与前两位独立收敛 APPROVE、无新 BLOCK/HIGH。更细地确认 CRITICAL 修复的**必要性比 commit message 更广**——不止修 block-close remap，还修零内容干净完成时 `message_delta`/`message_stop` 触发 `isMessageTerminator` close-off 的 anchor 平衡（走 clientSink 才平衡）。剩 2 MEDIUM + 1 NIT，均非阻塞、记待办：
  - **M1（记待办，非本 phase 修）**：`createResponseAccumulator(env)` per-leg 分派在 v4 热路径**零生产消费者**（仅 gemini 委托 cc；handler `pumpTranslateLegStreamingV4` 内联重复同一「leg→accumulator-kind」分派）。规则写两处、新增翻译腿两处都要改，漂移风险。handler 需具体累加器类型选 `buildOpenAIResponseData` vs `buildResponsesResponseData`，非「删一处」简单事。待收敛：抽共享 `leg→accumulator-kind` primitive（对齐 `fix-all-comparison-sites` 单一事实源）。
  - **M2（记待办，需完整 pump harness）**：CRITICAL 回归测试用**结构断言**证 index 平衡，未把 anchor+reconcile+flush 后的 wire 喂真 SDK 解码器（roundtrip 测过真 SDK 但不带 anchor；flush-reconcile 测带 anchor 但不过 SDK，两者正交）。补一条「注入 empty_text anchor + reconcile + 真 translator + flush → 过真 SDK」的集成断言（defense-in-depth，非正确性缺口——结构平衡已是 SDK 需要的性质）。**主会话尝试在隔离单测内加过真 SDK 断言失败**：隔离测试手动构造 `anchorState.injected=true` 但 frames 不含真 anchor `content_block_start@0`（"already forwarded" 只在注释），给 SDK 的是残缺 wire、decode 行为异常。正确补法需**完整 pump 集成 harness**（真 anchor prelude 帧在流内），Phase 5/收尾时用 `anthropic-stream-roundtrip.it.test.ts` 的完整 harness + 注入 anchor 补。
  - **N1（非阻塞）**：翻译腿 settled-abort 分支取 `getStreamMeta().usage`（Anthropic 净值）而非 `outboundResponseData()`（原始上游形），与其余三终止分支取数不一致；token 计数等价（同批上游帧）、原始帧已落 ctx，非 bug。

---

## Phase 5：反向格子接线（cc/responses/gemini → messages 出站）

> **实施状态（2026-07-12，已 landed master FF `b00d52e2`）**：**T5.0–T5.4 全部 landed**（7 commit + 1 review-fix commit）。
> - **T5.0**：W3 反向守卫（`cc-to-anthropic-request.ts`：缺 `tool_call_id` 的 tool_result 跳过、空 content user turn 跳过）+ W4 `@responses` 前向端到端 IT（Responses-shaped wire）。
> - **T5.1**：`anthropic-to-cc-stream.ts`（逐帧穷举表全类型 + 逆折叠单 choice + 净 usage gross-up 复用 `mapUsage`/`mapStopReason`（已从 `anthropic-to-cc.ts` export）+ 独立 CC 累加器 oracle + 正样本对照）。flush=[]（finish/usage inline on message_delta）。
> - **T5.2**：hub `createReverseStreamTranslator`（按 clientFormat 分派）+ cc codec MESSAGES 腿五方法 + `reverse-anthropic-rewrite.ts`（专属 Anthropic sanitize + 共享 mapper holder，**非** ctx.toolNameMapper 的 CC mapper）+ cc handler 专属反向 pump（无心跳、`onUpstreamFrame`→Anthropic 累加器记 honest outbound、getStreamMeta F2 截断）+ 反向非流式 render 记 honest Anthropic outbound。
> - **T5.3**：responses codec MESSAGES 腿（**二跳 + reverse-exchange** `{responseId,itemId,clientModel}`，`createCCToResponsesStreamTranslator`/`translateCCToResponsesResponse` 吃 `TranslateExchangeContext`）+ 反向 pump **必调 flushResponse**（response.completed 终帧）。
> - **T5.4**：gemini codec 经 cc delegate 继承 Anthropic→CC + geminiTranslator wrap CC→Gemini（`reverseBetaProbe` 透传 delegate）+ 反向 pump（`onUpstreamFrame` 补 Anthropic 累加器、截断读 `anthropicAcc.sawMessageStop`、必调 flushResponse）。
> - **前置门控**：W2（inbound tool_use.id 接受性）✅ CLEARED（2026-07-12 探针，PROBE-FINDINGS Probe 3）；W3/W4 ✅ 本 phase T5.0。
> - **测试**：`anthropic-to-cc-stream.unit.test.ts`（11）+ hub 反向分派（hub-translate.unit.test.ts）+ 三格反向端到端 IT（`reverse-cc-messages` / `reverse-responses-messages` / `reverse-gemini-messages`，各含独立消费者 oracle）。
> - **交付后独立 code review（主会话补，非自派）抓 HIGH-1 + MEDIUM-1，已修（`b00d52e2`）**：三反向 pump 缺 `anthropicAcc.streamError` 门（H2 终端上游 Anthropic error 帧被误判为截断 → 吞真实 code/message + 客户端双 error 终止帧，never-swallow 违规；直连 Anthropic pump [messages/handler-v4.ts:1292] 有此门反向没有）。修=抽共享 `src/lib/pipeline/reverse-terminal.ts` 的 `classifyReverseAnthropicTerminal`（upstream-error → truncated → complete 优先序，`fix-all-comparison-sites` 单一事实源防三 pump 漂移）+ `reverse-terminal.unit.test.ts` 正样本对照（error 帧 `sawMessageStop=false` 须分类 upstream-error 非 truncated）。**MEDIUM-1**：截断信号统一为 `!sawMessageStop`（对齐直连 pump；cc/responses 原用 `finishReason===undefined` 会漏「message_delta 后 message_stop 前被切」的截断）。测试盲区教训：现有反向 IT 只覆盖正常 message_delta+message_stop 流、无终端 error 帧用例，otherwise-green 掩盖 error 分支缺陷。
> - **kickoff 对抗审查（交付前）抓 4 BLOCK + 2 MEDIUM 全采纳**（记录于 `prompts/phase-5.md`「Kickoff 对抗审查记录」节）：反向 pump 非平凡复用 / responses 二跳 `TranslateExchangeContext` / 反向 sanitize 专属 Anthropic mapper / resanitize 内联同源 / 帧表 swallow / usage helper export。
> - **承重红线**：反向请求侧零 thinking 合成（沿用 T2 red-line 测试）；byte-critical 独立 oracle（CC 累加器 / Responses 累加器 / Gemini 帧消费）。

**Task**：
- T5.1 `anthropic-to-cc-stream.ts`（反向流式，FAIL-A'）：**逐帧穷举表**——锚定真实帧集 [stream-accumulator.ts:156-186](../../../src/lib/anthropic/stream-accumulator.ts#L156)（顶层 8 类含 ping swallow/error 映射）+ [:248-278](../../../src/lib/anthropic/stream-accumulator.ts#L248)（block 5 类含 **server_tool_use 剥离**、redacted_thinking 丢弃）+ [:311-334](../../../src/lib/anthropic/stream-accumulator.ts#L311)（delta 4 类）。**content_block_stop→CC finish 状态转换**（主干）。逐帧 golden。
- T5.2 cc→messages 接线：cc handler render 经 hub Anthropic→CC + 心跳保持 CC 现状机制（无心跳）+ §7.3 上游保护归属。
- T5.3 responses→messages 接线：hub 二跳（Anthropic→CC→Responses render，串联点在 hub 内部，WARN-F）。
- T5.4 gemini→messages 接线（W-gemini-hub-composition）：hub 内串两段有状态 translator（Anthropic→CC + 现有 CC→Gemini geminiTranslator 闭包）。**依赖 hub 组合契约，非纯并行**。
- 单测 + 反向 tool-name oracle（W-mapper-format）+ gemini→messages 最长链 oracle。

**Phase 5 前置门控（Phase-2 code-review 记录，反向腿接线前必处理）**：
- **W2 OQ3 inbound 接受性须探针**：`cc-to-anthropic-request.ts` 反向 tool_use.id verbatim 透传，但探针只测了 outbound（GHC 返回 toolu_/call_），**未测 GHC Anthropic 腿是否接受 `call_*` 入站 request tool id**。Phase 5 接线上游前须补探针实测（别继承 Phase 2 注释当已验证事实，`verifying-authoritative-claims`）。
- **W3 反向 empty/占位守卫**：`toolMessageToResultBlock` 在 `tool_call_id` 缺失时产 `tool_use_id:""`（空串失配 assistant 的 tool_use）；`translateUserMessage` 空 content 数组产 `content:[]`（正向 `translateAssistantBlocks` 已用 undefined 守卫、反向未对称）。Phase 5 接线前加守卫（空串/空 content 撞 GHC 400 风险）。
- **W4 @responses 正向腿端到端 IT + ws 目标对称**：Phase 2 IT 只覆盖 `@cc` 腿到 CC wire，`@responses` 腿产 Responses-shaped wire（input[] 非 messages[]）无端到端 IT；`isForwardTranslateLeg` 接受 `ws:/responses` 但 prepareWire 不备料（对 anthropic 入站不可达但潜在不对称）。Phase 3/4 前补 anthropic@responses IT。

---

## Phase 6：doc-sync
DESIGN.md 活的架构现状加矩阵表 + router 层 + 二维门控 + hub 共享层 + 配置语法（@cc/@responses/@messages）；count_tokens 后缀剥离；spec §10 删反向 YAGNI 标注；**NIT-E 文档点明「thinking signature 硬约束在翻译矩阵天然规避」**（消实现者疑虑）。**OQ2**（reasoning_effort 档位映射）若 Phase 2 未做则记 `docs/todo/`。

---

## 测试锚点汇总
- Golden 预捕获点：T0.0（router）、T4.1（正向流式）、Phase 5（反向逐帧）。
- 独立 oracle：Anthropic SDK（流式 event-line）、@responses 四跳、gemini→messages 最长链、反向 tool-name。
- 隔离：DI/fetch-mock、useIsolatedRuntime（需 runtime 的测试）。
