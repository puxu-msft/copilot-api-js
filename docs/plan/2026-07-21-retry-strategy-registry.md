# reactive retry 策略声明式 registry Implementation Plan

> **实施状态（2026-07-22）**：**✅ 全 6 task landed master（merge `ed1a1a8f`）**。subagent-driven 执行于 worktree `feat/retry-strategy-registry`，每 task per-task 审 + whole-branch 终审 0 blocker，golden 逐字节等价全程保持。carryover 3 项记 `docs/todo/deferred-backlog.md`。权威现状见 `docs/DESIGN.md` 活的架构现状「reactive retry 策略声明式 registry」行 + RFC。

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
      "network-retry", "server-error-retry", "token-refresh", "effort-learning",
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

### Task 4 (Commit 4): config `retry.strategies` schema + allow+warn ✅ 已完成

> **实施结果**：`RETRY_STRATEGY_CONFIG_KEYS`（16 键，与 `RETRY_STRATEGY_ORDER` 平行声明，schema.ts 内联而非从 `retry-registry.ts` 导入，防止 config schema 层反向依赖业务逻辑——同 `ENDPOINT_SCOPE_VALUES` 既有惯例）+ `z.partialRecord(z.enum(...), {enabled}.strict())`（未知键单独报 `invalid_key`、可被 `cleanInvalidPaths` 定点剥离，非整段拒绝）。`state.retryStrategies`（whole-map replace，镜像 `errorSelfhealDelegate` 的既有模式）经 `setReactiveRetryConfig` 扩展（新增第二个 patch 字段，同函数）接线；三处平行块（`mutableState` 初始化 / `CONFIG_MANAGED_DEFAULTS` / `resetConfigManagedState`）+ `cloneState`/`cloneStatePatch` 均用 `Edit` + 唯一后续行定位，`grep -c 'retryStrategies' src/lib/state.ts` = 9 处、无错位重复（已核对每处上下文）。三个 `buildXxxStrategies`（Task 3 遗留的 `config: undefined`）已接回 `state.retryStrategies`。allow+warn 落在 `config.ts` 的 `warnDisabledSharedRetryStrategies`（禁用 network/serverError/tokenRefresh 三个 shared configKey 才警告，anthropic-only 禁用不警告——无跨协议 blast radius）。`tests/config/retry-strategies.it.test.ts`（新，config 文件驱动、非 `setStateForTests` 直接戳）+ `tests/config/config-hot-reload.it.test.ts` 新增一条 EXEMPT 条目（enum-keyed Record 不适配标量 FieldSpec 矩阵，同 `generation.*` 既有先例）。`tests/request/retry-registry.unit.test.ts` 补 attemptRef 共享回归测试（Task 3 reviewer 建议 2）：两条测试分别断言「同一 `assembleRetryStrategies()` 调用内多策略共享同一 attemptRef」+「两次独立调用各自拿到全新 attemptRef（无跨请求泄漏）」，用 `consola.info` spy 解析各策略实际打印的 `Attempt N/M` 行验证（行为级、非结构断言）。golden 默认（`state.retryStrategies={}`）逐字节仍过（6/6，未调整）；四格式套件 2145 pass 零回归；`bun run test`（test:fast）4358 pass（Task 3 基线 4356 + 本次新增 2 条 attemptRef 测试，零回归）；`bun test tests/config` 811 pass。`bun run typecheck` 绿；`bunx eslint`（含改动文件 + 两测试文件）无 error（`--fix` 后重新 typecheck + 重跑测试确认未破坏行为——遵循 `tooling-eslint-fix-at-autofix-breaks-types` 教训的一般性纪律）。

**Files:**
- Modify: `src/lib/config/schema.ts`（RetryConfigSchema 加 `strategies`）
- Modify: `src/lib/state.ts`（`retryStrategies` 声明态 + applyConfigToState 接线）
- Test: `tests/config/retry-strategies.it.test.ts`（新）

**Interfaces:**
- Consumes: `assembleRetryStrategies` 读 `state.retryStrategies`。
- Produces: `state.retryStrategies: Record<string, {enabled?:boolean}>`。

- [x] **Step 1: 写 config 测试**

