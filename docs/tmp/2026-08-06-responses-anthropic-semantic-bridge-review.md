# Responses ↔ Anthropic 语义桥规格评审记录

> **状态**：已完成；协议、架构与最新 master thinking 审计增量复核均放行
>
> **评审对象**：`docs/spec/2026-08-06-responses-anthropic-semantic-bridge.md`
>
> **首轮基线**：`63c784cc`（规格核验基线 `192dce69f1bf482b1c3130d519991594a3fe46ab`）

## 评审视角

| 视角 | 主责 |
|---|---|
| 协议与验收判据证伪 | 核 F1–F8、N1–N5、P0、AC；构造 false-green／false-red；检查真实 Claude Code WebSearch 外层行为 |
| 实施者第一人称走查 | 沿当前 hub、CellAssembly、双向 whole／stream translator、错误路由和 History 契约走 Phase 1–5 |

## 首轮结论

- 协议 verifier：1 BLOCKER。
- 架构 reviewer：0 BLOCKER、6 MAJOR。
- 两个 reviewer 的隔离 worktree 均保持干净。

## 发现与处置

### B1. Web Search 专用 lifecycle event 未纳入 known handler

- **原级别**：BLOCKER。
- **处置**：采纳（C）。
- **事实复核**：当前 OpenAI SDK 的 `ResponseStreamEvent` 包含 `response.web_search_call.in_progress`、`searching`、`completed`；本地 `ResponsesStreamEvent` 未建模，当前 translator 会落入 default。
- **失败场景**：按原规格启用 unknown fail-loud 后，合法 Web Search 进度事件会被拒绝；若继续忽略，则违反禁止 silent drop。
- **整改**：新增 F9；定义完整 Web Search lifecycle disposition、`output_index` 状态转换、完整序列正控及缺 added／重复／乱序反向控制；P0-3 改为真实外层 `WebSearch.call()`／CLI tool-use oracle。

### M1. Request／response registry 契约混用

- **原级别**：MAJOR。
- **处置**：采纳（C）。
- **事实复核**：Responses→Anthropic request translator 还承担 payload tools＋choice 联动、flat-item turn fold 和 carrier reconstruction，职责不同于 response item mapper。
- **整改**：拆成四张方向表；request handler 使用 `RequestItemDecision`，每个 request profile 必须有 `RequestPayloadCoordinator`；response handler 使用双平面 `BridgeDecision`。

### M2. 原 lifecycle router 只描述 Responses

- **原级别**：MAJOR。
- **处置**：采纳（C）。
- **事实复核**：Anthropic stream 使用 `content_block_start/delta/stop` 与 block `index`，不能套入 Responses `output_index` envelope。
- **整改**：改为 protocol adapter → 小 lifecycle algebra → handler 私有 state；Responses key 保留 `output_index`，Anthropic key 保留 block `index`。D2 明确该方案是择优，不是唯一可行实现。

### M3. Emission／collector／affinity 接口不足

- **原级别**：MAJOR。
- **处置**：采纳（C）。
- **事实复核**：原 `BridgeEmission` 未定义 citation；普通 tool result 与 server-tool result 未分型；continuation collector 与模型兼容边界没有接口。
- **整改**：定义 `BridgeCitation`、client/server tool call/result 分型、`ContinuationCollector`、`ContinuationBundle`、`ResponseRenderInput` 与 `SourceAffinity`；whole／stream 不得在 closure 私藏第二份 continuation 状态。

### M4. Unknown compatibility error 未接当前 commit seam

- **原级别**：MAJOR。
- **处置**：采纳（C）。
- **事实复核**：当前 live handler 已进入 `streamSSE`；renderer throw 会被 driver 折成 `stream-error` outcome，不能回到未提交 HTTP 响应。
- **整改**：定义 typed `BridgeCompatibilityError`；分别冻结 request、whole、buffered-uncommitted、live-committed 四格路由；live 格只允许目标协议合法 terminal error；driver outcome 保留原 Error 对象与结构化字段。

### M5. Disposition 没有 candidate owner 与 append-only SSOT

