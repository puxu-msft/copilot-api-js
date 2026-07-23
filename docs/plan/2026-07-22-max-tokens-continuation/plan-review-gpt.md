# max_tokens 续传实施计划评审（GPT 异模型对抗审）

## 评审范围

- 待审计划：`/home/xp/src/copilot-api-js/docs/plan/2026-07-22-max-tokens-continuation/README.md`、`kickoff.md`、`plan-G-gates.md`、`plan-M-terminal-ownership-matrix.md`、`plan-0-classifier-and-observability.md`、`plan-1-anthropic-continuation.md`、`plan-2-visibility-and-budget.md`、`plan-3-cc-responses.md`、`plan-4-closeout.md`。
- 需求权威：`/home/xp/src/copilot-api-js/docs/spec/2026-07-22-max-tokens-continuation.md`。
- 本报告只审计划，不修改计划或实现代码。

## 已读取／执行的证据

- 独立核对了 `src/lib/pipeline/driver.ts:1279-1300` 的 ledger 喂养、`:1336-1358` 的 terminal drain、`:1401-1488` 的 cut-path continuation，以及 `src/routes/messages/handler-v4.ts:1203-1231` 和 `:1442` 的 Anthropic 接线与 `ctx.complete()` 时序。
- 独立核对了 `src/lib/pipeline/generation/coordinator.ts:143-154` 的 `runContinuation`、`src/lib/context/model-operation-record.ts:239-250` 的 `continued` verdict、`src/lib/pipeline/continuation-request-builder.ts:13-31` 的 builder registry、`src/lib/pipeline/committed-blocks-ledger.ts:13-40` 与 `src/lib/anthropic/committed-block-extractor.ts:27-73` 的实际数据形状。
- 独立核对了 CC、Responses HTTP、Responses WS 的候选会话与终局路径：`src/routes/chat-completions/handler-v4.ts:628-657`、`src/routes/responses/candidate-response-session.ts:104-165`、`src/routes/responses/handler-v4.ts:444-499`、`src/routes/responses/ws.ts:375-408`、`:467-505`，以及 `src/lib/openai/responses-stream-accumulator.ts:23-210`。
- 执行：`bun test --parallel tests/pipeline/continuation-flow.it.test.ts tests/pipeline/generation-coordinator.it.test.ts`，结果为 11 pass、0 fail。该结果只确认姊妹 cut-path continuation 与 coordinator 基础未回归，不证明本计划新增的 success-path 设计正确。

## 总体 verdict

**需先修订，不应按当前计划开工实施。**

**blocker 数量：1。**

计划正确地区分了 `driver.ts:1336` 的成功 terminal drain 与 `:1401` 的 cut-path，且 `runContinuation`、`continued` verdict、builder registry 均已在 master 可复用。P1 Task 1.1 关于“driver 内循环不返回则 handler 的 `ctx.complete()` 尚未发生”的控制流结论也被本次复核证实：handler 的 `ctx.complete()` 确在 driver 返回 `complete` 后才于 `handler-v4.ts:1442` 调用。

但当前计划尚未给出能够正确识别 A/B/B-closed/C 的状态来源，也没有把 P0 的“enabled:false 仍观测”接到任何真实终局路径。这不是实现细节，而是会让核心分型、ADR D3 安全边界和 P0 验收同时失效的架构缺口。另有若干跨阶段协议与合并态要求被延后或遗漏，不能以“实施时再核实”代替计划中的可执行设计。

## 事实性发现

