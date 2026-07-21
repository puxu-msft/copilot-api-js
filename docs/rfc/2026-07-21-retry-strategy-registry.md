# RFC：reactive retry 策略声明式 registry

- **日期**：2026-07-21
- **状态**：草案（待 ≥3 轮对抗审 → 用户审 open questions → plan）
- **类型**：大重构（内部治理，仿 v4 rewrite-registry）
- **关联**：v4 rewrite-registry（`docs/v4/03-spec/rewrite-registry.md`，同款治理的先例）、skill `telemetry-architecture`、`large-refactor`；上游探索 spec `docs/spec/2026-07-20-inbound-system-prompt-dispatch-hook.md`（该探索定位「retry 策略是最大未插件化区」，本 RFC 是其下一独立项）

## 1. 问题陈述 + 债务清单（带 file:line 证据）

reactive retry 策略**已经是模块化单元**（每个 `createXxxStrategy()` → `EnvRetryStrategy`：`name`/`canHandle(error)`/`handle(error,env)`/`onResolved`，各自封装 matcher+修法+反应式学习）。缺的是 rewrite-registry 当年得到的**治理层**。具体债务：

1. **per-leg 硬编码有序数组**：`buildAnthropicStrategies`（[anthropic/strategies.ts:87](../../src/lib/codec/anthropic/strategies.ts#L87)，16 策略）、`buildOpenAiCcStrategies`（[openai-cc/strategies.ts:41](../../src/lib/codec/openai-cc/strategies.ts#L41)，3）、`buildOpenAiResponsesStrategies`（[openai-responses/strategies.ts:44](../../src/lib/codec/openai-responses/strategies.ts#L44)，3）。顺序 = 数组位置。
2. **重叠 matcher 顺序靠注释维护**（[anthropic/strategies.ts:97-106](../../src/lib/codec/anthropic/strategies.ts#L97)）：tool-field → body-field → cache-control 三者都 match `Extra inputs are not permitted`，靠数组位置 + 注释保 defense-in-depth。**正是 rewrite-registry 当年治的病**（`RESPONSE_REWRITE_ORDER` 把「注释维护硬顺序」换成声明式 `order` 契约）。
3. **跨 leg 重复**：network/server-error/token-refresh 三 leg 各自 import + `adapt()` 列一遍（cc/responses = 仅这 3；anthropic = 这 3 + 13 个 400-class）。
4. **无逐策略 config 开关**：[RetryConfigSchema](../../src/lib/config/schema.ts#L844) 只有 `max_reactive_retries`（全局 cap）。16 策略全 or 无、不能单独禁用。
5. **无统一注册集可观测**：driver `recordAttemptFailure({nextStrategy})`（[context/types.ts:739](../../src/lib/context/types.ts#L739)）已记「哪个触发」，但无「声明了哪些策略 / per-strategy fire 计数」的视图。

**driver 消费现状**（[driver.ts:538](../../src/lib/pipeline/driver.ts#L538)，`createSemanticRetryPolicy`）：每请求 resolve 一次策略数组（在 CandidateStateFactory fork `env.requestState` 后，closures 绑 candidate supplies）→ `.find(canHandle)` **首命中** → `handle(error,env)` → budget 双闸（`action.learning ? learningRetries++>=maxLearningRetries : normalRetries++>=maxRetries`）→ `onResolved` post-success。**顺序决定谁认领重叠错误。**

## 2. 目标（用户已定，4 全选 + 内部 registry）

① 声明式 registry + 声明 order ② 逐策略 config 开关 ③ 统一可观测 ④ 跨 leg 去重。**纯内部治理**（不对外暴露公共契约 / 用户自供策略——列 backlog，见 §9）。

**硬约束**：行为**字节等价**——每 leg 组装出的策略数组（顺序 + 实例行为）与现状逐字节一致（golden 锁，§7）。

## 3. 架构

### 3.1 registry 条目契约

```ts
// src/lib/request/retry-registry.ts (新)
interface RetryStrategyEntry {
  readonly name: string
  readonly order: number                    // 声明式装配序,替代数组位置
  appliesTo(ctx: RetryStrategyContext): boolean   // leg 门控 → 跨 leg 去重
  readonly configKey: string                // config 开关键(retry.strategies.<configKey>)
  /** per-request 工厂:拿 deps 造策略实例(payload 或 native env)。 */
  create(deps: RetryStrategyDeps): PayloadOrEnvStrategy
}
```

- **`RetryStrategyContext`**：`{ clientFormat, targetEndpoint }`（appliesTo 据此门控——shared 三个 return true 全 leg;anthropic-only return `targetEndpoint===MESSAGES`）。
- **`RetryStrategyDeps`**：现有 per-request 闭包并集 `{ attemptRef, originalPayload, resanitize, model, maxRetries, betaProbe }`（现在散在三个 `buildXxxStrategies` 的 deps 里，统一成一个 bundle）。
- **payload vs native**：`create` 返回二者之一;registry 元数据标 `kind: "payload" | "env"`（assembler 对 payload kind 套 `adaptPayloadStrategy`、native 直用）。承接现状（poisoned-thinking 是 native、读 `env.ctx`）。

### 3.2 assembler（替换三个 buildXxxStrategies）

```ts
function assembleRetryStrategies(ctx, deps, config): ReadonlyArray<EnvRetryStrategy> {
  return RETRY_STRATEGY_REGISTRY
    .filter((e) => e.appliesTo(ctx) && isStrategyEnabled(config, e.configKey))  // appliesTo ∧ config
    .sort((a, b) => a.order - b.order)                                          // 声明式 order
    .map((e) => instantiate(e, deps))                                           // create + (payload→adapt)
}
```

三个 `buildXxxStrategies` 全部改为**薄封装**调 `assembleRetryStrategies(ctx, deps, config)`（cell 接线 `cell.n(env)` 不变、内部换实现）。

### 3.3 声明 order（编码现状 defense-in-depth）

单一 `RETRY_STRATEGY_ORDER` 常量（仿 `RESPONSE_REWRITE_ORDER`）。按现状 anthropic 数组序赋值，shared 取最低段：

| order | strategy | appliesTo | configKey |
|---|---|---|---|
| 100 | network-retry | all | network |
| 200 | server-error-retry | all | serverError |
| 300 | token-refresh | all | tokenRefresh |
| 400 | effort-learning | anthropic | effortLearning |
| 410 | tool-field-rejection | anthropic | toolFieldRejection |
| 420 | body-field-rejection | anthropic | bodyFieldRejection |
| 430 | cache-control-subfield-rejection | anthropic | cacheControlSubfield |
| 440 | legacy-thinking | anthropic | legacyThinking |
| 450 | adaptive-thinking-rejection | anthropic | adaptiveThinkingRejection |
| 460 | poisoned-thinking（native） | anthropic | poisonedThinking |
| 470 | unsupported-beta | anthropic | unsupportedBeta |
| 480 | server-tool-rejection | anthropic | serverToolRejection |
| 490 | structured-outputs-rejection | anthropic | structuredOutputsRejection |
| 500 | system-reject | anthropic | systemReject |
| 510 | web-search-not-found | anthropic | webSearchNotFound |
| 520 | deferred-tool | anthropic | deferredTool |

410/420/430 的 10-step 间距 = defense-in-depth（tool-field < body-field < cache-control）显式编码。golden 锁每 leg 组装出的 `name[]` 顺序。

### 3.4 config 开关（opt-out、enabled-only）

```yaml
retry:
  max_reactive_retries: 5      # 现状,不动
  strategies:                  # 新,全可选,缺省 = 启用(保现状)
    server_tool_rejection: { enabled: false }
```

- **只 `enabled` bool**（用户决策 1）——**不**开放 order override（order 是正确性契约、非用户可调）。
- **默认全开**——`isStrategyEnabled` 缺省 true，保字节等价（未配 = 现状 16 策略全在）。
- **allow + warn**（用户决策 2）——禁用被依赖的策略（如 token-refresh）允许,但启动/reload 时 `consola.warn` 提示潜在后果（internal-tool 姿态，绝不阻塞）。
- schema：`retry.strategies` 是 `Record<configKey, {enabled?:boolean}>`,strict、未知键报错（防拼写静默失效）。

### 3.5 可观测（history + metrics，用户决策 3）

- **history**：现有 `recordAttemptFailure({nextStrategy})` 不动（已记触发者）。补：注册集（声明了哪些 + 各自 enabled 态）作诊断，经既有 pipelineInfo 通道或 `GET /api/config` 暴露声明态。
- **metrics（telemetry）**：新增 per-strategy fire 计数维度——按 skill `telemetry-architecture`（开放 counters bag + 泛型复制器，**零版本 bump**）加 `retry_strategy_fires{strategy}` counter，在 driver retry 命中点 `recordAttemptFailure` 处递增。契合 telemetry-registry「聚合后不可重算的因子拆最细」。

### 3.6 跨 leg 去重

shared 三策略在 registry 声明**一次**（`appliesTo: () => true`）;anthropic-only 13 个 `appliesTo: (ctx) => ctx.targetEndpoint === ENDPOINT.MESSAGES`。三个 `buildXxxStrategies` 的重复 import + adapt 消除（净删）。

## 4. 依赖方向

`retry-registry.ts`（新，声明集 + assembler + order 常量 + config 判定）← 被三个 `codec/*/strategies.ts` 消费。registry 只 import 各 `create*Strategy` 工厂（已存在）+ `adaptPayloadStrategy` + config `state`。不反向依赖 codec。driver 消费点（`resolveExchangeStrategies` / `createSemanticRetryPolicy`）**不变**（仍拿 `ReadonlyArray<EnvRetryStrategy>`）。

## 5. Cutover 计划（按 commit + commit invariants）

**Commit invariant（全程）**：每 commit 结束时，三个 leg 经 `cell.n(env)` 产出的策略数组**与现状字节等价**（golden 锁），driver 消费契约不变。中间态绝不半坏。

- **Commit 1**：golden 预捕——`tests/pipeline/retry-strategy-assembly.golden.it.test.ts` 锁三 leg（anthropic/cc/responses）当前组装出的 `name[]` 顺序 + 每策略 canHandle 对代表性 error 的判定。**在改动前的 HEAD 上跑通**（锁定现状）。
- **Commit 2**：加 `retry-registry.ts`（契约 + order 常量 + 声明集 + assembler），**不接线**（纯新增、零消费者）。单测 assembler filter/sort/appliesTo。
- **Commit 3**：三个 `buildXxxStrategies` 改为委托 `assembleRetryStrategies`（default config = 全开）。golden（commit 1）**必须仍逐字节通过** = 字节等价证明。
- **Commit 4**：config `retry.strategies` schema + `isStrategyEnabled` + allow+warn。测试禁用某策略 → 组装集少它 + warn;默认全开 golden 仍过。
- **Commit 5**：telemetry per-strategy fire counter + 注册集诊断暴露。测试 fire 计数递增。
- **Commit 6**：删三个 leg 的重复 import/adapt（去重收口）+ 文档同步（DESIGN.md 活的架构现状行 + skill）。

每 commit 后跑 golden + `bun test tests/pipeline tests/anthropic tests/openai tests/responses` + typecheck。

## 6. 关键设计风险（RFC 自审 + 待对抗审重点核）

- **首命中 × 声明 order**：driver 是 `.find(canHandle)` 首命中，order 决定重叠 matcher 认领序。golden 必须锁**组装后的顺序**（非仅集合），否则 sort 稳定性/order 赋值错会静默改认领。
- **per-request deps + 声明式 create**：`create(deps)` 每请求实例化（承现状 per-request factory + attemptRef 共享计数器）——registry 条目是**工厂声明**非静态实例，assembler 每请求 create。须核实 attemptRef 共享语义（一个 ref 传给一请求所有策略）在 registry 下不破。
- **payload vs native 混合**：poisoned-thinking native（读 env.ctx.onResolved）——registry `kind` 标记 + assembler 分支;别 adapt 它（会丢 env.ctx）。
- **config reload 生命周期**：`retry.strategies` 是声明态,`assembleRetryStrategies` 每请求读 config——热重载改开关下一请求生效（对齐既有 config 语义,别绑 artifact 生命周期）。

## 7. 验证（golden 字节等价为硬 gate）

- **golden（commit 1 预捕，改动前锁）**：三 leg 组装 `name[]` 顺序 + canHandle 判定矩阵。commit 3/4（默认）后**逐字节仍过** = 行为等价（[[feedback-byte-equivalence-is-proxy-calibrate-by-consumer]]：真 invariant = driver 拿到的策略序列无可观测变化）。
- **assembler 单测**：filter(appliesTo ∧ enabled) + sort(order) + payload/native 分支。
- **config 测**：禁用/未知键/allow+warn;默认全开等价。
- **telemetry 测**：per-strategy fire counter 递增、维度基数。
- **回归**：现有全套 retry/reactive-learning 测试（`tests/**` 含 reactive-retry-leg、negotiation）零新增失败——反应式学习 onResolved 链不变。

## 8. 范围外

- **用户自供自定义 retry 策略**（公共契约 + loader + 安全姿态）→ backlog（本 RFC 是其内部地基）。
- **order 用户可调**（决策 1：只 enabled）。
- **策略逻辑本身改动**（matcher/修法/学习）——纯搬装配层,策略实现零改。
- **payload↔env adapter 重写**——复用现有 `adaptPayloadStrategy`。

## 9. Open Questions（用户已答，记录）

1. config 粒度 → **只 enabled**（order 码定）。
2. 禁用被依赖策略 → **allow + warn**。
3. 可观测面 → **history（现有 recordAttemptFailure）+ telemetry metrics（per-strategy fire 计数）**。

## 10. 未采纳备选（记录以免复议）

- **保留 per-leg 硬编码数组、只加 config filter**：不解决「注释维护顺序」「跨 leg 重复」「无声明 order 契约」——治标。否。
- **把 retry 塞进现有 rewrite-registry**：形状不同（跨 attempt 决策 vs 单次 transform、canHandle 首命中 vs 全 apply），强并会污染两个契约。否——独立 registry。
