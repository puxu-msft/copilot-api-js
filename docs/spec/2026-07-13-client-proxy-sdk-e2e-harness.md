# Spec: client↔proxy SDK e2e 骨架（屏蔽上游）

- **状态**：**已落地——Tier 1（SDK，9 场景）+ Tier 2（CLI，2 gated 场景）**（2026-07-13）。Tier 1 commits `54117ce8`+`b6b142dd`；Tier 2 commit `68538cc2`（`tests/e2e-client/anthropic-cli.e2e.test.ts` + `harness/{spawn-proxy,drive-claude-cli,cli-refusal-hook}`）。**Tier 2 实证了 refusal-text spec 里标记的空串 stall 终裁：会 stall**（真 claude → 真 proxy → hook-mock refusal → 空串 end_turn → `num_turns=2, result=""`）。
- **日期**：2026-07-13
- **实测坐实结论（harness 揭示的真实客户端/proxy 行为）**：① `setUpstreamFetchForTests` 是上游专用注入点、不碰 `globalThis.fetch`——隔离零风险（探针证 SDK 真打 localhost + upstream 恰调 1 次）；② SDK 0.106.0 在流式与非流式路径**均不给 text 块合成 `citations` 字段**；③ **proxy 原样转发 eventless 帧**（裸 fetch 探针证 content_block_start 无 `event:` 行透传），SDK 确实丢弃 eventless 帧——但一个 eventless content_block_**START** 会被后续带 event 的 delta 遮蔽（delta 宽容地重开块），须丢**内容 delta** 才可观测；④ refusal `error` 模式 SDK `throws APIError` + upstream 调用次数==1（`maxRetries:0` 证不重试）；⑤ 200+流内 `event: error` 下 SDK 同步 `throws APIError`（非静默 complete）。
- **相关**：brainstorming 本会话、[docs/refusal-recovery.md](../refusal-recovery.md)（空串 stall 盲区来源）、skill `upstream-hook-mocking`、skill `debugging-claude-client-connection`（CC 客户端行为域）、[tests/helpers/test-app.ts](../../tests/helpers/test-app.ts)（`createFullTestApp`）、[src/lib/transport/upstream-fetch.ts](../../src/lib/transport/upstream-fetch.ts)（`setUpstreamFetchForTests` 注入点）、ADR [richest-data-flow](../decisions/2026-07-05-richest-data-flow.md)（合成帧可辨识——本骨架用真实 SDK 反证 wire 契约）

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

