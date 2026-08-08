# History Persistence Worker Implementation Plan

> **评审状态门：** 以配套 kickoff 的 `REVIEWED_PLAN_COMMIT` 为唯一机器可判真相源。该值为空或 plan blob 与该提交不一致时禁止实施；不在本文件写自引用 commit SHA。
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 把 History semantic/raw 持久化、backfill、maintenance 与最终查询逐批迁入单个专用 Worker；使用有界 operation reservation、Worker crash 重放和 startup/shutdown durability barrier；每个 batch 独立验收后立即合入 `master`。

**Architecture:** 主线程拥有 `HistoryAdmissionController`、未 ACK envelope 和 in-flight/recent overlay；单个 `node:worker_threads.Worker` 拥有 History 写入和最终全部 SQLite。写入先行阶段允许主线程 readonly connection，Batch 6c 删除它。所有主线程↔Worker 行为通过版本化 protocol 和 `HistoryPersistenceRuntime` 端口完成。

**Tech Stack:** TypeScript 5.9、Bun 1.3.14、Node 24、`node:worker_threads`、`bun:sqlite`／`node:sqlite`、Hono、tsdown、Bun test、SQLite WAL。

**Behavior oracle:** `docs/spec/2026-08-06-history-persistence-worker.md`。冲突时先停下核对规格，不自行改动冻结契约。

**Runtime prerequisite verified:** 2026-08-07 临时探针以同一 `node:worker_threads` 主／子脚本分别在 Bun 1.3.14 与 Node 24 运行，`parentPort`、`Uint8Array`、`Map`、`bun:sqlite`／`node:sqlite` 均成功并返回 `n=7`。该探针不入库、不替代 Batch 0 自动化。

## Global Constraints

- 只使用一个 History Worker；禁止 writer pool。
- Worker transport 统一使用 `node:worker_threads`；Bun 和 Node 都必须实测。
- 队列配置为 `history.persistence_queue_capacity`，默认 `256`，按 operation 条数计容，禁止 `0 = unlimited`。
- 达峰只阻塞新模型 operation；liveness、status、metrics、History 查询和管理 API 不受 admission gate 阻塞。
- admission 等待没有独立超时；沿客户端 abort 和 shutdown signal。
- 主线程保留所有未终态 ACK envelope；普通 Worker crash 自动重启重放。
- terminal `fatal` 必须终结未 ACK、拒绝 waiter/config barrier、释放 reservation、reject drain，并触发 shutdown failed。
- raw config 使用 `latestDesiredRevision`／`publishedRevision` 与共享 publication barrier；连续 A→B 热切时只有 B ACK 可放行 admission。
- raw artifact 跨 restart 以 `dbPath + storeId` 校验；worker-local token 不参与跨 restart identity。
- 每个 batch 独立红绿、评审、提交并 fast-forward 合入 `master`；不等待后续 batch。
- 允许未接生产流程的自洽代码先合，但必须可执行、已测试、无 import 副作用／资源泄漏，并明确后续接线 batch。
- 绝不停止用户 4141 服务。真服务验证仅使用动态端口或明确非 4141 端口，并精确清理本测试进程。
- 每批报告必须写“证明什么／不证明什么”。

## Execution Progress Contract

执行者在第一笔实现前创建 `docs/tmp/2026-08-07-history-worker-progress-impl-1.md`，frontmatter 包含：

```yaml
---
slug: impl-1
base: <执行会话开始时的 master SHA>
branch: <执行分支>
worktree: <绝对路径>
plan: docs/plan/2026-08-07-history-persistence-worker.md
agent_id: <拿到后回填>
status: active
---
```

每个实现 commit 必须同时更新该文件，只记录 git 不保存的三项：剩余项及验收、在途意图、已作废路线。每个 batch 通过后：

1. 提交 batch 实现和进度文件；
2. 独立 review 本 batch；
3. 修复并复审到 0 blocker／major；
4. fast-forward 合入 `master`；
5. 从最新 `master` 创建下一 batch worktree；
6. 在正式计划的 batch 标题下追加 `状态：已完成（<sha>）`，进度文件同步更新。

不得在共享主树执行 mutation。每个 batch 的 mutation patch 必须先冻结，再注入、反向检查和恢复。

## File Structure

新增文件路径与职责固定如下；若实现证据表明路径必须改变，先修改并重新评审本计划，不能由执行者静默改名：

- `src/lib/history/worker/protocol.ts`：structured-clone-safe 消息、envelope、status 和 type guards。
- `src/lib/history/worker/runtime.ts`：主线程 `HistoryPersistenceRuntime`、generation、未 ACK、restart、ACK tombstone。
- `src/lib/history/worker/history-worker.ts`：Worker entry；文件 basename 固定产出 `dist/history-worker.mjs`，只接 protocol 并调用 backend。
- `src/lib/history/worker/backend.ts`：Worker 内 semantic/raw/query/maintenance ownership。
- `src/lib/history/worker/admission.ts`：有界 reservation、FIFO waiter；唯一 reservation owner。
- `src/lib/history/worker/status.ts`：组合 admission 与 Worker 两个独立 snapshot，生成对外 History subsystem status。
- `src/lib/history/worker/legacy-terminal-sink.ts`：Batch 1b 到 2b 的旧 writer adapter；Batch 2b 删除。
- `src/lib/history/worker/registry.ts`：生产 runtime/admission 单例与测试注入端口。
- `src/lib/history/worker/asset-url.ts`：source 与 dist Worker URL 解析。
- `src/lib/history/terminal-publication.ts`：唯一 terminal bus payload；携 canonical record 与 operation-owned raw attachment。
- `src/lib/history/recent-terminal.ts`：未 ACK 全量 overlay 与已 ACK 有界 recent cache。
- `src/lib/history/sqlite/read-connection.ts`：写入先行阶段的主线程 readonly handle registry；Batch 2b 安装，Batch 6c 删除。
- `tests/history/worker/fixtures/worker-entry.ts`：协议测试 Worker fixture。
- `tests/history/worker/*.unit.test.ts`：纯状态机与 fake backend。
- `tests/history/worker/*.it.test.ts`：真 Worker、SQLite、crash、source/dist runtime。
- `tests/architecture/history-worker-boundaries.unit.test.ts`：生产 import／owner／入口集合守卫。

现有承重文件：

- `tsdown.config.ts`：增加 `packages/cli/src/main.ts` 与 Worker entry 两个稳定 bundle entry；产物必须包含 `dist/main.mjs` 和 `dist/history-worker.mjs`。
- `src/lib/history/state.ts`：runtime lifecycle、terminal subscriber、readonly transition。
- `src/lib/history/v3/store.ts`：被搬迁的 prepare／commit／retry／backfill primitives。
- `src/lib/history/raw/manager.ts`：被搬迁的 raw generation backend。
- `src/lib/context/{manager,request,lightweight-model-operation}.ts`：reservation claim 与 raw command accumulation。
- `packages/foundation/src/state{,-defaults}.ts`、`src/lib/config/{schema,config}.ts`、`config.yaml`：capacity 配置。
- `src/routes/status/route.ts`、`src/lib/metrics-exposition.ts`：status 和 Prometheus。
- `src/lib/shutdown.ts`、`packages/cli/src/start.ts`：startup hard gate 与 durability barrier。
- `src/lib/history/{queries,sessions,stats}.ts`、`src/routes/history/handler.ts`：Batch 6 query RPC cutover。
- `src/routes/responses/{handler-v4,ws,conversation-rebuild}.ts`、`src/routes/debug/dry-run-pipeline.ts`、`src/lib/codec/openai-responses/{codec,openai-responses-leg}.ts`、`src/lib/pipeline/{driver,types,request-state}.ts`：Batch 6b 的 production／inspection 共用 async fallback-history prefetch seam。

