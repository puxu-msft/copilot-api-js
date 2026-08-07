# Anthropic ↔ Responses thinking 与整体翻译路径审计

> 状态：已独立复核，可作为修复 spec 的事实输入；不是已批准的实施 spec
> 审计对象：master squash commit `192dce69f1bf482b1c3130d519991594a3fe46ab`
> 复核：代码事实／协议 oracle 逐项复验通过；架构／实施走查终审无新增 finding（2026-08-06）
> 报告落盘基线：`285dc571ed6cd12fc7b5641d719da5516a724646`（`192dce69` 的 4 个后续提交还触及其它非审计路径；在本审计范围内，翻译代码、测试、RFC、ADR 均未变，相关活文档中仅 `docs/DESIGN.md` 有变化）
> 日期：2026-08-06

## 结论

**整体翻译路径目前不恰当，也不全面。** 用户主动从 Claude 模型切到 Responses 模型时，丢弃真实 Claude/source-signed thinking 的方向是正确的；本次修复把逐块 WARN 收敛成请求级 INFO、把 unsigned 异常保留为请求级 WARN，也正确。但 direct bridge 的其它路径仍有一个官方客户端协议 BLOCKER、多个可复现的 round-trip 数据损失、Scenario B 配置漏接、server-tool 历史丢失和顶层能力静默裁剪。因此当前实现不能继续宣称“anthropic↔responses per-pair 无损桥”或“reasoning 全链路完整 round-trip”。

### 当前正确的边界

1. `src/lib/openai/translate/anthropic-to-responses-request.ts:231-275` 能区分我方 synthetic sentinel 与真实 Claude/source-signed signature：前者重建 Responses reasoning，后者在跨协议/跨模型边界丢弃并记录 degradation。
2. 正常 source-signed-only 切换只产生一次 INFO，不产生该类 WARN；unsigned thinking 仍产生请求级 WARN。focused tests、exact-patch callback mutation 与真实 183-block History payload 已验证这一点。
3. 单个、带 summary 的 Responses reasoning item 在非流式和流式 happy path 可转成 Anthropic thinking，并可通过 sentinel 回流。
4. 流式 encrypted-only reasoning 在合法 `output_item.added → output_item.done` 生命周期下可保留为空 thinking + signature；真实 Anthropic SDK 能解析。
5. Anthropic→Anthropic direct cell 不经过 Anthropic→Responses translator，本次 source-signed 丢弃不会误伤同模型 Claude 工具续轮。
6. 基础 user text/image、普通 custom `tool_use`/`tool_result`、工具声明与匹配的 `tool_choice` 有直接单测和 codec/driver 接线测试。

## 已确认缺陷

### P0 BLOCKER：Anthropic→Responses 流式事件序列不符合官方 OpenAI SDK 生命周期

**位置：** `src/lib/openai/translate/anthropic-to-responses-stream.ts:246-359`

- text block 直接发送 `response.content_part.added`，此前没有对应的 `response.output_item.added` message item。
- reasoning item 初始化为 `summary: []`，随后直接发送 `response.reasoning_summary_text.delta`，此前没有 `response.reasoning_summary_part.added`。
- 官方 OpenAI SDK 6.45.0（`bun.lock:1784`）的 `ResponseAccumulator` 要求 `response.output_item.added` 先建立 output；`response.content_part.added`、`response.reasoning_summary_text.delta` 再按 index 读取该 output/summary part。权威源码：`node_modules/openai/src/lib/responses/ResponseAccumulator.ts:16-43,78-85,179-199`。
- 独立 reviewer 用官方 OpenAI SDK 实测：text 路径报 `missing output at index 0`；reasoning 路径报 `missing content at index 0`。项目现有自有 accumulator 较宽松，因而相关 62 条测试全绿仍是假绿。

**影响：** Anthropic client→Responses-compatible client 的流式翻译产物不能被官方客户端可靠消费，属于客户端协议 blocker。

