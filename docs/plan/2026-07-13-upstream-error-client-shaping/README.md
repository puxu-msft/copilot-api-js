# 实施计划：上游错误 → 客户端可行动形态整形（upstream-error-client-shaping）

- **对应 Spec**：[docs/spec/2026-07-13-upstream-error-client-shaping.md](../../spec/2026-07-13-upstream-error-client-shaping.md)（v2.3，三轮对抗评审全闭合，2026-07-13）
- **依赖 Spec（前置里程碑，G-4）**：[docs/spec/2026-07-11-block-level-buffered-retry.md](../../spec/2026-07-11-block-level-buffered-retry.md)（P1 default 翻转，当前 gated）——见下文「Phase DAG」
- **证据基础**：`exp/cc-error-retry-surface/FINDINGS.md` + `REPORT.md`
- **计划撰写日期**：2026-07-13；撰写者：planner（本计划未参与实现，不写实现代码）
- **计划状态**：草案，待 subagent 评审 → 待主会话/用户确认「待裁决」节后可执行

---

## 0. 待主会话 / 用户裁决（先读）

以下两项不是我可以从 spec/代码自解的真分叉，列在最前面，其余任务不受阻可直接推进。

### D-0：交互式 / headless 检测信号不存在——AUQ 的“仅交互式有效”门控如何落地

**发现**：全仓 grep `headless`/`querySource`/`interactive`/`isInteractive`/`sessionMode`/`client_type` 在 `src/lib/context/request.ts`、`src/routes/messages/*.ts`、`src/lib/anthropic/*.ts` 均**零命中**——代理服务端当前没有任何信号能区分“交互式终端会话”与“headless / `-p` / 子 agent”。`requestHeaderWhitelist` 里allow-list 的请求头（`x-app`/`x-claude-code-*`/`x-stainless-*`）也不携带这类信息（已读 state.ts:1402 核实）。

**选项**：
1. **（推荐）纯配置门控，不做运行时探测**——`error_ask_user_question` 默认 `false`；是否开启完全交给部署方（部署方知道自己是交互式 TUI 还是 headless CI/子 agent），代理不尝试自动判断。这与 spec §配置面原文一致（该键本就是唯一开关，spec 未要求运行时探测）。
2. 引入启发式判断（如按 `stream:false`/无 `anthropic-beta` 等猜测），额外增加一条不可靠的分类逻辑，且没有可靠信号源可用——不建议，容易引入误判且找不到 oracle 验证。
3. 要求客户端主动上报（新增请求头约定），但这超出本 spec「不改客户端协议」的非目标边界，且 CC 客户端不会为本代理特别改造。

**推荐**：选项 1。已按此写入 Phase 4 任务（配置即门控，无运行时探测代码）。若主会话认为需要选项 2/3，请在评审阶段提出，我会补充相应任务。

### D-0.5：Phase 3（canonical 尾帧整形）与 block-level P1 Task 6 的跨 worktree 编辑冲突风险——执行排序建议

**发现**：Phase 3 需要修改的两个位置——① `handler-v4.ts` H2/H3/truncation 三个终点分支（约 1172-1306 行）、② 新增一条 `ResponseRewrite`（`response-rewrite-adapters.ts` 的 `ANTHROPIC_RESPONSE_REWRITES` 数组）——与 `docs/plan/block-level-buffered-retry/`（进行中，独立 worktree `.worktrees/block-level-buffered-retry` 上）Task 6（P1 块级接线+默认翻 on）**很可能改动同一批行**（P1 Task 6 要把 truncation 分支的语义从「hard fail」改造成「首块前重放 / 首块后 partial-degrade」）。

这不是 G-4 严格要求的阻塞（G-4 只 gate「post-commit 截断类目标的实际兑现」，不要求 gate 这处 canonical 尾帧整形本身），但两个工作流并行会产生**跨 worktree rebase 成本**：谁先落地 master，谁就要求另一方在 rebase 时重新对齐这几个分支。

