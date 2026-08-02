# 网络韧性重试加固草案：现状断言与引用独立核验报告

## 评审结论

- **评审范围**：`/home/xp/src/copilot-api-js/docs/tmp/2026-08-02-network-resilience-retry-hardening.md` 的 §2 C1–C12，以及 §4 中全部显式 `file:line` 引用。
- **已读取的主要证据**：草案、ADR `/home/xp/src/copilot-api-js/docs/decisions/2026-07-22-continuation-retry-sequential-anchor.md`、仓库 shipped `/home/xp/src/copilot-api-js/config.yaml`、用户 override `/home/xp/.local/share/copilot-api/config.yaml`、`packages/foundation/src/state-defaults.ts`、Messages/Responses/Chat/Gemini handlers、pipeline driver/ledger/delivery、retry registry/schema、Claude Code 2.1.207 打包源码 `/home/xp/.claude/refs/claude-code-2.1.207/app.pretty.js`。
- **已执行的独立检查**：全仓生产代码检索；实际调用 `extractAnthropicCommittedBlocks` 输入完整 `server_tool_use` 帧序列；执行 `bun test tests/anthropic/committed-block-extractor.unit.test.ts tests/pipeline/committed-blocks-ledger.unit.test.ts`，结果 9 pass / 0 fail；执行所有命中 `request_deadline|requestDeadline` 的 14 个测试文件，结果 630 pass / 0 fail。
- **总体 verdict**：**修复 major 后可进入下一阶段**。设计方向不在本报告裁决范围；现状依据中有两处确定性重大错误：C6 遗漏已经启用的 per-request hard deadline，C10 对当前 Claude Code byte-idle 常量及我方保活覆盖范围的描述已过时。
- **blocker 数量**：0。
- **裁决统计**：确证 7 条；部分成立 5 条；证伪 0 条；无法取证 0 条。这里把“断言主体成立但数值、范围或附带理由错误”统一记为“部分成立”。

## C1–C12 裁决表