```ts
test("默认全开 → golden 等价", () => { /* 无 retry.strategies → 16 策略全在 */ })
test("禁用 server_tool_rejection → 组装集少它", () => { /* config 驱动 */ })
test("未知策略键 → schema 报错", () => { /* strict */ })
test("禁用被依赖策略(token_refresh) → allow + consola.warn", () => { /* spy warn */ })
```

- [x] **Step 2: 跑失败**

Run: `bun test tests/config/retry-strategies.it.test.ts` → FAIL。

- [x] **Step 3: 实现**

- schema：`RetryConfigSchema` 加 `strategies: z.record(z.enum([...16 configKeys]), z.object({enabled: z.boolean().optional()}).strict()).optional()`（用 enum 键防拼写静默失效）。
- state：`retryStrategies` 声明态 + `applyConfigToState` 映射 + `resetConfigManagedState` 默认 `{}`（参 CLAUDE.md large-refactor §6 平行块加字段用 Edit + 唯一后续行、`grep -c` 对账防错位）。
- allow+warn：启动/reload 时若禁用了 shared 策略（network/serverError/tokenRefresh）→ `consola.warn`。

- [x] **Step 4: 测试通过 + 默认 golden 仍过 + typecheck**

Run: `bun test tests/config/retry-strategies.it.test.ts tests/pipeline/retry-strategy-assembly.golden.it.test.ts && bun run typecheck`
Expected: PASS。

**实测**：`retry-strategies.it.test.ts` 11 pass；golden 6/6 逐字节过；`retry-registry.unit.test.ts`（含新增 attemptRef 回归）20 pass；`config-hot-reload.it.test.ts`（含完整性守卫）361 pass；四格式套件 2145 pass；`bun run test` 4358 pass；`bun test tests/config` 811 pass。

- [x] **Step 5: lint + 提交**（含 config.yaml 示例 + schema.json 若有）

```bash
git add -- src/lib/config/schema.ts src/lib/config/config.ts src/lib/state.ts \
  src/lib/codec/anthropic/strategies.ts src/lib/codec/openai-cc/strategies.ts src/lib/codec/openai-responses/strategies.ts \
  tests/config/retry-strategies.it.test.ts tests/config/config-hot-reload.it.test.ts tests/request/retry-registry.unit.test.ts
git commit -m "feat(retry): retry.strategies 逐策略 config 开关（opt-out + allow+warn）+ attemptRef 共享回归测试"
```

**未在原计划文件清单里、但属于本 task 必需的联动改动**（如实记录）：三个 `buildXxxStrategies`（`codec/{anthropic,openai-cc,openai-responses}/strategies.ts`）接回 `state.retryStrategies`（Task 3 报告已预告的「Task 4 需改回」接线点，非范围蔓延）；`tests/config/config-hot-reload.it.test.ts` 补一条 EXEMPT 条目（新 schema 键触发既有完整性守卫，不补会让 Task 4 挂掉一条既有测试——按项目纪律「不忽略已有测试失败」处理，非新增功能）。

---

### Task 5 (Commit 5): telemetry per-strategy fire 计数 + 注册集诊断 ✅ 已完成

