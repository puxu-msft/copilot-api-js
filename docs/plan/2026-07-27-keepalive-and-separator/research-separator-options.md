# 上游 assistant thinking 块布局“合成分隔符”方案调研

日期：2026-07-27

状态：调研中；本文件仅包含只读事实复核与方案设计，不修改生产代码，不请求真实上游。

## 当前结论摘要（随调研更新）

1. 当前可见 text marker 不是无条件必要；它只在“必须保留全部 thinking 块、单条 assistant 消息内修复、没有可复用的真实合法非-thinking 分隔块、且空/空白 text 会被上游删除或拒绝”同时成立时才必要。若保留或就地替换上游原生空 text、存在足够真实分隔块，或采用另一种经真上游证明可接受的表示，便可不插入当前 marker。
2. ADR `docs/decisions/2026-07-05-richest-data-flow.md` 第 33–41 行的直接适用范围是“往真实数据流注入、面向下游消费者的合成帧”，并明确要求原始上游轨无合成物、合成物只进 forwarded/派生轨且显式标记。它没有直接规定“发往上游请求体中的合成 content block”；但其可观测性原则类推适用：若上游请求体被 History 记录，合成物应在记录层可辨识。不能由此 ADR 推出“wire text 本身必须带人类可见 marker”。
3. 纠正后的事故链：当前默认 keepalive 是标记为 `synthetic="keepalive"` 的 `ping`，不是空 text anchor；本轮 4141 抽样观测到的空 text `content_block_start` 全部无 synthetic 标记，index 分布为 0/1，且均被后续真实 delta 填成非空。事故导出 entry 中承担 thinking 边界的最终空 text 来自上游响应，经客户端回流后被我方 `filterEmptyAnthropicTextBlocks` 删除，由此制造邻接；它不是 keepalive 自激闭环。“不产生空锚”方案删除；“结构空位就地替换”升为首选候选。

## 已复核证据

- C1/C2/C3 及合法形态 `[T,SEP,T,tool]`、`[T,SEP,T,SEP]`、`[T,tool1,T,tool2]`：`/home/xp/src/copilot-api-js/docs/spec/2026-07-26-thinking-terminal-block-layout.md:21-39`。证据等级：项目已记录的真 GHC 上游重放实测，本轮未重复打真实上游。
- 当前 marker 生成、前缀族识别、空白 text 会被 strip 的设计前提：`/home/xp/src/copilot-api-js/src/lib/anthropic/sanitize/assistant-block-layout.ts:9-50`。
- 当前算法把非空 text 与所有非-thinking 块视作候选真实分隔符，并在不足时补 marker：同文件 `:63-71,121-167`。
- 当前 sanitizer 确实以 `block.text.trim() !== ""` 删除空/纯空白 text：`/home/xp/src/copilot-api-js/src/lib/anthropic/sanitize/content-blocks.ts:9-26`。
- keepalive anchor 确实打开 `{type:"text",text:""}`，随后发送空 `text_delta`：`/home/xp/src/copilot-api-js/src/lib/anthropic/keepalive-anchor.ts:84-104`；该机制意在重置 Claude Code 300 秒 watchdog：同文件 `:186-203`。
- ADR 的合成数据条款：`/home/xp/src/copilot-api-js/docs/decisions/2026-07-05-richest-data-flow.md:33-41`；应用实例明确谈 forwarded SSE 轨与 History：同文件 `:43-48`。

## 纠正后的空 text 来源与删除 pass 审计

### 来源复核

- 项目文档对事故请求 `req_1785160010003_3754` 的客户端形状记录为 `[thinking,text(""),thinking,tool_use]`，sanitizer 后 wire 形状为 `[thinking,tool_use,thinking]`：`/home/xp/src/copilot-api-js/docs/spec/2026-07-26-thinking-terminal-block-layout.md:95-112`。
- 当前默认 keepalive 已是 `ping`，不是 `empty_text`：`/home/xp/src/copilot-api-js/src/lib/state-defaults.ts:76`、`/home/xp/src/copilot-api-js/config.yaml:757-765`。这与早期 `docs/DESIGN.md:305-306` 的“empty_text 默认”描述冲突；该 DESIGN 行已陈旧，不能用来给事故归因。
- 本轮对 4141 做了只读抽样。最近 200 条中有 159 条 outbound `/v1/messages`：59 个 `synthetic="keepalive"` 帧全部是 `ping`；59 个 text `content_block_start{text:""}` 全部没有 synthetic 标记，index 分布为 0×11、1×48。本轮还重建了这批 SSE 的最终 text 内容：64 个 text 块全部在后续 delta 中获得非空文本，没有最终空 text。这个抽样证明检索确实能命中已知 keepalive 和空 start 正样本，也证明普通流式协议的 block start 初值为空不等于最终历史块为空。它不直接复现事故中的最终空 text 块；事故形状仍以导出 entry 和既有实测文档为证。

