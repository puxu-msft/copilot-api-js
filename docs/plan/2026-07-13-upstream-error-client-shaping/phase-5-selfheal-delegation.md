# Phase 5 —— D 类自愈委派（`filterDelegatedStrategies`）

# Phase 5 —— D 类自愈委派（`filterDelegatedStrategies`）

> **评审 HIGH-3 共享文件提示**：本 Phase 在 `error-shaping.ts` 追加 `filterDelegatedStrategies`（任务见下方"最小实现：`error-shaping.ts` 内新增"）+ 编辑 `handler-v4.ts` 的 `buildMessagesDriverStrategies`（258-288 行）。这两个文件同时被 Phase 3（post-commit 收编）+ Phase 4（AUQ 接线）追加/编辑，**不是"不共享运行时函数、可并行"的独立单元**——原草稿此处的独立性表述有误，已订正：建议按 3→4→5 顺序串行落地，或各自开隔离 worktree 后按文件段合并，合并前人工核对 diff 有无相邻行覆盖。详见 README §3 Phase DAG「订正」段。

**依赖**：Phase 0（`state.errorSelfhealDelegate` / `state.errorShapingEnabled`）、Phase 1（`error-shaping.ts` 已建立的模块骨架 + `FeatureKind`/`SyntheticOriginKind` 类型面）。**订正**：本 Phase 与 Phase 3/4 共享 `error-shaping.ts`/`handler-v4.ts` 两个文件的追加/编辑面，不是相互独立、不建议直接并行（见上方提示）。

**不依赖 block-level P1**：D 类委派纯粹作用于 pre-commit 反应式重试策略层（策略装配 `assembleStrategiesForEndpoint` 只在 pre-commit 阶段跑一次，产出的重试决策发生在 200 头尚未发出之前），与 post-commit 截断/G-4 排序前提无关。

## 探索确认的关键事实（写在前面，供实现者不必重新反向工程）

1. **策略装配调用链**（本 Phase 唯一需要接线的位置）：

   ```
   handler-v4.ts:323  strategies: (env) => buildMessagesDriverStrategies(env, { codec, betaProbe })
                          │
   handler-v4.ts:258-288 buildMessagesDriverStrategies(env, deps)
                          │  if (env.targetEndpoint === ENDPOINT.MESSAGES) {          ← 唯一 Anthropic-Messages 直连分支（263 行）
                          │    return assembleStrategiesForEndpoint(env.targetEndpoint, { anthropic: {...} })
                          │  }
                          │  // 否则是 forward-translate 腿（anthropic→cc/responses），本 Phase 不碰
                          │
   strategy-registry.ts:75-96  assembleStrategiesForEndpoint()
                          │  case ENDPOINT.MESSAGES: return buildAnthropicStrategies(supply.anthropic)
                          │
   anthropic/strategies.ts:87-124  buildAnthropicStrategies(deps) → 15 个 `adapt(create*Strategy())` 平铺数组
   ```

   `env.targetEndpoint === ENDPOINT.MESSAGES` 这个 if 分支（`handler-v4.ts:263`）**恰好就是 spec 约束 3「只接入 Anthropic Messages 路径」画的那条线**——同一个 `buildMessagesDriverStrategies` 函数下面还有一段（279-287 行）服务于 forward-translate 到 CC/Responses 的腿，那段绝对不能碰。

2. **接线层选择：在 `handler-v4.ts` 里包裹，而非改 `strategy-registry.ts` / `anthropic/strategies.ts`。** 理由：
   - `strategy-registry.ts` 与 `anthropic/strategies.ts` 是**跨 Phase/跨特性共享的装配基础设施**（`assembleStrategiesForEndpoint` 同时服务 CC/Responses 腿；`buildAnthropicStrategies` 的文件头注释明确它是"镜像 legacy 顺序"的稳定契约），把一个特性专属的 D 类过滤塞进去会让这两个文件承担不属于它们的职责，且会波及 forward-translate 腿（违反约束 3）。
   - `buildMessagesDriverStrategies` 已经在 `env.targetEndpoint === ENDPOINT.MESSAGES` 分支内部读取了 `state.maxReactiveRetries` 并显式传入 `deps.anthropic.maxRetries`——**本项目既有惯例是"在调用点读 state、以显式参数下传"，而不是让被调用的纯装配函数自己读全局 state**。D 类过滤延续同一惯例：在 `buildMessagesDriverStrategies` 内、`assembleStrategiesForEndpoint` 返回之后，追加一层 `filterDelegatedStrategies(strategies, state.errorSelfhealDelegate, onDelegated)` 包装，零改动 `strategy-registry.ts` 和 `anthropic/strategies.ts`。

