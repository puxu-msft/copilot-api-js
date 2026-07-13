# Phase 4：B 类 AskUserQuestion 合成（pre-commit 整段合成）

> **评审 HIGH-3 共享文件提示**：本 Phase 在 `error-shaping.ts` 追加 `buildAskUserQuestionFrames`/`buildAskUserQuestionResponse` + 编辑 `error-shaping-glue.ts`（`ask-user-question` 分支接线）+ `handler-v4.ts`（一行 `stream` 标记暴露）。`error-shaping.ts`/`handler-v4.ts` 同时被 Phase 3（post-commit 收编）+ Phase 5（自愈委派接线）追加/编辑，**不是「不同文件不重叠」的独立并行单元**——建议按 3→4→5 顺序串行落地，或各自开隔离 worktree 后按文件段合并，合并前人工核对 diff 有无相邻行覆盖。详见 README §3 Phase DAG「订正」段。
>
> **评审 MEDIUM-3 风险标注（未实测，随 spec 继承的假设）**：本 Phase 的全部测试只验证"代理产出的合成 AUQ 帧/响应体在协议形状上与真实 Claude Code 主动发起的 AskUserQuestion 工具调用逐字节等价"，**没有**用真实 Claude Code 客户端（或忠实复刻其工具调用解析逻辑的 fake）去消费这些合成帧、确认它确实会被渲染成交互式问句 UI 而非被当作普通文本/未知工具调用丢弃或报错。这个"CC 会正确渲染"的假设来自 spec，本计划予以继承但不重新验证。若要关闭这个风险敞口，需要在 Phase 4 之前或之内插入一个 PoC 门（用真实 `claude` CLI 或其可复现的最小工具解析路径喂一段合成 SSE，肉眼/脚本确认交互式渲染），这属于**新增测试基础设施/可能需要额外工具依赖的范围扩张**，本计划不擅自决定是否做，留给 coordinator/用户裁决：
> - 选项 A（推荐，成本最低）：本 Phase 照原计划只做协议形状测试，在 Phase 4 完成检查清单末尾加一条"人工用真实 Claude Code 手动触发一次 GHC 429/504 之类的可复现上游错误，肉眼确认弹出的是交互式问句而非报错文本"，作为**上线前人工验收步骤**而非自动化测试。
> - 选项 B：投入一次性 PoC（`exp/cc-auq-render-probe/`），录制真实 CC 与 fake GHC 上游的一次交互，固化成可重复运行的 e2e fixture。成本高于 A，但能把假设变成回归可测的事实。
> 本计划默认按选项 A 执行（见下方任务清单末尾新增项），除非 coordinator/用户明确要求做选项 B。

**依赖**：Phase 0（`error_ask_user_question`/`error_auq_template`）、Phase 1（`decide()` 的 `ask-user-question` 分支 + 任务 1.4 的 `AuqQuestion`/`renderAuqQuestion`/`DEFAULT_AUQ_TEMPLATE`，本 Phase 直接消费其产出，不重新构造问句内容）、Phase 2（`shapePrecommitError` glue、`errorShapingConfigFromState`）
**产出**：`error-shaping.ts` 内新增 `buildAskUserQuestionFrames`/`buildAskUserQuestionResponse` 两个纯序列化函数（**注**：不新建 `error-shaping-auq.ts` 独立文件——见下方「与早期草稿的差异」）+ `error-shaping-glue.ts` 接线 `ask-user-question` 分支 + handler-v4.ts 一行 `stream` 标记暴露

## 与本计划早期草稿的差异（订正说明，供实现者知悉，不必重新推导）

