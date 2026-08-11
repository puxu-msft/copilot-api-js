# Mandatory Block Delivery 与 HTTP/2 终止观测实施计划

> 状态：`approved-not-implemented`
>
> 权威规格：[`docs/spec/2026-08-06-mandatory-block-delivery-and-h2-termination-observability.md`](../../spec/2026-08-06-mandatory-block-delivery-and-h2-termination-observability.md)
>
> 本目录只定义实施方法；规格是 what/why 单一事实源，当前 live 架构仍以 [`docs/DESIGN.md`](../../DESIGN.md) 为准。


## Context

近期 Responses 上游多次在 tool arguments 中途自然耗尽，缺少 `response.function_call_arguments.done`、`response.output_item.done` 和 response terminal；现有翻译层正确 fail closed，但部分生产路径已经逐 delta 写给客户端，随后才补 synthetic error。已冻结规格 `docs/spec/2026-08-06-mandatory-block-delivery-and-h2-termination-observability.md` 要求所有真实内容至少按完整 block／item 交付，无可靠中间边界的协议按 response terminal 原子交付；同时在不触碰 HTTP/2 DATA callback 的前提下记录 dispatch-scoped first-terminal、ordered GOAWAY、trailers 和 History V3 evidence。

技术规格由两个正交 reviewer 对固定提交 `0e524438cfa9d7197484731b9f89fc8c263223cb` 给出 `0 blocker / 0 major`，闭环记录在 `955408a5b85cb3ce14bf4e8dc1ff3a81226f30a8`，当前状态仍为 `confirmed-not-implemented`。本计划只描述实施；实施完成前不修改 `docs/DESIGN.md` 的 live 状态。

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施。每个任务按 TDD：先红、再绿、再重构、再精确 pathspec 提交。

**Goal:** 退役所有 production live／cap-retreat 内容旁路，统一 typed delivery grammar 与单写 owner，并把 HTTP/2 终止／GOAWAY evidence 以 dispatch-scoped、可恢复的 History V3 形状持久化。

**Architecture:** 扩展现有 `src/lib/pipeline/delivery/session.ts`，使其成为规格中的 `BlockDeliveryOwner`，不平行创建第二个 owner；把现有 `CandidateBoundaryClassifier` 合并进 typed `DeliveryProtocolAdapter → DeliveryGrammar`，避免二次解析与双源边界。Transport 只采集冷路径事实，经 `dispatch-scheduler` 和 RequestContext 的 dispatch capability 写入 canonical record；History writer 以 schema 6／manifest 3／journal 2 两事务恢复集持久化。

**Tech Stack:** TypeScript、Bun、Hono SSE／WS、`node:http2`、bun:sqlite History V3、tsdown、Bun／Node 双 runtime harness。

## Global Constraints

- 真实客户端内容永久执行 block-level delivery；Chat Completions、Responses WS、Gemini 和无可靠中间边界的 reverse legs 执行 response-terminal delivery。
- 不保留 production `runResponseSink`、delivery enable boolean、`buffer_cap_bytes` retreat、route terminal／`[DONE]` 直写或第二套 boundary classifier。
- HTTP/2 DATA callback 逐字保持 `req.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)))`；不得加入时钟、计数、对象、callback、日志或额外复制。
- 不等待 physical close，不增加 debounce／polling／sleep；first terminal 先冻结 snapshot，再终止 consumer。
- 不为超大单块添加 spool／磁盘溢写或降级；内存不足按普通不可恢复错误处理，绝不退回 live。
- retry 只由 `max_retries` 控制；旧 delivery mode-switch 兼容解析后迁移为 retry 语义并警告，不能关闭 delivery。
- 性能只报告 A/A、A/B paired delta 与单侧 bootstrap 95% CI，不设固定门，不声称“零性能回归”。
- 生产 attribution 只记事实；测试 fixture intent 不得写入 production snapshot。Bun clean EOF／RST 保持 `indeterminate`，专项调查仍留 backlog。
- 不启动或终止 4141 主服务器；需要服务器验证时使用非 4141 端口并按精确 PID 清理自己启动的实例。
- 每个语义任务单独 conventional commit，显式 pathspec；不 push。凡任务会产出多于一个语义 commit、或单 commit 但历时长／需试错，派活前为该实施者建立独立 progress 文件 `docs/tmp/2026-08-07-mandatory-block-delivery-h2-progress-t<task>.md`；一 agent 一文件，每个实现 commit 同步更新。一次成型的单 commit 任务不强制建 progress 文件。
- 完整实现后才更新 `DESIGN.md`／`API.md`／coding conventions／config 文档；所有生产路径与 History migration 完成前不得写成 live。

