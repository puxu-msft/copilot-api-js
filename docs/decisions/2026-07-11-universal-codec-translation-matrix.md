# ADR：通用入站×出站翻译矩阵（CC hub + 全 codec 互通）

日期：2026-07-11
状态：Accepted（用户 2026-07-11 明确决定「全矩阵 4×3」）
关联：ADR [2026-07-11-route-decision-separated-from-format-codec.md](2026-07-11-route-decision-separated-from-format-codec.md)（前置：codec 纯化）、[spec/anthropic-via-openai-translation.md](../spec/anthropic-via-openai-translation.md)、[RFC](../rfc/2026-07-11-anthropic-via-openai-translation.md)、[DESIGN.md](../DESIGN.md)「活的架构现状」。

## 背景

设计 anthropic-via-openai-translation（让 Claude Code 用 gpt-5.5）时，用户提出泛化：这不该是 anthropic 的特例，而应是**通用的入站格式 × 出站协议腿翻译矩阵**。

一手事实（`.claude/skills/ghc-api-reference/references/AVAILABLE_MODELS.json`，40 模型）：
- **入站格式（ClientFormat）4 种**：anthropic / openai-cc / openai-responses / gemini。
- **出站协议腿（UpstreamEndpoint）3 种**：`/v1/messages`(anthropic, 8 模型) / `/chat/completions`(cc, 13) / `/responses`(含 ws 变体, 9)。**无独立 Gemini 出站腿**（Gemini 只作客户端入站，Google vendor 模型经 cc/responses 暴露）。

现状 4×3 矩阵（已核实）：

| 入站 ↓ \ 出站 → | /v1/messages | /chat/completions | /responses |
|---|:---:|:---:|:---:|
| anthropic | ✓ identity | ❌ | ❌ |
| openai-cc | ❌ | ✓ passthrough | ✓ via-responses |
| openai-responses | ❌ | ✓ via-cc | ✓ passthrough |
| openai-gemini | ❌ | ✓（委托 cc）| ✓（委托 cc）|

现状 **openai-cc 是翻译 hub**（DESIGN.md）：responses/gemini 都经 CC 中转，OpenAI 家族 6 格已互通。**唯一孤岛是 anthropic 行**——只有 identity，进不了 hub、别人也到不了 `/v1/messages`。

## 决策

**建成通用 4×3 翻译矩阵——所有入站格式可路由到任意出站腿（受模型 `supported_endpoints` 约束），全部经 CC hub 互通。**

核心机制：
1. **CC hub（保留现状中枢）**：所有跨格式翻译经 openai-cc 的 CC 表示中转，不建 N² 个点对点翻译器。
2. **anthropic 接入 hub**：建**一对 Anthropic↔CC 双向翻译器**（`anthropic-to-cc` 请求 + `cc-to-anthropic` 响应）。这一对同时使能对称两向：
   - Anthropic→CC(请求) + CC→Anthropic(响应) → **anthropic 入站可达 cc/responses 出站**（格 2/3，即 Claude Code 用 gpt-5.5 的最初需求）。
   - CC→Anthropic(请求) + Anthropic→CC(响应) → **cc/responses/gemini 入站可达 /v1/messages 出站**（格 4/7/10，反向）。
3. **入站定客户端交互 / 出站定上游 wire（缝合模型）**：
   - **入站 codec（clientFormat）** 决定 parse + 出站 render + **handler 心跳/机制**（给客户端的响应格式 = 入站格式，故 anthropic 入站恒用 Anthropic 心跳、cc 入站用 CC 机制…，无论上游哪条腿）。
   - **出站腿（targetEndpoint）** 决定 prepareWire + 上游 accumulate。
   - 中间经 CC hub 翻译。这是 hub-and-spoke 的对称结构。
4. **router 全矩阵决策**（承前置 ADR）：唯一读 `supported_endpoints`/vendor，为任意 `{clientFormat, model, routeOverride}` 选出站腿或 reject。

补全后新增的格子：anthropic→cc/responses（2/3）、cc/responses/gemini→messages（4/7/10）——全部靠这一对 Anthropic↔CC 翻译器，增量小。

## 理由

- **模块化 + 泛用**（用户「一定要做好代码模块化，我们有多种模型格式需要支持」）：hub-and-spoke 让「加一个格式」= 加一对 ↔CC 翻译器，自动与所有其他格式互通，非 N² 爆炸。
- **对称一致**：入站定交互、出站定 wire、CC 中转——四个格式同构，无 anthropic 特例 hack。
- **against-yagni**：用户明确要泛化，推翻 spec §10「反向 YAGNI」。全矩阵是真实有效的迭代路线（任意客户端 SDK 用任意 GHC 模型），不因「暂时只需 anthropic→gpt-5.5」缩范围。
- **长远正确 > 短期**：符合项目定位（把 GHC 模型暴露为多端点兼容）+ architecture-health-first。

## 影响

- **正向**：任意入站客户端 × 任意 GHC 模型；hub 复用；anthropic 不再是孤岛。
- **成本**：范围从「anthropic 行」扩到「全矩阵」，但核心增量集中在一对 Anthropic↔CC 翻译器 + anthropic codec 接入 hub + router 全矩阵决策；其余格子复用现状 hub。仍走 large-refactor（RFC + commit invariants + golden）。
- **文档**：RFC 范围从 anthropic-via-openai 扩为通用矩阵；spec §10 删「反向 YAGNI」；DESIGN.md 活的架构现状加矩阵表。

## 推翻的既定决策（record-not-adopted）
- **spec §10 YAGNI「反向（OpenAI/Gemini 入站→Anthropic 腿）」** —— 推翻。用户 2026-07-11 决定全矩阵，反向（格 4/7/10）纳入范围。
- RFC v2「只做 anthropic 行」的范围 —— 扩为全矩阵（v3）。

## 未采纳备选
- **只补 anthropic 行**（anthropic→cc/responses，不开反向）——被否。用户选全矩阵；且反向靠同一对翻译器逆用，增量极小，缩范围反而留孤岛（cc/responses/gemini 客户端仍不能用 Claude `/v1/messages` 腿）。
- **N² 点对点翻译器**（每对格式一个）——被否。CC hub 已是中枢，N² 是反模式。