本 Phase 文档的更早一版草稿里使用过 `buildAuqStreamFrames`/`buildAuqWholeResponse`/`renderAuqQuestion({errorType, message})` 等函数名与参数形状，与 README 第 4 节已经定稿的类型草图（`buildAskUserQuestionFrames`/`buildAskUserQuestionResponse`，入参 `(decision: Extract<ShapingDecision,{kind:"ask-user-question"}>, ctx:{model,reqId})`）不一致，且误用了 `{{message}}`（双花括号）与不存在的 `message` 字段作为模板占位符示例。经回查 spec 第 90-97 行配置面表格确认，`error_auq_template` 的占位符契约固定为 `{model}`/`{request_id}`/`{error_type}`/`{status}`（单花括号，复用 `renderRefusalTemplate` 语法，**没有 `{message}`**）。本版文档已按 README 定稿签名 + spec 真实占位符契约重写，函数体设计也相应调整为**两遍渲染**（Phase 1 任务 1.4 完成第一遍 `{error_type}`/`{status}`，本 Phase 完成第二遍 `{model}`/`{request_id}`），不再是本 Phase 独立处理全部 4 个占位符。

## 探索确认的关键事实

- **AUQ 合成的注入点与 A 类 retry-signal 同一处**（`route.ts` 的 `shapePrecommitError`），但 Phase 2 里该分支只是"直通 forwardError"的占位——本 Phase 把它换成真正的整段合成。
- **route.ts 的 catch 块拿不到原始请求是否 `stream:true`**：`handleMessagesV4` 在自己函数体内部 `await c.req.json<MessagesPayload>()`（`handler-v4.ts:183`）解析 payload，从未通过 `c.set()` 暴露给外层——route.ts 的 catch 只有 `error: unknown`，不知道原请求要不要流式响应。AUQ 的两种变体（`stream:true` 走 SSE 帧序列、`stream:false` 走整个 JSON `AnthropicMessageResponse`）必须知道这个标志。**需要在 `handler-v4.ts:183` 之后补一行 `c.set("clientRequestStream", payload.stream ?? false)`**（Context 变量，模式与既有 `c.set("requestContext", ctx)` 一致），供 `shapePrecommitError` 用 `c.get("clientRequestStream")` 读取。这是本 Phase 唯一对 `handler-v4.ts` 的改动，非侵入式（早期一行 side-channel 暴露，不改变任何现有分支行为）。
- **401 vs 403 分流不在 `decide()` 内部实现，而是天然由调用时机保证**：`auth_expired` 类型（覆盖 401/403）能走到 `decide()` 是因为既有 token-refresh `RetryStrategy` 已经在更早的重试管线层耗尽（无论 401 还是 403，走到这里时都已经"没有更多自动恢复手段"）。`decide()` 因此不需要、也不应该在自己内部区分 401/403——两者到达时语义等价（"认证类错误、已耗尽既有自动恢复"），均可进入 AUQ 候选（Phase 1 真值表任务 1.1 已经用 `test.each([401,403])` 锁定这个不变量）。**本 Phase 不新增 401/403 分流逻辑**，只是引用 Phase 1 已经验证的事实。
- **AUQ 输入形状**（沿用已确认的 `decode-tool-input-core.ts:64-97` 既有约定）：`questions[]` 数组，每项 `{question, header, multiSelect, options}`；`backfillAskUserQuestionHeaders` 已经是这个 tool 的既有消费方，说明上游/合成的 `AskUserQuestion` tool_use 都遵循这个形状——本 Phase 合成的 input 直接按此形状手写（`decision.questions` 已经是这个形状的实例，见 Phase 1 任务 1.4 的 `AuqQuestion` 接口），不依赖 `backfillAskUserQuestionHeaders`（该函数是"缺 `question` 时回填"，本 Phase 主动合成时永远同时提供两者，不存在回填需求）。
- **合成 tool_use id 沿用既有 `toolu_` 前缀风格**（参照 `recover-tool-call/core.ts:174-180` 的 `synthesizeToolUseId`，但那个是确定性 hash-based，用于流式重放场景；AUQ 是一次性整段合成，无需确定性，用 `crypto.randomUUID()` 派生即可，前缀保持一致以避免客户端 SDK 对 id 格式做防御性校验时报错）。
- **两遍渲染的分工边界**：Phase 1 的 `decide()` 产出的 `decision.questions[].question` 字符串**可能仍含未渲染的 `{model}`/`{request_id}` 字面量**（因为 `decide()` 的输入 `ShapingInput` 不含这两个字段）。本 Phase 的 `buildAskUserQuestionFrames`/`buildAskUserQuestionResponse` 在序列化之前，必须对每个 `question.question`（以及如果 `header` 也支持占位符，一并处理——设计上 `header` 是固定短标签"如何继续？"，本 Phase 起点不假设 `header` 含占位符，除非 Phase 1 的 `optionsForErrorType`/模板设计后续演进出需要，此为非阻塞性留白）调用 `renderAuqQuestion(question.question, { model: ctx.model, request_id: ctx.reqId })` 完成第二遍渲染，才能拿到最终展示文本。

