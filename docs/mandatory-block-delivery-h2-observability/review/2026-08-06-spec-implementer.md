# Mandatory block delivery 与 HTTP/2 终止观测规格评审——实施者走查

> 状态：第七轮 `0 blocker / 0 major`，实施者视角已放行；两个正交视角均已放行同一固定提交
>
> reviewer：独立异模型实施者视角 reviewer
>
> 评审基线：`2bd0b83d88d67f67a315bfc1ba331c75c28b9cff`
>
> 原始报告由 reviewer 通过工具返回；本文件逐条转录其 finding，供多轮处置保留。Reviewer 未修改仓库。

## Gate

Reviewer 在隔离 worktree detached 到固定提交，核验 `pwd`、top-level、HEAD 与干净状态。它沿 candidate／processor／sink、dispatch／transport、RequestContext／History、全部 route pump、config 和测试脚本做了只读走查，未运行测试。

## 第一轮 verdict

`0 blocker / 5 major`，修复 major 后可定稿。Reviewer 原摘要写“major 数量 4”，但正文实际列出 5 条；以逐条正文为准。

## Findings

### I1 · Major：缺少协议 adapter 契约

规格只列出 `CompleteClientUnit`、`ClientTerminal`、`ClientProtocolError`，没有定义 protocol adapter 如何识别 unit、生成合法 error／terminal／`[DONE]`、获得 control capability 或处理 terminal 后帧。现有 driver 直接写 frame，CC route 自行写 `[DONE]`。实施者可能让 owner import route codec，或保留 route terminal 直写，两者都破坏唯一 owner。

Reviewer 建议冻结 `DeliveryProtocolAdapter` 的 classification、terminal rendering、control capability 与 post-terminal 契约，并逐协议列出映射。

### I2 · Major：evidence bytes lease 没有所有权转交通道

`EvidenceCapture` 只有 digest，dispatch-scoped termination API 也只接 snapshot；“immutable bytes handle”只在说明文字出现，没有 acquire／handoff／release API。现有 transport options 只传 signal／forceHttp，V3 writer 只能写 `PreparedOperation.objects`。实施者可能过早释放 bytes，或只持 digest，导致 journal reference 没有实体。

Reviewer 建议把 opaque evidence lease 纳入 dispatch-scoped capability，明确 acquire→事务 A commit／rollback→release 的唯一 owner。

### I3 · Major：V3 format version 与旧 journal 兼容未定义

两事务设计只覆盖新写和崩溃点，没有规定旧 manifest／旧 self-contained journal 的 format-version、hydrate 兼容与升级。现有 V3 store 有 schema version、manifest format gate，旧 journal 假定 payload 自足。实施者可能直接改变 journal／manifest，令升级前遗留 journal 无法恢复，或让旧 operation hydrate 假红。

Reviewer 建议把 evidence refs 设计为可选版本化字段，明确 schema／format bump、旧 journal recovery 分支和升级 fixture。

### I4 · Major：production pump 集合未冻结

“所有 production route”没有清单或 production graph root。现有 sink 调用散布在 Responses HTTP 两条腿、Messages direct／translate、CC direct／reverse、Gemini direct／reverse 与 Responses WS。实施者可能只迁常规 HTTP route，漏 reverse、error path 或 WS fallback，局部测试仍全绿。

Reviewer 建议列出每个 pump、目标 grammar 粒度、owner entry 和对应测试；AST guard 对冻结集合判定，而不是模糊的“production”。

### I5 · Major：Node／性能验证没有可执行 harness

规格要求 Bun／Node 同矩阵和 A/A、A/B、三种变异，但没定义命令、harness、baseline selector、结果格式或 CI 落点；当前 package scripts 都由 Bun 驱动，也没有 benchmark harness。实施者可能把 Bun fixture 当 Node oracle，或只 benchmark callback 而非 session→stream→consumer 全链。

Reviewer 建议明确 Node 真 `node:http2` runner、Bun／Node 统一结果格式、A/A+A/B version switch，以及在同一端到端 harness 注入三种变异。

## 主会话处置表