| 编号 | 裁决 | 独立证据 | 备注 |
|---|---|---|---|
| C1 | 确证 | `/home/xp/src/copilot-api-js/packages/foundation/src/state-defaults.ts:120-125`；`/home/xp/src/copilot-api-js/config.yaml:747-771`；`/home/xp/src/copilot-api-js/src/routes/messages/handler-v4.ts:1171-1190,1310-1367,1388-1428` | Anthropic 的 ledger/extractor/continuation hooks 只传给 `runResponseBufferedSink`；`false` 解析成 live；用户 override 未覆盖该键，故 effective 值来自 shipped config 的 `false`。live 中途异常会合成 Anthropic `event:error`。 |
| C2 | 确证 | `/home/xp/src/copilot-api-js/src/lib/pipeline/driver.ts:1465-1488,1530-1547`；`/home/xp/src/copilot-api-js/src/routes/messages/handler-v4.ts:1388-1428`；ADR `/home/xp/src/copilot-api-js/docs/decisions/2026-07-22-continuation-retry-sequential-anchor.md:39-47` | 完整交互式 `tool_use` 令 `canContinue=false`，随后得到 `partial-degrade`/`stream-error`，handler 写 error 帧；ADR D3 要求正常终止，确有不一致。 |
| C3 | 确证 | `/home/xp/src/copilot-api-js/src/routes/messages/handler-v4.ts:1322-1340`；`/home/xp/src/copilot-api-js/src/routes/responses/handler-v4.ts:382-395`；`/home/xp/src/copilot-api-js/src/routes/responses/candidate-response-session.ts:106-164`；全生产树检索结果见详述 | Responses 侧没有 ledger、extractor、continuation hooks，也没有 Responses builder 注册；driver 的 continuation 条件因此恒不成立。 |
| C4 | 确证 | `/home/xp/src/copilot-api-js/src/routes/responses/candidate-response-session.ts:106-151`；`/home/xp/src/copilot-api-js/src/lib/codec/openai-responses/commit-boundaries.ts:4-34`；`/home/xp/src/copilot-api-js/src/routes/responses/ws.ts:372-405` | HTTP 挂 `isResponsesCommitBoundary`，其中 `response.output_item.done` 是块边界；WS 明确不挂 `commitBoundaries`，仅 terminal drain。 |
| C5 | 部分成立 | `/home/xp/src/copilot-api-js/packages/foundation/src/state-defaults.ts:124-127,186-187`；`/home/xp/src/copilot-api-js/config.yaml:332-355`；`/home/xp/.local/share/copilot-api/config.yaml:1-55`；`/home/xp/src/copilot-api-js/src/lib/config/config.ts:600-617` | 内置值 3/5 正确，shipped config 的 buffered 值也是 3；但“用户 config 亦为 3”不成立——用户 override 根本没有该键。effective 3 来自 bundled shipped config，不是用户显式配置。单一 `maxReactiveRetries` 确实传给所有 registry 策略。 |
| C6 | 部分成立 | `/home/xp/src/copilot-api-js/config.yaml:227-261`；`/home/xp/src/copilot-api-js/packages/foundation/src/state-defaults.ts:246-257`；`/home/xp/src/copilot-api-js/src/lib/context/manager.ts:122-127,252-257,406-427`；`/home/xp/src/copilot-api-js/src/lib/pipeline/generation/runtime-policy.ts:7-25` | “不存在任何 per-request 总时长预算”被确定性反例推翻：`timeouts.request_deadline` 是从请求创建起算、跨内部重试的 hard deadline，shipped 值 1200s。只有“没有拟议的 3600s、只在开新腿前检查且不打断当前腿的 retry budget”成立。`persist_retry.maxTotalMs` 只管 History 单条落盘重试，不是请求预算。 |
| C7 | 确证 | `/home/xp/src/copilot-api-js/packages/foundation/src/state-defaults.ts:188-195`；`/home/xp/src/copilot-api-js/config.yaml:967-985`；`/home/xp/src/copilot-api-js/src/lib/pipeline/generation/generation-budget.ts:27-58`；`/home/xp/src/copilot-api-js/src/lib/pipeline/driver.ts:1502-1527` | 5/16 数值正确，且是 generation-global lifetime caps；continuation 新建 candidate/dispatch，预算耗尽会在 driver catch 中降级为 `continuation-exhausted`。用户 override 未改这些值。 |
| C8 | 部分成立 | `/home/xp/src/copilot-api-js/src/lib/request/retry-registry.ts:100-112,132-180,182-300`；`/home/xp/src/copilot-api-js/src/lib/config/schema.ts:963-1012` | registry 确有逐策略唯一 `configKey`，前三项恰好是 network/serverError/tokenRefresh；但 `configKey` 是策略 ID，不是“族”字段，schema 当前只允许每策略 `enabled`，也没有预算族。可以按三个 key 的硬编码集合临时归族，但若设计要求“给策略打族标签并按族解析预算”，必须扩展 registry entry/schema 或另建映射；“无需新增注册机制”只能理解为无需另造第二个 registry，不能理解为零 registry 合约改动。 |
| C9 | 确证 | `/home/xp/src/copilot-api-js/src/lib/pipeline/continuation-request-builder.ts:14-33`；`/home/xp/src/copilot-api-js/src/lib/anthropic/continuation-builder.ts:48-58`；`/home/xp/src/copilot-api-js/src/routes/messages/handler-v4.ts:215-217` | registry key 的 union 已含 `openai-responses`，Anthropic builder 在模块加载时注册；Responses 可沿同一 seam 注册。 |
| C10 | 部分成立 | `/home/xp/.claude/refs/claude-code-2.1.207/app.pretty.js:88228-88240,88263-88324,88382,298070-298104,298198-298204`；`/home/xp/src/copilot-api-js/packages/foundation/src/state-defaults.ts:120-123`；`/home/xp/src/copilot-api-js/src/lib/pipeline/delivery/session.ts:111-167`；`/home/xp/src/copilot-api-js/config.yaml:747-764` | 300s event-idle 与“ping 不重置、任意非-ping 事件重置”在当前源码中成立；20s ping 与 200s content escalation 的配置也成立。但当前可用 2.1.207 源码并非固定 60s byte-idle：first-party 默认 180s，其他路径基准 300s，并可被 env/remote setting 改写。更重要的是，我方 escalation 明确在第一个真实块完成后的 no-open gap 只继续 ping，尚不能覆盖 300s event-idle。 |
| C11 | 部分成立 | `/home/xp/src/copilot-api-js/src/lib/pipeline/committed-blocks-ledger.ts:14-16,32-42`；`/home/xp/src/copilot-api-js/src/lib/anthropic/stream-accumulator.ts:28-61,251-287`；`/home/xp/src/copilot-api-js/src/lib/anthropic/committed-block-extractor.ts:8-12,34-62`；独立 probe 输出 `[]` | 谓词实现描述正确；但敞口的担忧已被证伪：accumulator 保留 `type:"server_tool_use"`，extractor 只投影 text/tool_use，明确丢弃 server_tool_use，因此不会变成 canonical `tool_use`，不会违反 ADR D3。 |
| C12 | 部分成立 | `/home/xp/src/copilot-api-js/packages/foundation/src/state-defaults.ts:138-140`；`/home/xp/src/copilot-api-js/src/routes/chat-completions/handler-v4.ts:333-369,482-558`；`/home/xp/src/copilot-api-js/src/routes/gemini/handler-v4.ts:405-438,609-638` | Chat 默认缓冲且内容递送实质 terminal-only；Gemini 两条 streaming pump 都只走 `runResponseSink`。但“Chat 无 `commitBoundaries`”字面错误：它挂了 `ccCommitBoundaries`，只是该 predicate 对普通内容不形成中途边界，仅把 in-band error 当边界，正常内容仍在 terminal commit。 |

