# Spec：HTTP/2 CANCEL 来源归因与 response-header deadline 作用域修复

- **状态：** Approved（用户 2026-08-06 批准三阶段渐进实施；允许阶段性无消费者基础设施先并入主线；每个自洽阶段验证后立即合并 `master`）
- **日期：** 2026-08-06
- **范围：** 上游 HTTP 请求的 response-header deadline、HTTP/2 stream termination provenance、History/诊断投影
- **相关：** [upstream-http2-transport](upstream-http2-transport.md)、[block-level buffered retry ADR](../decisions/2026-07-11-block-level-buffered-retry.md)、[request lifecycle cancel/settle/quiesce RFC](../rfc/2026-07-14-request-lifecycle-cancel-settle-quiesce.md)

## 实施状态

截至 commit `bea1dfa3d61896bf2089958676bd1236269877d9`（2026-08-08），**阶段 1 已完成并合入本地 `master`；阶段 2、3 尚未开始，父任务仍为部分完成**。

阶段 1 的实现提交为：

- `0f9023b2`：建立可解除的 response-header deadline primitive，并让 `upstreamFetch` 在 transport resolve/reject 后解除它。
- `b1a0f6e6`：迁移全部 HTTP 调用点为独立 duration，保留 WebSocket first-event signal。
- `88bb1039`：把 deadline primitive 下沉到 transport 叶子，避免 `upstream-fetch → fetch-utils → context` 新增 SCC；同时把通用 model-pattern matcher 归位。
- `7cf1e896`：为 HTTP/2 post-response abort listener 建立具名幂等 cleanup，并覆盖 natural end、abort、physical close、`onStreamClosed` 与 reservation 回零。
- `bae83f01`：应用仓库 lint 修复；`0732fc76` 将 lossless shutdown 主线语义合入阶段分支；`a0ad0f1a`、`da584116` 随后闭合 lint gate、校准 discovery baseline 与 H2 时序测试。
- `03a84bcb`：闭合独立评审发现，whole/streaming Responses usage 复用单一 mapper，并以真实 shared-send 运行时 oracle 替代实现字符串正向断言。
- `b0d9dbf0`、`bea1dfa3`：把交付窗口内前进的主线（`d59a622c`、`82c0664e`）并入阶段分支。`b0d9dbf0` 逐 hunk 解决三处冲突——`count-tokens` 同时保留 History admission 外壳与 scalar `responseHeaderTimeoutMs`、refusal projection 同时保留 `historyTestReservation` 与逐字常量、discovery baseline 取两侧并集；`bea1dfa3` 只并入三份与本阶段零交集的 semantic-bridge 文档。

在该 commit 上的验收证据：

- `bun run typecheck`：通过。
- `bun run lint:all`：通过；不属于 root tsconfig 的三个独立脚本/fixture 使用 typescript-eslint 官方 `disableTypeChecked`，仍保留普通语法与格式 lint。
- `bun run test:backend`：`7279 executed / 30 skipped / 0 fail`；`tests/infra/entry-test-discovery-baseline.json` 冻结 `minimum_executed=7279`、712 个文件、30 条 allowed skips，16 个 shard JUnit 叶节点独立重算为 `7309 testcase − 30 skipped = 7279 executed`、0 failure/error。合并前分支单独口径为 `7244`，该数字已被合并态取代。
- 定向 deadline、H2、cancel、WS、shutdown、count-tokens/History admission 与 translator 验收：独立 verifier 与独立 code reviewer 均对最终 tip 复评 PASS（0 blocker、0 major、0 minor）。
- exact-patch mutation 双控：删除 deadline signal 接线、删除 resolve/reject disarm、只保留 deadline signal、跳过 timer clear、删除幂等门、删除 H2 natural-end/close detach、删除 shared-send 的真实 duration property，分别使其目标判据精确变红；每次均在 `git apply --reverse --check` 后反向恢复，恢复态全绿。

阶段 1 保持 2026-08-08 主线确立的 lossless shutdown 契约：第一次进程信号不向已接收请求注入 shutdown abort；header deadline 只与 client/reaper/dispatch 等 request-owned lifecycle signal 分离，不复活已删除的 shutdown→request cancel/529 rewrite。

## 1. 问题与裁决

