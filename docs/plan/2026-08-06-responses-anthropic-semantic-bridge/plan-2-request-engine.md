# P2 — Ordered Request Engine and Top-Level Capability Registry

> **状态**：未实施
>
> **前置**：P1 types／diagnostics／compatibility error；P0 capability matrix 的已裁决行。未裁决 capability 必须 degraded／rejected。

**Goal:** 用一个 request engine 驱动两张 request 方向表，保证 source turn／item 顺序、tools＋choice 同源、top-level capability 单一 owner、continuation reconstruction 与 request diagnostics 恰好冻结一次。

### Task 2.1: Branded ordering primitive

**Files:**
- Create: `src/lib/semantic-bridge/request.ts`
- Create: `tests/semantic-bridge/request-ordering.unit.test.ts`
- Create: `docs/tmp/2026-08-07-responses-anthropic-semantic-bridge-progress-p2-request.md`

**Produces:** `OrderedRequestEmission<E>`、`RequestOrderingPolicy<E>`、branded `OrderedRequestSequence<E>`、`orderRequestEmissions()`。

- [ ] 写 preserve 与 reasoning-first 红灯：`tool→text`、`text→tool→text`、多工具、两 source groups。
- [ ] 断言 reasoning-first 只在组内稳定移动 reasoning，组间顺序不变；无 reasoning kind 时该 policy 类型不可构造。
- [ ] 实现 stable partition；coordinator 参数只接受 brand。
- [ ] mutation：跨组排序、移动 tool、绕过 brand 后红。
- [ ] Commit: `feat(bridge): add ordered request sequence`

### Task 2.2: Top-level capability patch engine

**Files:**
- Modify: `src/lib/semantic-bridge/request.ts`
- Create: `tests/semantic-bridge/top-level-capabilities.unit.test.ts`
- Create: `tests/semantic-bridge/request-profile.typecheck.unit.test.ts`

**Produces:** `TopLevelCapabilityRegistry`、`applyTopLevelCapabilities()`、`assembleRequestPayload()`。

- [ ] 写 registry key/order exact-set 红灯；order 缺 key／重复 key、两个 rule 写同 path、top-level path 与 items field 相交均 reject。
- [ ] 写正确状态：多个 rule 写不同 path 原子应用；mapped path 从 patches 单源派生；合法 degraded 带 disposition继续。
- [ ] 实现 rule 只读 source payload、返回受限 patches＋disposition；coordinator 不接 payload／target，只返回 items。
- [ ] 把 `tools+tool_choice` 作为单一 capability fixture，删除 declaration 时 choice 同步省略。
- [ ] mutation：last-write-wins、coordinator 返回完整 target、吞 disposition 后红。
- [ ] Commit: `feat(bridge): add top-level capability registry`

### Task 2.3: 通用 request profile runner（仅 fixture profile）

**Files:**
- Modify: `src/lib/semantic-bridge/request.ts`
- Create: `tests/semantic-bridge/fixtures/request-profiles.ts`
- Create: `tests/semantic-bridge/request-profile-runner.unit.test.ts`

**Produces:**

```ts
export type RequestBridgeResult<TargetPayload> =
  | { kind: "accepted"; payload: TargetPayload }
  | { kind: "rejected"; error: BridgeCompatibilityError }

export function runRequestBridge<
  Payload,
  TargetPayload,
  TargetItem,
  SourceByKind extends object,
  Emission extends { kind: string },
  KnownTopLevelCapability extends string,
  KnownTopLevelTargetField extends string,
  TargetItemsField extends string,
>(
  profile: RequestBridgeProfile<
    Payload,
    TargetPayload,
    TargetItem,
    SourceByKind,
    Emission,
    KnownTopLevelCapability,
    KnownTopLevelTargetField,
    TargetItemsField
  >,
  payload: Payload,
  ctx: RequestBridgeContext,
  collector: RequestBridgeDiagnosticsCollector,
): RequestBridgeResult<TargetPayload>
```

