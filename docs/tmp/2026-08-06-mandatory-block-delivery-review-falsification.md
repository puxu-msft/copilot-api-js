# Mandatory block delivery 与 HTTP/2 终止观测规格评审——事实与判据证伪

> 状态：第七轮 `0 blocker / 0 major`，事实／判据视角已放行；两个正交视角均已放行同一固定提交
>
> reviewer：独立事实／判据证伪 reviewer
>
> 评审基线：`2bd0b83d88d67f67a315bfc1ba331c75c28b9cff`
>
> 原始报告由 reviewer 通过工具返回；本文件逐条转录其 finding，供多轮处置保留。Reviewer 未修改仓库。

## Gate

Reviewer 在隔离 worktree detached 到固定提交，核验 `pwd`、top-level、HEAD 与干净状态。它逐段对账 spec／ADR／backlog／DESIGN，扫描 sink、buffering 配置、retreat、SSE、HTTP/2、trailers 与 History journal，并模拟生产入口、并发策略、终止分支、事务崩溃点和性能 mutation。Reviewer 未运行测试。

## C1～C7

- C1 通过：当前 translate、direct、Responses 与 Gemini 仍有 live sink；配置仍能关闭 buffering，cap 超限仍会 retreat live。
- C2 通过，但引出 F1：WHATWG 要求 EOF 丢弃 pending data；当前代码没有在 EOF dispatch 残余 event。
- C3 通过：DATA handler 保持纯 enqueue；GOAWAY 参数未消费。
- C4 通过：trailers 仍写 request-global 槽。
- C5 通过：journal 先独立写，operation／CAS 后进另一事务；spec 的 recovery set 是目标态。
- C6 通过：spec、backlog 与 DESIGN 均诚实区分目标态和当前态。
- C7 未验证：隔离树无 History 数据库；三个固定样本仅见于 spec，无法独立复核 attempt／client marker、末帧及 terminal 缺失。

## 第一轮 verdict

`0 blocker / 6 major`，修复 major 并复审后可进入下一阶段；当前不可定稿。

## Findings

### F1 · Major：SSE 空行 dispatch 条件比 WHATWG 更宽

Spec 写“由空行终止的 event 必须 dispatch”，但 WHATWG 在 data buffer 为空时会中止 dispatch。当前 parser 可让仅含 `event:`／`id:` 的输入生成 event。若按现文补测试，会把现有标准偏差冻结为目标。

建议限定为“具有非空 data buffer 且由空行终止”，加入 `event:`-only、`id:`-only 正反样本。

### F2 · Major：response-level unit 的帧所有权与提交边界不闭合

真实前缀必须缓冲，但 spec 又要求 terminal commit 时无 open unit。若整响应算 open unit，正确响应无法提交；若不算，`buffer-real-frame` 由谁、按何边界整体提交未定义。`CompleteClientUnit` 是否携带已缓冲帧也未定义，可能重复写或永久扣留。

建议按协议冻结状态转移和 frame ownership／consumption。

### F3 · Major：production entry set 与双向可达性验收缺失

现有验收未冻结 direct／translate／reverse／Gemini／WS／web search 等生产入口，也未要求逐入口证明只能到达 owner。漏迁入口或新 helper／alias 直写时，已有 mutation 仍可能全绿。

建议建立 production entry set，并做“每入口可达 owner、不可达底层 sink”的 AST／调用图双向守卫。

### F4 · Major：evidence bytes owner 状态机与全退出路径释放缺失

Spec 未定义 session GOAWAY recorder 到 History writer 的 API，也未定义 loser dispatch、History 禁用、prepare／journal 失败、永久提交失败、shutdown 的释放责任。现有验收只测持久对象，不测进程内 handle，允许 digest 有而 bytes 丢失或永久泄漏。

建议冻结 owner 状态机，并为所有退出路径加入释放／可重试正反控。

### F5 · Major：fixed-shape snapshot 没有闭合 schema 与字段上界

字段列表使用“包括”，error／reason 无数值界限；GOAWAY-after-end 未规定保持 frozen、标记不可用或允许 late mutation。字段缺席、无界字符串、终止后改写都可能通过。

建议冻结闭合类型、每个 terminal 分支的完整字段形状与长度上限，以及 GOAWAY-before／after 期望。

### F6 · Major：对象分配与字节复制 mutation 被合并

硬约束把额外对象分配和额外字节复制列为独立禁项，但验收把两者合成一个 mutation。执行者可以只注入一种而宣称全部可检测。