生产 History 中大量 generation 以 `Stream closed with error code NGHTTP2_CANCEL` 失败。单看这条 Bun `node:http2` 错误无法判定谁发起了 CANCEL：peer 发 `RST_STREAM(CANCEL)` 与本地调用 `ClientHttp2Stream.close(NGHTTP2_CANCEL)` 都可能产生同一错误文本。当前 transport 将 post-header body error 与 close-before-end 都标成 `mid-body-close`；这个标签说明阶段，却不说明发起方，上层仍只能靠错误字符串、请求状态和经过时间猜测来源。

修复前，`createResponseHeaderTimeoutSignal()` 返回不可解除的 `AbortSignal.timeout()`。`sendUpstreamHttp()` 将它与 shutdown/client/reaper/dispatch signal 合并后传给 `upstreamFetch()`；`http2Fetch()` 收到响应头后仍继续监听这个 composite signal，并在其 abort 时关闭 body stream。因此，名义上只覆盖“发请求到收到响应头”的 deadline 实际延伸到整个响应 body 生命周期。阶段 1 已在上述实施 commit 中解除该作用域泄漏。

用户裁决如下：

1. 渐进实现根本修复；每个阶段形成可部署终态、验证后立即合并 `master`。
2. 允许类型、记录字段和生产者 primitive 在暂时没有消费者时先并入主线；后续阶段必须接上，不以“死代码”否决正确基础设施。
3. 不启用、不扩展旧 `anthropic.protect_streaming_generation` whole-response L2。它不符合新的 block-level buffering，未来会删除。
4. 本任务不改变 block-level commit、continuation retry、`partial-degrade` 或 endpoint 默认策略；只修 transport 事实与其消费方式。

## 2. 目标与非目标

### 2.1 目标

1. response-header deadline 只覆盖获取响应头之前；响应头到达后，合法长 body 不受该时钟影响。
2. transport 在 close 动作或 close 事件的产生点追加 termination evidence，不再靠错误字符串反推。
3. 本地取消保留原始 `CancellationCause`；Bun 随后产生的同文本 `NGHTTP2_CANCEL` error 作为后续 stream evidence 保留，不得覆盖本地 intent。
4. peer stream reset、session termination、本地 signal、本地 body cancel、自然结束可区分；对 wire 到达与 JS listener 调度之间不可观测的因果顺序，只报告 `firstObserved` 和完整 evidence，不声称真实发起方。
5. canonical `ModelOperationDispatch` 保存结构化 termination observation；History REST、诊断日志和 UI 类型从该单一事实源投影。
6. 新分类不得改变已有 block-level recovery 的产品契约；retry admission 必须显式消费允许的 termination 集合。

### 2.2 非目标

1. 不阻止 GHC 发 `RST_STREAM(CANCEL)`；本任务只能正确归因并让现有恢复机制据事实裁决。
2. 不新增 whole-response buffering，不翻转旧 L2 开关。
3. 不重写全部 transport 或请求生命周期状态机。
4. 不回填旧 History。旧记录缺少 termination 时字段保持 absent，不伪造 unknown observation。
5. 不以 History 样本数量、固定持续时间或固定帧数作为运行时判据。

## 3. 核心不变量

### 3.1 时钟作用域

被测对象是“等待 response headers 的阶段”，不是整个 fetch 对象的存活期。deadline 必须在以下任一事件先发生时结束：

- response headers 到达：watchdog 正常解除，body 生命周期不再受它影响；
- deadline 到期：仅该 dispatch 被取消，抛出的错误保留 `TimeoutError` 身份；
- shutdown/client/reaper/dispatch signal 先到：保留原始 abort reason，header watchdog 只清理自身；
- transport 在 headers 前失败：保留真实 transport error，header watchdog 只清理自身。

任何实现若只在 `sendUpstreamHttp()` 返回后忽略 timeout error，而底层 timer 仍能关闭 stream，都不满足本不变量。解除动作必须发生在拥有“headers 已到”事实的 transport 边界。

### 3.2 事实与策略分离

`TransportTerminationObservation` 只描述本进程观察到的 transport evidence；`TransportErrorReason` 继续描述上层错误分类/retry 所需的语义。二者不得合并成一个枚举：同一组 evidence 可因 pre/post-header、是否已提交语义内容、协议保证不同而采用不同策略。

建议的事实模型：