**修复方向：** 按官方 lifecycle 完整补齐 message `response.output_item.added/done`、text `response.content_part.added/done`、reasoning `response.reasoning_summary_part.added/done`，并保留其间 delta；新增官方 OpenAI SDK accumulator oracle，项目自有 accumulator 不能继续作为唯一 oracle。

### P1 MAJOR：两向 request translator 都把有序 block/item 压成固定 turn 顺序

**位置：** `src/lib/openai/translate/anthropic-to-responses-request.ts:214-255`、`src/lib/openai/translate/responses-to-anthropic-request.ts:163-176,200-275`

- 前向实现把所有 text 收进 `textParts`，最后生成一个 message 并 `unshift` 到所有 function call 前。输入 `[tool_use("t1"), text("after")]` 会变成 `[assistant message("after"), function_call("t1")]`；`[text, tool_use, text]` 也会把两段 text 合并到 tool 前。代码注释声称“block order preserved”，与实际行为矛盾。
- 反向 fold 同样分别累计 `thinking`、`textParts`、`toolUse`，flush 时固定输出 `thinking→text→tool_use`。flat input `function_call→assistant message` 会被改写成 `text→tool_use`。

**影响：** 两向都改变文本与工具调用的相对语义，尤其影响有状态 agent history、工具调用前后说明和 interleaved block。

**修复方向：** 两向 request translator 共用一个显式 ordered-turn 模型；按源 block/item 顺序发射，仅 reasoning 必须前置这一规则在取得协议证据后作为显式、受测的例外，不能从“thinking first”泛化出 text/tool 可任意重排。补双向 `tool→text`、`text→tool→text`、多工具交错的正反样本。

### P1 MAJOR：server-tool 四格均未闭合

**位置：** `src/lib/openai/translate/anthropic-to-responses-request.ts:243-249,278-305`；`src/lib/openai/translate/anthropic-to-responses-stream.ts:287-291`；`src/lib/openai/translate/anthropic-to-responses.ts:113-136`

按“历史请求 vs live response”×“stream vs non-stream”核对：

| 格 | 当前行为 |
|---|---|
| 历史 assistant `server_tool_use` | request translator 仅 WARN 后丢弃 |
| 历史 user `web_search_tool_result` / `*_tool_result` | request translator default 静默丢弃 |
| live streaming Claude response | stream translator 标成 drop |
| live non-stream Claude response | non-stream response translator default 静默丢弃 |

最小配对 probe `server_tool_use(web_search)` + `web_search_tool_result` 得到空 Responses input。S2 先翻译、S3 对 Anthropic→Responses cell 明确 `requestRewrites()=[]`，所以 sanitize 不会在 translator 前替它降级；见 `src/lib/pipeline/driver.ts:367-403`、`src/lib/codec/openai-responses/openai-responses-cell.ts:88-113`。冻结 RFC `docs/rfc/2026-07-14-anthropic-responses-direct-bridge.md:180-196` 要求 server-tool 结果“永远降级为普通 tool_use/text”，不是整块删除。

**影响：** 带 server-tool 历史的多轮请求和 Claude live response 都可能丢失查询、状态、结果与关联 ID，破坏会话连续性。

**修复方向：** 四格一次对账：合法可表达处保留结构；无法表示的 result 保留关联 ID 并降级为可读 text；绝不合成 `web_search_tool_result`（R-NO-REVIVE）。候选包括 function-call 配对、可读 text 降级、opaque extension；推荐“合法处保结构，无法表示的结果带关联 ID 降级为 text”。补配对、孤儿、错误、image/result 与 stream/non-stream 回送测试。

### P1 MAJOR：Scenario B 只接到两向 response renderer，漏了两向下一轮 request consumer

**位置：** `src/lib/config/model-translation.ts:62-70`、`src/lib/codec/anthropic/codec.ts:359-361`、`src/lib/codec/openai-responses/codec.ts:195-207`、`src/lib/pipeline/hub-translate.ts:148-153`、`src/lib/openai/translate/anthropic-to-responses-request.ts:92-99,268-275`、`src/lib/openai/translate/responses-to-anthropic-request.ts:221-236,302-312`