- [ ] **Step 1: 写 fixture profile 红灯。** Fixture 只含虚构 `alpha`／`beta` source kinds 与 `mapped`／`degraded` capability，不实现 message／function／reasoning 等真实业务。
- [ ] **Step 2: 跑红灯。** Run: `bun test tests/semantic-bridge/request-profile-runner.unit.test.ts`。Expected: FAIL，缺 `runRequestBridge`。
- [ ] **Step 3: 实现通用顺序。** 建 collector → fixture handlers 产 emissions → `orderRequestEmissions` → `applyTopLevelCapabilities` → fixture coordinator 产 items → `assembleRequestPayload`；collector 的 freeze 仍由 P3 S2 owner 负责，runner 不自行 freeze。
- [ ] **Step 4: 正负控制。** Profile 缺 coordinator／ordering／capability table 编译红；success／rejected／unexpected throw 都返回原 error 与已追加 records，不伪造流程动作。
- [ ] **Step 5: mutation。** 绕过 branded ordering、last-write-wins、吞 degraded disposition 后目标测试红。
- [ ] **Step 6: commit。** Commit: `feat(bridge): add generic request profile runner`

### Task 2.4: Ordered-turn oracle 与当前缺陷基线

**Files:**
- Modify: `tests/openai/anthropic-to-responses-request.unit.test.ts`
- Modify: `tests/openai/responses-to-anthropic-request.unit.test.ts`
- Create: `tests/semantic-bridge/request-ordering-oracle.unit.test.ts`

- [ ] **Step 1: 锁当前生产缺陷。** 用现有 translator 实证 `tool→text`、`text→tool→text`、多工具交错的当前错误输出，并在测试名／注释标 `known defect`；这些断言在对应 family cutover commit 中翻转，不作为长期 golden。
- [ ] **Step 2: 锁新 engine 正确状态。** 用虚构 emissions 驱动 `orderRequestEmissions`，断言 Anthropic parallel tool results 同一 group、Responses groups 不跨 turn。
- [ ] **Step 3: 跑测试。** Run: `bun test tests/semantic-bridge/request-ordering-oracle.unit.test.ts tests/openai/anthropic-to-responses-request.unit.test.ts tests/openai/responses-to-anthropic-request.unit.test.ts`。Expected: PASS，且 known-defect cases 明确展示旧／新差异。
- [ ] **Step 4: mutation。** 按 kind 全局分桶、跨 group 移动 reasoning 后新 oracle 红；旧 defect test 仍只描述生产现状。
- [ ] **Step 5: commit。** Commit: `test(bridge): lock ordered request defect and oracle`

### Task 2.5: Capability matrix fixture，不创建真实 profile

**Files:**
- Modify: `tests/semantic-bridge/fixtures/request-profiles.ts`
- Create: `tests/semantic-bridge/top-level-mapping.unit.test.ts`

- [ ] **Step 1: 将 P0 已裁决行编码成测试数据。** 数据行包含 source capability、target paths、mapped／degraded／rejected、lostFields；不创建 production registry。
- [ ] **Step 2: 未裁决项正控。** Structured-output name／`context_management` 未裁决行只能产生 explicit degraded／rejected fixture，不能被测试当作已批准 mapping。
- [ ] **Step 3: 运行。** Run: `bun test tests/semantic-bridge/top-level-mapping.unit.test.ts`。Expected: PASS。
- [ ] **Step 4: mutation。** 删除 fixture capability key、把同名字段整体透传、吞 lostFields 后红。
- [ ] **Step 5: commit。** Commit: `test(bridge): freeze request capability decisions`

## Phase 验收

- 此 phase 不创建真实 pair profile、不实现任何 production semantic family，也不替换 `hub-translate`；只有 fixture profile 与通用 engine，客户端 wire 零变化。
- AC22／AC24 全部有 unit＋type fixture＋目标 mutation。
- `bun test tests/semantic-bridge tests/openai/*request* && bun run typecheck` 通过。
- `bun run test:backend` 通过；旧客户端 wire 未变。
