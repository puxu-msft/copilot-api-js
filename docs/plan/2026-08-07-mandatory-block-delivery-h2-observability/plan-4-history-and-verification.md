# Phase 4：History Activation 与 Verification

> 状态：`approved-not-implemented`
>
> 权威规格：[`docs/spec/2026-08-06-mandatory-block-delivery-and-h2-termination-observability.md`](../../spec/2026-08-06-mandatory-block-delivery-and-h2-termination-observability.md)
>
> 本目录只定义实施方法；规格是 what/why 单一事实源，当前 live 架构仍以 [`docs/DESIGN.md`](../../DESIGN.md) 为准。执行本阶段前必须先读 [`README.md`](README.md) 的 Global Constraints、文件责任边界、冻结跨层接口与 commit invariants。

## Task 10：Atomic production activation：dispatch slots、H2 ledger 与 persistence handoff

**Files**
- Modify: `src/lib/transport/http2-client.ts`
- Modify: `src/lib/pipeline/types.ts`、`src/lib/pipeline/generation/dispatch-scheduler.ts`
- Modify: `src/lib/transport/{physical-transport,http-transport,responses-transport}.ts`
- Modify: `src/lib/context/model-operation-record.ts`、`src/lib/context/request.ts`
- Create: `src/lib/context/operation-persistence-envelope.ts`
- Modify: `src/lib/history/v3/{terminal-bus,store,projection}.ts`、`src/lib/history/state.ts`
- Test: dispatch scheduler／context recorder／terminal seal／terminal bus／History projection／shutdown／HTTP2 integration tests

**Activation invariant**
- 下列 wiring 在一个 production activation commit 中同时落地：dispatch port与槽、scheduler option、H2 lease install／freeze、terminal envelope、唯一 persistence sink、Task 9 transaction A consumer。禁止 stub、旁路或“先 publish envelope 后补 CAS”。红测可先单独提交；production activation 必须原子。

- [ ] 写红测：per-dispatch `transportTermination`／`responseTrailers` first-write；retry／hedge sibling isolation；unknown／settled／sealed false；loser evidence retained；terminal seal单次转移leases。另做ownership三控：CAS拒绝时source从未freeze且cleanup可release；CAS成功时snapshot与operation lease同临界区落地；source／operation lease均不丢失、不双freeze／双release。
- [ ] 在 `ModelOperationDispatch` 加闭合槽，在 RequestContext 实现 `DispatchTransportObservationPort`、source install、termination／trailers first-write 和 cleanup；现有 track trailers保留。RequestContext独占installed source。
- [ ] Scheduler 在 `beginDispatch` 后取得真实 port并放入 `TransportDispatchOptions`；H2 session创建ledger，GOAWAY先non-admitting再append，retire保留PING／in-flight；`session.request()`前 install source，rejected立即release且不创建stream。
- [ ] 接入 Task 7 first-terminal recorder builder + Task 8 `GoawaySnapshotSource`：stream／session earliest `PROTOCOL_ERROR` 在 CAS/freeze前记录，后到者不覆盖。Port先CAS；拒绝不freeze，成功则内部freeze一次并把snapshot+operation lease同临界区写sidecar，再用builder构造完整termination。默认 source与ledger source共享同一serializable union，禁止转换／复制schema。
- [ ] terminal seal 生成 `OperationPersistenceEnvelope`；canonical record保留所有 dispatch，egress只投影 winner。
- [ ] terminal bus继续把 inert record给 recent／stats／queries observers；新增唯一 persistence sink接收 envelope。无 sink／disabled／rejected由 bus release；accepted 后 History queue成为唯一 owner并调用Task 9事务A/B。
- [ ] `src/lib/history/state.ts` 替换 `subscribeModelOperationTerminals(enqueueModelOperation)` 为 persistence sink 注册，同时保留 record-subscriber drain；projection暴露 dispatch字段。
- [ ] 测 transient A／prepare failure保留同一 envelope／leases；A commit后release；terminal failure／conflict／shutdown release；session close后bytes可读。
- [ ] 跑 stream-first／session-first、siblings、GOAWAY before/after terminal、disabled History、enqueue reject、recent/stats、shutdown drain和projection tests。
- [ ] 注入 scheduler无port、install reject仍开stream、winner-only envelope、bus双release、record observer取得lease、transient提前release mutation，确认红。
- [ ] 提交：`feat: activate dispatch transport evidence persistence`。

## Task 11：真实双 runtime matrix 与性能 harness

