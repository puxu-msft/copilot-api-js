# ADR：路由决策与格式翻译分离（纯 FormatCodec + 独立 router 层）

日期：2026-07-11
状态：Accepted（用户 2026-07-11 明确决定「彻底全局拆 decideRoute」）
关联：[anthropic-via-openai-translation spec](../spec/anthropic-via-openai-translation.md)（触发本决策的特性）、[DESIGN.md](../DESIGN.md)「活的架构现状」、`src/lib/pipeline/types.ts` FormatCodec 接口、`src/lib/pipeline/driver.ts` S2。

## 背景

在设计 `anthropic-via-openai-translation`（让 Anthropic `/v1/messages` 端点经翻译访问 OpenAI 协议腿）时，用户提出一条架构立场：**codec 应是一个单纯干净的 format codec，不应知道 upstream 的情况、不应做路由/reject 检查**。

现状与此有出入。`FormatCodec` 接口（[types.ts:619](../../src/lib/pipeline/types.ts#L619)）含：

```ts
decideRoute(env: RequestEnvelope): RouteDecision  // passthrough / translate / reject
```

`decideRoute` **必须知道 upstream**——它读 model 的 `supported_endpoints`/`vendor`（经 `supportsDirectAnthropicApi`/`isEndpointSupported`/`isResponsesSupported`）才能决定走哪条协议腿或 reject 400。因此现状 codec 混了两个职责：

1. **格式翻译**（parse / translateOut / renderResponse / formatError）——纯客户端格式 ↔ 内核格式的双向转换。
2. **路由决策**（decideRoute）——读 upstream 模型能力，决定 passthrough/translate/reject。

driver 在 S2 两处调 `deps.codec.decideRoute(parsed)`（[driver.ts:144,202](../../src/lib/pipeline/driver.ts#L144)）。

值得注意：**翻译逻辑本身已经是与 codec 解耦的独立纯模块**了（`gemini/convert-{request,response,stream}.ts`、`openai/translate/*.ts`），codec 只是委托它们。脏的只是 `decideRoute` 这块路由决策——它内联在每个 codec 工厂里（`openai-gemini/codec.ts:157` 委托 `cc.decideRoute`、`openai-cc/codec.ts:354` 的 `decideOpenAiCcRoute` 读 endpoint 能力等）。

## 决策

**把 `decideRoute`（路由 / reject 决策）从 `FormatCodec` 拆到一个独立的 router 层**，使 codec 成为纯格式翻译器（format-in/format-out，不读 upstream 模型能力）。

- `FormatCodec` 接口**去掉 `decideRoute`**，变纯：parse / translateOut / prepareWire / renderResponse / renderResponseNonStreaming / formatError / createResponseAccumulator / sampleRequest（+ 可选 preSend）。
- 新增独立 **router**：输入 `{ clientFormat, resolvedModelName, routeOverride, modelIndex }`，输出 `RouteDecision`（passthrough/translate/reject）。它是**唯一**读 `supported_endpoints`/vendor 做路由/reject 的地方。
- driver 的 S2 改为：先调 router 决策 → 据决策选 codec + 目标 endpoint → codec 只做翻译。
- 全局作用于现有 5 个 codec 路径（anthropic / openai-cc / openai-responses / openai-gemini / 新 openai-anthropic）。

## 理由

- **模块化（多格式支持）**：项目要支持多种模型格式（OpenAI CC / Responses / Anthropic / Gemini / Azure）。纯 codec 让「加一个客户端格式」= 加一个纯翻译器，不必在 codec 里重复路由逻辑。→ user 输入「一定要做好代码模块化，我们有多种模型格式需要支持」。
- **codec 独立可测是优点**：纯 format codec 可用固定输入/输出做单测，不需 mock upstream 模型能力。→ user 输入「codec 独立可测不是坏处」。
- **职责单一 + 单一真相源**：路由/reject 决策集中在 router 一处（消除现状「4 scattered checks」+ 各 codec 内联的 decideRoute），符合 architecture-health-first。这也**自动消解** spec 原 FAIL-3——`gpt-5.5@cc` 的严格 reject 天然归 router 层，不再需要 codec 检查 upstream 腿。
- **长远正确 > 回归风险**：这是横切重构、动全部 codec + driver，工程量大；但按项目 `long-term-wins` + `architecture-health-first`，架构健康 > 短期回归风险，且本项目无向后兼容负担、可强制迁移。

## 影响

- **正向**：codec 纯化、router 单一真相源、新格式易加、消解 FAIL-3。
- **成本**：横切重构（5 codec + driver + 相关测试）；须走 large-refactor 流程（RFC-first + commit invariants + golden 预捕获证行为等价）。
- **顺序**：这是 `anthropic-via-openai-translation` 特性的**前置架构重构**——先拆 decideRoute 让 codec 纯化，再在纯 codec 基础上加 openai-anthropic 翻译器。RFC 须把「decideRoute 拆分」作为 Phase 0（或独立前置 RFC），后续翻译特性建其上。

## 未采纳的备选

- **局部：只让新 openai-anthropic codec 纯，现有 5 codec 不动**（仍带 decideRoute）——被否。理由：新旧 codec 风格不一致、遗留技术债，违背单一真相源；用户明确选「彻底全局拆」。
- **拆分作为完全独立的 RFC、与翻译特性解耦**——被否（作为独立项）。用户选「彻底」，但拆分仍应作为翻译特性 RFC 的 Phase 0 前置，二者在同一 RFC 内分阶段，而非另起时间线。