**建议**（不強制，供主会话按当前并发会话全局情况决定）：
- 若 block-level P1 Task 6 近期（同一两天内）会落地，建议 Phase 3 排在其后开工，直接在 P1 落地后的新分支上写，免去 rebase。
- 若暂不确定 P1 落地时间，Phase 3 可先做，但**必须**把 canonical 尾帧整形封装成 error-shaping.ts 导出的单一纯函数（`buildCanonicalErrorFrame` 见 Phase 1），P1 Task 6 未来只需调用同一函数即可接入，将 rebase 冲突面收窄到「调用点」而非「整形逻辑」本身。
- 无论哪种顺序，Phase 3 的 golden 字节锁测试（`error_shaping_enabled=false` 逐字节等价现状）都应保留为回归哨兵，P1 落地后重跑一遍确认未破坏。

本计划按「Phase 3 可独立先行」的假设编排任务（因为它不依赖 P1 的 `partial-degrade` 类型），但在 Phase 3 文档顶部重复此风险提示。

---

## 1. 目标 / 架构 / 技术栈 / 全局约束

### 目标（对齐 spec 5 项目标，逐字对应见第 5 节覆盖表）

把上游错误按 `ApiError` 分类 × commit phase（pre-commit/post-commit）× `clientVisibleStopEmitted` 三维决策，整形为对 Claude Code（CC）客户端更「可行动」的形态（触发原生重试 / 合成 AskUserQuestion / 委派 CC 自愈 / 保持 canonical 错误帧），而非现状的「一律拍平成错误帧」。**只接入 Anthropic Messages 路径**；OpenAI/Gemini/Azure 不动。

### 架构（模块边界，不新决定公共 API，只细化已接受的架构合同）

```
                        ┌─────────────────────────────┐
                        │  src/lib/anthropic/           │
                        │  error-shaping.ts  (新, 纯函数) │
                        │  ─ decide(ApiError, phase,     │
                        │    clientVisibleStopEmitted,   │
                        │    config) → ShapingDecision   │
                        │  ─ buildCanonicalErrorFrame()   │
                        │  ─ buildAskUserQuestionFrames() │
                        │  ─ buildAskUserQuestionResponse()│
                        │  ─ filterDelegatedStrategies()  │
                        └───────────┬─────────────────────┘
                                    │ 被下列 4 处消费（均在 routes/ 或 codec/，不反向依赖 routes）
        ┌───────────────────────────┼───────────────────────────┬─────────────────────────┐
        ▼                           ▼                           ▼                         ▼
 src/lib/error/forward.ts   routes/messages/handler-v4.ts  codec/anthropic/          codec/anthropic/
 （pre-commit A 类重试信号）  （post-commit 终点①②，        response-rewrite-         strategies.ts
                              AUQ pre-commit 整段合成）      adapters.ts（新 rewrite，  （D 类委派过滤，
                                                             上游 event:error 帧        按策略名关 canHandle）
                                                             canonical 化）
```

- `error-shaping.ts` 是 `lib` 层纯函数模块，**不得 import `routes/`**（与 `recover-refusal.ts`/`post-commit-error.ts` 同层同规则）；输入 `ApiError + config（4 新键的当前值）+ commitPhase + clientVisibleStopEmitted`，输出一个可辨识的 `ShapingDecision` 联合类型（下节定义），不做任何 I/O / SSE 写入——写入动作留给调用方。
- 消费点固定为 4 处，接口方向不变：`forward.ts`（pre-commit 路径）、`handler-v4.ts`（post-commit 两终点 + AUQ 触发点）、`response-rewrite-adapters.ts`（新增一条 S5 rewrite，用于拦截 upstream 主动下发的流内 `event:error` 帧并 canonical 化——这是 G-3「终局尾帧唯一所有权」在**流式路径**的落地点，此前排除的分析遗漏了这一处，见下方「探索新发现」）、`strategies.ts`/`handler-v4.ts` 组装点（D 类委派过滤）。

### 技术栈

不引入新依赖；复用既有 `zod`（schema.ts）、`fetch-event-stream`（`ServerSentEventMessage`）、`renderRefusalTemplate`（recover-refusal.ts）、`ResponseRewrite`（rewrite-registry.ts）、`RetryStrategy`（pipeline.ts）等既有抽象。

### 全局约束（贯穿所有 Phase）