## 涉及文件

- `src/lib/anthropic/error-shaping.ts`（Phase 1 已建，本 Phase 追加 `buildAskUserQuestionFrames`/`buildAskUserQuestionResponse` 两个导出函数）
- `src/routes/messages/error-shaping-glue.ts`（Phase 2 已建，本 Phase 补 `ask-user-question` 分支）
- `src/routes/messages/handler-v4.ts`（一行 `c.set("clientRequestStream", ...)`）
- `tests/anthropic/error-shaping-auq.unit.test.ts`（新增，纯函数单测）
- `tests/routes/messages/error-shaping-auq.it.test.ts`（新增，端到端 streaming + non-streaming 两变体）

## 任务 4.1：AUQ 帧/响应纯序列化函数（streaming + non-streaming 两变体）

- [ ] 写失败测试 `tests/anthropic/error-shaping-auq.unit.test.ts`：
  ```ts
  import { describe, expect, test } from "bun:test"

  import { readSyntheticKind } from "~/lib/pipeline/frame-origin"

  import { buildAskUserQuestionFrames, buildAskUserQuestionResponse, type ShapingDecision } from "~/lib/anthropic/error-shaping"

  const decision = (questions: ShapingDecision extends { kind: "ask-user-question"; questions: infer Q } ? Q : never) =>
    ({ kind: "ask-user-question", questions } as Extract<ShapingDecision, { kind: "ask-user-question" }>)

  const oneQuestion = [{ question: "上游返回 quota_exceeded（模型 {model}，请求 {request_id}），如何继续？", header: "如何继续？", multiSelect: false, options: ["等待配额重置", "更换模型", "更换账号"] }]

  describe("buildAskUserQuestionResponse — stream:false variant", () => {
    test("produces a valid AnthropicMessageResponse with a single AskUserQuestion tool_use block, stop_reason:tool_use", () => {
      const res = buildAskUserQuestionResponse(decision(oneQuestion), { model: "claude-3-5-sonnet-latest", reqId: "req_test" })
      expect(res.stop_reason).toBe("tool_use")
      expect(res.content).toHaveLength(1)
      const block = res.content[0] as { type: string; name?: string; input?: { questions?: Array<unknown> } }
      expect(block.type).toBe("tool_use")
      expect(block.name).toBe("AskUserQuestion")
      expect(block.input?.questions).toHaveLength(1)
    })

    test("第二遍渲染：{model}/{request_id} 被替换为 ctx 里的真实值", () => {
      const res = buildAskUserQuestionResponse(decision(oneQuestion), { model: "claude-3-5-sonnet-latest", reqId: "req_test" })
      const block = res.content[0] as { input: { questions: Array<{ question: string }> } }
      expect(block.input.questions[0]?.question).toBe("上游返回 quota_exceeded（模型 claude-3-5-sonnet-latest，请求 req_test），如何继续？")
      expect(block.input.questions[0]?.question).not.toContain("{model}")
      expect(block.input.questions[0]?.question).not.toContain("{request_id}")
    })

    test("tool_use id starts with toolu_", () => {
      const res = buildAskUserQuestionResponse(decision(oneQuestion), { model: "m", reqId: "r" })
      const block = res.content[0] as { id: string }
      expect(block.id).toMatch(/^toolu_/)
    })
  })

  describe("buildAskUserQuestionFrames — stream:true variant", () => {
    test("produces a complete, self-contained SSE frame sequence: message_start → content_block_start(tool_use) → input_json_delta → content_block_stop → message_delta(stop_reason:tool_use) → message_stop", () => {
      const frames = buildAskUserQuestionFrames(decision(oneQuestion), { model: "m", reqId: "r" })
      const events = frames.map((f) => f.event)
      expect(events).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"])
    })

    test("every frame is tagged synthetic:error-shaping-auq (richest-data-flow — must be distinguishable from real upstream traffic)", () => {
      const frames = buildAskUserQuestionFrames(decision(oneQuestion), { model: "m", reqId: "r" })
      for (const f of frames) expect(readSyntheticKind(f)).toBe("error-shaping-auq")
    })

    test("第二遍渲染也在 streaming 变体里生效", () => {
      const frames = buildAskUserQuestionFrames(decision(oneQuestion), { model: "claude-3-5-sonnet-latest", reqId: "req_test" })
      const deltaFrame = frames.find((f) => f.event === "content_block_delta")
      const data = JSON.parse(deltaFrame?.data ?? "{}") as { delta: { partial_json: string } }
      expect(data.delta.partial_json).toContain("claude-3-5-sonnet-latest")
      expect(data.delta.partial_json).toContain("req_test")
      expect(data.delta.partial_json).not.toContain("{model}")
    })
  })
  ```