[blocker] `plan-0-classifier-and-observability.md:18-28, 32-65, 150-154`；`README.md:64-71` — 计划指定的 `CommittedBlocksLedger` 不能提供分型器所需的“最后一个 wire block 类型 + 闭合状态”，P0 又明确不建立替代 observer，故 A/B/B-closed/C 无法按 spec 判定。证据：`src/lib/pipeline/committed-blocks-ledger.ts:13-28` 的 canonical union 仅有 `text|tool_use`，没有 `thinking` 与 closed 标记；`src/lib/anthropic/committed-block-extractor.ts:54-60` 明确丢弃 thinking；ledger 只在 `driver.ts:1279-1300` 的 `content_block_stop` commit 后写入。因此未闭合 text、悬挂 tool_use、thinking terminal 都不可能由 `ledger.snapshot()` 区分。若实现者以 ledger 的最后项代替 wire 最后块，“text 后又 thinking 截断”会被误判为 text 并可能走 continuation，违反 ADR D3 的 thinking 不作前缀约束；B 的 partial/zero-delta 也会退化成“看不见”。建议：在 P0 先冻结一个独立、per-format 的 terminal observer 契约，并把它作为 `maxTokensContinuation` 输入，而非把不含所需信息的 ledger 伪装成判定来源。Anthropic observer 至少记录最后 wire block 的 kind、是否接到 `content_block_stop`、是否含可 replay 的 committed prefix；CC/Responses 分别记录 tool-call/output-item 的打开与完成状态。为避免双解析，可在 candidate-session 的 `onRenderedFrame`／原始 accumulator 旁更新该 observer，但必须保留原始 wire 顺序并由单元测试覆盖 A'、zero-delta B、B-closed、thinking-after-text 等反例。随后 P1 只能消费此 observer，ledger 仅继续承担“可回放已提交前缀”的职责。

[major] `plan-0-classifier-and-observability.md:116-153` — P0 声称在不改 driver／生产接线的前提下，可在 `enabled:false` 时记录 `max_tokens_truncation{class}`，与它自身的任务定义矛盾。Task 0.4 仅添加未调用的 `recordMaxTokensContinuation` 槽位，Task 0.5 的 telemetry extractor 又只从 `entry.pipelineInfo.maxTokensContinuation` 读取；计划中没有任何真实 terminal 路径把分型写入该字段。因而 P0 收口要求的“真实 C 类请求使计数递增且不续写”没有可执行生产路径。建议：把“terminal observer + 在所有已支持格式的正常 terminal 时 recordMaxTokensTruncation”移入 P0，明确其调用点、history merge 和 telemetry sink；这不是 continuation，仍可保持 `enabled:false` 字节等价。P0 验收改为真实持久化／telemetry readback，而不是类型 round-trip。

[major] `plan-1-anthropic-continuation.md:17-33` — Task 1.1 的控制流结论正确，但所列“driver 级”测试不能按示例直接证明 `ctx.complete()` 的调用次数。`runResponseBufferedSink` 只返回 `ResponseOutcome`，并不调用 `ctx.complete()`；实际调用在 `pumpAnthropicStreamingV4` 的 handler 分支 `src/routes/messages/handler-v4.ts:1442`。若测试只驱动 driver，则 spy 永远不会被调用，即使实现错误地在 handler 侧提前 settle，也会出现假绿。建议：拆为两个 oracle：driver integration test 证明首轮 terminal 不 flush、续写 request 被派发且 driver 未返回；handler/in-process HTTP test 证明一次请求的 `RequestContext.complete`／history terminal 只在最终 leg 后发生一次。该 handler 测试还应覆盖 parent dispatch 为 `continued`、final dispatch 为 `committed`，避免只验证 client wire。

[major] `plan-1-anthropic-continuation.md:35-87`；`plan-2-visibility-and-budget.md:13-54` — 组合矩阵校验被排在 P2，而 P1 已启用并消费 `visibility` 与 `classes`。因此在 P1 落地到 P2 之前，用户可配置 `visibility:passthrough + classes.text:continue`，driver 会发 continuation，却先后把 terminal 发给客户端，违反 spec §6 “同一 SSE 连接不能在已终止后继续”。这也违反每个 task commit 必须终态自洽的约束。建议：将最小的 effective-config validation／downgrade 和 `strategy-prevented-stitch` 的 request-level诊断移到 P0 config 或 P1 的首次消费提交中；P2 可以再扩展 marker、完整 telemetry 与其余策略，但不得让一个已发布的 P1 commit 暴露非法组合。