建议拆成四个独立 mutation：时钟、对象分配、字节复制、callback，并逐项确认失败来自目标机制。

## 主会话处置表

| Finding | 级别 | 处置 | 证据／整改 |
|---|---|---|---|
| F1 | C | 采纳 | WHATWG dispatch algorithm 在 data buffer 为空时中止；当前 parser 可从 `event:`／`id:`-only 构造 event。Spec §3／§9.1 已要求修正 empty-data 偏差，并分开 EOF-flush 与 empty-data-dispatch 变异。 |
| F2 | C | 采纳 | 旧 outcome 没有定义 `CompleteClientUnit.frames`，response-level buffer 也没有消费出口。Spec §4.2 已冻结 unit／response buffer 的单次所有权转移、`response-terminal.responseFrames` 与 truncation 销毁语义；§9.3 加逐 adapter 状态转移验收。 |
| F3 | C | 采纳 | 与 I4 独立重合。Spec §4.7 以 path-qualified 5 roots／9 pumps 冻结 production set，并同时测正确 root 可达 owner 与错误 root 不可达 writer。 |
| F4 | C | 采纳 | 与 I2 独立重合。进一步反例发现 session 可能先于 History acquire 退役；Spec §5.4～§5.5 改为 first-write 同步 retain operation ref、terminal seal 产生 `OperationPersistenceEnvelope`，关闭该空窗。 |
| F5 | C | 采纳 | Spec §5.3 已替换“包括”式字段表，冻结 schemaVersion 1 的闭合类型、128／1,024 UTF-8 byte 上界、null 形状与 GOAWAY-after-end 永不 late-mutate；§9.2 加正反验收。 |
| F6 | C | 采纳 | Spec §8.2／§8.3／§9.5 已拆成 clock、object allocation、byte copy、callback 四个独立 variant 与报告行，逐项核对退化机制。 |
| C7 | C | 降级并显式标注 | 当前评审 worktree 无运行态 History DB。Spec §1 明确三个样本是原故障排查的一手运行态记录，reviewer 未独立重放，且该事实不作为书面规格定稿门。 |

性质→验收对账抓到并修复一处已知正样本：正文把实际 6 个 strategy variant 写成“5 个”；现已改为 6，并在 §9.5 保持 4 个 mutation 的正确基数。

## 第二轮复审

> 固定复审 HEAD：`d1a0ad2e3261a643f23f681f2263744bceb22a0e`（base `2bd0b83d88d67f67a315bfc1ba331c75c28b9cff`）
>
> Verdict：`0 blocker / 5 major`。F2、F6 已闭合；F1、F3、F4、F5 仍有 major；另发现旧 journal v1 digest compatibility major。当前不可定稿。

### Gate 与双视角覆盖

Reviewer 机械核对整改 diff、WHATWG SSE algorithm、production stream graph、History format／digest 兼容、snapshot／registry 类型与 runtime harness；执行模拟覆盖 empty-data ID 继承、warmup／precommit synthetic 流、GOAWAY 未观察态、事务 A 重试、旧 journal 恢复、response-level 正常／截断和四类性能 mutation。

### 原 finding 逐项 verdict

- **F1：仍有 major。** Empty-data 不 dispatch 已修，但遗漏 WHATWG last-event-ID 更新、空 `id:` 重置、U+0000 忽略和下一 data event 继承。
- **F2：闭合。** Unit／response buffer 所有权、单次消费、terminal commit 与 truncation 销毁已闭合。
- **F3：仍有 major。** 5 roots／9 pumps 漏掉 warmup `drop|fake` 和 precommit AskUserQuestion 两条直接结构化流写出路径。
- **F4：仍有 major。** `OperationEvidenceLease` 未定义，session ref 有双 release 歧义，且 transient rollback 保留重试与“refcount 为零”验收冲突。
- **F5：仍有 major。** GOAWAY 未在 snapshot 前观察到时，强制 `EvidenceCapture` 无诚实 union variant。
- **F6：闭合。** 4 类性能 mutation 与双 runtime harness 已闭合。
- **C7：处置成立但仍 unverified。** 固定 worktree 无运行态 DB 的限制已诚实记录。

### 新增 Major：旧 journal v1 digest compatibility

当前 recovery 同时接受当前 prepared digest 与 `legacyV1Digest(record)`；spec 只冻结 manifest-v2 digest，会拒绝真实旧 v1-digest pending row。须保留 v1／v2 两条冻结 digest oracle和真实 fixture。

