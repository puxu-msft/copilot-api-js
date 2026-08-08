# Phase 3：HTTP/2 Observation Substrate

> 状态：`approved-not-implemented`
>
> 权威规格：[`docs/spec/2026-08-06-mandatory-block-delivery-and-h2-termination-observability.md`](../../spec/2026-08-06-mandatory-block-delivery-and-h2-termination-observability.md)
>
> 本目录只定义实施方法；规格是 what/why 单一事实源，当前 live 架构仍以 [`docs/DESIGN.md`](../../DESIGN.md) 为准。执行本阶段前必须先读 [`README.md`](README.md) 的 Global Constraints、文件责任边界、冻结跨层接口与 commit invariants。

## Task 7：HTTP/2 first-terminal recorder

**Files**
- Create: `src/lib/transport/http2-observation-types.ts`
- Create: `src/lib/transport/http2-termination.ts`
- Modify: `src/lib/transport/http2-client.ts`
- Modify: `src/lib/transport/upstream-fetch.ts`（observer option only）
- Test: `tests/transport/http2-termination.unit.test.ts`、`tests/transport/http2-client.it.test.ts`

**Interfaces**
- `http2-observation-types.ts` 唯一定义 spec §5.3 的 `TransportTerminationSnapshot`、`GoawaySnapshot`、`GoawayEventSnapshot`、`GoawayProtocolViolation` 与 `EvidenceCapture`；Task 8 不得重定义。
- `GoawaySnapshotSource<Lease = null>.freezeAtTerminal()` 返回 `GoawayFreezeResult<Lease> = { snapshot: GoawaySnapshot; operationLease: Lease }`。Serializable union、泛型 source／result与`Http2TerminationCommitPort`放在`http2-observation-types.ts`；进程内`OperationGoawayLease`仍只在Task 8 ledger模块定义。Task 7提供default source factory和无callback的`createLocalTerminationCommitPort()`：port独占`GoawaySnapshotSource<null>`、first-write CAS，成功时freeze并调用builder，丢弃builder返回值。Task 8 dispatch lease实现`GoawaySnapshotSource<OperationGoawayLease|null>`。Task 7 recorder只依赖commit port、用builder closure捕获snapshot并独占`onTermination`通知；Task 10用RequestContext port替换local port。Serializable types不反向import lease implementation，也没有双owner／双observer。
- Observer is best-effort／never-throw and fires once.

- [ ] 写 fake stream 红测覆盖 `end`、`error`、bare close-before-end、body cancel、post-response signal abort、late close、observer throw、second terminal、bounded text；default source factory单测必须产 ordinary zero-event，不能伪造 source-unavailable或 event。
- [ ] 实现无callback的`createLocalTerminationCommitPort()`：每请求独占default source，CAS只成功一次；成功时freeze ordinary-zero并调用builder一次但丢弃返回值；拒绝时不freeze、不调用builder。该port不import RequestContext、不产生operation lease、不保存snapshot、不调用任何observer。
- [ ] 实现atomic first-terminal recorder的builder半边：recorder只把`(goaway) => 完整 TransportTerminationSnapshot`交给commit port；builder closure保存本次snapshot。`trySet...` true后recorder唯一一次调用`onTermination(snapshot)`，并catch隔离异常；false时builder未运行、observer零次。Recorder不接收、保存或释放source／operation lease。Consumer terminal顺序为port commit→recorder observer→controller close/error。
- [ ] 添加通知三控：首次成功terminal observer恰一次；second terminal／CAS拒绝observer零次；observer throw不改变原本`controller.close/error`结果。
- [ ] 接入 `http2Fetch`：Task 7 使用per-request local commit port，使现有transport测试可直接断言snapshot；Task 10才把port替换为`options.observation`的RequestContext实现。保留DATA callback逐字不变；local cancel标source，不误记remote reset。
- [ ] trailers 与 physical close 使用 observed／not-observed／unavailable union，snapshot 后禁止 late mutation。
- [ ] 运行 transport tests；用 AST test 精确断言 DATA callback body。
- [ ] 注入 Date.now／object／copy／callback 到 DATA handler 的四个静态 mutation，architecture test 必须红。
- [ ] 提交：`feat: record HTTP2 dispatch termination snapshots`。