| Finding | 级别 | 处置 | 证据／整改 |
|---|---|---|---|
| I1 | C | 采纳 | 现有 driver 丢弃上游 `[DONE]`，CC route 在 `src/routes/chat-completions/handler-v4.ts` 自行写 terminal。Spec §4.2～§4.4 已冻结 `DeliveryProtocolAdapter`、frame ownership、逐协议 terminal／error／`[DONE]` 与 post-terminal 契约。 |
| I2 | C | 采纳 | Canonical recorder 只返回 inert `ModelOperationRecord`，V3 prepare 只接 record。Spec §5.4～§5.5 已冻结 content-addressed registry、operation ref、`OperationPersistenceEnvelope`、terminal seal→enqueue 接管与所有失败／shutdown 释放路径。 |
| I3 | C | 采纳 | 当前 `SCHEMA_VERSION="5"`、`FORMAT_VERSION=2`，journal 无格式字段且 recovery 假定 self-contained record。Spec §6.3 冻结 schema 6／manifest 3／journal 2，以及旧 manifest v1/v2、pending journal v1、readonly/search/summary 兼容 fixture。 |
| I4 | C | 采纳 | `rg` 文本枚举与 TypeScript compiler AST 两种原理交叉确认 5 个流式 exported root 下有 9 个 sink-owning pump，且存在同名 symbols；AST 另见 Gemini 非流式 `handleGenerateContentV4`，按集合边界正确排除。Spec §4.7 以 path-qualified symbol 冻结全集与“可达 owner／不可达底层 writer”双向守卫。 |
| I5 | C | 采纳 | `package.json` 仅有 Bun backend test scripts，无 Node matrix runner／端到端 benchmark runner。Spec §8.3 冻结真实 `node:http2` fixture、同 bundle Bun／Node 执行、runtime identity gate、A/A+A/B selector、JSONL schema 与四个独立 mutation。 |

整改自审另外抓到并修复：`response-terminal` 未携带 response-level buffered frames、旧 GOAWAY 字段名残留、旧评审结论冒充当前状态、裸 symbol 名歧义、session 退役早于 History acquire 时可能丢 evidence bytes 的生命周期空窗，以及错误释放 loser dispatch evidence 会违反 richest-data-flow／canonical diagnostic History 的冲突。

## 第二轮复审

> 复审提交：`d1a0ad2e3261a643f23f681f2263744bceb22a0e`（基线 `2bd0b83d88d67f67a315bfc1ba331c75c28b9cff`）
>
> 证据：reviewer 已在隔离 worktree 核验 `pwd`、top-level、HEAD 与 status；读取本报告、spec 整改段和相邻 transport／History／route 契约，并以代码符号检索交叉验证。

### I1 · 未闭合（Major）：adapter 的函数签名仍无法实施

Spec §4.3 的 `DeliveryProtocolAdapter` 引用了未定义的 `DeliveryFrameClass`、`DeliveryFinishClass`、`ClientProtocolError` 与 `DeliveryControlCapability`。`classify`／`classifyFinish` 的每一种返回值、frame 所有权转移、error 的 semantic 原因与 terminal source 如何区分均未冻结。实施者仍会各自设计 union，令 grammar、owner、五个 adapter 出现第二套边界判定或把正确 finish frame 当作 error。须补齐全部 discriminated unions、每一变体的 buffer ownership／合法后继和 adapter→grammar error mapping。

### I2 · 关闭

§5.4～§5.5 已定义 session lease→registry→operation ref→`OperationPersistenceEnvelope` 的交接、事务 A 后释放和 shutdown 责任，并明确 loser dispatch 也持久化。这解决了先前“只有 digest 没有 bytes”与 session 退役空窗。

### I3 · 关闭

§6.3 已明确 schema 6、manifest 3、journal 2，规定 v1 pending journal 走 legacy digest／preparation、manifest v1／v2／v3 的读取边界和真实旧库 fixture。

### I4 · 关闭

§4.7 以 5 个实际 exported root 和 9 个实际 private pump 的 path-qualified symbol 冻结集合；双向 AST／call-graph guard 加 root→owner 正控，能同时防漏接与误拒正确路径。

### I5 · 未闭合（Major）：Bun 子进程内的 server 不是 Node oracle

§8.3 要同一 bundle 分别由 Bun、Node 执行，并由 harness 自己启动 `node:http2.createServer`。在 Bun child 中此调用走 Bun 的 Node compatibility implementation，而非真实 Node runtime。现有测试通过 `setHttp2SessionFactoryForTests()` 注入 h2c production-client path。须固定由独立 `node` child 启动 fixture，把连接信息传给 Bun／Node client child，并明确该 test-only h2c session-factory injection 是允许的 production-client seam。