## 文件与责任边界

### 新建

- `src/lib/pipeline/delivery/protocol.ts`：闭合 `DeliveryFrameClass`、`DeliveryFinishClass`、`DeliveryOutcome`、`ClientTerminal`、`ClientProtocolError`、adapter 接口。
- `src/lib/pipeline/delivery/grammar.ts`：唯一 typed 状态机；不解析 wire，不写 sink。
- `src/lib/pipeline/delivery/adapters/{anthropic,responses,chat-completions,gemini}.ts`：唯一 wire→semantic classifier 与 terminal／error／`[DONE]` renderer。
- `src/lib/pipeline/delivery/synthetic.ts`：`runSyntheticResponse()`，供 warmup 与 AUQ 复用同一 owner。
- `src/lib/transport/http2-observation-types.ts`：唯一 serializable termination／GOAWAY closed union、bounded text、`GoawaySnapshotSource` 契约。
- `src/lib/transport/http2-termination.ts`：first-terminal recorder、默认 ordinary-zero-event source、never-throw observer。
- `src/lib/transport/http2-goaway-ledger.ts`：导入上述唯一 schema，实现 session ledger、dispatch／operation leases、registered evidence ownership。
- `src/lib/context/operation-persistence-envelope.ts`：canonical record + operation GOAWAY leases 的单一持有者。
- `tests/transport/h2-fixture-server.ts`、`tests/transport/h2-termination-client.ts`、`scripts/run-h2-termination-matrix.ts`：独立 Node server + Bun／Node production-client matrix。
- `tests/transport/h2-delivery-benchmark.ts`、`scripts/run-h2-delivery-benchmark.ts`：A/A、A/B 与四个 mutation controls。
- `tests/architecture/mandatory-delivery-graph.unit.test.ts`：6 roots／11 pumps 双向 AST／symbol guard。
- `tests/history/v3/fixtures/transport-evidence/`：schema-5／manifest-v1/v2／journal-v1 真实 fixture。

### 扩展而非替换

- `src/lib/pipeline/delivery/session.ts`：升级为唯一真实／synthetic／terminal wire owner；复用 serializer、heartbeat、allocation port 和 terminal fence。
- `src/lib/pipeline/generation/candidate-response-session.ts`：持有 adapter／grammar；现有 accumulator／renderer state 保留。
- `src/lib/pipeline/generation/boundary-classifier.ts`：降为 grammar outcome 的只读 readiness 投影，删除独立 JSON 分类。
- `src/lib/pipeline/stream/response-processor.ts`：先逐帧消费 `finish.frames`，再消费 finish verdict，二者各一次。
- `src/lib/pipeline/driver.ts`：单一 owner drain／retry orchestration；删除 production live 和 cap-retreat 分支。
- `src/lib/pipeline/generation/dispatch-scheduler.ts`、`src/lib/pipeline/types.ts`：dispatch observation capability 在 `beginDispatch` 后、physical `open` 前安装。
- `src/lib/transport/http2-client.ts`：session ledger 与 stream recorder 接线；DATA callback 不变。
- `src/lib/context/model-operation-record.ts`、`src/lib/context/request.ts`：Task 10 activation commit 同时加入 dispatch `transportTermination`／`responseTrailers` first-write 槽、lease sidecar 与 History refs。
- `src/lib/history/v3/store.ts`、`projection.ts`：schema 6／manifest 3／journal 2、evidence CAS、两事务 recovery set 和 API projection。
- 11 个生产 pump：`messages`、`responses` HTTP／WS、Chat Completions、Gemini、reverse legs、warmup、AUQ。
- 配置：`packages/foundation/src/{state,state-defaults}.ts`、`src/lib/config/{schema,config,compat,model-overrides}.ts`、`config.yaml`、status route 与测试。