- **`serveInProcess()`**：把 `createFullTestApp()` 塞进 `Bun.serve({ fetch: app.fetch, port: 0 })` → 内核分配临时端口，**从 `server.port` 动态读**构造 `baseURL`；返回 `{ baseURL, close() }`，teardown 关闭。同进程、无跨进程开销。注记：① `Bun.serve` 默认 `idleTimeout` 10s——Tier1 脚本化流够快无碍，慢流场景需显式抬高；② 该 app 注册了 History WebSocket 路由，裸 `Bun.serve`（无 `websocket` handler）不会 upgrade——**Tier1 SDK 场景不覆盖 WS 路由**，WS/Tier2 另行。
- **上游屏蔽（上游专用注入点，非全局 fetch-mock）**：**直接 `setUpstreamFetchForTests(upstreamScriptHandler)`**——该 primitive 替换 `upstream-fetch.ts` 的模块级 `activeUpstreamFetch`，**只被 `upstreamFetch()`（proxy→GHC 唯一出口）调用**，**全程不碰 `globalThis.fetch`**。故真实 SDK 的 `globalThis.fetch`（`@anthropic-ai/sdk` 默认 fetch）打 localhost proxy 走真实 HTTP、proxy→GHC 走注入 handler，**两条路天然隔离、无需 host-scoping/passthrough**。**绝不复用 golden 的 `applyFetchMock`/`setFetchMock`**（那俩装 `globalThis.fetch = mock` 会误伤 SDK 自己的请求→自锁；golden 用它无害只因走 `app.request()` 无真实 SDK）。可选第三重保险 `new Anthropic({ fetch })`（本轮不必）。**（原「host-scoped 唯一未知」经代码核实为表述错位——见「待确认」节修订）**
- **脚本化上游 SSE fixture（`upstream-script.ts`）**：复用 golden 既有 SSE 帧 builder（`ev()`/`messageStart()`/…），把一段上游响应脚本包成 `UpstreamFetchFn` handler（返回 SSE `Response`）喂给 `setUpstreamFetchForTests`。**Tier1/Tier2 共用同一脚本格式**（Tier2 改喂 hook 模块）——「接入点预留」的具体结构约束、非口号。
- **config/state（camelCase state 键 + 状态卫生）**：场景所需 config 经 **`setStateForTests`（camelCase state 键，如 `refusalSseRewrite`/`refusalEndTurnText`，**非** YAML 键 `refusal_sse_rewrite`）** 设置。`setStateForTests` 是 **MERGE 不 reset**：进程全局 `~/lib/state` 下场景**串行**，每场景 `beforeEach` 复位 refusal 三键（`refusalSseRewrite`/`refusalEndTurnText`/`refusalErrorMessage`/`refusalErrorType`）+ 依赖 `useIsolatedRuntime` per-test 隔离，防前一场景 config 泄漏。
- **真实 SDK 客户端**：`new Anthropic({ baseURL, apiKey: "x", maxRetries: 0 })` → `client.messages.stream(...)`（`.finalMessage()` / event handlers）/ `.create(...)`；断言 SDK 侧可观测结果（拼装 final message、流事件序列、抛 `APIError`、是否缺块）。`maxRetries:0` 固定 + 「upstream handler 调用次数」作重试的独立 oracle。

### 安全红线（承重，来自 CLAUDE.md `protect-user-main-server`）

即便本轮 Tier 1 同进程（不 spawn），骨架**任何路径都不碰 4141 主服务器**；`Bun.serve` 用 `port: 0`（内核分配临时端口）。Tier 2（延后）spawn 的 proxy 必须非 4141、按 **PID 精确 kill 自己 spawn 的实例**、绝不 `pkill`/`killall`——此红线随 Tier 2 设计一并文档化。

### 文件结构

```
tests/e2e-client/
  harness/
    serve-in-process.ts     # Bun.serve(app.fetch, port:0) + server.port→baseURL + close()
    upstream-script.ts      # 脚本化上游 SSE fixture → setUpstreamFetchForTests handler（Tier2 共用喂 hook）
  anthropic-sdk.e2e.test.ts # Tier1 Anthropic 场景集
  # (Tier2 anthropic-cli.e2e.test.ts —— 延后，接入点预留)
```

## Anthropic 场景集（Tier 1，深先于广）

| 场景 | oracle 断言（客户端可观测，非我方字节） |
|---|---|
| eventless 帧被 SDK 丢弃 | **纯直通** stream（不激活 refusal/decode/recover，否则 `anthropicSseFrame` 会补 event 行）+ 上游 script **手写**一个无 `event:` 行、只 `data:` 的帧（共享 builder `anthropicSseFrame` 总写 event 行，须绕过手写）→ SDK final message **缺**该块（正控对照：同流带 event 行 → 块存在；守 [sse-frame.ts](../../src/lib/anthropic/sse-frame.ts) 契约必要性；注：该帧仍进 history accumulate，oracle 是 SDK 缺块非 history 缺） |
| refusal `end_turn` 模式 | 上游 thinking-only refusal + `refusalSseRewrite:"end_turn"` → SDK 拼出含 recovery text 的完整 turn、`stop_reason:"end_turn"`、无异常 |
| refusal `error` 模式 | 同上游 + `refusalSseRewrite:"error"` → SDK **`throw APIError`**；**不重试**的独立 oracle = upstream handler **调用次数 == 1**（`maxRetries:0`），非仅凭「未见重试」 |
| refusal 空串 end_turn | `refusalEndTurnText:""` + `end_turn` → SDK 无错拼出 thinking + **无 text 块** + `end_turn`（stall 终裁属 Tier 2） |
| 200 + 流内 SSE error | 上游 200 后发 `event: error` → SDK **同步 throw** `APIError`（**实测坐实，非凭文档**）而非静默截断成 complete |
| tool_use 拼装 | 上游 tool_use 流（`input_json_delta` 分片）→ SDK final message 的 `tool_use.input` **深等于**期望对象（证 partial_json 拼接 + SDK JSON.parse 成功，超出字节层） |
| thinking 拼装 | 上游 thinking + signature_delta → SDK 累积后 thinking block 的 **`signature` 字段保真**（证 signature_delta 被正确 accumulate，超出字节层） |