- **原级别**：MAJOR。
- **处置**：采纳（C）。
- **事实复核**：当前 `PipelineInfo.translation.anthropicToResponses` 是 request-global 单值槽，不能表达多 item、多 candidate；项目存在 generation candidate 与 winner selection。
- **整改**：每 candidate 使用 append-only collector；所有候选记录进 attempt/candidate 明细；只有 winner 投影到顶层 `pipelineInfo.bridgeDispositions`；新增窄 `appendCandidateBridgeDisposition` API，禁止复用 `recordFeature` 或单值 degradation 槽。

### M6. N2／N3 把择优写成伪必要性

- **原级别**：MAJOR。
- **处置**：采纳（C）。
- **事实复核**：原规格表格已承认方向专属 normalized value、每 handler 独立状态机可行，却仍声称窄 IR／共同 router“必须”。
- **整改**：N2／N3 改为 D1／D2 架构选择；补方向专属 normalized value、双协议 router 等可行方案；按长期维护、类型判别力和扩展性推荐窄 IR 与 adapter＋algebra，并规定 PoC 证伪后的回退条件。

## 整改后的新增验收

- Web Search 完整 lifecycle sequence 与生命周期反向控制。
- 外层 Claude Code `WebSearch.call()` 最终 `data` 与主 loop `tool_result` oracle。
- 四张方向表与 request payload coordinator 守卫。
- request／whole／buffered-uncommitted／live-committed 四格 compatibility error。
- candidate-local append-only disposition 与 winner-only 顶层投影。
- `response.web_search_call.searching` 误入 unknown、loser 污染 winner 等目标 mutation。

## 待复审命题

1. B1 与 M1–M6 是否全部闭合。
2. 新增接口是否足以让 planner 不再临场发明承重 contract。
3. D1／D2 是否正确区分可行性与择优，没有残留伪必要性。
4. 本报告是否忠实转录两位 reviewer 的首轮发现、严重度与处置。
5. 若只剩 minor，reviewer 应明确写“可定稿”。

## 第一轮复审结果

- 协议 verifier：**可定稿**。B1、Web Search lifecycle、外层 `WebSearch.call()` oracle 与对应 AC／mutation 已闭合。
- 架构 reviewer：0 BLOCKER、4 MAJOR。首轮 M1–M6 的方向已采纳，但整改新增接口仍有四个执行接缝。

## 第二轮发现与处置

### M7. 异构 stateful handler 无法类型安全进入 registry／router

- **原级别**：MAJOR。
- **处置**：采纳（C）。
- **事实复核**：原 `ResponseHandlerRegistry` 省略 State 泛型，router 又把 state 擦成 unknown；严格实现只能 cast。机器守卫中的 `whole-item-on-done` 也没有对应 contract。
- **整改**：定义 `defineWholeItemOnDoneHandler`／`defineStatefulResponseHandler` 两个 typed factory；两者在 `bindStream` 时闭包捕获 typed source／State，只向 router 暴露统一 `BoundResponseItemHandler`。Router 不保存泛型 handler 或裸 state。

### M8. Request disposition 发生在 candidate 创建前

- **原级别**：MAJOR。
- **处置**：采纳（C）。
- **事实复核**：driver S2 translate-out 在 generation preflight／candidate 创建之前执行；request context 没有 candidate handle。
- **整改**：拆 request-level 与 response candidate-level 两个 append-only SSOT。Request diagnostics 在 S2 后冻结一次，candidate／dispatch 只引用 frozen id/hash；response records 才写 candidate-local。顶层由 request records + winner response records 派生。

### M9. Affinity 未编码进 carrier wire

- **原级别**：MAJOR。
- **处置**：采纳（C）。
- **事实复核**：原 `ContinuationBundle` 有 affinity，但候选 `ResponsesContinuationEnvelopeV2` 只有 version + records，echo 后无法比较来源。
- **整改**：carrier envelope 编码 resolved model、provider、endpoint 与 compatibilityKey；请求 echo 经当前 route resolution 后比较。相同实际模型的不同 alias 可兼容，不同 provider／protocol family 默认不兼容。

### M10. Buffer 未 flush 不等于 HTTP headers 未提交