### `filterEmptyAnthropicTextBlocks` 原始目的

- 当前实现对所有 message text block 用 `block.text.trim() !== ""` 作终末过滤：`/home/xp/src/copilot-api-js/src/lib/anthropic/sanitize/content-blocks.ts:9-26`；调用点在 `finalizeAnthropicSanitization`：`/home/xp/src/copilot-api-js/src/lib/anthropic/sanitize/result.ts:40-59`。
- `git blame` 指向 `57b15e61c`，更早引入提交 `461e9557` 的注释明确写着：Anthropic API 会以 `text content blocks must be non-empty` 拒绝空 text，因此它是 original input / sanitization / truncation 后的通用安全网。现有集成测试还明确锁定“preserve thinking 时也删除纯空白 text”：`/home/xp/src/copilot-api-js/tests/anthropic/message-sanitizer.it.test.ts:1243-1267`。
- 这说明不能把全局过滤器简单删除。当前缺陷不是“过滤空 text 一概错误”，而是它把两种语义混为一谈：普通垃圾空块与位于两个有效 thinking 之间、承担结构边界的空块。后者即使不能原样上 wire，也必须在删除前保留其边界信息。

### “就地替换”与“先删后补”的语义差别

- 先删后补：`[Ta,empty,Tb,tool] → [Ta,Tb,tool] → move_blocks → [Ta,SEP,Tb,tool]`。最终 wire 在这个最小形状上可与就地替换相同，但算法已经丢失 provenance：不知道 SEP 是替换哪个上游槽位，也不知道相邻是客户端原生、上游原生，还是其他 sanitizer 删除后新生。stats 只能报告“删除 1 + 插入 1”，mapping 也只有 message 级，没有 block 级来源；见 `/home/xp/src/copilot-api-js/src/lib/codec/anthropic/request-rewrite-adapter.ts:84-95` 与 `/home/xp/src/copilot-api-js/src/lib/anthropic/message-mapping.ts:42-82`。
- 就地替换：在删除 pass 看到 `thinking/empty-text/thinking` 时，把该空块替换为合法分隔载体，保留该槽位和周围真实块顺序；对事故形状直接得到 `[Ta,SEP,Tb,tool]`。它比全量重排更接近输入，能单独统计 `replacedStructuralEmpty`，也能把“由哪个 inbound block 派生”保留下来。
- 但单独把这条逻辑塞进旧 filter 仍不是完整架构：终末 sanitizer 还会删除 orphan tool、corrupt thinking、synthetic reasoning 等，均可能新制造相邻 thinking；C2/C3 也与空 text 无关。布局验证仍必须保留为终末 invariant pass。
- 推荐顺序不是“让 layout repair 跑在空过滤前，然后结束”。那会让 layout pass 把空块当作无效、可能先重排，随后 filter 再删除并重造 C1；现有终末顺序正是为防后续删除破坏布局，证据见 `/home/xp/src/copilot-api-js/src/lib/anthropic/sanitize/index.ts:154-167`。正确形状是：各删除/改写 pass 在删掉一个块前产生 provenance-aware structural gap，或把候选交给终末布局 pass；终末 pass 一次性做 `replace structural empty → validate/repair C1+C2+C3`，普通空块仍删除。

## Anthropic/GHC assistant content block 类型穷举

### 协议表面

项目类型不是自定义窄 union，而是 re-export `@anthropic-ai/sdk`：`/home/xp/src/copilot-api-js/src/types/api/anthropic.ts:14-39`。锁文件中的 SDK 为 `0.106.0`，其 `ContentBlockParam` 在 `/home/xp/src/copilot-api-js/node_modules/@anthropic-ai/sdk/src/resources/messages/messages.ts:839-873` 共 17 类：`text`、`image`、`document`、`search_result`、`thinking`、`redacted_thinking`、`tool_use`、`tool_result`、`server_tool_use`、`web_search_tool_result`、`web_fetch_tool_result`、`code_execution_tool_result`、`bash_code_execution_tool_result`、`text_editor_code_execution_tool_result`、`tool_search_tool_result`、`container_upload`、`mid_conv_system`。

注意“SDK union 合法”不等于“可放在 assistant 顶层且被 GHC 当前端点接受”。GHC 官方源码 `messagesApi.ts` 的 assistant builder 只自然产出 `text`、`image`、`document`、`thinking`、`redacted_thinking`，再追加 `tool_use`：`/home/xp/src/copilot-api-js/refs/vscode-copilot-chat-upstream/extensions/copilot/src/platform/endpoint/node/messagesApi.ts:314-360,455-560`。`tool_result` 由 Tool role 构造成 user message：同文件 `:364-405`；`tool_reference` 不是顶层 `ContentBlockParam`，只嵌在 `tool_result.content`：同文件 `:428-453`。

### 逐型作为 separator 的判断

