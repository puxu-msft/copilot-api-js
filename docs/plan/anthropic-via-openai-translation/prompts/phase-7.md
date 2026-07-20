# Phase 7 Kickoff：修复前向翻译腿生产 500 + 无后缀自动路由

> self-contained kickoff。假设你零项目上下文。先读【必读】再动手。这是**通用翻译矩阵特性的真实 bug 修复**（Phase 0-6 已 landed，但前向腿从没真正能用）。

## 背景与为什么（实测证据）

copilot-api-js 有通用「入站×出站」翻译矩阵，让任意客户端用任意 GHC 模型。特性的**招牌用例**：Claude Code（Anthropic 客户端）想用 OpenAI 模型（如 `gpt-5.6-sol`）。**但前向翻译腿（anthropic→cc/responses）在生产全部 500**——实测（经运行中 4141）：
- `gpt-5.6-sol`（无后缀）→ `Model "gpt-5.6-sol" does not support /v1/messages: vendor is "OpenAI", not Anthropic`（router reject）。
- `gpt-4.1@cc` / `gpt-4o@cc` / `gpt-5@cc`（cc-capable）→ **`[strategy-registry] no strategy builder registered for the /chat/completions leg yet`**（driver strategies 工厂 throw 500）。
- `gpt-5.6-sol@responses` → 同样 `no strategy builder registered for the /responses leg yet`。

**根因**：`src/lib/codec/strategy-registry.ts` 的 `assembleStrategiesForEndpoint` **只注册了 MESSAGES builder**；CC/Responses builder 从没注册。plan 每个 phase 都把它推给下一个（「Phase 2 自然消解」→「Phase 3+ 接 CC strategy builder」→「Phase 4 handler 缝合时接」），**最后没人做**；而所有测试用 `strategies:[]` 注入或 `driver.inspectRequest` dry-run 绕过了真 handler，于是测试全绿、生产 500。反向腿（Phase 5）不受影响——走已注册的 MESSAGES builder。

**次要缺口**：无后缀 anthropic 遇非-Anthropic 模型直接 reject，不自动路由。RFC §4.3 指定了 anthropic 无后缀优先级但从没实现（`decideAnthropicRoute` 仍是 Phase 0 冻结的 reject-only）。

## 用户决策（本次范围，已定）

1. **完整修前向腿**：注册 CC/Responses strategy builder + messages handler 前向腿供料 → `@cc`/`@responses` 前向腿真能跑上游。
2. **无后缀自动路由**：`decideAnthropicRoute` 实现优先级 **`messages > responses > cc`**（⚠️ 用户显式定的顺序，**responses 优先于 cc**——契合 gpt-5.x Responses-first 现实；**注意这偏离 RFC §4.3 原文的 `messages > cc > responses`**，用户已裁决 responses 优先，实施记录须标注此偏离）。→ `gpt-5.6-sol`（无后缀）自动走 responses 腿翻译。
3. **golden 更新**：`tests/pipeline/router-golden.it.test.ts` 的 anthropic 列按新行为重算（这是「有意行为变更」，golden 从「冻结旧 reject」改为「捕获新正确行为」）。

## 必读
- `src/lib/pipeline/router.ts`（`decideRoute`/`decideRouteFromInput`/`decideExplicitLeg`/`decideAnthropicRoute`/`isLegSupported`/`explicitRejectReason`——你改 `decideAnthropicRoute` + 复用 `isLegSupported`）。
- `src/lib/codec/strategy-registry.ts`（`assembleStrategiesForEndpoint` + `StrategySupply`——你加 CC 供料槽 + CHAT_COMPLETIONS/RESPONSES/WS_RESPONSES case）。
- `src/lib/codec/openai-cc/strategies.ts`（`buildOpenAiCcStrategies(deps)`，deps=`{originalPayload:ChatCompletionsPayload, model, maxRetries, label}`）。
- `src/routes/messages/handler-v4.ts`（约 line 371-390 的 `strategies:` 工厂——你加前向 translate leg 分支供 `{cc:...}`）。
- `src/lib/models/endpoint.ts`（`isEndpointSupported` legacy-true 默认 / `isResponsesSupported` legacy-**false** / ws counts）。
- `src/routes/responses/fallback.ts`（`shouldForceChatCompletionsFallback`：Google vendor→true）。
- `docs/rfc/2026-07-11-anthropic-via-openai-translation.md` §4.3（W-priority；注意用户改了 anthropic 的 cc/responses 顺序）。
- skill `large-refactor`（golden 语义：behavior-change 时 golden 捕获新行为）、`empirical-verification`、`verifying-authoritative-claims`。