> **实施结果（与原计划的一处偏离，如实记录理由）**：原计划设想把 `retryStrategyFires` 并入 `request-telemetry.ts` 的 settled-request registry（`recordSettledRequest` 那套 dimension×measure 框架）。实施时发现语义不匹配：retry-fire 是**每次 attempt 失败重试决策提交**时的事件（一个请求内同一策略可连续触发多次），不是「per-settled-request 的一次性维度 key」——套用 `recordSettledRequest` 的按 (dimension,key) 去重累加模型会**低估**重复触发。故改为独立、扁平的 process-lifetime `Map<string, number>` 模块 `src/lib/observability/retry-strategy-fires.ts`（`recordRetryStrategyFire` / `getRetryStrategyFireCounts` / `resetRetryStrategyFiresForTests`），镜像既有 `anthropic/tool-input-repair-stats.ts` / `anthropic/protect-streaming-stats.ts` 的「live-observation 聚合计数器，不持久化，重启归零」模式——仍遵循 skill `telemetry-architecture` 的核心原则（开放 bag、`/metrics` 侧零版本 bump 即可新增 key），只是不寄生在 settled-request 那条特定流水线里。`/metrics` 新增单独一族 `copilot_api_retry_strategy_fires_total{strategy="..."}`（非 `(dimension,key)` 两标签形状，因 retry-fire 无 dimension 概念，故走 `renderPrometheusMetrics` 的独立新参数 + 独立发射块，非并入 measure 循环）。
>
> **命中点**：`driver.ts` 的 `createSemanticRetryPolicy`——`action.env.ctx.recordAttemptFailure({...})` 那一行**之后**立即调 `recordRetryStrategyFire(strategy.name)`，与 `recordAttemptFailure` 同一提交点（budget-accepted retry：已过 `overBudget` 门 + 已排除 `action.kind==="abort"`）。天然排除 `ws-fallback`/`rate-limit-retry`（走 `dispatch-scheduler.ts` 各自的 `recordAttemptFailure` 调用点，不经过 registry 策略 `.find(canHandle)`）与 L2 buffered-retry（`driver.ts:1299` 那条 `recordAttemptFailure({nextStrategy:"buffered-retry"})` 同理不经过本命中点）——这是**故意的范围**：本 counter 只统计 registry 声明的 16 个反应式策略实际触发，不是「全部 retry 原因」的大一统计数器（RFC §3.5 的字面意图是给 registry 治理面用的诊断，非通用 retry 遥测）。Never-throw：一次 `Map.set` 无 I/O、无外部调用，不会抛，故命中点无需 try/catch（`strategy.handle` 抛出的分支在更早的 catch 里已 return，不会走到这里）。
>
> **注册集诊断**：`retry-registry.ts` 新增 `getRetryStrategyRegistryDiagnostics(config)` → `Array<{name, configKey, order, scope, enabled}>`（16 条、按 `order` 排序，与 `assembleRetryStrategies` 的装配序一致）。`scope`（`"shared" | "messages-only"`）**由 `appliesTo` 对两个代表性 probe ctx（`MESSAGES_PROBE_CTX` / `CC_DIRECT_PROBE_CTX`）实测推导**，不是硬编码名单——防止未来 `appliesTo` 门漂移时诊断跟着一起说谎。接线进 `GET /api/config`（`routes/config/route.ts` 的 `buildEffectiveConfig`）新增字段 `retryStrategyRegistry`，喂 `state.retryStrategies` 得到实时 enabled 态（该原始 config record 本就经 `CONFIG_MANAGED_DEFAULTS` 自动派生逐字段暴露；本字段是人类可读的补充视图，非替代）。选 `GET /api/config` 而非 `pipelineInfo`：RFC §3.5 原文列了两个候选通道（"经既有 pipelineInfo 通道或 GET /api/config"），`pipelineInfo` 是**per-request** 诊断（挂在某次请求的 history entry 上），而"声明了哪些策略 + 各自 enabled 态"是**全局静态注册集视图**、与具体某次请求无关，`GET /api/config` 这个已有的"效validate 运行时配置快照"端点语义上更贴切、且已有 completeness-guard 测试基础设施可复用。
>
> **测试**：`tests/observability/retry-strategy-fires.unit.test.ts`（新，6 pass，counter 模块行为：空/累加/独立 key/快照不可变/reset）+ `tests/pipeline/driver.unit.test.ts` 新增 `describe("per-strategy retry-fire telemetry")`（5 pass：budget-accepted 递增、strategy 抛出不递增、budget-rejected 不递增、abort 不递增、多策略独立累加）+ `tests/request/retry-registry.unit.test.ts` 新增 `describe("getRetryStrategyRegistryDiagnostics")`（6 pass：16 条、字段投影、scope 探测非硬编码、undefined config 全 enabled、单条禁用、按 order 排序）+ `tests/config/config-effective-route.http.test.ts` 新增一条（`retryStrategyRegistry` 字段存在 + 形状）+ `tests/pipeline/metrics-exposition.unit.test.ts` 新增两条（`copilot_api_retry_strategy_fires_total` 计数 + 零 fire 时仍稳定发射 HELP/TYPE）。全部先跑红确认（TDD）、实现后转绿。golden（`retry-strategy-assembly.golden.it.test.ts`）6/6 逐字节仍过（未碰装配逻辑，只在 driver 消费点追加旁路调用）；`tests/pipeline tests/anthropic tests/openai tests/responses tests/observability tests/request tests/config` 合计 3852 pass / 0 fail（含新增 17 条）；`bun run typecheck` 绿；改动文件 `bunx eslint` 无 error（`src/lib/pipeline/driver.ts:1208` 与 `tests/helpers/isolated-fixture.ts` 的既有 4 条 sort-imports/prettier 告警核实为 HEAD 既有、非本次引入——`git stash` 掉本次全部改动后仍报同样错误，实测确认非我方回归）。`resetRetryStrategyFiresForTests` 已注册进 `tests/helpers/isolated-fixture.ts` 的 `RESETTERS` 表（防跨测试文件泄漏）。
>
> **`bun run test:backend` 全量**：3852+ 全绿；另有 4 条 `tests/history/v3/store*.it.test.ts` 失败——经 `git stash` 本次全部改动后**同样失败**（History V3 semantic store 的既有/环境相关失败，与 History 模块零 diff），确认与 Task 5 无关、不阻塞本次交付。

