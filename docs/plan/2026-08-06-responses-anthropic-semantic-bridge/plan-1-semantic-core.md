# P1 — Semantic Core, Typed Lifecycle, and Target Grammar

> **状态**：未实施
>
> **前置**：无；与 P0 可并行。此 phase 不接 production profile，客户端 wire 必须零变化。

**Goal:** 建立行为中性的 semantic bridge core：双平面 decision、typed handler factories、source lifecycle router、target Responses grammar、continuation collector、diagnostics collectors 和 compatibility error 类型。

**Architecture:** Core 不 import transport、routes、state 或 concrete translators。Handlers 只作领域决定；router 管 key／phase／finalize；renderer grammar 只验证／组装目标 wire；driver integration 留 P3。

### Task 1.1: 双平面 types 与 compile-time fixtures

**Files:**
- Create: `src/lib/semantic-bridge/types.ts`
- Create: `src/lib/semantic-bridge/index.ts`
- Create: `tests/semantic-bridge/types.typecheck.unit.test.ts`
- Create: `docs/tmp/2026-08-07-responses-anthropic-semantic-bridge-progress-p1-core.md`

**Produces:** `BridgeDecision<E>`、`PresentationDecision<E>`、`ContinuationDecision`、`BridgeEmission`、`RequestItemDecision<E>`、`SourceAffinity`。

- [ ] **Step 1: 写类型正负 fixture**

正样本：`presentation:degraded + continuation:carrier`；负样本：known response handler 返回 `undefined`、degraded 缺 reason／lostFields／syntheticKind、opaque handler 返回无理由 none。

- [ ] **Step 2: 跑红灯**

