# Phase 1：SSE 与 Delivery Foundation

> 状态：`approved-not-implemented`
>
> 权威规格：[`docs/spec/2026-08-06-mandatory-block-delivery-and-h2-termination-observability.md`](../../spec/2026-08-06-mandatory-block-delivery-and-h2-termination-observability.md)
>
> 本目录只定义实施方法；规格是 what/why 单一事实源，当前 live 架构仍以 [`docs/DESIGN.md`](../../DESIGN.md) 为准。执行本阶段前必须先读 [`README.md`](README.md) 的 Global Constraints、文件责任边界、冻结跨层接口与 commit invariants。

## Task 1：SSE parser WHATWG 契约

**Files**
- Modify: `src/lib/transport/send.ts`
- Test: `tests/transport/owned-sse-parser.unit.test.ts`（新建）

**Produces**
- `parseOwnedSse` 仍为 `ownedResponseEvents` 私有实现；EOF 不 flush。
- connection-local `lastEventIdBuffer`／`lastEventIdString`，ID 始终为 wire string。

- [ ] 写 table-driven 红测：非空 `data`、`data:`、bare `data`、no-data fields、id-only 更新、空 id 重置、U+0000 忽略、numeric ID string、跨 chunk ID、CRLF、UTF-8、多行 data、EOF pending drop。
- [ ] 运行 `bun test tests/transport/owned-sse-parser.unit.test.ts`；预期现实现对 bare field、empty data、ID 类型／继承等失败，同时 EOF 样本通过。
- [ ] 实现 WHATWG line／dispatch state：colon-less `data`／`id` 是 empty value；空行先提交 ID buffer，再仅在 data buffer 曾被触达时 dispatch；EOF 只清理 reader。
- [ ] 运行定向测试和 `tests/transport/http-transport.it.test.ts`；预期全绿。
- [ ] 分别注入并反向恢复 6 个 exact mutation（EOF flush、no-data dispatch、丢 empty-data、丢 id-only、错误 reset、接受 NUL ID），确认各自目标测试红且正确基线绿。
- [ ] 提交：`fix: align owned SSE parsing with WHATWG`。

## Task 2：Typed protocol contract 与 grammar

**Files**
- Create: `src/lib/pipeline/delivery/protocol.ts`
- Create: `src/lib/pipeline/delivery/grammar.ts`
- Create: `tests/pipeline/delivery-grammar.unit.test.ts`
- Modify: `src/lib/pipeline/stream/frame-envelope.ts`

**Interfaces**
- Produces the exact unions from spec §4.2／§4.3.
- `createDeliveryGrammar({ mode })` accepts only `DeliveryGrammarInput` and returns ordered `DeliveryOutcome[]`.
- 本任务不动 production `CandidateBoundaryClassifier`；它在 Task 3 有真实 adapter／grammar outcome source 后才切换为 projection。

- [ ] 写红测覆盖合法后继表和每个 frozen `ClientProtocolError.semantic`：nested、mismatch、terminal-with-open、finish-before-terminal、duplicate、post-terminal、truncated、terminal-failure、adapter-exception。
- [ ] 写所有权红测：每个 input frame 只进入一个 buffer／outcome；`complete-unit.frames` 精确等于输入序列；response terminal 原子取走 response buffer；protocol error 不 flush 半块。
- [ ] 实现闭合类型和 state machine；grammar 不 import codec／route，不调用 JSON.parse。
- [ ] 运行 `bun test tests/pipeline/delivery-grammar.unit.test.ts`；同时运行现有 `boundary-classifier.unit.test.ts` 证明 production readiness 路径未被本任务改变。
- [ ] 注入错误后继／重复 frame 消费／terminal 携半块 mutation，确认红。
- [ ] 提交：`feat: add typed delivery grammar`。

## Task 3：协议 adapters 与 finish 单次消费

**Files**
- Create: `src/lib/pipeline/delivery/adapters/{anthropic,responses,chat-completions,gemini}.ts`
- Create: `tests/pipeline/delivery-adapters.unit.test.ts`
- Modify: `src/lib/pipeline/generation/candidate-response-session.ts`、`src/lib/pipeline/generation/boundary-classifier.ts`
- Modify: route candidate factories：`src/routes/messages/handler-v4.ts`、`src/routes/responses/candidate-response-session.ts`、`src/routes/chat-completions/handler-v4.ts`、`src/routes/gemini/handler-v4.ts`
- Modify: `src/lib/pipeline/stream/response-processor.ts`
- Move／extract: Anthropic route-only error frame builder into `src/lib/anthropic/` so delivery never imports routes.