1. **TDD**：每个任务先写失败测试→确认红→最小实现→确认绿→提交。真实代码路径测试，`.unit` 用 `autoRestoreState()`，涉及 runtime/HTTP 的 `.it`/`.http` 用 `useIsolatedRuntime()`（`tests/helpers/isolated-fixture.ts`），禁止 `mock.module`。
2. **Golden 字节锁**：`error_shaping_enabled=false` 时，pre-commit `forward.ts`、post-commit 终点①（pre-pump catch）、post-commit 终点②（pump 内 H2/H3/truncation）三处必须与当前行为逐字节等价——每个 Phase 落地后都要跑一遍既有相关测试文件确认零回归。
3. **G-3 终局尾帧唯一所有权**：post-commit 失败尾帧（无论走 H2/H3/truncation 哪条分支）的 canonical 整形只能来自 `error-shaping.ts` 的 `buildCanonicalErrorFrame`，`streaming-pump.ts` 现有的 `anthropicStreamErrorType` 必须被收编（保留原函数签名/导出位置或改为 re-export，避免破坏其他调用方——当前仅 `codec.ts` + `handler-v4.ts` 两处引用，见 Phase 1 任务）。
4. **G-4 排序前提**：post-commit 截断类（首块前重放/首块后 partial-degrade）依赖 block-level P1 落地，本计划 Phase 0-5 均不依赖 P1，可独立交付；Phase 6 显式标注为 gated，仅记录契约与验收测试骨架，不实现。
5. **仅 Anthropic Messages**：所有改动只发生在 `src/lib/anthropic/`、`src/routes/messages/`、`src/lib/codec/anthropic/`、`src/lib/config/`（键定义对所有格式可见但仅 Anthropic 消费）。`src/lib/codec/openai-cc/`、`openai-responses/` 不动。
6. **richest-data-flow**：History 永远记真实上游错误（`attempts[].upstreamResponse`）；forwarded 轨的合成物（AUQ 整段合成、canonical 尾帧、委派透传）通过 `tagFrameSynthetic` 打标记；`writeSynthetic` 写入的帧本就不进任一轨（既有 B0-c 行为，AC#6 对这类帧靠「不进记录」而非「打标记」满足，Phase 3 任务里会显式记一条测试断言这一点，避免被误判成遗漏）。
7. **配置三触点 + 热重载 + 不阻塞**：新键必须同时改 `schema.ts`（zod 校验）、`config.ts`（`applyConfigToState`）、`state.ts`（`CONFIG_MANAGED_DEFAULTS` + `setAnthropicBehavior` 的 `Pick<>` 列表，Record 类型字段还需在 `mutableState` 初始字面量与 `resetConfigManagedState()` 两处补显式 spread 行）；配置遇到无效值只警告并继续，不 fail-fast（运行期），只有启动期可选 fail-fast。
8. **命名与风格**：遵循 `docs/coding-conventions.md`（无分号、三元起行、printWidth 160、`/** */` 用于导出符号、同目录相对导入）。

### 探索阶段的新发现（写入本计划，供实现者知晓，不是待裁决项）

- **G-3 在流式路径的真实落点比 spec 字面描述更精确**：post-commit「GHC 主动发流内 `event:error`」的帧，在当前实现里**已经原样转发给客户端**（`stream-accumulator.ts:186-192` 只是把它记进 `acc.streamError` 供 H2 判定用，`handler-v4.ts` 的 H2 分支——1213-1224 行——不再二次写帧，注释明确写着"a terminal upstream `error` SSE event was forwarded as a content frame"）。也就是说，**canonical 整形必须发生在帧被转发之前**，即 S5 rewrite 链（`response-rewrite-adapters.ts`）里新增一条拦截 `type==="error"` 帧的 rewrite，而不能只在 H2 分支里事后补救（那时帧已经上线）。这是 Phase 3 任务 3.3 的确切依据；spec 原文的"commit + fail, 不重放 → C" 描述的是结果状态，具体的接线点需要这次探索才能钉死，故记录于此供实现者不必重新反查。
- **AUQ 合成是 pre-commit 整段合成**（已在 spec 探索阶段确认），完全不需要与实时 pump/anchor 机制交互；但需要区分 `stream:true`（合成 SSE 帧序列）与 `stream:false`（合成整个 `AnthropicMessageResponse` JSON）两种客户端请求形态——这与 `recover-refusal.ts` 已经解决过的同款问题（`buildSyntheticTextFrames` vs 非流式对应函数）同构，Phase 4 直接复用该模式。

---

## 2. 文件结构（职责边界）