### 第二轮 verdict

`0 blocker / 5 major`。修复后须复审。

### 主会话第二轮处置

| Finding | 级别 | 处置 | 整改方向 |
|---|---|---|---|
| F1-r2 | C | 采纳 | §3／§9.1 冻结完整 last-event-ID buffer：`id:`-only 无 MessageEvent 但更新状态，空值重置，含 U+0000 忽略，下一 data event 继承。 |
| F3-r2 | C | 采纳 | §4.7 扩为 6 个真实 graph roots／11 个 pumps，warmup drop／fake 与 precommit AUQ streaming 全部迁入 synthetic owner；route catch 成为 graph root。TypeScript compiler AST 独立枚举同时识别 driver sink 与 `stream.writeSSE`，精确得到 11 个函数，并确认 6 个冻结 roots 存在。 |
| F4-r2 | C | 采纳 | §5.4 定义 `OperationEvidenceLease` 唯一 release，注册后只由 `RegisteredEvidence.releaseSessionRef()` 释放 session ownership；验收区分 transient retry-retained 与 terminal release。 |
| F5-r2 | C | 采纳 | §5.3 把 GOAWAY evidence 改成 `not-observed-before-snapshot`／`unavailable-at-source`／`captured`／`unavailable-at-capture` 闭合 union，以字段级 `SnapshotScalar` 冻结 observation→detail 合法组合。 |
| J1-r2 | C | 采纳 | §6.3 冻结旧 journal v1／v2 digest oracle，各自使用真实 fixture；旧 oracle 验证 pending row 完整性后迁移提交为 manifest v3，不能用 v3 digest 反向替代旧 oracle。 |

## 第三轮复审

> 固定复审 HEAD：`97fcadde98c118e53ca8f09604dc47162959c65e`（base `d1a0ad2e3261a643f23f681f2263744bceb22a0e`）
>
> Verdict：`0 blocker / 4 major`。F1 last-event-ID、F3、J1 已闭合；F4／F5 仍有 major，并新增 SSE empty-value data 与 finish diagnostic 两项 major。当前不可定稿。

### 已闭合

- F1 last-event-ID：更新、空值重置、U+0000、继承、跨 chunk 与 mutation 已闭合。
- F3：6 roots／11 pumps、warmup／AUQ synthetic owner 与双向守卫已闭合。
- J1：两条 legacy digest oracle、真实 fixture 与 v3 migration 已闭合。
- 独立 Node server harness、F2 frame ownership、F6 四个性能 mutation 保持闭合。

### Major findings

1. Session ref 仍在 session retire 释放；GOAWAY 后仍在途 dispatch 可能尚未 first-write／retain，bytes 会过早丢失。
2. 同 digest sibling 去重共用 operation ref时，一条 first-write 被拒可能误释另一条 accepted sibling 仍需要的 ref。
3. `goaway.observation="unavailable-at-source"` 仍允许 observed scalar，形成自相矛盾状态。
4. 缺 `data:\n\n`／无冒号 `data` 的 empty-value 正样本；错误丢弃空字符串 MessageEvent 仍可全绿。
5. `valid-terminal-without-boundary` 要求保留原 terminal 字符串，但 `ClientTerminal`／`DeliveryFinishClass` 没有 diagnostic 载体。前两项合并为 F4 所有权 major 簇，因此 verdict 总计 4 major。

### 主会话第三轮处置

| Finding | 级别 | 处置 | 整改方向 |
|---|---|---|---|
| F4-r3 | C | 采纳 | GOAWAY 同步为当时每个 in-flight dispatch 创建独立 `DispatchEvidenceClaim` 后释放 session ref；claim 单次 transfer／release，每个 dispatch 保留独立 operation lease，仅事务 A 的持久 CAS insert 按 digest 去重。拒绝 sibling 只释放自己的 claim。 |
| F5-r3 | C | 采纳 | 顶层 `unavailable-at-source` 时所有 scalar 都必须 source-unavailable；若 event 可见但部分字段不可见，顶层为 observed。 |
| SSE-r3 | C | 采纳 | §3／§9.1 增加 `data:` 与无冒号 `data` 的空字符串 MessageEvent 正样本和错误丢弃 mutation。 |
| FIN-r3 | C | 采纳 | `ClientTerminal` 增加有界、可序列化 diagnostic，完整保留 `valid-terminal-without-boundary.terminal` 原字符串并加 round-trip oracle。 |

