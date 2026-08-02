# Refusal 诊断忠实化与分型：架构评审

> 评审对象：`docs/spec/2026-07-27-refusal-diagnostics-and-typing.md`。
> 结论性质：架构提案，关键决策仍待主会话确认。
> 证据说明：除文件引用外，本文还采用主会话补充的 3 条 4141 History 一手样本。它们尚未落盘，因此无法提供 `文件:行号`；本文均以 request id 明示，不把它们伪装成已落盘证据。

## 1. 总结结论

草案找对了根因的一半：`thinking-only` 确实是错误命名，`stop_details` 确实应从 raw SSE 提升为结构化、持久、可消费的数据；现状 accumulator 只保存 `stop_reason`，没有保存 `stop_details`，而 `ResponseData` 也只有 `stop_reason`（`src/lib/anthropic/stream-accumulator.ts:100-124`、`src/lib/anthropic/stream-accumulator.ts:390-415`、`src/lib/context/types.ts:72-113`）。这部分应保留并扩大到所有正确消费面。

但草案从“category 有无”进一步推导出两套行为策略，目前证据不成立。三个已知样本证明的是“上游有时给出非空 category，有时给出 `null`”，没有证明两者具有不同的可重试性、不同的终态语义或不同的最佳 wire 处理。尤其 `req_1783947618475_731` 在 `category:"bio"` 下消耗 25,636 thinking tokens 后才拒绝，直接证伪草案“policy 多在推理前拦截”的表述；草案把“同内容必再被拒”写成事实也没有重放实验支持。现有草案中的这两条断言位于 `docs/spec/2026-07-27-refusal-diagnostics-and-typing.md:67-72`。

我的推荐形状是：

1. 把 refusal 建模为一个结构化的**观测事实**，而不是先建模成两套行为策略。事实至少包含 `stopReason`、`category: string | null`、`explanation: string | null`、`contentless`、`thinkingTokens`、`outputTokens`；完整原文进入 History，末端消费者自行决定如何展示。这与 accepted ADR 的“后端完整存储，前端选择性展示”一致（`docs/decisions/2026-07-05-richest-data-flow.md:16-30`）。
2. 暂不新增 3 个 `policy_*` 配置键。保留现有一个 wire 策略键和两个模板键；category 只改变模板变量与诊断，不改变模式。
3. 将客户端 wire 处理与请求终态判定解耦。默认客户端 wire 应优先保留原生 `refusal + stop_details`，而 History/终端应把 contentless refusal 记为失败；不要为了记失败而把原生 refusal 降级成通用 `event:error`，也不要把拒绝伪装成正常 `end_turn`。
4. 不需要因本次改动合并两个 factory。只要没有按 kind 选择 mode，mode 在流开始时仍然已知。应抽取共享的 refusal 观察器/解析原语，两个现有 reshaper 可以保留；将来真有按 category 分派的实证需求，再增加一个薄外壳延迟分派，而不是把所有状态机揉成一个大 factory。
5. 草案列出的 History 接线仍不完整。还应覆盖 TUI 完成行、History 列表与详情、CSV 导出、全文检索派生、遥测 refusal category 维度，以及跨协议翻译时的 category 降级留痕。

## 2. Q1：`empty` 型存在时与不存在时怎么设计

### 2.1 已知事实下的建议

`empty` 形态已经存在：`req_1782214935133_68` 的 `stop_details.category` key 存在但值为 `null`，且只有一个带有效 signature 的 thinking 块。现状契约也记录了这一请求确实是 contentless refusal，并导致 Claude Code 后续“继续”空转（`docs/refusal-recovery.md:4-18`）。因此 `extractRefusalDetail` 必须把 `null` 作为一等兼容形态，而不是只测试字段缺失；`category` 的判据必须是“非空 string”，不能是“字段存在”。