```
src/lib/anthropic/error-shaping.ts        新增 — 纯决策引擎 + 帧/响应构造 + 委派过滤器（本计划核心产出）
src/lib/anthropic/streaming-pump.ts       改动 — anthropicStreamErrorType 収编为对 error-shaping 的委托（保留导出签名）
src/lib/error/forward.ts                  改动 — mapHttpErrorToEnvelope/forwardError 接入 pre-commit retry-signal（Retry-After 头）
src/routes/messages/handler-v4.ts         改动 — 终点①②调用 error-shaping 决策 + AUQ pre-commit 整段合成分支
src/routes/messages/post-commit-error.ts  改动（小）— anthropicHttpErrorFrame 等收编进 error-shaping 的 canonical 构造（或改为委托调用，视 Phase 1/3 实现顺序）
src/lib/codec/anthropic/response-rewrite-adapters.ts  改动 — 新增一条 ResponseRewrite（errorFrameCanonicalize），拦截上游主动 event:error 帧
src/lib/codec/anthropic/strategies.ts     改动（小）— buildAnthropicStrategies 返回值经 error-shaping 的委派过滤器包装
src/lib/pipeline/frame-origin.ts          改动（小）— SyntheticOriginKind 扩两个成员（"error-shaping-auq" / "error-shaping-canonical"）
src/lib/observability/events.ts           改动（小）— FeatureKind 扩若干成员（决策分支 + 委派命中）
src/lib/config/schema.ts                  改动 — 4 新键 zod schema
src/lib/config/config.ts                  改动 — applyConfigToState 4 新键映射
src/lib/state.ts                          改动 — CONFIG_MANAGED_DEFAULTS + setAnthropicBehavior Pick<> + 两处 Record 字段显式 spread

tests/anthropic/error-shaping.unit.test.ts            新增 — 决策矩阵真值表 + AUQ 帧构造 + 委派过滤器单测
tests/anthropic/error-shaping-canonical.unit.test.ts  新增（可与上一个文件合并，视体量而定）— canonical 尾帧构造 + S5 rewrite 单测
tests/anthropic/post-commit-error.unit.test.ts        改动 — 补 error-shaping 收编后的等价性回归
tests/config/error-shaping-config.unit.test.ts        新增 — 4 新键 schema/config/state 三触点 + 热重载
tests/anthropic/error-shaping-golden.http.test.ts     新增 — error_shaping_enabled=false 三终点字节锁 e2e（用 exp/cc-error-retry-surface fake server 复用）
tests/anthropic/error-shaping-auq.http.test.ts        新增 — AUQ 合成端到端（streaming + non-streaming 两种）
tests/anthropic/error-shaping-selfheal-delegate.it.test.ts 新增 — D 类委派 canHandle 过滤 + 6 条自愈腿映射表测试
```

不新增目录层级（`src/lib/anthropic/` 已是既定归属，`recover-refusal.ts`/`keepalive-anchor.ts`/`post-commit-error.ts` 同层先例）。

---

## 3. Phase DAG（依赖关系）

```
Phase 0 (config 三触点)
   │
   ▼
Phase 1 (error-shaping.ts 决策引擎 + canonical 构造 + SyntheticOriginKind/FeatureKind 扩展)
   │
   ├──────────────┬──────────────┬──────────────┐
   ▼              ▼              ▼              ▼
Phase 2        Phase 3        Phase 4        Phase 5
(pre-commit    (post-commit   (B类 AUQ       (D类自愈
 retry-signal)  canonical      合成)          委派)
                尾帧接线)

Phase 2/3/4/5 互相独立，可并行执行（不同文件、不同调用点，唯 Phase 3 与 Phase 5 都涉及 strategies 组装/handler-v4 但改动行不重叠）。

Phase 6 (GATED —— 依赖 block-level P1 Task 6 落地 master)
   仅在 Phase 0-5 全部落地 + P1 Task 6 落地后开工；仅记录契约与验收测试骨架，不在本计划落地日程内强制执行。
```

**独立可交付集合**：Phase 0-5（config + 决策引擎 + pre-commit 信号 + post-commit canonical + AUQ + 委派）——这部分单独交付即可兑现 spec 目标 1/3/4/5 的绝大部分，以及目标 2 的 pre-commit 半部分。
**gated 集合**：Phase 6——只兑现目标 2 的 post-commit 截断类半部分，且实际生效还要求 block-level P1 的 buffered 默认翻转（那由 block-level 计划自己的 G2 门控，不归本计划决定）。

---

## 4. 决策引擎的核心类型草图（细化架构合同，非新决定）

