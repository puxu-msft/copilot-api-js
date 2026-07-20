# Spec: thinking block 空/非空专项 metrics

**Status:** 待实现（2026-07-05）。
**Author:** grounded in 读码 + `recording.unit.test.ts` golden 实测确认地基不变量 + brainstorming 对齐。
**Driver:** 用户要求增加专项 metrics，统计 response 中 `role:"assistant"` 的 thinking block 内容为空（`thinking:""`）与非空的分布——用于观测上游 thinking 块质量（尤其区分「正常加密空块」与「损坏双空块」）。

---

## 1. 背景与动机

Anthropic thinking block 的 `thinking` 明文字段可能为空，且空的成因**本质不同**：

- **合法加密块**：`thinking:""` 但 `signature` 非空。Anthropic thinking 加密自包含，明文可为空而签名承载加密内容；部分 Copilot 上游还会把整个 signature 直接塞进 `content_block_start`（见 `stream-accumulator.ts` 的 seeding 注释、`thinkingSignatureCompat` 配置）。这是**正常/兼容态**。
- **损坏双空块**：`thinking:""` 且 `signature` 也空/缺失。这是上游损坏信号，正是 `thinkingBlockSanitizeCheck` 的 `empty_thinking` 模式要剥离的那种，回传上游会被拒。

现有 telemetry 只统计 token/duration 等 usage 维度，无 thinking 块质量的可观测性。本 spec 增加逐块三桶计数，接入既有可扩展 telemetry registry 框架（见 [operational-stats-and-lineage-removal.md](operational-stats-and-lineage-removal.md)）。

**关联缺陷（本 spec 一并修复，见 §4.0）**：subagent 审查发现，损坏 thinking 块恰在「上游先吐 thinking 块、随后 H2 error 帧 / H3 stream-error 中止」的失败流中高发，而这两条流式失败分支（`handler-v4.ts` 的 `env.ctx.fail`）**未传 partial content**（`fail()` 落 `content: null`），使 `acc` 已累积的 thinking 块被丢弃。这是既有的 richest-data-flow 缺陷（截断/refusal 分支已用 `buildAnthropicResponseData(acc)` 传 partial、H2/H3 是遗漏），不修则本 metrics 会对核心观测目标——损坏双空块分布——产生系统性、偏向高价值样本的漏计。故本 spec 先修根因，让损坏块能到达 `outboundResponse.content` 再被统计。

## 2. 三桶定义

对每个 settled request，遍历其 `outboundResponse.content` 里的 block，**先按 `block.type === "thinking"` 过滤**（与 `extractToolNames` 先判 `type` 同构）——`redacted_thinking`（有 `data` 无 `thinking`）、`server_tool_use`、`text` 等在此步排除；**绝不靠 `thinking` 字段有无来反推类型**（否则 `redacted_thinking` 会误落 emptyUnsigned）。对通过过滤的 thinking block，按下述规则三分并计数：

| 桶 | measure 名 | 判定 |
|---|---|---|
| 非空 | `thinkingBlocksNonEmpty` | `thinking` 为 string 且 `trim()` 后非空 |
| 空·有签名 | `thinkingBlocksEmptySigned` | `thinking` 空（非 string 或 trim 后为空）+ `signature` 为 string 且非空 |
| 空·无签名 | `thinkingBlocksEmptyUnsigned` | `thinking` 空 + `signature` 空/缺失（损坏双空块） |

判定顺序：先判 `thinking` 非空（nonEmpty）；否则按 `signature` 有无二分（emptySigned / emptyUnsigned）。**signature 三态归属**：`""`（空 string）、`undefined`（seed 时上游没给，见 `stream-accumulator.ts` 的 `typeof block.signature === "string" ? … : undefined`）、缺 key、`null`（上游显式 null，`typeof null === "object"`）——全部归 emptyUnsigned（判据是「不是非空 string」）。

## 3. 架构：单一数据源 + 三投影端