但我不建议继续使用 `policy | empty` 作为公共类型名。`empty` 容易被理解为“响应没有任何块”，而真实 `req_1782214935133_68` 有一个 thinking 块；真正稳定的维度是 `category: string | null` 与 `contentless: boolean`。现状门控也只关心 `stop_reason === "refusal" && !sawRealContent`（`src/lib/anthropic/recover-refusal.ts:99-102`），草案将它改名为 `isContentlessRefusal` 是正确的（`docs/spec/2026-07-27-refusal-diagnostics-and-typing.md:78-89`）。

推荐公共形状不是 `RefusalKind = "policy" | "empty"`，而是类似 `RefusalObservation`：

- `category: string | null`：上游是否提供了类别，不推断可重试性。
- `explanation: string | null`：上游原文，完整保留。
- `contentless: boolean`：是否没有客户端可见 `text/tool_use`。
- `thinkingTokens: number | null`：权威细分存在时取细分；不存在时按兼容规则回落。
- `outputTokens: number`：与 thinking tokens 分开保存，避免再次混淆。

`req_1782214935133_68` 没有 `output_tokens_details`，所以 `thinking_tokens ?? output_tokens` 的兼容回落必须保留；本次 cyber 样本则证明细分值存在时不能再直接使用 `output_tokens`。现状代码当前直接读取 `usage.output_tokens`（`src/lib/anthropic/recover-refusal.ts:187-191`、`src/lib/anthropic/recover-refusal.ts:263-272`），草案识别出的 D3 是真实缺陷（`docs/spec/2026-07-27-refusal-diagnostics-and-typing.md:59-61`）。

### 2.2 反事实：如果最终证明无 category 形态不存在

如果未来协议收敛为每个 refusal 都有非空 category，仍然不应删除结构化 `stop_details` 接线；category/explanation 是上游事实，History 必须保留（`docs/decisions/2026-07-05-richest-data-flow.md:18-30`）。此时应删除 `kind` 和全部按 kind 的模式配置，只保留单一 refusal 观察与单一 wire 策略。

### 2.3 反事实：如果无 category 形态存在，但以后实验证明行为真的不同

只有在完成“相同请求重放、跨模型重放、客户端行为”实验并证明 category presence 能稳定预测可恢复性后，才值得引入按类策略。届时也应把判据命名为 `categorized | uncategorized`，不要叫 `policy | empty`；它描述的是协议事实，不冒充尚未证明的政策机制。成功判据应是：同 payload 的重复 refusal 概率、换模型恢复率和客户端终态行为在两组之间有稳定差异。当前三个样本不足以得出这些结论，标记为**未验证**。

## 3. Q2：默认终态与默认 wire

### 3.1 在 `error` 与 `end_turn` 二选一时，我推荐 `error`

如果只能在草案给出的两个选项中选，我推荐 `error`。`end_turn` 明确把语义失败伪装成正常完成；现状契约已经以“上游语义失败必记 fail”为默认原则（`docs/refusal-recovery.md:8-18`）。更重要的是，空 `end_turn` 已由真实 Claude CLI e2e 证明会多发一轮并返回空结果，非空文本只是阻止空转，并不能把 refusal 变成真正成功（`docs/refusal-recovery.md:30-34`）。

标题生成辅助请求不构成选择 `end_turn` 的理由。Claude Code 2.1.207 的标题生成函数已在内部 catch 所有失败并回落 `null`，不会让主编码会话失败（`/home/xp/.claude/refs/claude-code-2.1.207/app.pretty.js:332758-332771`）；它的调用方也在拿到 `null` 后使用本地预览文本回退（`/home/xp/.claude/refs/claude-code-2.1.207/app.pretty.js:392967-392973`）。因此“辅助请求失败无伤”是有源码证据的，不需要用伪成功来保护它。

### 3.2 但更好的默认不是通用 `event:error`，而是“原生 refusal wire + failed verdict”

