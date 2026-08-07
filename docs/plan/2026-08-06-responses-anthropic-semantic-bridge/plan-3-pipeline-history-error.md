# P3 — Pipeline, Candidate Diagnostics, History, and Compatibility Errors

> **状态**：未实施
>
> **前置**：P1 diagnostics/error、P2 request runner。此 phase 接基础设施，但不迁 production semantic family。

**Goal:** 把 request-level freeze、candidate-local response records、winner-only projection 和 typed compatibility error 接到真实 driver／routes／History，保持现有业务 wire不变。

### Task 3.1: RequestState 携 frozen diagnostics

**Files:**
- Modify: `src/lib/pipeline/request-state.ts`
- Modify: `src/lib/pipeline/generation/candidate-state.ts`
- Test: `tests/pipeline/candidate-state.unit.test.ts`
- Create: `docs/tmp/2026-08-07-responses-anthropic-semantic-bridge-progress-p3-pipeline.md`

**Produces:** `RequestState.requestBridgeDiagnostics?: RequestBridgeDiagnostics`，deep-frozen request-stable；candidate fork 原样共享 id/hash/records值，不复制 mutable collector。

- [ ] 写 fork tests：多 candidate 引用同一 frozen值；mutation attempt不可 append；没有 diagnostics 不改变现状。
- [ ] 实现 snapshotStableState clone+freeze。
- [ ] mutation：把 open collector放进 RequestState 或每 candidate复制 records 后红。
- [ ] Commit: `feat(pipeline): carry frozen request bridge diagnostics`

### Task 3.2: Candidate-local response collector

**Files:**
- Modify: `src/lib/pipeline/generation/candidate-response-session.ts`
- Modify: `src/lib/pipeline/generation/candidate-state.ts`
- Test: `tests/pipeline/candidate-response-session.unit.test.ts`

**Produces:** 每 candidate 一个 append-only response collector；snapshot 包含 frozen records；loser／failed／cancelled 都保留。

- [ ] 写两个 candidate 相互隔离、freeze 后 append失败、loser记录保留测试。
- [ ] 在 `CreateCandidateResponseSessionInput` 增 `bridgeDiagnostics` supply／snapshot，不让 driver直接改业务记录。
- [ ] mutation：共享 collector 或 request-global 单槽后红。
- [ ] Commit: `feat(pipeline): isolate candidate bridge diagnostics`

### Task 3.3: RequestContext 与 History schema

**Files:**
- Modify: `src/lib/history/types.ts`
- Modify: `src/lib/context/types.ts`
- Modify: `src/lib/context/request.ts`
- Modify: `src/lib/context/model-operation-record.ts`（dispatch diagnostics 与 terminal metadata 的权威 owner）
- Test: `tests/context/request-bridge-diagnostics.unit.test.ts`
- Test: `tests/history/v3/bridge-diagnostics.it.test.ts`

**Produces:**

```ts
appendRequestBridgeDisposition(record)
freezeRequestBridgeDiagnostics(): RequestBridgeDiagnostics
appendCandidateBridgeDisposition(candidate, record)
PipelineInfo.bridgeDispositions?: BridgeDispositionRecord[]
```

- [ ] 写 request records 单份冻结、candidates 只投影 id/hash、winner顶层投影测试。
- [ ] 写 hedge loser 先写、winner 后写、无 winner failure 六种顺序。
- [ ] 接 V3 terminal store／API readback，不能只测 `toHistoryEntry()` 内存对象。
- [ ] mutation：loser污染winner、request records复制到每 candidate、无 candidate reject 丢 History 后红。
- [ ] Commit: `feat(history): persist semantic bridge dispositions`

### Task 3.4: 惰性 migration dispatcher 与 S2 request runner `try/finally`

**Files:**
- Create: `src/lib/openai/translate/semantic-bridge/migration-dispatch.ts`
- Modify: `src/lib/pipeline/hub-translate.ts`
- Modify: `src/lib/pipeline/driver.ts:347-369`
- Test: `tests/semantic-bridge/migration-dispatch.unit.test.ts`
- Test: `tests/pipeline/hub-translate.unit.test.ts`
- Test: `tests/pipeline/request-bridge-wiring.it.test.ts`

**Produces:** `createMigrationDispatcher({ migratedKinds, semantic, legacy })`；每 kind 精确二选一，不支持 semantic→legacy fallback 或双结果合并。P3 production `migratedKinds` 为空，wire严格走legacy；`HubTranslateContext.profileOverride` 是 fixture-only DI（仿 `DriverDeps.decideRoute`），production omits，driver不读取profile。