[major] `plan-G-gates.md:49-57` 与 `plan-2-visibility-and-budget.md:56-71` — 对 `marker` 的 wire 语义互相冲突。Gate D Step 4 写“marker……不抑制信号本身，只追加标记”，但首轮 `message_stop`／`[DONE]`／`response.incomplete` 一旦发送，流已终止，无法在同一流发送 continuation；P2 Task 2.3 则正确写为“抑制真实终止符同时插入 marker”。建议：统一冻结为“marker 和 transparent 一样抑制被替代的首轮 terminator，区别仅为在 continuation 前注入可辨识且格式合法的 marker”；Gate D 必须以这个真实 producer wire 作为 SDK oracle。再明确 marker 是 content text、metadata 还是 protocol extension，并把其 usage 计数、history synthetic provenance 和 CC／Responses 的格式映射列为逐格式验收项。

[major] `plan-M-terminal-ownership-matrix.md:6-12, 16-86`；`README.md:54-57` — 计划承诺矩阵覆盖每个 `(inbound × outbound × direct/translate/fallback/WS)` leg，实际只列了四个同格式直连格：Anthropic direct、CC direct、Responses HTTP direct、Responses WS。项目现有代码存在反向／翻译 legs，例如 `src/routes/messages/handler-v4.ts:1123-1137` 分派 direct 与 `@cc/@responses` translate，且其注释 `:1501-1505` 已明确该 translate leg 不可直接复用 buffered terminal 判据；Responses 也有 `viaFallback`／`reverseMessages` 分支（`src/routes/responses/handler-v4.ts:194-235`）。矩阵若不列这些 legs，P3 无法证明“全格式 terminal ownership”，也无法保证 enabled 状态下非目标 leg 保持纯透传。建议：M.1 先从运行时路由枚举所有 live inbound×target legs；对每个 leg 填四要素，或者明确标为“本版本不支持 continuation、由配置／builder lookup 强制 passthrough”并给 disabled/opt-in producer oracle。不能只把 direct 四格称为全表。

[major] `README.md:77-80`；`plan-1-anthropic-continuation.md:106-124` — spec 要求每个 synthetic continuation request 有 `synthetic:"continuation"` provenance，当前底座尚未实现：`src/lib/pipeline/driver.ts:1433-1438` 明确注释该 marker 是 backlog 缺口。计划虽在 README Global Constraint 提及“若姊妹未先落地则顺手解决”，但没有任何具体 task、所有者、数据模型改动或 producer/history oracle；Task 1.4 的示例直接期待 attempts 有 marker，却没有实现步骤。这会产生“测试补 fixture／手工字段”而真实 attempt 未标记的假绿风险。建议：在 P1 前增加条件化任务：先核查 backlog 是否已 landed；未 landed 时以独立 commit 在 `RequestEnvelope`／attempt recording 的拥有方建立 provenance，断真实持久化 attempts[].upstreamRequest 标记而 upstream-original response track 无合成物；已 landed 时引用精确 commit 与现有 producer test。不可把这一项留给实施者临场“顺手”。

[major] `README.md:76-80`；`plan-4-closeout.md:31-39` — 冻结 spec §13 Q5 要求的“三方叠加时序图”和 index／挂载层次／预算账没有落到任何计划 task。全文搜索计划目录未找到 repetition、重复截断、`client.outbound`、`delivery/session`、Q5 或“三方”对应任务。P4 的 merged-state review 只点名 settle、terminal matrix、visibility、history、C3/C4，未覆盖重复截断 spec。建议：在 M 后、P1 前增设一个明确的 integration-design task：列出 committed-block offset、max_tokens continuation offset、repetition delivery transform 的所有权和顺序；写至少一个三方生产 oracle（包括 continuation 后 index 及终局唯一性）；P4 再以该图为合并态核对标准。该任务不可仅降格为收尾 reviewer 的泛化检查。

[minor] `plan-M-terminal-ownership-matrix.md:50-57` — Responses HTTP 行关于 `incomplete_details.reason` 的不确定性被诚实标为待核实，这一点正确；本次独立复核也确认 `src/lib/openai/responses-stream-accumulator.ts:23-129` 目前只有 `status`，没有保存 `incomplete_details.reason`。但计划把“可能需新增该字段”放在 P3 Task 3.5，而 P0 Task 0.2 已宣称三格式 terminal detector 可只读已有 accumulator 字段。建议：把 Responses detector 的状态捕获提前为 P0 的条件前置，或将 P0 对 Responses 仅定义 pure predicate、明确尚未接生产观测；不要在 P0 的接口说明中声称其调用方已有该值。