当前设计把三个概念绑定在一个 `refusal_sse_rewrite` 值里：客户端看到什么、History 记成功还是失败、feature/log 打什么。绑定导致 `refusal` 模式保真 wire 却谎报 complete，`error` 模式记 fail 却丢失客户端原生 `stop_details`。现状文档明确写了这三个模式的终态绑定（`docs/refusal-recovery.md:8-18`、`docs/refusal-recovery.md:44-47`）。

Claude Code 2.1.207 已原生处理 `stop_reason:"refusal"`：它读取 category/explanation，生成专门的 refusal 消息，保存 `stop_reason` 与 `stop_details`；explanation 会截到 400 字符，而不是把 refusal 当空轮（`/home/xp/.claude/refs/claude-code-2.1.207/app.pretty.js:170302-170326`）。流式/非流式请求也在最终 response 上检查 refusal，并产生 `refusal_no_fallback` 或 fallback 请求（`/home/xp/.claude/refs/claude-code-2.1.207/app.pretty.js:298050-298063`）。因此对当前主要客户端，原生 refusal 是信息最丰富、协议最忠实的 wire。

推荐主会话确认以下 ADR 草案：

- **客户端默认 wire**：contentless refusal 原样透传，包括 `stop_details`。
- **代理请求 verdict**：记 `failed`，failure reason 为结构化 refusal 摘要；上游腿仍记 `success:true`，因为上游完整返回了 200 refusal。现有 `ctx.fail(..., {upstreamSucceeded:true})` 已支持“上游腿成功、代理 verdict 失败”的分离（`src/lib/context/request.ts:1694-1723`）。
- **兼容模式**：`end_turn` 与 `error` 继续作为显式用户选择；但它们是 wire presentation policy，不再拥有终态语义。

这比在 `error` 和 `end_turn` 之间争默认更正确，也与项目“数据最丰富地流到末端”一致（`docs/decisions/2026-07-05-richest-data-flow.md:18-40`）。

需要注意：2026-06-23 的旧 CC 行为曾在原生 refusal 后空转（`docs/refusal-recovery.md:4-7`），而 2.1.207 源码现在有原生 refusal 处理。两者为何不同尚未实测裁决，可能是客户端版本变化、fallback 配置或主循环路径差异，标记为**未验证**。在翻默认前，应使用当前 Claude Code CLI 跑 contentless categorized/uncategorized 两个 e2e 正样本；这不是要求维持旧默认，而是验证新默认的当前客户端 oracle。

## 4. Q3：explanation 是否应进入 `end_turn`

草案“explanation 回灌后可能再次触发同一分类器”的说法目前是推测，没有重放实验。三个 refusal 样本也削弱了 explanation 的信息价值：其中两个 explanation 是完全相同的 fallback 样板句，真正有区分度的是 category。草案把 explanation 称为“唯一可行动诊断”过强（`docs/spec/2026-07-27-refusal-diagnostics-and-typing.md:46-57`）。

不过“不把 explanation 放进默认 `end_turn` 文本”的结论仍然正确，理由应改成可证的**语义边界**，而不是未证的二次触发风险：

- `end_turn` 合成 text 是一条成功 assistant 消息，会被 Claude Code baked 进后续对话；现状契约已明确这一数据流（`docs/refusal-recovery.md:20-32`）。
- explanation 是上游诊断元数据，不是模型对用户任务的回答。把诊断原文放进成功 assistant 历史，会污染后续语义上下文，即使它永远不触发分类器也不合适。
- 原生 refusal 路径和 error 路径不是成功 assistant 内容，可以完整暴露 explanation。Claude Code 自己也在无 fallback 时读取并展示 explanation（`/home/xp/.claude/refs/claude-code-2.1.207/app.pretty.js:170302-170326`）。

因此推荐：

