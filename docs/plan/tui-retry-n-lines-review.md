# 计划审计报告 — misty-sparking-candy.md

审计对象：让 retryable 请求错误在 TUI 显示为 `[RTRY]` 行。
计划文件：`/home/xp/.claude/plans/misty-sparking-candy.md`

总体结论：**WARN** — 设计方向正确，pipeline 选点准确、依赖图干净、ApiError 字段安全、handler 全覆盖 tuiLogId、web_search 子跳天然跳过。但有 **1 个 FAIL（错误的过滤模型）** 和 **数个 WARN**（footer 时序、API 设计、测试覆盖、文档）。下方逐条列出。

---

## FAIL

### F1. `learning !== true` 过滤模型对 `unsupported-beta-retry` **只过滤一半**

- **严重度**：FAIL（直接违背用户给出的"排除 learning probe"语义）
- **位置**：plan 第 11–14、42–54 行；对照 `src/lib/request/strategies/unsupported-beta-retry.ts:142-180`

**事实**：`unsupported-beta-retry.handle()` 有两条路径：

| 路径 | 文件:行 | `learning` 字段 |
|---|---|---|
| Explicit-list（`unsupported beta header(s): X[, Y]`，上游列名） | `unsupported-beta-retry.ts:146-156` | **未设置**（即 `undefined`） |
| Laconic（`invalid beta flag`，需要枚举猜测） | `unsupported-beta-retry.ts:161-180` | `learning: true` |

计划写道（plan 第 13 行）："Learning probes (`unsupported-beta-retry` and any strategy returning `learning: true`) — these are deterministic protocol probes, not real errors"，把整个 `unsupported-beta-retry` 都归类为 learning probe。

但实际门控代码 `action.learning !== true && !EXCLUDED_RETRY_STRATEGIES.has(strategy.name)`（plan 第 42 行）：
- explicit-list 路径 `learning === undefined`，**不被 `action.learning !== true` 拦截**
- `EXCLUDED_RETRY_STRATEGIES = new Set(["token-refresh"])` 不含 `"unsupported-beta-retry"`
- → explicit-list 路径会触发 `[RTRY]` 行

这与用户给定的语义直接冲突。其实 explicit-list 是上游 **权威告知** "这个 beta 不支持"，本质和"协议惯例 / 维护性"更接近，并不是真正的请求失败（客户端发了上游不认的元数据，pipeline 一次剥离即愈合）；用户判定整个 `unsupported-beta-retry` 都不属于"真错误"是合理的。

**复现 / 验证方式**：构造一个 `HTTPError` status=400、responseText 含 `"unsupported beta header(s): foo"`，通过 pipeline 跑一次，按计划现写法会打印 `[RTRY]`。

**修复建议**（择一）：
1. 把 `EXCLUDED_RETRY_STRATEGIES` 改成 `new Set(["token-refresh", "unsupported-beta-retry"])`（最贴合用户答案，零分类风险）。
2. 让 explicit-list 路径返回 `learning: true`。语义上不准确（它不是"探测"，是确定性修复），且会改变现有 budget 行为（吃 learning budget 而非 normal budget），有 side effect，**不推荐**。
3. 加更细分的字段（如 `RetryAction.maintenance?: boolean`）并把 explicit-list 标上。比 (1) 干净但超出本计划范围。

**推荐 (1)**。同时把 plan 第 13–14 行的措辞从"any strategy returning `learning: true`"修正为更准确的"`learning: true` 的探测 + 显式排除清单覆盖的维护性策略"。

---

## WARN

### W1. `EXCLUDED_RETRY_STRATEGIES` 还应考虑 `deferred-tool-retry` 的语义归类

- **严重度**：WARN（取决于用户视角）
- **位置**：plan 第 54 行 vs `src/lib/request/strategies/deferred-tool-retry.ts:66-136`

`deferred-tool-retry` 处理的是 "Tool reference 'X' not found in available tools" 400。这通常发生在：
- 客户端历史里有 deferred 工具的 tool_use，但 sticky 缓存还没建立（首次遇到）。
- context_management 清理掉 tool_search 激活但保留 tool_use/tool_result 配对。