- **原级别**：MAJOR。
- **处置**：采纳（C）。
- **事实复核**：Responses 与已进入 Messages pump 的 streaming 路径均先进入 `streamSSE`，再调用 buffered／live sink；candidate buffer 状态不能改变已提交的 HTTP 200。
- **整改**：定义 `CompatibilityErrorRenderer` 与 typed error status/code；区分 request／whole headers-uncommitted、stream headers-committed/body-uncommitted、stream body-committed。后两者都保留 HTTP 200 并写 typed terminal error；driver outcome保留原 Error 与 `bodyCommitted`。

## 第二轮整改新增验收

- Typed handler factory 的 source／State 不经 unknown／any cast。
- Request dispositions 单份冻结，candidates 只引用 id/hash。
- Carrier affinity 随 wire 编码；alias 同源正控与跨 source 剥离反控。
- Streaming error 的 HTTP-header commit 与 body commit 分离，headers-committed/body-uncommitted 不调用 `c.json`。

## 第二轮待复审命题

1. M7–M10 是否闭合，且未在修复中引入同类接口缺口。
2. typed factory 是否真能承载异构 handler，而非把 cast 移入业务层。
3. request／response disposition SSOT 与 winner 投影时序是否可执行。
4. carrier affinity 是否足以支持 echo 后兼容裁决。
5. streaming compatibility error 的三个 commit 阶段是否与当前 handler seam 一致。
6. 若无 BLOCKER／MAJOR，明确写“可定稿”。

## 第二轮复审结果

- 架构 reviewer：0 BLOCKER、3 MAJOR。M7–M10 的方向继续成立，但 source typing、request diagnostics freeze/reference 与 retry gate 尚未闭合。

## 第三轮发现与处置

### M11. Stateful handler 的 source 仍经 `unknown`

- **原级别**：MAJOR。
- **处置**：采纳（C）。
- **事实复核**：第二轮 factory 已闭包封装 State，但业务 callback 仍接统一 `SemanticLifecycleEvent.source:unknown`；Web Search source map 也只列常规 complete 类型，漏 incomplete union。
- **整改**：分离 `WholeSourceByKind` 与 `LifecycleByKind`；lifecycle event 按 semantic kind／phase 映射 typed source，Web Search whole source包含 complete/incomplete union，progress source 使用三种官方专用 event union。两个 typed factory 把具体 source／State 封进统一 bound closure；唯一异构类型擦除限制在 bridge-core factory，并由 runtime kind guard + mutation 保护。

### M12. Request diagnostics 缺 freeze/reference 状态机

- **原级别**：MAJOR。
- **处置**：采纳（C）。
- **事实复核**：S2 在 candidate 前执行；第二轮只有 append API 与结果形状，未定义 reject／throw 如何冻结、hash 输入或 reference 载体。
- **整改**：定义 open→frozen collector；S2 `try/finally` 在 success／compatibility reject／unexpected throw 三路恰好 freeze 一次；canonical `{version,records}` hash 不含 id。Frozen diagnostics 放入 `RequestState`，candidate fork 继承 deep-frozen 值，dispatch metadata 只引用 id/hash；无 candidate 的 S2 reject 仍投影 request History。

### M13. `BridgeCompatibilityError` 会被 buffered retry 重放

- **原级别**：MAJOR。
- **处置**：采纳（C）。
- **事实复核**：当前 buffered catch 对非 client-abort throw 先记 `thrown`，后续 `classifyStreamError==="other" && !committedAny` 会重试；compatibility error 是永久语义错误，不应重开上游。
- **整改**：error 增 `retryable:false` 与 type guard；buffered catch 在 transport 分类前立即返回 typed stream-error，不增加 attempt／reset／escalate／exchange／continuation；semantic retry registry 不 claim。正控固定 request error=0 dispatch、response error=1 dispatch，mutation 把它重新送入 transport retry 必红。

## 第三轮整改新增验收

- WholeSource／LifecycleByKind 映射覆盖 complete/incomplete Web Search 与三种 progress event；业务 callback 不接 unknown source／state。
- Request diagnostics 三出口恰好冻结一次，canonical hash 稳定，candidate 只引用 id/hash。
- Compatibility error 永不进入 buffered／semantic retry；dispatch 计数与原 typed error 传递可观测。

## 第三轮待复审命题