> 以下签名是**局部实现草图**，用于指导 Phase 1 落地，不构成新的公共 API 决定——`ApiError`/`RetryStrategy`/`ResponseRewrite`/`ClientFrame` 等类型本身来自既有代码，未改动。

```ts
// src/lib/anthropic/error-shaping.ts（新文件顶部类型，供 Phase 1 任务参考）

/** 决策引擎的三维输入（纯函数，无 I/O）。*/
export interface ShapingInput {
  error: ApiError                    // ~/lib/error, 11 种 ApiErrorType 之一
  commitPhase: "pre-commit" | "post-commit"
  clientVisibleStopEmitted: boolean  // 含合成 anchor 的 stop；仅 post-commit 有意义
  config: ErrorShapingConfig         // 4 新键的当前值快照（调用方从 state 读出后传入，模块内不读 state）
}

export interface ErrorShapingConfig {
  enabled: boolean                              // error_shaping_enabled
  askUserQuestion: boolean                       // error_ask_user_question
  auqTemplate: string                             // error_auq_template（空 = 内置默认）
  selfhealDelegate: Readonly<Record<string, "proxy" | "delegate">>  // error_selfheal_delegate
}

/** B类问句内容（decide() 已完成 `{error_type}`/`{status}` 第一遍渲染；`{model}`/`{request_id}` 留给 Phase 4 builder 第二遍渲染，两遍复用同一 `renderAuqQuestion`，键不在 vars 里的占位符原样保留——与 `recover-refusal.ts` 的 `renderRefusalTemplate` 同款语义）。*/
export interface AuqQuestion {
  question: string  // 可能仍含未渲染的 {model}/{request_id}
  header: string
  multiSelect: boolean
  options: ReadonlyArray<string>
}

/** 供 decide() B 类分支与 Phase 4 builder 共用的模板渲染器（regex 语义与 `recover-refusal.ts` 的 `renderRefusalTemplate` 一致：`key in vars` 才替换，否则保留原始 `{key}` 字面量——藉此支持「分两遍、传互补的 vars 子集」）。占位符集合固定为 spec 给定的 `{model}`/`{request_id}`/`{error_type}`/`{status}`（单花括号，无 `{message}`）。*/
export function renderAuqQuestion(tmpl: string, vars: Partial<{ model: string; request_id: string; error_type: string; status: string }>): string { /* Phase 1 任务 1.4 */ }

/** 决策引擎的输出——四类之一，调用方据此执行写入/委派动作。*/
export type ShapingDecision =
  | { kind: "retry-signal"; retryAfterSec?: number; shouldRetryHeader?: boolean }  // A类 pre-commit
  | { kind: "ask-user-question"; questions: ReadonlyArray<AuqQuestion> }           // B类
  | { kind: "canonical-error"; errorType: string; message: string; retryAfterSec?: number }  // C类
  | { kind: "defer-to-block-level" }  // A类 post-commit 截断/RST（G-4 gated，Phase 6 消费）

/** 决策引擎实际在纯函数边界内能拿到的字段只有 ApiError（error.type/error.status），故 B 类分支内调用 renderAuqQuestion 只完成第一遍渲染 + 按 errorType 分派 options（Phase 1 任务 1.4）。*/
export function decide(input: ShapingInput): ShapingDecision { /* Phase 1 实现 */ }

/** 收编 streaming-pump.ts 的 anthropicStreamErrorType；canonical 尾帧的唯一构造入口（G-3）。*/
export function buildCanonicalErrorFrame(decision: Extract<ShapingDecision, { kind: "canonical-error" }>): ClientFrame { /* Phase 1 */ }

/** B类：pre-commit 整段合成（streaming 与 non-streaming 两个变体，镜像 recover-refusal.ts 的既有拆分模式；内部对 decision.questions 的每一项做第二遍 renderAuqQuestion 渲染 {model}/{request_id}）。*/
export function buildAskUserQuestionFrames(decision: Extract<ShapingDecision, { kind: "ask-user-question" }>, ctx: { model: string; reqId: string }): Array<ClientFrame> { /* Phase 4 */ }
export function buildAskUserQuestionResponse(decision: Extract<ShapingDecision, { kind: "ask-user-question" }>, ctx: { model: string; reqId: string }): AnthropicMessageResponse { /* Phase 4 */ }

/** D类：按策略名过滤 canHandle，委派透传的策略永远返回 false。RetryStrategy 是 `~/lib/pipeline/types.ts:123` 的非泛型 v4 接口（无 TPayload 类型参数——探索代码后确认，早期草图误写成泛型，已按代码订正）。*/
export function filterDelegatedStrategies(strategies: ReadonlyArray<RetryStrategy>, delegateConfig: Readonly<Record<string, "proxy" | "delegate">>, onDelegated?: (strategyName: string) => void): ReadonlyArray<RetryStrategy> { /* Phase 5 */ }
```