```ts
export type TransportTerminationEvidence =
  | { kind: "local-signal"; observedAt: number; code: number; cause?: CancellationCause }
  | { kind: "local-body-cancel"; observedAt: number; code: number }
  | { kind: "stream-error"; observedAt: number; code?: number; errorCode?: string }
  | { kind: "stream-close"; observedAt: number; code?: number }
  | { kind: "session-error"; observedAt: number; errorCode?: string }
  | { kind: "session-close"; observedAt: number }

export interface TransportTerminationObservation {
  firstObserved: TransportTerminationEvidence["kind"]
  attribution: "local" | "peer" | "session" | "ambiguous" | "unknown"
  evidence: ReadonlyArray<TransportTerminationEvidence>
}
```

字段名可在实现计划中按项目命名风格细化，但判别能力不得下降。`code` 保存数字 HTTP/2 error code；日志可另渲染 `NGHTTP2_CANCEL` 等符号名。自然 `end` 是内部终态，不写 failure observation。GOAWAY 只表示 session 停止接收新 stream；在途 stream 若继续正常结束，不得因 GOAWAY 被标为 session termination。

### 3.3 Evidence 追加与归因

本地代码在调用 `req.close(code)` 前必须原子追加 local intent evidence。后续 Bun `ERR_HTTP2_STREAM_ERROR`、stream close、session error/close 继续追加，不能被 first-writer 丢弃。`firstObserved` 只表示 JS 层最先观察到什么，不等于 wire 上真正先发生什么。

observation snapshot 可随 evidence 追加而重新派生；canonical settlement 与 recovery 决策必须在 stream/dispatch quiescence 后读取最终 snapshot。归因规则如下：

- 只有 local intent，且尚无 stream/session 结构证据：当前 snapshot 为 `local`。
- 无 local intent、无 session evidence，且有非零 stream `rstCode`/结构化 stream error：`peer`。
- 无 local intent、无 peer reset evidence，且有 session error/close：`session`。
- local、peer reset、session 三类机制中任意两类或三类 evidence 共现：`ambiguous`，保留全部 evidence；共现不能证明哪类事件导致另一类。Bun 对本地 `req.close(CANCEL)` 产生的 error 回声也落此规则，因为同一形状可能是已到 socket但尚未派发 listener 的 peer RST，不得用 first-writer 宣称真实发起方。
- 只有 `rstCode=0` 的 bare close、只有字符串、或没有结构证据：`unknown`。

`unknown` 不是首个事件写入的 evidence；它是 quiescence 后证据仍不足的派生 attribution，因此后到的 session/peer evidence不会被吞掉。

### 3.4 peer/session 判定要求结构证据

- stream 在 `error`、`end` 或 `close` 任一事件上暴露非零 `rstCode`，或出现结构化 stream error，才构成 peer evidence；是否归因 peer还取决于是否同时存在 local/session evidence。非零 `rstCode` 的 `end` 不是 clean end，必须进入失败路径。
- session 的 `error`/`close` 只在 stream observer 仍注册时追加；stream `close` 后立即解绑，不用事件循环延迟吸收后到的 session event。该规则宁可将迟到的真实 session teardown 保守留为 peer/unknown，也不把无关 session close 错归当前 stream。单独 GOAWAY 只 retire session，不构成在途 termination。
- 只有字符串含 `NGHTTP2_CANCEL`、只有 `rstCode=0`、或只有“close before end”时，证据不足，最终 attribution 必须是 `unknown`。
- 自然 `end` 后的 `close` 视为正常内部终态，不得产生 failure observation。

### 3.5 canonical History 所有权与方案取舍

termination observation 属于一次 physical dispatch。选择在 `ModelOperationDispatch` 增加一等 typed 字段，是因为它提供后端 SSOT、union 穷尽检查和直接 REST/UI 投影；这不是唯一可行形状。未采用 typed dispatch diagnostic／`settlementExtensions`：两者也能持久化，但前者把核心终态事实伪装成可重复诊断，后者是 opaque bag，都会削弱编译期约束。

数据流如下：

