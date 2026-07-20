# 对抗性审查报告 — token usage 语义归一化修复计划

审查对象: `/home/xp/.claude/plans/vectorized-spinning-cherny.md`
裁判轴: 长远正确 + richest-data-flow + 完整根因修复。

## 语义断言核验（全部为真）

- canonical=Anthropic 净值 (input 与 cache 互斥): types.ts:179-185 无注释强制，但 sessions-agg.ts:30 `SUM(input)+SUM(cache_read)+SUM(cache_creation)` 与 recording.ts:104-107 Anthropic builder（net input + 独立 cache_*）共同反证约定成立。
- GHC oracle: 亲验 refs/ghc-api-py streaming.py:47/148、translator.py:286 均 `input_tokens = prompt_tokens - cached_tokens`。注意 GHC **只减 cached，不减 cache_creation**（OpenAI 无 cache_creation 概念）。plan 的 helper 带 cacheCreation 参数、对 OpenAI/Responses 传 0，算术等价，OK。
- Responses 上游 input_tokens 含 cached: responses-stream-accumulator.ts:71-74 `acc.inputTokens=usage.input_tokens` + `acc.cachedInputTokens=input_tokens_details.cached_tokens`，两者独立读取，input 为含缓存总量。helper 签名对 Responses 正确。
- Gemini 流式已净值: convert-response.ts:106 `promptTokenCount=max(0,promptTokens-cachedTokens)` → codec meta → geminiUsageFromMeta:246。plan 断言成立。
- Gemini 非流式未净值: handler-v4.ts:210 `input_tokens: usage?.prompt_tokens`（原始总量）。bug 确认。

## HIGH — 必须修

### H1. backfill 幂等仅防「重跑」，漏防「代码先上线 / 边跑边写」窗口
plan 显式拒绝行级自检、只靠 version guard（plan L74）。但 version guard 只在**整轮完成后**阻断再启动。真实部署时序:
1. 代码修复上线 → 新 OpenAI/Responses/Gemini 行的 `entries_v2.input_tokens` 列**已是净值**。
2. backfill 首轮启动（version key 尚未置位）→ scan 命中这些**新净值行** → 再减一次 cache → 破坏新行。
search-index-backfill.ts:184 用**独立于 version 的 per-entry guard**（`SELECT 1 FROM req_msg`）跳过已建行来规避同类问题；本 plan 无等价判别器。net 算术不可逆（`input=600,cache=400` 再跑 → 360），一旦污染无法自愈。
证据: search-index-backfill.ts:178-207 vs plan L73-76。
需要: 每行落一个「已归一化」标记（新列/边表/version 戳进行级），或强约束「backfill 完成前代码不得写净值」（与增量部署矛盾）。plan 当前设计两者皆无 → 净值行会被二次减。

## MEDIUM

### M1. request-telemetry 持久聚合 + input_tokens 直方图携带混合语义，plan 未处理
request-telemetry.ts 是**独立 JSON 持久存储**（atomicWriteJson，7d 滚动桶），**不从 entries_v2 重算**。plan 的 backfill 只改 entries_v2 列+blob，从不触及该存储。后果:
- applySettledMeasures:373-388 `inputTokens` 计数器 + costInputTokens 在最长 7d 内混合旧(总量)/新(净值)语义。
- **input_tokens 直方图**（:113-116 `extract: opts.usage.input_tokens`）: 修复后大缓存请求从高桶（如 50k）跳到低桶（如 5k），旧观测**永久错桶**、无法重新分桶（不能重新 observe）。
plan 把「聚合双计」列为要修的 bug（L10），却让该存储在 7d 内保持部分错误、且直方图永久错桶，全程未提及。至少应文档化「7d 自愈窗口 + 直方图历史错桶不可回填」，或提供 reset/重derive 路径。