---

### Task 0 / Batch 0: Protocol and Worker Runtime Skeleton

**Files:**
- Create: `src/lib/history/worker/protocol.ts`
- Create: `src/lib/history/worker/runtime.ts`
- Create: `src/lib/history/worker/history-worker.ts`
- Create: `src/lib/history/worker/asset-url.ts`
- Create: `src/lib/history/worker/registry.ts`
- Modify: `tsdown.config.ts`
- Test: `tests/history/worker/protocol.unit.test.ts`
- Test: `tests/history/worker/runtime.it.test.ts`
- Test: `tests/history/worker/packaged-runtime.it.test.ts`

**Interfaces:**

```ts
export const HISTORY_WORKER_PROTOCOL_VERSION = 1
export type WorkerGeneration = number
export type HistoryMessageId = number
export type HistoryPersistenceOutcome = "persisted" | "conflict" | "failed"

export interface RawTargetDescriptor {
  readonly configRevision: number
  readonly requested: boolean
  readonly dbPath?: string
  readonly storeId?: string
  readonly maxObjectBytes: number
  readonly workerLocalGeneration?: string
}

export interface RawOperationAttachment {
  readonly rawTarget: RawTargetDescriptor
  readonly rawCommands: ReadonlyArray<RawCaptureCommand>
}

export interface ModelOperationTerminalPublication {
  readonly record: ModelOperationRecord
  readonly rawAttachment: RawOperationAttachment
}

export interface HistoryOperationEnvelope {
  readonly protocolVersion: typeof HISTORY_WORKER_PROTOCOL_VERSION
  readonly publication: ModelOperationTerminalPublication
}

export interface RawCaptureCommand {
  readonly sequence: number
  readonly track: string
  readonly kind: string
  readonly bytes: Uint8Array
}

export interface HistoryWorkerRawConfig {
  readonly enabled: boolean
  readonly dbPath: string
  readonly maxObjectBytes: number
}

export interface HistoryPersistRetryConfig {
  readonly maxAttempts: number
  readonly backoffMs: number
  readonly maxTotalMs?: number
}

export interface HistoryWorkerHotConfig {
  readonly rawConfig: HistoryWorkerRawConfig
  readonly maintenanceIntervalMs: number
}

export interface HistoryWorkerStartConfig {
  readonly semanticDbPath: string
  readonly configRevision: number
  readonly rawConfig: HistoryWorkerRawConfig
  readonly persistRetry: HistoryPersistRetryConfig
  readonly maintenanceIntervalMs: number
}

export interface HistoryWorkerReady {
  readonly workerGeneration: WorkerGeneration
  readonly threadId: number
  readonly selectedDriver: "bun:sqlite" | "node:sqlite"
  readonly configRevision: number
  readonly rawTarget: RawTargetDescriptor
}

export interface HistoryDrainResult {
  readonly outcomes: Readonly<Record<HistoryMessageId, HistoryPersistenceOutcome>>
}

export interface HistoryWorkerStatus {
  readonly workerGeneration: WorkerGeneration
  readonly threadId?: number
  readonly selectedDriver?: "bun:sqlite" | "node:sqlite"
  readonly ready: boolean
  readonly terminalFailed: boolean
  readonly pendingEnvelopes: number
  readonly pendingBytes: number
  readonly latestDesiredRevision: number
  readonly publishedRevision: number
  readonly restartsTotal: number
  readonly replaysTotal: number
  readonly lastError?: string
}

export interface HistoryPersistenceRuntime {
  start(config: HistoryWorkerStartConfig): Promise<HistoryWorkerReady>
  enqueue(
    envelope: HistoryOperationEnvelope,
    onOutcome: (outcome: HistoryPersistenceOutcome) => void,
  ): HistoryMessageId
  updateConfig(revision: number, config: HistoryWorkerHotConfig): Promise<RawTargetDescriptor>
  stopMaintenance(): Promise<void>
  drain(): Promise<HistoryDrainResult>
  shutdown(): Promise<void>
  snapshot(): HistoryWorkerStatus
  subscribe(listener: (status: HistoryWorkerStatus) => void): () => void
}
```

Batch 0 即定义 production-shaped `ModelOperationTerminalPublication` 与 `HistoryOperationEnvelope`：publication 含 canonical record 与冻结 raw attachment；Batch 1b attachment 先为空 commands。这让 legacy sink 与 Worker sink 使用同一 terminal payload。Batch 0 Worker fixture 只做协议 round-trip，不得伪造 production persistence success。

- [ ] **Step 0.1: 写 protocol red tests**

断言：错误 version、未知 message type 和不可克隆字段被拒；旧 generation ACK 被忽略并计数，不触碰当前状态；同 generation 相同 outcome duplicate ACK 幂等；不同 outcome fail-fast。

Run:

```bash
bun test tests/history/worker/protocol.unit.test.ts
```

Expected: FAIL，模块不存在。

- [ ] **Step 0.2: 实现 protocol types 与 runtime 纯状态机**

`runtime.ts` 只管理 Worker transport、generation、pending envelope/RPC 和状态；不得 import SQLite。completed-ACK tombstone 设有界容量并测试淘汰。Runtime snapshot 只暴露 `pendingEnvelopes/pendingBytes`，不得出现 `reserved/waitingRequests`；这些字段唯一属于 admission。

- [ ] **Step 0.3: 写真 Worker source-mode red test**

fixture 通过 `node:worker_threads` 接收 ping，在线程内打开 `:memory:` SQLite，回传 `Uint8Array`／`Map` round-trip，并支持确定性 `throw`。

Run:

```bash
bun test tests/history/worker/runtime.it.test.ts
bun run build:backend
bun dist/history-worker.mjs --probe
node dist/history-worker.mjs --probe
```

Node 不直接加载 TypeScript，也不为测试新增 loader 依赖。`--probe` 是 Worker entry 的显式测试模式：完成 SQLite round-trip 后输出一行 JSON 并退出；正常 Worker 模式仍只响应 parent port。

- [ ] **Step 0.4: 增加双入口构建与 asset URL**

`tsdown.config.ts` 的 entry array 增加 `src/lib/history/worker/history-worker.ts`；以两个 basename 固定生成 `main.mjs` 和 `history-worker.mjs`。Batch 0 build test 必须断言两个精确路径存在，若 tsdown 实际命名不符则在本 batch 调整 bundler 的官方 output naming 配置并把真实配置写回计划，禁止靠运行时 glob 猜文件。`asset-url.ts` 接受显式 override 用于测试；生产默认基于当前 bundle 的 `import.meta.url` 解析 sibling `history-worker.mjs`。开发模式先构建 Worker bundle，不依赖 Node 直接加载 `.ts`。

- [ ] **Step 0.5: 写 packaged-runtime red/green test**

Run:

```bash
bun run build:backend
bun test tests/history/worker/packaged-runtime.it.test.ts
node dist/main.mjs --help
```

测试必须分别用 Bun 和 Node 启动 `dist/history-worker.mjs`，并证明 worker 内选择对应 SQLite driver。

- [ ] **Step 0.6: 验证无生产副作用**

导入 `registry.ts` 不得创建 Worker、timer 或 DB。用 active handle 计数或显式 injected factory 断言 lazy start。

- [ ] **Step 0.7: Batch 0 门禁与提交**

```bash
bun test tests/history/worker/protocol.unit.test.ts tests/history/worker/runtime.it.test.ts tests/history/worker/packaged-runtime.it.test.ts
bun run typecheck
bunx eslint src/lib/history/worker tests/history/worker tsdown.config.ts
git diff --check
```

**证明：** Bun／Node／dist Worker primitive 和协议状态机可用，自洽 dead code 可安全入主树。