| 类型 | 能否作为合成 separator | 结论与证据 |
|---|---|---|
| `text` | 可以，当前唯一已实测可行 | 非空可见 marker 已真上游 200；空/ASCII 空格真上游会被 strip 或拒绝。类型字段最少、无配对关系、无外部资源。|
| `image` | 理论上是 non-thinking，但不应 | 必须提供合法 base64 或 HTTPS source；会把伪造视觉输入喂给模型，token/语义污染远大于短 text。GHC 只从真实用户图像构造它，源码 `messagesApi.ts:467-489`。assistant 角色接受性还需真上游实测。|
| `document` | 理论上是 non-thinking，但不应 | 必须提供 PDF/text/content/URL source；伪造文档是强语义输入且成本高。GHC 只从真实 Document part 构造，源码 `messagesApi.ts:506-517`。assistant 角色接受性未证。|
| `search_result` | 不应 | 需要 `content/source/title`，语义是检索证据；伪造来源和引用会误导模型。SDK 结构见 `messages.ts:1465-1480`；GHC assistant builder 不产出它。|
| `thinking` | 不能 | 它本身属于 C1/C2 受限集合，加入只会增加需要分隔的块；还需有效 signature。|
| `redacted_thinking` | 不能 | 同属 C1/C2 受限集合，还需真实 opaque `data`；伪造会被签名/数据校验拒绝。|
| `tool_use` | 只可复用真实块，不可合成 | 真实内部 tool_use 已实测可作 separator，但消息含 tool_use 必须以 tool_use 收尾 C3；合成一个会制造真实工具调用、要求 tools 定义与后续 user `tool_result` 配对，副作用不可接受。SDK 字段见 `messages.ts:2287-2305`。|
| `tool_result` | 不能放 assistant 顶层 | 协议语义要求它位于 user message。项目自身 server-tool downgrade 注释把 assistant `tool_result` 明确定义为“交换一个 400 为另一个”：`/home/xp/src/copilot-api-js/src/lib/anthropic/sanitize/rewrite-server-tool-blocks.ts:18-25`。|
| `server_tool_use` | 不可合成 | 需要声明对应 server tool、合法 id/name/input；历史残留在 tools 未声明时已知 400：同上文件 `:5-12`。还会触发真实服务器工具语义。|
| `web_search_tool_result` | 不可合成 | 必须与 server tool use 配对且 `encrypted_content` 真实有效；空、缺失、`null`、伪占位均真上游 400，证据 `/home/xp/src/copilot-api-js/exp/encrypted-content-400/README.md:8-23`。|
| `web_fetch_tool_result` | 不可合成 | 要求合法 `tool_use_id` 与 structured fetch result/error，伪造会制造服务器工具历史。SDK 结构见 `messages.ts:2613-2642`。|
| `code_execution_tool_result` | 不可合成 | 同属 server tool result，需要合法配对和执行结果；强语义、副作用、角色约束未知。|
| `bash_code_execution_tool_result` | 不可合成 | 同上。|
| `text_editor_code_execution_tool_result` | 不可合成 | 同上。|
| `tool_search_tool_result` | 不可合成 | 需要 `tool_use_id`，content 只能是规定 error 或 tool-reference result；会伪造工具发现历史。SDK 结构见 `messages.ts:2089-2108`。|
| `container_upload` | 不可合成 | 必须引用真实 `file_id`，否则悬空；且向容器注入文件具有真实语义。SDK 结构见 `messages.ts:821-834`。|
| `mid_conv_system` | 不应，且需真上游验证 | 需要嵌套 text instructions，语义强于普通 text，会把分隔符提升为 system 指令；GHC 当前官方 builder 不产出，后端支持范围未知。SDK 结构见 `messages.ts:1221-1240`。|

`tool_reference`、`web_search_result`、`web_fetch_result` 等名字容易被误认为顶层候选，实际上它们是结果块内部的 nested type，不是顶层 `ContentBlockParam`，不能作为独立 separator。

**类型结论：不应换 block type。** 在所有已知顶层类型中，只有 `text` 没有配对、资源、签名或指令语义；其它类型即使某个模型真上游接受，也会制造比短 text 更严重的语义污染。值得实测的不是“另一个复杂 block”，而是 text 的最小载荷及上游对结构空位的特殊处理。

## “合成标记是否必要”的精确答案

先区分三个概念：

- **合成 block**：原输入没有，新增一个 content block。
- **合成内容**：保留原 block 槽位，但把 `text:""` 改成我方提供的字符。
- **可见 marker**：合成内容采用 `[copilot-api:thinking-separator:v1]` 这类人类可见字面量。

当前事故若采用就地替换，就不需要新增合成 block，但仍需要合成内容；若不可见 Unicode 字符经真上游证明可行，则不需要人类可见 marker；若 GHC 将所有无显示宽度字符都 strip/归一化，则要保全全部 thinking 时仍需要某种可见非空 text。

