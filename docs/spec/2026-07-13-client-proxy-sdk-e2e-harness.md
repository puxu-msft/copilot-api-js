# Spec: client↔proxy SDK e2e 骨架（屏蔽上游）

- **状态**：草案（待 subagent 审 → 用户审 → plan）
- **日期**：2026-07-13
- **相关**：brainstorming 本会话、[docs/refusal-recovery.md](../refusal-recovery.md)（空串 stall 盲区来源）、skill `upstream-hook-mocking`、skill `debugging-claude-client-connection`（CC 客户端行为域）、[tests/helpers/test-app.ts](../../tests/helpers/test-app.ts)（`createFullTestApp`）、[tests/helpers/mock-fetch.ts](../../tests/helpers/mock-fetch.ts)（`setUpstreamFetchForTests`）、ADR [richest-data-flow](../decisions/2026-07-05-richest-data-flow.md)（合成帧可辨识——本骨架用真实 SDK 反证 wire 契约）

## 背景与问题

现有 golden/http 测试断言的是**代理发出的字节**（`postStream()` + 逐字节 golden）。但一个真正的盲区从未被自动化覆盖：**真实客户端 SDK/CLI 拿到那些字节后如何反应**——`@anthropic-ai/sdk` 的 `SSEDecoder` 是否静默丢弃 eventless 帧、200+流内 `event: error` 是否 `throw APIError` 且不重试、合成 refusal recovery 轮能否被拼成连贯 message、thinking-only `end_turn`（空串 recovery）是否让 Claude Code 的 agent-loop **stall**（轮变空→下轮变「继续」）。

这些「客户端可观测行为」是 client↔proxy 契约的真相，golden 字节测证不了（字节对 ≠ 客户端接受）。最近的 refusal 文本可配特性收尾时明确标记了一个此类盲区：**空串 end_turn 是否 stall「需真实 Claude Code live oracle、自动化测试证不了」**。本 spec 把这类验证系统化：让**真实客户端打真实 proxy、上游（GHC）全程屏蔽**，确定性、可复现、不烧额度。

## 目标

1. 建立可复用的 **client↔proxy e2e 骨架**，客户端侧用**真实 SDK** 当 oracle（断言客户端可观测行为，非我方字节），上游经 mock 屏蔽。
2. 本轮交付 **Tier 1（SDK 层）全量**：真实 `@anthropic-ai/sdk` 打同进程 proxy，覆盖 Anthropic 行为场景集（深先于广）。
3. 骨架核心 **vendor 无关**，为后续 OpenAI/Gemini SDK + CLI 层预留干净接入点。

## 非目标（本轮，均为**延后不砍**——记 roadmap）

- **CLI 层（Tier 2）实现**：spawn 真实 `claude`（2.1.207 已在 PATH）驱动 agent-loop、复现 stall——**本轮只文档化设计意图 + 预留接入点，不实现**。原因：agent-loop 行为复现有真实未知（`claude -p` 非交互下 stall 的可断言信号）需单独 PoC；用户决定本轮先做透 SDK 层。
- **OpenAI / Gemini SDK 场景**：骨架 vendor 无关，但本轮只落 Anthropic 场景（深先于广），另二 vendor 后续接。
- **stall 终裁**：SDK 层能断言「空串 end_turn → SDK 无错拼出 thinking+无 text+end_turn 轮」，但「是否 stall」是 agent-loop 行为、**属 Tier 2**；本轮 SDK 场景只覆盖前半。

## 两层 oracle 愿景（Tier 2 文档化、本轮只做 Tier 1）

| 层 | 客户端 | 屏蔽机制 | 能测 | 本轮 |
|---|---|---|---|---|
| **Tier 1 — SDK** | 真实 `@anthropic-ai/sdk`（后续 openai/@google/genai） | 同进程 `Bun.serve` 临时端口 + 全局 fetch-mock（host-scoped） | SDK 是否接受/拼装 wire、是否 throw、是否丢 eventless 帧 | **做** |
| **Tier 2 — CLI** | 真实 `claude` CLI | spawn 真 proxy（非 4141）+ upstream-hook-mocking `onExchange` | agent-loop 行为（stall/重发/渲染） | 延后 |

## Tier 1 架构（本轮）

### 组件（vendor 无关核心 + Anthropic 场景）

- **`serveInProcess()`**：把 `createFullTestApp()` 塞进 `Bun.serve({ port: 0 })` → 拿临时端口 + `baseURL`；返回 `{ baseURL, close() }`，teardown 关闭。同进程，无跨进程开销。
- **上游屏蔽（host-scoped fetch-mock）**：复用 `setUpstreamFetchForTests`，但 mock 处理器**只拦上游 GHC host**、**放行 SDK→localhost proxy 的真实 HTTP**（否则同进程 fetch-mock 会误伤 SDK 自己的请求→自锁）。这是本轮**唯一真实未知**，作为骨架 smoke 第一步坐实。
- **脚本化上游 SSE fixture（`upstream-script.ts`）**：复用 golden 测试既有 SSE 帧 builder（`ev()`/`messageStart()`/…），把一段上游响应脚本喂给 fetch-mock（Tier 2 时同一脚本喂 hook 模块——共用格式）。
- **真实 SDK 客户端**：`new Anthropic({ baseURL, apiKey: "x" })` → `client.messages.stream(...)` / `.create(...)`；断言 SDK 侧可观测结果（拼装的 final message、流事件序列、抛出的 `APIError`、是否缺块）。