RFC `docs/rfc/2026-07-14-anthropic-responses-direct-bridge.md:162-165` 与 ADR `docs/decisions/2026-07-14-lossless-per-pair-bridge.md:30-33` 定义：同格式跨模型切换时，Scenario B 应剥历史 carrier 中旧 opaque state、保留 summary。实际两个 codec 都计算 pair policy，但只传给 response renderer：

- Anthropic client→Responses model：现有历史 synthetic sentinel 仍在下一 request 无条件恢复旧 `encrypted_content`。
- Responses client→Claude model：现有历史 Claude carrier 仍在下一 request 无条件解出旧 Claude signature，可能送给新 Claude 模型。

前向最小 probe：配置目标 pair 为 `features:["strip-thinking-signature"]`，输入 `buildSyntheticReasoningSignature("OLD-MODEL-ENCRYPTED")`，request 输出仍含 `encrypted_content:"OLD-MODEL-ENCRYPTED"`；开关 on/off 字节相同。反向 `reconstructThinkingBlock()` 同样没有 pair-policy 参数。现有测试只覆盖 config→response renderer，未覆盖两向 request wire。

**真实 GHC 对照的边界：** 2026-08-06 用隔离服务器、真实 `gpt-5.4-mini` 与 `gpt-5.6-sol` 做四组回放（同模型/跨模型 × 带密文/无密文），四组均 HTTP 200，均输出 `UNKNOWN`。这推翻 RFC 的“跨模型旧密文必被拒/必然 400”机制故事；但同模型正控也未恢复隐藏计算，故探针对“密文语义是否可移植”无鉴别力。当前 confirmed defect 是**实现违反已冻结配置契约**，现实风险应表述为“旧模型 opaque state 未按声明剥离，语义/token 影响未证”，不能再声称“必然 400”。

**修复方向：** 路由完成后只解析一次 pair policy，并把同一 policy 同时传给两向 request consumers、stream renderers 与 non-stream renderers；Scenario B 保留 summary、删除 synthetic `encrypted_content` 或 Claude carrier。两个 ingress 都补真实 driver request-wire on/off 双控，避免四调用点再次漂移。

### P1 MAJOR：多个 reasoning item 被压成单槽，文本与密文错配

**非流式位置：** `src/lib/openai/translate/responses-to-anthropic.ts:163-173,210-218`

全局仅有 `reasoningText` 和 `reasoningEncrypted`。两个 item `A/ENC-A`、`B/ENC-B` 会生成一个 thinking：`thinking="AB"`，signature 只封装 `ENC-B`；`ENC-A` 丢失，展示文本和签名来源不一致。

**流式位置：** `src/lib/openai/translate/responses-to-anthropic-stream.ts:129-190,228-295`

thinking open block 与 `reasoningEncrypted` 同样是全局单槽。连续两个 reasoning output_index 实测只生成一个 thinking，summary 串为 `AB`，carrier 只保留 `ENC-B`。

**修复方向：** 每个 reasoning item/output_index 独立维护 summary、encrypted carrier 和 block lifecycle；每项生成独立前置 thinking。添加多 reasoning item 的 non-stream/stream/SDK round-trip 测试。

### P1 MAJOR：non-streaming encrypted-only reasoning 被整体丢弃

**位置：** `src/lib/openai/translate/responses-to-anthropic.ts:164-173,210-218`

只有 `reasoningText.length > 0` 才生成 thinking。真实 GHC `gpt-5.4-mini` 已观测到合法 reasoning item 为 `summary:[]`、非空 `encrypted_content`；非流式 translator 会把它完全丢掉。流式路径在 `.added` 打开空 thinking、`.done` 捕密文，能够保留，因此两路径分叉。

**修复方向：** 以“summary 非空或 encrypted_content 存在”为生成条件；补真实 GHC encrypted-only fixture 和 stream/non-stream parity oracle。