对一条含 `n` 个 thinking/redacted_thinking 的 assistant 消息，在 C1+C2+C3 同时成立时，若允许重排并保留全部块，**无合成内容的充分必要供给是至少 `n` 个可用真实 non-thinking 块**：`n-1` 个用于内部间隔，另 1 个用于合法收尾；含 `tool_use` 时最后一个 tool_use 正好承担收尾，其余 real block 承担内部间隔。当前实现的测试也显示纯 `[T,T,T]` 需要 2 个内部分隔 + 1 个尾块，共 3 个 marker：`/home/xp/src/copilot-api-js/tests/anthropic/assistant-block-layout.unit.test.ts:34-42`。

因此：

- **不必要**：消息本来合法；或 real non-thinking 供给 `m≥n`，只靠重排即可；或结构空 text 能原样被 GHC 保留并充当边界；或经验证的不可见 text 能替换结构空位；或允许丢弃 thinking。
- **必要**：要求单条 assistant 内保留每个 thinking 原字节与相对序、real non-thinking 供给 `m<n`、空/空白被 GHC 删除，而且没有另一种经 GHC 接受且语义更弱的载体。此时至少需要 `n-m` 个合成 non-thinking 内容位。当前唯一已证载体是非空 text。
- **当前事故**：`[T,empty,T,tool]` 的 block 数已足够，只缺一个能过 GHC 的 text 内容。就地替换把 1 个结构空位升级为 1 个有效分隔位；“删除后新增”在 wire block 数上回到同样形状，但 provenance 更差。

只靠重排覆盖率不能从现有材料给出可信百分比。已有真上游样本同时包含两端：`[T,T,T,text,toolA,toolB]` 有 `m=n=3`，纯重排可零合成；事故 `[T,empty,T,tool]` 在删除 empty 后 `m=1<n=2`，必须补 1 个。4141 最近 159 条 Anthropic 抽样里 marker 为 0、也没有捕获到 `T/empty/T` 请求形状，只能说明该时间窗没有触发，不能外推总体比例。应直接用现有 `blockLayout.{repairedMessages,insertedMarkers}` 做长期分布，而不是猜。

## richest-data-flow ADR 的适用范围

ADR 原文第 33 节说的是“任何往真实数据流注入合成帧”以及“下游消费者（history / log / UI / diff / 运维）”，三条规则又明确用“原始/上游轨”“forwarded/派生轨”描述 response 侧帧：`/home/xp/src/copilot-api-js/docs/decisions/2026-07-05-richest-data-flow.md:33-41`；应用实例也全是 response forwarded SSE 与 client-facing 输出：同文件 `:43-48`。

据此，**该 ADR 的直接规范范围不覆盖发往上游的 request body content block**。它不能作为“wire text 必须人类可见”的依据，也不能禁止不可见 Unicode。它覆盖的是记录/转发轨上合成与真实的 provenance：History 必须能看出“这个 outbound block 是替换/插入的”，原始 client request 必须保持原样。

但 ADR 的上位原则“合成 vs 真实可辨识、原始数据不被派生物覆盖”可以且应该类推到 request 双轨：

- History 的 client-side request 轨保留客户端原始空块；当前 V3 具体可见形状包含 `clientRequest.body/messages`，字段归属以运行时 entry 为准。
- `attempts[].upstreamRequest` 保留实际 wire，包括替换后的 separator。
- `pipelineInfo.sanitization[].blockLayout` 记录 `replacedStructuralEmpty`、`insertedSeparators`、载体版本/类别；必要时增加 block-level derivation，而不是只靠正文猜 provenance。
- marker 的身份识别应由结构化 provenance + 统一 predicate 承担；wire 字符是否可见是协议可靠性与模型污染轴，不是 ADR 的硬要求。

## 是否应该可配置

### 保留的配置轴

1. **布局修复总策略应继续可配**：现有 `assistant_block_layout_strategy: passthrough | move_blocks` 是有价值的。`passthrough` 是精确上游探针/诊断对照，`move_blocks` 是生产修复；schema 见 `/home/xp/src/copilot-api-js/src/lib/config/schema.ts:421-433`。旧 `insert_text` 因与 C3 契约互斥已正确退役，不能复活。
2. **真实行为不同、且无法同时满足的载体策略，只有经 PoC 证明后才值得形成 enum**。例如若 invisible text 在所有目标模型/运行时都稳定 200，可讨论 `separator_representation: visible_marker | invisible_unicode`。在证据出现前加配置只会把未知协议风险下放给用户。
3. **lossy fallback 已由现有 L2/L3 配置承担**：`strip_thinking_on_reject` 与 quarantine 决定上游拒绝后的 strip-all 行为，不应再在 L1 重复发明 `drop_first/drop_all` 轴。

### 不应开放的配置轴

