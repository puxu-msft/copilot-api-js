# Spec：HTTP/2 CANCEL 来源归因与 response-header deadline 作用域修复

- **状态：** Approved（用户 2026-08-06 批准三阶段渐进实施；允许阶段性无消费者基础设施先并入主线；每个自洽阶段验证后立即合并 `master`）
- **日期：** 2026-08-06
- **范围：** 上游 HTTP 请求的 response-header deadline、HTTP/2 stream termination provenance、History/诊断投影
- **相关：** [upstream-http2-transport](upstream-http2-transport.md)、[block-level buffered retry ADR](../decisions/2026-07-11-block-level-buffered-retry.md)、[request lifecycle cancel/settle/quiesce RFC](../rfc/2026-07-14-request-lifecycle-cancel-settle-quiesce.md)

## 1. 问题与裁决

生产 History 中大量 generation 以 `Stream closed with error code NGHTTP2_CANCEL` 失败。单看这条 Bun `node:http2` 错误无法判定谁发起了 CANCEL：peer 发 `RST_STREAM(CANCEL)` 与本地调用 `ClientHttp2Stream.close(NGHTTP2_CANCEL)` 都可能产生同一错误文本。当前 transport 将 post-header body error 与 close-before-end 都标成 `mid-body-close`；这个标签说明阶段，却不说明发起方，上层仍只能靠错误字符串、请求状态和经过时间猜测来源。

同时，`createResponseHeaderTimeoutSignal()` 返回不可解除的 `AbortSignal.timeout()`。`sendUpstreamHttp()` 将它与 shutdown/client/reaper/dispatch signal 合并后传给 `upstreamFetch()`；`http2Fetch()` 收到响应头后仍继续监听这个 composite signal，并在其 abort 时关闭 body stream。因此，名义上只覆盖“发请求到收到响应头”的 deadline 实际延伸到整个响应 body 生命周期。

用户裁决如下：

1. 渐进实现根本修复；每个阶段形成可部署终态、验证后立即合并 `master`。
2. 允许类型、记录字段和生产者 primitive 在暂时没有消费者时先并入主线；后续阶段必须接上，不以“死代码”否决正确基础设施。
3. 不启用、不扩展旧 `anthropic.protect_streaming_generation` whole-response L2。它不符合新的 block-level buffering，未来会删除。
4. 本任务不改变 block-level commit、continuation retry、`partial-degrade` 或 endpoint 默认策略；只修 transport 事实与其消费方式。

## 2. 目标与非目标

### 2.1 目标

1. response-header deadline 只覆盖获取响应头之前；响应头到达后，合法长 body 不受该时钟影响。
2. transport 在 close 动作或 close 事件的产生点记录 termination provenance，不再靠错误字符串反推。
3. 本地取消保留原始 `CancellationCause`；Bun 随后产生的同文本 `NGHTTP2_CANCEL` error 不得覆盖本地事实。
4. peer stream reset、session termination、本地 signal、本地 body cancel、自然结束可区分；证据不足时必须标为 `unknown`，不得猜测。
5. canonical `ModelOperationDispatch` 保存结构化 termination；History REST、诊断日志和 UI 类型从该单一事实源投影。
6. 新分类不得改变已有 block-level recovery 的产品契约；retry admission 必须显式消费允许的 termination 集合。

### 2.2 非目标

1. 不阻止 GHC 发 `RST_STREAM(CANCEL)`；本任务只能正确归因并让现有恢复机制据事实裁决。
2. 不新增 whole-response buffering，不翻转旧 L2 开关。
3. 不重写全部 transport 或请求生命周期状态机。
4. 不回填旧 History。旧记录缺少 termination 时投影为 absent/unknown。
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

`TransportTermination` 只描述观察到的 transport 事实；`TransportErrorReason` 继续描述上层错误分类/retry 所需的语义。二者不得合并成一个枚举：同一个事实可因 pre/post-header、是否已提交语义内容、协议保证不同而采用不同策略。

建议的事实模型：

```ts
export type TransportTermination =
  | { source: "local-signal"; code: number; cause?: CancellationCause }
  | { source: "local-body-cancel"; code: number }
  | { source: "peer-rst"; code: number }
  | { source: "session"; event: "error" | "close"; code?: number }
  | { source: "unknown"; code?: number }
```

字段名可在实现计划中按项目命名风格细化，但判别能力不得下降。`code` 保存数字 HTTP/2 error code；日志可另渲染 `NGHTTP2_CANCEL` 等符号名。自然 `end` 是内部终态，不写 failure termination。GOAWAY 只表示 session 停止接收新 stream；在途 stream 若继续正常结束，不得因 GOAWAY 被标为 session termination。

### 3.3 本地意图优先

