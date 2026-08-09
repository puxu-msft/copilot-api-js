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

### Task 3.2: Candidate-local response collector 先于 renderer 创建

**Files:**
- Modify: `src/lib/pipeline/generation/candidate-state.ts`
- Modify: `src/lib/pipeline/generation/candidate-response-session.ts`
- Modify: `src/lib/pipeline/driver.ts:539-547`
- Modify: `src/lib/pipeline/types.ts`（`FormatCodec.createCandidateRenderer(env, bridgeDiagnostics)`）
- Modify: `src/lib/codec/anthropic/codec.ts`
- Modify: `src/lib/codec/openai-responses/codec.ts`
- Test: `tests/pipeline/candidate-state.unit.test.ts`
- Test: `tests/pipeline/candidate-response-session.unit.test.ts`

**Produces:** 每candidate一个append-only response collector；candidate runtime在renderer之前创建同一实例，将它同时传给`createCandidateRenderer`和`createCandidateResponseSession`，snapshot冻结其records；loser／failed／cancelled都保留。

- [ ] **Step 1: 写创建顺序红灯。** Mock codec的`createCandidateRenderer`必须收到collector；renderer append后session snapshot看到同一record；两个candidate实例不相等。
- [ ] **Step 2: 跑红灯。** Run: `bun test tests/pipeline/candidate-state.unit.test.ts tests/pipeline/candidate-response-session.unit.test.ts`。Expected: FAIL，renderer无collector参数。
- [ ] **Step 3: 重排producer。** Candidate state supply先创建collector；driver `createProcessor`先取得collector，再创建renderer，最后创建session；禁止renderer／session各自new collector。
- [ ] **Step 4: snapshot与settle。** Session terminal snapshot freeze；loser／failed／cancelled在dispatch diagnostics保留完整records。
- [ ] **Step 5: mutation。** 恢复renderer先创建、共享collector或request-global单槽后目标测试红。
- [ ] **Step 6: commit。** Commit: `feat(pipeline): isolate candidate bridge diagnostics`

### Task 3.3: RequestContext 与 History schema

**Files:**
- Modify: `src/lib/history/types.ts`
- Modify: `src/lib/context/types.ts`
- Modify: `src/lib/context/request.ts`
- Modify: `src/lib/context/model-operation-record.ts`（dispatch diagnostics 与 terminal metadata 的权威 owner）
- Test: `tests/context/request-bridge-diagnostics.unit.test.ts`
- Test: `tests/history/v3/bridge-diagnostics.it.test.ts`
- Test: `tests/pipeline/non-streaming-bridge-diagnostics.unit.test.ts`

**Produces:**

```ts
publishRequestBridgeDiagnostics(diagnostics: RequestBridgeDiagnostics): void
appendCandidateBridgeDisposition(candidate: CandidateHandle, record: ResponseBridgeDispositionRecord): void
freezeCandidateBridgeDiagnostics(candidate: CandidateHandle): CandidateBridgeDiagnostics
PipelineInfo.bridgeDispositions?: BridgeDispositionRecord[]
```

- [ ] 写request records单份冻结、candidates只投影id/hash、winner顶层投影测试。
- [ ] 写hedge loser先写、winner后写、无winner failure六种顺序。
- [ ] 新增non-streaming candidate调用链：`runResponseNonStreaming`必须解析当前generation binding，使用该candidate的collector运行whole profile，freeze后再选择／投影winner；不得直接写request-global response slot。Response-only compatibility helper创建显式synthetic candidate-local collector并标`dispatchScopedCapture:false`。
- [ ] 接V3 terminal store／API readback，不能只测`toHistoryEntry()`内存对象。
- [ ] mutation：whole response绕过candidate collector、loser污染winner、request records复制到每candidate、无candidate reject丢History后红。
- [ ] Run: `bun test tests/context/request-bridge-diagnostics.unit.test.ts tests/history/v3/bridge-diagnostics.it.test.ts tests/pipeline/non-streaming-bridge-diagnostics.unit.test.ts`。Expected: PASS。
- [ ] Commit: `feat(history): persist semantic bridge dispositions`

### Task 3.4: 惰性 migration dispatcher 与 S2 request runner `try/finally`