1. M11–M13 是否闭合，且 typed source 没有把 cast 移到 adapter／业务边界。
2. Request diagnostics success／reject／throw 的 freeze/reference／History 时序是否完整。
3. Compatibility error 是否在所有 retry／continuation gate 之前 fail-fast。
4. 若无 BLOCKER／MAJOR，明确写“可定稿”。

## 第三轮复审结果

- 架构 reviewer：0 BLOCKER、2 MAJOR。M11–M13 的主体契约已闭合；剩余问题是 Anthropic nested delta 类型写法会化为 `never`，以及 response dispatch 总数判据过严。

## 第四轮发现与处置

### M14. Anthropic nested delta 的 `Extract` 结果为 `never`

- **原级别**：MAJOR。
- **处置**：采纳（C）。
- **事实复核**：SDK 的 outer `RawContentBlockDeltaEvent.delta` 是 union；`Extract<RawMessageStreamEvent,{delta:{type:"text_delta"}}>` 不对嵌套 union 分配。最小 `tsc --strict --noEmit` 探针确认旧类型为 `never`；先提取 outer event、再重建窄 delta 后，text delta 可赋值、thinking delta 被拒绝。
- **整改**：分离 `WholeSourceByKind` 与 `LifecycleByKind`；用 `ItemLifecycleEvent<Kind,Whole,Progress,Delta>` 给业务 callback 按 phase 提供 typed source。Responses Web Search whole source包含 complete/incomplete union，progress source 使用三种官方事件；Anthropic delta 使用 outer event + 窄 delta 重建。唯一异构擦除只留在 core factory，并有 runtime kind guard／错误 kind mutation。

### M15. Response compatibility error 总 dispatch=1 是 false-red

- **原级别**：MAJOR。
- **处置**：采纳（C）。
- **事实复核**：response bridge 运行前可已有 reactive retry、rate-limit 重开或 primary＋hedge dispatch。固定总数 1 会迫使实现禁用合法重试／hedge。
- **整改**：不变量改成“compatibility error 观测后 dispatch 数不再增长，当前 candidate 不启动 recovery／continuation”；无前置 retry／hedge fixture 仍断言基准值 1。Error 标记 `retryable:false`，buffered catch 在 transport 分类前 fail-fast，semantic retry registry 不 claim。

## 第四轮整改新增验收

- TypeScript assignability 正控：每个 typed lifecycle source 接受合法 phase source，并拒绝 sibling delta。
- Complete／incomplete Web Search whole source 与三种 progress source 均在 registry 类型中。
- 无前置重试 fixture：response compatibility error 总 dispatch=1；有前置 retry／hedge fixture：错误出现后的 dispatch delta=0，当前 candidate 无 recovery／continuation。

## 第四轮待复审命题

1. M14／M15 是否闭合，且类型擦除没有泄漏到业务层。
2. Dispatch 判据是否既防 compatibility retry，又不误禁合法前置 retry／hedge。
3. 若无 BLOCKER／MAJOR，明确写“可定稿”。

## 第四轮复审结果

- 架构 reviewer：**可定稿**，0 BLOCKER、0 MAJOR。
- M14 已闭合：WholeSource／LifecycleByKind 分离，complete／incomplete Web Search 与三种 progress event 均有 typed source；Anthropic delta 采用 outer-first Extract + nested delta 重建，type-level 正负控制可判别。
- M15 已闭合：不抹除 compatibility error 前的合法 retry／hedge dispatch，只禁止错误观测后的新增 dispatch、recovery 与 continuation；无前置 dispatch fixture 单独固定基准总数 1。
- reviewer 复核本记录对 M14／M15 的事实、级别与处置转录忠实。
- reviewer 隔离 worktree 结束时 `git status --short` 为空。

## 最终结论

| 视角 | 最终 verdict | 未决 BLOCKER／MAJOR |
|---|---|---:|
| 协议与验收判据证伪 | 可定稿 | 0 |
| 实施者第一人称架构走查 | 可定稿 | 0 |

首轮至第四轮共处置 1 BLOCKER、15 MAJOR，全部采纳并经原 reviewer 复审闭合；无驳回 finding，无待第三方裁决项。

## 重基后增量复核