**核心决策（best-complete-solution / single-source-of-truth）**：不引入独立 module-global feature counter。thinking block 计数**天然是 per-request measure**，已适配 telemetry measure 体系；再造第二个真值源会造成同一 per-request 值两处累加 + 长期漂移。这与 `protect_streaming`/`tool_input_repair` 的独立 counter **不同**——那些的数据（控制流决策 / 修复动作）不在 measure 体系里才需独立 counter。

**关键机制**：每个 settled request 贡献「本请求的三桶 thinking block 数量」作为 measure（per-request 累加的整数）。全局累加后正是**逐块总数**——per-request 记录与 per-block 语义天然调和；开放 counters bag 意味着**零持久版本 bump**，并自动获得按 model/endpoint/client 维度的 breakdown。

```
                         ┌──────────────────────────────────────┐
  entry.outboundResponse │  extractThinkingBlockCounts(entry)    │  单一提取点
       .content ────────▶│  → {nonEmpty, emptySigned,           │  （telemetry-dimensions.ts）
                         │     emptyUnsigned}                    │
                         └──────────────────┬───────────────────┘
                                            │  sink 塞进 SettledTelemetryInput
                                            ▼
                         ┌──────────────────────────────────────┐
                         │  3 个 measure 累加进 dimSinceStart    │  唯一真值源
                         │  + dimBuckets（request-telemetry.ts） │  （request-telemetry.ts）
                         └───┬──────────────┬───────────────┬────┘
                             ▼              ▼               ▼
                       /metrics        /api/stats      /api/status
                    （自动 fan-out）  （generic breakdown）（agentKind sum 投影）
```

## 4. 实现契约

### 4.0 前置根因修复：H2/H3 流式失败腿保留 partial content（`routes/messages/handler-v4.ts`）

**独立于 metrics、有独立诊断价值**——先落地、可单独成 commit。把两条流式失败分支对齐 refusal/截断分支的既有做法（都用 `buildAnthropicResponseData(acc, model)`）：

- **H3 stream-error**（当前 `env.ctx.fail(acc.model || model, error, { usage, stop_reason })`，无 content）→ 改传 `{ usage: partial.usage, stop_reason: partial.stop_reason, content: partial.content }`。
- **H2 upstream-error SSE**（当前 `env.ctx.fail(acc.model || model, new Error(...))`，连 usage 都无）→ 同样先 `const partial = buildAnthropicResponseData(acc, model)` 再传 usage/stop_reason/content。

`fail()` 已支持 content 通道（`request.ts` 的 `content: partial?.content ?? null`），无需改。修复后 H2/H3 失败腿的 `outboundResponse.content` 从 `null` 变为 partial message 对象，忠实保留上游中止前已吐的残缺内容（含损坏 thinking 块）——richest-data-flow 的自然对齐。**范围仅这两条流式分支**：非流式失败是上游 HTTP error（无 acc、无 partial thinking 可留），abort 分支见 §5。既有断言 H2/H3 `content === null` 的测试若存在须更新（那些断言固化的正是本缺陷）。

### 4.1 提取器（`observability/telemetry-dimensions.ts`）

新增 `extractThinkingBlockCounts(entry: HistoryEntryData): { nonEmpty: number; emptySigned: number; emptyUnsigned: number }`，与既有 `extractToolNames` **同构**（同样从 `entry.outboundResponse?.content` 的 `.content` 数组遍历，防御 `unknown` 形态）。