## 第四轮复审

> 固定复审 HEAD：`0b933be2adbe15e0688cfcccc4544bcffdc918a2`（base `97fcadde98c118e53ca8f09604dc47162959c65e`）
>
> Verdict：`0 blocker / 2 major`。F5、SSE empty-value、finish diagnostic 已闭合；首次 GOAWAY lifecycle 与 sibling ownership 已闭合，但 repeated GOAWAY 和 fan-out exception 一致性仍未闭合。

### 已闭合

- 首次 GOAWAY：同步 non-admitting、无 await 快照、per-dispatch claim、晚 first-terminal、sibling 独立 ownership、transient retry 与 shutdown均已定义。
- F5：顶层 source-unavailable 强制 scalar／evidence source-unavailable。
- SSE empty-value：`data:`／bare `data` 正常 dispatch 空字符串，no-data 不 dispatch。
- Finish diagnostic：原字符串载体、256-byte fail closed 与 round-trip oracle 已闭合。

### Major findings

1. RFC 9113 允许同 connection 多次 GOAWAY，后续 `Last-Stream-ID` MUST NOT 增加。First-claim-only 会拒绝第二 event，丢失其 evidence 与更严格边界。
2. Fan-out 中途异常保留已安装 claims，却让尚未遍历 dispatch 无 claim，允许同一 GOAWAY 下部分 captured、部分 unavailable 的静默缺失。

### 主会话第四轮处置

| Finding | 级别 | 处置 | 整改方向 |
|---|---|---|---|
| GOAWAY-r4 | C | 采纳 | 改为 session-local 有序 GOAWAY ledger；每 event 有 sequence／完整 evidence，后续 lastStreamID 单调不增，dispatch terminal 冻结完整事件前缀。 |
| FANOUT-r4 | C | 采纳并换共同基座 | 取消 GOAWAY 时 fan-out。每个 physical dispatch 在 `beginDispatch` 时取得 ledger lease；GOAWAY 仅原子 append 一次，所有 in-flight leases 自然共享同一前缀。Terminal 原子冻结前缀并转成 operation lease，彻底消除 partial fan-out。 |

## 第五轮复审

> 固定复审 HEAD：`21e455989182c72c04621644f789ad895c84d768`（base `0b933be2adbe15e0688cfcccc4544bcffdc918a2`）
>
> Verdict：`0 blocker / 1 major`。Ordered ledger、lease ownership、repeated GOAWAY 等值／递减、prefix freeze、History refs 均闭合；剩余 major 是非法递增 GOAWAY 的真实 Node harness oracle 与规格预期冲突。

### 已闭合

- Session-local ordered ledger 取代 fan-out，消除 partial install。
- Dispatch open 前 lease、append transaction、terminal prefix freeze、session close 后 bytes ownership 与 History transient retry均闭合。
- 同 digest 两 event 保留两条 sequence→digest ref，CAS 只去重实体。

### Major：非法递增 GOAWAY runtime capability

Spec 要求先保存 offending event 再 `PROTOCOL_ERROR`，但 Node v24.16.0 公共 server API 的结果不稳定：reviewer 同步连续 `goaway(1)`→`goaway(3)`稳定得到客户端只见第一 event、随后 connection `PROTOCOL_ERROR`；主会话用 `setImmediate` 分隔时稳定观察到第二调用被钳制为 ID 1并正常 callback。故公共 fixture 不能作为稳定 raw-wire oracle。

### 主会话第五轮处置

| Finding | 级别 | 处置 | 整改方向 |
|---|---|---|---|
| ILLEGAL-r5 | C | 采纳 | Harness 每次 run 探测 `fixture-clamped`／`runtime-rejected`／`raw-invalid-visible`／`unsupported`。仅帧级 oracle 证实非法 frame 到线且 callback 可见时要求 ledger 保存 offending event；runtime 预拦截时保存 transport `PROTOCOL_ERROR` 与 offending-frame unavailable；clamped 时保存实际非递增 callbacks。共同反控：不得无错误地向应用暴露递增 ID。Reviewer 保留同步连续调用得到 runtime-rejected 的实测，撤回“public Node fixture 能稳定制造并向 JS 暴露非法 frame”的隐含前提；主会话 `setImmediate` 时序实测为 clamped。 |

## 第六轮复审