1. History、结构化 API、日志详情保存完整 explanation，不脱敏、不裁剪；这是内部工具的既定安全立场与 richest-data-flow 要求（`CLAUDE.md:35-38`、`docs/decisions/2026-07-05-richest-data-flow.md:24-30`）。
2. 原生 refusal wire 保留完整 stop_details；不要由代理二次包装。
3. `event:error` message 可以包含 category、explanation、request id，但终端单行日志应以 category 为主，完整 explanation 放 detail/History，避免一条样板句淹没日志。
4. 合成 `end_turn` 默认只写稳定的代理说明、category、request id；不写 explanation。无需“脱敏 explanation”或“只提 URL”这种中间态，因为问题不是敏感信息，而是它不属于成功 assistant 回答。用户显式模板仍可选择 `{refusal_explanation}`。

“explanation 原文是否会再次触发分类器”应单独做重放 PoC；成功判据是同 payload 只增删 explanation 文本时 refusal 结果发生可重复变化。当前标记为**未验证**，不应继续作为架构前提。

## 5. Q4：是否必须合并 factory、`appliesTo` 是否破坏字节等价

草案的“必须合并”论证只在“mode 必须按 kind 选择”成立；而按 kind 选择 mode 本身尚无证据。因此当前不成立。现状在 stream 开始时按全局 mode 选择 `createRefusalRecoverer` 或 `createRefusalErrorEmitter`（`src/lib/codec/anthropic/response-rewrite-adapters.ts:355-381`），只要 mode 仍是全局策略，这个时点没有结构性问题。

推荐形状：

- 抽一个共享、纯逻辑 `observeRefusalDelta`/`extractRefusalObservation`，负责解析 category/explanation/tokens；accumulator、end_turn recoverer、error emitter、handler 都使用同一原语。
- 保留两个 factory，因为二者状态机不同：end_turn 追踪 `maxIndex` 并追加三帧，error emitter 抑制 delta 与 `message_stop`（`src/lib/anthropic/recover-refusal.ts:157-203`、`src/lib/anthropic/recover-refusal.ts:247-288`）。合并不会消除这些差异，只会增加分支密度。
- 如果未来实证要求按 category 选择 mode，加一个薄 `createRefusalDispatcher`：在 refusal delta 到达时计算 observation，委派给已经独立测试的三个 disposition handler。不要把解析、策略、两套状态机和遥测副作用合成一个函数。

关于 `appliesTo`：只要 rewriter 被挂上但每个非目标帧都返回同一个 frame 对象，wire 字节不会改变。pipeline 对单入单出、相同 wire bytes 的 emit 走 identity 映射，不创建 derived frame（`src/lib/pipeline/stream/response-processor.ts:253-272`、`src/lib/context/request.ts:649-676`）。所以“挂上本身”不会改变字节。

但草案拟议的“两型 mode 都是 refusal 才跳过”仍有两个问题：

1. 它扩大了所有 Anthropic 流经过该状态机的范围，虽不改 wire，却增加了行为接线和测试面积；在没有按 kind mode 的需求时没有架构收益。
2. 非流式 `runResponseWhole` 同样只按 `appliesTo` 装配 rewrite（`src/lib/pipeline/rewrite-registry.ts:206-215`、`src/lib/pipeline/driver.ts:1536-1550`）。若未来 dispatcher 的 `transformWhole` 与流式 observation 判据漂移，仍可能发生流/非流不一致；“合并 factory”本身不解决这一点。

因此推荐保留现有快路径：全局 mode 为 `refusal` 时不挂 rewrite；需要诊断的数据由 accumulator/History 捕获，不要为了数据采集强迫一个 wire rewriter 永远挂载。

## 6. Q5：配置键形状

草案新增的 `inherit` 哨兵不符合项目现有配置约定。`nullableEnum` 和 `nullableString` 都把 YAML `null` 转成 TypeScript `undefined`，并允许字段省略（`src/lib/config/schema.ts:82-97`）；运行时只在字段非 `undefined` 时覆盖 state（`src/lib/config/config.ts:812-815`）。项目已有 partial override 也使用字段缺省 + `?? shared` 表达继承，而不是把 `inherit` 混进业务枚举（`src/lib/state.ts:163-166`、`src/lib/state.ts:1935-1950`）。

