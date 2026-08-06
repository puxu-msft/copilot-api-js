# Responses ↔ Anthropic 语义桥规格评审记录

> **状态**：已完成；协议、架构与最新 master 重基增量复核均放行
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

至此所有评审与重基增量复核均闭合，无未决 finding。