**不证明：** 生产 History 已使用 Worker；队列背压、持久化、raw、shutdown 均未接线。

Commit: `feat(history): add worker runtime skeleton`

### Task 1a / Batch 1a: Admission Controller Primitive

**Files:**
- Create: `src/lib/history/worker/admission.ts`
- Modify: `src/lib/history/worker/protocol.ts`
- Modify: `src/lib/history/worker/registry.ts`
- Modify: `packages/foundation/src/state.ts`
- Modify: `packages/foundation/src/state-defaults.ts`
- Modify: `src/lib/config/schema.ts`
- Modify: `src/lib/config/config.ts`
- Modify: `config.yaml`
- Regenerate: `config.schema.json` via `bun run generate:config-schema`
- Test: `tests/history/worker/admission.unit.test.ts`
- Test: `tests/config/history-persistence-queue-config.unit.test.ts`

**Interfaces:**

```ts
export interface HistoryTerminalSink {
  enqueue(
    envelope: HistoryOperationEnvelope,
    onOutcome: (outcome: HistoryPersistenceOutcome) => void,
  ): HistoryMessageId
}

export interface HistoryReservation {
  readonly reservationId: string
  readonly admittedAt: number
  readonly historyAdmissionWaitMs: number
  bindOperationId(operationId: string): void
  releaseBeforeBinding(reason: string): void
}

export interface HistoryAdmissionStatus {
  readonly capacity: number
  readonly reserved: number
  readonly unacked: number
  readonly waiting: number
  readonly estimatedBytes: number
  readonly overCapacity: boolean
}

export interface HistoryAdmissionController {
  acquire(input: { signal: AbortSignal }): Promise<HistoryReservation>
  acceptTerminal(envelope: HistoryOperationEnvelope): Promise<HistoryPersistenceOutcome>
  failBeforeTerminal(operationId: string, error: unknown): void
  updateCapacity(capacity: number): void
  pause(reason: string): Promise<void>
  waitForQuiescence(): Promise<void>
  resume(): void
  replaceTerminalSink(sink: HistoryTerminalSink): void
  close(error: Error): void
  snapshot(): HistoryAdmissionStatus
}
```

- [ ] **Step 1a.1: 写 capacity 与 FIFO red tests**

覆盖 capacity=1、第二 waiter pending、release 只唤醒一个、FIFO、abort、close、double release、bind 只能一次、未知 operation terminal fail-fast、同 operation terminal 只能 accept 一次、`failBeforeTerminal` 释放并记录错误。

- [ ] **Step 1a.2: 写热调 red tests**

覆盖调大立即放行；调小允许 `reserved > capacity`，直到 `reserved < capacity` 才放行；断言 `0 <= unacked <= reserved`。

- [ ] **Step 1a.3: 实现 admission controller**

使用显式 waiter queue 和一次性 reservation 状态机；每个状态转换集中到一个私有 primitive，防 ACK/fatal 双释放。`bindOperationId()` 把 reservation 移入 operation map；唯一 terminal bus subscriber 调 `acceptTerminal()`，后者调用当前 `HistoryTerminalSink.enqueue(envelope,onOutcome)` 并记录其返回的 messageId。sink outcome 回调驱动统一 terminal transition。Batch 1a 测试 sink 可控延迟 outcome。

- [ ] **Step 1a.4: 接配置**

`HistoryConfigSchema` 新增 `persistence_queue_capacity: nullablePositiveInt()`；foundation state/default 新增 `historyPersistenceQueueCapacity=256`；`setHistoryConfig` 触发专用 listener。生成并检查 `config.schema.json`，不得手改生成物。

- [ ] **Step 1a.5: status primitive**

snapshot 至少含 capacity、reserved、unacked、waiting、estimatedBytes、overCapacity。此 batch 只提供 primitive，不改 HTTP status。

- [ ] **Step 1a.6: 门禁与提交**

```bash
bun test tests/history/worker/admission.unit.test.ts tests/config/history-persistence-queue-config.unit.test.ts tests/config/config-validation.unit.test.ts
bun run generate:config-schema
git diff --check config.schema.json
bun run typecheck
bunx eslint src/lib/history/worker packages/foundation/src/state.ts src/lib/config
```

**证明：** 有界 reservation 与配置契约成立。

**不证明：** 任一生产模型入口已受背压；Worker ACK 尚未驱动 release。

Commit: `feat(history): add persistence admission controller`

### Task 1b / Batch 1b: Production Admission Wiring

**状态：候选已验收（`94205e89`），待 fast-forward 合入 `master` 后写最终完成 SHA。**

**Files:**
- Create: `src/lib/history/worker/http-admission.ts`
- Create: `src/lib/history/worker/legacy-terminal-sink.ts`
- Create: `src/lib/history/worker/status.ts`
- Modify: `src/routes/{chat-completions,responses,messages,embeddings,gemini}/route.ts`
- Modify: `src/routes/azure-openai/route.ts`
- Modify: `src/routes/responses/ws.ts`
- Modify: `src/lib/context/manager.ts`
- Modify: `src/lib/context/request.ts`
- Modify: `src/lib/context/lightweight-model-operation.ts`
- Modify: `src/lib/history/v3/terminal-bus.ts`
- Create: `src/lib/history/terminal-publication.ts`
- Create: `src/lib/history/recent-terminal.ts`
- Modify: `src/lib/shutdown.ts`
- Modify: four codec files under `src/lib/codec/`
- Modify: `src/routes/status/route.ts`
- Modify: `src/lib/metrics-exposition.ts`
- Modify: `src/lib/telemetry-assembly.ts`
- Modify: `packages/telemetry/src/request-telemetry.ts`
- Test: `tests/history/worker/admission-wiring.http.test.ts`
- Test: `tests/history/worker/admission-ws.it.test.ts`
- Test: `tests/history/worker/admission-shutdown.unit.test.ts`
- Test: `tests/history/worker/pending-overlay.it.test.ts`
- Test: `tests/architecture/history-worker-boundaries.unit.test.ts`

**Wiring rule:** 不把同步 `manager.create()` 改 async。模型 route 在 parse/dispatch 前 await reservation，并把 `HistoryReservation` 作为显式参数传给 codec／lightweight producer。dry-run 不传 reservation。Responses WS 每条 `response.create` 独立 acquire。Terminal publication 只有一个 owner：`ModelOperationTerminalPublication { record, rawAttachment }` 经 terminal bus 发布，subscriber 消费；context/lightweight 不直接 enqueue persistence。

- [x] **Step 1b.1: 写入口矩阵 red test**

从 route registration 与 operation producers 枚举：OpenAI CC／Responses、Anthropic Messages／count_tokens、Gemini generate／stream／count、embeddings、Azure、Responses WS。使用 capacity=1 且预先持有唯一 reservation 的 test controller，使每个新模型入口必须等待；liveness、status、metrics、History、dry-run 必须通过。

- [x] **Step 1b.2: 冻结 terminal publication 与 raw attachment ownership**

新增 `ModelOperationTerminalPublication { record, rawAttachment }`。`rawAttachment` 是 operation-owned、一次性 seal/transfer 对象：Batch 1b 先为空 attachment，Batch 3a 扩为 commands/descriptor。RequestContext 和 lightweight operation 在 terminal commit 时 seal attachment，并把完整 publication 交 `publishModelOperationTerminal()`；terminal bus subscriber 类型同步升级。subscriber 是唯一 `acceptTerminal()` 调用者。attachment 第二次 seal/transfer 必须抛错；finalizer publish 前失败由 manager 调 `failBeforeTerminal`。这条接缝必须在 Batch 1b 落地，Batch 3a 不再另造全局 registry。

- [x] **Step 1b.3: 扩展 context/lightweight reservation 接口**