## 冻结跨层接口

### Dispatch transport observation capability

`dispatch-scheduler` 在 `beginDispatch()` 后立即从 RequestContext 取得 port，并在调用 `PhysicalTransport.open()` 前放入 `TransportDispatchOptions`。HTTP/2 transport 选择 session 后、调用 `session.request()` 前，从该 session ledger 获取 lease 并安装；plain HTTP／upstream WS 不伪造 HTTP/2 snapshot。

```ts
interface Http2TerminationCommitPort {
  trySetTransportTermination(
    build: (goaway: GoawaySnapshot) => TransportTerminationSnapshot,
  ): boolean
}

interface DispatchTransportObservationPort extends Http2TerminationCommitPort {
  readonly dispatch: DispatchHandle
  tryInstallGoawaySource(
    source: GoawaySnapshotSource<OperationGoawayLease | null>,
  ): "installed" | "rejected"
  trySetResponseTrailers(trailers: ReadonlyArray<OperationHeaderField>): boolean
}

interface TransportDispatchOptions {
  forceHttp?: boolean
  signal?: AbortSignal
  observation?: DispatchTransportObservationPort
}
```

所有权规则：任何 commit port 都独占自己的 GOAWAY source。Task 7 的 per-request transport-local default port 独占 ordinary-zero source，不接 RequestContext／canonical record／lease；Task 10 的 RequestContext port 独占 installed real source。`installed` 消费 source；`rejected` 不消费，HTTP/2 caller 立即 release 且不得创建 stream。HTTP/2 recorder 不持有或 freeze source；它只调用 `trySetTransportTermination(builder)`。Port 先 CAS terminal slot：CAS 拒绝时绝不调用 builder／freeze；CAS 成功时 port 内部恰好一次 `source.freezeAtTerminal()`，并调用 builder恰好一次。Local port不接callback、不保存snapshot、不调用observer，只丢弃builder返回值；RequestContext port在同一临界区写入builder返回的完整snapshot与returned operation lease。Recorder通过builder closure捕获成功构造的snapshot，在`trySet...`返回true后唯一一次调用`onTermination(snapshot)`，catch并隔离observer异常；false时builder与observer均零次。不存在port observer，也不存在recorder→RequestContext的lease返还步骤。

### Canonical terminal 与 persistence handoff

现有 terminal bus 的 recent cache／stats／queries 继续只看 inert `ModelOperationRecord`，不能拿到 bytes lease。新增唯一 persistence sink，bus 同步转交 `OperationPersistenceEnvelope`；无 sink或 sink 拒绝时 bus 立即 release。异步 record observers 与 persistence ownership 分离。

```ts
interface OperationPersistenceEnvelope {
  readonly record: ModelOperationRecord
  readonly goawayLeases: readonly OperationGoawayLease[]
  release(): void
}

type ModelOperationTerminalSubscriber = (record: ModelOperationRecord) => void | Promise<void>
type ModelOperationPersistenceSink = (
  envelope: OperationPersistenceEnvelope,
) => "accepted" | "rejected"
```

`publishModelOperationTerminal(envelope)` 的固定顺序：先把 `envelope.record` 放 recent cache并通知 record observers；再把完整 envelope 同步交给唯一 persistence sink。`accepted` 后 queue／History writer 成为唯一 release owner；`rejected`、History disabled 或无 sink由 bus release。不得把同一 envelope fan-out 给多个 owner。

## Commit invariants