本地代码在调用 `req.close(code)` 前必须原子记录 termination intent。此后即使 Bun 对同一个 stream 发出 `ERR_HTTP2_STREAM_ERROR: Stream closed with error code NGHTTP2_CANCEL`，该 error 仍归入已记录的 local source，不得重判为 peer reset。

本地意图只覆盖该 stream，不推断 session 或 sibling。重复 close 采用 first-writer-wins：首个已执行的终止动作是权威，后续 teardown 事件只补充诊断，不改来源。

### 3.4 peer/session 判定要求结构证据

- 没有本地 intent、stream 报非零 `rstCode` 或结构化 stream error，才可判 `peer-rst`。
- session 的 `error`/`close` 必须在 session 监听器处记录，并关联实际因此中断的 stream，才可判 `session`。单独 GOAWAY 只 retire session，不构成在途 termination。
- 只有字符串含 `NGHTTP2_CANCEL`、只有 `rstCode=0`、或只有“close before end”时，证据不足，必须判 `unknown`。
- 自然 `end` 后的 `close` 视为正常内部终态，不得产生 disconnect termination。

### 3.5 canonical History 所有权

termination 属于一次 physical dispatch，故一等字段放在 `ModelOperationDispatch`，不是 request 顶层、`OperationTrack.extensions` 或 REST-only 类型。数据流如下：

1. `http2-client` 产生 `TransportTermination`；
2. transport/driver 将它附到 dispatch settlement；
3. `RequestContext` 调用 canonical recorder 的 `settleDispatch()` 写入 `ModelOperationDispatch.termination`；
4. V3 manifest 原样持久化；
5. `recordToHistoryEntry()` 投影到 `attempts[].transportTermination`；
6. `ui-v4` 经 `~backend/*` re-export 使用后端类型。

`dispatchReason` 和 `error` 保留供人读与兼容；它们不再是 termination 来源的事实源。

## 4. Provenance 图

| 一侧 | 生产者 | 观测点 | 上游来源 |
|---|---|---|---|
| local signal | `http2-client` 的 AbortSignal listener | 调用 `req.close()` 前记录 intent | signal.reason；其中 request/reaper/dispatch 来源已由 `CancellationCause` 标记 |
| local body cancel | WHATWG `ReadableStream.cancel()` | 调用 `req.close()` 前记录 intent | body consumer 主动释放 response |
| peer stream reset | `ClientHttp2Stream` error/close | 无 local intent，且 stream 有非零 `rstCode`/结构化 stream error | peer 发来的 HTTP/2 stream termination |
| session termination | `ClientHttp2Session` error/close | session listener 记录事件并通知实际受影响的 stream | 整条 H2 session 异常结束 |
| natural completion | stream `end` 后 `close` | body adapter 的 `ended` 状态；仅作内部判别、不持久化 failure termination | peer 正常 END_STREAM |

local 与 peer 两侧不能追溯到同一生产者：local 由本进程在 close 调用前写入，peer 只在 local intent 缺失时由接收事件建立。`rstCode` 与错误字符串只是 peer 侧辅助证据，不能推翻 local intent。

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

- 在 `packages/foundation` 定义共享 `TransportTermination` 和读取/附着 primitive；core 不复制类型。
- `http2-client` 对 local signal、body cancel、peer reset、session event、clean end、unknown 建立 first-writer-wins 状态。
- transport error 保留 termination through cause chain；local error 同时保留 `CancellationCause`。
- `classifyError` 和 block-level recovery 从结构化 termination/`TransportErrorReason` 显式裁决，不把所有 `mid-body-close` 或所有 `NGHTTP2_CANCEL` 统一视为同一来源。
- 允许阶段内先合入尚无 History 消费者的类型/producer，但阶段结束前 live error classification 必须已消费它；History 消费留给阶段 3。

#### Recovery 边界

- `peer-rst`/可确认的 session close 可进入现有 transport-cut 分支，但是否透明重试仍受 block-level 已提交边界、server execution risk 和既有预算约束。
- `local-signal`、`local-body-cancel` 不得被当成 upstream cut 重试。
- `unknown` 保持当前保守终止行为，不因“可能是 peer”扩大重试。
- `REFUSED_STREAM` 的 RFC 9113 零处理保证保持独立，不被本阶段稀释。

#### TDD

1. Bun 本地 `req.close(CANCEL)` error 回声仍归 local signal/body cancel。
2. local signal 保留 request-deadline、stale-reaper、request-cancel、dispatch-cancel 等 cause。
3. 忠实 h2 RST fixture 使用 `stream.destroy(error)`；无 local intent 时归 peer reset。
4. session teardown 与 stream RST 分开。
5. clean EOF 不产生 failure termination。
6. `rstCode=0`/无结构证据归 unknown。
7. local cancel 不进入 block-level retry；peer cut 在既有安全门允许时仍能进入。
8. 双向控制：错误状态不能冒充 peer；正确 peer 样本也不能被过严判据压成 unknown。
9. 正向变异：去掉 local intent 写入、交换 local/peer 优先级、把 unknown 当 peer，相关测试必须分别变红。