它确实是 **真实的协议级 400**——上游确实拒绝了请求。但和 `unsupported-beta-retry` explicit-list 一样，本质是"客户端发了上游需要的元数据校准"，pipeline 一次性修复后续就 sticky 不再触发。

用户明确说"仅真正错误类（排除 learning probe）+ 排除 token-refresh"。`deferred-tool-retry` 表面上属于"真错误"（首次必然发生 400，对运维有诊断价值——表明客户端历史和 sticky 缓存的状态），但和 `token-refresh` 一样也是 "系统自愈性维护"。

**建议**：在实施前 **`AskUserQuestion` 澄清**：
- "deferred-tool-retry 首次触发是真错误（值得 [RTRY]）还是维护性自愈（排除）？"
- "explicit-list 的 unsupported-beta-retry 是真错误还是维护性？"（参见 F1）

**复现/验证方式**：grep 7 个策略文件统计哪些设了 `learning: true`（只有 unsupported-beta-retry 的 laconic 路径），其它全是 `learning: undefined`。光靠 `learning !== true` 一个轴显然不足以划清"真错误 vs 维护性"。

---

### W2. `onRequestRetry` 应当像 `printLog` 一样做 footer 三步舞

- **严重度**：WARN（不修会有 footer 残影）
- **位置**：plan 第 24 行未明确；对照 `src/lib/tui/console-renderer.ts:340-344`

`ConsoleRenderer.printLog()` 是 `clearFooterForLog() → write → renderFooter()` 三步，确保 footer 在新行之后重绘。`onRequestComplete`、`onRequestStart` 都走这条路。但计划只说"print via the existing `formatLogLine` helper"，没要求复用 `printLog`。

如果 `onRequestRetry` 实现里只 `process.stdout.write(line + "\n")` 而不清/重绘 footer，会出现：
- footer 与新行重叠 / 错位
- 由于 `footerTimer` 100ms 周期，下一帧会"自愈"，但仍有视觉抖动

**修复建议**：`onRequestRetry` 必须调用 `this.printLog(this.formatLogLine({...}))`。在 plan 第 24 行加一句"必须复用 `printLog` 以维持 footer 三步舞"。

**复现/验证方式**：手工验证或单测里 stub `process.stdout.write` 并断言调用序列。

---

### W3. `entry.tags` 视觉重复：retry 行已经携带策略名，handler 的 `retry-N` tag 仍出现在最终 `[OK]/[FAIL]` 行

- **严重度**：WARN（非阻塞，但和"减少噪音"原则冲突）
- **位置**：`src/routes/messages/handler.ts:384-391`、`chat-completions/handler.ts:519`

handler 已经在 `onRetry` 回调里用 `tuiLogger.updateRequest({ tags: ["truncated", "retry-N", "beta-strip:..."] })` 给 in-flight entry 累加 tag。这些 tag 会在最终完成行 `[OK]` 里以 `(truncated, retry-1, ...)` 形式重复显示——和 `[RTRY]` 中携带的策略名是同一信息源。

**修复建议**：实施时一并清理冗余——`[RTRY]` 行是更高保真的载体，可以把 handler 端 `retry-N`/`beta-strip:` 这类 tag 改为 debug-only 或直接删除（保留 `truncated`/`thinking:` 这类"特性"tag）。出 PR 时用 `AskUserQuestion` 与用户确认。**或**直接归入 "Out of scope"（W3 不阻塞 [RTRY] 落地）。

---

### W4. `tuiLogId` 在 OpenAI Responses Client 的内部子调用路径未设置——但 plan 已隐式覆盖

- **严重度**：低 WARN（属于"应当指出"而非"必须修"）
- **位置**：`src/lib/openai/responses-client.ts:140` 的 `manager.create({ headers, model, conversationId })`

这是 OpenAI Responses **persistent connection manager** 的 `create`，与 `requestContextManager.create` 同名但不同类（前者是连接管理器，后者是 RequestContext 管理器）。**不是** RequestContext 创建。无需 `tuiLogId`。