**Files:**
- New: `src/lib/observability/retry-strategy-fires.ts`（独立轻量 fire-counter，偏离原计划「并入 request-telemetry.ts」的理由见上）
- Modify: `src/lib/request/retry-registry.ts`（加 `getRetryStrategyRegistryDiagnostics`）
- Modify: `src/lib/pipeline/driver.ts`（`createSemanticRetryPolicy` 命中点递增）
- Modify: `src/lib/metrics-exposition.ts`（新增 `retry_strategy_fires_total` 族）
- Modify: `src/routes/config/route.ts`（`GET /api/config` 新增 `retryStrategyRegistry` 字段）
- Modify: `tests/helpers/isolated-fixture.ts`（RESETTERS 注册）
- Test: `tests/observability/retry-strategy-fires.unit.test.ts`（新）、`tests/pipeline/driver.unit.test.ts`、`tests/request/retry-registry.unit.test.ts`、`tests/config/config-effective-route.http.test.ts`、`tests/pipeline/metrics-exposition.unit.test.ts`（均追加）

- [x] **Step 1: 写 telemetry 测试**：策略触发 → counter 递增、维度基数。
- [x] **Step 2: 跑失败**。
- [x] **Step 3: 实现**：独立 counters bag（`retry-strategy-fires.ts`，理由见上）;driver `createSemanticRetryPolicy` 命中 strategy 后递增;注册集（声明集 + enabled 态）经 `GET /api/config` 诊断暴露。
- [x] **Step 4: 测试通过 + typecheck + golden 仍过**。
- [x] **Step 5: lint + 提交** `feat(retry): per-strategy fire telemetry + 注册集诊断`。

---

### Task 6 (Commit 6): 去重收口 + 文档同步 ✅ 已完成