- [ ] **Step 1: 写 dispatcher 红灯。** 空集合只调 legacy；已迁 kind只调 semantic；semantic throw不回退legacy；同kind双调用计数必须失败。
- [ ] **Step 2: 跑红灯。** Run: `bun test tests/semantic-bridge/migration-dispatch.unit.test.ts`。Expected: FAIL，模块不存在。
- [ ] **Step 3: 实现 dispatcher，并在hub装空production集合。** `HubTranslateContext`增request collector／affinity与仅测试使用的`profileOverride?: RequestBridgeProfile`；空production集合且无override时不创建profile／collector、不改变body。`tests/pipeline/request-bridge-wiring.it.test.ts`注入fixture profile验证真实S2时序，不实现真实family。
- [ ] **Step 4: Driver S2 finally。** Success／compatibility reject／unexpected throw 都 freeze已有collector；没有collector时完全惰性。Reject before dispatch记录request History，dispatch count=0。
- [ ] **Step 5: inspector共路。** `inspectRequest(stopAfter=translate)` 调同一S2 helper，不复制bridge runner。
- [ ] **Step 6: mutation。** Empty dispatcher创建diagnostic／改变body、semantic失败回legacy、reject绕过finally后目标测试红。
- [ ] **Step 7: 运行与提交。** Run: `bun test tests/semantic-bridge/migration-dispatch.unit.test.ts tests/pipeline/hub-translate.unit.test.ts tests/pipeline/request-bridge-wiring.it.test.ts`。Expected: PASS。Commit: `feat(pipeline): add inert semantic bridge dispatcher`。

### Task 3.5: `BridgeCompatibilityError` fail-fast across retry gates

**Files:**
- Modify: `src/lib/pipeline/driver.ts`
- Modify: `src/lib/error/forward.ts`（headers-uncommitted `BridgeCompatibilityError` → HTTP envelope）
- Modify: `src/lib/pipeline/types.ts`（`ResponseOutcome.stream-error` 保留 typed error 与 `bodyCommitted`）
- Modify: `src/lib/codec/anthropic/codec.ts`（实现 profile `CompatibilityErrorRenderer` 的 Anthropic terminal 委托）
- Modify: `src/lib/codec/openai-responses/codec.ts`（实现 profile `CompatibilityErrorRenderer` 的 Responses terminal 委托）
- Modify: `src/routes/messages/error-shaping-glue.ts`、`src/routes/messages/post-commit-error.ts`
- Modify: `src/routes/messages/handler-v4.ts`、`src/routes/responses/handler-v4.ts`
- Test: `tests/pipeline/bridge-compatibility-retry.unit.test.ts`
- Test: `tests/openai/bridge-compatibility-errors.http.test.ts`

- [ ] Request error：headers未提交，真实 HTTP 400/422，dispatch=0。
- [ ] Whole response error：headers未提交，真实 HTTP 502或规格 status。
- [ ] Stream headers-committed/body-uncommitted：HTTP 200、无 partial semantic content、typed terminal。
- [ ] Stream body-committed：保 partial＋typed terminal，History `bodyCommitted:true`。
- [ ] `runResponseBufferedSink` catch 在 `classifyStreamError` 前识别 typed error，返回原 Error，不增加 attempt／reset／exchange／continuation。
- [ ] Semantic retry registry 不 claim；compatibility error观测后 dispatch delta=0，但合法前置 retry／hedge数量保留。
- [ ] mutation：把 typed error送回 transport retry后 callCount测试红。
- [ ] Commit: `feat(pipeline): fail fast on bridge compatibility errors`

### Task 3.6: Infrastructure merged-state gate

- [ ] Run: `bun test tests/semantic-bridge tests/pipeline/request-bridge-wiring.it.test.ts tests/history/v3/bridge-diagnostics.it.test.ts tests/openai/bridge-compatibility-errors.http.test.ts`
- [ ] Run: `bun run typecheck`
- [ ] Run: `files=$(git diff --name-only "$PHASE_BASE"..HEAD -- '*.ts'); test -z "$files" || bun x eslint $files`，其中 `PHASE_BASE` 取本 phase progress frontmatter 的起始 SHA。Expected: eslint 0 error。
- [ ] Run: `bun run test:backend`。
- [ ] 独立 reviewer 双向检查 false-green／false-red；修订后恢复原 reviewer。
- [ ] Commit progress/archive disposition。

## Phase 验收

- P1/P2 core 已真实接入 lifecycle infrastructure，但没有 production family registry 条目；客户端 wire byte-identical。
- Request diagnostics 三出口 freeze一次；candidate response records隔离；winner投影时序可解释。
- Compatibility error 永不进入 retry／continuation，四个 commit stage wire正确。