**地基不变量（已实测确认 + §4.0 修复覆盖失败腿）**：`outboundResponse.content` 忠实含 thinking blocks（含空明文的、带 `signature` 字段）。已核验的路径：**成功 complete / 非流式成功 / 截断 `!sawMessageStop` / refusal / unrepairable** 均传 `buildAnthropicResponseData(acc, model)` 的 partial content（`handler-v4.ts:1062/1083/1103/1118`）；**H2/H3 失败腿**由 §4.0 修复补齐。`tests/pipeline/recording.unit.test.ts:159-173`（"signature embedded in content_block_start survives into response content"）已证明 `{ type:"thinking", thinking:"", signature:"EoAQ-embedded-3404" }` 忠实进 `response.content`。形态为 `{ role:"assistant", content:[...blocks] }`。**响应腿不经请求侧 sanitize**——`acc` 由 `onUpstreamFrame` 喂 S5 改写前的 RAW 上游帧（`handler-v4.ts:897/907`），`thinkingBlockSanitizeCheck` 只作用于发往上游的 messages、绝不碰响应腿，故损坏双空块在响应腿不被剥离、能到达 acc。

非 Anthropic 格式 → 三桶全 0（提取器对任意 `unknown` 安全返回零计数）。**已实测形态**：OpenAI CC 的 `outboundResponse.content` 是 `{ role, content: <string>, tool_calls }`（`recording.ts:145` `content: acc.rawContent` 是**字符串**非数组），提取器同构 `extractToolNames` 的 `if (!Array.isArray(blocks)) skip` → 跳过、返 0；Responses 经 `finalizeResponsesContent`。测试须显式覆盖「`content.content` 为 string」这一 CC 真实形态（而非仅 undefined/非对象/空数组），否则 lock 的是不存在的形态。

### 4.2 measure 注册（`request-telemetry.ts`）

- `MEASURE_NAMES` 新增 3 个，放入**新建的 `FEATURE_MEASURE_NAMES` 组**（语义独立于 base/cost/extra，表达「feature-specific 逐块计数 measure」）——**绝不进 `BASE_MEASURE_NAMES`**，否则旧 V2 telemetry 文件的 `isValidPersistedModelTelemetry` validity check 会要求它、判旧文件无效。`MEASURE_NAMES = [...BASE, ...COST, ...EXTRA, ...FEATURE]`。
- `SettledTelemetryInput` 新增 `thinkingBlocks?: { nonEmpty: number; emptySigned: number; emptyUnsigned: number }`。
- `applySettledMeasures` 累加：`c.thinkingBlocksNonEmpty += opts.thinkingBlocks?.nonEmpty ?? 0` 等三行。
- `createAccumulator` 经 `MEASURE_NAMES` 循环自动初始化为 0（无需额外改动）。
- **自动获得**：`/metrics`（`metrics-exposition.ts` 的 `for (const measure of TELEMETRY_MEASURE_NAMES)` fan-out，`toSnakeCase` → `copilot_api_thinking_blocks_non_empty_total{dimension,key}` 等）+ `/api/stats` generic breakdown + 7d 持久 + V3 generic (de)serializer round-trip。**零改动**这些消费端。

### 4.3 sink 接线（`observability/sinks/telemetry.ts`）

`handle()` 在构造 `SettledTelemetryInput` 时新增 `thinkingBlocks: extractThinkingBlockCounts(entry)`。单点提取，随既有 `recordSettledRequest` 分发到所有维度。aborted 请求仍按既有 carve-out 排除（sink 只订阅 `request.completed`/`request.failed`）。

### 4.4 /api/status 投影（`request-telemetry.ts` + `status/route.ts`）

`request-telemetry.ts` 新增 `getThinkingBlockTotals(): { nonEmpty; emptySigned; emptyUnsigned }`：从 `dimSinceStart.get("agentKind")` 遍历所有 key sum 三个 measure。**`agentKind` 是安全的全局锚**——DESIGN 明确其 extract 永不返 `null`、非 multi-key、bounded（`main`/`subagent` 二元），故每个 settled request 恰好累加到一个 agentKind key，sum over 其所有 key = 精确的全局逐块总数（无重复、无遗漏）。函数内注释钉死这个「为何 agentKind 可作全局 sum 锚」的不变量。

`status/route.ts` 的 `ServerStatusSchema` 加 `thinking_blocks: z.record(z.string(), z.unknown())`，handler 返回段 `thinking_blocks: getThinkingBlockTotals()`。