3. **`canHandle(error: ApiError): boolean` 拿不到 `env`/`ctx`**（`~/lib/pipeline/types.ts:123-128`：`RetryStrategy` 接口里只有 `handle(error, env)` 和 `onResolved?(env, meta?)` 带 `env` 参数，`canHandle` 只有 `error` 一个参数）。这意味着委派发生的 telemetry（`recordFeature("error-shaping-selfheal-delegated", ...)`）**不能在 `canHandle` 内部直接调 `env.ctx.recordFeature`**——因为压根拿不到 `ctx`。

   解法：`filterDelegatedStrategies` 设计为**纯函数 + 回调注入**（不内嵌 `ctx` 依赖，保持 `error-shaping.ts` 对 `~/lib/context/*` 零耦合）：
   ```ts
   export function filterDelegatedStrategies(
     strategies: ReadonlyArray<RetryStrategy>,
     delegateConfig: Readonly<Record<string, "proxy" | "delegate">>,
     onDelegated?: (strategyName: string) => void,
   ): ReadonlyArray<RetryStrategy>
   ```
   包裹后的 `canHandle`：先调用原始 `canHandle(error)`；若返回 `true`（说明这条 400 本来会被这条反应式策略吃掉），才触发 `onDelegated?.(strategy.name)` 并强制返回 `false`（放行给客户端自愈）；若原始 `canHandle` 返回 `false`（这条策略本来就不管这个错误），照原样返回 `false`，不触发回调——避免把"不相关的 canHandle 探测"误记成"委派命中"。

   调用点 `buildMessagesDriverStrategies`（**有** `env.ctx`，见 `env: RequestEnvelope` 且 `RequestEnvelope.ctx: RequestContext`，其它腿如 `gemini/handler-v4.ts:137`、`routes/responses/ws.ts:239` 已有 `env.ctx.recordFeature(...)` 先例）把回调闭包指向 `env.ctx.recordFeature`：
   ```ts
   onDelegated: (strategyName) => env.ctx.recordFeature("error-shaping-selfheal-delegated", { strategyName })
   ```

4. **spec 示例策略名字面值与代码 `.name` 不一致，按代码为准（此处代码已把答案钉死）**。spec 第 97 行 `error_selfheal_delegate` 举例键写的是 `"adaptive-thinking-rejection"` / `"tool-field-rejection"`（无 `-retry` 后缀），但本计划 Phase 0-4 探索期已 grep 全部 15 个反应式策略文件逐一确认，它们的 `.name` 字段**全部带 `-retry` 后缀**（如 `"adaptive-thinking-rejection-retry"`、`"tool-field-rejection-retry"`）。`filterDelegatedStrategies` 按 `strategy.name` 精确字符串匹配 `delegate` 的 key，这是运行时唯一可行的匹配依据——因此**配置键必须使用代码 `.name` 字段的精确字符串**，spec 示例文本的字面差异只是措辞不精确，不构成设计分叉，不阻塞本 Phase。文档面板（README/user-facing docs，若有）应向用户注明这一点，避免用户抄 spec 示例配置后委派静默不生效（`delegate[strategy.name]` 查不到键时 `filterDelegatedStrategies` 视为 `"proxy"` 默认值，不报错——这是 D-1 已定案的宽松语义，见任务 5.1 测试）。