`RequestContextManager.create` 与 `createLightweightModelOperation` 接受必填于生产、可选于 direct tests 的 `historyReservation`；manager 先把新 context 发布到 operation registry，再调用 `bindOperationId(id)`，使 shutdown 的首次 registry snapshot 不会漏掉已绑定 operation；direct 构造与 lightweight operation 在创建 ID 后立即 bind。context/lightweight 不直接 enqueue persistence。绑定前失败调用 `releaseBeforeBinding`；绑定后 canonical finalizer 拒绝时 manager 调 `failBeforeTerminal(operationId,error)`。用 compile-time helper 避免生产 codec／lightweight producer 漏传。

- [x] **Step 1b.4: 接 HTTP routes 与 shutdown Step 1**

新增 `withHistoryAdmission(requestOrSignal, operationKind, fn)`；History disabled 时返回 no-op reservation。wrapper监听客户端AbortSignal和专用admission-stop signal，并从acquire开始跟踪到reservation首次bind／release。生产 controller 安装 `LegacyHistoryTerminalSink`：它把 publication.record 交现有 `enqueueModelOperationWithOutcome`，再回调 outcome；Batch 2b 删除 adapter。`gracefulShutdown` Step 1 必须在统计 active context 前同步调用 `stopHistoryAdmission(shutdownError)`，拒绝全部pre-context waiter；随后调用 `drainHistoryAdmissionHandoffs()`，确保已grant reservation的async continuation完成bind／release，且已绑定operation先进入registry，再读取首次active snapshot。不得等到Batch 5才接。

- [x] **Step 1b.5: 接 Responses WS**

在每个合法 `response.create` 解析后、创建 abort controller 后 acquire；socket close abort waiter；每条 operation 独立 release。

- [x] **Step 1b.6: 接 pending/recent overlay 与 status/metrics**

Terminal publication 立即进入全量 `pendingDurability` map，直到 legacy/Worker sink outcome；该 map 不受 256 recent cap，天然受 admission capacity 上限。ACK 后从 pending 移到独立 256 条 acknowledged-recent cache。所有 History overlay 查询合并 pending＋acknowledged recent＋DB。用 capacity=512、Worker/sink outcome 暂停、发布 512 条 terminal 的测试证明最早 256 条仍可见；临时恢复旧 `RECENT_CAPACITY` FIFO 行为时测试必须红。

`HistoryReservation.historyAdmissionWaitMs` 在 bind 时写入 RequestContext／lightweight operation，并在 terminal telemetry assembly 进入独立 `history_admission_wait_ms` histogram；不得复用上游 rate-limit `queueWaitMs`。`/api/status` 使用 `history-worker/status.ts` 聚合 admission snapshot 与 runtime snapshot；聚合层断言 `admission.unacked === runtime.pendingEnvelopes`（legacy sink 阶段 runtime pending 为 0，聚合明确标 backend=`legacy`，不做该等式）。Runtime status 不含 reserved/waiting。Prometheus 增加 gauges/counters 与 histogram。扩展 pure renderer 测试，并断言管理请求不产生 observation。

- [x] **Step 1b.7: shutdown/pending-overlay 正负控与 mutation**

冻结 exact patch，临时移除任一入口 wrapper，确认 architecture/wiring test 红。另在 pre-context waiter pending 时触发 shutdown：waiter 必须立即 reject，active tracker 可为 0，History close 后不得出现新 context/terminal。临时移除 Step 1 `stopHistoryAdmission` 时测试必须红。反向应用 patch 后全绿。

- [x] **Step 1b.8: 门禁与提交**

```bash
bun test tests/history/worker/admission-wiring.http.test.ts tests/history/worker/admission-ws.it.test.ts tests/history/worker/admission-shutdown.unit.test.ts tests/history/worker/pending-overlay.it.test.ts tests/architecture/history-worker-boundaries.unit.test.ts tests/infra/basic-routes.http.test.ts
bun run typecheck
bun run test:backend
```

**证明：** 全部生产 operation 在开始前受有界背压，管理面不被堵塞。

**不证明：** terminal persistence 已移出主线程；reservation 暂由旧 writer outcome adapter 释放。

Commit: `feat(history): gate model operations on persistence capacity`

### Task 2a / Batch 2a: Semantic Worker Backend

**Files:**
- Create: `src/lib/history/worker/backend.ts`
- Create: `src/lib/history/worker/restart-policy.ts`
- Modify: `src/lib/history/worker/{protocol,runtime,history-worker}.ts`
- Modify: `src/lib/history/v3/store.ts` to export pure backend primitives without changing old production wiring
- Modify: `src/lib/history/sqlite/connection.ts` to support worker-owned handles without singleton leakage
- Create: `src/lib/history/sqlite/read-connection.ts`
- Test: `tests/history/worker/semantic-backend.it.test.ts`
- Test: `tests/history/worker/crash-replay.it.test.ts`
- Test: `tests/history/worker/fatal-state.unit.test.ts`

**Interfaces:** `persist-operation` carries canonical `ModelOperationRecord`; backend returns `persisted | conflict | failed`. Runtime owns envelope state `pending → terminal`、completed tombstones、generation 和 restart backoff；admission 独占 reservation/waiter 状态。Worker sink 接线后，composition status 必须断言 `admission.unacked === runtime.pendingEnvelopes`，但两个对象不得各自增减对方计数。

- [ ] **Step 2a.1: 写真实 semantic write red test**

用临时磁盘 DB，启动真 Worker，发送 fixture record，等待 ACK，再用独立 readonly connection 验 operation、summary、tracks、journal empty。

- [ ] **Step 2a.2: 抽取 backend primitives**

`prepareModelOperation`、`commitPreparedOperation`、retry 接受显式 DB handle；旧 `runDrain()` 暂保留生产调用。禁止 Worker backend 读取主线程 singleton state。新增 `read-connection.ts`，只保存 `openDatabaseReadonly()` 返回的 handle，接口固定为 `installHistoryReadDatabase(db)`, `getHistoryReadDatabase()`, `closeHistoryReadDatabase()`；不得运行 schema/maintenance。

- [ ] **Step 2a.3: 实现 Worker semantic backend**

Worker startup 执行 owner/schema/migration/recovery；`persist-operation` 执行 prepare→journal→transaction→ACK。

- [ ] **Step 2a.4: crash-window tests**

注入点：before journal、after journal、mid transaction、after commit before ACK。每次杀 Worker，runtime restart/replay，最终一条 operation、正确 outcome、journal 收敛。

- [ ] **Step 2a.5: fatal tests**

模拟 restart recovery fatal：所有未 ACK 变 failed、reservation 各释放一次、后续 enqueue 立即 failed、drain reject、waiter/config barrier reject。与迟到旧 ACK 交错，断言无双释放。

- [ ] **Step 2a.6: restart policy tests**

使用 injectable clock/timer 测 bounded exponential delay、consecutive failures、nextRetryAt；不睡真实长时间。

- [ ] **Step 2a.7: 门禁与提交**

```bash
bun test tests/history/worker/semantic-backend.it.test.ts tests/history/worker/crash-replay.it.test.ts tests/history/worker/fatal-state.unit.test.ts tests/history/v3/terminal-writer.it.test.ts tests/history/v3/transient-retry.it.test.ts
bun run typecheck
bunx eslint src/lib/history/worker src/lib/history/v3/store.ts
```

**证明：** 未接生产的 Worker backend 可真实持久化并从所有 crash window 收敛。

**不证明：** terminal subscriber 使用 Worker；模型响应与主线程隔离尚未实证。

Commit: `feat(history): add semantic worker backend`

### Task 2b / Batch 2b: Semantic Production Cutover