### 第二轮 verdict

`0 blocker / 2 major`。I2、I3、I4 已关闭；I1、I5 修复后可定稿。

### 主会话第二轮处置

| Finding | 级别 | 处置 | 整改 |
|---|---|---|---|
| I1-r2 | C | 采纳 | Spec §4.3 已定义 branded `DeliveryControlCapability`、`DeliveryUnitIdentity`、`ClientProtocolError`、`DeliveryFrameInput`、闭合 `DeliveryFrameClass`／`DeliveryFinishClass`，冻结状态后继、非法输入→error semantic 映射，以及现有 `ResponseFinishResult` 四分支的逐一映射。Grammar 只消费 typed class，不再解析 wire。 |
| I5-r2 | C | 采纳 | Spec §8.3 已改为一个独立 Node server child + Bun／Node 两个串行 client children。Server runtime identity、同一 fixture instance／manifest、fresh session、scenario token 全部可验；唯一允许 seam 是 `setHttp2SessionFactoryForTests(() => http2.connect(origin))`，仍驱动 production `http2Fetch`／pool／request／body adapter。 |

跨视角更正：本轮 reviewer 对 I4 的“5 roots／9 pumps 已关闭”结论随后被事实／判据 reviewer 用 warmup `drop|fake` 与 precommit AUQ 两条直接 `stream.writeSSE` 路径证伪。该历史 verdict 保留，但不再代表当前状态；最新 spec §4.7 已扩为经 TypeScript AST 交叉验证的 6 roots／11 pumps，第三轮须按新集合复审。

## 第三轮复审

> 复审提交：`97fcadde98c118e53ca8f09604dc47162959c65e`（上一轮 `d1a0ad2e3261a643f23f681f2263744bceb22a0e`）
>
> 证据：reviewer 已在隔离树核验目标 SHA；读取第二轮与主会话 disposition，审阅 spec §4.2～§4.7、§5.3～§6.3、§8.3～§9.3，并以当前代码复核 warmup／AUQ 直接写 SSE、stream root／pump 及 HTTP/2 h2c factory seam。

### I1-r2 · 关闭

§4.2～§4.4 已闭合 adapter→grammar pipeline：grammar 只接收 typed class，所有 union、ownership、非法后继和 error semantic 均固定；`result.frames` 逐帧且恰好一次分类后才分类 finish。Structural staging、唯一 natural-drain 与 control runtime identity 均有正反验收。

### I2 · 维持关闭

Evidence capture 四态、scalar／evidence 合法组合、Session／Operation lease、envelope、queue retry、事务 A 后释放、loser canonical evidence 与 shutdown 均有唯一责任，不触及 DATA 热路径。

### I3 · 维持关闭

Pending journal format 1 的两个独立 legacy digest oracle、真实 v1／v2 fixture、v3 migration、manifest readers 与 future-format 拒绝均已规定。

### I4 · 关闭（经范围更正）

§4.7 已修正为 6 roots／11 pumps，纳入 warmup `drop|fake` 与 precommit AUQ；`runSyntheticResponse` 和双向 guard 能抓漏接而不误拒正确 synthetic path。

### I5-r2 · 关闭

独立 Node server child、同一 fixture／manifest、Bun／Node client children、runtime identity、scenario token、fresh session 与 h2c production-client seam 均可验证并有错误 wiring 变异。

### 第三轮 verdict

`0 blocker / 0 major`。I1～I5 均已闭合；**实施者视角可定稿**。

## 第四轮复审

> 目标提交：`0b933be2adbe15e0688cfcccc4544bcffdc918a2`（上一轮 `97fcadde98c118e53ca8f09604dc47162959c65e`）
>
> 证据说明：reviewer 隔离树的报告路径存在未解决 index merge，Git 拒绝 checkout；reviewer 没有修改 spec，而是用 `git show <target>:<spec>` 读取目标提交的精确内容，并与当前 transport／History 接缝交叉核对。主会话从 reviewer return 转录本节到干净工作树。

### DispatchEvidenceClaim／GOAWAY fan-out：关闭

Session ref、dispatch claim 与 operation lease 已分开；attach 的 `installed`／`rejected` 所有权、first-terminal transfer／release、严格 one-shot fan-out、异常／零 dispatch、sibling 独立 claim 与拒绝新 dispatch均已闭合，没有 retire→attach bytes 空窗。

