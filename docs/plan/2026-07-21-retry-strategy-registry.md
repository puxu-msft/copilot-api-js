# reactive retry 策略声明式 registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 16 个 reactive retry 策略从「per-leg 硬编码数组 + 注释维护顺序」重构成声明式 registry（named + 声明 order + appliesTo + config 开关 + 统一可观测 + 跨 leg 去重），行为字节等价。

**Architecture:** 新增 `src/lib/request/retry-registry.ts`（registry 声明集 + `RETRY_STRATEGY_ORDER` + `assembleRetryStrategies`），三个 `buildXxxStrategies` 改为薄封装调它。deps 统一成 optional bundle + 消费点 throwMissing；appliesTo 用 `targetEndpoint===MESSAGES`；config `retry.strategies.<key>.enabled` opt-out；telemetry per-strategy fire 计数。

**Tech Stack:** TypeScript / Bun；测试 `bun test`。

**权威 RFC:** `docs/rfc/2026-07-21-retry-strategy-registry.md`（评审通过 v3）。

## Global Constraints

- **字节等价硬约束**：每 leg（6 cell）经 `cell.buildLegStrategies` 产出的 `EnvRetryStrategy[]` 顺序 + 行为逐字节不变（golden 锁，Commit 1）。
- **appliesTo 谓词 = `targetEndpoint === ENDPOINT.MESSAGES`**（**不是** `clientFormat==="anthropic"`）——否则 cc/responses/gemini 三条 reverse @messages 腿丢 13 策略（RFC §3.3）。
- **deps optional + throwMissing**：`betaProbe?`/`resanitize?` optional；需要它们的 entry 全 appliesTo:MESSAGES；消费点 `?? throwMissing(...)` 显式抛错，绝不 `?? []` 静默兜底（RFC §3.1）。
- **策略实现零改**：纯搬装配层，各 `createXxxStrategy` 工厂 + matcher/修法/学习不动（复用，见 factory 锚点表）。
- **config opt-out**：`retry.strategies` 缺省 = 全开（保现状）;只 `enabled` bool;禁用被依赖策略 allow+warn。
- **提交纪律**：显式 pathspec、conventional commits、无模型署名;每 commit 后跑 golden + typecheck + 相关套件。
- **不杀 4141 主服务器**;测试用非 4141 端口。

## Factory 锚点表（复用，不重写）

| 策略 | 工厂 file:line | deps 需求 | kind |
|---|---|---|---|
| network-retry | `request/strategies/network-retry.ts` `createNetworkRetryStrategy` | — | payload |
| server-error-retry | `request/strategies/server-error-retry.ts` | — | payload |
| token-refresh | `request/strategies/token-refresh.ts` | — | payload |
| effort-learning | `request/strategies/effort-learning-retry.ts` | — | payload |
| tool-field-rejection | `request/strategies/tool-field-rejection-retry.ts` | — | payload |
| body-field-rejection | `request/strategies/context-management-retry.ts` `createBodyFieldRejectionStrategy` | — | payload |
| cache-control-subfield | `request/strategies/cache-control-subfield-rejection-retry.ts` | — | payload |
| legacy-thinking | `request/strategies/legacy-thinking-retry.ts` | — | payload |
| adaptive-thinking-rejection | `request/strategies/adaptive-thinking-rejection-retry.ts` | — | payload |
| poisoned-thinking | `codec/anthropic/poisoned-thinking-retry.ts` `createPoisonedThinkingRetryStrategy` | **env.ctx** | **env（native，不 adapt）** |
| unsupported-beta | `request/strategies/unsupported-beta-retry.ts` | **betaProbe**（`getProbeCandidates`） | payload |
| server-tool-rejection | `request/strategies/server-tool-rejection-retry.ts` | — | payload |
| structured-outputs-rejection | `request/strategies/structured-outputs-rejection-retry.ts` | — | payload |
| system-reject | `request/strategies/system-reject-retry.ts` | **resanitize** | payload |
| web-search-not-found | `request/strategies/web-search-not-found-retry.ts` | **resanitize** | payload |
| deferred-tool | `request/strategies/deferred-tool-retry.ts` | — | payload |