#### 合并门

同阶段 1；另需对错误状态可通过和正确状态被拒绝两个方向做独立 review。提交后立即合并 `master`。

### 5.3 阶段 3：canonical History 与诊断消费

#### 产物

- `ModelOperationDispatch.termination?: TransportTermination` 成为 canonical 字段。
- dispatch settlement、V3 manifest、REST detail 的 `attempts[].transportTermination` 贯通。
- `STREAM DISCONNECT` 增加稳定结构字段：source、numeric code、local cause、session event；现有 elapsed/frame/byte/last-frame/silence 信号保留。
- UI/API 使用后端 SSOT type；旧记录无字段时正常显示 unknown/absent。
- 不做数据库 schema migration或 backfill：termination 随 manifest JSON 自然演进。

#### TDD

1. peer CANCEL、client abort、header timeout、dispatch cancel、session close 投影为不同值。
2. terminal error cause wrapping不丢 termination/cancellation cause。
3. canonical record→V3 persist→hydrate→REST projection 保留全部字段。
4. 旧 manifest/缺字段记录仍可读。
5. 正常 completion 不写 disconnect termination。
6. 日志 formatter 对 absent 字段兼容，并不把 unknown 渲染成 peer。
7. mutation：折叠任意两种 source、删投影字段、删 hydrate round-trip，测试必须变红。

#### 合并门

定向测试、typecheck、架构守卫、`bun run test:backend`、doc-sync、独立 merged-state review 均通过。提交后立即合并 `master`。

## 6. 测试夹具与实证纪律

1. H2 RST 夹具必须使用经 wire oracle 校准的方式。项目既有实测表明 `stream.close(code)` 在部分 Node/Bun 形态不忠实；优先复用 `stream.destroy(error)` 夹具，并断言客户端实际看到非零 `rstCode`/error。
2. 每个 gate 同时跑正样本和目标缺陷变异。只证明“变异会红”不证明覆盖完整，还必须构造 local/peer/session/unknown 四种相邻状态。
3. Bun 与 Node 对本地 CANCEL 的事件序列不同，至少在 Bun 主测试腿覆盖真实回声；Node 腿用于确认实现不依赖 Bun 特例。
4. 测试不得连接真实 GHC 或用户 4141。需要进程级验证时使用非 4141 端口和独立配置/History。
5. 任何“source=peer-rst”结论必须由 provenance primitive 或忠实 wire fixture支持；日志文本不构成 oracle。

## 7. 可观测性与兼容性

- 新字段是加性的；现有 API 消费者、旧 History 和旧日志解析不应失败。
- operator-facing detail 保留原始 error message，同时追加结构化字段，避免为了机器可读性丢失底层信息。
- termination 只记录 transport 事实，不包含请求正文、凭据或其他无关数据。
- `TransportTermination` 的新增 union member必须触发所有策略与投影消费者的穷尽检查。
- 旧 `dispatchReason` 字符串继续存在，但任何新判据不得读取它来判断来源。

## 8. 结构改进与暂缓项

| 位置 | 怪味 | 本轮处置 |
|---|---|---|
| `src/lib/fetch-utils.ts` + `src/lib/transport/send.ts` + `src/lib/transport/http2-client.ts` | response-header 时钟职责跨层泄漏 | 阶段 1 在共享 transport API 明确作用域并建立可解除 primitive |
| `src/lib/transport/http2-client.ts` | local close 与 peer error 共用同一错误表面 | 阶段 2 在产生点记录 termination intent/event |
| `packages/foundation/src/error/transport-reason.ts` | 现有 reason 同时被误当事实来源与 retry 语义 | 阶段 2 分出 `TransportTermination`，保留 `TransportErrorReason` 的策略职责 |
| `ModelOperationDispatch.error/reason` | 人读字符串承担机器判定 | 阶段 3 新增一等 termination 字段，字符串退回兼容/展示职责 |
| 旧 `protect_streaming_generation` | whole-response 双轨与新 block-level buffering 重叠 | 本任务明确不启用、不扩展；删除由独立清理阶段处理，避免与 transport 根修耦合 |

## 9. 验收

任务完成必须同时满足：

1. header deadline 在 headers 后不再能关闭 body；pre-header timeout 仍有效。
2. local CANCEL、peer RST、session termination、clean end、unknown 在结构上可区分。
3. block-level recovery 不重试 local cancel，也不漏掉符合既有安全门的真实 peer cut。
4. History 和日志能回答“谁终止了 stream、用什么 code、若为本地取消则原因是什么”。
5. 旧记录、旧 API 消费者和正常成功流不回归。
6. 三个阶段各自通过测试/review并已独立合并 `master`；没有把全部改动积成一次 catch-all merge。