1. Grammar／adapter commit 只新增 typed 基座，不改变 production routing。
2. Owner commit 必须保留现有 allocation／anchor／heartbeat tests 全绿；不能同时存在两个 client-wire serializers。
3. 每个 pump 迁移 commit 都必须让该 pump 只能到达 owner；迁移前不得删除其旧终止语义测试，迁移后以 client-visible golden 证明不丢 terminal／error／synthetic marker。
4. 删除 live／retreat／mode-switch 只能在 11 pumps 全迁移并通过 AST 双向 guard 后落地。
5. HTTP/2 recorder commit 不得修改 DATA callback；Task 8 可先落未接线的 inert ledger primitive，但所有 production wiring（session ledger、dispatch port／lease install、freeze、terminal envelope、persistence sink）必须在 Task 10 同一 activation commit 接通，不能留下 callback fan-out、无 lease stream 或含 lease envelope 进入旧 writer。
6. History evidence schema 与 writer transaction A 同 commit 落地；manifest／journal reader compatibility 与版本 bump 同 commit 落地。
7. 文档 live 状态只在代码、matrix、backend suite 与双 reviewer merged-state review 都通过后更新。

---

## 阶段 DAG

1. [`plan-1-sse-and-delivery-foundation.md`](plan-1-sse-and-delivery-foundation.md)：Task 1～4，SSE、typed grammar、adapter 与唯一 owner。
2. [`plan-2-production-pump-migration.md`](plan-2-production-pump-migration.md)：Task 5～6，11 pumps ratchet 迁移与配置双轨退役。
3. [`plan-3-http2-observation.md`](plan-3-http2-observation.md)：Task 7～9，termination contract、ordered ledger 与 History storage substrate。
4. [`plan-4-history-and-verification.md`](plan-4-history-and-verification.md)：Task 10～12，production activation、runtime／performance harness 与 merged-state 验收。

执行入口见 [`KICKOFF.md`](KICKOFF.md)。阶段 1→2 与 3→4 各自有强依赖；Task 7、8、9 可依次形成行为中性的完整提交，Task 10 才原子激活 production evidence 链。

## 评审记录

- [`review-implementer.md`](review-implementer.md)：实施者可执行性与每 commit 可绿审查，最终 `0 blocker / 0 major`。
- [`review-falsification.md`](review-falsification.md)：spec coverage、判据双向性与 mutation 审查，最终 `0 blocker / 0 major`。

两份记录是 Plan Mode 单文件评审的转录件，不能自动替代拆分后复核。拆分后的真实目录已完成两个正交视角复核，均为 `0 blocker / 0 major`：见 [`review-split-implementer.md`](review-split-implementer.md) 与 [`review-split-falsification.md`](review-split-falsification.md)。

## 计划评审处置记录

### 第一轮