## 依赖与既有基建复用

- `@anthropic-ai/sdk` 0.106.0 已装（本轮 Tier 1）；`openai`/`@google/genai` 已装（后续 vendor）。
- `createFullTestApp`（全路由真实 proxy app）、`setUpstreamFetchForTests`（上游专用注入点）、golden 的 SSE builder——全复用，不重造。**`applyFetchMock`/`setFetchMock` 明确不用**（globalThis.fetch 桥、会误伤 SDK）。
- `claude` 2.1.207 已在 PATH（Tier 2 用，本轮不触）。

## 测试策略（骨架自身如何被信任）

- **正样本对照**：每个「SDK 丢帧/throw」的否定性断言，先用一个**正常帧**证 SDK 在该 harness 下能正确拼装/不 throw（证 harness 真的驱动了 SDK、断言触达目标），再断言坏 case——对齐 `verifying-authoritative-claims`「否定断言不自证」。
- **隔离验证**（smoke 第一步）：断言 SDK→proxy 的 localhost 请求真实发出（`globalThis.fetch` 未被碰）+ **upstream handler 恰被调 N 次**（proxy 没真打 GHC、且重试计数可查）。
- **确定性**：无真实网络、无 sleep；流式场景用脚本化帧序，200+SSE-error 的「同步 throw」等 SDK 行为**实测坐实**、必要时连跑多次证时序确定。

## 待确认/未知

1. **上游屏蔽隔离**（原「唯一未知」，**经代码核实为无风险、已修订**）：`setUpstreamFetchForTests` 替换 `activeUpstreamFetch`（仅 `upstreamFetch()` 用），**不碰 `globalThis.fetch`**；SDK 默认走 `globalThis.fetch` → 两条路天然隔离，**无需 host-scoping/passthrough**。smoke 第一步坐实「SDK 真打 localhost + upstream handler 恰被调 N 次」即可，无隔离逻辑要建。
2. **SDK 200+mid-stream `event: error` 是否同步 throw**（需实测）：`client.messages.stream()` 遇流内 error 帧是否 `throw APIError`（而非静默 finalMessage）——正样本对照 + 实测坐实，别凭文档（empirical-verification）。
3. **SDK 流式 API 形状**：`.finalMessage()` / event handlers 取法——实现时对齐 0.106.0 `MessageStream` API。

## 验收标准

1. `serveInProcess()` 起真实 proxy app 于临时端口（`server.port` 动态 baseURL），真实 `@anthropic-ai/sdk` 经 `baseURL` 打通，上游 GHC 被 `setUpstreamFetchForTests` handler 屏蔽（smoke 证 SDK 真打 localhost + upstream handler 恰被调 N 次；`globalThis.fetch` 未被碰）。
2. 场景集全部以**客户端可观测行为**为 oracle（SDK 拼装结果 / 抛错 / 缺块 / input 深等值 / signature 保真），非断言我方字节。
3. 每个否定性断言有正样本对照证 harness 触达目标。
4. refusal `error` 模式证 SDK `throw APIError` **且 upstream handler 调用次数==1**（`maxRetries:0`）；`end_turn`/空串场景证 SDK 无错拼装。
5. eventless-帧场景证 SDK 丢弃（守 `anthropicSseFrame` 必要性）。
6. 全程不触 4141；同进程 `port:0`。

## 设计意图（非本轮验收标准，待第二 vendor / Tier 2 接入时验证）