- [ ] 跑测试确认红
- [ ] 最小实现：`error-shaping.ts` 内追加：
  - `buildAskUserQuestionResponse(decision, ctx): AnthropicMessageResponse`：对 `decision.questions` 每一项调用 `renderAuqQuestion(q.question, { model: ctx.model, request_id: ctx.reqId })` 完成第二遍渲染，手搓 `{ id: "msg_"+crypto.randomUUID(), type:"message", role:"assistant", model: ctx.model, content:[{type:"tool_use", id:"toolu_"+crypto.randomUUID().replaceAll("-",""), name:"AskUserQuestion", input:{questions: renderedQuestions}}], stop_reason:"tool_use", stop_sequence:null, usage:{input_tokens:0, output_tokens:0} }`（`usage` 字段填 0 是本 Phase 起点的最小值——AUQ 是合成响应，没有真实 token 消耗可报告；若 history/计费层对 `usage:{0,0}` 有特殊断言依赖需要非零占位，属任务 4.3 history 一致性检查范围，非本任务阻塞）
  - `buildAskUserQuestionFrames(decision, ctx): Array<ClientFrame>`：仿照 `buildSyntheticTextFrames` 的模式，对渲染后的 `questions` 序列化成完整独立帧序列（`message_start`/`content_block_start(tool_use, 空 input)`/`content_block_delta(input_json_delta, 完整 JSON 字符串一次性下发)`/`content_block_stop`/`message_delta(stop_reason:"tool_use")`/`message_stop`），每帧 `tagFrameSynthetic(frame, "error-shaping-auq")`（Phase 1 已扩展该 `SyntheticOriginKind` 成员）
- [ ] 确认绿
- [ ] 提交（`feat: add AUQ synthesis builders (streaming + non-streaming variants, two-pass template render)`）

## 任务 4.2：handler-v4.ts 暴露 `clientRequestStream` + glue 接线 `ask-user-question` 分支