### SSE empty-value data field：关闭

“无 data field”与 `data:`／无冒号 `data` 已明确区分；后两者 dispatch `data === ""`，相反错误各有 mutation。

### ClientTerminal diagnostic：关闭

Finish／wire terminal source 与原 terminal 字符串结构化保留；256-byte 上限 fail closed，round-trip／丢失／改写均有验收。

### GOAWAY source-unavailable scalar：关闭

顶层 observation 与每个 scalar／evidence 的合法组合已冻结；source-unavailable 不再允许 observed scalar，空 opaque bytes 仍正确捕获为 zero-length。

### 第四轮 verdict

`0 blocker / 0 major`。本轮重写的四项契约均已闭合；**实施者视角可定稿**。

## 第五轮复审

> 目标提交：`21e455989182c72c04621644f789ad895c84d768`（上一被审 `0b933be2adbe15e0688cfcccc4544bcffdc918a2`）
>
> 证据说明：reviewer 隔离树仍存在此前未解决 index merge，Git 拒绝 checkout；reviewer 以 `git show <target>:<spec>` 审阅精确目标文档，并结合当前 scheduler→transport→`http2Fetch` 的 reservation／`session.request` 接缝验证实施性。主会话从 reviewer return 转录本节到干净工作树。

### GOAWAY ordered ledger 重写：关闭

Dispatch 创建时先安装 `DispatchGoawayLease`，任何可调用 `session.request()` 的 dispatch 已持有 ledger ref。Repeated GOAWAY 以单同步 transaction 按 sequence append；first terminal 原子 freeze 完整前缀并转为 `OperationGoawayLease`。Session close 只释放 owner ref，History envelope 继续持有 bytes。

### Ownership 与双向正确性：关闭

`appendObserved` 成功才消费 registered evidence，失败由调用方释放；`appendUnavailable` 不接 bytes。Dispatch lease 只能 freeze／release。零 event 正确返回 null lease；已有合法 stream 在 GOAWAY 后可完成，新 acquire 被拒；`lastStreamID` 非法增加仍记录 offending event 后 fail closed。

### History 有序 refs：关闭

Canonical record／journal 保留 dispatch event sequence 与 digest；CAS 只去重 bytes，不合并不同 sequence event 或内存 lease；loser dispatch 保留。验收覆盖 repeated GOAWAY、非法递增、零 event、lease 误用、transient retry 与 refcount 归零。

### 第五轮 verdict

`0 blocker / 0 major`。Ordered ledger、dispatch／operation leases、install／freeze／close、repeated GOAWAY 与 History sequence refs 均无未闭合实施或所有权歧义；**实施者视角可定稿**。

## 第六轮复审

> 目标提交：`2f706e7d4891e5018c8b7c6ab3f57a12f29a5a1f`（上一被审 `21e455989182c72c04621644f789ad895c84d768`）
>
> 证据：目标 SHA 已解析。报告仍处于先前未解决 index merge，故本轮以 `git show <target>:<spec>` 审阅精确目标文档；未修改 spec。

### G1 · Major：unattributed protocol error 的 freeze 规则与 snapshot union 矛盾

§5.3 允许 `unavailable-at-source` 且 `unattributed-protocol-error-before-callback`、events 为空，`recordUnattributedProtocolError()` 也要求生产记录该状态。但 §5.4 同时规定 `DispatchGoawayLease.freezeAtTerminal()` “零 event 返回 not-observed”。生产在 callback 前收到 `ERR_HTTP2_ERROR: Protocol error` 后 ledger 没有 event；按 freeze 文字实施会把已记录的 protocol violation 变为 `not-observed`，丢失 `PROTOCOL_ERROR`，而按 union／验收又必须保留 unattributed violation。实施者无法同时满足两者，且错误实现可因零 event 正常路径测试而绿。应把 freeze 判据改为按 ledger 状态：仅“无 event 且无 unattributed violation”才返回 not-observed；有 unattributed violation 时返回 unavailable-at-source + violation，且补该生产路径正反控制。

### G2 · 其余本轮重点：关闭

`InvalidGoawayCapability` 将 fixture-clamped、runtime-rejected、raw-invalid-visible 与 unsupported 分开，并禁止用 fixture 调用参数或 test scenario 因果回写生产 snapshot；clamped callback 是有效 non-increasing 正样本，runtime-rejected 保留 unattributed error 而不伪造 event。`RegisteredGoawayEvidence` 的 append 成功消费／发布前失败调用方 release，及 ordered append-only ledger、session owner close 后 leases 继续可读，均定义了单一责任并有相应变异控制。