规格分支从 `192dce69` 重基到最新 master `285dc571`，两份文档 SHA-256 在重基前后完全一致。新 master 增加 empty-body HTTP 499 → `network_error` → network retry 一次的行为，并确认 retry registry 已是三条生产腿的共享实时来源。该改动不推翻规格，却扩大了“宽错误分类可能误收永久 compatibility error”的相邻风险：`BridgeCompatibilityError` 必须在 `classifyError`、buffered transport retry 与 semantic retry registry 之前由 `isBridgeCompatibilityError` 专门分流。M13 的 `retryable:false`、错误后 dispatch delta=0 与 registry 不 claim 判据继续成立。

### 增量复核结果

- 架构 reviewer：**增量复核通过，可定稿**，0 BLOCKER、0 MAJOR。
- `285dc571` 与 `d2607ec9` 均为重基后规格分支祖先；重基前后两份文档内容哈希一致。
- `d2607ec9` 只扩大普通 `HTTPError` 的 network retry 分类面；按规格先执行 `isBridgeCompatibilityError` 时，typed compatibility error 不进入 `classifyError`、buffered transport retry、semantic retry registry 或 continuation。
- M13、mutation、守卫 17 与 AC17 继续充分：错误观测后 dispatch 增量为 0，无 recovery／continuation，原 typed error 到达 handler。
- 无需新增验收。

至此该轮评审与重基增量复核均闭合，无未决 finding。

### 最终状态短复审

原架构 reviewer 对 commit `11720c53` 仅复核 wrap-up 状态、最新 master 基线、重基增量转录与 finding 计数，最终 verdict：**最终状态通过**。Reviewer 隔离 worktree 保持干净。

## Thinking 翻译审计增量复核

规格分支再次从 `285dc571` 重基到 master `d00b0d82`，随后吸收只新增 History／HTTP2 诊断计划的 `b6fb0947`。第一次重基前后规格与评审记录的 SHA-256 分别保持 `26f27a04ee96d8bcbb1c0e1ea36ccaed7e88edaae2603d47be617a5990b37fd5` 与 `1fb60544362b91a6567487613b50d5c0a989299d7b5ce2f6b5ff96cf7007ebff`；第二次重基前后更新后的两份文档 SHA-256 分别保持 `c32ece0b4fd31408bd446002454ab766ac0f3d289740e9d215ab645a69c37014` 与 `afa54605c2ba777aac519f1dcea1e07a019ef9e94dd66a419a611434f8cfdf47`。两次重基本身均未改变文档内容。

`d00b0d82` 新增 thinking 翻译审计与真实 GHC Responses carrier 探针；`b6fb0947` 只新增 `docs/plan/2026-08-06-history-read-path-and-h2-diagnostics.md`，不触及本规格的协议、实现接缝或目标文档。主会话初步对账认为：探针只证伪“跨模型旧 `encrypted_content` 必然 400”，而本规格没有采用该机制断言；本规格要求 carrier 按冻结的 affinity／compatibility policy 决定恢复或剥离，并把具体兼容判据留给 Phase 0 冻结。新审计还独立确认 server-tool 四格、per-item lifecycle、多 reasoning 单槽、request carrier policy 与顶层能力诊断缺口；它们是否已被本规格的通用 contract 充分覆盖，交由下述短复核裁决。

### 增量复核结果

- 架构 reviewer：0 BLOCKER、4 MAJOR。新证据不推翻 F1–F9 或 D1–D2；规格确实没有声称跨模型 `encrypted_content` 必然 400。Server-tool 四格与多 reasoning per-item owner 已有结构约束，但以下四类只有泛化目标，没有足以判错的 AC／mutation／guard。
- `b6fb0947` 只新增 History／HTTP2 诊断计划，与本规格无协议或实现接缝。
- Reviewer 结论：**修复 MAJOR 后可合入；当前不满足“增量复核通过，可合入 master”**。

### M16. 目标 Responses emitter 生命周期未冻结

- **原级别**：MAJOR。
- **处置**：采纳（C），待复审。
- **事实复核**：当前 Anthropic→Responses stream 缺 message `output_item.added` 与 reasoning `reasoning_summary_part.added`；官方 OpenAI SDK accumulator 会分别报 missing output／content，而项目自有宽松 accumulator 与既有 62 条测试仍绿。
- **失败场景**：source lifecycle router 全部正确，目标 renderer 仍可发出官方客户端无法消费的事件序列；现有 AC1–AC20 无法区分。
- **整改**：新增目标 Responses lifecycle grammar，分别冻结 message text、reasoning summary、function call 与 completed／incomplete terminal 的必需偏序；官方 OpenAI SDK accumulator 与事件订阅作为独立 oracle；新增对应 unit、mutation、守卫 23 与 AC21。