**Files:**
- Modify: `src/lib/history/state.ts`
- Modify: `src/lib/history/worker/registry.ts`
- Modify: `src/lib/history/v3/store.ts` and `v3/index.ts` to retire production `runDrain` wiring, retaining test/migration primitives as needed
- Modify: `src/lib/history/{queries,sessions,stats}.ts`
- Modify: `src/routes/status/route.ts`
- Modify: `packages/cli/src/start.ts`
- Test: `tests/history/worker/semantic-cutover.it.test.ts`
- Test: `tests/history/worker/event-loop-isolation.it.test.ts`
- Modify: existing tests importing `drainV3Writer` to drain runtime instead

- [ ] **Step 2b.1: 写 terminal subscriber red test**

Publish canonical terminal，断言唯一 terminal bus subscriber 调 controller `acceptTerminal()` 一次、runtime 收到一个 envelope、recent durability pending→ACK outcome、reservation release；context 自身不 enqueue，旧 `runDrain` injector 不被调用。另测 canonical finalizer 在 publish 前 reject 时 `failBeforeTerminal` 释放 reservation并让 shutdown finalization barrier 失败。

- [ ] **Step 2b.2: 切换 `initHistory`**

安装 runtime，Worker 独占 semantic write connection；主线程用 `openDatabaseReadonly()` 创建 handle 并安装到 `read-connection.ts`。将 `queries.ts`、`sessions.ts`、`stats.ts` 与 status count 的生产默认 DB accessor 从 `getDatabase()` 改为 `getHistoryReadDatabase()`；显式传 DB 的测试／primitive 不变。用 `replaceTerminalSink(workerRuntime)` 原子替换 `LegacyHistoryTerminalSink`；唯一 terminal subscriber 继续调用 controller `acceptTerminal()`，由 controller 投 Worker；outcome callback 调 `settleRecentModelOperationDurability`。在 Batch 3b 前，Worker 以 raw disabled 启动，现有主线程 raw manager 仍是唯一 raw authority；不得同时打开同一 raw DB。History disabled 使用 no-op runtime/admission。

- [ ] **Step 2b.3: 删除生产旧 writer ownership**

删除 `src/lib/history/worker/legacy-terminal-sink.ts` 及其生产安装；保留脚本/测试明确依赖的纯 primitive。architecture test 禁 `state.ts` 调 `enqueueModelOperationWithOutcome`／`drainV3Writer`，并禁止 production registry 再引用 legacy adapter。

- [ ] **Step 2b.4: 线程隔离正负对照**

真 Worker 注入 500ms sync block，同时驱动主线程 metronome 和 `/health/liveness`，max gap 不跟随 500ms；同 harness 用 in-process backend 必须观察到约 500ms gap。错误实现下正控必须红。

- [ ] **Step 2b.5: 模型交付不等 ACK**

mock Worker 延迟 ACK，HTTP 模型 response 已返回，但 reservation/unacked 保留；ACK 后释放。

- [ ] **Step 2b.6: 门禁与提交**

```bash
bun test tests/history/worker/semantic-cutover.it.test.ts tests/history/worker/event-loop-isolation.it.test.ts tests/history/v3/durability-overlay.it.test.ts tests/shutdown/drain-waits-operation.unit.test.ts
bun run test:backend
bun run build:backend
```

**证明：** semantic terminal 落盘退出主线程，模型交付不等待 ACK，crash replay 接入生产。

**不证明：** raw capture、backfill/maintenance 和 reads 已迁出主线程。主线程仍以独立 readonly connection 执行现有查询。

Commit: `refactor(history): route terminal persistence through worker`

### Task 3a / Batch 3a: Raw Command Accumulator

**Files:**
- Create: `src/lib/history/worker/raw-command.ts`
- Modify: `src/lib/history/worker/protocol.ts`
- Modify: `src/lib/context/request.ts`
- Modify: `src/lib/context/lightweight-model-operation.ts`
- Modify: `src/lib/history/raw/manager.ts` only to expose descriptor-compatible pure types
- Test: `tests/history/worker/raw-command.unit.test.ts`
- Test: `tests/history/worker/raw-config-publication.unit.test.ts`

- [ ] **Step 3a.1: 写 frame→command red tests**

覆盖 event/data/id/retry 字节、sequence、track、too-large metadata、structured clone；accumulator 不 import SQLite/compression/hash。

- [ ] **Step 3a.2: 实现 command accumulator**

RequestContext 与 lightweight operation 各自拥有一个 accumulator；terminal 时通过 Batch 1b 的一次性 `rawAttachment.seal()` 进入 terminal publication。此 batch 可 shadow-capture，同时旧 raw writer 仍为生产 authority，Legacy sink 明确忽略 attachment；禁止全局旁路 registry，禁止双写 raw DB。

- [ ] **Step 3a.3: 实现 descriptor/revision state machine**

状态包含 latestDesiredRevision、publishedRevision、active descriptor、共享 barrier。A→B 连续 update：A ACK 不发布、不 resolve；B ACK 原子发布再放行。本 batch 只在隔离 coordinator tests 中驱动该状态机，不注册 production config listener、不改变 `applyConfigToState()`，因此旧 raw manager 仍是唯一 authority。

- [ ] **Step 3a.4: crash/config tests**

覆盖 pending B 时 Worker crash，matching ready 恢复 barrier；fatal reject；迟到 A ACK；`dbPath + storeId` 同一而 worker-local token 改变仍合法；storeId mismatch 失败。production config 聚合和 await 留给 Batch 3b。

- [ ] **Step 3a.5: mutation 正控**

临时让 A ACK resolve barrier，确定性测试必须红；恢复 exact patch。

- [ ] **Step 3a.6: 门禁与提交**

```bash
bun test tests/history/worker/raw-command.unit.test.ts tests/history/worker/raw-config-publication.unit.test.ts tests/history/raw/manager.it.test.ts
bun run typecheck
bunx eslint src/lib/history/worker/raw-command.ts src/lib/context/request.ts
```

**证明：** raw command 与 latest-only config publication primitive 自洽，可作为未接线代码合入。

**不证明：** 流式生产路径停止写 raw SQLite；Worker 已消费 raw commands。

Commit: `feat(history): add raw capture command envelope`

### Task 3b / Batch 3b: Raw Capture Production Cutover

**Files:**
- Modify: `src/lib/history/worker/backend.ts`
- Modify: `src/lib/history/worker/protocol.ts`
- Modify: `src/lib/history/state.ts`
- Modify: `src/lib/context/request.ts`
- Modify: `src/lib/history/raw/manager.ts`
- Test: `tests/history/worker/raw-backend.it.test.ts`
- Test: `tests/history/worker/raw-cutover.it.test.ts`
- Modify: `tests/architecture/history-worker-boundaries.unit.test.ts`

- [ ] **Step 3b.1: 写 Worker raw backend red tests**

覆盖 object hash、collision byte-check、compression、refs、too-large、disabled、failed gap、same store reopen、rotation active/retiring。

- [ ] **Step 3b.2: 实现 Worker raw generations**

descriptor 的 durable identity 为 path+storeId；worker-local token 只管理 handles。旧 envelope 按自身 descriptor reopen，不使用 current active descriptor 替换。

- [ ] **Step 3b.3: 合并 semantic/raw envelope**

Worker 先处理 raw commands，raw failure 记录 gap，再提交 semantic terminal；raw failure 不回滚 semantic。

- [ ] **Step 3b.4: 实现单写者 quiesce handoff**