### 第六轮 verdict

`0 blocker / 1 major`。G1 修复后可定稿。

### 主会话第六轮处置

| Finding | 级别 | 处置 | 整改方向 |
|---|---|---|---|
| G1-r6 | C | 采纳 | `freezeAtTerminal()` 改为按 ledger 的 event／violation 联合状态构造三种结果：仅“零 event + violation none”是 not-observed；“零 event + unattributed violation”是 unavailable-at-source 且保留 violation；有 event 是 observed prefix。纯标量 violation 不需要 evidence lease。§9.2 增加 ordinary zero-event 正样本、error-bearing zero-event 正样本及双向变异。 |

## 第七轮复审

> 目标提交：`0e524438cfa9d7197484731b9f89fc8c263223cb`（上一被审 `2f706e7d4891e5018c8b7c6ab3f57a12f29a5a1f`）
>
> 证据：已以 `git rev-parse 0e524438` 解析完整 SHA，并读取本报告第六轮。因隔离树保留历史 unresolved index merge，未 checkout；以 `git show <target>:docs/spec/2026-08-06-mandatory-block-delivery-and-h2-termination-observability.md` 与 `git diff 2f706e7d..0e524438 -- docs/spec/...` 审阅目标版本。未修改 spec。

### G1 · 关闭：freeze 三态与 ordinary zero-event

§5.3～§5.4 现明确 `freezeAtTerminal()` 仅“零 event 且 violation none”产生 `not-observed-before-snapshot`；“零 event 且 unattributed violation”产生 `unavailable-at-source` 并逐字保留 violation；非空 ledger prefix 产生 observed。前两者均为 null operation lease。故普通无 GOAWAY 的正确 dispatch 不会 false-red，而 callback 前 `PROTOCOL_ERROR` 也不会被零 event 分支吞掉；退出责任表与验收逐项覆盖三种结果。

### G2 · 关闭：stream／session earliest-signal one-shot

§5.4 规定 stream 与 session error path 共用 session-scoped one-shot recorder，最早观察者必须在 `controller.error`／first-terminal freeze、cleanup 等动作之前记录；后到信号只能 `already-recorded`，不得覆盖原 reason。由此 stream-first 与 session-first 都使 freeze 看见同一 unattributed violation，且终端 snapshot 不被后到事件改写。验收要求吞掉 early record、覆盖 reason 和错误顺序的变异变红。

### G3 · 关闭：InvalidGoawayCapability provenance

§8.3 的 capability union 令 clamped／raw-visible 都严格为两条 callback，rejected 严格为零条或唯一 first-token callback；两个 unique opaque token、ordered digest provenance、wire oracle 与 ambiguous→unsupported 均可机械实施。only-first callback 不再误判 clamped，runtime-rejected 不伪造第二 event；正确 clamped 的 two-token non-increasing callback 仍可通过。

### G4 · 维持关闭：ledger／evidence／History

本轮不改变 append-only ledger、`RegisteredGoawayEvidence` 成功消费／发布前释放、dispatch→operation lease 转移或 History envelope 责任。早 signal 只写无 bytes 的 violation，不与 evidence ownership 竞争；ordered event prefix、CAS digest 去重但不合并 sequence／lease、loser dispatch 持久化与 transient retry 均仍闭合。

### 第七轮 verdict

`0 blocker / 0 major`。G1、G2、G3、G4 均通过双向核验；**可定稿**。

## 闭环状态复核

> closure commit：`955408a5b85cb3ce14bf4e8dc1ff3a81226f30a8`；技术冻结提交：`0e524438cfa9d7197484731b9f89fc8c263223cb`。

以 `git show 955408a5:<path>` 和 `git diff 0e524438..955408a5 -- <三文件>` 复核：实施者报告第七轮 `0 blocker / 0 major` 与本 reviewer 原 verdict 一致；事实／判据报告对同一 SHA 记录 `0 blocker / 0 major`。Spec §11 明确两视角同一 SHA 均为 `0/0`、闭环完成且可交用户审核，同时保留 `confirmed-not-implemented`，不把目标态冒充已实现。两份报告状态头均为第七轮放行、无 stale pending。闭环状态复核：`0 blocker / 0 major`。