### M2. ui-v4 AgentLane 前端 SUM 会静默少报，plan 漏列
AgentLane.tsx:14 `input += e.usage?.input_tokens`（**不加 cache_read**，与 sessions-agg.ts:30 加三项不一致）。net 化后该 lane 汇总的 input 变小、且 cache 那部分**从 lane 视图彻底消失**（AgentLane 只显 ↑in↓out）。plan review 项 3 点名要查 AgentLane SUM，plan 正文只列 MetaSegment/DiagnosticBar 补 cache 分解，**漏了 AgentLane**——它既不加 cache 又不会补显 cache，是真实的展示回归（richest-data-flow：cache token 在 lane 层丢失）。

### M3. 站点 E「复用 extractUsageMetadata」类型不成立
plan L45 称 gemini 非流式复用 extractUsageMetadata。但 extractUsageMetadata:96-116 返回 **Gemini 形状**（promptTokenCount/candidatesTokenCount/cachedContentTokenCount），非 `UsageData`（input_tokens/output_tokens/cache_read_input_tokens）。renderGeminiNonStreamingV4:206-216 要为 ctx.complete 构造 `UsageData`。不能直接复用 extractUsageMetadata 填 ctx usage——要么再套一层 Gemini→UsageData 映射（即 geminiUsageFromMeta 的逆），要么直接对手头的 `chat.usage`（ChatCompletionUsage 齐全）调 `usageFromTotalInput`。plan 的描述具误导性，实施者照做会撞类型错误。源字段是有的（chat.usage），修复可行，但 plan 措辞错。

## LOW / 需知会

### L1. via-fallback Responses 腿本就丢 cache_read（pre-existing，非本 plan 引入）
responses-to-cc-request.ts:527-533 `ccUsageToResponsesUsage` 合成 response.completed 的 usage **只带 input/output/total、丢 input_tokens_details.cached_tokens**。→ accumulateResponsesStreamEvent:74 `acc.cachedInputTokens=0`。故 CC-经-Responses 回退路径下 cache_read 在进 accumulator 前就没了。builder 层 `usageFromTotalInput(total, 0)` 算术无害（net=total），但**该腿永远无 cache_read 数据**。属既有 richest-data-flow 缺口，plan 未覆盖（也未声称覆盖）；若目标是「完整数据流」应一并修 ccUsageToResponsesUsage 透传 cached。

### L2. 生产端站点完备性（plan 覆盖充分，无遗漏）
全仓 grep `input_tokens:` 逐站点核验:
- 已列且正确: recording.ts A/B(132/178)、chat handler C(249)、responses handler D(218)、gemini handler E(210)；abort/fail 六处 chat:368/381、responses:308/320、ws:335/348 全为 OpenAI/Responses 语义、当前发原始总量且**丢 cache_read**，plan 均列入。
- 正确排除: Anthropic 腿全部（recording.ts:104、messages handler-v4:728/764/1005/1139、web-search-direct/handler、orchestrator、streaming-pump、warmup、count-tokens）——上游即 net。
- context/request.ts:512/521/573/787 全是 `{input_tokens:0}` 兜底占位，无关。
- 结论: 生产端无遗漏站点。

### L3. dual-write 断言正确
serialize.ts META_KEYS(61-79) **不含 usage** → outboundResponse.usage 存于 head blob；input_tokens/cache_read/cache_creation 为独立列(222-225)。deserialize 不从列回注 usage。故 plan「必须同改列+blob」为真。migrations/index.ts:50-62 注释确证 long backfill 走 background 非 Umzug。

### L4. 消费端 rowAnomaly 判定不变（plan 断言正确）
activity-row.ts:89 cacheMiss 要求 `!cache_read` 短路；net 化只缩小已有 cache 的行，此类行本就短路，判定不变。tokenIn:46 读 input_tokens 自动正确。

## 结论
方向正确（GHC oracle 逐字印证），生产端站点完备。**H1 是阻断级**: 部署时序会让 backfill 二次减、破坏新净值行，需引入 per-row 判别器（对齐 search-index 的 req_msg guard 思路），单靠 version guard 不足。M1/M2 是 plan 声称要修的问题域内的真实遗漏（telemetry 存储 + 直方图历史语义混合；AgentLane 前端少报）。M3 是实施误导。建议在实施前补齐 H1 判别器设计、M2 AgentLane、并文档化 M1 的不可回填部分。