## 详细取证过程

### C1：Anthropic 三腿是否只存在于 buffered path

`CONFIG_MANAGED_DEFAULTS.protectStreamingGeneration` 是 `false`，`bufferedRetryShared.maxRetries` 是 3（`/home/xp/src/copilot-api-js/packages/foundation/src/state-defaults.ts:120-127`）。仓库 shipped config 在 `/home/xp/src/copilot-api-js/config.yaml:767-771` 同样写明 `false`；实际用户 override `/home/xp/.local/share/copilot-api/config.yaml` 只覆盖 model mappings、`response_header`、`stream_idle` 和 history，没有覆盖该键，故 effective 值仍为 `false`。

`resolveBufferedAndHeartbeat` 在 `/home/xp/src/copilot-api-js/src/routes/messages/handler-v4.ts:1183-1190` 只把 `"on"` 或命中 `"tool_use_only"` 解析成 buffered。仅 buffered 分支在 `:1310-1340` 传入 `commitBoundaries`、`committedBlocksLedger`、`extractCommittedBlocks` 和 `continuation`；`:1367` 的 live 分支只调用 `runResponseSink`。live 出错后 `:1388-1428` 合成 `event:error`。因此 C1 的机制与有效配置判断均成立。

### C2：完整 tool_use 后当前到底是正常结束还是 error

Driver 在 `/home/xp/src/copilot-api-js/src/lib/pipeline/driver.ts:1476-1488` 用 `!hasCompleteInteractiveToolUse(ledger.snapshot())` 决定 continuation。出现完整 tool_use 时 continuation 不执行；`:1538-1547` 把“已 commit、未 continuation”的终态记为 `partial-degrade` 并返回 `streamErrorOutcome`。Messages handler 在 `/home/xp/src/copilot-api-js/src/routes/messages/handler-v4.ts:1388-1428` 对该 outcome 写 Anthropic error 帧并 `ctx.fail`。ADR D3 `/home/xp/src/copilot-api-js/docs/decisions/2026-07-22-continuation-retry-sequential-anchor.md:43-47` 明确要求“不续写，正常终止”。C2 确证。

### C3：Responses 是否完全没有 ledger/extractor/continuation 接线

否定性断言的检索范围是 `/home/xp/src/copilot-api-js/src` 与 `/home/xp/src/copilot-api-js/packages` 的生产代码；关键词为 `committedBlocksLedger`、`extractCommittedBlocks`、`extractResponsesCommittedBlocks`、`getContinuationBuilder`、`register*ContinuationBuilder`、`continuation:`。正向对照是同一次检索明确命中 Messages 的 `/home/xp/src/copilot-api-js/src/routes/messages/handler-v4.ts:1328-1338`，证明检索能触达目标机制。Responses 路由与 codec 目录无命中；Responses handler `/home/xp/src/copilot-api-js/src/routes/responses/handler-v4.ts:382-395` 只传 telemetry/retry/buffer caps，candidate session `/home/xp/src/copilot-api-js/src/routes/responses/candidate-response-session.ts:106-164` 只有 commit boundary、terminal stop 与 merge transform。故“Responses 三件套全无、continuation branch inert”成立。

### C4：Responses HTTP 与 WS 的 commit 模式