### P1 MAJOR：Responses→Anthropic 流式 function arguments 只信 delta，合法无-delta 流得到空 input

**位置：** `src/lib/openai/translate/responses-to-anthropic-stream.ts:228-253,274-295,327-340`

function call 在 `response.output_item.added` 打开 tool_use，输入只由 `response.function_call_arguments.delta` 生成；`.added`/`.done` 中的完整 `arguments` 未作 authoritative fallback。合法 added+done、无 delta 流实测得到空 `tool_use.input`。

**修复方向：** 以 `.done.arguments` 为权威 fallback，存在 delta 时校验两者一致；补无-delta、分片 delta、冲突 delta/done 三类测试。

### P1 MAJOR：Anthropic→Responses 流式 incomplete 仍发 `response.completed`

**位置：** `src/lib/openai/translate/anthropic-to-responses-stream.ts:482-501`

flush 无论最终映射 status 是 `completed` 还是 `incomplete`，事件名恒为 `response.completed`。`max_tokens`、`pause_turn`、`refusal` 等客户端订阅不到 `response.incomplete`，event type 与 payload status 自相矛盾。

**修复方向：** 按最终 status 发对应 terminal lifecycle event，并用官方 OpenAI SDK/事件订阅测试终止语义。

### P1 MAJOR：顶层能力映射与有损诊断不完整

**前向位置：** `src/lib/openai/translate/anthropic-to-responses-request.ts:150-167`；**反向位置：** `src/lib/openai/translate/responses-to-anthropic-request.ts:122-140`

- `top_k`、`stop_sequences`、Anthropic block/tool `cache_control` 确无直接 Responses 等价，当前只能丢，但没有结构化 degradation。
- Anthropic `output_config.format` 是用户可观察的结构化输出契约；Responses 已有 `text.format`（`src/types/api/openai-responses.ts:104-114,150`），当前直接桥静默丢失。两边 schema 不完全同形（Responses json_schema 需要 name），应设计稳定命名/映射或明确诊断，而不是用注释冒充处理。
- 两端都有 `context_management` 字段，但策略 schema 可能不兼容；当前前向注释一概称“Anthropic/GHC-only”、反向一概称“Responses-only”，没有逐策略映射表或诊断。
- 反向 Responses `text.format` 同样没有映射到 Anthropic `output_config.format`，且无测试。
- 项目已有可复用模式 `src/lib/openai/translate/cc-to-responses.ts:23-27,53-96` 的 `TranslateResult.droppedParams`；direct bridge 没有统一诊断，形成同类实现一条可观测、一条静默的结构怪味。

**修复方向：** 建立 per-pair 顶层能力映射表与单一 degradation schema；每个字段明确 mapped/dropped/unsupported reason。优先设计 structured outputs 双向映射和 context-management 策略映射；不可表达字段按请求汇总一次，不逐字段刷屏。

## 其它 confirmed 缺口

### P2：carrier decoder 的 base64url 校验过宽，但两方向后果不同

`src/lib/anthropic/claude-signature-carrier.ts:52-60` 与 `src/lib/anthropic/synthetic-reasoning.ts:59-67` 都依赖 `Buffer.from(payload,"base64url")` 抛错判断损坏；Node/Bun decoder 会宽松接受部分非法字符。

- Claude-signature carrier 解码后会成为裸 Claude signature并抵达 Anthropic 上游；乱码可触发可避免的 signature 400，这条因果已有实测边界支持。
- synthetic-reasoning carrier 解码后回到 Responses `encrypted_content`；本轮 live probe只证明 Responses 不因旧/任意密文必然400，未证明损坏 synthetic carrier 会400，不能把 Claude 方向的后果泛化到它。

两者都应在解码前校验 base64url 字符/长度并 canonical re-encode 比对，并记录 degradation；但测试和严重度按方向分开。现有“corrupt carrier 不抛”测试不能区分安全拒绝与乱码接受。