- 不开放任意 separator 字符串。它会破坏统一识别、旧历史兼容、strip-all 清孤儿、日志聚合与测试矩阵；用户还能填空白重新制造 400。当前前缀族 + legacy set 已显示身份迁移成本：`/home/xp/src/copilot-api-js/src/lib/anthropic/sanitize/assistant-block-layout.ts:9-50`。
- 不开放任意 block type。绝大多数类型需要配对/签名/资源，配置错误就是确定性 400 或伪工具副作用。
- 不开放“普通空 text 是否删除”的全局 bool。上游会拒绝普通空块；正确轴是代码中的语义分类：普通空块 drop，结构空位 replace，而不是让用户二选一地破坏其中一条 invariant。
- 不开放 provenance/observability 开关。记录派生事实是架构不变量，不是偏好。

### 配置代价

每新增一个策略值都会与 C1/C2/C3、thinking/redacted、tool/no-tool、retry resanitize、strip-all orphan cleanup、旧 marker 回流、config compat、hot reload、History schema 形成笛卡尔积。项目配置哲学要求旧键/旧值留 compat、warn-and-continue；所以一个试验值一旦发布就有长期迁移成本。这里应当“配置行为差异，不配置内部实现细节”。

**结论：保留现有总策略配置，不新增 separator 文本/block type 配置。** 只有 invisible text 完成真上游矩阵实测并证明存在真实兼容分叉时，再提出一个封闭 enum；若它在支持范围内全面胜出，则直接升级默认并保留旧值 compat，不制造永久双轨。

## 方案矩阵（18 个方案）

| # | 方案 | 机制 | 合成内容 | 可见 | 客户端配合 | 需真上游实测 | 主要风险 | 实施成本 |
|---|---|---|---|---|---|---|---|---|
| 1 | 现状：删空后 `move_blocks` | 全局删 empty，再重排 real block，不足插 visible text | 是 | 是 | 否 | 否，当前形状已证 | 丢 provenance；对上游原生结构空位先破坏后修；marker 污染 prompt | 现有 |
| 2 | **结构空位就地替换 + 终末 invariant repair** | `T/empty/T` 在原槽位替换为 separator，普通 empty 仍删；最后统一修 C1-C3 | 是；不新增 block | 取决于载体 | 否 | visible 载体无需；invisible 需 | 需正确分类结构空位；仍要保留终末 repair | 中 |
| 3 | 布局感知地原样保留 empty | `T/empty/T` 不删，期待 GHC 将它视作边界 | 否 | 否 | 否 | 已有空/空格 400 证伪 | GHC strip 后 C1 重现 | 低，但不可用 |
| 4 | 只靠真实块重排 | 保留全部 thinking，复用 text/tool 等，严格留终结块 | 否 | 否 | 否 | 已证可行 | 仅覆盖 `m≥n`；重排真实语义顺序 | 现有 |
| 5 | 不插任何内容，违规透传 | `passthrough` | 否 | 否 | 否 | 否 | 确定性 400；仅适合诊断 | 现有 |
| 6 | 丢弃最少 thinking | 删除 `n-m` 个 thinking 使 real block 足够 | 否 | 否 | 否 | 已知保留任一单块可 200 | 丢推理签名与上下文；违背保全原则 | 低 |
| 7 | strip-all thinking | L2/L3 式全删后重试/预清洗 | 否 | 否 | 否 | 已证 200 | 最大信息损失；纯 thinking 可能变空 message | 现有兜底 |
| 8 | 合并多个 thinking 为一个 | 拼 plaintext/signature 或选一个 signature | 是/改真块 | 否 | 否 | 不值得 | signature 自包含，不能伪造合并 seal；等价于篡改/丢块 | 高、不可行 |
| 9 | 可见短 text marker | 当前 `[copilot-api:…]` 或更短 sentinel | 是 | 是 | 否 | 当前 marker 已证 | prompt 污染、token、模型可能读到；但可诊断 | 低 |
| 10 | 不可见 Unicode text | U+200B/U+2060/U+2063 等 trim-non-empty code point | 是 | 视觉不可见 | 否；但客户端/JSON需保真 | **是** | GHC Unicode trim/normalize、tokenizer差异、复制清洗；wire 本身难肉眼识别 | 低+探针 |
| 11 | 最小可见标点 | `.`、`·` 等 1 字符 text | 是 | 弱可见 | 否 | 是 | 身份碰撞，模型语义仍有污染，无法仅凭正文可靠识别 | 低+探针 |
| 12 | 连续 assistant 拆消息 | `[assistant:T],[assistant:T]` | 否 | 否 | 否 | 已有 `pb_split3` 真上游证伪 | GHC 合并同 role 后重新相邻；`messagesApi.ts:410-420` 也显示官方先合并同 role | 中、不可用 |
| 13 | 拆消息并插 synthetic user turn | `assistant:T → user:separator → assistant:T` | 是 | 是 | 可能，history role 语义会变 | 是 | 伪造用户发言、破坏 tool pairing/turn 语义，污染远大于 text block | 高 |
| 14 | 复用真实 `tool_use` 作间隔 | 保留最后 tool 收尾，其余 tool 间隔 | 否 | 否 | 否 | 已证 `[T,tool1,T,tool2]` 200 | 只有多 tool 时可用；不可合成调用 | 已在方案 4 |
| 15 | 合成 `tool_use` | 造 no-op tool call + 后续 result | 是 | 客户端可见副作用 | **是** | 即使 200 也不应 | 触发 agent loop/真实工具；C3、tools 定义、配对复杂 | 极高 |
| 16 | 其它合法语义 block | image/document/search/server-tool-result/container/mid-system | 是 | 多数不直接显示但语义强 | 视类型 | 是 | 资源/配对/签名/role 限制；伪造语义远强于 text | 高 |
| 17 | 自定义未知 block / metadata-only | 自造 `separator` type，或给 empty text 加私有字段 | 是 | 否 | 否 | 是 | 严格 schema 很可能 400；metadata 不会阻止 empty text 被 strip | 低探针/不可取 |
| 18 | 上游/客户端协议级结构边界 | 让 GHC 或客户端原生保留“空但有边界”的正式类型/字段 | 无本地污染 | 否 | **是** | 需对端功能 | 当前协议不存在；需外部版本演进 | 外部依赖 |