HTTP candidate 在 `/home/xp/src/copilot-api-js/src/routes/responses/candidate-response-session.ts:140` 挂 `isResponsesCommitBoundary`；predicate `/home/xp/src/copilot-api-js/src/lib/codec/openai-responses/commit-boundaries.ts:18-34` 明列 `response.output_item.done`。WS 在 `/home/xp/src/copilot-api-js/src/routes/responses/ws.ts:372-405` 明确省略 `commitBoundaries`，仅依赖 terminal drain。C4 确证。

### C5：重试预算数值与“用户 config”

内置默认 3/5 在 `/home/xp/src/copilot-api-js/packages/foundation/src/state-defaults.ts:124-127,186-187`。shipped config 的 `/home/xp/src/copilot-api-js/config.yaml:332-355` 显式写 buffered 3；该 shipped config 没显式写 `retry.max_reactive_retries`，所以 5 来自 hardcoded safety-net default。用户真正的 override 路径由 `/home/xp/src/copilot-api-js/src/lib/config/paths.ts:6-12,56-62` 决定为 `/home/xp/.local/share/copilot-api/config.yaml`；该文件没有两个预算键。因此草案应改成“effective 值为 3/5；用户 override 未覆盖”，不能写“用户 config 亦为 3”。

### C6：per-request 总时长预算是否不存在

检索范围覆盖 `/home/xp/src/copilot-api-js/src`、`/home/xp/src/copilot-api-js/packages/foundation/src`、shipped/user config；关键词至少包括 `total`、`budget`、`deadline`、`maxTotal`、`max_total`、`elapsed`、`requestDeadline`、`request_deadline`。正向反例是 shipped `/home/xp/src/copilot-api-js/config.yaml:257-261`：注释明确写“客户端请求最大存活秒数；一次客户端请求可能被多次内部重试”，值为 1200。`RequestContextManager` 在 `/home/xp/src/copilot-api-js/src/lib/context/manager.ts:406-427` 于 request create 时启动 timer，到期 `ctx.cancel(REQUEST_DEADLINE_CANCEL_REASON)` 并 fail；这是实质上的 per-request hard wall-clock deadline。相关 14 个测试文件共 630 tests 全绿，包含 `/home/xp/src/copilot-api-js/tests/context/request-deadline.it.test.ts`。

`maxTotalMs` 反例审查：`/home/xp/src/copilot-api-js/config.yaml:440-452` 的 `history.persist_retry.max_total_ms` 是每条 History terminal commit 的 SQLite 落盘重试软上限，不覆盖客户端请求和上游腿，因此它本身不是 C6 的反例；真正反例是 `timeouts.request_deadline`。

草案可以继续提出新的 `retry.total_budget_sec`，但必须解释它与现有 hard deadline 的关系：当前 shipped 1200s hard deadline 会先于拟议 3600s retry budget 杀掉请求；若不联动修改/废除现有 deadline，3600s 设计不可达。

### C7：candidate/dispatch budget 是否会饿死 9 次 continuation

内置与 shipped 值均为 5/16（`/home/xp/src/copilot-api-js/packages/foundation/src/state-defaults.ts:188-195`，`/home/xp/src/copilot-api-js/config.yaml:979-985`），用户 override 未覆盖。`createGenerationBudget` 在 `/home/xp/src/copilot-api-js/src/lib/pipeline/generation/generation-budget.ts:27-58` 把 total candidates/dispatches 作为 generation-global lifetime counter；超限直接 throw。Continuation 在 `/home/xp/src/copilot-api-js/src/lib/pipeline/driver.ts:1502-1527` 经 coordinator 新开 continuation candidate，catch 明确点名 candidate budget exhaustion 并降级。因此 C7 确证。设计把 caps 改到 12/32 是否足以覆盖 hedge、reactive retry、continuation 的最坏组合属于后续可行性验证，不由 C7 现状断言自动证明。

### C8：configKey 是否已经是可直接使用的“族”

`RetryStrategyEntry` 在 `/home/xp/src/copilot-api-js/src/lib/request/retry-registry.ts:100-112` 只有 `name/order/appliesTo/configKey/kind/create`，没有 `family` 或 budget selector。16 个 `configKey` 在 `:132-300` 是逐策略唯一 ID；schema `/home/xp/src/copilot-api-js/src/lib/config/schema.ts:971-1010` 只允许 `retry.strategies.<configKey>.enabled`。前三个 key 与拟议网络类一一对应，因此不必新造第二个 registry；但若按设计文字“给策略打族标签”，现有 entry contract 必须扩展，或需要一个额外 `configKey → family` 映射。现状结构本身不会从 `configKey` 推导“network vs negotiation”。C8 只能部分成立。