（`ANTHROPIC_RESPONSE_REWRITES` 数组的具体拼装等更细节留给 Phase 3 任务内展开。）

---

## 5. Spec 验收标准覆盖映射（反-YAGNI 核对表）

| Spec 验收标准（原文摘录） | 覆盖 Phase / 任务 | 备注 |
|---|---|---|
| AC1：pre-commit 可重试错误（429/503-upstream/5xx/network_error）触发真实 `Retry-After` 头 + 可选 `x-should-retry` | Phase 2 全部 | forward.ts 目前只写 body，不写头（已核实 forward.ts:497-541 从无头写入）——本计划新增 |
| AC2：402/content_filtered/403(耗尽 token-refresh) 在 `error_ask_user_question=true` 时合成 AUQ 成功轮次，401 先走既有 token-refresh 不弹问 | Phase 1 任务 1.1/1.4（`decide()` 真值表 + questions 内容构造）+ Phase 2（route.ts 唯一入口，401 未耗尽 token-refresh 时从不产生 `ApiError` 走到这里）+ Phase 4（AUQ 序列化/接线） | **订正（自审发现）**：401/403 的分流**不是**由 Phase 4 内的显式 `.status` 判断实现的——`decide()`（Phase 1）对到达它的 401/403 一视同仁（`auth_expired` 统一处理）；真正的"401 先走 token-refresh 不弹问"是**call-site 时机**保证的既有架构不变量（token-refresh `RetryStrategy` 在更早的重试层已经拦截并消化了"尚未耗尽"的 401，只有耗尽后才会以 `ApiError` 形式到达 route.ts 的 pre-commit catch），非本计划新实现的判断逻辑，只是被本计划的真值表测试（Phase 1 `test.each([401,403])`）显式锁定为回归不变量。早期草稿曾错误地把这个分流职责记在"Phase 4 任务 4.2"，已在本轮自审中订正。 |
| AC3：post-commit 上游主动 `event:error` 帧被 canonical 化（吸收 anthropicStreamErrorType），不尝试推客户端重试 | Phase 1（构造函数）+ Phase 3（接线到 S5 rewrite） | 见「探索新发现」，接线点是 rewrite 链非 H2 分支事后 |
| AC4：post-commit 截断类可重试错误重放，依赖 block-level P1 | Phase 6（GATED，已写契约+验收骨架，`describe.skip` 未开工） | G-4，本计划不实现，只记契约；开工前置条件 = block-level P1 Task 6 落地 master（见 `phase-6-gated-postcommit-truncation.md` 开工检查清单） |
| AC5：D 类自愈委派按反应式策略名可配置，6 条腿映射表 | Phase 5 全部 | media-strip 无对应策略，delegate-only，测试须覆盖该边界 |
| AC6：所有合成物（AUQ/canonical/委派透传）在 forwarded 轨打 `synthetic` 标记，History 永远记真实上游错误 | Phase 1（`SyntheticOriginKind` 扩展）+ Phase 3/4 各自的 `tagFrameSynthetic` 调用 + 每个 Phase 的 history 断言测试 | `writeSynthetic` 类帧不进任一轨——Phase 3 显式测试断言这一豁免不是遗漏 |
| 非目标：OpenAI/Gemini/Azure 不变 | 全程守卫 | 每个 Phase 任务清单末尾都有「未改动 openai-cc/openai-responses 目录」检查项 |
| 非目标：aborted 不介入 | Phase 1 决策矩阵真值表显式包含 `aborted → 不出现在 decide() 的可处理分支`（走既有 handler abort 路径，见 handler-v4.ts:542-559/1164-1170） | 用一条测试固化「error-shaping 从不处理 aborted」 |
| 非目标：不引入 TCP-reset 关闭技巧 / 不做 post-commit 客户端重试尝试 | Phase 1 决策矩阵 + 设计注释 | `decide()` 对 post-commit 截断/RST 一律返回 `defer-to-block-level`，不合成 overloaded_error/api_error 试图推客户端 |
| 配置面 4 键 + 热重载 + 无迁移负担 | Phase 0 全部 | 三触点 + `config-hot-reload.it.test.ts` 同款热重载回归 |
| 遥测（spec 标注「可选，plan 定」）| Phase 1（FeatureKind 扩展）+ 各 Phase 对应 `recordFeature` 调用 | 按项目 `dont-postpone-nonfunctional-needs` 原则计划采纳为必做而非可选，见下方「未采纳方案」无对应项——此处是「采纳」记录 |

