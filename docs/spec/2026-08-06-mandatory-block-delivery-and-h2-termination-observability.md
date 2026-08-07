# Mandatory block delivery 与 HTTP/2 终止观测规格

> 状态：`confirmed-not-implemented`
>
> 用户确认：2026-08-06
>
> 当前代码现状仍以 [DESIGN.md](../DESIGN.md) 的活架构表为准；本文冻结目标契约与验收标准，不声明实现已落地。

## 1. 背景与问题

近期 `gpt-5.6-sol` 的 Responses 上游多次在 `response.function_call_arguments.delta` 中途自然耗尽，没有 `response.function_call_arguments.done`、对应的 `response.output_item.done` 或最终的 `response.completed|incomplete|failed`。Messages v4 translate leg 随后打印：

```text
[Anthropic:v4:translate] Upstream truncated for gpt-5.6-sol: drained without a finish_reason
```

以 2026-08-06T07:13:57Z 的 History V3 固定快照为口径，attempt error `upstream stream truncated: closed without finish_reason` 与客户端 synthetic truncation error 两个持久化表面一致指向已知样本 `req_1785930862697_426`、`req_1785981964707_1474`、`req_1785989751986_2060`。这些样本都停在未闭合 tool arguments JSON，原始上游轨在翻译前已经缺失协议终止事件。因此，Responses→Anthropic 翻译器不是缺失源头；现有 truncation gate 正确阻止了把残缺 tool call 伪装成成功。

不过，当前实现先把逐 delta 内容交给客户端，再在发现终止事件缺失后补 synthetic error。这违反 2026-08-02 用户确认的项目公理：真实内容绝不逐 token 交付，所有生产路径至少以完整 block／item 为单位缓冲并交付。

本规格同时修复两个共同根因：

1. 交付层仍把 block buffering 与 retry 配置耦合，保留 route live sink、配置 disable 和 cap retreat 三类逐帧旁路。
2. HTTP/2 transport 对 body 终止只产生粗粒度 error／EOF，缺少 dispatch-scoped、可持久化、诚实表达不可判状态的终止事实。

## 2. 冻结目标与非目标

### 2.1 冻结目标

1. 所有生产流式路径永久执行 mandatory block-level delivery；无可靠中途边界的协议执行更强的 response-level terminal-only delivery。
2. retry、hedge、continuation、anchor 与 keepalive 不得绕过完整块交付。
3. HTTP/2 DATA 热路径不增加时钟、计数、对象、callback、日志或额外字节复制。
4. 每条 physical dispatch 保存 fixed-shape first-terminal snapshot；retry／hedge sibling 互不覆盖。
5. GOAWAY 完整 opaque evidence 只存一次，由 History V3 内容寻址对象承载，所有 dispatch 只引用 digest。
6. History journal、evidence CAS 与 operation 在崩溃恢复中不产生悬空 reference。
7. 判据同时防 false-green 与 false-red；性能报告不把“统计不显著”冒充“无回归”。

### 2.2 明确非目标

1. 不提供逐 token／delta live 模式，也不保留隐藏 fallback。
2. 不为超大单块设计 spool、磁盘溢写或专用恢复；单个未闭合 unit 在内存中保存到协议边界。
3. 在 Bun 当前提供的观测不足时，不在应用层推断 clean RST 与 END_STREAM；保存原始事实与不可判状态，等待独立 oracle 裁决。用户对此保持怀疑，深入调查在当前任务全部完成后单独执行，见 deferred backlog。
4. 不删除 continuation；它继续以完整块 ledger 为基础工作。
5. 不让 transport observer 执行 SQLite I/O。
6. 不用性能数据包装“零成本”结论。

## 3. SSE EOF 契约

`parseOwnedSse` 不在自然 EOF flush pending event。[WHATWG Server-Sent Events 解释算法](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation)明确规定：到达 EOF 时，任何尚未由空行终止的 pending data 必须丢弃。

若强行 flush，未完整传输的 `response.completed` 可能被当作真实终止事件，制造假成功。因此，本轮只加固契约，不改变生产解析语义：