## 5. 已知语义与覆盖边界（有意决策，非缺陷）

**multi-key inflation**：measure 挂**每个维度**累加同一请求的贡献（既有架构：`inputTokens` 等亦如此——`recordSettledRequest` 对每个 distinct tool key 各调一次 `applySettledMeasures(opts)`，`opts` 含全部 measure）。故 `tool` 维度（multi-key）下，一个调用 N 个 tool 的请求，其 thinking block 计数会加到 N 个 tool key（按 tool 数放大）。这与既有 `inputTokens` 在 tool 维度的语义**完全一致**，可接受。`model`/`endpoint`/`agentKind`/`client` 是单-key/请求，不受影响；`/api/status` 全局投影用 agentKind、亦不受影响。`/metrics` 输出已有「不可跨维度求和」的 leading comment 覆盖此语义。

**覆盖边界（aborted 不计，有意取舍）**：sink 只订阅 `request.completed`/`request.failed`，**aborted 请求不进 telemetry**（`sinks/telemetry.ts:39` 既有 carve-out——客户端断开不是对模型/上游的裁决，计入会扭曲 per-model 成功率）。且 abort 分支 `content: null`（`request.ts`）。故「上游长时间只吐 thinking 就被客户端 abort」场景的 thinking 块不计入本 metrics——这是**与既有 telemetry 一致的有意取舍**，本 metrics 度量的是「settled（成功 + §4.0 修复后的失败腿）请求的 thinking 块质量」。abort 请求的 partial content 保留属独立诊断改进（abort 不进 telemetry，与本 metrics 正交），不在本 spec 范围。

## 6. 测试计划（TDD）

- **前置修复回归**（`tests/anthropic/` 或既有 handler 测试）：H2 upstream-error SSE + H3 stream-error 失败流，`outboundResponse.content` 在中止前吐过 thinking 块时保留 partial（含损坏双空块），而非 null。这是 §4.0 修复的锁定测试——先 RED（改前 content=null）再 GREEN。
- **unit**（`tests/observability/telemetry-dimensions.unit.test.ts`，既有文件）：`extractThinkingBlockCounts` 三桶判定——非空 / 空+签名 / 空无签名 / 混合多块 / `redacted_thinking`（有 `data` 无 `thinking`）不计且不误落 emptyUnsigned / signature 三态（`""`/`undefined`/缺 key/`null`）归 emptyUnsigned / **CC 真实形态 `content.content` 为 string 返 0** / `content` 为 undefined|非对象|空数组返 0。复用 `recording.unit.test.ts` 的 accumulator→content golden 建 fixture（地基同源）。
- **unit**（`tests/pipeline/request-telemetry.unit.test.ts`，既有文件）：`applySettledMeasures` 累加 3 个新 measure；`getThinkingBlockTotals` 从 agentKind 维度 sum 正确（含 main+subagent 两 key 合计）；V3 round-trip 保留新 measure（generic serializer）。
- **it/http**（`tests/observability/thinking-block-metrics.http.test.ts`，新建；被测核心是 sink→telemetry→status 投影链）：端到端——喂一个含空 thinking block 的 Anthropic 响应经 sink → `/api/status.thinking_blocks` + `/api/stats?dimension=model` breakdown + `/metrics` 三桶数值正确。
- **metrics-exposition unit**（`tests/pipeline/metrics-exposition.unit.test.ts`，既有文件）：新 measure 出现在 Prometheus 输出、snake_case 命名正确。

## 7. 非目标（YAGNI 边界）

