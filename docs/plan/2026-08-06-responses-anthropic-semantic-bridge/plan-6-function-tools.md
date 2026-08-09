# P6 — Function Calls, Tool Results, and Custom Tools

> **状态**：未实施
>
> **前置**：P5。与 P7 严格串行。

**Goal:** 原子迁移 function call／output、tool_use／tool_result、custom declaration／forced choice 与 stream arguments 三源裁决，保持 call identity、block顺序与完整 tool input。

> **既有约束（master `3bfb5a3d`，2026-08-07 落地，晚于本规格初稿）**：工具名的 Responses-wire 合法化**已由 S3 request rewrite `responsesToolNameSanitize` 拥有**（`src/lib/codec/openai-responses/openai-responses-cell.ts`），它在 S2 `translateOut` **之后**运行，并把 mapper 写回 `env.ctx.setToolNameMapper`。配套的 provenance 是 `RequestState.sourceToolNameMapper`——parse 时捕获一次、跨 retry 不变，区别于每 attempt 可变的 `ctx.toolNameMapper`。
>
> 本 phase 的 function-call family **一律不得自行 sanitize 工具名**，也不得读写 `ctx.toolNameMapper`：语义桥只产出**客户端原始名**，合法化留给那条 S3 rewrite，否则会双重改名并破坏还原映射。
>
> 顺带一提，`sourceToolNameMapper`（稳定供给放 `RequestState`）与 `ctx.toolNameMapper`（每 attempt 可变）的这一分工，正是本计划 diagnostics 采用 **S2-local `RequestTranslationRuntime` + 只把 frozen 结果放进 `RequestState`** 的同一条既有契约；执行时按同样的口径处理，别把可变累加器塞进 `RequestState`。

### Task 6.1: Shared complete-arguments mapper

**Files:**
- Create: `src/lib/openai/translate/semantic-bridge/families/function-call.ts`
- Test: `tests/semantic-bridge/function-arguments.unit.test.ts`
- Create: `docs/tmp/2026-08-07-responses-anthropic-semantic-bridge-progress-p6-function.md`

**Produces:**

```ts
resolveFunctionArguments({ deltas, argumentsDone, itemDone }):
  | { kind: "complete"; raw: string; value: unknown }
  | { kind: "rejected"; error: BridgeCompatibilityError }
```

- [ ] 红灯覆盖：无专用 done但 item-close完整；专用＋item-close同值；分片 delta＋两done canonical等价；重复同值专用 done；多并行 call。
- [ ] 反向：delta/任一done冲突、两done冲突、重复异值、专用done晚于close、非法JSON、缺close。
- [ ] 实现 canonical JSON value比较；item-close唯一finalize门。解析失败不再静默 `{}`。
- [ ] mutation：先到者finalize、忽略item-close、移除专用done typed source后红。
- [ ] Commit: `feat(bridge): resolve function arguments authoritatively`

### Task 6.2: Responses function lifecycle handler

**Files:**
- Modify: `src/lib/openai/translate/semantic-bridge/responses-adapter.ts`
- Modify: `families/function-call.ts`
- Test: `tests/semantic-bridge/function-lifecycle.unit.test.ts`

- [ ] `response.function_call_arguments.done`→typed item-progress，`output_item.done`→item-close。
- [ ] State存 delta、专用done、item-close；close前不finalize；flush缺close invalid-lifecycle。
- [ ] Presentation 产生 client-tool-call；callId/name/input不丢；continuation按源协议需要返回none/native。
- [ ] mutation：把专用done送default或提前finalize后红。
- [ ] Commit: `feat(bridge): add function call lifecycle handler`

### Task 6.3: Anthropic tool_use／tool_result request handlers

**Files:**
- Modify: `src/lib/openai/translate/semantic-bridge/families/function-call.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/anthropic-to-responses-profile.ts`
- Test: `tests/semantic-bridge/anthropic-tool-requests.unit.test.ts`

- [ ] tool_use→function_call；tool_result→function_call_output；关联只用call id，不伪造fc item id。
- [ ] tool_result text／image／error按 richest-data-flow disposition；无法表达image不得silent drop。
- [ ] 同一 user turn的parallel tool results保持一个group；顺序不跨turn。
- [ ] malformed／missing id走rejected或显式degraded，不空id继续。
- [ ] Commit: `feat(bridge): map Anthropic tool request items`