> **实施结果**：Step 1 的「删三 leg 重复 import」在 Task 3 委托 assembler 时已提前完成——三个 `codec/{anthropic,openai-cc,openai-responses}/strategies.ts` 委托后只剩 `ENDPOINT`/`assembleRetryStrategies`/`state` + 必要类型 import，typecheck 全程无未用 import 报错（本 task 核实确认，无需再删）。**去重收口的实质工作是死字段清理**：核实发现 `RetrySemanticsSpec.label`（`src/lib/pipeline/cell-assembly.ts`）及其穿透的 `OpenAiCcStrategiesDeps.label`、`RetryStrategyDeps.label` 是全链路死字段——唯一历史消费者（CC 控制台日志行）随 2026-07-13 auto-truncate 移除已断链，`grep` 全仓确认无任何读取点。按 no-destructive 纪律核实无遗漏消费者后整链路删除（`cell-assembly.ts` 接口定义 + 4 处 `RETRY_SEMANTICS` 分支调用 + 4 个语义生产函数 `{anthropic,chatCompletions,responsesFallback,responsesDirect,viaResponses,anthropicReverse}RetrySemantics` + `cc-family-strategies.ts` 消费点 + `openai-cc/strategies.ts` 接口字段 + `retry-registry.ts` 的 `RetryStrategyDeps.label`，共 8 个文件的机械单行删除，typecheck 兜底捕获全部遗漏点）。**carryover 逐条处置**：见 task-6-report.md 完整记录——plan Task 1 示例块 `effort-learning-retry`→`effort-learning` 笔误修正；`/metrics` HELP 行补范围说明；三处硬编码 `ANTHROPIC_16_NAMES`/`SHARED_3_NAMES` 抽取为 `tests/helpers/retry-strategy-names.ts` 独立 fixture 消除漂移风险；`deps.label` 死字段确认删除（见上）；`SHARED_RETRY_STRATEGY_CONFIG_KEYS` parity 测试当场补做（导出该 Set + 加一条测试断言其与 `getRetryStrategyRegistryDiagnostics` 的 `scope:"shared"` 投影集合相等，低成本无取舍，未记 backlog）；13 处 payload cast 分组类型（RFC §3.1 备选）/attemptRef 日志断言脆性/retry-fire counter 无维度切面三项记 `docs/todo/deferred-backlog.md`（过度设计阈值未到或需要用户方向判断）。doc-sync：`docs/DESIGN.md`「活的架构现状」加 registry 行、`docs/API.md` 补 `/api/config` 的 `retryStrategyRegistry` 字段 + `/metrics` 的 `retry_strategy_fires_total` 族说明、本 RFC 状态注 landed。golden 6/6 逐字节仍过（`label` 删除不改变任何 `.name`/顺序输出）；`tests/anthropic tests/openai tests/responses tests/gemini tests/pipeline tests/config tests/observability tests/request` 合计 3905 pass/0 fail（1 todo 无关，含新增 parity 测试）；`bun run test:backend` 6058 pass/4 fail（4 条 History V3 semantic store 失败经 `git stash` 干净基线复现同样失败，确认 pre-existing、与本次改动无关）；`bun run typecheck` 绿；改动文件 `bunx eslint` 无 error（`--fix` 后重跑 typecheck + 全部相关测试确认未破坏行为）。

**Files:**
- Modify: `src/lib/codec/{openai-cc,openai-responses}/strategies.ts`（删不再用的 create* import + adapt 重复——现由 registry 声明）
- Modify: `docs/DESIGN.md`（活的架构现状加/改 retry registry 行）、skill（若有 retry 相关）、RFC 状态注 landed

- [x] **Step 1: 删三 leg 的重复 import**（typecheck 会报未用 import → 删）。**实测**：Task 3 委托时已提前清理，本 task 核实确认零残留。
- [x] **Step 2: typecheck + 全量 golden + 相关套件零回归**。
- [x] **Step 3: doc-sync**（DESIGN 活的架构现状行 + 跨文档 grep）。
- [x] **Step 4: 提交** `refactor(retry): 去重收口 + doc-sync（registry landed）`。

---

## Self-Review（对照 RFC）

- RFC §3.1 registry 契约 + deps optional + throwMissing → Task 2 ✅。
- RFC §3.2 assembler → Task 2 ✅;三 leg 委托 → Task 3 ✅。
- RFC §3.3 order 表 + appliesTo:MESSAGES + defense-in-depth → Task 2（order 常量）+ Task 1/3 golden ✅。
- RFC §3.4 config opt-out + allow+warn → Task 4 ✅。
- RFC §3.4a delegate 并存 → 无代码改动（文档已记，Task 6 doc-sync 确认）。
- RFC §3.5 可观测 history+metrics → Task 5 ✅。
- RFC §3.6 去重 → Task 6 ✅（Task 3 提前完成 import 去重 + Task 6 补做 `label` 死字段整链路删除）。
- RFC §5 6-commit + invariants → Task 1-6 一一对应，每 commit golden gate ✅。
- RFC §3.1 WS 边界 → Task 1 golden 测 HTTP 路径不测 WS ✅。
- **Type consistency**：`assembleRetryStrategies(ctx: RetryStrategyContext, deps: RetryStrategyDeps, config): ReadonlyArray<EnvRetryStrategy>` 全程一致;三 build 函数签名不变（内部委托）。
- **未决执行注**：Task 3 Step 1 的 clientFormat 传参（deps 加 vs assembler 只看 targetEndpoint）——实施时以 typecheck + golden 为准，倾向 assembler 只按 targetEndpoint 门控（更简）。**实施落定**：assembler 只按 targetEndpoint 门控（见 Task 3 报告）。