## Task（每个一 commit，每 commit typecheck 绿 + 相关测试过）

### T7.1 strategy-registry 注册 CC/Responses builder（先修根因）
- `StrategySupply` 加 `cc?: OpenAiCcStrategiesDeps`（import `buildOpenAiCcStrategies` + 其 deps 类型）。
- `assembleStrategiesForEndpoint` 加 case：`CHAT_COMPLETIONS` / `RESPONSES` / `WS_RESPONSES` → `if (!supply.cc) throw ...; return buildOpenAiCcStrategies(supply.cc)`。保留 MESSAGES case + default throw（未来腿）。
- 更新 module docstring（删「CC/Responses builders land later」的过时话，改为已注册）。
- 单测 `strategy-registry.unit.test.ts`：CHAT_COMPLETIONS/RESPONSES/WS_RESPONSES + cc 供料 → 返回非空 strategy 数组；缺 cc 供料 → throw。

### T7.2 messages handler 前向腿供料
- `strategies:` 工厂（line ~371）：`env.targetEndpoint === MESSAGES` 走现有 `{anthropic:...}`；否则（前向 translate leg CC/Responses）走 `assembleStrategiesForEndpoint(env.targetEndpoint, { cc: { originalPayload: env.body as ChatCompletionsPayload, model: env.model as Model|undefined, maxRetries: state.autoTruncateMaxRetries, label: env.targetEndpoint===RESPONSES ? "Anthropic(→Responses)" : "Anthropic(→CC)" } })`。
  - **为何 `env.body as CC`**：strategies 工厂在 driver `translateOut` 之后被调用（driver 先 translateOut 把 anthropic body 翻成 CC，再 `deps.strategies(rewritten)`），故此刻 `env.body` 已是翻译后的 CC 形——即 CC auto-truncate 的 baseline。核实 driver 调用顺序确认（`src/lib/pipeline/driver.ts` translateOut→strategies）。
- **IT（承重，证生产路径不再 throw）**：新 `tests/anthropic/forward-leg-strategies.it.test.ts`——真 anthropic codec + 真 driver + **真 strategies 工厂**（不注入 strategies:[]）+ mock transport，@cc 与 @responses 腿各跑 `driver.runRequest` 到上游、断言 **不 throw strategy-registry error** + 上游收到 CC/Responses wire。这是 Phase 3/4 用 strategies:[] 绕过、从没覆盖的生产接缝（`empirical-verification`：别再用注入绕过真工厂）。

### T7.3 router 无后缀自动路由 `messages > responses > cc`
改 `decideAnthropicRoute`（现 line 216，reject-only）为：
```
1. supportsDirectAnthropicApi(modelName).supported? → PT(MESSAGES)
2. 前向 translate 候选腿（优先级 responses > cc）：
   - isResponsesSupported(model)? → leg = RESPONSES
   - elif isEndpointSupported(model, CHAT_COMPLETIONS)? → leg = CHAT_COMPLETIONS
   - else → RJ(新 reason)
3. Google force-fallback：leg===RESPONSES && shouldForceChatCompletionsFallback(model) → leg = CHAT_COMPLETIONS
4. return TR(leg)  （非-Anthropic 模型的 leg 永不 == MESSAGES 默认，故恒 translate）
```
- 签名需要 `model`（现只收 `modelName`）——改 `decideAnthropicRoute(input: RouteInput)`，调用点 line 85 传 `input`。
- 复用 `isLegSupported`（已有）或直接 `isResponsesSupported`/`isEndpointSupported`（保持与 golden 语义一致）。
- 新 reject reason（无腿可达）：`Model "${modelName}" cannot be served on /v1/messages (${supportsDirectAnthropicApi(modelName).reason}) and supports no translatable /responses or /chat/completions leg`。
- **@cc/@responses 显式路径不变**（`decideExplicitLeg` 已对；本 task 只改无后缀）。