为旧 raw manager 增加 `quiesceRawCapture()`：同步停止发放新 lease，返回 `drainLeases(): Promise<void>`，只在最后一个既有 lease release 后关闭全部 generation handles。History admission 增加可恢复 `pause(reason)`／`resume()`；`pause` 阻止新 acquire、等待 pre-context waiter settled，但不进入 terminal-failed，也不复用 shutdown 的永久 `close()`。这套 quiesce 只用于 Batch 3b 的一次性“主线程 raw manager → Worker raw owner”切换；切换完成后的 config hot reload 完全在 Worker 内用 active/retiring generations 处理，不再 quiesce 全局 admission。一次性 authority 切换固定顺序：

1. `pause("raw-authority-handoff")`，阻止新的模型 admission，并等待 pre-context waiter settled；
2. 等所有已获 reservation operation terminal，确保旧 request path 不再调用 putObject/appendRef；
3. `quiesceRawCapture()` 并等待 leasedOperations=0、handles closed；
4. 删除 `request.ts` 的旧 lease/write 调用，启用 command accumulator；
5. Worker `updateConfig` 打开/验证 target 并 ACK；
6. 原子发布 descriptor，调用 `resume()` 恢复 admission。

Worker **不得在第 3 步前打开旧 manager 指向的任何 raw artifact**。第 5 步前失败时 `pause` 保持，coordinator 进入 terminal-failed/graceful shutdown；成功路径必须且只能 resume 一次。不得回退双 writer。把 `config.ts` 的 raw 三字段合并为一个 revision。全局每请求 `applyConfigToState()` 不等待 publication；模型 admission 等 barrier；`PUT /api/config` 等整个 quiesce handoff。config module 不直接 import runtime。

- [ ] **Step 3b.5: handoff 正负控与活路径性能**

用一个阻塞旧 operation 持 lease：触发 raw config handoff 后，Worker open injector 必须在 lease release/旧 handle close 后才调用；任一采样时刻 writer-owner 数恰为 0 或 1，永不为 2。临时把 Worker open 移到 drain 前，测试必须红。handoff 期间 liveness/status/History query 可用，模型请求等待。完成后真实高帧 stream 只经 Worker产生 raw refs；旧 raw write injector 不再调用。Worker 慢 compression 不冻结 liveness。

- [ ] **Step 3b.6: architecture mutation**

重新在 request path import raw manager，guard 必须红；恢复 patch。

- [ ] **Step 3b.7: 门禁与提交**

```bash
bun test tests/history/worker/raw-backend.it.test.ts tests/history/worker/raw-cutover.it.test.ts tests/history/raw/manager.it.test.ts tests/architecture/history-worker-boundaries.unit.test.ts
bun run test:backend
```

**证明：** semantic 与 raw 所有落盘工作退出请求主线程，raw config/restart 绑定闭合。

**不证明：** backfill、maintenance、History reads 已迁出主线程。

Commit: `refactor(history): move raw capture into worker`

### Task 4a / Batch 4a: Worker Backfill Backend

**Files:**
- Modify: `src/lib/history/worker/{protocol,backend,history-worker}.ts`
- Modify: `src/lib/history/v3/{store,summary-store}.ts`
- Test: `tests/history/worker/backfill-backend.it.test.ts`
- Reuse: `tests/history/v3/summary-projection-migration.it.test.ts`

- [ ] **Step 4a.1: 写 command red tests**

协议支持 `start-backfill`、`stop-maintenance`、progress/status；backend 使用 keyset `(created_at, operation_id)`，不是 OFFSET。

- [ ] **Step 4a.2: 抽取 cooperative backfill unit**

一次调用只领取一个 batch，完成后检查 stop flag；poison row 进入 backlog，不 wedge 全体。

- [ ] **Step 4a.3: restart tests**

处理若干 batch 后 terminate Worker；新 Worker 从 DB 现状继续，最终 readiness 只在 divergence=0 时发布。

- [ ] **Step 4a.4: query-plan oracle**

`EXPLAIN QUERY PLAN` 必含 `SEARCH v3_operations`、`idx_v3_operations_created` 和 tuple boundary； mutation 去掉 boundary 后测试红。

- [ ] **Step 4a.5: 门禁与提交**

```bash
bun test tests/history/worker/backfill-backend.it.test.ts tests/history/v3/summary-projection-migration.it.test.ts
bun run typecheck
```

**证明：** 未接 production timer 的 Worker backfill unit 可恢复、可停、走 keyset。

**不证明：** startup 已调用 Worker backfill；主线程 maintenance 已删除。

Commit: `feat(history): add worker backfill backend`

### Task 4b / Batch 4b: Maintenance Production Cutover

**Files:**
- Modify: `src/lib/history/worker/{protocol,backend,runtime}.ts`
- Modify: `src/lib/history/state.ts`
- Modify: `src/lib/history/v3/maintenance.ts`
- Modify: `packages/cli/src/start.ts`
- Test: `tests/history/worker/maintenance-cutover.it.test.ts`
- Modify: `tests/architecture/history-worker-boundaries.unit.test.ts`

- [ ] **Step 4b.1: 写 maintenance red tests**

Worker command 执行 checkpoint、incremental vacuum、optimize；stop-maintenance 后完成已领取 unit，不领下一 unit。

- [ ] **Step 4b.2: 切 startup/backfill**

`startHistoryBackfills()` 发 Worker command；主线程不再调用 `startV3SummaryBackfill`。

- [ ] **Step 4b.3: 切 periodic maintenance**

maintenance timer 归 Worker 所有。`initialize`／`update-config` 传 interval；Worker timer 到点领取一个 maintenance unit。`stop-maintenance` 同步清 timer、设置 stop flag，并等待已领取 unit 到提交点；主线程不得保留 maintenance timer。

- [ ] **Step 4b.4: isolation test**

Worker maintenance 注入 500ms block，主线程 liveness/metronome 不冻结；in-process negative control 红。

- [ ] **Step 4b.5: architecture guard**

生产主线程禁止调用 `runV3MaintenanceTick`、`startV3SummaryBackfill`、`checkpointWal`、`incrementalVacuum`、`runOptimize`。

- [ ] **Step 4b.6: 门禁与提交**

```bash
bun test tests/history/worker/maintenance-cutover.it.test.ts tests/history/v3/db-health.it.test.ts tests/architecture/history-worker-boundaries.unit.test.ts
bun run test:backend
```

**证明：** backfill 与 DB maintenance 的执行退出主线程，shutdown 可 cooperative stop。

**不证明：** startup hard gate、完整 Worker drain/close、History reads 已迁移。

Commit: `refactor(history): move maintenance into worker`

### Task 5 / Batch 5: Startup and Shutdown Lifecycle Closure

**Files:**
- Modify: `src/lib/history/worker/{runtime,registry}.ts`
- Modify: `src/lib/history/state.ts`
- Modify: `packages/cli/src/start.ts`
- Modify: `src/lib/shutdown.ts`
- Modify: `src/routes/status/route.ts`
- Modify: `src/lib/metrics-exposition.ts`
- Test: `tests/history/worker/startup-hard-gate.it.test.ts`
- Test: `tests/history/worker/shutdown-barrier.unit.test.ts`
- Test: `tests/history/worker/shutdown-crash.it.test.ts`
- Modify: `tests/shutdown/shutdown.unit.test.ts`

- [ ] **Step 5.1: startup hard-gate red test**

Spawn 非 4141 proxy／最小 composition fixture：Worker migration/recovery fatal 时端口从未监听；ready matching config revision 后才能 `startServer`。

- [ ] **Step 5.2: 实现 startup 顺序**

`initHistory()` start Worker→await ready→publish descriptor→打开主线程 readonly connection；失败向上传播，`start.ts` 不监听。

- [ ] **Step 5.3: shutdown ordering red test**

复用 Batch 1b 已接通的 Step 1 `stopHistoryAdmission`，不得另建第二套 close。Controllable barriers 精确断言：stop admission＋pre-context waiter drain→accepted terminal→subscriber drain→stop maintenance→Worker drain→DB close→History barrier→Telemetry/Diagnostic→stopped。