- **vendor 无关接缝**：`upstream-script.ts` 脚本格式与 `serveInProcess` 的 baseURL 契约设计成 Tier1/Tier2 + 多 vendor 共用；新增 openai/gemini SDK 或 CLI Tier 2 不应重构核心。~~本轮只落 Anthropic，故该断言不可证伪~~ **已证**（2026-07-13：OpenAI SDK vendor smoke `anthropic-sdk.it.test.ts` 尾部 describe，真 OpenAI SDK 打同 proxy 拼出流式 completion，核心零重构）。

## e2e 场景覆盖 roadmap（2026-07-13 考古后）

现有 **25 场景**（Tier 1 SDK 23 = Anthropic 22 + OpenAI 1；Tier 2 CLI 2），均变异验证有牙（MUTANT-A/C/D 各精准逮住对应测试）。挖掘全清单见 Explore agent 考古（本会话），来源可信度分 `[DOC-REAL]`（文档实证、最高价值）/ `[CODE-INFER]`（需实测）。

**已覆盖**：eventless 帧丢弃、tool_use input 深等、thinking signature 累积、refusal end_turn/空串/error、200+SSE-error throws、空串 stall（CLI）、**截断→throws、HTTP-4xx 类型化子类对照（400 BadRequestError / 429 RateLimitError，对照 200+SSE-error 无类型）、client-abort→APIUserAbortError、reactive-retry 内部重试透明（callCount=2）—— tool-field / cache_control-subfield / server-tool / unsupported-beta / poisoned-thinking 五腿（各腿变异摘 canHandle 后精准红）、空 delta 被 SDK 无害折叠（B1 Tier1 半）、tool-call 文本恢复、畸形 input 修复、event 名宽容、OpenAI vendor smoke**。

**未覆盖 backlog（按承重排序，供后续扩展；每条真实、多数 `[DOC-REAL]` 可直接实现或 TDD 先红）**：
- **一梯队**（生产 incident 催生）：B1 CC 300s no-real-content keepalive 墙 —— **Tier1 半已覆盖**（空 text/thinking delta 被 SDK 无害折叠、无幻块无崩），**真 300s 墙留 Tier2 计时**。~~B8 thinking 双相邻块毒化 reactive 恢复~~ ✅ **已覆盖**（400 `thinking cannot be modified` → L2 strip-all + 单重试 → callCount=2；实测坐实 outbound 保留 thinking 块可剥）。~~B9 retry 腿~~ ✅ **全覆盖**（tool-field/cache_control-subfield/server-tool/unsupported-beta 四腿，逐腿一断言 + 变异有牙）。
- **二梯队**：B2 synthetic-message-start anchor 保活、B3 block-aware 空 delta 类型匹配、B5 非流式语义截断、B10/B11 server_tool/empty-encrypted 降级、B13 HTTP-429 vs 200-error-429 CC 重试发散（**Tier1 半已覆盖**：HTTP-429→RateLimitError vs 200+SSE-error 无类型；CC 重试次数发散仍属 Tier2）、B16 buffered-retry 上游 RST 透明、B17 三类中止（client-abort/reaper/header-timeout）客户端侧区分（**client-abort 半已覆盖**：Tier1 pre-aborted signal→APIUserAbortError；reaper/header-timeout 需真计时+history，仍 Tier2）。
- **三梯队（广度）**：B12 通用翻译矩阵反向腿逐 cell（Anthropic client × CC/Responses/Gemini upstream）、B18 Responses SSE/WS keepalive、B15 合成帧空 delta 不泄漏成可见内容、B20 repetition-detector 终止、B22 cache_control 剥离透明、B23 tool name 清洗后还原。
- **需实测先坐实再固化断言**（`[CODE-INFER]`）：B3/B9/B20/B22/B23。

纪律（扩展时守）：否定断言必配正样本对照；`[CODE-INFER]` 先跑真实客户端 oracle 坐实；新绿测试做变异验证有牙（关掉被测行为→测试变红）。详见 skill `client-proxy-e2e-testing`。