### Task 6.4: Responses request fold 与 custom declaration／choice

**Files:**
- Modify: `src/lib/openai/translate/semantic-bridge/responses-to-anthropic-profile.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/families/function-call.ts`
- Test: `tests/openai/responses-to-anthropic-request.unit.test.ts`
- Test: `tests/responses/responses-to-cc-request.unit.test.ts`（公共choice回归）

- [ ] function_call/message相对顺序由P2 policy；function_call_output归同 user group。
- [ ] function/custom declaration与forced choice同源；custom降为Anthropic function时forced choice同名保留。
- [ ] unsupported builtin/missing declaration/zero-tool required显式省略并记录disposition。
- [ ] Phase 0无真实fixture的`custom_tool_call`/delta/output保持unknown rejected，不注册空handler。
- [ ] mutation：forced custom被删、dangling choice、按kind重排后红。
- [ ] Commit: `feat(bridge): map function and custom tool requests`

### Task 6.5: Target renderers 与 SDK oracle

**Files:**
- Modify: `src/lib/openai/translate/semantic-bridge/anthropic-renderer.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/responses-renderer.ts`
- Test: `tests/e2e-client/semantic-bridge-tools.it.test.ts`
- Test: `tests/openai/*anthropic*stream.unit.test.ts`

- [ ] Responses→Anthropic零delta仍生成完整 `tool_use.input`；Anthropic SDK `.finalMessage()` deep-equal。
- [ ] Anthropic→Responses完整 function lifecycle；OpenAI SDK finalResponse deep-equal。
- [ ] 多并行tool calls/results保持id、order、一个user result turn。
- [ ] error tool result不被成功规则误伤。
- [ ] byte-golden断event/index/id顺序；SDK断parse／assembly，两者不可互替。
- [ ] Commit: `test(e2e): verify semantic bridge tool assembly`

### Task 6.6: 原子 production cutover

**Files:**
- Modify: `src/lib/openai/translate/semantic-bridge/anthropic-to-responses-profile.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/responses-to-anthropic-profile.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/migration-dispatch.ts`
- Modify: `src/lib/pipeline/hub-translate.ts`
- Modify: `src/lib/openai/translate/anthropic-to-responses-request.ts`
- Modify: `src/lib/openai/translate/anthropic-to-responses.ts`
- Modify: `src/lib/openai/translate/anthropic-to-responses-stream.ts`
- Modify: `src/lib/openai/translate/responses-to-anthropic-request.ts`
- Modify: `src/lib/openai/translate/responses-to-anthropic.ts`
- Modify: `src/lib/openai/translate/responses-to-anthropic-stream.ts`
- Test: `tests/pipeline/hub-translate.unit.test.ts`
- Test: `tests/anthropic/anthropic-codec-forward-leg.it.test.ts`
- Test: `tests/responses/reverse-responses-messages.it.test.ts`

- [ ] Dispatcher加入function call／output／tool_use／tool_result相关source kinds；旧translator shell对应case只委托semantic，不保留旧算法。Web Search／reasoning保持semantic，remaining families保持legacy。
- [ ] Handler／whole／stream／reverse echo／diagnostics同commit；semantic失败不回退legacy，同kind不双跑。
- [ ] Unknown policy仍未全局启用，只对已注册family生效。
- [ ] Run: `bun test tests/semantic-bridge/function-arguments.unit.test.ts tests/semantic-bridge/function-lifecycle.unit.test.ts tests/e2e-client/semantic-bridge-tools.it.test.ts tests/pipeline/hub-translate.unit.test.ts tests/anthropic/anthropic-codec-forward-leg.it.test.ts tests/responses/reverse-responses-messages.it.test.ts`。Expected: PASS。
- [ ] Run: `bun run typecheck && bun run test:backend`；随后运行 `files=$(git diff-tree --no-commit-id --name-only -r HEAD -- '*.ts'); test -z "$files" || bun x eslint $files`。Expected: 全绿。
- [ ] Commit: `feat(bridge): cut over function tool family`

## Phase 验收

- AC22／AC23与custom choice正负样本通过。
- 无空input、无silent parse fallback、无call identity漂移。
- 旧function/tool分支零残留；reviewer双向复核0 BLOCKER/MAJOR。