### P2：stream usage 详情和 output item ID 保真不足

- `src/lib/openai/translate/responses-to-anthropic-stream.ts:382-394` 的最终 `message_delta.usage` 丢 `output_tokens_details`/thinking token 详情，和非流式不一致。
- `src/lib/openai/translate/anthropic-to-responses-stream.ts:425-462` 多个 text block 使用同一 `ctx.itemId`，不满足多个 Responses output item 的 ID 唯一性。

### P2：redacted_thinking 丢弃不可观测

`src/lib/openai/translate/anthropic-to-responses-request.ts:238-241` 在跨模型边界丢 `redacted_thinking` 的语义与官方当前规则一致，但 `PipelineInfo.translation.anthropicToResponses` 只统计 source-signed/unsigned regular thinking，不记录 redacted 数量。无法从 History 区分“请求没有 redacted”与“translator 丢了 N 个 redacted”。

### P2：History 诊断只测内存投影，没有 V3 落盘/API 读回

`tests/anthropic/anthropic-codec-forward-leg.it.test.ts:140-162` 在 `inspectRequest(...,"translate")` 止步；`tests/context/request-buffered-merge-info.unit.test.ts:45-79` 只断言 `RequestContext.toHistoryEntry()`。`src/lib/history/v3/projection.ts:352-386` 有通用 metadata 投影，但没有 `translation.anthropicToResponses` 的 terminal-store→History API 集成测试。

### P2：活文档有配置键和“已接线”漂移，修复文档归属需完整对账

`docs/DESIGN.md:90` 写 `model_translations`（复数）并夹带 `model_overrides` 重命名叙述；真实 schema 是 `model_mappings` 与单数 `model_translation`，见 `src/lib/config/schema.ts:1411-1425`。同一行称两场景 Phase 5 已接线，但 Scenario B 两向 request consumer 实际缺失；`docs/DESIGN.md:376` 也只列两 codec response-side `reasoningRoundTripOpts`，不能支持 request 闭环。

修复时不应把历史完成计划改写成“从未完成”：

- 新建修复 spec/plan 作为执行真相源。
- `docs/DESIGN.md` 更新当前态与可见边界。
- `docs/plan/2026-07-14-anthropic-responses-direct-bridge/plan.md` 保留完成叙事，但追加已发现缺陷和新修复 spec 指针。
- `docs/todo/deferred-backlog.md` 对既有 via-responses、reverse server-tool 债项做迁入/关闭 disposition，避免双待办。
- History `PipelineInfo.translation` schema 与 API readback 契约同步到正式 History 文档，不只留在本审计报告。
- ADR 只在用户重裁后修改；Scenario B 自动判定、structured-output 命名与 context-management 兼容表均不得由 implementer自行决定。

### 邻接缺口：Anthropic→Anthropic 直连模型切换没有主动 strip

官方当前 Thinking 文档要求任意模型切换时剥 prior assistant 的 `thinking` 与 `redacted_thinking`；其他模型虽静默忽略，但 ignored blocks 仍计入 input token。同模型工具续轮则必须完整原样回送 assistant content，过滤 `redacted_thinking` 会 400。项目现有 L1 只修布局，L2/L3 只在 rejection/已知 quarantine 时 strip，没有 session→last-model 索引或 direct-pair feature 识别 Claude→Claude 模型切换。该缺口不属于 Anthropic↔Responses translator 本体，但属于“整体模型切换 thinking 处理”未全面。

## 测试类型审计

除负样本外，修复前必须建立以下 false-red 正控：

- 同模型 Anthropic direct 工具续轮完整 assistant content（含 source-signed thinking、`redacted_thinking`、text、tool_use）字节与相对序原样穿过 sanitize/wire；共享 model-switch policy 不得误剥。
- Scenario A 两向 request carrier 保留正控；Scenario B 两向只剥 opaque carrier、summary 仍在。
- 官方 OpenAI SDK 对正确完整 lifecycle 的正样本；真实 Anthropic SDK 对 encrypted-only 与多 thinking 的正样本。
- 每个新 oracle 都要有目标 mutation：删 output-item/summary-part added、去掉 pair-policy callback、退回单槽 reasoning、忽略 `.done.arguments` 后必须精确变红。