- 空行终止的 event 必须 dispatch。
- 只有单换行或没有换行的 EOF pending event 必须丢弃。
- CRLF 跨 chunk、UTF-8 多字节跨 chunk、多行 `data:` 合并必须正确。
- 注入 EOF flush 的正向变异必须使“pending event 丢弃”测试变红。
- 源码注释须引用规范的 EOF 规则，防止未来再次把正确行为“修坏”。

## 4. Mandatory block-level delivery

### 4.1 不变量与协议粒度

所有真实客户端内容都必须至少以完整 block／item 为单位交付。逐 token／delta live forwarding 全部退役，不保留配置退路。

| 客户端协议路径 | 最小交付单位 |
|---|---|
| Anthropic direct／translate | 完整 `content_block_start … content_block_stop` |
| Responses HTTP | 完整 `response.output_item.*` lifecycle，以 `response.output_item.done` 收口 |
| Chat Completions | response-level terminal-only |
| Responses WS | response-level terminal-only |
| Gemini | response-level terminal-only |
| reverse translation legs | 无已证可靠中间边界时 response-level terminal-only |

`retryCap=0` 只关闭透明重试，不关闭 buffering。Synthetic ping／keepalive 可通过封闭 control capability 直达；anchor 会改变 message envelope 与 block index，不属于纯 control，必须由 envelope owner 管理。

### 4.2 唯一协议语法机

现有 boolean `commitBoundaries`、`sawMessageStop` 和独立 hedge boundary classifier 被统一替换为 candidate-local、stateful `DeliveryGrammar`。

Grammar 接收有序输入：

```ts
type DeliveryGrammarInput =
  | { kind: "frame"; frame: ClientFrame }
  | { kind: "finish"; result: ResponseFinishResult }
```

Grammar 产生 typed outcome：

```ts
type DeliveryOutcome =
  | { kind: "buffer-real-frame"; frame: ClientFrame }
  | { kind: "complete-unit"; unit: CompleteClientUnit }
  | { kind: "response-terminal"; terminal: ClientTerminal }
  | { kind: "protocol-error"; error: ClientProtocolError }
  | { kind: "discard-open-unit"; reason: string }
```

关键顺序：

1. `finish` 输入先顺序处理 `result.frames`。
2. 处理完 closing frames 后才应用 `result.kind`。
3. 仅 `complete`／`valid-terminal-without-boundary` 且无 open unit 时允许 terminal commit。
4. `truncated`／`terminal-failure` 丢弃当前未闭合 unit，再 fail closed。
5. Response terminal 或 error 不是普通 block boundary，绝不能把此前半块一起 flush。
6. Grammar outcome 是 hedge race readiness 与客户端 delivery 的唯一事实源；不得保留第二套协议判断。
7. Race 对 append-only outcome 只作非消费式观察；winner promotion 原子接管同一 outcome 序列。

### 4.3 唯一写出所有者

`BlockDeliveryOwner` 是生产代码中唯一可向客户端写真实内容或协议终止帧的组件。它负责：

- 缓冲当前 unit；
- 只提交 grammar 判定完整的 unit；
- 在终止／错误时丢弃半块；
- 生成并交付协议合法 terminal／error／`[DONE]`；
- 在首个完整 unit 提交前执行透明 retry；
- 在已提交完整块后按既有 continuation 设计续写；每条 continuation leg 仍经过 grammar，半块仍丢弃；
- hedge winner 选定前零客户端真实内容写入；promotion 原子接管 winner outcomes 与完整 unit buffer；
- 禁止 route handler 调用底层 sink `write`／`writeSynthetic` 或自行追加 `[DONE]`。

所有 production route 必须使用 mandatory owner。`runResponseSink` 不得作为生产旁路；若仍为测试原语保留，必须由架构守卫证明 production graph 不可达。

### 4.4 Retry、hedge 与 continuation

Delivery 永久开启；retry 是正交策略。