> 固定复审 HEAD：`2f706e7d4891e5018c8b7c6ab3f57a12f29a5a1f`（base `21e455989182c72c04621644f789ad895c84d768`）
>
> Verdict：`0 blocker / 2 major`。四态 capability 的总体方向、证据边界与 `RegisteredGoawayEvidence` ownership 均正确；剩余缺口是 production protocol-error 的事件顺序，以及 `fixture-clamped` 缺少“第二调用确实产生该 callback”的正证据。当前不可定稿。

### Gate 与双视角覆盖

- 机械核对：detached HEAD、status、`21e45598..2f706e7d`；逐项对照 `InvalidGoawayCapability` 四态、生产 `GoawayProtocolViolation`、raw oracle／attemptedOracle、ordered ledger ownership 与 RFC 9113 §6.8。
- 第一人称执行：模拟同步 runtime-rejected、`setImmediate` clamped、只有第一 callback 且无 error、raw-invalid-visible、unsupported、stream error 先于 session error、terminal freeze 以及 append／close／History refs。Node v24.16.0 真探针事件顺序为 `goaway(1) → stream ERR_HTTP2_ERROR → stream close → session ERR_HTTP2_ERROR → session close`。

### 已闭合

- 四态 capability 按每次 run 动态裁决，禁止用 server 调用参数自证 wire；同步与 `setImmediate` 结果仅作经验锚点，不硬编码版本。
- `raw-invalid-visible` 需要帧级 oracle，`unsupported` 带 `attemptedOracle`，共同反控禁止 visible increase + violation none。
- 生产归因保持 `unattributed`，不把 harness fixture intent 回写生产 record，也不伪造 offending frame。
- `RegisteredGoawayEvidence` 的 append 成功消费／发布前失败调用方 release、session close 只释放 owner ref、dispatch／operation／History leases 延长 bytes 生命周期，均未回归。

### Major findings

1. 生产只规定 session error path 调 `recordUnattributedProtocolError()`，但 first-terminal 会在 stream error 时同步 freeze ledger。Node v24.16.0 真探针稳定顺序是 client `goaway(1)`，随后 stream `ERR_HTTP2_ERROR`，最后才是 session `ERR_HTTP2_ERROR`。因此 dispatch 会先冻结 `violation:none`，session path 后写因 no-late-mutation 永远进不了该 dispatch History。应让 stream／session 共享 one-shot protocol-error recorder，最早观察者在 `controller.error`／first-terminal freeze 前写 ledger，后到者只去重；测试该精确顺序及 session-first 反向顺序。
2. `fixture-clamped.callbacks` 只要求非空 tuple，未要求其中存在可归属于第二调用的 callback。若 fixture 只产生第一条合法 callback、静默丢掉第二调用且无 protocol error，现类型可仅凭 server attempted call 把它判成 clamped。第二调用应携唯一 opaque token；`fixture-clamped` 必须记录匹配该 token digest 的 callback sequence 且 ID 非递增，否则归 `unsupported`；增加“只有 first callback、无 error”不得判 clamped 的反控。

### 第六轮 verdict

`0 blocker / 2 major`。修复 protocol-error-before-freeze 的共享记录点与 clamped 第二-callback provenance 后，再复审方可定稿。

### 主会话第六轮处置

| Finding | 级别 | 处置 | 整改方向 |
|---|---|---|---|
| ORDER-r6 | C | 采纳 | Stream／session 的 protocol-error path 共用 ledger one-shot recorder；最早观察者必须先记录，再触发 `controller.error`／first-terminal freeze 或 session cleanup，后到者去重。§9.2／§9.4 覆盖 stream-first 与 session-first 两种顺序及错误延后记录变异。 |
| PROVENANCE-r6 | C | 采纳 | 两次 fixture 调用使用 run 内唯一且彼此不同的 opaque token；`fixture-clamped`／`raw-invalid-visible` 必须恰有 first／second 两条有序 callback，构造器核对 `firstSequence < secondSequence`、digest 分别匹配对应 token，再比较两条 callback 的 ID。只有 first callback、只有 second callback、额外／重复 callback、token digest collision、null／未知 digest 等无法建立唯一 provenance 的形状必须是 `unsupported`；零 callback 或单一 first-token callback + `PROTOCOL_ERROR` 可正确分类为 `runtime-rejected`。不得靠 attempted call 判 clamped。 |

## 第七轮复审