| 行为 | 当前测试 | 真相域判断 | 缺口 |
|---|---|---|---|
| 纯 block/item 映射 | unit | 合适 | 缺顺序交错、server-tool 历史、多个 reasoning、encrypted-only、structured output |
| codec/cell callback 与 request wire | `.it` inspect | 接线真相域基本合适 | Scenario B 未穿到 forward request；无真实 prepare-wire on/off 双控 |
| History degradation | context unit + inspect | 只证明内存对象 | 缺 V3 terminal store/API readback |
| Anthropic→Responses stream | 项目自有 accumulator | oracle 同源且过宽 | 必须加入官方 OpenAI SDK accumulator |
| Responses→Anthropic stream | unit +部分 Anthropic SDK | 层级正确 | 缺多个 reasoning、encrypted-only、无-delta args、incomplete terminal |
| reasoning carrier | 同源 encode/decode unit + 旧真 GHC探针 | 编解码测试必要但不充分 | 缺跨模型语义 oracle；本轮 live 对照只证“不 400”，未证可移植 |

## 外部契约与 live probe

### 官方 Anthropic Thinking 契约

当前官方文档确认：

1. 同一 assistant 工具回合必须把完整 `content` 原样回送；每个 `thinking`/`redacted_thinking` 都不能编辑、重排或部分删除。
2. `thinking` 文本为空但 signature 存在是合法 omitted-display 形态，仍须原样回送。
3. 任意模型切换时应剥 prior assistant 的 `thinking` 与 `redacted_thinking`；其它模型会静默忽略，但 ignored blocks 仍增加 input tokens。

本项目 source-signed Claude→Responses 丢弃符合第 3 条；本项目同模型 Claude direct sanitize 不得无条件复用这一丢弃，必须尊重第 1 条。

### 2026-08-06 真实 GHC Responses A/B 对照

环境：commit `192dce69` 的 `git archive` 导出；非 4141 端口 `56235`；独立 `XDG_DATA_HOME`/History；复制真实 token/config；确认无 hooks upstream module；测试后端口释放且 4141 healthy。可复跑脚本与边界说明见 `exp/thinking-cross-model-reasoning/README.md`、`probe.py`；当次脱敏输出与 provenance 见 `observed-2026-08-06.json`。资产不含 token 或真实密文正文。

1. `gpt-5.4-mini` 生成真实 encrypted-only reasoning（`summary:[]`、非空 `encrypted_content`）和答案 `323`。
2. 四组续接：A→A 带密文、A→A 无密文、A→`gpt-5.6-sol` 带 A 密文、A→B 无密文。
3. 四组均 HTTP 200、均返回 `UNKNOWN`。

**它证明了什么：** GHC Responses 当前不会因为回喂跨模型旧 `encrypted_content` 而必然 400；RFC 的“必被拒”解释不成立。

**它没有证明什么：** 同模型正控也不能读取隐藏计算，因此该 prompt/oracle 对“密文是否恢复语义”没有鉴别力；不能据此宣称跨模型密文可移植，也不能宣称剥除无影响。

## 修复顺序建议