- [ ] **Step 5.4: 普通 crash 与 fatal 分流**

Drain 中普通 crash restart/replay 后继续；restart recovery fatal 批量 failed、释放 reservation、drain reject、shutdown failed。第二信号 fixture 仍立即 130/143。

- [ ] **Step 5.5: 完整 status/metrics**

暴露 spec §9 所有字段，包括 terminalFailed、revisions、oldestUnackedMs、restart/replay counters。Status 读取内存 snapshot，不 RPC SQLite。

- [ ] **Step 5.6: 真进程验收**

使用动态端口、隔离 XDG、mock upstream；验证 boot、模型请求、History ACK、优雅 shutdown。必须验证端口 ownership，清理本测试 PID，禁止 4141。

- [ ] **Step 5.7: 门禁与提交**

```bash
bun test tests/history/worker/startup-hard-gate.it.test.ts tests/history/worker/shutdown-barrier.unit.test.ts tests/history/worker/shutdown-crash.it.test.ts tests/shutdown/shutdown.unit.test.ts tests/shutdown/shutdown-signals.it.test.ts
bun run test:backend
bun run build:backend
```

**证明：** 写入先行阶段完整闭合：semantic/raw/backfill/maintenance 在 Worker，startup/shutdown 真值成立。

**不证明：** History query 不阻塞主线程；主线程 readonly connection 仍存在。

Commit: `feat(history): close worker lifecycle barriers`

### Task 6a / Batch 6a: Query RPC Backend

**Files:**
- Modify: `src/lib/history/worker/{protocol,backend,runtime}.ts`
- Refactor: `src/lib/history/{queries,sessions,stats}.ts` to parameterized DB/query primitives
- Modify: `src/lib/history/v3/{store,summary-store}.ts`
- Modify: `src/lib/history/search.ts`
- Test: `tests/history/worker/query-rpc.it.test.ts`
- Test: `tests/history/worker/query-equivalence.it.test.ts`

**RPC surface:** `get-entry`、`get-summary`、`list-summaries`、`list-session-entries`、`list-sessions`、`get-stats`、`export`、`set-pinned`、`freeze-search-target`、`get-summaries-by-ids`、`has-summary-matching`。Search sidecar 协议保持独立，但 DB snapshot、ID hydration 与 persisted-match 均由 Worker RPC 完成。`freeze-search-target` 返回 committed boundary＋boundary IDs；后续 hydrate 必须针对该 target 验证 missing/non-ready refs，并保留现有 attestation/poison/stale-reference 503 语义。

- [ ] **Step 6a.1: 写 query protocol red tests**

每个 request 有 requestId、cancel、typed success/error；unknown request/cancel 不杀 Worker。

- [ ] **Step 6a.2: 参数化当前 query primitives**

把 DB-dependent 逻辑放 worker-safe module；主线程 facade 暂继续直接调用同 primitive，保持行为。

- [ ] **Step 6a.3: 真实 fixture equivalence**

同一 DB 分别通过旧 direct facade 和 RPC 查询；比较 detail、summary page、direction、cursor、filters、sessions、stats、export bytes、pin outcome。另驱动真实 search sidecar fake：freeze target→sidecar IDs/attestation→batch hydrate→persisted-match，比较 total/cursor/poison/stale-reference。

- [ ] **Step 6a.4: read-after-ACK ordering**

同一 message stream 中 persistence ACK 之后发 query，必须可见；ACK 前 query 只保证 DB 当前 committed snapshot，recent overlay 由主线程补。

- [ ] **Step 6a.5: cancellation/error tests**

取消慢 query 只让主线程丢弃 response 并回收 pending RPC；SQLite 同步 query 在 Worker 中继续完成，随后 Worker 处理下一项。不得声称能中断正在执行的 SQLite 调用。SQLite error 映射 typed error，不泄漏 pending map。

- [ ] **Step 6a.6: 门禁与提交**

```bash
bun test tests/history/worker/query-rpc.it.test.ts tests/history/worker/query-equivalence.it.test.ts tests/history/history-api.it.test.ts tests/history/history-sessions.it.test.ts tests/history/search/search-rest-cutover.it.test.ts tests/history/search/protocol.unit.test.ts
bun run typecheck
```

**证明：** 未接 HTTP 的 Worker query backend 与当前消费者行为等价，可安全先合。

**不证明：** HTTP/management consumers 已停止主线程 SQLite；Worker 独占尚未成立。

Commit: `feat(history): add worker query RPC backend`

### Task 6b / Batch 6b: Responses Fallback Async History Prefetch

**Files:**
- Modify: `src/routes/responses/handler-v4.ts`
- Modify: `src/routes/responses/ws.ts`
- Modify: `src/routes/responses/conversation-rebuild.ts`
- Modify: `src/routes/debug/dry-run-pipeline.ts`
- Modify: `src/lib/codec/openai-responses/{codec,openai-responses-leg}.ts`
- Modify: `src/lib/pipeline/{driver,types,request-state}.ts`
- Test: `tests/responses/fallback-history-prefetch.it.test.ts`
- Test: `tests/responses/responses-conversation-rebuild.unit.test.ts`
- Test: `tests/pipeline/inspect-request.unit.test.ts`
- Test: `tests/infra/debug-dry-run-pipeline.http.test.ts`

- [ ] **Step 6b.1: 写 prefetch red tests**

Responses request 带 session/previous_response_id 且路由到 `/chat/completions` fallback 时，在任何同步 `translateOut/prepareWire` 前必须 await `list-session-entries` RPC；direct `/responses`、Anthropic/Gemini/CC cells 不发该 RPC。HTTP、Responses WS 与 debug dry-run／`inspectRequest` 都覆盖。Inspection 的 `parse`、`translate-inbound` stop stages 位于 route 前，断言不发 RPC；`translate`、`rewrite-in`、`prepare-wire` 会越过 route，fallback 正样本断言各发一次 RPC 并成功产出对应 inspection，不得只断言“不抛错”。

- [ ] **Step 6b.2: 增加共享的 driver async pre-translate seam**

在 `DriverDeps` 增加可选 `prepareRequestState(env): Promise<RequestEnvelope>`，并新增单一 helper `prepareRequestStateAfterRoute(deps, env)`。`runRequest()` 与 `inspectRequest()` 都必须在 parse＋route decision 之后、`outboundTranslateOut` 之前 await 同一个 helper；不得在两条路径复制判断或预取逻辑。Responses production handler、Responses WS 与 debug dry-run 都显式注入同一个 `createResponsesFallbackHistoryPrefetch(queryClient)` callback：生产及 dry-run 使用 Batch 6a 的真实 readonly Worker query client；测试可注入实现同一接口的 controllable query client。callback 只在 Responses→`/chat/completions` fallback 且请求携带 history linkage 时调用 `list-session-entries`，将 immutable entries snapshot 写入 requestState 的 `responsesFallbackHistoryEntries`；其他 cells 与 route 前 inspection stages不发 RPC。不把 `OutboundLeg.translateOut` 或 `prepareWire` 改 async，不在 debug／inspection 路径回退同步 SQLite。

- [ ] **Step 6b.3: 纯 rebuild core 消费 prefetched entries**

`rebuildConversationMessages` 拆为 async fetch wrapper 与既有纯 `rebuildMessagesFromEntries`。`ResponsesFallbackScratch.ensure()` 只读 prefetched entries 并同步构造 messages；若 fallback cell 缺 prefetch，抛 wiring error，不同步读 DB，不接受 Promise。Debug dry-run 不豁免这条 wiring gate：真实 Worker RPC 或显式注入的 controllable query client 必须先提供 snapshot。