> 固定目标提交：`0e524438cfa9d7197484731b9f89fc8c263223cb`（base `2f706e7d4891e5018c8b7c6ab3f57a12f29a5a1f`）
>
> 审查方式：因隔离树保留本报告未提交追加，未 checkout 目标；以 `git show <target>:<spec>` 和固定 diff 审查。Verdict：`0 blocker / 0 major`，事实／判据视角可定稿。

### Gate 与双视角覆盖

- 机械核对：`git rev-parse 0e524438` 得完整 SHA；读取第六轮与 disposition；逐行对账目标 spec 的三态 `GoawaySnapshot`、shared one-shot recorder、capability provenance、RFC 9113 证据边界、释放表和 §9.2／§9.4。
- 第一人称执行：模拟 ordinary zero-event、error-bearing zero-event、visible prefix + stream-first／session-first protocol error、clamped／runtime-rejected／raw-invalid-visible／unsupported 全形状，以及 only-first／only-second／额外／重复／null／unknown／digest collision；同时造错误状态全绿候选并检查正确样本不过严。

### 命题①：三态 snapshot／freeze／释放／验收一致——闭合

- 目标 spec `:403-420` 的 union 只允许：zero+none→not-observed、zero+unattributed error→source-unavailable、non-empty events→observed。`:449-456` prose、`:532` freeze、`:542-544` 释放表与 `:820-821` 验收完全对齐。
- False-green 控制明确覆盖 error-bearing zero 被降级、ordinary zero 被升格、source-unavailable+none、observed empty；ordinary zero 正样本单列通过。因此错误状态不能绿，正确无 GOAWAY／无 error 也不会被误拒。

### 命题②：shared one-shot recorder 与事件顺序——闭合

- 目标 spec `:348-356` 把“同 terminal signal 首次暴露 PROTOCOL_ERROR”置于 first-terminal CAS／freeze 前；`:499` API 返回 `recorded|already-recorded`；`:530` 明确 stream／session 最早观察者先记录，后到者不得覆盖 reason。
- `:822` 同时验 stream-first `prefix→stream error→record→freeze→session error` 与 session-first，并以“移到 controller.error 后／只 session 记录／覆盖 reason”三变异防假绿。正确两种顺序均有正样本，不会 false-red。

### 命题③：capability provenance 全形状——闭合

- 目标 spec `:735-775` 的闭合 union：clamped／raw 恰两 callback，rejected 仅 0 或 1 callback；`:777-784` 要 first／second run-unique token、严格 sequence、digest 一一匹配。
- `:779-782` 明确 only-first／no-error、only-second、额外／重复／null／unknown、digest collision 全归 unsupported；0 callback 或单 first + PROTOCOL_ERROR 正确归 rejected。`:784` 禁止 attempted call 自证 clamped；`:856` 对 unsupported 无 attemptedOracle、伪造 provenance、吞 error 等设独立变异。
- 未发现可让错误形状进入三种强结论的缺口，也未把合法 rejected 0／1 callback 或合法 clamped／raw 两 callback 误拒。

### 命题④：wire oracle 与生产归因——闭合

- 目标 spec `:777-784` 明确 public fixture 参数不自证 wire，raw-invalid-visible 仅在独立帧级 oracle + visible callback 时成立；runtime-rejected 不伪造 event；unsupported 必须记录 attemptedOracle。
- 生产 `GoawayProtocolViolation` 在 `:388-401` 只表达 visible callback 或 unattributed pre-callback error；`:441-453,530` 禁止从 fixture intent／错误时序推断 offending frame。Harness 分类与生产 attribution 分层清楚。

### 相邻契约回归

- `RegisteredGoawayEvidence` ownership 未回归：`:479-482,528` 仍是 append 成功消费、发布前失败调用方 release；`:534-552` session close 只释 owner ref，dispatch／operation／History lease 与 transient retry 职责不变。
- Ordered ledger、same-digest event 保序、raw evidence、SSE／adapter／History migration／performance harness 前轮已闭合部分未被本 diff 削弱。

### 主会话证据引用复核

Reviewer 原报告在命题③把 capability 变异验收写成 `:815`、在命题④把 public-fixture／wire-oracle 规则写成 `:740-747`；主会话对固定提交逐行复核后更正为 `:856` 与 `:777-784`。这是行号引用漂移，不改变 reviewer 对应命题或 verdict。

### 第七轮 verdict

**事实性发现：0 blocker / 0 major。未发现阻断性或 major 问题；事实／判据视角可定稿。**