### T7.4 golden 更新（anthropic 列重算）
`tests/pipeline/router-golden.it.test.ts` 的 MATRIX，**只改 anthropic 列**（cc/responses/gemini 列零变——它们的无后缀逻辑没动）。按 T7.3 优先级逐行重算。**下方是主会话预算的期望值，你须实现后让 golden 通过、并对每行独立复核**：

| row (vendor, endpoints) | 旧 anthropic | 新 anthropic | 推理 |
|---|---|---|---|
| anthropic-msg (Anthropic,[MSG]) | PT(MSG) | **PT(MSG)** 不变 | direct 支持 |
| anthropic-no-msg (Anthropic,[CC]) | RJ | **TR(CC)** | direct 否→resp 否→cc 是 |
| cc-only (OpenAI,[CC]) | RJ | **TR(CC)** | resp 否→cc 是 |
| resp-only (OpenAI,[RESP]) | RJ | **TR(RESPONSES)** | resp 是 |
| ws-only (OpenAI,[WS_RESP]) | RJ | **TR(RESPONSES)** | resp 是(ws counts) |
| cc-and-resp (OpenAI,[CC,RESP]) | RJ | **TR(RESPONSES)** | **resp>cc 优先→resp** |
| msg-only-openai (OpenAI,[MSG]) | RJ | **RJ(新 reason)** | direct 否(vendor)→resp 否→cc 否 |
| legacy-none (OpenAI,undefined) | RJ | **TR(CC)** | resp 否(legacy)→cc 是(legacy-true) |
| google-resp (Google,[RESP]) | RJ | **TR(CC)** | resp 是→force-fallback→cc |
| google-none (Google,undefined) | RJ | **TR(CC)** | resp 否(legacy)→cc 是(legacy-true) |
| google-cc (Google,[CC]) | RJ | **TR(CC)** | resp 否→cc 是 |
| (index-miss/unknown 行如有) | — | 按同逻辑算 | — |
- **注**：`isResponsesSupported` 对 legacy(无 endpoints) 返 **false**（与 isEndpointSupported 的 legacy-true 不同，见 endpoint.ts:63 注释）——legacy 行落 cc。核实此前提。
- golden 注释更新：说明 anthropic 列已从「Phase 0 冻结 reject」改为「无后缀自动路由 messages>responses>cc（用户裁决，偏离 RFC 原 cc>responses）」。
- route-explicit-leg / two-axis-gating 等其它路由测试：核对无回归（显式后缀逻辑没动）。

## 验收 gate
- 每 commit：`bun run typecheck` 0 + `bun test` 全套件通过（预存在 UI shell 404 + /api/negotiation 例外可忽略）。
- **T7.2 IT 证真 strategies 工厂不 throw**（生产接缝，非注入绕过）。
- golden anthropic 列全绿 + cc/responses/gemini 列零变。
- 显式 @cc/@responses 路由测试零回归。

## 提交指引
`git commit -F <msgfile> -- <精确路径>`，conventional commits（fix/feat/test），无模型署名。每 task 一 commit。

## 红线
- **byte-critical 路由**：golden 是唯一硬证；anthropic 列改动须逐行推理正确、cc/responses/gemini 列零变。
- **别再用 strategies:[] 注入/dry-run 绕过真工厂**——T7.2 IT 必须驱动真 strategies 工厂（这正是 bug 溜过的原因）。
- **no-auto-server**；**绝不 kill 4141 主服务器**（用户实时使用）；活服务器实测由主会话合并后做。
- 用户裁决的 `messages > responses > cc` 顺序偏离 RFC §4.3 原文——实施记录明确标注，别自作主张改回。

## 若撞硬阻塞（停下报告）
① `env.body` 在 strategies 工厂调用时不是 CC 形（driver 顺序与假设不符）② golden 某行重算与预算表不符（附实际 decideRoute 输出 + 你的推理）③ isResponsesSupported/isEndpointSupported legacy 默认与假设不符 ④ 前向腿供料牵连比预期广——**停下报告**，别硬编/别放宽 golden。