- 首个完整 unit 提交前，`retryCap>0` 可透明 retry；`retryCap=0` 仍缓冲。
- 每个 hedge candidate 有独立 grammar 与 buffer；选出 winner 前任何 candidate 都不能写客户端。
- Loser 的 outcome、identity 与 buffer 全部丢弃。
- Continuation 不违反 block-level 公理：ledger 只在完整 unit 成功交付后记录；新腿产生的新完整 unit 才能继续提交，半块仍丢弃。
- Continuation normalization 在 grammar outcome 形成前完成：重复 `message_start` 抑制、block index remap 和中间腿 terminal 抑制不能藏在最终 sink flush 中。
- 整条响应只有一个 client message envelope 和一个最终 terminal。

### 4.5 Request-scoped envelope reservation

`EnvelopeReservation` 由 `BlockDeliveryOwner` 在 candidate 创建前建立并单写，所有 candidate grammar 共享其单调状态：

- Synthetic anchor identity 由 request context 生成，不取任何 candidate frame 或 identity。
- Reservation 持有 `messageStartEmitted`、`reservedBlockCount`、`anchorOpen` 与 `anchorClosed`。
- Anchor 在 hedge winner 前触发也不会泄漏 loser 信息。
- 所有 candidate 使用同一 reserved block count 与 index offset。
- Winner 首个完整 unit 提交前，owner 先原子关闭 anchor。
- 未触发 anchor 时，owner 以 CAS 方式只接受 winner 的一次真实 `message_start`。
- Continuation 复用同一个 owner-global response envelope 与 block index cursor。
- 只有无结构语义的 ping／keepalive 可通过独立 control capability 直达；anchor 必须经过 envelope API。

### 4.6 删除所有 live bypass

架构守卫必须禁止：

- production route 调用 `runResponseSink`；
- route 直接调用 sink `write`／`writeSynthetic`；
- delivery enable boolean；
- `buffer_cap_bytes` 超限后的 live retreat；
- 第二套 protocol boundary classifier；
- hedge winner 的 `writeWinnerFrames`／`liveFrames` 直写；
- payload 或可伪造 synthetic 标签自行取得 control passthrough 权限。

守卫必须带反向变异对照：恢复任一旁路都应变红。

## 5. HTTP/2 body 终止观测

### 5.1 DATA 热路径

每条 physical HTTP/2 dispatch 建立固定形状、dispatch-local 的终止 recorder。Recorder 只在 response headers、trailers、`end`、`error`、`close-before-end`、local cancel、post-response signal abort 与 session GOAWAY 冷路径更新。

DATA listener 保持现有唯一工作：

```ts
req.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)))
```

不得增加时钟读取、计数器、额外对象、callback、日志或 payload 复制。

### 5.2 First-terminal snapshot

首次 consumer-terminal 事件通过单写门冻结 `TransportTerminationSnapshot`：

- `end`：先冻结，再 `controller.close()`；
- `error`：先冻结，再 `controller.error()`；
- `close-before-end`：先冻结，再 `controller.error()`；
- body cancel 与 post-response signal abort：统一经过 local-cancel primitive，先记录 source／reason，再执行 `req.close(NGHTTP2_CANCEL)`。

固定顺序：

1. 原子 check-and-set first terminal；
2. 构造并冻结 snapshot；
3. best-effort 调用 observer；
4. 无论 observer 是否抛错，都继续原有 `controller.close/error`。

Observer 必须 never-throw；抛错 observer 的正向探针必须证明 consumer 仍按原语义终止。

### 5.3 只记录事实，不猜根因

Snapshot 使用明确的观测状态，而不是把未来事件编码成误导性 `false`：

```ts
type ObservationAtSnapshot =
  | "observed-before-snapshot"
  | "not-observed-before-snapshot"
  | "unavailable-after-snapshot"
```

核心字段包括：

- `firstObservedSignal`：`end | error | close-before-end | local-cancel`；
- `headersReceived`；
- `streamId`；
- `rstCode`；
- 有界 error code／message；
- local cancel source 与结构化 reason；
- trailers 是否已观察；
- physical close／session GOAWAY 截至 snapshot 的观测状态；
- GOAWAY `errorCode`、`lastStreamID`、`opaqueDataLength`；
- 终止 epoch。