5. **6 条 D 类映射表**（spec 第 79-86 行，转录供任务 5.2 测试直接取用）：

   | CC 自愈腿 | 对应 proxy 反应式策略 `.name`（代码实际字符串） | 委派是否有实测依据 |
   |---|---|---|
   | `retry:thinking-signature-strip` | `adaptive-thinking-rejection-retry` / `legacy-thinking-retry` | 端到端 sig-conv 实测（conns=3） |
   | `retry:thinking-type` | 同上 | 端到端实测（conns=2） |
   | `retry:mid-conv-system` | `system-reject-retry` | 源码确证 |
   | `retry:cache-diagnosis-beta` / `prompt-caching-evict-beta` | `unsupported-beta-retry` | 源码确证 |
   | `retry:foundry-capability-strip` / `server-fallback-strip` | `structured-outputs-rejection-retry` / `tool-field-rejection-retry` | 源码确证 |
   | `retry:media-strip` | **无对应 proxy 策略** | 仅 delegate 一条路，无 `"proxy"` 选项可用 |

   最后一行是本 Phase 唯一需要特殊处理的边界：`media-strip` 场景没有反应式策略可委派/可代理——因为 proxy 侧压根没有实现"剥离媒体内容重试"这个策略。`error_selfheal_delegate` 里不会出现它的 key（没有策略 `.name` 叫这个），委派机制对它天然是空操作。任务 5.3 用一条显式边界测试锁定"该腿没有映射目标，`filterDelegatedStrategies` 不会因為找不到对应策略而报错或影响其它策略"这一不变量。

6. **M-1 边界（spec 第 88 行）**：`filterDelegatedStrategies` 只作用于**反应式** `RetryStrategy[]` 数组（`assembleStrategiesForEndpoint` 的返回值），不触碰 thinking-signature 的 **always-on 预飞 sanitize（quarantine，S3，发上游之前就跑）**。Quarantine 不是 `RetryStrategy`，它在 codec `parse`/`prepare` 阶段执行，不出现在 `buildAnthropicStrategies` 返回的数组里，因此 `filterDelegatedStrategies` 的 `strategies.map(...)` 天然不可能碰到它——这是数据结构层面的隔离，不需要额外的排除逻辑，只需要一条回归测试断言"quarantine 阶段产生的 sanitize 结果不受 `error_selfheal_delegate` 配置影响"（任务 5.3）。

## 任务 5.1：`filterDelegatedStrategies` 核心行为

- [ ] 写失败测试（新建 `tests/anthropic/error-shaping-selfheal.unit.test.ts`）：
  ```ts
  import { describe, expect, test } from "bun:test"

  import type { ApiError } from "~/lib/error"
  import type { RetryStrategy } from "~/lib/pipeline/types"

  import { filterDelegatedStrategies } from "~/lib/anthropic/error-shaping"

  const mk = (type: string, status: number): ApiError => ({ type: type as never, status, message: "boom", raw: null })

  function fakeStrategy(name: string, matches: boolean): RetryStrategy {
    return {
      name,
      canHandle: () => matches,
      handle: async () => ({ kind: "abort" }) as never,
    }
  }

  describe("filterDelegatedStrategies", () => {
    test("delegate=proxy(default/omitted key) → canHandle 行为不变", () => {
      const strategies = [fakeStrategy("system-reject-retry", true)]
      const filtered = filterDelegatedStrategies(strategies, {})
      expect(filtered[0]?.canHandle(mk("bad_request", 400))).toBe(true)
    })

    test("delegate=\"delegate\" 且原 canHandle 本来会命中 → 强制返回 false", () => {
      const strategies = [fakeStrategy("system-reject-retry", true)]
      const filtered = filterDelegatedStrategies(strategies, { "system-reject-retry": "delegate" })
      expect(filtered[0]?.canHandle(mk("bad_request", 400))).toBe(false)
    })

    test("delegate=\"delegate\" 但原 canHandle 本来就不命中 → 仍返回 false，且不触发 onDelegated 回调", () => {
      const strategies = [fakeStrategy("system-reject-retry", false)]
      const hits: Array<string> = []
      const filtered = filterDelegatedStrategies(strategies, { "system-reject-retry": "delegate" }, (name) => hits.push(name))
      expect(filtered[0]?.canHandle(mk("bad_request", 400))).toBe(false)
      expect(hits).toEqual([])
    })

    test("delegate=\"delegate\" 且命中 → onDelegated 回调收到策略名，且只在真正命中时触发一次", () => {
      const strategies = [fakeStrategy("system-reject-retry", true)]
      const hits: Array<string> = []
      const filtered = filterDelegatedStrategies(strategies, { "system-reject-retry": "delegate" }, (name) => hits.push(name))
      filtered[0]?.canHandle(mk("bad_request", 400))
      expect(hits).toEqual(["system-reject-retry"])
    })

    test("delegate 里出现不存在的策略名（不匹配任何 .name）→ 静默忽略，不报错、不影响其它策略", () => {
      const strategies = [fakeStrategy("system-reject-retry", true)]
      expect(() => filterDelegatedStrategies(strategies, { "not-a-real-strategy": "delegate" })).not.toThrow()
      const filtered = filterDelegatedStrategies(strategies, { "not-a-real-strategy": "delegate" })
      expect(filtered[0]?.canHandle(mk("bad_request", 400))).toBe(true)
    })

    test("handle/onResolved 透传不变（只包装 canHandle）", () => {
      const strategies = [fakeStrategy("system-reject-retry", true)]
      const filtered = filterDelegatedStrategies(strategies, { "system-reject-retry": "delegate" })
      expect(filtered[0]?.handle).toBe(strategies[0]?.handle)
    })

    test("空 delegate 映射 + 空策略数组 → 原样返回（长度/引用穿透测试）", () => {
      expect(filterDelegatedStrategies([], {})).toEqual([])
    })
  })
  ```