### C9：continuation builder 是否 vendor/client-format keyed

`/home/xp/src/copilot-api-js/src/lib/pipeline/continuation-request-builder.ts:16-33` 的 key union 含 `anthropic/openai-cc/openai-responses/gemini`，底层是 `Map<ClientFormat, ContinuationRequestBuilder>`。Anthropic builder 在 `/home/xp/src/copilot-api-js/src/lib/anthropic/continuation-builder.ts:55-58` 注册，并由 Messages handler `/home/xp/src/copilot-api-js/src/routes/messages/handler-v4.ts:215-217` 模块加载时调用。C9 确证；更准确术语是 client-format keyed，而非严格 vendor keyed。

### C10：Claude Code 两层 idle watchdog 与我方覆盖范围

项目 skill `/home/xp/src/copilot-api-js/.claude/skills/debugging-claude-client-connection/SKILL.md` 仍声称 60s byte-idle + 300s event-idle，但当前本机唯一源码参考是 Claude Code 2.1.207：

1. Event-idle：`x0i()` 在 `/home/xp/.claude/refs/claude-code-2.1.207/app.pretty.js:88228-88230` 最低返回 300000ms；`he()` 在 `:298085-298093` 以该值武装超时。消费循环 `:298198-298204` 遇 ping 直接 `continue`，其余事件调用 `he()`，所以“非-ping 事件重置”成立。
2. Byte-idle：`k0i()` 在 `:88231-88240` 选择 provider 基准；常量 `S_h=180000` 在 `:88382`，不是 60000。first-party 默认 180s；其他路径基准可到 event-idle 的 300s；`CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS` 和 remote setting 还能覆盖，最终 clamp 10s–1800s。包装流在 `:88263-88324` 每读到任意 byte 重新武装。因此把 60s 写成当前恒定边界已过时，最多只能作为旧版本 2.1.185/2.1.201 的历史实测。
3. 我方 ping/escalation 配置：20/200 正确（`/home/xp/src/copilot-api-js/config.yaml:747-764`）。但 delivery session `/home/xp/src/copilot-api-js/src/lib/pipeline/delivery/session.ts:116-143` 明确规定：有 open block 时发 empty delta；没有 open block且 `semanticBlockCount===0` 时可注入 pre-content scaffold；第一个真实块完成后 no-open gap 不再注入，只能 ping，等待未来 monotone index allocator。故“当前已覆盖 300s event-idle”只覆盖 pre-content 或仍有 open block 的时段，不覆盖首块完成后的长 inter-block gap。

这也是 §4.5 承重因果链的直接缺口：草案声称 3600s budget 依赖持续非-ping 事件，但现状并不保证所有 block-level gap 都能持续产生非-ping 事件。

### C11：server_tool_use 会不会被归一成 tool_use

确定结论：**不会**。

Accumulator 的 union 和 start handler 在 `/home/xp/src/copilot-api-js/src/lib/anthropic/stream-accumulator.ts:28-61,251-287` 分开保留 `tool_use` 与 `server_tool_use`。Extractor `/home/xp/src/copilot-api-js/src/lib/anthropic/committed-block-extractor.ts:8-12,47-61` 仅将 `block.type === "tool_use"` 投影成 canonical tool_use，`server_tool_use` 走落空分支被丢弃。独立 probe 构造 `server_tool_use start → input_json_delta → stop` 并调用真实 extractor，stdout 是 `[]`。因此 `hasCompleteInteractiveToolUse` 看不到 server tool，符合 ADR D3。

已有测试 `/home/xp/src/copilot-api-js/tests/anthropic/committed-block-extractor.unit.test.ts:50-60` 的名称声称覆盖 server_tool_use，但 fixture 实际只含 thinking + text，没有构造 server_tool_use；这条测试对该风险是潜在假绿。此次结论依赖代码阅读和独立 probe，不依赖该测试名。建议补一个真实 server_tool_use fixture，防未来回归。

### C12：Chat Completions 与 Gemini

Chat 默认 `true` 在 `/home/xp/src/copilot-api-js/packages/foundation/src/state-defaults.ts:138-140`。`/home/xp/src/copilot-api-js/src/routes/chat-completions/handler-v4.ts:359-361` 实际提供 `commitBoundaries: ccCommitBoundaries`，所以“无 commitBoundaries”错误；不过 handler 注释与 `:482-558` 表明普通内容没有中途结构边界，完成内容只在 `finishReason` terminal drain 提交，只有 in-band error 是 frame-level boundary，故“内容递送 terminal-only”成立。