## 可复跑的最小真上游探针设计（本轮未执行）

### 探针 A：不可见/最小 text 的 GHC 判定

目的不是只看 HTTP 状态，而是同时回答三层问题：字符是否被我方 `.trim()` 删除；是否逐码点到达 wire；GHC 是否接受并真正把它当 non-thinking separator。

建议在 `exp/thinking-terminal-block/probe-separator-codepoints.py` 按现有 `replay-400.py` 范式新增下列脚本。它复用一份含真实有效 thinking signatures 的已导出生产 body，避免伪造签名导致无关 400；服务器必须是非 4141 隔离端口，配置 `assistant_block_layout_strategy: passthrough`，防 layout repair 用当前 marker 掩盖被测字符。脚本只在用户显式批准额度后执行。

```python
#!/usr/bin/env python3
import copy, json, sys, urllib.error, urllib.request

SRC = sys.argv[1]                 # 导出的 entry JSON
PORT = sys.argv[2] if len(sys.argv) > 2 else "4142"
entry = json.load(open(SRC))
base = entry["attempts"][0]["upstreamRequest"]["body"]
# 取现有真实签名块；沿用 replay-400.py 已验证的 msg 28 槽位。
c = base["messages"][28]["content"]
T1, TOOL, T2 = copy.deepcopy(c[0]), copy.deepcopy(c[1]), copy.deepcopy(c[2])

CANDIDATES = {
    "visible-current": "[copilot-api:thinking-separator:v1]",  # 正控，预期 200
    "visible-dot": ".",
    "zwsp-U200B": "​",
    "zwnj-U200C": "‌",
    "word-joiner-U2060": "⁠",
    "invisible-separator-U2063": "⁣",
    "combining-grapheme-joiner-U034F": "͏",
    "mongolian-vowel-separator-U180E": "᠎",
    "braille-blank-U2800": "⠀",
    "nbsp-U00A0": " ",      # 本地 trim 阴控，预期 wire 前被删
    "bom-UFEFF": "﻿",       # 本地 trim 阴控，预期 wire 前被删
    "ascii-space": " ",           # 已知阴控，预期 400/被删
    "empty": "",                  # 已知阴控，预期 400/被删
}

def send(name, text):
    body = copy.deepcopy(base)
    body["stream"] = False
    body["max_tokens"] = min(body.get("max_tokens", 2000), 64)
    body["messages"][28]["content"] = [T1, {"type":"text", "text":text}, T2, TOOL]
    # 与 replay-400.py 一样删除代理会重复注入的工具定义，避免 Tool names must be unique 干扰。
    injected = {"Grep", "KillShell", "tool_search_tool_regex", "Glob", "Task"}
    body["tools"] = [t for t in body.get("tools", []) if t.get("name") not in injected]
    req = urllib.request.Request(
        f"http://localhost:{PORT}/v1/messages",
        data=json.dumps(body, ensure_ascii=False).encode(),
        headers={"content-type":"application/json", "anthropic-version":"2023-06-01", "x-probe-case":name},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            print(name, "HTTP", r.status, "trim_len", len(text.strip()), "codepoints", [f"U+{ord(ch):04X}" for ch in text])
    except urllib.error.HTTPError as e:
        print(name, "HTTP", e.code, e.read().decode()[:240])

for name, text in CANDIDATES.items():
    send(name, text)
```

本轮轻量本地事实探针（未请求上游）已经测得 Bun/JS `trim()`：U+00A0、U+FEFF 被 trim 到长度 0；U+200B、U+200C、U+2060、U+2063、U+180E、U+034F、U+2800 的 trim 长度均为 1。因此前两者只能当本地阴控，后七者才会抵达当前 wire。