1. `http2-client` 追加 `TransportTerminationEvidence` 并提供可重算的 `TransportTerminationObservation` snapshot；最终消费者在 quiescence 后读取；
2. transport/driver 为每个dispatch提供`{getObservation, lifecycleQuiesced, terminationQuiesced}`；后两者分别代表iterator cleanup与physical stream close/evidence finalization。所有settlement/recovery先依次等待两道transport barrier，再取最终observation；
3. `RequestContext` 的 logical terminal只保存runtime raw error与持久化snapshot并seal scope；finalizer先等operation quiescence，再等未settled final dispatch的transport quiescence，最后调用canonical recorder的`settleDispatch()`写入`ModelOperationDispatch.termination`；
4. V3 manifest 原样持久化；
5. `recordToHistoryEntry()` 投影到 `attempts[].transportTermination`；
6. `ui-v4` 经 `~backend/*` re-export 使用后端类型。

`dispatchReason` 和 `error` 保留供人读与兼容；它们不再是 termination attribution 的事实源。

## 4. Provenance 图

| Evidence | 生产者 | 观测点 | 上游来源 |
|---|---|---|---|
| local signal | `http2-client` 的 AbortSignal listener | 调用 `req.close()` 前追加 intent | signal.reason；request/reaper/dispatch/client/shutdown 由 `CancellationCause` 标记 |
| local body cancel | WHATWG `ReadableStream.cancel()` | 调用 `req.close()` 前追加 intent | body consumer 主动释放 response |
| stream error/close | `ClientHttp2Stream` error/close | 每个事件均追加，不因已有 local evidence跳过 | peer frame、local close回声或 session teardown；最终结合全部 evidence归因 |
| session error/close | `ClientHttp2Session` error/close | session listener追加到仍 active的 stream | 整条 H2 session 异常结束 |
| natural completion | stream `end` 后 `close` | body adapter 的 `ended` 状态；不持久化 failure observation | peer 正常 END_STREAM |

local 与 peer evidence 的生产者独立，但事件调度顺序不能证明 wire 因果顺序。故 observation 同时保留 `firstObserved` 与完整 evidence；归因冲突时诚实标为 `ambiguous`。

## 5. 渐进实施阶段

### 5.1 阶段 1：response-header deadline 作用域

#### 产物

- 把 header deadline 从一般 `signal` 中拆出，建立可解除的 header-phase primitive。
- `UpstreamFetchInit` 明确区分生命周期 signal 与 response-header deadline；调用方不能再用一个不可解除的 composite signal 表达两个不同作用域。
- `upstreamFetch` 统一拥有“建立 watchdog → 交给选中的 transport → headers 到达或 fetch reject 时解除”的生命周期；HTTP/2 与 undici/plain HTTP 路径共享同一语义，不能只修 https。
- HTTP/2 在 `response` 事件处报告 headers 已到，之后只保留一般生命周期 signal 对 body 的控制。
- `TimeoutError`、shutdown、client、reaper、dispatch 的既有分类保持不变。

#### TDD

1. headers 到达后超过 header deadline，body 仍能自然读完。
2. headers 未到时 deadline 到期，dispatch 失败且保留 `TimeoutError`。
3. headers 与 deadline 同 tick 竞争只有一个终局。
4. 非 header signal 在 body 阶段仍能取消 stream。
5. reservation、listener、timer 在所有终局释放一次。
6. 正向变异：删除 headers-arrived disarm，第一条必须变红；把一般 signal 一并解除，第四条必须变红。

#### 合并门

定向 transport 测试、typecheck、架构守卫、`bun run test:backend`、独立代码 review 均通过。提交后立即合并 `master`。

### 5.2 阶段 2：termination provenance 生产与策略接线

#### 产物

- 在 `packages/foundation` 定义共享 `TransportTerminationEvidence`、`TransportTerminationObservation` 和追加/派生 primitive；core 不复制类型。
- `http2-client` 追加 local signal、body cancel、stream error/close、session error/close evidence，并提供可重算 observation snapshot；canonical/recovery 在 quiescence 后读取最终值，正常 end不产生 failure observation。
- transport error 保留当前 evidence snapshot through cause chain；local evidence 同时保留 `CancellationCause`。
- `classifyError` 和 block-level recovery 从结构化 observation/`TransportErrorReason` 显式裁决，不把所有 `mid-body-close` 或所有 `NGHTTP2_CANCEL` 统一视为同一来源。
- 允许阶段内先合入尚无 History 消费者的类型/producer，但阶段结束前 live error classification 必须已消费它；History 消费留给阶段 3。

#### Recovery 边界