---

## 6. 自审（Self-Review）

> 本节已在全部 7 份文档（Phase 0-6 + kickoff）完成落盘后重新核验一遍，下方记录本轮（撰写 Phase 3-6 + kickoff 期间）新发现并修正的问题，供评审者知悉这些问题已经被撰写者自己发现和处理，不需要评审重复指出。

- **占位符检查（全量重跑）**：对 `README.md` + 全部 7 份 Phase/kickoff 文档 grep `{{`/`TODO`/`FIXME`/裸 `...`，命中的全部逐条核实：`phase-1-error-shaping-core.md` 的 `{{message}}` 出现在"断言默认模板**不含**该占位符"的测试断言里（合规）；`phase-2-precommit-retry-signal.md:88` 的 `// ask-user-question: Phase 4 TODO` 是 Phase 2 minimal 实现里合法的"本任务不处理、留给 Phase 4"的代码注释，且 Phase 4 现已实际落地对应实现，该注释描述的缺口已被后续 Phase 补齐，不是遗留占位；`phase-4-askuserquestion.md:8` 的 `{{message}}` 出现在"记录早期草稿曾经的错误写法"的说明段落里（合规，非遗留错误）；其余命中均为省略号在自然语言解释性文字或代码字面量（`Pick<MutableState, ...>`/`{ ...strategy }`/`{ ...extra }`/mock body 里的 `"...system role..."`）里的正常用法。**结论：无遗留占位符。**
- **类型一致性（跨全部 7 份文档终检）**：`decide()`/`ShapingDecision`/`ShapingInput`/`ErrorShapingConfig`/`AuqQuestion`/`renderAuqQuestion`/`buildCanonicalErrorFrame`/`buildAskUserQuestionFrames`/`buildAskUserQuestionResponse`/`filterDelegatedStrategies` 十个符号的签名在 README 第 4 节类型草图与 Phase 1/2/3/4/5 各自的"最小实现"代码块之间逐一比对，确认完全一致（本轮已修正两处历史漂移，见下）。
- **本轮新发现并修正的问题（撰写 Phase 3-6 期间）**：
  1. **README 类型草图 `decide()` 重复定义 + `filterDelegatedStrategies` 泛型误写**——插入 `AuqQuestion`/`renderAuqQuestion` 定义时一度产生 `decide()` 两次定义的编辑错误，且早期草图把非泛型的 `RetryStrategy`（`~/lib/pipeline/types.ts:123-139` 实测确认无 `TPayload` 类型参数）误写成带泛型的签名。已在第 4 节重新组织并订正，注释里保留"早期草图误写成泛型，已按代码订正"以便评审对照。
  2. **README 第 7 节 Phase 文件索引链接名与实际/目标文件名不符**——`phase-3-postcommit-canonical-wiring.md`/`phase-4-auq-synthesis.md`/`phase-6-blocklevel-integration-GATED.md` 三处链接已更正为实际落盘的文件名 `phase-3-postcommit-canonical-frame.md`/`phase-4-askuserquestion.md`/`phase-6-gated-postcommit-truncation.md`。
  3. **Phase 1 缺一个任务把 `decide()` B 类分支的 `AuqQuestion[]` 内容真正构造出来**——原真值表任务只断言 `d.kind`，未构造 `questions` 字段的真实内容，而 `ShapingInput` 又缺 `model`/`request_id` 无法一遍完成 spec 要求的 4 占位符渲染。已新增任务 1.4，设计"两遍渲染"（`decide()` 完成 `{error_type}`/`{status}`，Phase 4 builder 完成 `{model}`/`{request_id}`，两遍复用同一 `renderAuqQuestion`，语义与既有 `renderRefusalTemplate` 一致），不需要改动 `ShapingInput` 契约本身。
  4. **Phase 4 早期草稿函数命名/参数形状与 README 定稿签名不一致 + 占位符语法错误**——早期草稿用过 `buildAuqStreamFrames`/`buildAuqWholeResponse`/flat-args 版 `renderAuqQuestion({errorType,message})`，且误用 `{{message}}`/不存在的 `message` 字段。已整篇重写，对齐 README 的 `buildAskUserQuestionFrames`/`buildAskUserQuestionResponse` decision-based 签名，移除 Phase 4 自建的模板/options 构造逻辑（移交 Phase 1 任务 1.4），Phase 4 现在只做"消费 `decision.questions` + 第二遍渲染 + 序列化为 SSE 帧/整体响应 + HTTP 层接线"。
  5. **README 第 5 节 AC2 覆盖表行归因错误**——原表把"401/403 分流"归到"Phase 4 任务 4.2"，但探索确认这个分流是**既有架构的 call-site 时机不变量**（token-refresh `RetryStrategy` 在更早层级已消化未耗尽的 401，`decide()`/Phase 4 都不做显式 `.status` 判断），已订正归因到 Phase 1（真值表锁定该不变量）+ Phase 2（route.ts 唯一入口位置）。