- [ ] 写失败测试（`tests/routes/messages/error-shaping-auq.it.test.ts`）：
  ```ts
  import { describe, expect, test } from "bun:test"

  import { useIsolatedRuntime } from "~~tests/support/isolated-runtime" // 精确导出名以现有 test-isolation skill 用例为准，实现者对照既有 .it.test.ts 文件核实
  import { state } from "~/lib/state"

  describe("AUQ synthesis — end to end", () => {
    const runtime = useIsolatedRuntime()

    test("stream:false request, upstream 402 quota_exceeded, error_ask_user_question=true → 200 whole AnthropicMessageResponse with AskUserQuestion tool_use (not a 402 error body)", async () => {
      state.errorShapingEnabled = true
      state.errorAskUserQuestion = true
      const res = await runtime.app.request("/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-3-5-sonnet-latest", max_tokens: 10, stream: false, messages: [{ role: "user", content: "hi" }] }), headers: { "content-type": "application/json" } })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.stop_reason).toBe("tool_use")
      expect(body.content[0].name).toBe("AskUserQuestion")
    })

    test("stream:true request, upstream 403 auth_expired, error_ask_user_question=true → 200 SSE with self-contained AUQ frame sequence", async () => {
      state.errorShapingEnabled = true
      state.errorAskUserQuestion = true
      const res = await runtime.app.request("/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-3-5-sonnet-latest", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }] }), headers: { "content-type": "application/json" } })
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/event-stream")
      const text = await res.text()
      expect(text).toContain("AskUserQuestion")
      expect(text).toContain("message_stop")
    })

    test("error_ask_user_question=false → falls back to plain canonical error (no behavior change from Phase 2)", async () => {
      state.errorShapingEnabled = true
      state.errorAskUserQuestion = false
      const res = await runtime.app.request(/* 同 402 fixture */)
      expect(res.status).toBe(402)
    })

    test("401 auth_expired reaching decide() (post token-refresh exhaustion) with error_ask_user_question=true → also synthesizes AUQ (per Phase 1 truth-table invariant, no special-casing 401 vs 403 here)", async () => {
      state.errorShapingEnabled = true
      state.errorAskUserQuestion = true
      const res = await runtime.app.request(/* 401 fixture，模拟 token-refresh 策略已耗尽后仍 401 */)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.content[0].name).toBe("AskUserQuestion")
    })
  })
  ```
- [ ] 跑测试确认红
- [ ] 最小实现：
  - `handler-v4.ts:183` 后追加一行：`c.set("clientRequestStream", payload.stream ?? false)`
  - `error-shaping-glue.ts` 的 `shapePrecommitError` 补全 `ask-user-question` 分支：
    ```ts
    if (decision.kind === "ask-user-question") {
      const streamRequested = (c.get("clientRequestStream") as boolean | undefined) ?? false
      const model = /* 从既有可得的已解析 model 名获取，核实 handler-v4.ts 是否已通过 c.set 暴露 resolvedName，若有直接复用，避免重复解析逻辑；若无则以 apiError 携带信息或 payload.model 兜底 */
      const ctx = { model, reqId: c.get("requestContext")?.requestId ?? "unknown" }
      env.ctx?.recordFeature("error-shaping-auq-synthesized", { errorType: apiError.type })
      if (streamRequested) {
        return streamSSE(c, async (sseSink) => {
          for (const frame of buildAskUserQuestionFrames(decision, ctx)) await sseSink.writeSSE({ event: frame.event, data: frame.data ?? "" })
        })
      }
      return c.json(buildAskUserQuestionResponse(decision, ctx))
    }
    ```
    （`streamSSE` 的具体 import 来源、`resolvedName`/`requestId` 的精确获取方式需要实现者对照 `handler-v4.ts` 顶部 import 列表核实，不得凭空假设——这是本任务里唯一需要实现者在动手前二次确认签名的点，已在此处显式标注，不静默假设）
- [ ] 确认绿
- [ ] 提交（`feat: wire AUQ synthesis into pre-commit error shaping glue`）

## 任务 4.3：history/richest-data-flow 一致性——AUQ 合成响应必须完整落库