- [ ] 跑测试确认红
- [ ] 最小实现：`error-shaping.ts` 内新增
  ```ts
  export function filterDelegatedStrategies(
    strategies: ReadonlyArray<RetryStrategy>,
    delegateConfig: Readonly<Record<string, "proxy" | "delegate">>,
    onDelegated?: (strategyName: string) => void,
  ): ReadonlyArray<RetryStrategy> {
    return strategies.map((strategy) => {
      if (delegateConfig[strategy.name] !== "delegate") return strategy
      return {
        ...strategy,
        canHandle(error) {
          const wouldHandle = strategy.canHandle(error)
          if (wouldHandle) onDelegated?.(strategy.name)
          return false
        },
      }
    })
  }
  ```
  （`RetryStrategy` 类型从 `~/lib/pipeline/types` import；注意该接口非泛型，`canHandle(error: ApiError): boolean` 不含 `env`，`handle`/`onResolved` 原样透传不需要重新绑定 `this`，因为两者本身不是箭头函数依赖闭包之外的 `this`——`adaptLegacyStrategy` 产出的对象内部方法不依赖外部 `this` 绑定，`{...strategy, canHandle: ...}` 展开是安全的）
- [ ] 确认绿
- [ ] 提交（`feat: add filterDelegatedStrategies for D-class self-heal delegation`）

## 任务 5.2：`buildMessagesDriverStrategies` 接线（仅 Anthropic Messages 分支）