因此分两层建议：

- **当前推荐**：不新增三个 policy 键。category presence 目前只是诊断差异，没有已证的行为差异；增加 mode/text/error 三套 override 会把未经验证的分类固化成公共配置契约。
- **若未来实证后确需 override**：`refusal_policy_sse_rewrite` 应使用 `nullableEnum(["refusal","end_turn","error"])`，省略或 `null` 表示继承；两个文本键用 `nullableString()`，省略或 `null` 表示继承。显式 `""` 仍必须保留为合法值，因为现有契约用空串表达 zero-wrapping（`docs/refusal-recovery.md:30-32`）。不要加入 `inherit` 字面值。

还应避免把内置 policy 默认文案与“继承基础模板”混为一谈。一个 optional override 只有两层：有值就覆盖、无值就继承。若确实需要第三种“使用 policy 专属内置默认”，应设计清楚独立的配置层级，而不是让 `null`、省略、`inherit`、内置默认四种语义叠在一个字段上。当前没有这个需求证据。

## 7. Q6：草案漏掉的正确消费面

### 7.1 TUI 完成行

当前失败完成行故意不显示 stop reason、tool names 和 response thinking，只显示 error 文本；feature tags 也只在非 error 时进入 `extra`（`src/lib/tui/render/lifecycle.ts:86-138`）。因此仅把 category 放进 `recordFeature` 或 upstream response，不会让 policy refusal 在 `[FAIL]` 行上可见。

推荐在终态投影增加结构化 refusal token，例如 `refusal:cyber` / `refusal:uncategorized`，与 failure text 分离；完整 explanation 不塞进单行。TUI feature tag 可以同步携带 `detail:{category}`，但不能作为唯一通道。现有 `refusal-recovered/refusal-errored` feature 既无 detail，TUI 也只显示裸 feature 名（`src/lib/observability/events.ts:137-140`、`src/lib/tui/active-request-store.ts:188-224`）。

### 7.2 History 详情、列表与 session 聚合

History 详情页目前只在失败时展示 `failureReason`，没有结构化 category；DiagnosticBar 和 ResponseSegment 都走该字符串（`ui-v4/src/components/detail/DiagnosticBar.tsx:26-64`、`ui-v4/src/components/detail/segments/ResponseSegment.tsx:162-219`）。应增加独立的 Refusal 诊断块或 badge，展示 category、完整 explanation、thinking/output tokens，并明确“upstream returned refusal”与“proxy presentation mode”。不要把这些字段继续压进 `failureReason` 一条字符串。

History 列表 `EntrySummary` 只有 `responseError`，没有 stop reason/category（`src/lib/history/types.ts:668-718`、`src/lib/history/in-flight.ts:153-185`）。推荐增加 `stopReason` 与 `refusalCategory` 的轻量派生字段，使请求行无需拉全量 detail 就能显示 `refusal:cyber`。session summary 当前只聚合 completed/failed/aborted（`src/lib/history/sessions.ts:27-61`）；是否增加 category 计数可由 UI 需求决定，但至少 failed 计数必须建立在正确的 proxy verdict 上，不能因默认 wire 透传而把 refusal 算 completed。

### 7.3 History V3 canonical metadata 与 projection

草案所列“`ResponseData.stop_details` 贯通 7 处”仍漏了 canonical metadata 这条承重链。`responseMetadata` 目前显式枚举 `stop_reason/status/error/responseId/toolSearchRequests/copilotAnnotations`，不会自动保留新字段（`src/lib/context/request.ts:764-783`）；V3 projection 的 response metadata 类型和输出也显式枚举同一集合（`src/lib/history/v3/projection.ts:214-232`、`src/lib/history/v3/projection.ts:318-336`）。这两处都必须纳入规格，否则运行时内存对象有 stop_details、落盘再读却静默丢失。