**必须补的独立 wire oracle**：每发一例后从隔离服务器对应 History entry 的 `attempts[0].upstreamRequest.body.messages[28].content[1].text` 读回，逐 code point 断言等于候选。HTTP 200 但 wire 字符不等，说明代理或 JSON 层改写，不能归因 GHC；wire 相等 + 200 才证明 GHC 接受。

**成功判据**：

1. `visible-current` wire 相等且 200，证明 harness 触达已知正样本。
2. `empty`/`ascii-space` 得到已知 400 或在 wire oracle 中明确被本地删除，证明阴性对照会咬。
3. 某 invisible candidate 在 opus/sonnet/haiku 各目标后端、stream true/false、至少 3 次重复中 wire 逐码点相等且全部 200；同 payload 去掉候选立即回到 C1 400。最后一条 mutation 是证明“200 确实由 separator 生效”，不能只信一次 200。
4. 再做 client round-trip oracle：真实 `@anthropic-ai/sdk`/Claude Code 保存并回放后，字符逐码点仍存在；若客户端 NFC/清洗掉，它不能替代持久 marker。
5. 模型输出不得把字符渲染成 replacement glyph，也不得在 usage/token 计量上出现异常放大。

只有满足全部五项，才可把 invisible text 从实验候选升级为生产载体。单模型一次 200 不足以改默认。

### 探针 B：连续 assistant 消息

这一项其实已有真上游结论，不再是未知：`pb_split3` 把 3 个 thinking 拆成 3 条连续 assistant，GHC 折叠回 `[T,T,T]` 后仍 400：`/home/xp/src/copilot-api-js/docs/spec/2026-07-07-thinking-signature-quarantine.md:18-23`。GHC 官方 builder 也主动合并相邻同 role：`messagesApi.ts:410-420`。

若要做回归性复跑，在同一脚本增加：

```python
# 用一条已知失败 assistant turn 替换成三条连续 assistant；后接原 user tool_result。
msgs = body["messages"]
original = msgs[28]
msgs[28:29] = [
    {"role":"assistant", "content":[T1]},
    {"role":"assistant", "content":[T2]},
    {"role":"assistant", "content":[TOOL]},
]
```

预期：wire oracle 证明三条确实出我方代理后，GHC 仍返回 C1 400。若未来变成 200，才说明 GHC 合并行为改变；在此之前拆消息已被证伪，不应列为候选实现。

### 探针 C：metadata-only 空 text 与自定义 block

为彻底排除“无需字符、只加 metadata”可加两例：`{"type":"text","text":"","cache_control":{"type":"ephemeral"}}` 与 `{"type":"separator"}`。预期前者仍被本地 filter 删除或被 GHC 判 empty，后者 strict schema 400。两者都必须先做 wire oracle；即使某后端接受未知 type，也不能直接采纳，因为跨模型兼容与 SDK 客户端 round-trip 未证。

### 探针 D：角色级 synthetic user 隔离

仅作解空间边界，不作推荐：把 `[T,T]` 改成 `assistant[T] → user[text:"[separator]"] → assistant[T]`，保证前后仍有合法 user/tool pairing。若 GHC 200，证明角色边界可隔离；但它伪造用户发言，语义污染显著大于 assistant 内 text，故“200”只代表可行，不代表应采用。

## 丢弃 thinking 的代价

现有实测证明每个 signature 自包含、非位置绑定：重排后其余块仍 200，见 `/home/xp/src/copilot-api-js/exp/thinking-signature-quarantine/README.md:73-93`。因此“删一个 thinking 会让剩余 signature 链全部失效”不是事实；删除在密码学结构上可行。

代价仍然不可接受为主路径：

- 丢失该块携带的推理上下文，可能改变模型对既有决定、工具调用与后续回答的理解。
- `redacted_thinking` 虽不可读，仍是模型后续上下文的一部分，不能用“人看不见”推导“无价值”。
- 纯 `[T]` 删除后留下 `content:[]`；现有 L2 明确有这个未闭合缺口：`/home/xp/src/copilot-api-js/docs/spec/2026-07-26-thinking-terminal-block-layout.md:137-142`。要继续修就得删除整条 assistant，再处理相邻同 role 与 tool_result 引用，损失会级联。
- 项目已决定 L1 保留全部 thinking，L2/L3 strip-all 只作上游已拒绝后的恢复兜底。没有新用户裁决，不应倒退。

## 推荐架构（待主会话/用户确认的 ADR 草案）

### 推荐顺序