**Interfaces**
- `DeliveryProtocolAdapter.classify` is the only wire classifier.
- `classifyFinish(result)` maps all four `ResponseFinishResult.kind` variants.
- `renderTerminal`／`renderError`／`renderDone` are owner-only.

- [ ] 写 adapter 红测：所有 frame classes、terminal diagnostic round-trip、256-byte fail-closed、runtime-branded control capability、伪造 capability 拒绝。
- [ ] 写 processor 红测：`finish.frames` 先逐帧 classify，再 classify verdict；each exactly once；throwing upstream never calls finish。
- [ ] 实现四个 adapters，复用 codec accumulator／现有 `openAIStreamErrorFrame`、Gemini error mapping、下沉后的 Anthropic builder；Chat Completions adapter 独占 `[DONE]` renderer。
- [ ] 在 candidate session 安装 adapter／grammar，并让 rendered frame／finish 的 typed outcomes 成为真实 producer；同一 commit 把 `CandidateBoundaryClassifier` 改为只消费 `complete-unit`／legal response terminal outcome 的 readiness projection，删除它自己的 JSON 解析。运行现有 hedge／boundary readiness 正样本，证明正确候选仍能 ready，且 raw-frame 第二 classifier mutation 变红。
- [ ] 保留 accumulator／renderer state，并提供只读 compatibility projection：现有 `commitBoundaries`／`sawMessageStop`／`sawUpstreamError` 只从 grammar outcome／terminal state 派生，供尚未迁移的 driver 消费，不再自行解析协议。Task 3 不删除这些字段。
- [ ] 调整 response processor 的 finish 顺序，删除 `yield* finish.frames` 旁路；compatibility projection 必须让旧 owner 路径的 terminal／truncation 行为和编译保持绿。
- [ ] Task 4 切换 driver 直接消费 grammar outcomes 的同一 commit 才删除 compatibility projection；禁止出现“旧 projection 已删、新 owner 尚未接管”的中间提交。
- [ ] 运行 adapter／processor／candidate-session 定向测试和现有 route candidate tests。
- [ ] 注入第二 JSON classifier、重复 finish frames、伪造 control capability mutation，确认 architecture／unit tests 红。
- [ ] 提交：`refactor: centralize delivery protocol classification`。

## Task 4：把现有 DownstreamDeliverySession 升级为 BlockDeliveryOwner

**Files**
- Modify: `src/lib/pipeline/delivery/{types,session}.ts`
- Create: `src/lib/pipeline/delivery/synthetic.ts`
- Modify: `src/lib/pipeline/client-sink.ts`
- Modify: `src/lib/pipeline/driver.ts`
- Test: `tests/pipeline/delivery-session.unit.test.ts`、`delivery-terminal-race.unit.test.ts`、`delivery-finish-race.it.test.ts`、`buffered-sink.unit.test.ts`

**Interfaces**
- `DownstreamDeliverySession` remains the one owner identity and serializer.
- Add `consume(outcome, adapter)` and `runSyntheticResponse` without exposing raw sink.
- Retry orchestration observes grammar outcomes but cannot write around owner.

- [ ] 写红测：unit commit、response-terminal atomic commit、half-block zero leak、single terminal、client-gone commit flag、owner failure、heartbeat independence、anchor allocation continuity。
- [ ] 在现有 session 内增加 candidate-local staging／outcome consumption；复用 serializer、wire state、allocation port、terminal fence，禁止第二 queue／serializer。
- [ ] 把 `runResponseBufferedSink` 改为通过 owner 消费 grammar outcomes；`retryCap=0` 仍缓冲；保留 continuation 和 anchor 语义。
- [ ] 删除 `writeWinnerFrames`／`writeWinnerFrame` 等 owner 外真实写出 helper；测试原语可保留但 production graph 不可达。
- [ ] 实现 `runSyntheticResponse`：完整 local candidate 经 adapter+grammar 验证后一次提交，畸形／缺 terminal 零部分写出。
- [ ] 跑全部 `tests/pipeline/delivery*`、allocation／anchor／continuation／hedge tests。
- [ ] 注入 route raw sink、second serializer、terminal 后 frame、owner 失败误报 committed mutation，确认红。
- [ ] 提交：`refactor: make delivery session the sole wire owner`。