1. **P0/P1a 同批：先建立 protocol-neutral keyed `PerOutputItemState`/item ledger，再由每个方向的独立 emitter 发各自协议。** 两条 stream translator 的 per-item 身份、summary/encrypted/arguments 权威值和终态不变量可以共享；wire emitter 不能共享——一条发 Responses lifecycle，另一条发 Anthropic block lifecycle。non-stream reasoning renderer 应消费同一 per-item 映射核心，或至少受严格 stream/non-stream parity oracle 约束。Responses emitter 必须完整发出 message `output_item.added/done`、text `content_part.added/done`、reasoning `reasoning_summary_part.added/done`，并按终态发 completed/incomplete；Anthropic emitter 独立负责 content_block start/delta/stop 与 message_delta/message_stop。先逐事件补丁、再改 keyed ledger 会返工并留下接缝。把官方 OpenAI SDK accumulator纳入回归，但不要把 SDK accumulator误当生产 emitter。
2. **P1b：两向 request translator 改成共享 ordered-turn 模型，同时闭合 server-tool 四格。** 顺序与 server-tool 都依赖 flat items↔turn/block 的状态模型，宜统一设计而非补单点 if。
3. **P1c：路由后单次解析 Scenario B pair policy，四腿共同消费。** 删掉 RFC 的“必然400”机制性解释，保留“按用户声明剥 opaque state”的契约，并做两 ingress 的 request-wire on/off 双控。
4. **P1d：建立双向顶层 capability mapping/degradation table。** structured-output 的稳定 schema name、context-management 策略兼容表和公共 degradation schema 都改变对外契约，须在 spec 中列选项并由用户确认；不可在 implementer 阶段自行拍板。
5. **P2：严格 carrier decoder、usage/details、redacted/History 可观测性和 docs 同步。** 完成 plan 保留历史叙事并加指向修复 spec 的勘误；DESIGN 写当前态；backlog 做迁入/关闭对账；History schema/API readback 契约同步到正式 History 文档。

### 需用户/ADR裁决的邻接分叉：Anthropic→Anthropic model switch

已接受 ADR 选择显式 per-pair 配置；主动自动判定会改变这项裁决，不得直接列入 implementer 执行序列。可行方案：

- A：维持手工 pair 配置，不自动判定。
- B：carrier v2 携 source-model provenance，request 时与目标模型比较。
- C：维护 session→last-model 状态。
- D：provenance 自动判定，显式配置兜底 legacy/external carrier。

推荐 D：它把模型来源放在每个 carrier 本身，能处理并发分支、重放和 session 复用；C 的 session 全局状态会被这些场景污染。采用 B/D 会扩展 carrier wire 契约并收窄/重裁 ADR，必须由用户决定。无论选哪种，同模型 Anthropic 工具续轮“完整 content 原样回送”的正控必须先建立，禁止共享 strip policy 误伤同模型签名与 `redacted_thinking`。

## 结构怪味与处置

- 两向 request translators：**有序 block/item 被压成固定 turn 顺序**；本轮应建立共享 ordered-turn 模型，不能只修一向或记 backlog。
- 两条 stream translators + non-stream reasoning renderer：**多 item 状态压成单槽，且 lifecycle/terminal/args 分散实现**；本轮应先重塑为 protocol-neutral keyed item ledger，并保留每协议独立 emitter；non-stream 消费同一映射核心或由 parity oracle 约束，不逐事件打补丁。
- `src/lib/config/model-translation.ts` + 两 codec：**配置只接两向生成侧、两向消费侧漏接**；修在路由后单次解析的共享 pair-policy 流，不在某 translator 旁加 special case。
- server-tool：**历史 use/result + live stream/non-stream 四格没有一张穷尽映射表**；按四格一次闭合并守 R-NO-REVIVE。
- direct translator vs `cc-to-responses.ts`：**有损诊断双份且强弱不一**；抽共享 translation degradation vocabulary。
- `docs/DESIGN.md:89-90`：**同一状态表先写 universal CC hub，再写 direct pair，且配置名漂移**；doc-sync 时收敛成当前架构，不保留互相矛盾的“历史叙述式现状”。

## 最终 verdict

本次 thinking-drop 日志修复本身方向正确，但它只处理了一个可观测性症状。Anthropic↔Responses direct bridge 的基础 happy path 可用，整体协议、round-trip、多 item、server-tool、Scenario B、顶层能力映射与独立 oracle 仍不完整。当前状态不应视为“全面完成”，应按上述 P0→P2 顺序进入修复设计与实施。