1. **把“结构空 text”从普通垃圾空块中分类出来，并就地替换。** 判据至少是 assistant array 中被两个 thinking/redacted_thinking 夹住的 trim-empty text；替换在原 block index 发生，不移动周围真实块。事故 `[T,empty,T,tool]` 直接变 `[T,SEP,T,tool]`。
2. **保留终末 `repairAssistantBlockLayout`，但让它接收 provenance-aware 结果。** 它继续兜住客户端原生 `[T,T]`、orphan 删除新生 adjacency、单 `[T]` 的 C2、无 thinking 的 C3；先复用真实块，最后才补 synthetic separator。
3. **短期载体继续用已实测的 visible versioned text family。** 这是当前唯一真上游证实的载体，不因审美直接换未知 Unicode。
4. **立独立 PoC 验证 invisible Unicode。** 若通过跨模型、mutation、wire、client round-trip 五门，推荐把 emitter 升级为最小 invisible text，同时保留旧 visible prefix 识别与 compat；History 用结构化 provenance 显示，不靠肉眼 marker。若任何一门失败，维持 visible marker。
5. **补 request-side provenance。** 在 sanitization stats 区分 `replacedStructuralEmpty` 与 `insertedSeparators`，并确保 clientRequest 原始轨与 upstreamRequest effective 轨都完整。若未来需要精确 diff，再引入 block-level derivation；不能把“wire 可见 marker”当作唯一 provenance。
6. **保留现有配置面，不新增自由字符串/type 旋钮。** `passthrough|move_blocks` 足以表达“诊断原样 vs 生产修复”；invisible 候选在证据闭合前不发布配置。

### 为什么这是长远正确而不是局部补丁

- 它修的是信息丢失边界：删除 pass 不再先抹掉“这里原本有结构槽位”这个事实。
- 它没有把特例硬塞进上游协议：普通空 block 仍按原安全网删除，C1-C3 仍由统一终末 invariant pass 保证。
- 它把协议载体与可观测身份解耦：wire 选择最可靠、最小语义的字符；History 选择结构化 provenance。ADR 要的是可辨识，不是用户必须看见一串 marker。
- 它不牺牲 thinking，也不伪造 tool/user/system 语义；对已有 marker family 与旧配置留兼容。

### 未采纳方案及原因

- **维持现状**：功能上能 200，但先丢 provenance 再补 block，无法解释合成来源，不是最优架构。
- **全局不删 empty**：普通 empty 已知会被上游拒绝，修一个事故会放开更大 400 面。
- **换复杂 block type**：没有一种比 text 语义更弱；配对、资源、签名、角色约束只会增加新失败面。
- **丢 thinking**：签名技术上可独立，但信息损失与空消息级联违背主路径保全目标。
- **拆连续 assistant**：已被 GHC 折叠实测证伪。
- **伪造 user/tool/system**：可能构造 200，但语义污染和客户端副作用远重于一个 text。
- **立即切 zero-width**：本地 `.trim()` 可通过不等于 GHC/客户端保真；没有真上游 PoC 就改默认是猜测。

## 证据等级总表

### 已实测或本轮亲手只读观测

- C1/C2/C3、visible marker 200、empty/space 400、真实 block interleave 200、split3 400：项目保存的真上游 PoC 结果，权威路径 `docs/spec/2026-07-07-thinking-signature-quarantine.md` 与 `docs/spec/2026-07-26-thinking-terminal-block-layout.md`。
- 4141 最近样本中的 keepalive 是 synthetic ping，空 `content_block_start` 无 synthetic 且最终均有非空 delta：本轮只读 History API 抽样 159 条 Anthropic entries。
- JS `.trim()` 对候选 Unicode 的分类：本轮 Bun 本地探针；仅证明本地 sanitizer 行为，不证明 GHC。
- `filterEmptyAnthropicTextBlocks` 的原始理由：git history + 当前代码与测试。

### 从代码/类型推断，尚非 GHC 接受性证明

- 17 类 SDK `ContentBlockParam` 的完整 union。
- tool_result 的 user-role 约束、server-tool 配对与资源型 block 的字段/语义成本。
- 就地替换比先删后补保留更多 provenance；终末 invariant pass 仍需保留。
- ADR 直接范围是记录/转发轨，不直接命令 upstream request wire 可见。

### 必须打真上游才能定

- U+200B/U+200C/U+2060/U+2063/U+034F/U+180E/U+2800 哪些会被 GHC 归一化或视为有效 text。
- 这些字符是否跨 opus/sonnet/haiku、stream/non-stream 与客户端 round-trip 稳定。
- metadata-only 空 text、自定义未知 block、synthetic user 隔离在当前 GHC 的精确接受性；后二者即使 200 也不推荐。

## 最终结论

本报告穷举 **18 个方案**。推荐“**结构空 text 就地替换 + 终末 C1/C2/C3 invariant repair + 结构化 provenance**”；当前继续使用已证的 visible versioned text，另以真上游 PoC 决定是否升级为 invisible Unicode。合成 block 并非总是必要，但在 real separator 不足且必须保全全部 thinking 时，合成 non-thinking 内容不可避免；richest-data-flow ADR 要求记录层可辨识，不要求 upstream wire 的文字必须肉眼可见。