| Finding | 级别 | 处置 | 整改 |
|---|---|---|---|
| 实施者 M1：Task 8 需要 RequestContext／dispatch slots，却把 API 推迟到 Task 9 | C | 采纳 | 先把 slots 前移，随后根据事实 reviewer 的 persistence finding 进一步重排：Task 8 只交付 inert ledger，Task 9 先交付 storage substrate，Task 10 用单一 activation commit 同时接通 slots、scheduler、H2 install、terminal envelope 与 persistence sink。 |
| 实施者建议：Task 9 的 `state.ts` 路径含糊 | C | 采纳 | 明确为 `src/lib/history/state.ts`，并写清替换 `subscribeModelOperationTerminals(enqueueModelOperation)` 的路径。 |
| 判据 M1：Task 3 先删 compatibility delivery fields，Task 4 才接 owner | C | 采纳 | Task 3 保留只读 compatibility projection；Task 4 切换 owner consumption 的同一 commit 才删除。 |
| 判据 M2：Task 9 先 publish lease envelope，Task 10 才有 evidence CAS | C | 采纳 | 重排为 Task 9 storage substrate 先落、Task 10 production handoff 原子激活；旧 writer 永不接触含 lease envelope。 |
| 判据 M3：旧 `enabled:true` retry 兼容缺正反样本 | C | 采纳 | 补默认／显式 `max_retries` 两类正样本，并断言都不改变 mandatory delivery。 |
| 判据 M4：GOAWAY ambiguous／rejected 形状与 mutation 未逐项冻结 | C | 采纳 | Task 11 逐格列出 only-first／only-second／额外／重复／null／unknown／collision 与 rejected 0／1 callback，并拆分 provenance／error／attemptedOracle mutations。 |
| 判据 M5：性能 raw JSONL 缺 commit／strategy digest，A/B 可测同一实现 | C | 采纳 | 每 block 记录 source commit／strategy digest；A/A digest 必须同、A/B 必须异；同 strategy 双标签 mutation 必须在汇总前红。 |
| 实施者复审 M1：Task 2 在 adapter outcome source 就绪前删除 classifier JSON logic | C | 采纳 | Task 2 只新增纯 grammar并保持现有 classifier；Task 3 在 adapter／candidate session 建立真实 outcome feed 的同一 commit 才把 classifier 切为 projection，并跑 hedge／readiness 正样本。 |
| 判据复审 M1：progress 三处集合冲突 | C | 采纳（并发自审已先修） | 当前全局约束、执行策略与 kick-off 均统一为一 agent 一文件；多 commit／长时任务为 Task 5／9／10／11，路径分别为 `progress-t5`／`t9`／`t10`／`t11`，不存在旧 `progress-impl` 或 Task 8 残留。 |
| 实施者最终复审 M1：Task 7 的完整 snapshot 依赖 Task 8 尚未定义的 GOAWAY schema | C | 采纳 | Task 7 新增唯一 `http2-observation-types.ts`、泛型 `GoawaySnapshotSource` 与 ordinary-zero default source factory；Task 8 导入同一 union并实现含 operation lease 的 source；Task 10 由 RequestContext 安装并独占真实 source，禁止复制 schema或让 recorder 持有 source。 |
| 实施者最终复审 M2：Task 5 分批迁移却提前启用全量 11-pump hard guard | C | 采纳 | Guard 改为 strict／pending ratchet：两集合无交集且并集精确等于已知 11 pumps，未知 root 立即红；每批同 commit 把本批移入 strict，最终批次要求 pending 空并切全量 hard guard。 |
| 判据再复审 M1：ratchet 未冻结各中间批次成员，可原样留 pending 假绿 | C | 采纳 | 预先冻结 Batch 0～4 的 exact strict delta 与数量，pending 由 frozen set 差集派生；pending 必须命中冻结 legacy sink，strict 必须 owner-only；未迁／漏移／回退逐批 mutation 当批红。 |
| 判据收口 M1：installed GOAWAY source 与 recorder 双 owner，operation lease 无法原子回到 RequestContext | C | 采纳 | 选择spec §5.5的port-owner形状：Task10 RequestContext port install并独占real source；recorder只交builder；port先CAS，成功后内部freeze并原子写snapshot+lease，拒绝不freeze。补CAS拒绝／成功原子写／无丢失无双消费三控。 |
| 实施者再复审 M1：Task 7 recorder依赖到Task 10才存在的dispatch port，不能独立绿 | C | 采纳 | Task7前移通用`Http2TerminationCommitPort`与transport-local default port；default port独占ordinary-zero source，recorder始终只依赖port；Task10用RequestContext port替换实现，不改变recorder。 |
| 实施者收口 M1：local port callback与recorder observer形成双通知通道 | C | 采纳 | Local port改为无callback、无snapshot store、无observer，只做CAS/freeze/builder；recorder在成功后唯一调用`onTermination`并隔离异常。补成功一次／拒绝零次／throw不影响close-error三控。 |

所有 finding 均采纳，无驳回项。复审门是两视角最新轮均 `0 blocker / 0 major`；只剩 minor 时直接判可定稿。Kick-off 提示词属于 instruction text，复审必须显式覆盖其加载前置、执行禁区、状态与计划引用，不因篇幅小跳过。

## Spec coverage 对账