### M17. Request coordinator 未保证 block／item 相对顺序

- **原级别**：MAJOR。
- **处置**：采纳（C），待复审。
- **事实复核**：现有双向 translator 均会把 `tool→text` 改写为 `text→tool`；只声明 fold／expand 无法阻止按 kind 分桶。
- **失败场景**：四张 registry、payload coordinator 和 unknown policy 全部存在，合法 text／tool 仍可被语义重排而所有旧 AC 保持绿。
- **整改**：请求 handler 输出携 immutable `sourceOrdinal`，coordinator 稳定保序；reasoning 顺序例外必须显式、经 per-pair oracle 冻结且不得重排非 reasoning 兄弟；新增交错正控、重排 mutation、守卫 22 与 AC22。

### M18. Function-call 无 delta 时可丢完整 arguments

- **原级别**：MAJOR。
- **处置**：采纳（C），待复审。
- **事实复核**：合法 `output_item.added → output_item.done` 无 arguments delta 的流，当前生成空 `tool_use.input`；handler 虽能看到 delta 和 whole item，规格未裁决权威值。
- **失败场景**：按现有 lifecycle contract 实现仍可只信 delta，合法无-delta 流静默变空 input。
- **整改**：`.done.arguments` 作为零 delta 权威 fallback；有 delta 时按 canonical JSON value 与 done 比较，等价表示不误拒，冲突／损坏返回 `invalid-lifecycle`；whole／stream 共用 mapper；新增三格正负控制、mutation、守卫 24 与 AC23。

### M19. 顶层 capability 字段可绕过 unknown-item 守卫静默丢失

- **原级别**：MAJOR。
- **处置**：采纳（C），待复审。
- **事实复核**：Responses `text.format` 与 Anthropic `output_config.format` 均存在但 schema 不同；两端 `context_management` 同名不等于策略兼容。它们是已知顶层字段，不会进入 item unknown policy。
- **失败场景**：profile 的 item registry 完备，coordinator 仍可删除 structured output／`context_management` 且 AC2 假绿。
- **整改**：request profile 必填穷尽 `TopLevelCapabilityRegistry`，每字段显式 mapped／degraded／rejected；新增 P0-5 实测与用户／ADR 裁决门，禁止实施者猜 schema name／策略兼容；新增双向正负控制、mutation、守卫 21 与 AC24。

### 第五轮复审结果

- 架构 reviewer：0 BLOCKER、3 MAJOR。M16 已闭合；M17–M19 的方向正确，但仍有三个接口缝使 planner 必须临场补承重规则。
- 目标 Responses grammar 能同时咬住错误状态并允许零 delta／多 item；P0-5 已把 structured-output name 与 `context_management` 策略分叉交给用户／ADR。
- Reviewer 结论：**修复 MAJOR 后可合入；当前仍不可宣称“增量复核通过，可合入 master”**。

### M20. Function arguments 专用 done 未进入 typed lifecycle

- **原级别**：MAJOR。
- **处置**：采纳（C），待复审。
- **事实复核**：项目 `FunctionCallArgumentsDoneEvent` 已建模并进入 `ResponsesStreamEvent`；既有 accumulator 把专用 done 与 `output_item.done` 视为双终结。第五轮规格却让 function lifecycle progress 为 `never`，业务 handler 无法收到专用 done。
- **失败场景**：错误实现只比较 delta 与 item-close，漏掉两种 done 冲突仍可通过；正确实现若尝试接专用 done，反而无法类型化。
- **整改**：把 `FunctionCallArgumentsDoneEvent` 纳入 typed `item-progress` source；state 分别保存 delta、专用 done 与 item-close done，专用 done 不提前 finalize；item close 更新 state 后统一 canonical 比较并 finalize，重复同值幂等、重复异值／冲突／缺 item-close fail-loud；同步 mutation、守卫 24 与 AC23。

### M21. Reasoning 顺序例外没有 profile-owned contract