- [ ] 写失败测试（追加 `tests/routes/messages/error-shaping-auq.it.test.ts` 或 history 专属测试文件，具体归属以既有 history 断言测试的既定位置为准）：
  ```ts
  test("AUQ 合成响应（200 + AskUserQuestion tool_use）落入 history，attempts[].upstreamResponse 记录真实上游 402/403，clientResponse 记录合成的 200", async () => {
    // 断言 history entry 的两个正交轴：
    // 1. attempts[].upstreamResponse.status === 402（真实上游错误，未被 AUQ 合成掩盖）
    // 2. clientResponse（或等价的『最终返给客户端』快照）反映 200 + AskUserQuestion
    // 3. AUQ 合成的 tool_use 内容里没有裸露"synthetic"标记泄漏到用户可见文本（标记只在 frame-origin 元数据层，不在渲染文本里）
  })
  ```
- [ ] 跑测试确认红
- [ ] 最小实现：核对既有 history 落库路径（`RequestContext`/`recordFeature`/既有 `attempts[]`/`clientResponse` 写入点）是否已经天然支持"合成 200 + `upstreamResponse.success:false`"这一组合——**若既有 API 已支持**（大概率成立，因为 Phase 1-3 的 canonical-error 整形也产生类似的"合成响应 vs 真实上游错误"分裂，若那边已有先例可直接复用同一写入路径），本任务只需补一条断言测试锁定该不变量，无需新增产品代码；**若不支持**（既有 `RequestContext` API 假设 client 响应状态与 upstream 响应状态强绑定，无法表达这种分裂），则这是一个**需要记入 README 待裁决节的新发现**（不是本计划可以自行决定的架构变更——`RequestContext`/history 落库契约的改动超出"细化局部签名"的授权范围），实现者应停止在此任务继续深挖 history 内部机制，转而在 README 第 0 节补充一条待裁决项，说明发现的具体 gap 与影响面。
- [ ] 确认绿（或在发现门控问题时，改为记录待裁决项并跳过绿）
- [ ] 提交（`test: lock AUQ history recording invariant (real upstream error preserved, synthetic client response distinguishable)`）

## Phase 4 完成检查

- [ ] `bun run typecheck` 全绿
- [ ] `bunx eslint src/lib/anthropic/error-shaping.ts src/routes/messages/error-shaping-glue.ts src/routes/messages/handler-v4.ts tests/anthropic/error-shaping-auq.unit.test.ts tests/routes/messages/error-shaping-auq.it.test.ts`
- [ ] 确认 `error-shaping.ts` 顶部 import 依旧不含任何 `~/routes/*` 路径
- [ ] 确认 `error_shaping_enabled=false` 时 `ask-user-question` 分支从不触发（`decide()` 的 `config.enabled` 门控在 Phase 1/2 已覆盖，本 Phase 补一条端到端回归确认 AUQ 场景同样受总开关约束）
- [ ] 确认 AUQ 选项文案（quota_exceeded/content_filtered/auth_expired 三组 `options`）与 Phase 1 任务 1.4 里落地的版本一致（同一份文案只应该在 `error-shaping.ts` 定义一次，Phase 4 不重复定义、不重复决策）
- [ ] **（评审 MEDIUM-3，人工验收步骤，非自动化测试，不阻塞本 Phase 的"确认绿"）**：用真实 Claude Code 客户端手动触发一次可复现的上游错误（例如临时调低配额触发 429，或直连一个会返回 5xx 的测试上游），肉眼确认代理合成的 AUQ 帧被 CC 渲染成交互式问句（可点选选项）而非报错文本、纯文本工具调用回显或静默失败。这一步验证的是"CC 会正确渲染合成 AskUserQuestion"这条继承自 spec、本计划从未实测过的假设——若肉眼确认失败，说明协议形状测试全绿但功能不成立，须回到 README 第 0 节记录为新发现的门控问题，不要就地扩大本 Phase 范围自行改协议形状。