## Task 8：In-memory ordered GOAWAY ledger primitive

**Files**
- Create: `src/lib/transport/http2-goaway-ledger.ts`
- Test: `tests/transport/http2-goaway-ledger.unit.test.ts`

**Boundary**
- 本任务只交付独立、未接 production session 的内存 primitive；不改 scheduler、RequestContext、terminal bus 或 writer。
- Task 10 才原子激活 production wiring；因此本任务提交行为中性，不存在含 lease envelope 进入旧 writer。
- 所有 snapshot／violation／evidence serializable types 导入 Task 7 的 `http2-observation-types.ts`；本任务只实现 `GoawaySnapshotSource` 与 lease ownership，禁止复制 union。

- [ ] 写 ledger 红测：repeated GOAWAY sequence、non-increasing IDs、visible increase fail closed、zero-event freeze 三态、session owner close、duplicate freeze／release fail loud；并做类型／构造器测试证明它返回 Task 7 的同一 `GoawaySnapshot`。
- [ ] 实现 `RegisteredGoawayEvidence`、`SessionGoawayLedger`、`DispatchGoawayLease`、`OperationGoawayLease`；append 成功消费 bytes，发布前失败不消费；`DispatchGoawayLease` 实现 Task 7 `GoawaySnapshotSource`。
- [ ] 实现 shared one-shot violation primitive：first reason 胜出，后到 signal 只返回 `already-recorded`。
- [ ] 测试 session close 后 dispatch／operation lease 仍可读、same digest 不合并 event、所有 ref 归零。
- [ ] 注入 fan-out、zero-event violation 丢失、close owner 早丢 bytes、重复 release mutation，确认红。
- [ ] 提交：`feat: add in-memory ordered GOAWAY ledger`。

## Task 9：History V3 evidence storage substrate

**Files**
- Modify: `src/lib/history/v3/store.ts`、`index.ts`
- Modify: `src/lib/history/sqlite/migrations/index.ts`（第一条 production migration `001-transport-evidence-schema`）
- Create fixtures: `tests/history/v3/fixtures/transport-evidence/`
- Extend: `tests/history/v3/{store,migrations-wiring,readonly-store,acceptance-verification,persist-guard-wiring}.it.test.ts`
- Extend search／summary fallback tests

**Boundary**
- 提供可持久化 evidence bytes／refs 的 storage API 与 crash-safe transaction；尚不注册 terminal-bus persistence sink，也不接 production GOAWAY leases。
- 测试用 synthetic persistence envelope 驱动 substrate；Task 10 才接入真实 terminal seal。

- [ ] 先冻结真实 schema-5／manifest-v1/v2／journal-v1 fixtures及两个独立 legacy digest oracle；证明现 writer 能读旧 fixture。
- [ ] 注册 `001-transport-evidence-schema`：用 `sqlMigration` 包住 evidence table 与 `schema_version=6` 更新；`v3_journal.format_version` 先 `PRAGMA table_info` 探测再 `ALTER TABLE ... ADD COLUMN ... DEFAULT 1`，整体同一 transaction。`ensureV3Schema` 只维护新库 floor／幂等索引。
- [ ] manifest 2→3；journal writer 只写 v2，旧 row migration 后显式 format 1。
- [ ] 扩展 `PreparedOperation`／storage input 携 ordered dispatch/event evidence refs；CAS 按 digest 去重 bytes但不合并 event sequence。
- [ ] commit 分为事务 A（evidence CAS + journal）与事务 B（operation/tracks/timeline + journal delete）；A 任一句失败共同回滚。
- [ ] recovery 按 journal format 选择 v1/v2 decoder；v1 支持 frozen manifest-v1／v2 digest oracle，v3 digest 不替代旧 oracle；future format fail loud。
- [ ] GC 可达集加入 journal／operation evidence；clear 清 evidence；readonly/search/summary 支持 manifest v1/v2/v3。
- [ ] 跑完整 crash matrix：CAS insert、journal insert、A 后 crash、B 中途失败、digest mismatch、missing evidence、same digest two events、two operations one digest。
- [ ] mutation：事务 A 拆开、sequence refs dedupe、旧 digest 用 v3 重算、future format 接受，均应红。
- [ ] 提交：`feat: add History V3 transport evidence substrate`。