| Spec | Task | 承重验收 |
|---|---|---|
| §3 SSE | 1 | WHATWG framing／ID／EOF + 6 exact mutations |
| §4.1～§4.3 typed delivery | 2～3 | 全 union／合法后继／error semantic／adapter-only classification |
| §4.4 owner | 4 | 唯一 serializer、frame ownership、terminal fence、client-gone committed flag |
| §4.5 retry／hedge／continuation | 4～5 | pre-first-unit retry、winner-only takeover、loser zero leak、continuation only complete units |
| §4.6 envelope reservation | 4～5 | 复用 `GenerationWireState`／allocation port；message_start 一次、block index 连续、anchor-before-winner race |
| §4.7 production set | 5 | 6 roots／11 pumps 集合精确相等 + reach-owner／no-writer 双向 guard |
| §5.1 DATA | 7、11 | AST callback exact-shape + 4 independent performance mutations |
| §5.2～§5.3 first terminal | 7 | closed snapshot union、first-write、late-drop、never-throw observer |
| §5.4～§5.5 GOAWAY／dispatch | 8、10 | Task 8 inert ordered ledger；Task 10 原子 activation 的 three-state freeze、shared one-shot、lease install／transfer／release |
| §6 History evidence | 9～10 | Task 9 storage substrate／CAS／transaction A/B／legacy v1-v2／schema 6-manifest 3-journal 2；Task 10 envelope ownership activation |
| §7.1 config | 6 | permanent delivery、retry-only config、old-key warn-and-continue |
| §7.2 fail closed | 2～6、9～10 | half-unit discard、legal error terminus、History failure does not block network、OOM no live fallback |
| §8 performance | 7、11 | DATA unchanged、A/A-A/B paired report、four discriminating controls、no fixed gate |
| §9 acceptance | 1～12 | 每项在对应 task 执行；Task 12 统一复跑与 mutation restore audit |
| §10 docs | 12 | 仅 merged-state 全绿后更新 live docs；Bun RST backlog 保留 |

无孤儿 section；每个会阻断流程的 gate 同时有已知正确样本和目标缺陷 mutation。执行期若新增判据，必须同步更新本表和对应 task，不得只写测试不写性质或只写性质不写验收。

## Verification matrix

| Spec area | Primary tests／commands | Positive mutation |
|---|---|---|
| SSE parser | `owned-sse-parser.unit.test.ts` | EOF flush／ID semantics 六变异 |
| Grammar／owner | delivery grammar／session／race／anchor／hedge tests | half-block flush、duplicate terminal、second serializer |
| 11 pumps | Batch 0～4 精确 strict delta ratchet + 最终全量 guard + endpoint HTTP／WS／client e2e | 本批未迁、漏移集合、strict回退live、missing root edge、route `[DONE]` |
| H2 termination | unit + current `http2-client.it` + runtime matrix | DATA clock/object/copy/callback；late mutation |
| GOAWAY ledger | ledger unit + real Node matrix | fan-out、violation drop、early release |
| History V3 | store／migration／recovery／readonly／search | split tx A、early lease release、wrong legacy digest |
| Performance | `bench:h2-delivery` A/A+A/B | four independent slowdown variants |
| Full backend | typecheck、lint、`test:backend`、matrix；按需 `test:ci` | test discovery guard |

## Structural-smell checkpoints

每阶段 reviewer 必须报告 `file:line + smell + disposition`：

- 同一协议边界是否仍由 adapter、candidate classifier、handler 三处重复判断。
- route 是否仍拥有 terminal／error／`[DONE]` 或 synthetic sequence 写出。
- delivery session 是否出现第二 serializer／buffer owner。
- transport 是否反向 import generation／delivery，或 DATA hot path 被观测逻辑污染。
- evidence digest、event sequence、lease 是否被错误合并成一份 ownership。
- config compatibility 是否重新产生可关闭 delivery 的隐式开关。

## 执行策略

推荐 `superpowers:subagent-driven-development`，但不是“每个 2 分钟步骤一个新 agent”：按 Task 1～12 的语义任务分配，每任务一个 implementer 上下文；Task 5、9、10、11 预计多 commit／需试错，派活前各自建立并逐 commit 更新独立 progress 文件。每任务完成后做规格符合性 review + 代码质量 review；Task 12 再做 merged-state review。