`end` 只表示 readable EOF，不表示正常完成。Bun 可能把 clean RST 暴露为 `end + rstCode=0`；在当前应用层证据不足时必须标记不可判，不把启发式猜测持久化为根因。

不等待后续 physical `close`，也不在 request settle 后 late-write，从而不增加 consumer EOF 延迟、不制造 History 冻结竞态。

### 5.4 Session GOAWAY evidence

GOAWAY 是 session 级旁证，不是 stream terminal，也不自动证明某条 dispatch 失败。

- 每个 GOAWAY event 只同步捕获一次完整 `opaqueData`。
- Per-dispatch snapshot 只保存有界标量与 evidence digest reference。
- 同一 session 上多个 dispatch 共享一个 evidence CAS 对象，不复制 N 份 bytes。
- Snapshot 明确标为 `goawayObservedBeforeSnapshot`，不作因果归因。

Transport 只产出同步已经成立的 observation：

```ts
type EvidenceCapture =
  | { availability: "captured"; digest: string; byteLength: number; encoding: string }
  | { availability: "unavailable-at-capture"; byteLength?: number; reason: string }
```

Transport 不执行 SQLite I/O、不等待持久化，也不把未来持久化结果回写 snapshot。Immutable bytes handle 只是 prepare／commit 的进程内载体，生命周期至少覆盖 History 事务 A，并在所有成功／失败路径释放；持久 manifest 与 snapshot 只保存可序列化 reference。

### 5.5 Dispatch 归属

Scheduler 在 `beginDispatch()` 取得 handle 后、physical `open()` 前，为该 dispatch 构造独立 observation capability。Transport 不读取“当前 attempt”。

RequestContext 提供 dispatch-scoped first-write API：

```ts
trySetDispatchTransportTermination(dispatch, snapshot): boolean
trySetDispatchResponseTrailers(dispatch, trailers): boolean
```

语义：

- 按 handle 直接定位；
- first-write-only；
- unknown／settled／sealed 返回 `false`，never-throw；
- canonical recorder 先裁决，成功后在同一同步栈内执行无抛兼容 projection；
- retry／hedge sibling 互不覆盖；
- egress 只投影 winner／committed dispatch。

`ModelOperationDispatch` 增加 first-class `transportTermination` 与 `responseTrailers` 槽，并由 recorder 自身实现冻结与 late-drop。现有 request-global trailer 槽仅可作为旧串行适配器；显式 generation 路径不得使用。

## 6. History V3 evidence 与崩溃一致性

### 6.1 Evidence owner

History V3 增加全局内容寻址 transport evidence owner，以 digest 为稳定 ID，存储在 `history-v3.db`，不依赖可选 `raw.db`，也不归属于任一 RequestContext。

Hydrate 按 digest 读取 evidence；多个 operation 引用同一 digest 时只保存一份实体。Capture 失败时不得产生 reference；snapshot 使用 `availability:"unavailable-at-capture"` 诚实说明。

### 6.2 两事务 recovery set

Transport snapshot 只表达 capture-time 事实，不能因未来持久化失败回改。因此 History writer 负责持久化编排。

**事务 A：**

1. 按 digest 幂等写本 operation 引用的 session evidence CAS；
2. 对已存在 digest 校验原文、长度与 encoding，碰撞即失败；
3. 写包含 evidence reference 清单的 operation journal。

Evidence CAS 与 journal 同事务提交或共同回滚。

**事务 B：**

1. 写 operation manifest、其它 CAS、sequence、tracks 与 timeline；
2. 删除 journal；
3. 原子提交。

恢复结果：

- A 前崩溃：evidence 与 journal 都不存在；
- A 后、B 前崩溃：journal 引用的 evidence 已存在，可完整恢复；
- B 失败：journal 与 evidence 保留，重试幂等；
- B 成功：operation 可独立 hydrate，journal 删除。