同样，`legFromUpstreamResponse` 是另一处显式投影（`src/lib/context/request.ts:159-180`），`HistoryUpstreamResponseData` 与公开 History `UpstreamResponseData` 是两个锁步 owner（`src/lib/context/types.ts:267-286`、`src/lib/history/types.ts:411-432`）。草案把 `context/request.ts(×4)` 概括成数量不够可靠，应改成按契约名称列清楚：`ResponseData`、partial/fail preservation、operation metadata、in-memory leg、canonical projection、public History type。

### 7.4 CSV 导出与全文检索

CSV 当前导出 `stop_reason` 和 error，但不导出 category/explanation（`src/lib/history/stats.ts:90-134`）。推荐至少增加 `refusal_category`；完整 explanation 可作为单独列，保持可查询性。

History 全文检索目前只索引 client-facing request/response 和 forwarded frames，刻意排除 upstream/intermediate tracks（`src/lib/history/v3/projection.ts:98-115`）。这意味着 `error` 或 `end_turn` 模式如果没有把完整 explanation 发给客户端，搜索就找不到上游 explanation。推荐把结构化 refusal category/explanation 作为 terminal diagnostic 文本追加进派生 search corpus；这不改变 authoritative storage，只提高诊断检索能力。

### 7.5 遥测维度

当前遥测维度只有 model/endpoint/client/agentKind/tool/max_tokens_truncation（`packages/telemetry/src/dimension-names.ts:35-63`），没有 refusal 分类。推荐增加 `refusal_category` 维度：非 refusal 返回 `null`，refusal 且 category 非空返回该 category，否则返回 `uncategorized`。category 是上游开放字符串，不应假定永远只有 cyber/bio；因此维度应使用 `capped`，不是 `bounded`。registry 已支持 extractor 返回 `null` 表示不适用（`src/lib/observability/telemetry-dimensions.ts:141-166`）。

该维度让 `/api/stats?dimension=refusal_category` 直接给出各类别 requestCount、token 和时延，不需要手搓 refusal 专用聚合。遥测 sink 已从最终 upstream response 读取 usage，并把所有 settled 请求送入 registry（`src/lib/observability/sinks/telemetry.ts:50-94`）；基础 measures 已包含 request/success/failure 计数（`packages/telemetry/src/request-telemetry.ts:84-90`、`packages/telemetry/src/request-telemetry.ts:866-879`）。

但要同时修正语义：sink 的 `success` 优先读取 upstream response success，而 `ctx.fail(...,{upstreamSucceeded:true})` 会诚实地把上游腿记为 success（`src/lib/observability/sinks/telemetry.ts:53-68`、`src/lib/context/request.ts:1707-1723`）。因此 refusal category 维度里的 `successCount` 仍会是 1，表示上游 HTTP/协议腿成功，而不是用户请求成功。推荐在遥测契约中明确这两个概念，长期增加独立 `requestVerdictSuccess` 或 refusalCount measure；不要悄悄改变现有 successCount 的上游腿语义。

### 7.6 `recordFeature` 的标签粒度

两个现有 feature 名只表达 presentation mode，不表达 category（`src/lib/observability/events.ts:137-140`）。推荐保留稳定的 feature kind，并加 detail：`{category: string | null, disposition: "native"|"end_turn"|"error"}`。不要把 category 拼进 `FeatureKind` 枚举，否则每个新上游 category 都要求代码发布。

feature event 只是实时观测，不能代替 History：`recordFeature` 只 publish event（`src/lib/context/request.ts:2054-2060`），History canonical record 并未持久化这些 feature。因此 category 必须首先进入 response/terminal 数据模型，feature detail 只是 TUI/live UI 的即时投影。

### 7.7 跨协议翻译