所有 5 个真实的 `RequestContext.create` 调用点（`messages`、`chat-completions`、`responses`、`responses/ws`、`gemini` 的 handler）都已正确传入 `tuiLogId`，加上 web_search 子跳故意传 `requestContext: undefined`（`src/lib/anthropic/web-search/orchestrator.ts:294`），plan 的 `requestContext?.tuiLogId` 守卫对所有路径都正确。

**结论**：plan 在这一点上 OK，列在这里只是确认审计已覆盖。

---

### W5. plan 未要求 `RetryInfo.waitMs` 渲染策略

- **严重度**：低 WARN
- **位置**：plan 第 30、44–50 行

plan 把 `waitMs: action.waitMs` 放进了 `RetryInfo`，但**输出格式行**（plan 第 30 行）没显示它：

```
[RTRY] HH:MM:SS 429 POST /v1/messages claude-opus-4.8 (3x) 1.2s: rate_limited (retryable: network-retry)
```

`waitMs` 仅 `network-retry`（1000ms 固定）和 `auto-truncate`（按 strategy 内部）会设置。运维语义上 `wait 1.0s` 是有用信息（告诉用户"下次重试前等 1 秒"，避免误以为卡住）。

**修复建议**（择一）：
1. 渲染为 `... (retryable: network-retry, wait 1.0s)` 当 `waitMs > 0`。
2. 显式说明"不展示 waitMs，删 `RetryInfo.waitMs` 字段以保持 API 最小化"。

任选其一，避免"加了字段不用"的死代码（违反原则 9 中"具有示范价值的死代码"的相反面——明显计划遗忘）。

---

### W6. 测试矩阵缺一条：第二次 retry / 多次 retry 累计

- **严重度**：WARN
- **位置**：plan 第 61–67 行

plan 测试列出：单次 retry 调用、token-refresh 排除、learning 排除、无 requestContext 排除、最终成功不触发、budget 耗尽不触发。

缺：
- **多次 retry**：一次请求触发 2 次（例如 network-retry → auto-truncate）应该有 2 行 `[RTRY]`，每行 `attempt` 递增（0、1）。
- **abort 路径**：策略返回 `{ action: "abort" }` 不应触发 `[RTRY]`（plan Out of scope 第 86 行已声明这是 `[FAIL]`，但应有显式测试 assert "abort 不触发 onRequestRetry"）。
- **`network-retry` 的 `hasRetried` 是 instance 单例**（`network-retry.ts:35`），同一 pipeline 内只会被调用 1 次；测试要避免误以为同一策略能在同一 pipeline 内多次 retry。

**修复建议**：在 plan 第 67 行下面加上述三条断言。

---

### W7. plan 第 24 行 "extra carries `: <error message> (retryable: <strategyName>)`" 与 `[FAIL]` 行格式不一致

- **严重度**：低 WARN（命名一致性）
- **位置**：plan 第 24 行 vs `console-renderer.ts:393-396`

`[FAIL]` 行的 `errorStr = isError && request.error ? ': ' + request.error : ''`——冒号紧跟错误消息，**没有** `(retryable: ...)` 后缀。plan 把 `(retryable: <strategyName>)` 塞进 `extra` 让它复用 `extraPart = isError ? pc.red(extra) : extra`（`console-renderer.ts:329`）会把整段红色——包括 `(retryable: network-retry)`，与现有 `[FAIL]` 错误段红色一致 ✓。但这是巧合，plan 没说清。

**修复建议**：plan 第 24 行明确写 "复用 `extra` slot；isError 上下文已让整段染红"——或显式拆出独立 slot 让 `(retryable: ...)` 用 dim 而非 red（区别于真正的错误消息）。后者更符合 web `design-quality` "intentional hierarchy"。倾向后者：`(retryable: <strategy>)` 是元数据，应该 dim。

---

### W8. plan 没说 `attempt` 从哪个基底数（0 还是 1）

- **严重度**：低 WARN
- **位置**：plan 第 45 行 `attempt: execIndex`