- **adapt 锚点**：`adaptPayloadStrategy(payloadStrategy, { attemptRef, originalPayload, model, maxRetries })`（[payload-strategy-adapter.ts:63](../../src/lib/pipeline/payload-strategy-adapter.ts#L63)）。attemptRef 是**一请求共享**的 `{value:0}` ref。
- **现状装配锚点**：anthropic [strategies.ts:87](../../src/lib/codec/anthropic/strategies.ts#L87)（16，含顺序注释）;cc [strategies.ts:41](../../src/lib/codec/openai-cc/strategies.ts#L41)（3）;responses [strategies.ts:44](../../src/lib/codec/openai-responses/strategies.ts#L44)（3）。
- **cell 消费锚点**：`anthropicMessagesLeg.buildLegStrategies`（[anthropic-cell.ts:144](../../src/lib/codec/anthropic/anthropic-cell.ts#L144)，direct + reverse 都调 buildAnthropicStrategies）;`throwMissing` 用法见 [anthropic-cell.ts:74](../../src/lib/codec/anthropic/anthropic-cell.ts#L74)。

---

### Task 1 (Commit 1): golden 预捕 — 锁全 6 cell 现状装配序

**Files:**
- Test: `tests/pipeline/retry-strategy-assembly.golden.it.test.ts`（新）

**Interfaces:**
- Consumes: 现状 `buildAnthropicStrategies`/`buildOpenAiCcStrategies`/`buildOpenAiResponsesStrategies`（改动前）。
- Produces: golden 断言（后续 commit 的字节等价 oracle）。

- [ ] **Step 1: 写 golden 测试**

对 6 组分别断言组装出的 `strategy.name[]` 顺序（判别字段，非全实例）。用各 build 函数的最小 deps（anthropic 需 betaProbe/resanitize stub）。`openai-responses|MESSAGES` 测 **HTTP 构造路径**（非 WS，RFC §3.1 边界）。

```ts
import { describe, expect, test } from "bun:test"
// ... imports: buildAnthropicStrategies, buildOpenAiCcStrategies, buildOpenAiResponsesStrategies + stubs

describe("retry-strategy assembly golden (pre-refactor lock)", () => {
  test("anthropic direct @messages → 16 策略顺序", () => {
    const names = buildAnthropicStrategies(stubAnthropicDeps()).map((s) => s.name)
    expect(names).toEqual([
      "network-retry", "server-error-retry", "token-refresh", "effort-learning-retry",
      "tool-field-rejection-retry", "body-field-rejection-retry", "cache-control-subfield-rejection-retry",
      "legacy-thinking-retry", "adaptive-thinking-rejection-retry", "poisoned-thinking-retry",
      "unsupported-beta-retry", "server-tool-rejection-retry", "structured-outputs-rejection-retry",
      "system-reject-retry", "web-search-not-found-retry", "deferred-tool-retry",
    ])
  })
  test("cc direct → 3 策略", () => {
    expect(buildOpenAiCcStrategies(stubCcDeps()).map((s) => s.name))
      .toEqual(["network-retry", "server-error-retry", "token-refresh"])
  })
  test("responses direct → 3 策略", () => {
    expect(buildOpenAiResponsesStrategies(stubResponsesDeps()).map((s) => s.name))
      .toEqual(["network-retry", "server-error-retry", "token-refresh"])
  })
  // reverse @messages 三腿:经 anthropic-cell.buildLegStrategies(reverse env) → 也应 16。
  // 用 anthropicMessagesLeg.buildLegStrategies 驱动 reverse env（clientFormat=openai-cc/responses/gemini, targetEndpoint=MESSAGES）
})
```

> **实施注**：先读各 `createXxxStrategy` 确认 `.name` 确切字面值（如 `network-retry.ts` 的 `name:"network-retry"`），golden 用真实 name。reverse 三腿的驱动见 `anthropic-cell.ts:144` 的 buildLegStrategies + reverse env 构造（参 `tests/anthropic/anthropic-codec.unit.test.ts` 现有 16-策略断言）。

- [ ] **Step 2: 在改动前 HEAD 上跑通（锁定现状）**

Run: `bun test tests/pipeline/retry-strategy-assembly.golden.it.test.ts`
Expected: PASS（锁定当前行为;若某 name 字面猜错，读工厂改对再跑）。

- [ ] **Step 3: 提交**

```bash
git add -- tests/pipeline/retry-strategy-assembly.golden.it.test.ts
git commit -m "test(retry): golden 预捕 6 cell 策略装配序（重构前锁定）"
```

---

### Task 2 (Commit 2): 加 `retry-registry.ts`（契约+order+声明集+assembler，不接线）

**Files:**
- Create: `src/lib/request/retry-registry.ts`
- Test: `tests/request/retry-registry.unit.test.ts`（新）

**Interfaces:**
- Consumes: 全 16 `createXxxStrategy` 工厂 + `adaptPayloadStrategy` + `ENDPOINT`。
- Produces: `RetryStrategyEntry`/`RetryStrategyContext`/`RetryStrategyDeps` 类型、`RETRY_STRATEGY_ORDER`、`RETRY_STRATEGY_REGISTRY`、`assembleRetryStrategies(ctx, deps, config)`、`isStrategyEnabled(config, key)`。**零消费者**（纯新增）。

- [ ] **Step 1: 写 assembler 单测**

```ts
// filter(appliesTo ∧ enabled) + sort(order) + payload/native 分支
test("MESSAGES ctx → 16 策略按 order", () => {
  const names = assembleRetryStrategies(
    { clientFormat: "anthropic", targetEndpoint: ENDPOINT.MESSAGES },
    stubDeps(), {}).map((s) => s.name)
  expect(names).toEqual([/* 同 Task1 的 16 */])
})
test("非 MESSAGES ctx → 仅 3 shared", () => {
  expect(assembleRetryStrategies({ clientFormat: "openai-cc", targetEndpoint: ENDPOINT.CHAT_COMPLETIONS }, stubDeps(), {}).map((s) => s.name))
    .toEqual(["network-retry", "server-error-retry", "token-refresh"])
})
test("config 禁用某策略 → 组装集少它", () => {
  const names = assembleRetryStrategies({ clientFormat: "anthropic", targetEndpoint: ENDPOINT.MESSAGES }, stubDeps(),
    { serverToolRejection: { enabled: false } }).map((s) => s.name)
  expect(names).not.toContain("server-tool-rejection-retry")
})
test("poisoned-thinking 是 native、不经 adapt", () => { /* 断言 kind:env 分支 */ })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/request/retry-registry.unit.test.ts`
Expected: FAIL（模块缺失）。

- [ ] **Step 3: 写 registry**

`src/lib/request/retry-registry.ts`：
- `RETRY_STRATEGY_ORDER`（RFC §3.3 表，16 键）。
- `RetryStrategyContext = { clientFormat, targetEndpoint }`;`RetryStrategyDeps`（RFC §3.1，betaProbe?/resanitize? optional）。
- `RETRY_STRATEGY_REGISTRY: RetryStrategyEntry[]` — 每 entry `{ name, order, appliesTo, configKey, kind, create(deps) }`。shared 三个 `appliesTo: () => true`;anthropic-only 13 个 `appliesTo: (ctx) => ctx.targetEndpoint === ENDPOINT.MESSAGES`。需 betaProbe 的（unsupported-beta）`create: (d) => createUnsupportedBetaRetryStrategy({ getProbeCandidates: () => (d.betaProbe ?? throwMissing("betaProbe")).getCandidates() })`;需 resanitize 的（system-reject/web-search）同法 throwMissing。poisoned-thinking `kind:"env"`。
- `assembleRetryStrategies(ctx, deps, config)`：filter(appliesTo ∧ isStrategyEnabled) → sort(order) → map(entry → kind==="payload" ? adaptPayloadStrategy(entry.create(deps), adaptDeps(deps)) : entry.create(deps))。
- `isStrategyEnabled(config, key)`：`config[key]?.enabled !== false`（缺省 true）。

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `bun test tests/request/retry-registry.unit.test.ts && bun run typecheck`
Expected: PASS + 绿。

- [ ] **Step 5: lint + 提交**

```bash
bunx eslint src/lib/request/retry-registry.ts tests/request/retry-registry.unit.test.ts
git add -- src/lib/request/retry-registry.ts tests/request/retry-registry.unit.test.ts
git commit -m "feat(retry): 声明式 retry-strategy registry + assembler（未接线）"
```

**Commit invariant**：纯新增、零消费者;三个 leg 仍用旧 buildXxxStrategies → Task 1 golden 仍过。

---

### Task 3 (Commit 3): 三 buildXxxStrategies 委托 assembler（字节等价 gate）✅ 已完成（commit `1ad16ede`）

> **实施结果**：clientFormat 传参未决执行注已定 —— assembler **只按 `targetEndpoint` 门控**（appliesTo 无视 clientFormat 恒定判断）；三 build 函数的 `ctx.clientFormat` 只作为 `RetryStrategyContext` 的备用字段传实际值（`"anthropic"`/`"openai-cc"`/`"openai-responses"`），不影响装配结果。`state.retryStrategies` 尚未由 Task 4 引入，三处委托暂传 `config: undefined`（assembler 视 `undefined` 同全默认 enabled，等价现状）。golden 6/6 **一次性逐字节通过**，未经调整。四格式套件（anthropic/openai/responses/gemini）2145 pass 零回归；全量快速档 `bun run test` 4356 pass 零回归。`deps.label`（cc）现状确认无消费者（2026-07-13 auto-truncate 移除时已断链，非本次改动引入），已在代码注释里如实记录。

**Files:**
- Modify: `src/lib/codec/anthropic/strategies.ts:87`（buildAnthropicStrategies body）
- Modify: `src/lib/codec/openai-cc/strategies.ts:41`、`src/lib/codec/openai-responses/strategies.ts:44`

**Interfaces:**
- Consumes: `assembleRetryStrategies`（Task 2）。
- Produces: 无新导出（三个 build 函数签名不变、内部换实现）。

- [x] **Step 1: 改 buildAnthropicStrategies 委托**

body 改为 `return assembleRetryStrategies({ clientFormat: <当前>, targetEndpoint: ENDPOINT.MESSAGES }, { attemptRef:{value:0}, originalPayload: deps.originalPayload, model: deps.model, maxRetries: deps.maxRetries, betaProbe: deps.betaProbe, resanitize: deps.resanitize }, state.retryStrategies ?? {} )`。
> 注：clientFormat 由调用方（cell）的 env 决定——`buildAnthropicStrategies` 现无 clientFormat 参，需从 deps 或调用点补传（reverse 腿 clientFormat≠anthropic 但 targetEndpoint=MESSAGES）。**改 deps 加 `clientFormat`** 或让 assembler 只按 targetEndpoint 门控（shared appliesTo 无视 clientFormat、anthropic-only 只看 targetEndpoint）——后者更简，clientFormat 仅入 ctx 备用。以 typecheck + golden 为准。
>
> **实施落定**：采用后者（assembler 只按 targetEndpoint 门控）。`config` 参数暂传 `undefined`（非 `state.retryStrategies ?? {}` —— 该字段是 Task 4 才引入的声明态，Task 3 时点尚不存在；`assembleRetryStrategies` 对 `undefined` 与 `{}` 的 `isStrategyEnabled` 判定等价，都是全默认 enabled）。

- [x] **Step 2: 改 cc + responses 委托**

`buildOpenAiCcStrategies` body → `assembleRetryStrategies({ clientFormat:"openai-cc", targetEndpoint: <当前 direct endpoint> }, {...deps, betaProbe:undefined, resanitize:undefined}, state.retryStrategies ?? {})`。responses 同法。cc/responses 的 targetEndpoint 非 MESSAGES → 只得 3 shared（golden 证）。

- [x] **Step 3: golden（Task 1）必须逐字节仍过 = 字节等价**

Run: `bun run typecheck && bun test tests/pipeline/retry-strategy-assembly.golden.it.test.ts tests/anthropic tests/openai tests/responses tests/gemini 2>&1 | tail -12`
Expected: golden 逐字节 PASS + 四格式套件零回归。**这是本 commit 的字节等价证明。** 若 golden 挂：对比 assembler 输出 vs golden 期望，定位 order/appliesTo 错位。

**实测**：golden 6/6 一次性通过（未调整任何顺序/appliesTo）；四格式套件 2145 pass/0 fail；`tests/request/retry-registry.unit.test.ts` 18 pass；全量快速档 `bun run test` 4356 pass/0 fail。

- [x] **Step 4: lint + 提交**

```bash
bunx eslint src/lib/codec/anthropic/strategies.ts src/lib/codec/openai-cc/strategies.ts src/lib/codec/openai-responses/strategies.ts
git add -- src/lib/codec/anthropic/strategies.ts src/lib/codec/openai-cc/strategies.ts src/lib/codec/openai-responses/strategies.ts
git commit -m "refactor(retry): 三 leg buildStrategies 委托声明式 assembler（字节等价）"
```

Commit hash: `1ad16ede`。

**Commit invariant**：golden 逐字节过 = 三 leg 装配序不变;driver 消费契约不变。**已验证满足。**

---

### Task 4 (Commit 4): config `retry.strategies` schema + allow+warn

**Files:**
- Modify: `src/lib/config/schema.ts`（RetryConfigSchema 加 `strategies`）
- Modify: `src/lib/state.ts`（`retryStrategies` 声明态 + applyConfigToState 接线）
- Test: `tests/config/retry-strategies.it.test.ts`（新）

**Interfaces:**
- Consumes: `assembleRetryStrategies` 读 `state.retryStrategies`。
- Produces: `state.retryStrategies: Record<string, {enabled?:boolean}>`。

- [ ] **Step 1: 写 config 测试**

```ts
test("默认全开 → golden 等价", () => { /* 无 retry.strategies → 16 策略全在 */ })
test("禁用 server_tool_rejection → 组装集少它", () => { /* config 驱动 */ })
test("未知策略键 → schema 报错", () => { /* strict */ })
test("禁用被依赖策略(token_refresh) → allow + consola.warn", () => { /* spy warn */ })
```

- [ ] **Step 2: 跑失败**

Run: `bun test tests/config/retry-strategies.it.test.ts` → FAIL。

- [ ] **Step 3: 实现**

- schema：`RetryConfigSchema` 加 `strategies: z.record(z.enum([...16 configKeys]), z.object({enabled: z.boolean().optional()}).strict()).optional()`（用 enum 键防拼写静默失效）。
- state：`retryStrategies` 声明态 + `applyConfigToState` 映射 + `resetConfigManagedState` 默认 `{}`（参 CLAUDE.md large-refactor §6 平行块加字段用 Edit + 唯一后续行、`grep -c` 对账防错位）。
- allow+warn：启动/reload 时若禁用了 shared 策略（network/serverError/tokenRefresh）→ `consola.warn`。

- [ ] **Step 4: 测试通过 + 默认 golden 仍过 + typecheck**

Run: `bun test tests/config/retry-strategies.it.test.ts tests/pipeline/retry-strategy-assembly.golden.it.test.ts && bun run typecheck`
Expected: PASS。

- [ ] **Step 5: lint + 提交**（含 config.yaml 示例 + schema.json 若有）

```bash
git add -- src/lib/config/schema.ts src/lib/state.ts tests/config/retry-strategies.it.test.ts
git commit -m "feat(retry): retry.strategies 逐策略 config 开关（opt-out + allow+warn）"
```

---

### Task 5 (Commit 5): telemetry per-strategy fire 计数 + 注册集诊断

**Files:**
- Modify: `src/lib/telemetry/*`（加 `retry_strategy_fires{strategy}` counter，按 skill `telemetry-architecture` 开放 counters bag）
- Modify: driver retry 命中点（`recordAttemptFailure` 处递增）
- Test: `tests/telemetry/retry-strategy-fires.it.test.ts`（新）

- [ ] **Step 1: 写 telemetry 测试**：策略触发 → counter 递增、维度基数。
- [ ] **Step 2: 跑失败**。
- [ ] **Step 3: 实现**：counters bag 加 `retryStrategyFires`（泛型复制器、零版本 bump，skill `telemetry-architecture` 一）;driver `createSemanticRetryPolicy` 命中 strategy 后递增 `{strategy: strategy.name}`;注册集（声明集 + enabled 态）经 `GET /api/config` 或 pipelineInfo 诊断暴露。
- [ ] **Step 4: 测试通过 + typecheck + golden 仍过**。
- [ ] **Step 5: lint + 提交** `feat(retry): per-strategy fire telemetry + 注册集诊断`。

---

### Task 6 (Commit 6): 去重收口 + 文档同步

**Files:**
- Modify: `src/lib/codec/{openai-cc,openai-responses}/strategies.ts`（删不再用的 create* import + adapt 重复——现由 registry 声明）
- Modify: `docs/DESIGN.md`（活的架构现状加/改 retry registry 行）、skill（若有 retry 相关）、RFC 状态注 landed

- [ ] **Step 1: 删三 leg 的重复 import**（typecheck 会报未用 import → 删）。
- [ ] **Step 2: typecheck + 全量 golden + 相关套件零回归**。
- [ ] **Step 3: doc-sync**（DESIGN 活的架构现状行 + 跨文档 grep）。
- [ ] **Step 4: 提交** `refactor(retry): 去重收口 + doc-sync（registry landed）`。

---

## Self-Review（对照 RFC）

- RFC §3.1 registry 契约 + deps optional + throwMissing → Task 2 ✅。
- RFC §3.2 assembler → Task 2 ✅;三 leg 委托 → Task 3 ✅。
- RFC §3.3 order 表 + appliesTo:MESSAGES + defense-in-depth → Task 2（order 常量）+ Task 1/3 golden ✅。
- RFC §3.4 config opt-out + allow+warn → Task 4 ✅。
- RFC §3.4a delegate 并存 → 无代码改动（文档已记，Task 6 doc-sync 确认）。
- RFC §3.5 可观测 history+metrics → Task 5 ✅。
- RFC §3.6 去重 → Task 6 ✅。
- RFC §5 6-commit + invariants → Task 1-6 一一对应，每 commit golden gate ✅。
- RFC §3.1 WS 边界 → Task 1 golden 测 HTTP 路径不测 WS ✅。
- **Type consistency**：`assembleRetryStrategies(ctx: RetryStrategyContext, deps: RetryStrategyDeps, config): ReadonlyArray<EnvRetryStrategy>` 全程一致;三 build 函数签名不变（内部委托）。
- **未决执行注**：Task 3 Step 1 的 clientFormat 传参（deps 加 vs assembler 只看 targetEndpoint）——实施时以 typecheck + golden 为准，倾向 assembler 只按 targetEndpoint 门控（更简）。