- **原级别**：MAJOR。
- **处置**：采纳（C），待复审。
- **事实复核**：第五轮 `OrderedRequestEmission` 只有 ordinal，profile 没有 ordering policy；散文引用了未定义的“per-pair capability 表”。
- **失败场景**：实施者只能私设 kind 分桶，守卫无法区分合法 reasoning 前置与任意重排。
- **整改**：新增 profile-owned、scope 固定为 `within-source-group` 的 `RequestOrderingPolicy<Emission>` 与 core `orderRequestEmissions`；emission 携 `sourceGroupOrdinal/sourceOrdinal`，排序 primitive 返回 branded sequence，coordinator 不能绕过。只允许组内完全保序或组内稳定 reasoning-first，后者在类型上只能移动 `reasoning`，保持两个分区内部顺序且禁止跨 user／assistant turn；同步双向正控、mutation、守卫 22 与 AC22。

### M22. 顶层 registry 与 coordinator 形成双 owner

- **原级别**：MAJOR。
- **处置**：采纳（C），待复审。
- **事实复核**：第五轮 coordinator 仍声称映射 scalar／instructions／system；capability rule 可读写整份 target，且没有 patch 边界、执行顺序或冲突裁决。
- **失败场景**：registry key／disposition 齐全时，coordinator 仍可覆盖结果；两个 rule 冲突可 last-write-wins，AC24 假绿。
- **整改**：registry 成为 top-level 唯一 owner；rule 只返回受限 patches＋disposition，mapped path 仅从 patches 派生，core 按与 registry key 精确相等的冻结 order 原子应用并拒绝重复 path；`tools+tool_choice` 为单一 capability。Coordinator 不接原始 payload／target，只接 branded ordered emissions并返回 target items；core 通过唯一 `targetItemsField` 最终装配，且 top-level field 与 items field 必须不相交。同步正负控制、mutation、守卫 21 与 AC24。

### 第六轮待复审命题

1. M20–M22 是否逐项闭合，且没有把类型擦除、双 owner 或隐式 policy 移到另一层。
2. Function typed progress、双 done state 与 item-close finalize 是否同时防漏冲突和 false-red；缺 item-close 或专用 done 晚到的处置是否明确。
3. `RequestOrderingPolicy` 是否只有两个可执行分支、强制走 branded sequence，reasoning-first 是否只能在同一 source group 内移动 reasoning 并稳定保留两分区顺序。
4. Capability registry／冻结 order／受限 patches／items-only coordinator／唯一 items assembler 是否机械消除 top-level 双 owner 与 last-write-wins。
5. 更新后的 mutation、正确状态、守卫 21–24 与 AC22–AC24 是否分别有判别力。
6. 若无 BLOCKER／MAJOR，明确写“增量复核通过，可合入 master”。

### 第六轮复审结果

- 架构 reviewer：**增量复核通过，可合入 master**，0 BLOCKER、0 MAJOR。
- M20 已闭合：`FunctionCallArgumentsDoneEvent` 进入 typed progress；三源 state 由 item-close 唯一 finalize，缺 close／晚到／冲突 fail-loud，canonical 等价与重复同值不 false-red。
- M21 已闭合：policy 只有 preserve 与 scope 固定为 `within-source-group` 的 reasoning-first 两支；group／item ordinal 保证组间不动，coordinator 只接受 branded `OrderedRequestSequence`。
- M22 已闭合：registry 是 top-level 唯一 owner，patch＋disposition 原子应用并拒绝重复 path；coordinator 不接 payload／target，只产 items，唯一 assembler 写入与 top-level fields 不相交的 items field。
- Mutation、正确状态、守卫 21–24 与 AC22–AC24 对目标缺陷有双向判别力；未发现阻断正确零 delta、多 item、canonical-equivalent JSON 或合法 degraded capability 的 false-red。
- Reviewer 复核本记录对第五轮结果、M20–M22 的级别、事实、处置与待复审命题转录忠实；隔离 worktree 结束时 `git status --short` 为空。

至此 thinking 审计增量的 7 个 MAJOR 全部采纳并经原 reviewer 复审闭合；连同首轮至第四轮，累计处置 1 BLOCKER、22 MAJOR，无未决 finding。