- [ ] 写失败测试（新建或追加 `tests/routes/messages/handler-v4-selfheal-delegation.integration.test.ts`，用 `test-isolation` skill 的 `useIsolatedRuntime` + `exp/cc-error-retry-surface` fake server harness 起端到端上游桩）：
  ```ts
  import { describe, expect, test } from "bun:test"

  import { useIsolatedRuntime } from "~/../tests/support/test-isolation" // 精确导出名以现有 skill 用例为准
  import { state } from "~/lib/state"

  describe("buildMessagesDriverStrategies — D 类委派仅作用于 ENDPOINT.MESSAGES 直连腿", () => {
    test("state.errorSelfhealDelegate 命中 system-reject-retry → 400 直接透传给客户端，不触发 proxy 侧 resanitize 重试", async () => {
      await useIsolatedRuntime(async ({ fakeUpstream, callMessages }) => {
        state.errorSelfhealDelegate = { "system-reject-retry": "delegate" }
        fakeUpstream.mockOnce({ status: 400, body: { error: { message: "...system role not allowed mid-conversation..." } } })
        const res = await callMessages({ stream: false, messages: [/* 触发 system-reject 匹配的构造 */] })
        expect(res.status).toBe(400) // 未被 proxy 侧吃掉重试，原样是 400（对照组：delegate 未命中时 proxy 会重试到 200）
        expect(fakeUpstream.callCount).toBe(1) // 只打了一次上游，没有 reactive retry 的第二次请求
      })
    })

    test("state.errorSelfhealDelegate = {}（默认）→ 行为与 Phase 5 之前完全一致（回归锁）", async () => {
      await useIsolatedRuntime(async ({ fakeUpstream, callMessages }) => {
        state.errorSelfhealDelegate = {}
        fakeUpstream.mockOnce({ status: 400, body: { error: { message: "...system role not allowed mid-conversation..." } } })
        fakeUpstream.mockOnce({ status: 200, body: {/* 正常响应 */} }) // resanitize 重试后应该拿到这条
        const res = await callMessages({ stream: false, messages: [/* 同上 */] })
        expect(res.status).toBe(200)
        expect(fakeUpstream.callCount).toBe(2)
      })
    })

    test("forward-translate 腿（env.targetEndpoint !== ENDPOINT.MESSAGES）不受 state.errorSelfhealDelegate 影响（约束 3 回归锁）", async () => {
      // 构造一个 @cc/@responses 后缀模型触发 forward-translate，断言其反应式策略数组未经 filterDelegatedStrategies 包装
      // 最小验证手法：spy `assembleStrategiesForEndpoint` 或直接断言 CC 腿即使配置同名 key 也不改变命中行为
    })
  })
  ```
  （fake server harness 的具体桩接口以 `exp/cc-error-retry-surface/` 现有 PoC 代码为准；若命名与草稿不完全一致，实现者应对照该目录实际导出调整，不视为阻塞）
- [ ] 跑测试确认红
- [ ] 最小实现：`handler-v4.ts` 的 `buildMessagesDriverStrategies`（258-288 行）里，仅在 `ENDPOINT.MESSAGES` 分支内追加委派过滤：
  ```ts
  export function buildMessagesDriverStrategies(
    env: RequestEnvelope,
    deps: { codec: ReturnType<typeof createAnthropicCodec>; betaProbe: ReturnType<typeof createBetaProbe> },
  ): ReadonlyArray<RetryStrategy> {
    const { codec, betaProbe } = deps
    if (env.targetEndpoint === ENDPOINT.MESSAGES) {
      const resanitize = codec.getResanitize()
      if (!resanitize) throw new Error("[Anthropic:v4] resanitize chain unavailable — codec.parse did not run")
      const strategies = assembleStrategiesForEndpoint(env.targetEndpoint, {
        anthropic: { originalPayload: codec.getTruncateBaseline() ?? (env.body as MessagesPayload), resanitize, model: env.model as Model | undefined, maxRetries: state.maxReactiveRetries, betaProbe },
      })
      if (!state.errorShapingEnabled) return strategies
      return filterDelegatedStrategies(strategies, state.errorSelfhealDelegate, (strategyName) =>
        env.ctx.recordFeature("error-shaping-selfheal-delegated", { strategyName }),
      )
    }
    // FORWARD translate leg (anthropic→cc/responses) — 约束 3：委派机制不覆盖此分支，原样不变
    return assembleStrategiesForEndpoint(env.targetEndpoint, {
      cc: { originalPayload: env.body as ChatCompletionsPayload, model: env.model as Model | undefined, maxRetries: state.maxReactiveRetries, label: env.targetEndpoint === ENDPOINT.RESPONSES ? "Anthropic(→Responses)" : "Anthropic(→CC)" },
    })
  }
  ```
  追加 `import { filterDelegatedStrategies } from "~/lib/anthropic/error-shaping"`。
- [ ] 确认绿
- [ ] 提交（`feat: wire D-class self-heal delegation into ENDPOINT.MESSAGES strategy assembly`）