- [ ] **Step 6b.4: 重试与双入口稳定性**

prefetch 每 request／inspection 一次；retry candidates 共享同一 immutable entries snapshot，不得在每 attempt 重查 History。测试在 retry 后断言 RPC count=1、rebuiltMessages 引用/字节稳定。Driver unit test 以调用顺序 probe 同时证明 `runRequest()` 与 `inspectRequest()` 的 callback 都发生在 route decision 后、`outboundTranslateOut` 前；删除任一入口对 helper 的调用后，其对应正样本必须变红。Debug HTTP test 用可识别的 session history 证明 fallback dry-run 的 `prepare-wire` output 已把历史 messages prepend 到当前 Responses→CC wire；`translate`／`rewrite-in` 正样本只断言 RPC 恰一次、调用顺序正确、requestState 中 snapshot 已冻结并可被后续 `prepareWire()` 消费，不要求其 stage body 提前变成 CC wire。Direct Responses negative control 保留 RPC count=0，防止用“所有 inspection 都预取”修出 false-red。

- [ ] **Step 6b.5: 门禁与提交**

```bash
bun test tests/responses/fallback-history-prefetch.it.test.ts tests/responses/responses-conversation-rebuild.unit.test.ts tests/pipeline/inspect-request.unit.test.ts tests/infra/debug-dry-run-pipeline.http.test.ts tests/openai/openai-responses-codec.unit.test.ts
bun run typecheck
bun run test:backend
```

**证明：** Responses fallback 的同步翻译链与 production／inspection 两个 driver 入口都具备 Worker RPC 历史输入，不需要把 pipeline cell 接口全改 async。

**不证明：** HTTP/management consumers 已切 RPC；主线程 readonly connection 仍存在。

Commit: `refactor(responses): prefetch fallback history asynchronously`

### Task 6c / Batch 6c: Read Cutover and Exclusive SQLite Ownership

**Files:**
- Modify: `src/lib/history/{queries,sessions,stats,state}.ts`
- Modify: `src/routes/history/handler.ts`
- Modify: `src/routes/logs/route.ts`
- Modify: `src/routes/status/route.ts`
- Modify: debug/hook/Responses history consumers identified by `tests/history/v3/read-consumer-guard.unit.test.ts`
- Modify: `src/lib/history/sqlite/connection.ts`
- Modify: `src/lib/history/worker/runtime.ts`
- Modify: `tests/architecture/history-worker-boundaries.unit.test.ts`
- Test: `tests/history/worker/read-cutover.it.test.ts`
- Test: `tests/history/worker/query-isolation.it.test.ts`

- [ ] **Step 6c.1: 写 consumer matrix red test**

枚举所有 production imports of History SQLite/store query primitives。目标：只有 Worker entry/backend 和独立 search sidecar daemon 可打开 History DB；主 server modules 不得 import connection/driver/raw manager。

- [ ] **Step 6c.2: 切 History APIs 与 list-search**

detail/list/session/stats/export/pin/unpin 全部 await RPC。List-search 顺序固定为 Worker `freeze-search-target` → sidecar query/attestation → Worker `get-summaries-by-ids`/`has-summary-matching`；preserve poison、boundary coverage、stale-reference 与 invalid-cursor 503/400 语义。Recent/in-flight/pending-durability overlay 在主线程末端去重合并；invalid cursor/error/status 保持现有 HTTP 形状。

- [ ] **Step 6c.3: 切非 History-route consumers**

logs、debug replay、hook toolkit、status count 等通过 async History facade/RPC；Responses fallback 已在 Batch 6b 使用 prefetched RPC entries，本批只删除其旧同步 fetch wrapper。不得留下同步 SQLite fallback。

- [ ] **Step 6c.4: 删除主线程 readonly connection**

`initHistory` 不再 open/install readonly DB；删除 `read-connection.ts` 及所有 `getHistoryReadDatabase()` 调用；`closeDatabase` 仅 Worker backend 使用。Search sidecar 作为独立进程 readonly owner 保留明确 architecture exception。

- [ ] **Step 6c.5: query isolation 正负对照**

Worker query 注入 500ms block，模型 endpoint 与 liveness 保持响应；in-process direct query negative control 观察冻结。

- [ ] **Step 6c.6: API byte/cursor/search regression**

运行现有 History HTTP、sessions、stats、export、pin 与 strict list-search tests；对 JSON shape、cursor、total、attestation、poison、stale reference、404/400/503 做 golden。

- [ ] **Step 6c.7: architecture mutation**

临时给主 server module 加 `openDatabaseReadonly` import，guard 必须红；恢复 patch。

- [ ] **Step 6c.8: 全量门与提交**

```bash
bun test tests/history/worker/read-cutover.it.test.ts tests/history/worker/query-isolation.it.test.ts tests/history/v3/read-consumer-guard.unit.test.ts tests/architecture/history-worker-boundaries.unit.test.ts
bun run test:backend
bun run build:backend
bun run test:ci
```

`test:ci` 会构建 native history-search；若环境缺 Rust toolchain，必须记录阻塞并至少完成 `test:backend`、Worker tests、Node/Bun packaged runtime tests，不得把 skip 冒充通过。

**证明：** History SQLite、压缩、query、raw、backfill、maintenance 全部退出代理主线程；Worker 成为主服务唯一 DB owner，search sidecar 是明确独立 readonly 例外。

**不证明：** 主进程 crash 前内存 envelope 跨进程 exactly-once；单超大 operation 内存有界。

Commit: `refactor(history): make worker the sqlite owner`

## Final Merged-State Verification

每个 batch 已各自 review 不等于合并态通过。Batch 6c 后另派 merged-state reviewer 和 verifier，至少执行：

```bash
bun run typecheck
bun run lint:all
bun run test:backend
bun run build:backend
bun test tests/history/worker
bun test tests/architecture/history-worker-boundaries.unit.test.ts tests/history/v3/read-consumer-guard.unit.test.ts
```

并在非 4141 端口真进程验证：

1. startup Worker ready 后才监听；
2. capacity=1 背压；
3. Worker block 不冻结 liveness；
4. Worker crash replay；
5. raw config A→B publication barrier；
6. graceful shutdown drain/close；
7. History query RPC 与 overlay；
8. `/proc/<pid>/fd` 只证明进程持有预期 semantic/raw DB handles；线程 owner 由 Worker status 中的 `threadId + selectedDriver`、SQLite open instrumentation（主线程 open 计数为 0）和 architecture guard 三种独立证据交叉验证。

## Rollback Discipline

- Batch 0/1a/2a/3a/4a/6a 是未接线自洽能力，可整 commit revert，不影响生产路径。
- 接线 batch 1b/2b/3b/4b/5/6b/6c 若失败，优先 revert 当前 batch commit 回到上一个已验收主树，不保留双轨 feature flag。Batch 6b 虽未切全局 History API，但已改变 Responses fallback pipeline，属于接线 batch。
- 不以“临时 fallback 到主线程 writer/read”作为最终修复；fallback 会重新引入本规格要消灭的 event-loop 阻塞。
- 任何数据文件迁移只由既有 forward migration/journal 处理；不得手工改用户 DB。

## Plan Completion

实施全部 batch 后：

- 将本计划头部状态改为 `已完成（<final sha>）`；
- 把 `docs/tmp/2026-08-07-history-worker-progress-impl-1.md` 标为已被正式计划取代并归档／删除；
- 更新 `docs/DESIGN.md` 活架构、`docs/history-v3-schema.md` connection ownership、`docs/lifecycle.md` Worker barrier、`docs/API.md` status fields、`docs/coding-conventions.md` Worker test/ownership 约定；
- 对所有旧“History async but same event loop”措辞做跨文档 grep disposition；
- 运行 merged-state review 后才宣告完成。
