# P1 — Semantic Core, Typed Lifecycle, and Target Grammar

> **状态**：未实施
>
> `[hard]` **并列备选，非当前执行线。** 语义桥当前由 [`docs/plan/2026-08-08-semantic-bridge/plan.md`](../2026-08-08-semantic-bridge/plan.md)（32 片 C0–C11，C0 已交付）执行；两条线在**迁移粒度／core owner／continuation schema** 三处互斥，不能同时落地。动手前先读 [README.md](README.md) 顶部的对照表确认你要执行的是哪一条。
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
  **⛔ 到此为止，别再往这里加第四格类型负样本。** 理由见 Step 5c／5d。
- [ ] **Step 5c: 唯一 typed factory + 不导出的 brand（覆盖非 registry 装配点）。** 给 `RequestBridgeProfile`／`ResponseBridgeProfile` 加 `readonly [BRIDGE_PROFILE_BRAND]: true`（`declare const BRIDGE_PROFILE_BRAND: unique symbol`，**不从模块导出**），并新增唯一构造入口 `defineRequestBridgeProfile<TF>(input): RequestBridgeProfile<..., TF>`。**生产表、局部临时对象、测试 fixture 一律经它构造**——含 P2 Task 2.3 的 fixture profile（那批**不在任何 registry 里**，是本 Step 要覆盖的主要真空）。
  **红灯**：把手写结构替身传进 runner，断言编译失败。**实测形态**：`TS2345 — Property '[BRAND]' is missing in type 'StandIn' but required in type 'Profile<...>'`。
  **为什么必须有 brand**：Step 5d 的守卫只扫 registry 声明，**扫不到**局部临时对象、工厂返回值、测试 fixture。brand 把不变量从**位置性**（"registry 那处要写对"）变成**结构性**（"没 brand 的对象根本进不了 runner"），这才覆盖非 registry 装配点。这是第三方裁决指出的、纯守卫方案的真空。
  **⚠️ brand 单独不够，别以为加了就安全**：实测确认 `declare function makeWide(): Profile<BridgeTargetFormat>` 的返回值**带着合法 brand**，传进 runner **零报错**。显式宽实例化这一姿势只能由 Step 5d 的守卫拦。三条机制（factory 推断 / brand / 守卫拒宽实例化）各堵一类，**缺一不可**。
- [ ] **Step 5d: 架构守卫——registry 值类型必须引用冻结别名，且拒绝显式宽实例化。** 新建 `tests/architecture/bridge-profile-renderer-authority.unit.test.ts`，用既有的 `tests/architecture/source-ast.ts` 做源码级断言（形状参照 `anchor-remap-single-authority.unit.test.ts` 的单一权威守卫）：**registry／表的值类型声明必须引用那条已冻结的零参封闭联合别名**，不得是结构相似的手写替身；**并拒绝任何显式写出的 `Profile<BridgeTargetFormat>` 宽实例化标注**（含函数返回类型标注——这正是 brand 拦不住的那一格）。
  **为什么这一层不能省、也不能用「加类型格」替代**：类型层管的是「**你怎么实例化冻结构造**」，管不到「**你到底用不用它**」。实测确认手写 `interface ProfileBase { targetFormat: BridgeTargetFormat; errorRenderer: AnthropicRenderer | ResponsesRenderer }` 当容器值类型，错配 **exit 0**；而结构替身有**无穷多种**写法（改名、换序、改 `type`、加可选字段、`extends` 组合——第三方裁决独立实测四个变体**全部逃逸**），逐个点名补不完。
  正样本对照：把值类型换成正确的冻结别名后守卫转绿；负样本：换成任意手写替身、或写出宽实例化标注后守卫必须红。
  **具体写法**（经第三方裁决者读码确认可行——`source-ast.ts` 的 `parseSource` 返回 `setParentNodes:true` 的完整 `ts.SourceFile`，纯语法解析、无 type checker，但本守卫不需要符号解析）：
  ① 找冻结别名的 `ts.TypeAliasDeclaration`，断言名称固定、**无 `typeParameters`**、右侧是预期两臂的 `UnionTypeNode`（这一步顺带把 Posture O 也钉死在源码层）；
  ② 对每个已登记的 registry／表变量找 `VariableDeclaration`，类型来源取 `declaration.type`，或 initializer 是 `SatisfiesExpression` 时取 `initializer.type`；
  ③ 要求外层是名为 `Record` 的 `TypeReferenceNode`，沿嵌套 `Record` 取最终 value type argument，断言它是**直接引用冻结别名**的 `TypeReferenceNode` 且无类型实参；
  ④ 扫全仓类型标注，拒绝 `Profile<BridgeTargetFormat>` 形态的显式宽实例化；
  ⑤ 照 `anchor-remap-single-authority` 的做法**冻结目标声明集合并双向比较**（`freeze-hit-set-not-zero-hits`），避免漏扫某个 registry；
  ⑥ 负控至少覆盖 `ProfileBase`、其改名／换序变体，以及一处宽实例化返回标注。
  **已知能力边界（方向别写反）**：纯语法 AST 不做符号解析，故**追不动跨文件 alias／re-export 链**；要可靠追踪需 `Program`+`TypeChecker`。当前契约只要求「声明处**直接**引用冻结别名」，因此不需要——而且守卫**原样不变时遇到中间别名会假红（误伤），不是假绿**。**只有**当有人把规则放宽成「接受任意中间 alias」却仍不做符号解析时，才会变成假绿。（第三方裁决订正：我原先把方向写反了。）
  **旁证**：`source-ast.ts` 自己的头注释写着「the parser is the only thing that covers the legal syntax SPACE rather than a growing list of remembered forms」——本仓建这套 AST 工具时认定的正是同一条原则（覆盖语法空间，而不是维护一张记住的形态清单），本 Step 与它同源。
- [ ] **Step 6: 运行。** Run: `bun test tests/semantic-bridge/compatibility-error.unit.test.ts tests/semantic-bridge/compatibility-error-renderer.unit.test.ts && bun run typecheck`。Expected: PASS。
- [ ] **Step 7: commit。** Commit: `feat(error): add bridge compatibility renderers`

## Phase 验收

- Core 生产代码尚未被 `hub-translate`／routes import，现有 wire goldens byte-identical。
- `bun run test:backend`、typecheck、精确 eslint 通过。
- 架构守卫确认 `src/lib/semantic-bridge/` 不 import routes、transport、state、driver。
- Progress 每个 commit 均更新；相位结论折回本文件。