- **不加 per-request `recordFeature` tag**：空 thinking block 就在 `outboundResponse.content` 里（richest-data-flow，history 已完整存），加 tag 是冗余派生、违反 single-source。单请求诊断直接看 history entry 的 content；聚合看 telemetry breakdown。
- **不加独立 module-global feature counter**（见 §3 决策）。
- **不做前端 dashboard 展示**（本 spec 只做后端 metrics；前端消费是独立后续，telemetry breakdown 已就绪）。
- **不改 `outboundResponse` 数据形态**：提取纯从既有 entry 派生。（例外：§4.0 修复让 H2/H3 失败腿从 `content:null` 变为保留 partial——这是**补齐既有 richest-data-flow 缺陷**、非新增形态，与截断/refusal 分支已有做法一致。）
- **不碰 stream-accumulator**：acc 结构不变。

## 8. 触及文件清单

| 文件 | 改动 |
|---|---|
| `src/routes/messages/handler-v4.ts` | **§4.0 前置修复**：H2/H3 流式失败分支传 `buildAnthropicResponseData(acc, model)` 的 partial content |
| `src/lib/observability/telemetry-dimensions.ts` | 新增 `extractThinkingBlockCounts` |
| `src/lib/request-telemetry.ts` | 3 measure 注册（`FEATURE_MEASURE_NAMES`）+ `SettledTelemetryInput.thinkingBlocks` + `applySettledMeasures` 累加 + `getThinkingBlockTotals` |
| `src/lib/observability/sinks/telemetry.ts` | sink 提取 + 塞入 opts |
| `src/routes/status/route.ts` | schema `thinking_blocks` 段 + handler 投影 |
| 测试（见 §6） | 前置修复回归 + unit + it/http + metrics-exposition |

**无需改动**：`metrics-exposition.ts`（自动 fan-out）、`/api/stats` 路由（generic）、V3 (de)serializer（generic）、`isolated-fixture.ts` RESETTERS（无新 module-global 单例）、`src/lib/context/request.ts`（`fail()` 已支持 content 通道）。

**实现顺序（commit 粒度）**：① §4.0 前置修复（独立 richest-data-flow 修复，先 RED 后 GREEN）→ ② 提取器 + measure 注册 + sink（TDD）→ ③ `/api/status` 投影 → ④ 端到端 http + metrics-exposition 测试 → ⑤ DESIGN.md 活文档同步（见 §9）。每步一个可独立成立的 commit。

## 9. 收尾 doc-sync（活文档 DESIGN.md，完成后更新）

DESIGN.md 是「现状镜」（`[done]` 标记描述已落地态），故按 `completion-includes-doc-sync` 在**代码落地后**同步（doc-first 指前瞻 spec 已先行、非先改活文档）。落地后须更新以下 loci（防漏，对齐 memory `feedback-completion-updates-docs`——收尾必跨文档 grep 验证）：

| DESIGN.md 位置 | 更新 | 关键措辞 |
|---|---|---|
| `request-telemetry.ts` 裸文件条目（现 L139） | +`FEATURE_MEASURE_NAMES` 第 4 类 measure 组（`thinkingBlocks*` 逐块三桶计数）；consumed-by 里 `routes/status` 从「model 摘要」扩为「+`thinking_blocks` 投影」；点名新投影 `getThinkingBlockTotals`（agentKind 维度 sum） | measure=数据非 schema、零版本 bump 的既有契约不变 |
| `/api/status` 路由条目（现 L192） | +`thinking_blocks` 段 | **必须写成「telemetry `agentKind` 维度 sum 的投影」，绝不并入 `protect_streaming`/`tool_input_repair` 的「feature-specific 计数器」措辞**——本设计是 single-source 投影而非独立 counter，误述会把架构讲反（doc-first 逼出的正确性点） |
| 流式截断检测行（现 L74）／响应腿数据模型（现 L60） | 注明 C1 修复：H2/H3 失败腿现也保留 partial content（对齐截断分支「`fail()` 经 content 通道保留残缺投影」）；L60 verdict 语义不变（H2/H3 仍 `success:false`+error），仅补「content 保留」面 | 不改 verdict、只补 content-preservation |

**无需改动**：`/metrics` 条目（现 L207，已是 generic「通用投影 `copilot_api_*_total`」，3 个新 measure 自动涵盖——这正是 registry 框架意图）。