- attribution 为 `peer`/`session` 可进入现有 transport-cut 分支，但是否透明重试仍受 block-level 已提交边界和既有预算约束。本任务不新增 server-execution-risk gate：当前 buffered recovery 没有该 gate，擅加会改变既有产品契约；相邻的 server-tool 双执行问题仍由其既有独立设计处理。
- attribution 为 `local`、`ambiguous`、`unknown` 不得被当成 upstream cut 重试。
- 无 observation 的 non-H2/legacy transport 保留原 fallback，避免本轮误改其它 transport。
- `REFUSED_STREAM` 的 RFC 9113 零处理保证保持独立，不被本阶段稀释。

#### TDD

1. Bun 本地 `req.close(CANCEL)` error 回声保留 local intent和后续 stream evidence；只有 local evidence时归 `local`。
2. local signal 保留 request-deadline、stale-reaper、request-cancel、dispatch-cancel、client-disconnect、shutdown 等 cause。
3. Bun测试进程内的公开h2c wire fixture实测产生非零peer RST=2，production `http2Fetch` 客户端观测该wire并归`peer`；独立collector单测验证code8字段保真，不冒充真实CANCEL wire重放。可选Node腿仅作跨runtime校准。
4. local intent与非零peer reset evidence并存时归`ambiguous`，两侧evidence均保留。
5. session evidence在stream close前到达时保留；peer+session或local+session共现归ambiguous。stream close后observer立即解绑，后到session event不归当前stream。
6. GOAWAY+正常end无failure observation；clean EOF不产生failure observation。
7. `rstCode=0`/无结构证据最终归`unknown`，但不作为首写evidence吞掉已同步观察到的事件。
8. `local|ambiguous|unknown`不进入block-level retry；`peer|session`在既有提交/预算门允许时仍能进入。
9. 双向控制：错误状态不能冒充peer；正确peer/session样本也不能被过严判据压成unknown。
10. 正向变异：丢弃冲突evidence、把ambiguous当peer、延迟解绑session observer、让unknown首写封口、漏及时session通知，相关测试必须分别变红。

#### 合并门

同阶段 1；另需对错误状态可通过和正确状态被拒绝两个方向做独立 review。提交后立即合并 `master`。

### 5.3 阶段 3：canonical History 与诊断消费

#### 产物

- `ModelOperationDispatch.termination?: TransportTerminationObservation` 成为 canonical typed 字段。
- `disposeDispatch()`、正常`scheduler.settle()`两路等待各自iterator lifecycle与physical termination双barrier；RequestContext最终terminal fallback在operation quiescence后再等待未settled final dispatch的两道transport barrier。三路均取最终observation，再写V3 manifest与REST `attempts[].transportTermination`；`ResponseOutcome.stream-error.transportTermination`携带同一冻结值供console diagnostics消费。
- `STREAM DISCONNECT` 增加稳定结构字段：attribution、first-observed、evidence 摘要、numeric code、local cause、session event；现有 elapsed/frame/byte/last-frame/silence 信号保留。
- UI/API 使用后端 SSOT type；旧记录无字段时显示 absent，不伪造 observation。
- 不做数据库 schema migration或 backfill：termination 随 manifest JSON 自然演进。

#### TDD

1. peer CANCEL、client abort、header timeout、dispatch cancel、session close、ambiguous evidence分别投影，双方 evidence不丢。
2. terminal error cause wrapping不丢 evidence/cancellation cause。
3. canonical record→V3 persist→hydrate→REST projection 保留全部字段与顺序。
4. 旧 manifest/缺字段记录仍可读。
5. 正常 completion 不写 disconnect observation。
6. 最终 attempt 失败且没有 recovery/continuation时，真实 scheduler→RequestContext terminal path仍写 observation。
7. 日志 formatter 对 absent 字段兼容，并不把 unknown/ambiguous渲染成 peer。
8. mutation：折叠 evidence、漏任一 settlement路径、删投影字段、删 hydrate round-trip，测试必须变红。

#### 合并门

定向测试、typecheck、架构守卫、`bun run test:backend`、doc-sync、独立 merged-state review 均通过。提交后立即合并 `master`。

## 6. 测试夹具与实证纪律