Gemini 的 direct 与 reverse streaming pump 分别在 `/home/xp/src/copilot-api-js/src/routes/gemini/handler-v4.ts:438,638` 只调用 `runResponseSink`；生产文件中检索 `runResponseBufferedSink` 无命中。该否定性检索有 Anthropic/Responses/Chat 的正向命中作为对照，故 Gemini pure-live 结论成立。

## §4 全部 file:line 引用核验

§4 只有两条显式 Markdown `file:line` 引用；两条都准确。

| 引用 | 裁决 | 证据 |
|---|---|---|
| `messages/handler-v4.ts:1367` | 确证 | `/home/xp/src/copilot-api-js/src/routes/messages/handler-v4.ts:1310-1367` 的 ternary 在 buffered 侧调用 `runResponseBufferedSink`，`:1367` 确为 `runResponseSink(... liveReconcilingSink(...))` 的 live 分支。 |
| `responses/handler-v4.ts:395` | 确证 | `/home/xp/src/copilot-api-js/src/routes/responses/handler-v4.ts:382-395` 的 ternary 在 `buffered=false` 时于 `:395` 调 `runResponseSink`，确为 Responses HTTP live 分支。 |

§4 其余位置有符号名和 skill 引用，但没有其他 `file:line` 引用。需要注意：§4.5 的 `responseHeaderTimeout: 300 / streamIdleTimeout: 300` 是 hardcoded fallback，不是当前 effective config；shipped config 是 600/600，用户 override 是 900/600。设计若意在“保持当前运行值不变”，应写 effective 900/600；若意在“保持 hardcoded fallback 不变”，应明确这样表述。

## 本次核验推翻或修正的断言

1. **C6 必须推翻**：“仓库不存在任何 per-request 总时长预算”错误。现有 `timeouts.request_deadline` 就是跨内部重试的 per-request hard deadline；shipped 1200s。拟议 3600s 若不联动该值，永远先被 1200s deadline 中断。
2. **C10 的 60s byte-idle 必须修正**：当前可取证的 Claude Code 2.1.207 源码默认是 first-party 180s、其他路径基准 300s，并允许 env/remote override；60s 只是旧版本实测，不能写成当前常量。
3. **C10 的“当前保活已覆盖两层边界”必须收窄**：200s escalation 仅覆盖 pre-content 或已有 open block；第一个真实块完成后的 no-open inter-block gap 仍只发 ping，会继续撞 300s event-idle。源码明确把 monotone index allocator 列为未来前置。
4. **C11 的敞口可关闭**：真实 extractor 不会把 `server_tool_use` 归一成 `tool_use`，而是明确丢弃；独立 probe 输出空数组。不存在草案担心的 D3 误判。
5. **C5 的“用户 config 亦为 3”必须修正**：用户 override 未设置该键；effective 3 来自 bundled shipped config。
6. **C8 必须收窄**：`configKey` 是逐策略 ID，不是预算族标签。可以复用现有 registry，但按族预算仍需扩展 entry/schema 或维护显式映射，不能按“现有结构已足够、零合约改动”估算。
7. **C12 的“Chat 无 commitBoundaries”必须修正**：生产代码挂了 `ccCommitBoundaries`；准确表述应是“普通内容无中途边界，实质 terminal-only；in-band error 例外地是 frame boundary”。
8. **§4.5 的 per-attempt 数值必须区分 fallback 与 effective**：hardcoded fallback 是 300/300，shipped 是 600/600，当前用户 override 后 effective 是 900/600。
9. **C11 现有测试有覆盖盲点**：测试名声称覆盖 server_tool_use，fixture 却没有 server_tool_use。建议补真实 fixture，避免未来把“当前代码正确”误当成“回归测试已咬住”。

## 建议修复路由

这是设计草案事实基础的修订，建议由 `gpt-souls:architect-advisor` 修订 C5/C6/C8/C10/C11/C12 与 §4.5，并显式设计 `retry.total_budget_sec` 和现有 `timeouts.request_deadline` 的优先级/迁移关系；C10 的 inter-block carrier 是确定性实现缺口，如进入实施，应交 `gpt-souls:implementer`，并由 verifier 用当前 Claude Code 版本独立验收客户端可观察行为。