Anthropic→Chat Completions 当前把 `refusal` 映射成 `finish_reason:"content_filter"`，会丢 category/explanation（`src/lib/openai/translate/anthropic-to-cc.ts:142-166`）；Anthropic→Responses 则映射成 `incomplete_details.reason:"refusal"`，同样没有 category（`src/lib/openai/translate/anthropic-to-responses.ts:180-212`）。即使客户端格式无法承载 stop_details，History upstream 轨和 feature/terminal diagnostic 也应保留 category，并为降级打可辨识标记。否则“direct Anthropic 有分类、翻译腿只有 content_filter/refusal”会形成路径相关的观测盲区。

## 8. 待主会话确认的 ADR 草案

### ADR-A：refusal 的公共模型

**推荐**：采用事实型 `RefusalObservation`，以 `category: string | null` 与 `contentless` 表达已知事实；不采用暗含政策机制和可重试性的 `policy | empty`。理由见 `docs/spec/2026-07-27-refusal-diagnostics-and-typing.md:67-89` 与本文 §2。

### ADR-B：默认 wire 与 verdict 解耦

**推荐**：默认原生 refusal wire，proxy verdict 为 failed；保留显式 end_turn/error presentation。理由是当前 Claude Code 已原生消费 stop_details（`/home/xp/.claude/refs/claude-code-2.1.207/app.pretty.js:170302-170326`），而 `ctx.fail(upstreamSucceeded:true)` 已有腿/终态解耦能力（`src/lib/context/request.ts:1694-1723`）。

未采纳但记录：默认 `error`。它比 `end_turn` 诚实，但把富 refusal 降格成通用 APIError；只有客户端不支持原生 refusal 时才是合理兼容模式。

未采纳但记录：默认 `end_turn`。它避免 SDK throw，却把拒绝伪装成正常回答，并可能进入下一轮历史（`docs/refusal-recovery.md:20-32`）。

### ADR-C：不新增按 category 的配置覆盖

**推荐**：当前不新增。若未来实验证明 categorized/uncategorized refusal 的恢复策略稳定不同，再使用 nullable optional override；禁止 `inherit` 哨兵。依据是现有 nullable helper 与 partial override 约定（`src/lib/config/schema.ts:82-97`、`src/lib/state.ts:1935-1950`）。

### ADR-D：factory 保持分离，解析收敛

**推荐**：共享 observation 原语 + 保留两个 reshaper；未来需要时加薄 dispatcher。理由是两个 factory 的状态机职责客观不同（`src/lib/anthropic/recover-refusal.ts:157-203`、`src/lib/anthropic/recover-refusal.ts:247-288`），而当前 mode 在构造时已知（`src/lib/codec/anthropic/response-rewrite-adapters.ts:355-381`）。

### ADR-E：完整消费面

**推荐**：规格必须覆盖 canonical metadata/projection、TUI、History detail/list/export/search、telemetry dimension、feature detail 和翻译降级，不能只列 6 个 handler/data 接线点。项目已经明确“改动横切数据形态时必须评估所有下游消费者”（`docs/decisions/2026-07-05-richest-data-flow.md:32-40`）。

## 9. 仍需验证的点

1. 当前 Claude Code 2.1.207 对 categorized 与 uncategorized contentless refusal 的真实 agent-loop 行为；源码显示已支持，但与 2026-06-23 的旧 e2e 观测冲突（`docs/refusal-recovery.md:4-7`、`/home/xp/.claude/refs/claude-code-2.1.207/app.pretty.js:170302-170326`）。
2. explanation 回灌是否提高再次 refusal 的概率。当前无重放证据，不能作为设计前提。
3. categorized/uncategorized 是否有稳定不同的同内容重试成功率。当前三个样本都没有重放实验。
4. 跨协议客户端是否有可承载 category 的标准字段；在没有标准字段前，History/telemetry 必须保真，客户端 wire 只做明确标记的诚实降级。