[minor] `plan-G-gates.md:25-34` — Gate B 用三次样本及“如 <20%”作为 PASS 示例，不能支撑一个模型行为分型的稳定默认／opt-in决策：3 次样本甚至无法观测到 20% 这一阈值，且“语义等价”没有可重复裁决规则。建议：先定义固定 prompts、工具 schema、采样参数、样本量、等价 oracle 和记录格式；将 Gate B 输出写成观测分布与明确的不确定性，若要允许 B opt-in，再在 ADR／计划中冻结由用户接受的阈值，而不是临时采用 `<20%`。

[minor] `plan-M-terminal-ownership-matrix.md:16-27` — Anthropic direct 的核心行号和“成功 terminal 与 cut-path 互斥”断言经复核成立：`driver.ts:1336-1358` 是 terminal drain，`:1401-1454` 是无终局／throw 后的 continuation；`handler-v4.ts:1442` 在 driver 返回后才 settle。建议保留该表，但将“`message_delta + message_stop` 全在 terminal tail buffer”写成显式测试前提，并测试已有 `content_block_stop` 已先行 flush、只有 terminal tail 被抑制，防止未来把 commit boundary 改成 `message_stop` 时静默破坏截获点。

## 已确认的计划优点

- `plan-1` 没有误把 `driver.ts:1401` 的 cut-path gate 当成成功续写触发点；这与 master 控制流一致。
- `runContinuation` 与 `continued` 不是待建接口：它们已落在 `src/lib/pipeline/generation/coordinator.ts:143-154` 和 `src/lib/context/model-operation-record.ts:246,250`，复用方向正确。
- CC 的 `[DONE]` 由 handler 在 driver outcome 后于 `src/routes/chat-completions/handler-v4.ts:628-657` 写出，计划把该 ownership 列为 P3 producer-oracle 前置是必要且诚实的。
- Responses WS 当前确实故意 terminal-only，`src/routes/responses/ws.ts:375-386` 的说明与 M／P3 对姊妹 WS 依赖的谨慎处理一致；对未 landed 依赖登记 backlog 是正确边界，不是静默砍范围。
- 客户端 SDK oracle、真实 history readback、disabled 字节等价和 10–25 次时序连跑均被计划纳入，方向正确；修订后应让它们覆盖上述真实 state source 与三方组合，而非只覆盖手工构造帧。

## 主观建议

[建议] `plan-G-gates.md:1-76` — 将 Gate D 从独立 hand-built-frame PoC 升级为两层：先用独立手工 producer 构造最小 wire 验证 SDK 接受性，再在 P1 implementation 的真实 handler+mock-upstream path 重跑同一 SDK oracle。预期影响是避免“SDK 接受某个帧序列”被误读为“真实 driver 的抑制、索引、usage 与 history 接线正确”。

[建议] `plan-1-anthropic-continuation.md:146-152` 与 `plan-3-cc-responses.md:107-113` — 把每一阶段收口中的“全部已实现格式 golden”列为具体测试文件和 fixture 基线，而不是仅写“跑既有 golden”。预期影响是 enabled:false 的字节等价能够覆盖 terminal frame、usage、`[DONE]`／WS close 行为，不会因套件选择遗漏新 leg。

[建议] `plan-4-closeout.md:31-39` — merged-state review 之外增加一份实现后的 matrix 对账清单，逐格记录“实际 interceptor、terminal owner、continuation builder、provenance producer、producer oracle”。预期影响是减少 M 文档和实现各自正确但相互错位的可能性，并让后续格式接入可复用。

## 可否开工实施

**需先修订。**

最低修订门槛是：先补齐可判定 A/B/B-closed/C 的 per-format terminal observer 与 P0 生产观测接线；把 passthrough×continuation 的非法组合前移到首个可启用实现；消除 marker 语义矛盾；把 full-leg matrix、synthetic provenance、spec Q5 三方交互写成具名 task 和 TDD oracle。完成后可先执行 gates、P0、M 的 direct Anthropic 格，再开始 P1。