## 任务 5.3：边界测试——media-strip 无映射 + quarantine 隔离

- [ ] 写失败测试（追加 `tests/anthropic/error-shaping-selfheal.unit.test.ts`）：
  ```ts
  describe("D 类映射表边界", () => {
    test("media-strip 场景无对应 proxy 策略 .name —— error_selfheal_delegate 配置里不存在这个 key 是预期常态，不是配置缺陷", () => {
      // 文档性回归：全量 grep 15 个反应式策略 .name，确认没有一个策略名字面含义等价于「剥离媒体内容重试」
      const knownStrategyNames = [
        "network-retry", "server-error-retry", "token-refresh", "effort-learning-retry",
        "tool-field-rejection-retry", "body-field-rejection-retry", "cache-control-subfield-rejection-retry",
        "legacy-thinking-retry", "adaptive-thinking-rejection-retry", "unsupported-beta-retry",
        "server-tool-rejection-retry", "structured-outputs-rejection-retry", "system-reject-retry",
        "web-search-not-found-retry", "deferred-tool-retry",
      ]
      expect(knownStrategyNames.some((n) => n.includes("media"))).toBe(false)
    })

    test("quarantine（always-on 预飞 thinking-signature sanitize）不出现在 assembleStrategiesForEndpoint 返回数组里，filterDelegatedStrategies 天然碰不到它", () => {
      // 断言手法：对 buildAnthropicStrategies 的真实返回数组做 .name 枚举，确认没有一项 name 含 "quarantine" 或 "sanitize"
      // （quarantine 逻辑位于 codec resanitize 链，不是 RetryStrategy，这条测试是「数据结构层面互不相交」的存在性证明）
    })

    test("即使 error_selfheal_delegate 里出现语义上指向 quarantine 的 key（用户误配），也不影响 resanitize 结果 —— filterDelegatedStrategies 只改 canHandle，quarantine 走独立代码路径", () => {
      // 端到端：state.errorSelfhealDelegate = { "thinking-signature-quarantine": "delegate" }（一个不存在的 key）
      // 断言 poisoned-thinking 端到端场景下 quarantine 依旧按原逻辑剥离 signature，不受此配置影响
    })
  })
  ```
- [ ] 跑测试确认红
- [ ] 最小实现：本任务预期**不需要新增产品代码**——上述断言应该在任务 5.1/5.2 实现完成后自然为真（这是"确认既有设计天然满足不变量"的回归锁，而非新功能）。若跑出来红，说明 5.1/5.2 的实现有泄漏，需回头修正而不是在此任务里打补丁绕过。
- [ ] 确认绿
- [ ] 提交（`test: lock D-class boundary invariants (media-strip no-mapping, quarantine isolation)`）

## Phase 5 完成检查

- [ ] `bun run typecheck` 全绿
- [ ] `bunx eslint src/lib/anthropic/error-shaping.ts src/routes/messages/handler-v4.ts tests/anthropic/error-shaping-selfheal.unit.test.ts`
- [ ] 确认 `error-shaping.ts` 顶部 import 依旧不含任何 `~/routes/*` / `~/lib/context/*` 路径（`filterDelegatedStrategies` 的 `onDelegated` 回调保持"调用方注入"，不在纯模块内部 import `RequestContext` 类型都不需要，只需 `(name: string) => void` 函数签名）
- [ ] 确认约束 3 回归：forward-translate 腿（`ENDPOINT.CHAT_COMPLETIONS`/`ENDPOINT.RESPONSES`/`ENDPOINT.WS_RESPONSES`）路径零改动，`strategy-registry.ts`/`anthropic/strategies.ts` 零改动（`git diff --stat` 确认这两个文件不在改动列表里）
- [ ] 确认 `FeatureKind` 的 `"error-shaping-selfheal-delegated"`（Phase 1 任务 1.3 已扩类型）在本 Phase 被真正调用到（非死类型），`grep -rn "error-shaping-selfheal-delegated" src/` 应同时命中类型声明处与本 Phase 的 `recordFeature` 调用处