Run: `bun test tests/semantic-bridge/types.typecheck.unit.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现规格签名**

完整复制规格 §5.4／§6 的 discriminated unions；`BridgeEmission` 明确 client/server tool call/result 与 citation，不接受 `raw:any` escape hatch。

- [ ] **Step 4: 绿灯与 mutation**

Run: `bun test tests/semantic-bridge/types.typecheck.unit.test.ts && bun run typecheck`
Expected: PASS。临时把 `BridgeDecision` 改成单平面后 type fixture 必红，再反向恢复冻结 patch。

- [ ] **Step 5: commit**

Commit: `feat(bridge): add typed semantic decisions`

### Task 1.2: typed handler factories 与 lifecycle router

**Files:**
- Create: `src/lib/semantic-bridge/lifecycle.ts`
- Create: `tests/semantic-bridge/lifecycle-router.unit.test.ts`
- Create: `tests/semantic-bridge/lifecycle-types.typecheck.unit.test.ts`

**Produces:**

```ts
export interface BoundResponseItemHandler<E> {
  consume(event: SemanticItemLifecycleEvent, ctx: ResponseBridgeContext): LifecycleDecision<E>
  finalize(ctx: ResponseBridgeContext): BridgeDecision<E>
}
export function defineWholeItemOnDoneHandler<Whole, Lifecycle extends SemanticItemLifecycleEvent, E>(
  spec: WholeItemOnDoneHandlerSpec<Whole, Lifecycle, E>,
): ResponseSemanticHandler<Whole, Lifecycle, E>
export function defineStatefulResponseHandler<Whole, Lifecycle extends SemanticItemLifecycleEvent, E, State>(
  spec: StatefulResponseHandlerSpec<Whole, Lifecycle, E, State>,
): ResponseSemanticHandler<Whole, Lifecycle, E>
export function createSemanticLifecycleRouter<E>(input: {
  resolveHandler(semanticKind: string, ctx: ResponseBridgeContext): BoundResponseItemHandler<E> | BridgeCompatibilityError
}): SemanticLifecycleRouter<E>
```

- [ ] **Step 1: 写 router 红灯**

覆盖 open→delta→close、close-only 合成 open、semantic kind 中途改变、重复 close、source flush 有 open item、unknown event。

- [ ] **Step 2: 写 typed source fixture**

Responses Web Search whole 包含 complete／incomplete；function progress 接 `FunctionCallArgumentsDoneEvent`；Anthropic nested delta 先提 outer event 再窄 delta；业务 callback 不接 `unknown` state/source。

- [ ] **Step 3: 实现最小 router 与 factories**

异构擦除只在 factory core，runtime kind guard 失败返回 `BridgeCompatibilityError`，不 cast 到业务层。

- [ ] **Step 4: 运行与 mutation**

Run: `bun test tests/semantic-bridge/lifecycle-router.unit.test.ts tests/semantic-bridge/lifecycle-types.typecheck.unit.test.ts`
Expected: PASS。删除 runtime kind guard、允许重复 finalize、恢复 nested `Extract` 后各自精确变红。

- [ ] **Step 5: commit**

Commit: `feat(bridge): add typed lifecycle router`

### Task 1.3: Target Responses lifecycle grammar

**Files:**
- Create: `src/lib/semantic-bridge/responses-grammar.ts`
- Create: `tests/semantic-bridge/responses-grammar.unit.test.ts`
- Extend: `tests/e2e-client/responses-nodelta.probe.it.test.ts`

**Produces:** `createResponsesTargetEmitter()`，发射 message text／reasoning summary／function call／completed／incomplete 的合法偏序。

- [ ] **Step 1: 在旧实现上捕获官方 SDK 失败正样本**

新增 fixture：缺 message `output_item.added`、缺 reasoning `reasoning_summary_part.added`；真实 OpenAI SDK 应分别因 missing output／content 抛错。正确完整序列与零 delta 序列必须通过。

- [ ] **Step 2: 写 grammar unit 红灯**

断言每 output_index 的 item／part added/done exactly once，terminal event type 与 payload status 一致，多 item id/index 独立。

- [ ] **Step 3: 实现 emitter**

Emitter 接 semantic emissions 与 lifecycle decisions，不读取 source wire；`response.incomplete` 不能伪装成 completed。

- [ ] **Step 4: 双 oracle 绿灯**

Run: `bun test tests/semantic-bridge/responses-grammar.unit.test.ts tests/e2e-client/responses-nodelta.probe.it.test.ts`
Expected: PASS。删除任一必需 added 事件或把 incomplete 改 completed 后，目标测试红。

- [ ] **Step 5: commit**

Commit: `feat(bridge): add Responses target grammar`

### Task 1.4: Continuation envelope 与 collector

**Files:**
- Create: `src/lib/semantic-bridge/continuation.ts`
- Create: `tests/semantic-bridge/continuation.unit.test.ts`

**Produces:** `ResponsesContinuationEnvelopeV2`、versioned prefix、`ContinuationCollector`、`compareSourceAffinity()`；保留 v1 decoders。

- [ ] **Step 1: 写 encode/decode／foreign／corrupt／affinity tests**
- [ ] **Step 2: 跑红灯**
- [ ] **Step 3: 实现 v2 envelope，不写普通日志，不裁 source fields**
- [ ] **Step 4: 正负控制**：alias 同 resolved source 可恢复；不同 compatibilityKey 默认剥离；删 affinity 后测试红。
- [ ] **Step 5: commit** `feat(bridge): add continuation envelope`

### Task 1.5: Diagnostics collectors 与 canonical hash

**Files:**
- Create: `src/lib/semantic-bridge/diagnostics.ts`
- Create: `tests/semantic-bridge/diagnostics.unit.test.ts`

**Produces:** open→frozen `RequestBridgeDiagnosticsCollector`、candidate append-only response collector、canonical `{version,records}` hash。

- [ ] **Step 1: 写 success／reject／throw freeze tests**
- [ ] **Step 2: 写 canonical 正控**：对象 key 构造顺序不同 hash 相同；record 顺序不同 hash 不同；id 不进 hash。
- [ ] **Step 3: 实现 append/freeze；freeze 后 append／再次 freeze fail-loud**
- [ ] **Step 4: mutation**：把 id 纳入 hash、把 response collector改成单槽后测试红。
- [ ] **Step 5: commit** `feat(bridge): add append-only diagnostics collectors`

### Task 1.6: Compatibility error 与 exact renderer contract

**Files:**
- Create: `src/lib/error/bridge-compatibility-error.ts`
- Modify: `src/lib/error/index.ts`
- Create: `src/lib/semantic-bridge/compatibility-error-renderer.ts`
- Test: `tests/semantic-bridge/compatibility-error.unit.test.ts`
- Test: `tests/semantic-bridge/compatibility-error-renderer.unit.test.ts`

**Produces:** class fields与规格一致；`retryable:false` readonly；`isBridgeCompatibilityError`不靠message string；`createAnthropicCompatibilityErrorRenderer()`与`createResponsesCompatibilityErrorRenderer()`实现规格§11的唯一矩阵。

- [ ] **Step 1: 写class红灯。** 覆盖四个code、request/response direction、source/target、wireType、requestId；type guard拒绝同名普通Error。
- [ ] **Step 2: 写8格renderer红灯。** 2目标协议×4阶段：request HTTP、whole response HTTP、stream body-uncommitted、stream body-committed。断exact status/body/event/data/bodyCommitted输入；判别union要求Anthropic terminal调用不带sequence、Responses terminal必须带单调`sequenceNumber:number`，漏传在type fixture编译红。
- [ ] **Step 3: 跑红灯。** Run: `bun test tests/semantic-bridge/compatibility-error.unit.test.ts tests/semantic-bridge/compatibility-error-renderer.unit.test.ts`。Expected: FAIL，缺class／renderer。
- [ ] **Step 4: 实现唯一矩阵。** Request incompatible-continuation=422，其余request=400，response=502；Anthropic HTTP/terminal与OpenAI HTTP/Responses terminal形状逐字按spec；renderer不读transport classifier。
- [ ] **Step 5: mutation。** 把response改400、Anthropic terminal用invalid_request、Responses terminal漏sequence、bodyCommitted两支生成不同taxonomy后精确红。
- [ ] **Step 5b: profile↔renderer 错配的编译期红灯（三格，缺一不可）。** 在 `tests/semantic-bridge/types.typecheck.unit.test.ts`：
  **格 1（具体实例化）**：构造 `targetFormat:"anthropic-messages"` 的 profile 却挂 `createResponsesCompatibilityErrorRenderer()`，断言**编译失败**（`@ts-expect-error`）；反向同理。若实现退回裸 `CompatibilityErrorRenderer` 联合体，该格因「`@ts-expect-error` 未触发」（`TS2578`）而红。
  **格 2（容器实例化）**：把同一份错配放进 registry 形状的容器里再断言。**实测事实（tsc 5.9.3 `--strict`）**：`satisfies Record<X, Profile<BridgeTargetFormat>>` 这种**宽实例化**容器下，错配 **exit 0、零报错**；换成**零类型参数的封闭联合**（每个 `targetFormat` 字面量各一臂）后，同一份错配报 `TS2322`、且正确装配不误红。
  **格 3（泛型别名，⚠️ 最隐蔽）**：把容器值类型换成**带宽默认值的泛型别名**并裸用——`type HelperProfile<TF extends BridgeTargetFormat = BridgeTargetFormat> = Profile<TF>`，`satisfies Record<X, HelperProfile>`。**实测 exit 0、错配零报错**。本格断言这种写法**不被采用**（即：若实现把容器值类型写成这种形式，格 2 的错配断言会因「`@ts-expect-error` 未触发」转红）。
  **为什么三格缺一不可**：格 1 看不见容器姿势；格 2 看不见「别名仍是开放泛型」这一姿势——`HelperProfile` 字面上像是符合「用联合别名」的要求，实际等价于宽实例化。**格 3 正是第五轮评审用独立 PoC 击穿前一版修法后补上的**，前一版不变量只写「具体实例化的联合」，允许了这个写法。
  **背景**：`hub-translate.ts` 现有 `satisfies Record<ClientFormat, Record<UpstreamEndpoint, RequestBridge>>` 就是容器形状，实施者照房内惯例写就会掉进格 2／格 3 的坑。
  **这三格不可省**：8 格运行时测试测的是各协议内部正确性，**覆盖不到装配错配**——这是判据之间的缝，不是某条判据写错。
- [ ] **Step 6: 运行。** Run: `bun test tests/semantic-bridge/compatibility-error.unit.test.ts tests/semantic-bridge/compatibility-error-renderer.unit.test.ts && bun run typecheck`。Expected: PASS。
- [ ] **Step 7: commit。** Commit: `feat(error): add bridge compatibility renderers`

## Phase 验收

- Core 生产代码尚未被 `hub-translate`／routes import，现有 wire goldens byte-identical。
- `bun run test:backend`、typecheck、精确 eslint 通过。
- 架构守卫确认 `src/lib/semantic-bridge/` 不 import routes、transport、state、driver。
- Progress 每个 commit 均更新；相位结论折回本文件。