- **spec 覆盖完整性**：见第 5 节表格，6 条验收标准 + 3 条非目标 + 配置面 + 遥测均有对应 Phase/任务，无静默删除或降级；AC4/Phase 6 是唯一"记契约不实现"的一行，且已在 README 第 0-1 节 + Phase 6 文档本身反复声明这是 spec G-4 明确认可的门控状态，非本计划自行收窄范围。
- **未采纳方案记录**（延续前述 + 本轮新增）：
  - 运行时启发式探测 interactive/headless（D-0 选项 2）——不采纳，无可靠信号源，见 D-0。
  - 新增客户端请求头协议来上报会话模式（D-0 选项 3）——不采纳，超出"不改客户端协议"的非目标边界。
  - 把 canonical 尾帧整形放在 H2/H3 分支内"事后补写"而非 S5 rewrite 链前置拦截——不采纳，帧已上线不可撤回（见「探索新发现」）。
  - `error_selfheal_delegate` 值类型曾考虑 `z.record(z.string(), z.array(z.string()))`（对齐 `tool_repair_malformed_input` 的多值模式）——不采纳，本键语义是二选一（proxy/delegate），`z.record(z.string(), z.enum(["proxy","delegate"]))` 更贴合语义且校验更严格。
  - **（本轮新增）Phase 6 提前用 mock/fake 谓词抢先实现截断重放接线逻辑**——不采纳，P1 的具体谓词形状未定，抢先 mock 大概率在 P1 落地后需要整体重写，留到 P1 落地后一次性做对（详见 Phase 6 文档「未采纳方案」）。
  - **（本轮新增）本计划自行实现 spec 第 111 行提到的"anchor close/open 分叉改造"**——不采纳，spec 原文明确该改造归 block-level P1 所有，本特性边界止于"canonical 化终局尾帧"，越界实现会模糊两个 spec 的职责边界。
- **待主会话/用户裁决项**：见第 0 节 D-0 / D-0.5，均为"有推荐值的开放项"，不阻塞 Phase 0-5 开工。

---

## 7. 各 Phase 文档索引

- [phase-0-config-scaffolding.md](./phase-0-config-scaffolding.md) — config 三触点新增 4 键
- [phase-1-error-shaping-core.md](./phase-1-error-shaping-core.md) — 决策引擎 + canonical 构造 + 收编 anthropicStreamErrorType + 类型扩展
- [phase-2-precommit-retry-signal.md](./phase-2-precommit-retry-signal.md) — pre-commit A 类 retry-signal 接线 forward.ts
- [phase-3-postcommit-canonical-frame.md](./phase-3-postcommit-canonical-frame.md) — post-commit 终点①②接线 + S5 rewrite + golden 字节锁
- [phase-4-askuserquestion.md](./phase-4-askuserquestion.md) — B 类 AskUserQuestion 合成
- [phase-5-selfheal-delegation.md](./phase-5-selfheal-delegation.md) — D 类自愈委派
- [phase-6-gated-postcommit-truncation.md](./phase-6-gated-postcommit-truncation.md) — （gated，仅契约与验收骨架）
- [kickoff.md](./kickoff.md) — 可复制的开工提示词
