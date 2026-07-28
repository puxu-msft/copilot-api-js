# 反应式 per-model 上游拒绝协商 —— 实施计划

> **实施状态（2026-07-07）：** ✅ **全部 P1–P4 已合并 master**（P1 `3de64acd`、P2 `1cd3927c`、P4 `dd8eeb54`、P3 `63f593d4`；逐 Task subagent review + 各 phase whole-branch opus review 均判 READY，合并后组合套件 2421 pass/0 fail、typecheck+lint 绿）。缺口 A/B/C/D/E/G/H 全落地，**F 按 O3 golden-first 门槛暂缓**（真实 425MB History 语料无 max_tokens/Vertex 变体 body，见 [docs/todo/deferred-backlog.md](../../todo/deferred-backlog.md)）。冻结设计事实源 = [RFC](../../rfc/2026-07-07-reactive-upstream-rejection-negotiation.md)。


> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐 Task 实施。步骤用 checkbox（`- [ ]`）跟踪。本项目纪律见 [项目 CLAUDE.md](../../../CLAUDE.md) 与 [prompts/README.md](prompts/README.md) 的「集中红线」；本文档是唯一 how-to 事实源，冻结的设计事实源是 [RFC](../../rfc/2026-07-07-reactive-upstream-rejection-negotiation.md)。

**Goal:** 补全本项目「反应式 per-model 上游拒绝协商」框架的覆盖缺口 A–H，让原本永久 400、零反应式恢复的请求（inline `role:"system"`、effort 零支持、web_search-not-found、partner-feature / server-tool 变体、token-limit 变体、deferred-tool 双层包裹、失败 attempt body 未持久化）自愈或可事后审计。

**Architecture:** 复用现有三支柱——per-model config 孪生（`per-model-config.ts`）、持久 negotiation 缓存（`feature-negotiation.ts`）、v4 driver 的 env-based reactive strategy（`pipeline/driver.ts` S4 retry loop）。新增一个**通用反应式拒绝 strategy primitive**（parse→mark→remediate 脚手架），A/C 用「learn → `getResanitize(originalPayload)` 重跑 S3 → 重试」remediation，D/E 用「strip / prepareHints」remediation，B 走 prepare 层独立 `effortUnsupported` 集（不经 strategy remediation 改动）。判别轴一律 key 在 `resolveModelName` 的**最终 outbound 名**上。

**Tech Stack:** TypeScript（严格）+ Bun test（`bun:test`）+ Zod 配置校验 + v4 pipeline（codec/driver/strategy）+ SQLite History。运行时 Bun 与 Node 双支持。

---

## Global Constraints（每个 Task 隐含包含）

从 RFC + 项目 CLAUDE.md 逐字提取的项目级硬约束，每条一行：