pipeline `execIndex` 在 emit 点是 **失败那次的 0-based index**（递增发生在 `execIndex++` 即 line 359，在 emit 之后才会发生）。对运维显示，1-based ("第 N 次尝试失败，准备第 N+1 次") 更直观。

**修复建议**：emit 时传 `attempt: execIndex + 1`（"刚失败的是第 N 次"），或在 console-renderer 显示 `retry-${attempt + 1}`。明确语义。

---

## PASS

### P1. pipeline 选点正确

`executeRequestPipeline` 在 `pipeline.ts:317` 之后到 `pipeline.ts:359` 之间持有 `chosen`、`strategy`、`action`、`apiError`、`requestContext`、`execIndex`、`action.learning`、`action.waitMs`、`apiError.status`、`apiError.message` 所有上下文，在 budget gate（333-339）之后插入完全可行。

### P2. budget gate 后再 emit 是正确的

budget 耗尽时 `break`（line 334/337）退出 for(;;) 循环，落入 line 364 的 `if (lastError)` throw 分支——**不会**经过 emit 点。plan 第 37 行的"After the budget gate accepts the retry"措辞与 break 语义一致 ✓。

### P3. ApiError 字段类型安全

`src/lib/error/classify.ts:29-43` 中 `ApiError.status: number` 和 `ApiError.message: string` 都是 **non-optional**。emit 时不需要处理 undefined。

### P4. 依赖图无循环

TUI 模块仅依赖 `~/lib/state`、`~/lib/utils`、`~/lib/models/resolver`、`~/lib/shutdown`、`consola`、`picocolors`，**无一项**依赖 pipeline 或 context/request。pipeline.ts 引入 `~/lib/tui` 单向、无环 ✓。

### P5. handler 全覆盖 `tuiLogId`

5 个 RequestContext 创建点全部从 `c.get("tuiLogId")` 取并传入：
- `src/routes/messages/handler.ts:162,179`
- `src/routes/chat-completions/handler.ts:157,164`
- `src/routes/responses/handler.ts:154,161`
- `src/routes/responses/ws.ts:210,220`
- `src/routes/gemini/handler.ts:239,244`

Web_search 内层 hop 故意 `requestContext: undefined`（`web-search/orchestrator.ts:294`），plan 的 `requestContext?.tuiLogId` 守卫天然跳过 ✓。

### P6. tracker `logRetry` 不动 entry 状态是正确的

`TuiLogger.entries`、`completedQueue`、`completedTimeouts` 三态机由 `finishRequest → moveToCompleted` 驱动。`logRetry` 不调这俩，entry 保持 `executing`/`streaming`，footer 继续显示该 entry，无副作用 ✓。

### P7. 测试样板可复用

`tests/pipeline/pipeline-with-strategy.unit.test.ts` 的 fake adapter + `createMockAdapter` + `createUnsupportedBetaRetryStrategy`+ `mockModel` 模式直接可用。新增 `pipeline-retry-tui.unit.test.ts` 走同一套路即可。

### P8. format.ts 现有函数足够

`formatTime`、`formatDuration`、`formatBillingLabel`、`formatBytes`、`formatTokens` 已覆盖 `[RTRY]` 行所需的所有列。无需新增 format 函数 ✓。

---

## 行动项汇总（按优先级）

1. **必修** F1：把 `unsupported-beta-retry` 加入 `EXCLUDED_RETRY_STRATEGIES`（或与用户重新澄清归类）。
2. **必修** W2：`onRequestRetry` 复用 `printLog` 的 footer 三步舞。
3. **建议澄清** W1：`deferred-tool-retry` 是否同样归入排除清单。
4. **必修** W7/W8：明确 `(retryable: ...)` 染色策略、`attempt` 基底语义。
5. **建议** W5：明确 `waitMs` 渲染或删字段。
6. **建议** W6：补 3 条测试断言（多次 retry / abort / network-retry 单实例）。
7. **可选** W3：清理 handler 端 `retry-N` 冗余 tag（或归入 Out of scope）。
8. W4 仅供存档，无需动作。