**Files:**
- Create: `src/lib/openai/translate/semantic-bridge/migration-dispatch.ts`
- Modify: `src/lib/pipeline/request-state.ts`
- Modify: `src/lib/pipeline/cell-assembly.ts`（`translateOut(env, requestTranslation?)`）
- Modify: `src/lib/pipeline/hub-translate.ts`（profile resolver + `RequestTranslationRuntime`）
- Modify: `src/lib/pipeline/driver.ts:347-369`
- Modify: `src/lib/codec/anthropic/anthropic-cell.ts:103-106`
- Modify: `src/lib/codec/openai-responses/openai-responses-cell.ts:88-101`
- Test: `tests/semantic-bridge/migration-dispatch.unit.test.ts`
- Test: `tests/pipeline/hub-translate.unit.test.ts`
- Test: `tests/pipeline/request-bridge-wiring.it.test.ts`

**Produces:** `createMigrationDispatcher({ migratedKinds, semantic, legacy })`；每 kind 精确二选一，不支持 semantic→legacy fallback 或双结果合并。P3 production `migratedKinds` 为空，wire严格走legacy；`HubTranslateContext.profileOverride` 是 fixture-only DI（仿 `DriverDeps.decideRoute`），production omits，driver不读取profile。

- [ ] **Step 1: 写 dispatcher 红灯。** 空集合只调 legacy；已迁 kind只调 semantic；semantic throw不回退legacy；同kind双调用计数必须失败。
- [ ] **Step 2: 跑红灯。** Run: `bun test tests/semantic-bridge/migration-dispatch.unit.test.ts`。Expected: FAIL，模块不存在。
- [ ] **Step 3: 建S2-local supply。** `hub-translate.ts`导出`resolveRequestTranslationRuntime(env, profileOverride?)`，只在non-identity且有migrated kind／fixture override时返回`{collector,context,profile}`。Driver在route decision后、`outboundTranslateOut`前调用一次，并以显式参数传给`CellAssembly.translateOut(env,runtime)`；两个outbound cell继续传给`translateRequestVia`。Open collector不进入`RequestState`。空production集合且无override时resolver返回undefined、dispatcher不append、不改变body。
- [ ] **Step 4: Driver S2 finally。** Success／compatibility reject／unexpected throw都freeze同一runtime collector；成功时`env.with({requestState:{...stableState,requestBridgeDiagnostics:frozen}})`，reject／throw时直接`ctx.publishRequestBridgeDiagnostics(frozen)`供失败History。Candidate fork只见frozen diagnostics，永不接触open collector。
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

- [ ] **Step 1: 写 exact 8格红灯。** 2目标协议×4阶段逐格断言：request HTTP（`incompatible-continuation`=422，其余=400）、whole response HTTP=502、stream body-uncommitted HTTP保持200且terminal前无semantic content、stream body-committed保partial＋同taxonomy terminal。Anthropic HTTP body固定`{type:"error",error:{type:"invalid_request_error"|"api_error",message}}`；OpenAI HTTP body固定`{error:{message,type:"invalid_request_error"|"server_error",code,param:null}}`；Anthropic terminal固定`event:error`＋`api_error` data；Responses terminal固定`event:error`＋`{type:"error",code,message,sequence_number}`，无`param`。
- [ ] **Step 2: 跑红灯。** Run: `bun test tests/openai/bridge-compatibility-errors.http.test.ts tests/pipeline/bridge-compatibility-retry.unit.test.ts`。Expected: FAIL，codec／handler尚未委托profile renderer，outcome无`bodyCommitted`。
- [ ] **Step 3: 接唯一调用链。** Headers未提交时route只调用`formatHttp`；进入`streamSSE`后handler只调用`formatTerminal`；driver只携原Error＋`bodyCommitted`，不选择status／taxonomy／wire。Anthropic codec复用`mapHttpErrorToEnvelope`／`anthropicErrorFrame`的既有taxonomy，Responses codec复用`openAIStreamErrorFrame` taxonomy并由renderer补typed code／sequence。
- [ ] **Step 4: fail-fast。** `runResponseSink`／`runResponseBufferedSink`在`classifyStreamError`前识别typed error，返回原Error，不增加attempt／reset／exchange／continuation；semantic retry registry不claim。错误观测后dispatch delta=0，合法前置retry／hedge数量保留。
- [ ] **Step 5: mutation。** Response-side改400、Anthropic terminal改`invalid_request_error`、Responses terminal漏sequence、body-uncommitted写partial、typed error重进transport retry后对应测试红。
- [ ] **Step 6: 绿灯。** Run: `bun test tests/openai/bridge-compatibility-errors.http.test.ts tests/pipeline/bridge-compatibility-retry.unit.test.ts`。Expected: 8格全部PASS，request dispatch=0，response error后dispatch delta=0。
- [ ] **Step 7: commit。** Commit: `feat(pipeline): fail fast on bridge compatibility errors`

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