### 安全红线（承重，来自 CLAUDE.md `protect-user-main-server`）

即便本轮 Tier 1 同进程（不 spawn），骨架**任何路径都不碰 4141 主服务器**；`Bun.serve` 用 `port: 0`（内核分配临时端口）。Tier 2（延后）spawn 的 proxy 必须非 4141、按 **PID 精确 kill 自己 spawn 的实例**、绝不 `pkill`/`killall`——此红线随 Tier 2 设计一并文档化。

### 文件结构

```
tests/e2e-client/
  harness/
    serve-in-process.ts     # Bun.serve(app, port:0) + baseURL + close()
    upstream-script.ts      # 脚本化上游 SSE fixture → host-scoped fetch-mock（Tier2 共用喂 hook）
  anthropic-sdk.e2e.test.ts # Tier1 Anthropic 场景集
  # (Tier2 anthropic-cli.e2e.test.ts —— 延后，接入点预留)
```

## Anthropic 场景集（Tier 1，深先于广）

| 场景 | oracle 断言（客户端可观测，非我方字节） |
|---|---|
| eventless 帧被 SDK 丢弃 | 上游给一个缺 `event:` 行的 data 帧 → 断言 SDK 拼装**缺**该块（正向反证 `anthropicSseFrame` 契约存在必要性；守 [sse-frame.ts](../../src/lib/anthropic/sse-frame.ts)） |
| refusal `end_turn` 模式 | 上游 thinking-only refusal + `refusal_sse_rewrite:end_turn` → SDK 拼出含 recovery text 的完整 turn、`stop_reason:"end_turn"`、无异常 |
| refusal `error` 模式 | 同上游 + `error` 模式 → SDK **`throw APIError`**、不自动重试 |
| refusal 空串 end_turn | `refusal_end_turn_text:""` + `end_turn` → SDK 无错拼出 thinking + **无 text 块** + `end_turn`（stall 终裁属 Tier 2） |
| 200 + 流内 SSE error | 上游 200 后发 `event: error` → SDK `throw APIError` 而非静默截断成 complete |
| tool_use 拼装 | 上游 tool_use 流 → SDK final message 正确含 `tool_use` block + input JSON |
| thinking 拼装 | 上游 thinking + signature_delta → SDK 正确拼出 thinking block（signature 保真） |

## 依赖与既有基建复用

- `@anthropic-ai/sdk` 0.106.0 已装（本轮 Tier 1）；`openai`/`@google/genai` 已装（后续 vendor）。
- `createFullTestApp`（全路由真实 proxy app）、`setUpstreamFetchForTests`/`applyFetchMock`（fetch-mock 基建）、golden 的 SSE builder——全复用，不重造。
- `claude` 2.1.207 已在 PATH（Tier 2 用，本轮不触）。

## 测试策略（骨架自身如何被信任）

- **正样本对照**：每个「SDK 丢帧/throw」的否定性断言，先用一个**正常帧**证 SDK 在该 harness 下能正确拼装/不 throw（证 harness 真的驱动了 SDK、断言触达目标），再断言坏 case——对齐 `verifying-authoritative-claims`「否定断言不自证」。
- **fetch-mock 隔离验证**：smoke 第一步显式断言 SDK→proxy 的 localhost 请求真实发出（未被 mock 误吞）、且上游 GHC 请求确被拦（proxy 没真打 GHC）。
- **确定性**：无真实网络、无 sleep；流式场景用脚本化帧序，必要时连跑多次证时序确定。

## 待确认/未知

1. **host-scoped fetch-mock 隔离**（唯一真实未知）：同进程下 mock 只拦上游 GHC host、放行 localhost proxy。骨架 smoke 第一步坐实（若 `setUpstreamFetchForTests` 的 mock 无法按 host 分流，退路=在 mock 处理器内按 URL host 判断 `realFetch` passthrough）。
2. **SDK 流式 API 形状**：`client.messages.stream()` 的事件/final-message 取法（`.finalMessage()` / event handlers）——实现时对齐 0.106.0 API。

## 验收标准

1. `serveInProcess()` 起真实 proxy app 于临时端口，真实 `@anthropic-ai/sdk` 经 `baseURL` 打通，上游 GHC 被 mock 屏蔽（smoke 证 localhost 放行 + GHC 拦截）。
2. 场景集全部以**客户端可观测行为**为 oracle（SDK 拼装结果 / 抛错 / 缺块），非断言我方字节。
3. 每个否定性断言有正样本对照证 harness 触达目标。
4. refusal `error` 模式场景证 SDK `throw APIError`；`end_turn`/空串场景证 SDK 无错拼装。
5. eventless-帧场景证 SDK 丢弃（守 `anthropicSseFrame` 必要性）。
6. 骨架 vendor 无关：新增 openai/gemini 或 CLI Tier 2 无需重构核心（接入点预留、文件结构支持）。
7. 全程不触 4141；同进程 `port:0`。