1. H2 RST 夹具必须使用经 wire oracle 校准的公开 API。公共 `stream.close(code)` 在实测 post-header 形态下不忠实；`stream.destroy(error)` 能忠实产生 INTERNAL_ERROR=2，并被 Bun/Node production `http2Fetch` 观测，故用它验证 peer wire→production evidence 接线。不得依赖 Node 私有 `kHandle` ABI作为必过门。
2. peer CANCEL=8 拆成两个独立判据：公开 wire oracle验证“非零 peer RST 能沿 production 接线形成 peer evidence”；collector单测验证 `code=8` 原样保留和归因。两条合起来不声称离线 fixture已经重放真实 GHC CANCEL=8；真实incident只作外部观测证据，不进入自动化测试。
3. 主 peer wire oracle在 Bun测试进程内使用本地h2c server公开`stream.destroy(error)`与production `http2Fetch`客户端；既有实测已证明Bun对该形态忠实观测rst2。可选Node独立腿只作交叉校准，按`Bun.which("node")` capability-gated skip，不得成为Bun-only环境的必过门，也不能用JSON回灌classifier冒充production接线测试。
4. 每个gate同时跑正样本和目标缺陷变异。只证明“变异会红”不证明覆盖完整，还必须构造local-only、peer-only、session-only、local+peer ambiguous、bare-close unknown、GOAWAY+clean-end六种相邻状态。
5. Bun主测试腿覆盖真实local echo与真实peer INTERNAL_ERROR wire；可选Node腿只验证跨runtime事件形状一致性。
6. 测试不得连接真实GHC或用户4141。需要进程级验证时使用非4141端口和独立配置/History。
7. 任何`attribution=peer`结论必须由结构化evidence与忠实非零RST wire fixture支持；具体code8的自动化判据只证明字段保真，不冒充wire来源oracle。

## 7. 可观测性与兼容性

- 新字段是加性的；现有 API 消费者、旧 History 和旧日志解析不应失败。
- operator-facing detail 保留原始 error message，同时追加结构化字段，避免为了机器可读性丢失底层信息。
- termination 只记录 transport 事实，不包含请求正文、凭据或其他无关数据。
- `TransportTerminationEvidence` 的新增 union member必须触发 attribution、策略与投影消费者的穷尽检查。
- 旧 `dispatchReason` 字符串继续存在，但任何新判据不得读取它来判断 attribution。

## 8. 结构改进与暂缓项

| 位置 | 怪味 | 本轮处置 |
|---|---|---|
| `src/lib/fetch-utils.ts` + `src/lib/transport/send.ts` + `src/lib/transport/http2-client.ts` | response-header 时钟职责跨层泄漏 | 阶段 1 在共享 transport API 明确作用域并建立可解除 primitive |
| `src/lib/transport/http2-client.ts` | local close 与 peer error 共用同一错误表面，事件竞态无全序 | 阶段 2 追加全部 evidence，quiescence 后派生 attribution；冲突诚实标 ambiguous |
| `packages/foundation/src/error/transport-reason.ts` | 现有 reason 同时被误当事实来源与 retry 语义 | 阶段 2 分出 `TransportTerminationEvidence/Observation`，保留 `TransportErrorReason` 的策略职责 |
| `ModelOperationDispatch.error/reason` | 人读字符串承担机器判定 | 阶段 3 新增一等 typed observation 字段；记录替代方案取舍，字符串退回兼容/展示职责 |
| 旧 `protect_streaming_generation` | whole-response 双轨与新 block-level buffering 重叠 | 本任务明确不启用、不扩展；删除由独立清理阶段处理，避免与 transport 根修耦合 |

## 9. 验收

任务完成必须同时满足：

1. header deadline 在 headers 后不再能关闭 body；pre-header timeout 仍有效；headers/deadline 同 tick只有一个终局，timer/listener/stream reservation各释放一次。
2. local-only、peer-only、session-only、local+peer ambiguous、bare-close unknown、clean end在结构上可区分，完整 evidence不丢。
3. block-level recovery 不重试 local/ambiguous/unknown，也不漏掉符合既有提交/预算门的真实 peer/session cut。
4. History 和日志能回答“本进程先观察到什么、有哪些证据、保守 attribution是什么、code/cause/event分别是什么”，但不对不可观测的 wire 因果顺序作过强声称。
5. `disposeDispatch`、正常 `scheduler.settle()` 和 RequestContext 最终 terminal fallback 三条 settlement路径均保存最终 observation。
6. 旧记录、旧 API 消费者和正常成功流不回归。
7. 三个阶段各自通过测试/review并已独立合并 `master`；没有把全部改动积成一次 catch-all merge。