- **能力框架非硬断言。** per-model「拒绝 inline system」是**观测症状**、不是 vertex 硬断言；config 键 / state 集 / 学入日志按观测症状命名，注释写「Vertex 是此账号已知成因，但不硬断言」。学入日志如实写「推断」。
- **判别轴 = 最终 outbound 名。** 一切 per-model 判别 key 在 `resolveModelName(clientModel)` 的返回名（wireBody.model = resolvedName，见 [codec.ts:281](../../../src/lib/codec/anthropic/codec.ts#L281)），**绝不** key 在 inbound 别名（`haiku`）上。
- **归一化匹配。** 模型名匹配一律经 `normalizeForMatching`（lowercase + `.`→`-`，[model-name.ts:16](../../../src/lib/models/model-name.ts#L16)）。config 侧默认 `[claude-sonnet-4.6, claude-haiku-4.5]` 靠 `normalizeForMatching("claude-haiku-4.5")="claude-haiku-4-5" ⊂ "claude-haiku-4-5-20251001"` 匹配真实 resolved 名。
- **喂 pre-S3 baseline 是正确性硬约束（O6）。** A/C 的 `getResanitize` 必须喂 `context.originalPayload`（= `codec.getTruncateBaseline()`，pre-S3 baseline，只过了 `preprocessAnthropicMessages`），**绝不**喂 already-S3 的 `currentPayload`——会 double-apply 整条 rewrite 链。镜像唯一先例 auto-truncate（[auto-truncate.ts:101](../../../src/lib/request/strategies/auto-truncate.ts#L101)）。
- **negotiation 缓存 All entries are permanent。** 学入即持久，跨重启存活（[feature-negotiation.ts:5-7](../../../src/lib/anthropic/feature-negotiation.ts#L5)）。新的成员集（`systemRejectModels` / `effortUnsupported`）持久化为**顶层 `Array<modelKey>`**——1 级集、永不存空数组、snapshot/load 对称平凡，碰撞按构造消失（**非** sibling 的 `Record<key, Array>` 2 级形状）。
- **反应式 strategy 零副作用。** 每个 reactive strategy 只在其目标 400 上 `canHandle=true`，对其他请求零副作用；per-instance `attempted` one-shot 守卫（strategy 每请求 factory 新建）。
- **richest-data-flow。** 后端完整存（H 的失败 body 永不为「无消费者」裁剪——它正是学习依据）；合成/注入数据打可辨识标记。→ ADR [richest-data-flow](../../decisions/2026-07-05-richest-data-flow.md)。
- **internal-tool-security-posture。** 全量暴露，绝不为「信息泄露」阻塞；但不豁免真实安全缺陷。→ ADR [internal-tool-security-posture](../../decisions/2026-07-05-internal-tool-security-posture.md)。
- **无向后兼容负担。** 破坏性改动是长远正确形状时可强制迁移；不留双轨包袱。

---

## Factory / 锚点表（现有函数 file:line，实施前逐个 Read 核实）

实施者只看自己 Task，此表是学习邻接命名 / 类型的唯一入口。**所有行号以实施时 `Read` 的实际文件为准**（并发会话可能已移动行号，用符号名 grep 定位）。

### 核心框架

| 符号 | 位置 | 职责 |
|---|---|---|
| `executeRequestPipeline` 的 v4 版 = `runExchange` | [pipeline/driver.ts:240](../../../src/lib/pipeline/driver.ts#L240) | S4 retry loop：每 attempt 重跑 `prepareWire`（S4），**不重跑 S3 rewrites**；失败→首个 `canHandle` strategy→`env.with(action.env)` |
| `runRewriteIn`（S3） | [pipeline/driver.ts:166](../../../src/lib/pipeline/driver.ts#L166) | 在 retry loop **外**跑一次 request rewrites（含 anthropic-sanitize order 300）|
| `RetryStrategy` / `RetryAction` / `RetryContext` / `PrepareHints` | [request/pipeline.ts:157/118/69/91](../../../src/lib/request/pipeline.ts#L157) | legacy payload-based strategy 契约 |
| `adaptLegacyStrategy` | [pipeline/legacy-strategy-adapter.ts:64](../../../src/lib/pipeline/legacy-strategy-adapter.ts#L64) | legacy strategy→env strategy；`context.originalPayload = deps.originalPayload`（= truncate baseline），`context.model`，`meta` 后置 onMeta |
| `buildAnthropicStrategies` | [codec/anthropic/strategies.ts:82](../../../src/lib/codec/anthropic/strategies.ts#L82) | 有序 strategy 工厂；deps 有 `originalPayload`（= `codec.getTruncateBaseline()`）+ `resanitize`（= `codec.getResanitize()`）+ `model` + `betaProbe` |
| `codec.getResanitize` / `getTruncateBaseline` | [codec/anthropic/codec.ts:189/180](../../../src/lib/codec/anthropic/codec.ts#L189) | resanitize = `(p)=>runAnthropicPayloadRewrites(p,{toolNameMapper}).sanitizeResult`（返回 `FullSanitizeResult`，有 `.payload` + `.stats`）；baseline = pre-S3 payload |
| `AnthropicSanitizeFn` | `~/lib/anthropic/pipeline` | `(p: MessagesPayload) => FullSanitizeResult` |
| `runAnthropicPayloadRewrites` | [payload-rewrites.ts:150](../../../src/lib/anthropic/payload-rewrites.ts#L150) | 跑整条链（tool-preprocess 100 → tool-name 200 → sanitize 300），返回 `{payload, sanitizeResult}` |
| `recordRetryPipelineStateV4` | [handler-v4.ts:595](../../../src/routes/messages/handler-v4.ts#L595) | onMeta 消费 `meta.sanitization as SanitizationStats` 追加 retry pipeline-info |

### A（inline role:system）锚点

| 符号 | 位置 | 用途 |
|---|---|---|
| `sanitizeInlineSystemMessages` | [sanitize/system-messages.ts:102](../../../src/lib/anthropic/sanitize/system-messages.ts#L102) | 纯函数，mode 显式传入；幂等（[:107-108](../../../src/lib/anthropic/sanitize/system-messages.ts#L107)）|
| `SystemMessagesSanitizeMode` | [sanitize/system-messages.ts:26](../../../src/lib/anthropic/sanitize/system-messages.ts#L26) | `false \| drop_invalid \| merge \| as_user \| as_assistant` |
| `sanitizeAnthropicMessages` 内 inline-system 调用 | [sanitize/index.ts:95](../../../src/lib/anthropic/sanitize/index.ts#L95) | 当前 `state.systemMessagesSanitize`；改为按 `payload.model` 算有效模式 |
| count-tokens inline-system 调用 | [count-tokens.ts:50](../../../src/routes/messages/count-tokens.ts#L50) | 当前 `state.systemMessagesSanitize`；改为**无条件**非 false 模式 |
| `markAnthropicPartnerFeatureUnsupported` / `snapshotSetMap` / `loadSetMap` | [feature-negotiation.ts:208/235/287](../../../src/lib/anthropic/feature-negotiation.ts#L208) | 学入 mark + 持久化模板（2 级 Record）；A 用 1 级 Array 变体 |
| `system_messages_sanitize` schema | [config/schema.ts:270](../../../src/lib/config/schema.ts#L270) | 新键 `system_reject_models` / `system_reject_mode` 的模板 |
| `system_messages_sanitize` apply | [config/config.ts:534](../../../src/lib/config/config.ts#L534) | `setAnthropicBehavior` 模板 |
| `systemMessagesSanitize` state 5 站点 | state.ts 352/966/1178/1299/1431 | 标量 state field 的镜像模板 |

### B（effort 零支持）锚点

| 符号 | 位置 | 用途 |
|---|---|---|
| `parseInvalidEffortError` | [request-preparation.ts:572](../../../src/lib/anthropic/request-preparation.ts#L572) | 双正则（`by model X;` + `supported values:[...]`）；零支持变体两者皆无→返 null |
| `learnEffortsFromError` | [request-preparation.ts:598](../../../src/lib/anthropic/request-preparation.ts#L598) | strategy 默认 learn；扩加零支持分支 |
| `clampEffortLevel` | [request-preparation.ts:728](../../../src/lib/anthropic/request-preparation.ts#L728) | prepare 步（S4，每 attempt 重跑）；顶部加 `isEffortUnsupported` 前置剥除 |
| `findSupportedEfforts` | [request-preparation.ts:638](../../../src/lib/anthropic/request-preparation.ts#L638) | 只被 `clampEffortLevel` 消费 |
| `createEffortLearningRetryStrategy` | [effort-learning-retry.ts:50](../../../src/lib/request/strategies/effort-learning-retry.ts#L50) | `handle` 逻辑不变（learn→retry→re-prep 剥除）|
| `snapshotEffortMap` / `loadEffortMap` | [feature-negotiation.ts:243/298](../../../src/lib/anthropic/feature-negotiation.ts#L243) | 空集丢失的 2 处（B 用独立集绕过，**不动** `supportedEfforts`）|
| `NegotiationStateFile` | [feature-negotiation.ts:225](../../../src/lib/anthropic/feature-negotiation.ts#L225) | 加 `effortUnsupported`/`systemRejectModels` 顶层 Array 字段 |

### C/D/E/F/G/H 锚点（P2–P4，详见对应 Task）

| 符号 | 位置 | 相关缺口 |
|---|---|---|
| `rewriteServerToolHistory` | [sanitize/rewrite-server-tool-history.ts:123](../../../src/lib/anthropic/sanitize/rewrite-server-tool-history.ts#L123) | C（既有 downgrade 机制；改为按 model 算有效模式）|
| `sanitizeAnthropicMessages` 内 server-tool-history 调用 | [sanitize/index.ts:104](../../../src/lib/anthropic/sanitize/index.ts#L104) | C（当前 `state.rewriteHistoryServerTools`）|
| `createServerToolRejectionStrategy` | [server-tool-rejection-retry.ts:58](../../../src/lib/request/strategies/server-tool-rejection-retry.ts#L58) | E（硬编码 web_search → 表驱动，迁到 primitive）|
| `createStructuredOutputsRejectionStrategy` / `parseDisallowedPartnerFeature` | [structured-outputs-rejection-retry.ts:113/95](../../../src/lib/request/strategies/structured-outputs-rejection-retry.ts#L113) | D（canHandle 只放行 structured_outputs → 表驱动）|
| `stripUnsupportedStructuredOutputs` | [request-preparation.ts:698](../../../src/lib/anthropic/request-preparation.ts#L698) | D（prepare 侧 strip 站点之二）|
| `parseTokenLimitError` | [error/parsing.ts:2](../../../src/lib/error/parsing.ts#L2) | F（2 条正则 → 加 golden-first 变体）|
| `classifyHTTPError` 400→token_limit 分支 | [error/classify.ts:203](../../../src/lib/error/classify.ts#L203) | F |
| `parseToolReferenceFromResponse` | [deferred-tool-retry.ts:169](../../../src/lib/request/strategies/deferred-tool-retry.ts#L169) | G（`if(!message) return null` → `parsed.error?.message ?? responseText`）|
| `AttemptSnapshot.error` | [observability/events.ts:115](../../../src/lib/observability/events.ts#L115) | H（加 `rawBody`/`responseText`）|

---

## Phase DAG（来自 RFC §4）

```
P1 (primitive + A + B) ──┬── P2 (C)
   [承重, 前置]           ├── P3 (D / E / F / G)   ← 内部各子项格式独立可并行；F 须 golden-first
                          └── P4 (H)
```

- **P1 是其余前置**：抽出的 `createReactiveRejectionStrategy` primitive 被 P2（C）、P3（D/E）复用；`systemRejectModels` 的持久化 + 有效模式解析模式被 C 复用。
- **P2/P3/P4 在 P1 后可并行**。P3 内部 D/E/F/G 格式独立、可并行；**F 强制 golden-first**（先捕获真实上游 token-limit body 做 golden，捕不到就不做，见 P3 Task F）。
- 每 phase 独立可交付、独立可测；每 commit 终态 typecheck 绿 + 测试通过 + 无「给要拒的请求白做/重复处理」半破碎态。

---

# P1 —— 框架 primitive + A + B（承重，最重）

**交付物：** 通用反应式拒绝 strategy primitive（unit-tested）；A 全套（config schema + state + `systemRejectModels` negotiation 集 + 有效模式在 sanitize/count-tokens 内从 `payload.model` 算 + 反应式 strategy via getResanitize + meta.sanitization 回传）；B 全套（独立 `effortUnsupported` 集 + 零支持 parse 分支 + clamp 前置剥除 + persist→reload golden）。

**Commit invariants（每 commit 终态）：**
- typecheck 绿（`bun run typecheck`）+ 相关测试通过。
- A：reject 集模型 outbound 无 `role:"system"` + 上游 200；非 reject 模型透传（除非全局 `system_messages_sanitize` 开）；反应式 mock 首发 400（`Unexpected role "system"`）→ 学入 `systemRejectModels` + `getResanitize(originalPayload)` + 重试已清洗。
- B：mock `does not support reasoning effort` 400 → 学入「已知不支持」+ 重试 outbound 无 `output_config.effort`；**persist→reload golden**（学入→snapshot 写盘→load 重载→重准备仍剥除）。
- 每 strategy 用**正样本证 canHandle 触达目标**（先证正则匹配真实错误串）。

---

### Task 1: 反应式拒绝 strategy primitive

抽出 A/C/D/E 共享的「parse→one-shot 守卫→mark→remediate」脚手架。remediation 分两类（RFC WARN-7）：A/C 是 `getResanitize` 重跑（re-sanitize arm），D/E 是 strip/prepareHints——primitive 统一 parse/mark/canHandle/one-shot，remediation 由调用方注入。

**Files:**
- Create: `src/lib/request/strategies/reactive-rejection.ts`
- Test: `tests/pipeline/reactive-rejection.unit.test.ts`

**Interfaces:**
- Consumes: `RetryStrategy` / `RetryAction` / `RetryContext` from [request/pipeline.ts:157](../../../src/lib/request/pipeline.ts#L157)；`ApiError` from `~/lib/error`。
- Produces:
  ```ts
  export interface ReactiveRejectionConfig<TPayload extends { model: string }> {
    /** Strategy name (also the log/telemetry label). */
    name: string
    /**
     * Parse the capability token from the error, or null when this isn't our
     * error class. MUST be positive-sample proven (a test that feeds the real
     * upstream error string and asserts a non-null token). Only inspects
     * bad_request/400 (the primitive gates status before calling this).
     */
    match(error: ApiError): string | null
    /** Persist the learned (model, token) to the negotiation cache (idempotent). */
    mark(model: string, token: string): void
    /**
     * Build the retry action AFTER mark ran. `token` is match()'s non-null result.
     * Re-sanitize arm: return retry with resanitize(context.originalPayload).payload.
     * Strip arm: return retry with a stripped payload / prepareHints.
     */
    remediate(args: { error: ApiError; payload: TPayload; token: string; context: RetryContext<TPayload> }): RetryAction<TPayload>
  }
  export function createReactiveRejectionStrategy<TPayload extends { model: string }>(
    cfg: ReactiveRejectionConfig<TPayload>,
  ): RetryStrategy<TPayload>
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/pipeline/reactive-rejection.unit.test.ts
import { describe, expect, test } from "bun:test"

import type { ApiError } from "~/lib/error"
import type { RetryContext } from "~/lib/request/pipeline"

import { HTTPError } from "~/lib/error"
import { createReactiveRejectionStrategy } from "~/lib/request/strategies/reactive-rejection"

interface P { model: string; [k: string]: unknown }

const ctx: RetryContext<P> = { attempt: 0, maxRetries: 3, originalPayload: { model: "m" }, model: undefined }

function err(body: string): ApiError {
  return { type: "bad_request", status: 400, message: "HTTP 400", raw: new HTTPError("boom", 400, body, "m") }
}

function make(overrides?: Partial<Parameters<typeof createReactiveRejectionStrategy<P>>[0]>) {
  const marks: Array<[string, string]> = []
  const strategy = createReactiveRejectionStrategy<P>({
    name: "test-reactive",
    match: (e) => (e.raw instanceof HTTPError && e.raw.responseText.includes("TOKEN") ? "cap-x" : null),
    mark: (model, token) => marks.push([model, token]),
    remediate: ({ payload, token }) => ({ action: "retry", payload, meta: { token } }),
    ...overrides,
  })
  return { strategy, marks }
}

describe("createReactiveRejectionStrategy", () => {
  test("name is passed through", () => {
    expect(make().strategy.name).toBe("test-reactive")
  })

  test("canHandle: true only for 400 bad_request whose match() is non-null", () => {
    const { strategy } = make()
    expect(strategy.canHandle(err("has TOKEN here"))).toBe(true)
    expect(strategy.canHandle(err("unrelated"))).toBe(false)
    expect(strategy.canHandle({ ...err("has TOKEN"), status: 500, type: "server_error" })).toBe(false)
  })

  test("handle: marks (model, token) then remediates", async () => {
    const { strategy, marks } = make()
    const res = await strategy.handle(err("TOKEN"), { model: "claude-x" }, ctx)
    expect(res.action).toBe("retry")
    expect(marks).toEqual([["claude-x", "cap-x"]])
    expect((res as { meta: { token: string } }).meta.token).toBe("cap-x")
  })

  test("one-shot: canHandle false after one handle", async () => {
    const { strategy } = make()
    await strategy.handle(err("TOKEN"), { model: "m" }, ctx)
    expect(strategy.canHandle(err("TOKEN"))).toBe(false)
  })

  test("handle aborts when match() returns null at handle time (defensive)", async () => {
    const { strategy } = make({ match: () => null })
    const res = await strategy.handle(err("TOKEN"), { model: "m" }, ctx)
    expect(res.action).toBe("abort")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/pipeline/reactive-rejection.unit.test.ts` — 若项目用 bun test：`bun test tests/pipeline/reactive-rejection.unit.test.ts`
Expected: FAIL —「Cannot find module '~/lib/request/strategies/reactive-rejection'」

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/request/strategies/reactive-rejection.ts
/**
 * Generic reactive-rejection retry primitive.
 *
 * Unifies the shared shape of the per-model upstream-rejection strategies
 * (system-reject / web_search-not-found / partner-feature / server-tool):
 * detect a specific 400 → parse a capability token → persist it to the
 * negotiation cache → remediate (re-sanitize the pre-S3 baseline, OR strip a
 * field / carry prepareHints) → retry once.
 *
 * Two remediation arms (RFC §3.1 WARN-7): the re-sanitize arm (system-reject /
 * web_search-history) re-runs the S3 chain on `context.originalPayload`; the
 * strip arm (partner-feature / server-tool) mutates the payload or sets
 * prepareHints. The primitive owns parse/mark/canHandle/one-shot; the caller
 * injects the remediation.
 */

import type { ApiError } from "~/lib/error"

import type {
  //
  RetryAction,
  RetryContext,
  RetryStrategy,
} from "../pipeline"

export interface ReactiveRejectionConfig<TPayload extends { model: string }> {
  name: string
  match(error: ApiError): string | null
  mark(model: string, token: string): void
  remediate(args: { error: ApiError; payload: TPayload; token: string; context: RetryContext<TPayload> }): RetryAction<TPayload>
}

export function createReactiveRejectionStrategy<TPayload extends { model: string }>(cfg: ReactiveRejectionConfig<TPayload>): RetryStrategy<TPayload> {
  // Per-instance one-shot guard. Strategies are built per-request (see
  // buildAnthropicStrategies), so this is request-scoped and cannot leak across
  // unrelated requests. Defense-in-depth alongside the idempotent cache mark.
  let attempted = false

  return {
    name: cfg.name,

    canHandle(error: ApiError): boolean {
      if (attempted) return false
      if (error.type !== "bad_request" || error.status !== 400) return false
      return cfg.match(error) !== null
    },

    handle(error: ApiError, currentPayload: TPayload, context: RetryContext<TPayload>): Promise<RetryAction<TPayload>> {
      attempted = true
      const token = cfg.match(error)
      if (token === null) return Promise.resolve({ action: "abort", error })
      cfg.mark(currentPayload.model, token)
      return Promise.resolve(cfg.remediate({ error, payload: currentPayload, token, context }))
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/pipeline/reactive-rejection.unit.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: Typecheck + lint（无缓存）**

Run: `bun run typecheck && bunx eslint src/lib/request/strategies/reactive-rejection.ts`
Expected: 0 error

- [ ] **Step 6: Commit**

```bash
git add -- src/lib/request/strategies/reactive-rejection.ts tests/pipeline/reactive-rejection.unit.test.ts
git commit -F - <<'EOF'
feat: add reactive-rejection retry strategy primitive

Generic parse→mark→remediate scaffold shared by the per-model upstream-rejection
strategies (system-reject / web_search-history / partner-feature / server-tool).
One-shot guard + 400-gate + pluggable remediation (re-sanitize vs strip arm).
EOF
```

---

### Task 2: negotiation 缓存 `systemRejectModels` 集（A 存储槽）

新增 1 级成员集 `Set<modelKey>`，持久化为顶层 `Array<modelKey>`（RFC §3.2 NIT-1 / O5 对称）。与 sibling `partnerFeatures`（2 级 Map）**不同形状**。

**Files:**
- Modify: `src/lib/anthropic/feature-negotiation.ts`（新增内存集 + mark/is + snapshot/load 字段 + reset 清理）
- Test: `tests/anthropic/feature-negotiation.unit.test.ts`（追加 describe 块）

**Interfaces:**
- Consumes: 现有 `modelKey(modelId)`（[:72](../../../src/lib/anthropic/feature-negotiation.ts#L72)）、`schedulePersist`、`NegotiationStateFile`。
- Produces:
  ```ts
  export function markSystemRejectModel(modelId: string): void
  export function isSystemRejectModelLearned(modelId: string): boolean
  // NegotiationStateFile 新增: systemRejectModels: Array<string>
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/anthropic/feature-negotiation.unit.test.ts — 追加
import {
  clearAnthropicFeatureNegotiationForTests,
  isSystemRejectModelLearned,
  markSystemRejectModel,
} from "~/lib/anthropic/feature-negotiation"

describe("systemRejectModels (inline role:system rejection set)", () => {
  test("mark then is — normalized membership, endpoint-scoped", () => {
    clearAnthropicFeatureNegotiationForTests()
    expect(isSystemRejectModelLearned("claude-sonnet-4.6")).toBe(false)
    markSystemRejectModel("claude-sonnet-4.6")
    expect(isSystemRejectModelLearned("claude-sonnet-4.6")).toBe(true)
    // normalization: dotted vs dashed are the same key
    expect(isSystemRejectModelLearned("claude-sonnet-4-6")).toBe(true)
    // an unrelated model is not marked
    expect(isSystemRejectModelLearned("claude-opus-4.8")).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/anthropic/feature-negotiation.unit.test.ts`
Expected: FAIL —「markSystemRejectModel is not exported / undefined」

- [ ] **Step 3: Write minimal implementation**

在 [feature-negotiation.ts](../../../src/lib/anthropic/feature-negotiation.ts) 加：

> **命名（review fix 4）：** 内存集用 `learnedSystemRejectModels`——**区别于** config 侧 `state.systemRejectModels`（Task 3 加的 Array）。有效模式 = config `state.systemRejectModels` ∪ 本 learned 集（`resolveSystemSanitizeMode` 求并集，Task 4）。同名会让 `feature-negotiation.ts` 的读者与 state 字段混淆，故此处显式区分。

```ts
// 内存集（挨着 unsupportedPartnerFeatures 声明）
/** Models whose upstream rejects inline role:"system", LEARNED reactively (config
 *  twin = state.systemRejectModels; effective set = config ∪ this learned set). */
const learnedSystemRejectModels = new Set<string>()

// mark / is（挨着 partner-feature 区）
/**
 * Mark a model whose upstream rejects inline `role:"system"` messages (learned
 * reactively from an `Unexpected role "system"` 400). A 1-level membership set —
 * the fact is a per-model boolean, no sub-dimension. Observed SYMPTOM, not a
 * Vertex assertion (Vertex is this account's known cause but is not asserted).
 * The config twin is `state.systemRejectModels`; the effective reject set unions
 * both (see resolveSystemSanitizeMode).
 */
export function markSystemRejectModel(modelId: string): void {
  if (!learnedSystemRejectModels.has(modelKey(modelId))) {
    learnedSystemRejectModels.add(modelKey(modelId))
    schedulePersist()
  }
}

/** Whether inline role:"system" was learned-rejected for the given model. */
export function isSystemRejectModelLearned(modelId: string): boolean {
  return learnedSystemRejectModels.has(modelKey(modelId))
}
```

`NegotiationStateFile`（[:225](../../../src/lib/anthropic/feature-negotiation.ts#L225)）加字段：`systemRejectModels: Array<string>`（持久化文件键沿用 `systemRejectModels`——文件 schema 与内存变量名解耦）。
`persistFeatureNegotiation` 的 `data` 对象加：`systemRejectModels: [...learnedSystemRejectModels]`。
`loadPersistedFeatureNegotiation` 的 total 累加：`+ loadStringSet(learnedSystemRejectModels, data.systemRejectModels)`，其中新增 helper：

```ts
/** Load a flat Array<string> into a Set (1-level set persistence — mirrors loadSetMap but for a single set). */
function loadStringSet(target: Set<string>, source: Array<string> | undefined): number {
  if (!Array.isArray(source)) return 0
  let n = 0
  for (const v of source) {
    if (typeof v === "string" && v.length > 0) {
      target.add(v)
      n++
    }
  }
  return n
}
```

`clearNegotiationMaps()`（[:338](../../../src/lib/anthropic/feature-negotiation.ts#L338)）加 `learnedSystemRejectModels.clear()`。**（review fix 5）** 同步更新 `clearAnthropicFeatureNegotiationForTests`（[:366-367](../../../src/lib/anthropic/feature-negotiation.ts#L366)）的「clears the 6 maps」注释——Task 2 + Task 6 各加一个集合 → 「clears the 8 collections」（P2 C1 再加 → 9；每 Task 各自维护该计数）。

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/anthropic/feature-negotiation.unit.test.ts`
Expected: PASS

- [ ] **Step 5: persist→reload golden test（承重 invariant）**

追加测试：mark → `persistFeatureNegotiation()` 写盘 → 清空内存 → `loadPersistedFeatureNegotiation()` → 断言 `isSystemRejectModelLearned` 仍 true。用 `useIsolatedRuntime` / DI 临时目录（见 skill `test-isolation`，`PATHS.NEGOTIATION_STATES` 须沙箱化）。

```ts
test("golden: persist → reload keeps the learned reject model across restart", async () => {
  // 用 isolated runtime fixture 沙箱 PATHS.NEGOTIATION_STATES；此处示意逻辑
  clearAnthropicFeatureNegotiationForTests()
  markSystemRejectModel("claude-haiku-4.5")
  await persistFeatureNegotiation()
  clearAnthropicFeatureNegotiationForTests()
  expect(isSystemRejectModelLearned("claude-haiku-4.5")).toBe(false) // wiped
  await loadPersistedFeatureNegotiation()
  expect(isSystemRejectModelLearned("claude-haiku-4.5")).toBe(true) // survived
})
```

Run: `bun test tests/anthropic/feature-negotiation.unit.test.ts` — Expected: PASS

- [ ] **Step 6: Typecheck + lint + Commit**

```bash
bun run typecheck && bunx eslint src/lib/anthropic/feature-negotiation.ts
git add -- src/lib/anthropic/feature-negotiation.ts tests/anthropic/feature-negotiation.unit.test.ts
git commit -F - <<'EOF'
feat: add systemRejectModels negotiation set (learned inline-system rejection)

1-level membership Set<modelKey> persisted as a top-level Array — inline
role:system rejection is a per-model boolean (no sub-dimension). Observed symptom,
not a Vertex assertion. Golden persist→reload verifies cross-restart survival.
EOF
```

---

### Task 3: config schema + state —— `system_reject_models` / `system_reject_mode`

新增 config 键（config 声明侧的 reject 集 + 有效模式），默认 `[claude-sonnet-4.6, claude-haiku-4.5]`（O2 实测）+ `as_user`（O 保位置、prompt-cache 友好）。

**Files:**
- Modify: `src/lib/config/schema.ts`（`AnthropicConfigSchema` 加两键）
- Modify: `src/lib/config/config.ts`（apply：`setAnthropicBehavior`）
- Modify: `src/lib/state.ts`（新 state field 两个：标量 `systemRejectMode` 镜像 `systemMessagesSanitize` 的 5 站点；集合 `systemRejectModels` 镜像一个 `Array<string>` 集合 field 如 `nonDeferredTools`；默认值置入 `CONFIG_MANAGED_DEFAULTS`）
- Modify: `config.yaml`（bundled 默认注释 + 默认值）
- Test: `tests/config/*`（新增或追加 schema + apply 断言）

**Interfaces:**
- Produces（state）：
  ```ts
  readonly systemRejectModels: Array<string>   // 默认 ["claude-sonnet-4.6", "claude-haiku-4.5"]
  readonly systemRejectMode: false | "drop_invalid" | "merge" | "as_user" | "as_assistant"  // 默认 "as_user"
  ```

- [ ] **Step 1: Write the failing test（schema + apply）**

在 config 测试里加：给定 YAML `anthropic: { system_reject_models: [foo], system_reject_mode: merge }`，apply 后 `state.systemRejectModels` = `["foo"]`（经 `normalizeModelKeyedRecord`? —— **不**，它是 `Array<string>` 子串集，非 Record；用 `nullableNonemptyStringArray`，apply 直接赋值，不归一化——归一化发生在匹配时），`state.systemRejectMode` = `"merge"`；不给时默认 `["claude-sonnet-4.6","claude-haiku-4.5"]` + `"as_user"`。

```ts
test("system_reject_models / system_reject_mode apply to state", () => {
  applyConfig({ anthropic: { system_reject_models: ["foo-model"], system_reject_mode: "merge" } })
  expect(state.systemRejectModels).toEqual(["foo-model"])
  expect(state.systemRejectMode).toBe("merge")
})
test("system_reject_* defaults are the empirically-confirmed reject set + as_user", () => {
  resetConfigManagedState()
  expect(state.systemRejectModels).toEqual(["claude-sonnet-4.6", "claude-haiku-4.5"])
  expect(state.systemRejectMode).toBe("as_user")
})
```

（`applyConfig` / `resetConfigManagedState` 是**占位名**——**review fix 2**：照抄 `tests/config/` 里现有用例的真实 harness（如 `tests/config/config-merge.unit.test.ts`、`tests/config/bundled-config.unit.test.ts` 里 apply/reset config 的真实调用），别用占位名直接跑。）

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config/` — Expected: FAIL（键不存在 / state 无字段）

- [ ] **Step 3: Implement — schema**

在 `AnthropicConfigSchema`（挨着 `system_messages_sanitize`）加：

```ts
/**
 * Models whose upstream STRICT backend rejects inline `role:"system"` messages
 * (observed SYMPTOM — Vertex is this account's known cause but NOT asserted).
 * A substring set matched against the resolved OUTBOUND model name (normalized).
 * A matched model uses `system_reject_mode`; unmatched models fall back to the
 * global `system_messages_sanitize`. Also grows at runtime (reactive learning).
 * Default `[claude-sonnet-4.6, claude-haiku-4.5]` (empirically confirmed).
 */
system_reject_models: nullableNonemptyStringArray(),
/**
 * Effective sanitize mode for models in `system_reject_models` (∪ the learned
 * reject set). Reuses the SystemMessagesSanitizeMode enum. Default `as_user`
 * (keeps position — most prompt-cache-friendly).
 */
system_reject_mode: z
  .union([z.literal(false), z.literal("drop_invalid"), z.literal("merge"), z.literal("as_user"), z.literal("as_assistant"), z.null()], {
    error: "Must be one of: false, drop_invalid, merge, as_user, as_assistant",
  })
  .optional()
  .transform((v) => v ?? undefined),
```

- [ ] **Step 4: Implement — state.ts（镜像 5+1 站点）**

`grep -n "systemMessagesSanitize" src/lib/state.ts` 得 5 站点（interface / setAnthropicBehavior union / CONFIG_MANAGED_DEFAULTS / 两处 reset spread），逐一加 `systemRejectMode` 平行行。集合 `systemRejectModels` 镜像 `nonDeferredTools`（`grep -n "nonDeferredTools" src/lib/state.ts`）的所有站点。`CONFIG_MANAGED_DEFAULTS` 里：

```ts
systemRejectMode: "as_user" as false | "drop_invalid" | "merge" | "as_user" | "as_assistant",
systemRejectModels: ["claude-sonnet-4.6", "claude-haiku-4.5"] as Array<string>,
```

- [ ] **Step 5: Implement — config.ts apply**

在 `system_messages_sanitize` apply（[:534](../../../src/lib/config/config.ts#L534)）附近加：

```ts
if (a.system_reject_models !== undefined) setAnthropicBehavior({ systemRejectModels: a.system_reject_models })
if (a.system_reject_mode !== undefined) setAnthropicBehavior({ systemRejectMode: a.system_reject_mode })
```

- [ ] **Step 6: Implement — bundled config.yaml**

在 `config.yaml` 的 `anthropic:` 段加带中英注释的键（默认注释掉或写出默认值，照抄同段其他键风格）：

```yaml
  # 上游严格后端拒绝 inline role:"system" 的模型集（观测症状，非 vertex 硬断言）。
  # 子串匹配 resolved outbound 名（归一化）。命中→用 system_reject_mode；未命中→回退 system_messages_sanitize。
  # Models whose upstream rejects inline role:"system" (observed symptom, not a Vertex assertion).
  # system_reject_models:
  #   - claude-sonnet-4.6
  #   - claude-haiku-4.5
  # system_reject_mode: as_user
```

- [ ] **Step 7: Run tests + typecheck + lint**

Run: `bun test tests/config/ && bun run typecheck && bunx eslint src/lib/config/schema.ts src/lib/config/config.ts src/lib/state.ts`
Expected: PASS + 0 error。若有 config JSON-schema 生成脚本（`scripts/generate-config-json-schema.ts`），跑 `bun run` 对应脚本刷新（见 package.json）。

- [ ] **Step 8: Commit**

```bash
git add -- src/lib/config/schema.ts src/lib/config/config.ts src/lib/state.ts config.yaml tests/config/
git commit -F - <<'EOF'
feat: add anthropic.system_reject_models / system_reject_mode config

Config-declared reject set + effective sanitize mode for models whose upstream
rejects inline role:system. Default [claude-sonnet-4.6, claude-haiku-4.5] +
as_user (empirically confirmed). Union'd with the learned negotiation set at
match time; observed symptom, not a Vertex assertion.
EOF
```

---

### Task 4: 有效模式解析 —— sanitize + count-tokens（A proactive 侧）

有效模式 = `model ∈ (config system_reject_models ∪ 学入 systemRejectModels) → system_reject_mode`；否则 → 全局 `system_messages_sanitize`。config 侧是**列表 substring-includes over normalized names**（非 `findMostSpecific`），学入侧是精确归一化 membership。count-tokens 走 canonical first-party endpoint、对**所有**模型拒 `role:"system"`，故**无条件**清洗（非 reject 集 gating）。

**Files:**
- Create: `src/lib/anthropic/system-reject-mode.ts`（有效模式解析纯函数，避免 sanitize/index.ts 与 count-tokens 重复逻辑）
- Modify: `src/lib/anthropic/sanitize/index.ts`（[:95](../../../src/lib/anthropic/sanitize/index.ts#L95) 用有效模式）
- Modify: `src/routes/messages/count-tokens.ts`（[:50](../../../src/routes/messages/count-tokens.ts#L50) 无条件非 false 模式）
- Test: `tests/anthropic/system-reject-mode.unit.test.ts`（纯函数）+ 追加 `tests/anthropic/system-messages-sanitize.it.test.ts`（proactive 集成）

**Interfaces:**
- Produces:
  ```ts
  /** Whether the model is in the config reject set (substring-includes, normalized) OR the learned set. */
  export function isSystemRejectModel(model: string): boolean
  /** Effective inline-system sanitize mode: reject-set → systemRejectMode; else global systemMessagesSanitize. */
  export function resolveSystemSanitizeMode(model: string): SystemMessagesSanitizeMode
  ```

- [ ] **Step 1: Write the failing test（纯函数）**

```ts
// tests/anthropic/system-reject-mode.unit.test.ts
import { afterEach, describe, expect, test } from "bun:test"

import {
  clearAnthropicFeatureNegotiationForTests,
  markSystemRejectModel,
} from "~/lib/anthropic/feature-negotiation"
import { isSystemRejectModel, resolveSystemSanitizeMode } from "~/lib/anthropic/system-reject-mode"
import { setAnthropicBehavior, state } from "~/lib/state"

afterEach(() => clearAnthropicFeatureNegotiationForTests())

describe("resolveSystemSanitizeMode", () => {
  test("config reject set matches by normalized substring → uses systemRejectMode", () => {
    setAnthropicBehavior({ systemRejectModels: ["claude-haiku-4.5"], systemRejectMode: "as_user", systemMessagesSanitize: false })
    // real resolved name is date-suffixed; substring of normalized key must still match
    expect(isSystemRejectModel("claude-haiku-4-5-20251001")).toBe(true)
    expect(resolveSystemSanitizeMode("claude-haiku-4-5-20251001")).toBe("as_user")
  })
  test("non-reject model falls back to global system_messages_sanitize", () => {
    setAnthropicBehavior({ systemRejectModels: ["claude-haiku-4.5"], systemRejectMode: "as_user", systemMessagesSanitize: false })
    expect(isSystemRejectModel("claude-opus-4.8")).toBe(false)
    expect(resolveSystemSanitizeMode("claude-opus-4.8")).toBe(false)
  })
  test("learned reject set (reactive) also drives the effective mode", () => {
    setAnthropicBehavior({ systemRejectModels: [], systemRejectMode: "merge", systemMessagesSanitize: false })
    markSystemRejectModel("claude-sonnet-4.6")
    expect(resolveSystemSanitizeMode("claude-sonnet-4.6")).toBe("merge")
  })
})
```

- [ ] **Step 2: Run → FAIL**（模块不存在）

Run: `bun test tests/anthropic/system-reject-mode.unit.test.ts`

- [ ] **Step 3: Implement — 纯函数**

```ts
// src/lib/anthropic/system-reject-mode.ts
/**
 * Resolve the effective inline-`role:"system"` sanitize mode for a given resolved
 * OUTBOUND model name. A model in the reject set (config `system_reject_models`
 * ∪ the learned negotiation set) uses `system_reject_mode`; every other model
 * falls back to the global `system_messages_sanitize` (default passthrough).
 *
 * The reject membership is a SYMPTOM ("this outbound model rejects inline system"),
 * NOT a Vertex assertion (Vertex is this account's known cause but is not asserted).
 * Config match is list substring-includes over normalized names (NOT findMostSpecific —
 * that is Record→value, meaningless for a boolean set); the learned side is exact
 * normalized modelKey membership.
 */

import type { SystemMessagesSanitizeMode } from "./sanitize/system-messages"

import { normalizeForMatching } from "~/lib/models/resolver"
import { state } from "~/lib/state"

import { isSystemRejectModelLearned } from "./feature-negotiation"

export function isSystemRejectModel(model: string): boolean {
  const normalized = normalizeForMatching(model)
  for (const key of state.systemRejectModels) {
    if (normalized.includes(normalizeForMatching(key))) return true
  }
  return isSystemRejectModelLearned(model)
}

export function resolveSystemSanitizeMode(model: string): SystemMessagesSanitizeMode {
  return isSystemRejectModel(model) ? state.systemRejectMode : state.systemMessagesSanitize
}
```

- [ ] **Step 4: Wire proactive — sanitize/index.ts**

[:95](../../../src/lib/anthropic/sanitize/index.ts#L95) 改：`payload.model` 在此已是 resolved outbound 名（[codec.ts:281](../../../src/lib/codec/anthropic/codec.ts#L281)），故有效模式在函数内直接算，**无需改签名**：

```ts
// was: const inlineSystem = sanitizeInlineSystemMessages(messages, sanitizedSystem, state.systemMessagesSanitize)
const inlineSystem = sanitizeInlineSystemMessages(messages, sanitizedSystem, resolveSystemSanitizeMode(payload.model))
```

顶部 import：`import { resolveSystemSanitizeMode } from "../system-reject-mode"`。

- [ ] **Step 5: Wire count-tokens — 无条件清洗（WARN-2）**

[count-tokens.ts:50](../../../src/routes/messages/count-tokens.ts#L50)：canonical first-party endpoint 对所有模型拒 `role:"system"`，故用无条件非 false 模式。改：

```ts
// was: sanitizeInlineSystemMessages(payload.messages, attributionStrippedSystem, state.systemMessagesSanitize)
// count_tokens forwards the CANONICAL first-party endpoint, which rejects role:"system"
// for EVERY model (not GHC's lenient first-party leg) — so ALWAYS sanitize, independent
// of the reject set. Use as_user (position-preserving); fall back to the global mode only
// when it is a non-false mode the operator explicitly chose otherwise.
const countMode = state.systemMessagesSanitize === false ? "as_user" : state.systemMessagesSanitize
const inlineSystem = sanitizeInlineSystemMessages(payload.messages, attributionStrippedSystem, countMode)
```

- [ ] **Step 6: Proactive 集成测试（reject 集模型 → outbound 无 system；非 reject → 透传）**

追加到 `tests/anthropic/system-messages-sanitize.it.test.ts`：构造带 inline `role:"system"` 的 payload，`state.systemMessagesSanitize=false` + `systemRejectModels=[claude-sonnet-4.6]`，跑 `sanitizeAnthropicMessages({...,model:"claude-sonnet-4.6"})` → 断言结果 messages 无 `role:"system"`（`convertedCount>0`）；同 payload model=`claude-opus-4.8` → 断言 `role:"system"` 保留（透传）。

- [ ] **Step 7: Run + typecheck + lint + Commit**

```bash
bun test tests/anthropic/system-reject-mode.unit.test.ts tests/anthropic/system-messages-sanitize.it.test.ts
bun run typecheck && bunx eslint src/lib/anthropic/system-reject-mode.ts src/lib/anthropic/sanitize/index.ts src/routes/messages/count-tokens.ts
git add -- src/lib/anthropic/system-reject-mode.ts src/lib/anthropic/sanitize/index.ts src/routes/messages/count-tokens.ts tests/anthropic/system-reject-mode.unit.test.ts tests/anthropic/system-messages-sanitize.it.test.ts
git commit -F - <<'EOF'
feat: resolve per-model inline-system sanitize mode (A proactive)

Effective mode = reject-set model → system_reject_mode, else global
system_messages_sanitize. Computed inside sanitizeAnthropicMessages from the
resolved outbound payload.model (no signature change). count_tokens always
sanitizes (canonical first-party endpoint rejects role:system for every model).
EOF
```

---

### Task 5: 反应式 A strategy —— system-reject-retry（via getResanitize）

用 Task 1 primitive 的 re-sanitize arm：检测 `Unexpected role "system"` 400 → 学入 `systemRejectModels` → `getResanitize(context.originalPayload)` 重跑 S3（有效模式已含新学模型 → 自动 role-rewrite）→ 重试 + `meta.sanitization` 回传（NIT-3，镜像 auto-truncate）。

**Files:**
- Create: `src/lib/request/strategies/system-reject-retry.ts`
- Modify: `src/lib/codec/anthropic/strategies.ts`（插入 strategy，位置：`unsupported-beta` 之后、`deferred-tool` 之前，与 server-tool/structured-outputs 同段——它们都是 400-class feature-strip；A 放在这段末尾）
- Test: `tests/pipeline/system-reject-retry.unit.test.ts`

**Interfaces:**
- Consumes: `createReactiveRejectionStrategy`（Task 1）、`markSystemRejectModel`（Task 2）、`AnthropicSanitizeFn`（`~/lib/anthropic/pipeline`）、`context.originalPayload`（pre-S3 baseline）。
- Produces:
  ```ts
  export interface SystemRejectRetryDeps {
    /** The S3 re-sanitize chain (= codec.getResanitize()), applied to the pre-S3 baseline. */
    resanitize: AnthropicSanitizeFn
    /** Injectable learn for tests (defaults to markSystemRejectModel). */
    mark?: (model: string) => void
  }
  export function createSystemRejectRetryStrategy<TPayload extends MessagesPayload>(deps: SystemRejectRetryDeps): RetryStrategy<TPayload>
  ```

- [ ] **Step 1: Write the failing test（含正样本证 canHandle 触达）**

```ts
// tests/pipeline/system-reject-retry.unit.test.ts
import { describe, expect, test } from "bun:test"

import type { ApiError } from "~/lib/error"
import type { RetryContext } from "~/lib/request/pipeline"
import type { MessagesPayload } from "~/types/api/anthropic"

import { HTTPError } from "~/lib/error"
import { createSystemRejectRetryStrategy } from "~/lib/request/strategies/system-reject-retry"

// The REAL upstream error string (positive sample — proves canHandle touches target).
const SYSTEM_REJECT_BODY = JSON.stringify({
  error: { type: "invalid_request_error", message: 'Unexpected role "system". The Messages API accepts a top-level system parameter, not inline system messages.' },
})

function rejectError(body = SYSTEM_REJECT_BODY): ApiError {
  return { type: "bad_request", status: 400, message: "HTTP 400: Failed to create Anthropic messages", raw: new HTTPError("boom", 400, body, "claude-sonnet-4.6") }
}

const baseline: MessagesPayload = {
  model: "claude-sonnet-4.6",
  max_tokens: 100,
  messages: [{ role: "system", content: "ctx" } as never, { role: "user", content: "hi" }],
} as MessagesPayload

const ctx: RetryContext<MessagesPayload> = { attempt: 0, maxRetries: 3, originalPayload: baseline, model: undefined }

describe("createSystemRejectRetryStrategy", () => {
  test("canHandle matches the real Unexpected role \"system\" 400 (positive sample)", () => {
    const s = createSystemRejectRetryStrategy({ resanitize: (p) => ({ payload: p, blocksRemoved: 0, systemReminderRemovals: 0, stats: {} as never }), mark: () => {} })
    expect(s.canHandle(rejectError())).toBe(true)
    expect(s.canHandle(rejectError(JSON.stringify({ error: { message: "something else" } })))).toBe(false)
  })

  test("handle: marks the model, re-sanitizes the PRE-S3 baseline, retries with meta.sanitization", async () => {
    const marked: Array<string> = []
    // Fake resanitize: proves the strategy feeds originalPayload (not currentPayload)
    // and forwards the resulting payload + stats.
    const resanitize = (p: MessagesPayload) => ({
      payload: { ...p, messages: p.messages.filter((m) => (m as { role: string }).role !== "system") },
      blocksRemoved: 0,
      systemReminderRemovals: 0,
      stats: { inlineSystemConverted: 1 } as never,
    })
    const s = createSystemRejectRetryStrategy({ resanitize, mark: (m) => marked.push(m) })
    const currentPayload = { ...baseline, messages: [{ role: "user", content: "already-mutated" }] } as MessagesPayload
    const res = await s.handle(rejectError(), currentPayload, ctx)
    expect(res.action).toBe("retry")
    expect(marked).toEqual(["claude-sonnet-4.6"])
    const retry = res as { payload: MessagesPayload; meta: { sanitization: unknown } }
    // fed the BASELINE (2 msgs → 1 after system strip), NOT currentPayload (1 msg "already-mutated")
    expect(retry.payload.messages).toHaveLength(1)
    expect((retry.payload.messages[0] as { content: string }).content).toBe("hi")
    expect(retry.meta.sanitization).toEqual({ inlineSystemConverted: 1 })
  })
})
```

- [ ] **Step 2: Run → FAIL**（模块不存在）

Run: `bun test tests/pipeline/system-reject-retry.unit.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/lib/request/strategies/system-reject-retry.ts
/**
 * System-reject retry strategy (RFC gap A).
 *
 * The Anthropic Messages API rejects inline `role:"system"` messages with
 * `Unexpected role "system"`. GHC's lenient first-party path hoists them before
 * forwarding; the STRICT path (Vertex / partner) sends canonical validation and
 * 400s. This strategy reacts to that 400: learn the model into the negotiation
 * `systemRejectModels` set (persisted), then re-run the S3 sanitize chain on the
 * PRE-S3 baseline (`context.originalPayload`) — the effective inline-system mode
 * now resolves to `system_reject_mode` for the just-learned model, so sanitize
 * rewrites role:system → user and the retry ships a clean payload.
 *
 * Re-sanitize arm of the reactive-rejection primitive (mirrors auto-truncate's
 * resanitize(originalPayload)). Feeding `context.originalPayload` is a CORRECTNESS
 * hard-constraint (RFC O6 / §3.2 WARN-1): feeding the already-S3 currentPayload
 * would double-apply the whole rewrite chain. Learned reason is logged as an
 * INFERENCE ("Vertex is this account's known cause but not asserted").
 */

import consola from "consola"

import type { AnthropicSanitizeFn } from "~/lib/anthropic/pipeline"
import type { ApiError } from "~/lib/error"
import type { MessagesPayload } from "~/types/api/anthropic"

import { markSystemRejectModel } from "~/lib/anthropic/feature-negotiation"
import { HTTPError } from "~/lib/error"
import { createReactiveRejectionStrategy } from "~/lib/request/strategies/reactive-rejection"

import type { RetryStrategy } from "../pipeline"

/** Upstream message for an inline role:"system" rejection. */
const UNEXPECTED_SYSTEM_ROLE = /Unexpected role \\?"system\\?"/i
// ⚠ 实施修正（Task 5 实测）：`HTTPError.responseText` 是**原始 JSON**，内层引号被反斜杠转义（`Unexpected role \"system\"`）。
// 故正则须容忍可选反斜杠 `\\?"`，才能同时匹配 raw-escaped body 与 parsed message；朴素的 `/Unexpected role "system"/i` 在真实 wire 上不触发（正样本测试会抓到）。

function extractErrorText(error: ApiError): string | null {
  if (UNEXPECTED_SYSTEM_ROLE.test(error.message)) return error.message
  if (error.raw instanceof HTTPError) return error.raw.responseText
  return null
}

export interface SystemRejectRetryDeps {
  resanitize: AnthropicSanitizeFn
  mark?: (model: string) => void
}

export function createSystemRejectRetryStrategy<TPayload extends MessagesPayload>(deps: SystemRejectRetryDeps): RetryStrategy<TPayload> {
  const mark = deps.mark ?? markSystemRejectModel
  return createReactiveRejectionStrategy<TPayload>({
    name: "system-reject-retry",
    match: (error) => {
      const text = extractErrorText(error)
      return text !== null && UNEXPECTED_SYSTEM_ROLE.test(text) ? "role:system" : null
    },
    mark: (model) => {
      mark(model)
      consola.info(`[SystemReject] Inferred inline role:system rejection for ${model} (Vertex is this account's known cause but not asserted); re-sanitizing + retrying.`)
    },
    remediate: ({ context }) => {
      // Re-run the S3 chain on the PRE-S3 baseline — the effective mode now
      // rewrites role:system for the just-learned model. NEVER feed currentPayload
      // (already-S3 → double-apply). Mirrors auto-truncate resanitize(originalPayload).
      const result = deps.resanitize(context.originalPayload)
      return { action: "retry", payload: result.payload as TPayload, meta: { sanitization: result.stats } }
    },
  })
}
```

- [ ] **Step 4: Run → PASS**

Run: `bun test tests/pipeline/system-reject-retry.unit.test.ts`

- [ ] **Step 5: Wire into buildAnthropicStrategies**

在 [strategies.ts:96](../../../src/lib/codec/anthropic/strategies.ts#L96)（`structured-outputs-rejection` 之后、`deferred-tool` 之前）插入：

```ts
adapt(createSystemRejectRetryStrategy<MessagesPayload>({ resanitize: deps.resanitize })),
```

顶部 import `createSystemRejectRetryStrategy`。注意 `deps.resanitize` 已是 `codec.getResanitize()`（[handler-v4.ts:328](../../../src/routes/messages/handler-v4.ts#L328)）。

> **反应式覆盖边界（review fix 3）：** 反应式 A strategy 只 wire 进 `buildAnthropicStrategies`（主 v4 handler 的 driver retry stack）。**web-search-direct 路径**（[web-search-direct.ts:210](../../../src/routes/messages/web-search-direct.ts#L210) 自跑 `runAnthropicPayloadRewrites`）**不经**该 retry stack——对**尚未学入**的 reject 模型，web-search-direct 首次仍会 400 一次。但 **proactive 侧透明覆盖它**（Task 4 已证 web-search 路径都经 `sanitizeAnthropicMessages`，默认 reject 集 `[claude-sonnet-4.6, claude-haiku-4.5]` 稳态直接清洗）。故 RFC §3.2「transparent coverage」在 web-search-direct 上是 **proactive-only**（稳态已覆盖），反应式学习只在主 handler 路径闭环。Task 5 集成测试断言的是主 handler 路径的反应式；web-search-direct 的覆盖靠 proactive 默认集，无需额外反应式接线。

- [ ] **Step 6: 反应式集成测试（mock 首发 400 → 学入 + 重试已清洗）**

在 `tests/anthropic/` 加集成测试（照 `tests/anthropic/server-tool-rejection.http.test.ts` 的 harness）：mock 上游首发 `Unexpected role "system"` 400、第二次 200；发带 inline system 的请求 → 断言 (a) 第二次 outbound wire 无 `role:"system"`，(b) `isSystemRejectModelLearned(model)` 为 true，(c) 终态 completed。**连跑 10 次确认确定性**（时序/单例）：`for i in $(seq 10); do bun test <file> || break; done`。

- [ ] **Step 7: typecheck + lint + Commit**

```bash
bun run typecheck && bunx eslint src/lib/request/strategies/system-reject-retry.ts src/lib/codec/anthropic/strategies.ts
git add -- src/lib/request/strategies/system-reject-retry.ts src/lib/codec/anthropic/strategies.ts tests/pipeline/system-reject-retry.unit.test.ts tests/anthropic/
git commit -F - <<'EOF'
feat: reactive system-reject retry (RFC gap A)

Detect Unexpected role "system" 400 → learn the model into systemRejectModels →
getResanitize(originalPayload) re-runs S3 with the now-effective reject mode →
retry with a clean payload. Re-sanitize arm of the reactive-rejection primitive;
feeds the pre-S3 baseline (O6). Forwards meta.sanitization (mirrors auto-truncate).
EOF
```

---

### Task 6: negotiation 缓存 `effortUnsupported` 集（B 存储槽，O5=独立集）

新增独立 `Set<modelKey>`，与 `supportedEfforts` map **完全分离**（永不存空数组，snapshot/load 对称平凡，5 处碰撞按构造消失）；写入与 `supportedEfforts` 互斥。

**Files:**
- Modify: `src/lib/anthropic/feature-negotiation.ts`
- Test: `tests/anthropic/feature-negotiation.unit.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function markEffortUnsupported(modelName: string): void
  export function isEffortUnsupported(modelName: string): boolean
  // NegotiationStateFile 新增: effortUnsupported: Array<string>
  ```
- 键用 `effortKey`（model-only，与 `supportedEfforts` 同键空间，见 [:76](../../../src/lib/anthropic/feature-negotiation.ts#L76)）——保证互斥判定同一 key。

- [ ] **Step 1: Write the failing test（含互斥 + golden）**

```ts
// tests/anthropic/feature-negotiation.unit.test.ts — 追加
import {
  clearAnthropicFeatureNegotiationForTests,
  getSupportedEfforts,
  isEffortUnsupported,
  loadPersistedFeatureNegotiation,
  markEffortUnsupported,
  persistFeatureNegotiation,
  setSupportedEfforts,
} from "~/lib/anthropic/feature-negotiation"

describe("effortUnsupported (zero-support effort set)", () => {
  test("mark then is (model-only key, normalized)", () => {
    clearAnthropicFeatureNegotiationForTests()
    expect(isEffortUnsupported("claude-haiku-4.5")).toBe(false)
    markEffortUnsupported("claude-haiku-4.5")
    expect(isEffortUnsupported("claude-haiku-4-5")).toBe(true)
  })
  test("mutually exclusive with supportedEfforts", () => {
    clearAnthropicFeatureNegotiationForTests()
    setSupportedEfforts("claude-x", ["medium"])
    markEffortUnsupported("claude-x")
    // marking unsupported removes any supported whitelist for that model
    expect(getSupportedEfforts("claude-x")).toBeUndefined()
    expect(isEffortUnsupported("claude-x")).toBe(true)
    // and vice-versa
    setSupportedEfforts("claude-x", ["low"])
    expect(isEffortUnsupported("claude-x")).toBe(false)
  })
  test("golden: persist → reload keeps the unsupported flag (empty-set collision avoided)", async () => {
    clearAnthropicFeatureNegotiationForTests()
    markEffortUnsupported("claude-haiku-4.5")
    await persistFeatureNegotiation()
    clearAnthropicFeatureNegotiationForTests()
    await loadPersistedFeatureNegotiation()
    expect(isEffortUnsupported("claude-haiku-4.5")).toBe(true)
  })
})
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement**

内存集：`const effortUnsupportedModels = new Set<string>()`（key = `effortKey`）。

```ts
/**
 * Mark a model as supporting NO reasoning effort at all (learned from a
 * `does not support reasoning effort` 400, code invalid_reasoning_effort, WITHOUT
 * a `supported values:[...]` list). Stored as an INDEPENDENT membership set —
 * "known-unsupported" is membership, never an empty array — so snapshot/load is
 * symmetric and the 5 empty-set collision sites of `supportedEfforts` do NOT apply
 * (RFC §3.3 O5). Mutually exclusive with a supported whitelist for the same model.
 */
export function markEffortUnsupported(modelName: string): void {
  const key = effortKey(modelName)
  supportedEfforts.delete(key) // exclusivity: cannot be both unsupported and have a whitelist
  if (!effortUnsupportedModels.has(key)) {
    effortUnsupportedModels.add(key)
    schedulePersist()
  }
}

export function isEffortUnsupported(modelName: string): boolean {
  return effortUnsupportedModels.has(effortKey(modelName))
}
```

`setSupportedEfforts`（[:130](../../../src/lib/anthropic/feature-negotiation.ts#L130)）加一行互斥：函数体开头 `effortUnsupportedModels.delete(effortKey(modelName))`（设置白名单即撤销「不支持」）。

`NegotiationStateFile` 加 `effortUnsupported: Array<string>`；persist 加 `effortUnsupported: [...effortUnsupportedModels]`；load 加 `+ loadStringSet(effortUnsupportedModels, data.effortUnsupported)`（复用 Task 2 的 `loadStringSet`）；`clearNegotiationMaps()` 加 `effortUnsupportedModels.clear()`。

- [ ] **Step 4: Run → PASS；Step 5: typecheck + lint + Commit**

```bash
bun test tests/anthropic/feature-negotiation.unit.test.ts && bun run typecheck && bunx eslint src/lib/anthropic/feature-negotiation.ts
git add -- src/lib/anthropic/feature-negotiation.ts tests/anthropic/feature-negotiation.unit.test.ts
git commit -F - <<'EOF'
feat: add effortUnsupported negotiation set (zero-support effort variant)

Independent Set<modelKey> separate from supportedEfforts — "known-unsupported" is
membership, never an empty array, so snapshot/load is symmetric and the empty-set
collision sites don't apply (RFC O5). Mutually exclusive with a supported whitelist.
EOF
```

---

### Task 7: B —— 零支持 parse 分支 + clamp 前置剥除

新增 parse 分支识别零支持措辞 → 学入 `effortUnsupported`（复用既有 effort-learning strategy 的 learn 腿）；`clampEffortLevel` 顶部前置剥除。effort-learning strategy `handle` 逻辑不变（learn 返 true → 重试 → 重准备剥除）。

**Files:**
- Modify: `src/lib/anthropic/request-preparation.ts`（`parseEffortUnsupportedError` + `learnEffortsFromError` 扩分支 + `clampEffortLevel` 前置）
- Test: `tests/anthropic/*`（request-preparation 单测 + effort-learning 集成）

**Interfaces:**
- Consumes: `markEffortUnsupported` / `isEffortUnsupported`（Task 6）。
- Produces:
  ```ts
  /** Parse the ZERO-support effort variant (`... does not support reasoning effort`, no supported list). Returns modelName or null. */
  export function parseEffortUnsupportedError(responseText: string): string | null
  ```

- [ ] **Step 1: Write the failing test（正样本 = 真实 body）**

```ts
// 真实 body（RFC §3.3 实测 req_1783390118141_26）
const ZERO_SUPPORT_BODY = JSON.stringify({
  error: { message: 'output_config.effort "high" was provided, but model claude-haiku-4.5 does not support reasoning effort', code: "invalid_reasoning_effort" },
})

test("parseEffortUnsupportedError extracts the model from the zero-support variant", () => {
  expect(parseEffortUnsupportedError(ZERO_SUPPORT_BODY)).toBe("claude-haiku-4.5")
  // the WHITELIST variant (has supported values) is NOT this branch → null
  expect(parseEffortUnsupportedError(JSON.stringify({ error: { message: 'not supported by model X; supported values: [medium]', code: "invalid_reasoning_effort" } }))).toBeNull()
})

test("learnEffortsFromError learns the zero-support model into effortUnsupported", () => {
  clearAnthropicFeatureNegotiationForTests()
  expect(learnEffortsFromError(ZERO_SUPPORT_BODY)).toBe(true)
  expect(isEffortUnsupported("claude-haiku-4.5")).toBe(true)
})

test("clampEffortLevel strips output_config.effort when the model is effort-unsupported", () => {
  // clampEffortLevel is NOT exported — drive via the public prepareAnthropicRequest
  // entry (project convention: never break encapsulation for a test). The clamp-effort
  // prepare step runs the strip.
  clearAnthropicFeatureNegotiationForTests()
  markEffortUnsupported("claude-haiku-4.5")
  const prepared = prepareAnthropicRequest(
    { model: "claude-haiku-4.5", max_tokens: 100, messages: [{ role: "user", content: "hi" }], output_config: { effort: "high" } } as MessagesPayload,
    // no resolvedModel → clampEffortLevel reads wire.model
  )
  expect((prepared.wire.output_config as { effort?: string } | undefined)?.effort).toBeUndefined()
})
```

（**review fix 1**：`clampEffortLevel` 是模块私有函数（[request-preparation.ts:728](../../../src/lib/anthropic/request-preparation.ts#L728)，只被 `clamp-effort` prepare step 消费）。**经公共入口 `prepareAnthropicRequest` 测**——不要为测试擅自 export、破坏封装。断言 `prepared.wire.output_config` 无 `effort`（空则整个 output_config 被删）。

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement — parse 分支**

```ts
/**
 * Parse the ZERO-support effort variant: `output_config.effort "X" was provided,
 * but model <M> does not support reasoning effort` (code invalid_reasoning_effort,
 * NO `supported values:[...]` list). Distinct from parseInvalidEffortError (which
 * requires the supported list). Returns the model name, or null when not this variant.
 */
export function parseEffortUnsupportedError(responseText: string): string | null {
  if (!responseText.includes("invalid_reasoning_effort")) return null
  if (!/does not support reasoning effort/i.test(responseText)) return null
  const m = /model ([^;"]+?) does not support reasoning effort/i.exec(responseText)
  return m ? m[1].trim() : null
}
```

- [ ] **Step 4: Implement — learnEffortsFromError 扩分支**

在 `learnEffortsFromError`（[:598](../../../src/lib/anthropic/request-preparation.ts#L598)）`parseInvalidEffortError` 返 null 后加零支持回退：

```ts
export function learnEffortsFromError(responseText: string): boolean {
  const parsed = parseInvalidEffortError(responseText)
  if (!parsed) {
    // Zero-support variant (no supported list): learn "known-unsupported".
    const unsupportedModel = parseEffortUnsupportedError(responseText)
    if (unsupportedModel) {
      markEffortUnsupported(unsupportedModel)
      consola.info(`[DirectAnthropic] Learned ${unsupportedModel} supports NO reasoning effort; will strip output_config.effort.`)
      return true
    }
    return false
  }
  // ... 现有 whitelist 逻辑不变
}
```

顶部 import `markEffortUnsupported`, `isEffortUnsupported` from `./feature-negotiation`。

- [ ] **Step 5: Implement — clampEffortLevel 前置剥除**

`clampEffortLevel`（[:728](../../../src/lib/anthropic/request-preparation.ts#L728)）顶部（读到 modelName 后、`findSupportedEfforts` 前）加：

```ts
function clampEffortLevel(wire: Record<string, unknown>, resolvedModel?: Model): void {
  const outputConfig = wire.output_config as OutputConfig | undefined
  if (!outputConfig?.effort) return
  const modelName = resolvedModel?.id ?? (wire.model as string)
  if (!modelName) return

  // Zero-support: the model supports NO reasoning effort (learned). Strip the field
  // entirely (drop output_config if it empties) — BEFORE the whitelist/clamp logic.
  if (isEffortUnsupported(modelName)) {
    const { effort: _effort, ...rest } = outputConfig
    if (Object.keys(rest).length > 0) wire.output_config = rest
    else delete wire.output_config
    consola.debug(`[DirectAnthropic] Stripped output_config.effort (model=${modelName} supports no reasoning effort)`)
    return
  }
  // ... 现有 findSupportedEfforts / clamp 逻辑不变
}
```

- [ ] **Step 6: Run → PASS + effort-learning 反应式集成测试**

集成测试（照 `tests/pipeline/effort-learning-retry-strategy.unit.test.ts` + 真实 pipeline 集成）：mock 上游首发零支持 400 → 断言学入 `effortUnsupported` + 第二次 outbound wire 无 `output_config.effort`。**persist→reload golden 已在 Task 6 覆盖**——此处补一条：学入零支持后 `prepareAnthropicRequest` 剥除（证 reactive→prepare 闭环）。连跑 10 次确认确定性。

- [ ] **Step 7: typecheck + lint + Commit**

```bash
bun run typecheck && bunx eslint src/lib/anthropic/request-preparation.ts
git add -- src/lib/anthropic/request-preparation.ts tests/anthropic/
git commit -F - <<'EOF'
feat: learn + strip zero-support effort variant (RFC gap B)

New parse branch for `does not support reasoning effort` (no supported list) →
learn into effortUnsupported → clampEffortLevel strips output_config.effort before
the whitelist logic. effort-learning strategy handle unchanged (learn→retry→strip).
EOF
```

---

**P1 收尾（session-closeout 步骤，见 skill `session-closeout`）：**
- [ ] 派 `ecc:typescript-reviewer` + `ecc:code-reviewer` subagent 审 P1 全量 diff（prompt 写明裁判轴：长远正确 + 完整、非 ROI/YAGNI；reviewer 的「无消费者/可删/已通过」断言亲自对照代码复核）。
- [ ] doc-sync：`docs/DESIGN.md`「活的架构现状」表加 A/B 反应式路径 + 新 config 键；跨文档 grep 验证。
- [ ] 全量 `bun run typecheck && bun run lint:all && bun test tests/anthropic tests/pipeline tests/config`。

---

# P2 —— C（web_search-not-found 反应式化）

**依赖：** P1（复用 `createReactiveRejectionStrategy` primitive re-sanitize arm + `systemRejectModels`/有效模式解析模式）。可与 P3/P4 并行。

**交付物：** 检测 `Tool '…' not found in provided tools` 400（区别于 deferred-tool 的 `Tool reference '…' not found in available tools`）→ 学入 per-model「server-tool-history downgrade」→ `getResanitize(originalPayload)` 重跑 S3（`rewriteServerToolHistory` 现对该 model 生效 downgrade）→ 重试。O1 已定 = 加反应式 strategy（默认不变）。

**结构镜像 A**（三 Task）：C1 negotiation 集，C2 有效模式解析 + sanitize 接线，C3 反应式 strategy。

**Commit invariants：** reject 集外零副作用；mock 首发 `Tool 'web_search' not found in provided tools` 400 → 学入 + downgrade + 重试 outbound 无 server_tool_use{web_search}；正样本证 canHandle 触达真实错误串。

---

### Task C1: negotiation 集 `serverToolHistoryDowngradeModels`

镜像 P1 Task 2（1 级 `Set<modelKey>` + 顶层 Array 持久化）。

**Files:** Modify `src/lib/anthropic/feature-negotiation.ts`；Test `tests/anthropic/feature-negotiation.unit.test.ts`。

**Produces:**
```ts
export function markServerToolHistoryDowngrade(modelId: string): void
export function isServerToolHistoryDowngradeLearned(modelId: string): boolean
// NegotiationStateFile 加: serverToolHistoryDowngrade: Array<string>
```

- [ ] Step 1–6：严格照 P1 Task 2 的 5 处改动（内存集 + mark/is + NegotiationStateFile 字段 + persist/load via `loadStringSet` + `clearNegotiationMaps`）+ golden persist→reload 测试。用 `modelKey`（endpoint-scoped）。Commit：`feat: add serverToolHistoryDowngrade negotiation set (RFC gap C)`。

---

### Task C2: server-tool-history 有效模式解析 + sanitize 接线

**Files:** Create `src/lib/anthropic/server-tool-history-mode.ts`；Modify `src/lib/anthropic/sanitize/index.ts`（[:104](../../../src/lib/anthropic/sanitize/index.ts#L104)）；Test `tests/anthropic/server-tool-history-mode.unit.test.ts`。

**Produces:**
```ts
/** Effective server-tool-history rewrite mode: learned-downgrade model OR global config → "downgrade"; else global rewriteHistoryServerTools. */
export function resolveServerToolHistoryMode(model: string): RewriteServerToolHistoryMode
```

- [ ] **Step 1: 纯函数测试**（reject 集模型 → "downgrade"；非集模型 → 全局 `state.rewriteHistoryServerTools`；学入侧 via `markServerToolHistoryDowngrade`）。镜像 P1 Task 4 的 `resolveSystemSanitizeMode` 测试结构。

- [ ] **Step 2–3: Implement**
```ts
// src/lib/anthropic/server-tool-history-mode.ts
import type { RewriteServerToolHistoryMode } from "./sanitize/rewrite-server-tool-history"
import { normalizeForMatching } from "~/lib/models/resolver"
import { state } from "~/lib/state"
import { isServerToolHistoryDowngradeLearned } from "./feature-negotiation"

/** Whether server-tool history should be downgraded for this model (learned OR global config already downgrade). */
export function resolveServerToolHistoryMode(model: string): RewriteServerToolHistoryMode {
  if (isServerToolHistoryDowngradeLearned(model)) return "downgrade"
  return state.rewriteHistoryServerTools
}
```
（说明：C 的 config 侧就是既有全局 `rewriteHistoryServerTools`，无新 per-model config 列表——O1 只加反应式、默认不变。故 resolver 只需 learned ∪ 全局。）

- [ ] **Step 4: Wire sanitize**——[:104](../../../src/lib/anthropic/sanitize/index.ts#L104)：`rewriteServerToolHistory(messages, resolveServerToolHistoryMode(payload.model))`（替 `state.rewriteHistoryServerTools`）。import `resolveServerToolHistoryMode`。

- [ ] **Step 5–6:** proactive 集成测试（学入 downgrade 的 model → sanitize 结果无 `server_tool_use` 块；非集且全局 false → 保留）+ typecheck + lint + Commit：`feat: per-model server-tool-history downgrade mode (RFC gap C proactive)`。

---

### Task C3: 反应式 strategy —— web-search-not-found（primitive re-sanitize arm）

**Files:** Create `src/lib/request/strategies/web-search-not-found-retry.ts`；Modify `src/lib/codec/anthropic/strategies.ts`（插在 `system-reject-retry` 后、`deferred-tool` 前）；Test `tests/pipeline/web-search-not-found-retry.unit.test.ts`。

**Produces:**
```ts
export interface WebSearchNotFoundRetryDeps { resanitize: AnthropicSanitizeFn; mark?: (model: string) => void }
export function createWebSearchNotFoundRetryStrategy<TPayload extends MessagesPayload>(deps: WebSearchNotFoundRetryDeps): RetryStrategy<TPayload>
```

- [ ] **Step 1: 正样本测试**——真实错误串 `Tool 'web_search' not found in provided tools`；断言 canHandle true；断言**不**匹配 deferred-tool 的 `Tool reference 'X' not found in available tools`（防 C 与 G 正则串味）。handle 断言 mark(model) + resanitize(context.originalPayload) 喂 baseline（非 currentPayload）+ meta.sanitization 回传。镜像 P1 Task 5 测试。

- [ ] **Step 2–3: Implement**（正则 = `/Tool '[^']+' not found in provided tools/i`；remediate 同 A 的 re-sanitize arm；mark = `markServerToolHistoryDowngrade`；日志写「推断 web_search 未在 provided tools，触发 server-tool-history downgrade」）。

```ts
// 关键：区别于 deferred-tool 的正则（RFC §1 C）
const WEB_SEARCH_NOT_IN_TOOLS = /Tool '[^']+' not found in provided tools/i
```
remediate 与 [system-reject-retry.ts](../../../src/lib/request/strategies/system-reject-retry.ts) 的 re-sanitize arm 逐字相同（`resanitize(context.originalPayload)` → `{action:"retry", payload, meta:{sanitization}}`）；若 P1 review 建议抽 `resanitizeRemediation` helper 则复用之。

- [ ] **Step 4–7:** wire 进 buildAnthropicStrategies（`adapt(createWebSearchNotFoundRetryStrategy<MessagesPayload>({ resanitize: deps.resanitize }))`）+ 反应式集成测试（mock 首发 400 → 第二次 outbound 无 server_tool_use{web_search}，连跑 10 次）+ typecheck + lint + Commit：`feat: reactive web_search-not-found retry (RFC gap C)`。

---

# P3 —— D / E / F / G（变体缺口补全）

**依赖：** P1（D/E 迁到 primitive strip arm）。**D/E/F/G 内部格式独立、可并行**。**F 强制 golden-first**。

---

### Task D: partner-feature 表驱动（两处 strip 站点，NIT-8）

把 structured-outputs strategy 的 canHandle 从「只 structured_outputs」放宽为「有已知 strip-target 的 partner feature 表」。**两处 strip 站点**：strategy 自身 strip（[structured-outputs-rejection-retry.ts:102](../../../src/lib/request/strategies/structured-outputs-rejection-retry.ts#L102)）+ prepare 侧 `stripUnsupportedStructuredOutputs`（[request-preparation.ts:698](../../../src/lib/anthropic/request-preparation.ts#L698)），**同一张表驱动两者**。O4：补当前已知——今日表仅 `structured_outputs → output_config.format` 一行，但架构表驱动（加行 = 数据变更、非改逻辑）。

**Files:**
- Create: `src/lib/anthropic/partner-feature-strip.ts`（`PARTNER_FEATURE_STRIP_TARGETS` 表 + `stripPartnerFeatureFromWire(wire, feature)` 通用剥除）
- Modify: `src/lib/request/strategies/structured-outputs-rejection-retry.ts`（canHandle 放行任意表内 feature；strip 走表；可迁到 primitive strip arm）
- Modify: `src/lib/anthropic/request-preparation.ts`（`stripUnsupportedStructuredOutputs` 泛化为遍历表）
- Test: `tests/anthropic/structured-outputs-rejection.unit.test.ts` + request-preparation 单测

**Produces:**
```ts
/** feature name (as upstream reports) → wire strip descriptor. Only features with a KNOWN SAFE strip target. */
export const PARTNER_FEATURE_STRIP_TARGETS: Readonly<Record<string, { path: "output_config.format" }>> // 今日仅 structured_outputs
export function stripPartnerFeatureFromWire(wire: Record<string, unknown>, feature: string): boolean
```

- [ ] **Step 1: 表 + 剥除纯函数测试**——`structured_outputs` → 剥 `output_config.format`（空则删 output_config、保 `effort`）；表外 feature（`extended_thinking`）→ 剥除返 false、canHandle 拒绝落空到 plain 400（现状保留）。正样本：真实 Vertex org-policy 400 串经 `parseDisallowedPartnerFeature` 得 `structured_outputs`。
- [ ] **Step 2–3: Implement 表 + 通用剥除**（`stripPartnerFeatureFromWire` 用表的 path 描述剥 wire 字段）。
- [ ] **Step 4: 改 strategy**——canHandle：`parseDisallowedPartnerFeature(error)` ∈ 表 keys（非仅 `STRUCTURED_OUTPUTS_PARTNER_FEATURE`）；strip 走 `stripPartnerFeatureFromWire`；mark = `markAnthropicPartnerFeatureUnsupported`。可用 primitive strip arm（match=parse+表校验，mark=markPartnerFeature，remediate=strip payload）。**保持** structured_outputs 的既有 degrade-warn 日志。
- [ ] **Step 5: 改 prepare**——`stripUnsupportedStructuredOutputs` 改为遍历表：对每个 `feature ∈ 表`，若 `isAnthropicPartnerFeatureUnsupported(model,feature) || collectStripPartnerFeatures(model).has(feature)` → `stripPartnerFeatureFromWire(wire, feature)`。重命名为 `stripUnsupportedPartnerFeatures` 反映实际职责（保 ANTHROPIC_PREPARE_STEPS 里 step name 或同步更新）。
- [ ] **Step 6–7:** 两站点各自单测（strategy strip + prepare strip 都由表驱动、行为不回归）+ typecheck + lint + Commit：`refactor: table-driven partner-feature strip, two sites (RFC gap D)`。

---

### Task E: server-tool 表驱动

把 server-tool-rejection 的硬编码 web_search 正则 + 前缀改为 per-tool 表（缓存结构已通用）。O4：今日表仅 web_search（唯一有观测消息的），架构 per-tool 表可扩展。可迁到 primitive strip arm。

**Files:**
- Create/Modify: `src/lib/request/strategies/server-tool-rejection-retry.ts`（`SERVER_TOOL_REJECTION_TABLE: {pattern, typePrefix}[]`；canHandle 遍历表；迁到 primitive strip arm）
- Test: `tests/pipeline/server-tool-rejection-retry.unit.test.ts`

**Produces:**
```ts
/** upstream-message pattern → server-tool type prefix to strip. Only tools with an observed upstream rejection message. */
const SERVER_TOOL_REJECTION_TABLE: ReadonlyArray<{ pattern: RegExp; typePrefix: string }> // 今日仅 web_search
```

- [ ] **Step 1: 表 + 匹配测试**——真实 `The use of the web search tool is not supported.` → typePrefix `web_search_`；表外消息 → 无匹配（不落空到别的 strategy）。正样本证 canHandle。
- [ ] **Step 2–4: Implement**（`match(error)` 遍历表返 typePrefix 或 null；mark = `markAnthropicServerToolUnsupported(model, typePrefix)`；remediate strip arm = `{action:"retry", payload, prepareHints:{excludeServerToolTypes:[typePrefix]}, meta:{strippedServerTools:[typePrefix]}}`——即现有 [:77](../../../src/lib/request/strategies/server-tool-rejection-retry.ts#L77) 逻辑，只是 web_search 从表来）。可用 primitive。
- [ ] **Step 5–6:** 既有行为不回归（web_search 仍触发）+ typecheck + lint + Commit：`refactor: table-driven server-tool rejection (RFC gap E)`。

---

### Task F: token-limit 变体（GOLDEN-FIRST，O3）

**前置硬门槛（O3）：先捕获真实上游 token-limit body 做 golden，再加正则；捕不到就不做（无 golden 不猜）。**

**Files:**
- Modify: `src/lib/error/parsing.ts`（`parseTokenLimitError` 加变体正则）
- Test: `tests/error/*` + fixture（真实 body）

- [ ] **Step 0（门槛）:** 从 History 语料 / 上游探针捕获**真实**的 `max_tokens`-inclusive 或 Vertex 措辞的 context-length 400 body。查 History（[proxy-api-reference skill] 4141 API 或直接 SQLite 查 `bad_request` + token/context 关键字）。**若捕不到真实 body → 停，把 F 记入 [docs/todo/deferred-backlog.md](../../todo/deferred-backlog.md)（根因/当前行为/理想架构/为何暂缓/若做需改什么），本 Task 不产出正则。** 不猜措辞。
- [ ] **Step 1:** 用捕获的真实 body 建 golden fixture；写测试：该 body 经 `parseTokenLimitError` 应返 `{current, limit}`（当前返 null）。
- [ ] **Step 2:** Run → FAIL（现 2 条正则匹配不上）。
- [ ] **Step 3:** 加**精确匹配真实 body 措辞**的正则变体（不宽泛猜测；只覆盖 golden 里的真实措辞）。
- [ ] **Step 4:** Run → PASS；补 `classify.ts` 400→token_limit 分支已复用 `extractTokenLimitFromResponseText`→`parseTokenLimitError`，无需另改（核实 [classify.ts:204](../../../src/lib/error/classify.ts#L204)）。
- [ ] **Step 5:** typecheck + lint + Commit：`feat: parse token-limit variant from captured golden body (RFC gap F)`。

---

### Task G: deferred-tool 双层包裹 raw 回退

`parseToolReferenceFromResponse`（[deferred-tool-retry.ts:169](../../../src/lib/request/strategies/deferred-tool-retry.ts#L169)）对双层包裹 body `if(!message) return null` 先返回、不回退 raw text；改用 `parsed.error?.message ?? responseText`（对齐姊妹策略 legacy-thinking / context-management）。

**Files:** Modify `src/lib/request/strategies/deferred-tool-retry.ts`；Test `tests/pipeline/*`（新增 deferred-tool 单测或追加）。

- [ ] **Step 1: 失败测试**——双层包裹 body（`error.message` 缺失但顶层/raw text 含 `Tool reference 'X' not found in available tools`）→ 断言 `parseToolReferenceFromResponse` 返 `X`（当前返 null）。正样本用真实双层包裹形状。
- [ ] **Step 2: Run → FAIL。**
- [ ] **Step 3: Implement**——[:169-178](../../../src/lib/request/strategies/deferred-tool-retry.ts#L169)：
```ts
function parseToolReferenceFromResponse(responseText: string): string | null {
  try {
    const parsed = JSON.parse(responseText) as { error?: { message?: string } }
    // Fall back to raw text when the double-wrapped body has no error.message
    // (mirrors legacy-thinking / context-management: parsed.error?.message ?? responseText).
    return parseToolReferenceError(parsed.error?.message ?? responseText)
  } catch {
    return parseToolReferenceError(responseText)
  }
}
```
- [ ] **Step 4–5: Run → PASS + 现有 deferred-tool 测试不回归** + typecheck + lint + Commit：`fix: deferred-tool falls back to raw text on double-wrapped body (RFC gap G)`。

---

# P4 —— H（可观测性：失败 attempt 完整错误 body 持久化）

**依赖：** 无（独立，可与 P2/P3 并行）。

**交付物：** 扩 `AttemptSnapshot.error` 携 `rawBody`；attempt_failed 路径持久化 per-attempt error body 为 per-attempt response stage（entry_stages）；history 投影 surfaced。richest-data-flow：后端完整存，**不**为「无消费者」裁剪——它正是反应式学习的事后审计依据。

**Commit invariants：** 终态失败 body 保留不回归；新增中途失败 body 持久化经 golden 验证（多 attempt 记录断言 attempt[0] 保留完整 rawBody；改动前先证终态失败 body 已存的等价 tripwire 不回归）。

---

### Task H1: AttemptSnapshot.error 加 rawBody + recordAttemptFailure 投影

**Files:**
- Modify: `src/lib/observability/events.ts`（[:115](../../../src/lib/observability/events.ts#L115) `AttemptSnapshot.error` 加 `rawBody?`）
- Modify: `src/lib/context/request.ts`（[:750](../../../src/lib/context/request.ts#L750) `recordAttemptFailure` 从 `a.error.raw` 提 responseText）
- Test: `tests/context/*` 或 `tests/observability/*`

- [ ] **Step 1: 失败测试**——构造 currentAttempt.error = ApiError{raw: HTTPError(status,body,...)}；调 `recordAttemptFailure` → 断言发布的 `attempt.error.rawBody === body`（当前 undefined）。
- [ ] **Step 2: Run → FAIL。**
- [ ] **Step 3: Implement**
```ts
// events.ts AttemptSnapshot
error?: { status: number; message: string; type: string; rawBody?: string }
```
```ts
// request.ts recordAttemptFailure — error 投影加 rawBody
...(a?.error && {
  error: {
    status: a.error.status,
    message: a.error.message,
    type: a.error.type,
    ...(a.error.raw instanceof HTTPError && { rawBody: a.error.raw.responseText }),
  },
}),
```
（顶部确保 import `HTTPError` from `~/lib/error`。）
- [ ] **Step 4–5: Run → PASS** + typecheck + lint + Commit：`feat: carry upstream error rawBody on AttemptSnapshot (RFC gap H)`。

---

### Task H2: per-attempt error body 持久化到 entry_stages + history 投影

把 attempt_failed 的 rawBody 持久化为 per-attempt response stage，与终态 outboundResponse.rawBody 对称（[history/types.ts:218](../../../src/lib/history/types.ts#L218) `rawBody?`、[serialize.ts:192](../../../src/lib/history/sqlite/serialize.ts#L192)）。

**Files:**（实施前 Read 这些定 attempt→stage 投影点）
- `src/lib/observability/sinks/history.ts`（attempt_failed → collectAttemptStages / mirror 到 SQLite）
- `src/lib/history/sqlite/serialize.ts`（[:482](../../../src/lib/history/sqlite/serialize.ts#L482) 附近：失败终态 attempt 只有 error 的处理）
- `src/lib/context/types.ts`（`ResponseData.responseText`/`rawBody` 已存在——core：让 per-attempt error body 走同一 stage 序列化）
- Test: `tests/history/*`（golden 多-attempt 记录）

- [ ] **Step 1: golden 失败测试**——构造 attempt[0] failed（error.rawBody=B0）→ attempt[1] ok → 终态 completed 的 History entry；断言持久化后 attempt[0] 的 response stage 保留 `rawBody===B0`。**先写等价 tripwire**：断言现有终态失败 body（outboundResponse.rawBody）不回归（改动前先跑证它已存）。
- [ ] **Step 2: Run → FAIL**（中途失败 body 未持久化）。
- [ ] **Step 3: Implement**——在 history sink 的 attempt-stage 收集处，把 `attempt.error.rawBody`（H1 投影）写入该 attempt 的 response-stage `rawBody`（复用 serialize 既有 `resp.rawBody` 路径，[serialize.ts:192](../../../src/lib/history/sqlite/serialize.ts#L192)）。**不**新增列——复用 entry_stages 的 response stage blob。
- [ ] **Step 4: Run → PASS + 4141 History API 实测**（探针复现生产接线，见 skill `empirical-verification`）：真发一个首 attempt 失败-恢复请求，查 History detail 断言 attempt[0] rawBody 可见。
- [ ] **Step 5: history 投影 surfaced**——前端 History detail 若消费 attempt stages，确认 rawBody 可选择性呈现（后端已完整存；前端裁剪按需）。
- [ ] **Step 6: typecheck + lint + build:ui（若碰 ui-v4 类型）+ Commit：** `feat: persist per-attempt upstream error body to history (RFC gap H)`。

---

## 全局收尾（所有 phase 完成后，走 skill `session-closeout`，步数与内容以 skill 为准）

- [ ] **① subagent audit**——派 `ecc:typescript-reviewer` + `ecc:code-reviewer`（+ `ecc:silent-failure-hunter` 查 never-swallow）审全量 diff，prompt 写明裁判轴（长远正确 + 完整、非 ROI/YAGNI）；reviewer 绝对断言亲自对照代码复核。
- [ ] **② doc-sync**——[docs/DESIGN.md](../../DESIGN.md)「活的架构现状」表加 A–H 反应式路径 + 新 config 键 + 新 negotiation 集；`docs/spec/` 相关（tool-use / request-pipeline / anthropic-compat）同步；跨文档 grep 验证无孤引。
- [ ] **③ 归档 plan**——本 plan 迁 `docs/plan/`（已在），头部加四档实施状态注解（见 skill `session-closeout`）。
- [ ] **④ 提炼教训**——反应式拒绝 primitive 模式、re-sanitize-arm 喂 pre-S3 baseline 的坑、独立集绕过空集碰撞——精炼进 skill `telemetry-architecture` 邻近或新 skill / 记忆库 stub。
- [ ] **⑤ 细粒度提交**——每 Task 已独立提交（显式 pathspec `git commit -- <精确路径>`、conventional commits、无模型署名）。