Journal 不再能笼统声称“payload 单独自足”：普通 payload／frame 仍由 compressed journal record 自足；session evidence 则由“journal + 同事务 evidence CAS”共同形成原子 recovery set。

Recovery 必须先验证每个 evidence digest 实体存在、hash／length／encoding 匹配；缺失视为数据损坏，不发布悬空 entry。

GC 可达集是所有已提交 operation manifest refs 与未完成 journal refs 的并集。只有两者都不可达的 evidence 才能删除；`clearV3Store` 同步清理 evidence 表。

持久化失败不影响正在进行的网络 stream；它使整个 History operation commit 进入现有重试／失败路径，不落悬空 reference，也不回改已冻结 transport snapshot。

## 7. 配置迁移与失败语义

### 7.1 配置语义拆分

完整块交付永久开启且不可配置。透明 retry 只由 `max_retries` 控制：

- `0`：不重试，但仍按完整 block／response 交付；
- `>0`：首个完整 unit 提交前允许透明 retry。

Continuation 保留现有独立策略配置。Buffer cap retreat 删除。

按项目既有配置兼容哲学：

- 旧 `enabled:false`／`protect_streaming_generation:false` 仍可被兼容 parser 识别，但不再关闭 delivery；它只迁移为 `max_retries:0`，并输出一次弃用警告。
- 旧 `enabled:true` 使用显式或默认 `max_retries`。
- 旧 `buffer_cap_bytes` 可被兼容 parser 接受，但被忽略并输出一次弃用警告。
- 新 schema、示例配置、状态 API 与文档不再暴露 delivery enable boolean 或 `buffer_cap_bytes`。
- 不保留隐藏环境变量、测试开关或 undocumented branch 重新开启 live delivery。

### 7.2 Fail closed

- 上游在 unit 中途截断：丢弃当前 unit。
- Grammar 检测错序或畸形 terminal：丢弃当前 open unit，生成协议合法 error terminus。
- Owner／sink 在完整 unit 提交前失败：该 unit 视为未交付。
- History observation／evidence 持久化失败：不影响网络交付；History operation 按现有策略重试或失败。
- Grammar／observer 内部异常：隔离并转换为 fail-closed outcome，不使请求永久悬挂。
- 内存分配失败：普通不可恢复错误；不建立超大单块专用降级，更不退回 live forwarding。

## 8. 性能契约

### 8.1 硬约束

1. HTTP/2 DATA listener 保持一个，callback body 只执行现有 `controller.enqueue(new Uint8Array(chunk))`。
2. 不增加人为 debounce、轮询、sleep 或等待 physical close。
3. Block-level 等待是已裁决的产品语义，不作为实现性能回归。
4. 有可靠边界的协议在完整 unit 后立即提交；无可靠边界的协议在 response terminal 提交。

TypeScript AST 架构测试机械检查 DATA callback，不用正则；同时禁止 production live bypass、delivery enable boolean、cap retreat、第二 protocol classifier 与未授权 control passthrough。

### 8.2 基准与结论口径

用户确认性能基准“仅报告、不设 non-inferiority 硬门”：

- 先跑 A/A 随机交错配对基准校准环境噪声；
- 再跑基线／新实现 A/B 配对 blocks；
- 报告配对差值与单侧 bootstrap 95% 置信区间；
- 不设置固定 0.5%／1%／2% 阻断阈值；
- 不以“统计不显著”声称“无回归”；
- 若数据不确定，只写“在当前基准分辨率下未观察到可区分差异”。

主指标：steady-state DATA 吞吐、p50／p99 consumer 延迟、`end→consumer EOF` 尾延迟、并发 stream 吞吐。History snapshot 序列化与 GOAWAY evidence fan-out 单独报告。

同一 harness 必须检测三种禁止变异：每 DATA chunk 增加一次 `Date.now()`、一次额外对象／字节复制、一次 callback。每个变异都须产生方向正确且可检测的退化；检测不到时，生产 A/B 数据不得支撑性能结论。

## 9. 验收矩阵

### 9.1 SSE parser