**Files**
- Create: `tests/transport/h2-fixture-server.ts`
- Create: `tests/transport/h2-termination-client.ts`
- Create: `scripts/run-h2-termination-matrix.ts`
- Create: `tests/transport/h2-delivery-benchmark.ts`
- Create: `scripts/run-h2-delivery-benchmark.ts`
- Modify: `package.json`
- Modify: `tests/infra/test-discovery-matrix.unit.test.ts`

- [ ] 独立 Node server child 输出 READY JSON；orchestrator 验证唯一 PID、`process.release.name=node`、无 `process.versions.bun`。
- [ ] 同一 bundled production client scenario 分别由 Bun／Node 执行，使用 `setHttp2SessionFactoryForTests(() => http2.connect(origin))`，不得 fake stream／绕过 `http2Fetch`。
- [ ] 场景集合精确相等：normal end、RST、abrupt close、cancel、abort、GOAWAY before/after、siblings、observer throws、first terminal、double GOAWAY equal/decrease、invalid capability four-state probe。
- [ ] Invalid probe 用 first／second unique opaque token，逐形状独立测试：clamped／raw 恰两条 first→second callback；rejected 仅允许 zero callback + `PROTOCOL_ERROR` 或 single first callback + `PROTOCOL_ERROR`；only-first/no-error、only-second、额外、重复、null digest、unknown digest、token digest collision 逐项只能 unsupported；raw-visible 需要独立帧级 oracle。
- [ ] 为伪造 first／second provenance、吞掉 connection error、缺失 `unsupported.attemptedOracle`、把 ambiguous 统一判 rejected／clamped 四类独立 mutation 各建报告行并确认红；正确 rejected 0／1 callback 与正确 clamped/raw 两 callback 均为绿，防 false-red。
- [ ] package scripts：`test:h2-runtime-matrix` 纳入 `test:ci`；`bench:h2-delivery` 按需，不作固定门。
- [ ] benchmark 保留同一 server／payload seed／chunk schedule；A/A 与 A/B randomized paired blocks；四个独立 strategy mutation：clock、object allocation、byte copy、callback。
- [ ] 每个 raw JSONL block 必须记录 runtime identity、source commit、strategy digest、variant、seed、scenario、pair／block／order。Orchestrator 强制 A/A 两侧 strategy digest 相同，A/B 两侧 digest 不同，且 runtime／seed／scenario 集合精确相等；注入“同一 candidate 实现贴 baseline／candidate 双标签”必须在汇总前变红。
- [ ] 报告 raw JSONL + paired delta + one-sided bootstrap 95% CI；mutation 未能制造方向正确退化时标“harness 分辨力不足”。
- [ ] 运行 matrix；benchmark 只报告，不用“无显著差异”声称无回归。
- [ ] 提交：`test: add HTTP2 runtime and delivery performance harnesses`。

## Task 12：合并态验收与 live docs

**Files**
- Modify: `docs/DESIGN.md`、`docs/API.md`、`docs/coding-conventions.md`、`config.yaml`
- Modify: `docs/todo/deferred-backlog.md`（只关闭已落地债项；保留 Bun clean RST 专项调查）
- Update plan status／progress files

- [ ] 运行所有定向 tests、architecture guards、`bun run test:h2-runtime-matrix`、`bun run typecheck`、`bun run lint:all`、`bun run test:backend`；History native tests若因无产物 skip，另跑 `bun run build:history-search` 后复跑相关测试或用 `test:ci`。
- [ ] 对生产入口重新运行 AST 6 roots／11 pumps 精确集合；验证每 root 可达 owner、不可达底层 writer。
- [ ] 执行所有冻结 mutation controls，并核对红因来自目标机制；恢复 exact patch 后重跑全量。
- [ ] 运行 A/A、A/B 性能报告；明确当前分辨率、CI 与不设门口径。
- [ ] 用非 4141 测试端口实跑关键 HTTP／WS client flow；验证进程 PID 是当前 worktree 构建，按精确 PID清理。
- [ ] 更新 live docs：mandatory owner、HTTP/2 snapshot／History API 字段、配置迁移、schema 6／manifest 3；不得把未验证能力写成已落地。
- [ ] 保留 deferred backlog 的 Bun `end+rstCode=0` 调查，不能因本实施误标已解。
- [ ] 双视角 merged-state review：一位审 production graph／实施可执行性，一位从 spec 独立推导 acceptance oracle；均 `0 blocker / 0 major`。
- [ ] 最终提交：`docs: publish mandatory delivery architecture`。