- 空行终止 event 正常 dispatch；
- 单换行／无换行 EOF pending event 丢弃；
- CRLF 与 UTF-8 跨 chunk；
- 多行 `data:` 合并；
- EOF-flush 变异使协议测试变红。

### 9.2 HTTP/2 body

Bun 与 Node 跑同一矩阵：

- 正常 `end→close`；
- `error→close`；
- bare `close-before-end`；
- body cancel；
- post-response signal abort；
- GOAWAY before／after end；
- 同 session sibling streams；
- observer 抛错不阻断 consumer 终止；
- first-terminal 只冻结一次；
- local cancel 不误记 remote reset；
- Bun clean EOF／clean RST 的不可判状态被诚实保留。

### 9.3 Mandatory delivery

- 完整 block／item 及时提交；
- 半块截断零泄漏；
- terminal／error 不携半块 flush；
- translate／Gemini 非空 finish frames 顺序正确且只交付一次；
- response-level 正常样本不永久扣留；
- route error／`[DONE]` 全部经过 owner；
- `retryCap=0` 仍保持 buffering；
- 首块前 retry 不产生重复输出；
- continuation 只提交新完整块，半块丢弃；
- hedge loser 零泄漏，winner 完整块正常提交；
- anchor-before-hedge 且 hedge 获胜时 loser identity 零泄漏；
- 整条响应唯一 message start、连续 block index、唯一 terminal；
- anchor deadline 与 winner promotion 同一事件循环 turn 交错的确定性探针；
- 恢复 route live、cap retreat、真实 delta 直写或第二 classifier 的变异使架构守卫变红。

### 9.4 History V3

- termination first-write 与 late-drop；
- retry／hedge sibling 归属隔离；
- trailer per-dispatch 归属；
- evidence CAS insert 失败；
- journal insert 失败；
- 事务 A 任一句失败同时回滚 evidence 与 journal；
- 事务 A 后崩溃；
- 事务 B 中途失败；
- journal recovery；
- 两 operation 共享 digest；
- GC 保留 journal／operation 可达 evidence；
- GC 删除真孤儿；
- `clearV3Store` 清 evidence；
- evidence 缺失或 hash／length／encoding 不匹配时阻止发布损坏 entry。

### 9.5 全量验证

- 新增定向 unit／integration／HTTP 测试；
- architecture guards；
- Bun 与 Node HTTP/2 专项矩阵；
- `bun run typecheck`；
- `bun run lint:all`；
- `bun run test:backend`；
- 性能 A/A、A/B 与三类变异正控。

## 10. 实施阶段与文档同步

实施按四个语义阶段提交：

1. SSE EOF 契约加固；
2. Mandatory block delivery 基座及所有 production pump 迁移；
3. HTTP/2 termination observation 与 dispatch-scoped History 投影；
4. History V3 evidence recovery set、配置／文档清理与性能验证。

最终必须进行合并态审查，确认所有 production 入口、grammar／race 单一事实源、retry／hedge／continuation／anchor 组合、History 跨重启 hydrate 与提交信息均闭合。

实施落地后同步：

- [DESIGN.md](../DESIGN.md) 活架构表；
- [API.md](../API.md) 新增 History 字段；
- [coding-conventions.md](../coding-conventions.md) production route 禁止直接写真实流内容；
- `config.yaml` 与生成 schema；
- [deferred-backlog.md](../todo/deferred-backlog.md) 中被本规格关闭的 live delivery／transport observability 债项。

## 11. 评审结论

本规格经过独立正确性与性能评审。正确性评审最终对以下部分给出 `0 blocker / 0 major`：

- dispatch-scoped termination／trailer 归属；
- first-terminal 时序与 observer 隔离；
- History evidence 两事务 recovery set；
- universal `DeliveryGrammar`／`BlockDeliveryOwner`；
- hedge、continuation 与 owner-global `EnvelopeReservation`。

性能评审确认 DATA 热路径零新增观测工作的方向，同时指出“统计不显著”不能证明非劣效。用户据此选择性能数据仅报告、不设 non-inferiority 阻断门。
