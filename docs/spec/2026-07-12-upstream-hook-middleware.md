# 上游 Transport hook 中间件（ad-hoc hook 机制）— 规格说明

> 状态：设计定稿 v2（brainstorming 敲定 + 2 轮 subagent 对抗评审 + 亲手实测核实全部承重断言，待用户审查 → writing-plans）。本文件自包含。
> 关联：调研锚点 [docs/plan/2026-07-12-upstream-hook-middleware-KICKOFF.md](../plan/2026-07-12-upstream-hook-middleware-KICKOFF.md)（已完成的探索，本 spec 取代之）。
> 评审修订：见 §11「评审裁决记录」——B1（Bun `?v=` 热重载实测为假→data-URL）、H1（onRequest 位置）、H2/BLOCK-1（mock 帧毒化 history 上游轨）、H3（mockUpstreamError 契约）、H4（CC/Gemini 回放有损）等均已核实并采纳。

## 1. 背景与目标

**源起**：2026-07-12 cache_control 子字段剥离特性的实测中，发现「验证代理行为不得不真发 GHC」——消耗 Copilot 额度、依赖网络、且**无法构造特定上游响应**（如 400、畸形 decode 腔）来测 reactive 学习腿。用户提出需要一个 hook 机制：既跑本 proxy 的**完整处理管线**，又能给出 mock 的上游交互。

**目标**：在 proxy 处理管线的**上游边界**引入一组可选的 ad-hoc hook 挂载点，让开发者用一个 config 声明的 JS/TS 文件，在不真发 GHC 的前提下 mock / 拦截改写 / 录制回放 / 注入故障，同时前置的 sanitize、cache_control 剥离、格式翻译、retry 腿全部走**真实处理**。

**四个确认用途**（2026-07-12 AskUserQuestion 全选）：① Mock 上游响应 ② 拦截/改写请求响应 ③ 录制-回放 ④ 注入故障/延迟。

## 2. 范围与已确认决策（勿擅自更改）

以下决策已与需求方逐条确认（2026-07-12 brainstorming）：

| 维度 | 决策 | 理由 |
|---|---|---|
| **注入接缝** | 收口进 `createPipelineDriver` 内部；6 处 handler transport 构造点**一行不改** | driver 是 transport 唯一消费者、也是 stage 编排者，天然收口 |
| **hook 粒度** | driver 编排的**多挂载点**（非单一 transport decorator）；同一 hook 模块按参数自辨 model/endpoint/format；**无声明式匹配** | 用户明确要「分阶段多挂载点 + 同 hook 按参数区分、不用声明式」 |
| **挂载点** | 三个：`onRequest`（一次性请求点）、`onExchange`（S4 核心）、`rewriteUpstreamFrame`（逐帧改写）；全部可选、未导出=直通 | against-YAGNI，三个都要 |
| **mock 编写接口** | 高层 helper 工具箱 + **raw 逃生口**（直接返回 `UpstreamStream`） | helper 覆盖 90%，raw 造任意畸形帧 |
| **录制-回放源** | **复用 history.db** 的 `upstreamResponse.sseEvents`（每请求已自动录，零新录制路径） | 无需独立 cassette 文件 |
| **格式 helper** | Anthropic / CC / Gemini 三份 mock 一次都做 | against-YAGNI |
| **加载** | config 声明模块路径 + 显式 `enabled` 开关；启动时 `import()` 一次 | 对齐 config 声明式 + 可选 code 模式 |
| **热重载** | **仅经管理 API** `POST /api/hooks/reload` 触发（**不**做 per-request mtime 检查） | 用户明确「仅 API 支持更好」；更显式、零隐式 per-request 开销、时机可控 |
| **安全** | 默认 `enabled:false` + config 显式启用 + 建议仅开发/测试环境；hook 抛错 warn-continue 绝不杀进程 | 项目 `internal-tool-security-posture`（内部开发工具） |

**明确不做（本特性范围外）**：独立 cassette 文件格式（复用 history 已足够）；声明式 match 路由（用户否决）；per-request 自动重载（用户否决）；env var / 请求头级 opt-in（config 已足够）；上游 WS（Responses ws:）的 hook——见 §8 边界。

**正交独立微改动**（用户顺带提，与 hook 无关、单独 commit）：根路径 `/` 从纯文本 `"Server running"` 改为 302 重定向到 `/openapi.json`（见 §7）。

## 3. 架构：driver 编排的多挂载点

### 3.1 上游边界与收口点

所有上游交互经过唯一窄接口 `Transport.send(wire: PreparedRequest, env: RequestEnvelope): Promise<UpstreamStream>`（[src/lib/pipeline/types.ts:108](../../src/lib/pipeline/types.ts#L108)）。driver 在 retry 循环里每 attempt 调一次 [src/lib/pipeline/driver.ts:310](../../src/lib/pipeline/driver.ts#L310) `await deps.transport.send(wire, current)`。

`UpstreamStream = { frames: AsyncIterable<UpstreamFrame>, nonStream?: unknown, headers: Headers }`（[types.ts:63](../../src/lib/pipeline/types.ts#L63)），`UpstreamFrame = SseFrame = { event?, data?, id?, retry? }`（[stream.ts:189](../../src/lib/stream.ts#L189)）。

**收口点**：`createPipelineDriver`（[driver.ts:134](../../src/lib/pipeline/driver.ts#L134)）内部读一个 module-global hook 单例（`getUpstreamHook()`），在它已编排的 phase 边界回调对应挂载点。6 处 handler 构造点（messages / chat-completions / gemini 用 `createUpstreamHttpTransport`，responses / ws 用 `createUpstreamResponsesTransport`）**一行不改**。

### 3.2 三个挂载点

hook 模块 `export` 关心的挂载点，全部可选；**未导出该挂载点 = 该边界直通**（零行为改变、字节等价）。

| 挂载点 | phase / 位置 | 签名 | 覆盖用途 |
|---|---|---|---|
| `onRequest` | **一次性**请求点：`runRequest` 内、`runRewriteIn` 后、`runExchange` 前（[driver.ts:187-196](../../src/lib/pipeline/driver.ts#L187) 之间） | `(env: RequestEnvelope) => RequestEnvelope \| undefined` | 人体工学地改写逻辑请求（不返回 / 返回 undefined 直通） |
| `onExchange` | S4 上游交换（**核心**），包裹 `deps.transport.send`（[driver.ts:310](../../src/lib/pipeline/driver.ts#L310)） | `(wire: PreparedRequest, env: RequestEnvelope, next: () => Promise<UpstreamStream>) => Promise<UpstreamStream>` | 四用途全覆盖（见 §3.3） |
| `rewriteUpstreamFrame` | 响应逐帧，**在 driver 上游-original 采样之后、rewrite 链之前**（[driver.ts:446-449](../../src/lib/pipeline/driver.ts#L446) 之间） | `(frame: UpstreamFrame, env: RequestEnvelope) => UpstreamFrame \| undefined` | 逐帧改写；返回 `undefined` 丢弃该帧 |

**改名说明（评审 M3）**：逐帧挂载点命名为 `rewriteUpstreamFrame`（非 `onUpstreamFrame`），以区分 driver 既有的 `RunResponseOpts.onUpstreamFrame`（[types.ts:243](../../src/lib/pipeline/types.ts#L243)，handler 内部的**观察-only** 采样 sink）——两者同在 runResponse 触发但语义相反（观察 vs 改写），复用同名会成维护陷阱。

**位置语义（评审 H1 + H2，均已核实）**：
- `onRequest` 是**一次性**改写，故落在 retry 循环**之外**（[driver.ts:187-196](../../src/lib/pipeline/driver.ts#L187)）。**绝不**放进 S4 loop 内：那里 `current` env 会被 reactive 策略（beta-strip / tool-field-strip）逐轮修正，循环内重放 onRequest 会清掉策略的 env 修正、破坏学习腿（与本特性核心动机直接冲突）。这与同位置的 `preSend`（[driver.ts:296](../../src/lib/pipeline/driver.ts#L296)）专用 `preflightDone` 守卫成一次性同理。
- `rewriteUpstreamFrame` 落在 [driver.ts:446](../../src/lib/pipeline/driver.ts#L446) 的 `onUpstreamFrame` 采样**之后**、rewrite 链之前——保证 driver 的**上游-original track 永远记 hook 改写前的真实上游帧**（见 §3.4 承重不变量），改写只影响 forwarded 投递侧。

**重要语义**：`onExchange` 在 driver 的 **retry 循环内**调用。实际触发次数 = **L1 attempts × L2 buffered-retry re-exchanges**（`runExchange` 有两个调用点：[driver.ts:196](../../src/lib/pipeline/driver.ts#L196) runRequest + [driver.ts:751](../../src/lib/pipeline/driver.ts#L751) buffered-retry sink，评审 M1 核实）。对返回固定响应的 mock 无害，但 record-replay / 有状态 fault 注入的 hook 作者须知「同一 hook 在一个客户端请求内可能被调 (L1×L2) 次」——spec 与 helper 文档必须显式说明。

### 3.3 `onExchange` 如何覆盖四用途

| 用途 | hook 行为 |
|---|---|
| Mock 上游响应 | 不调 `next`，返回合成 `UpstreamStream`（离线、零额度） |
| 拦截/改写 | 调 `next` 前改 `wire`，或调 `next` 后改返回 stream |
| 录制-回放 | 回放：`replayFromHistory(reqId)` 返回存档 stream 不调 `next`（录制复用 history，无需 hook 侧录） |
| 注入故障/延迟 | 返回 error（`mockUpstreamError(400)`）/ 延迟（`delay`）/ 断流（`truncateAfter`）的 `UpstreamStream` |

**红利**：hook 只在这些窄边界介入，前面的 sanitize / cache_control 剥离 / 格式翻译 / retry 腿全是真实处理——复用代理完整管线，只 mock 指定的那一段。

### 3.4 承重不变量：hook 产物在 history 必须可辨识（评审 BLOCK-1 / H2，双评审交叉印证）

这是本 spec 最承重的数据模型决策，写码前必须钉死（history 是 SSOT，误记不可逆）。

**问题**：`onExchange` 不调 `next` 返回的合成帧、`rewriteUpstreamFrame` 改写的帧，会被 driver 当**上游原始响应**记进 history `attempts[].upstreamResponse.sseEvents`（[driver.ts:440](../../src/lib/pipeline/driver.ts#L440)）。但项目 Accepted ADR [richest-data-flow](../decisions/2026-07-05-richest-data-flow.md) §3 明文：**上游-original track 绝不含合成物，合成物只进 forwarded 轨且打显式标记**。把 hook 伪造的假 400 / 假 deltas 记进上游轨、伪装成「GHC 真的这么回」，会让事后诊断、reactive-learning 分析、`replayFromHistory` 把 mock 流量当真实流量——正是 ADR 与项目记忆 [synthetic-data-must-be-distinguishable-from-real](../memory/feedback-synthetic-data-must-be-distinguishable-from-real.md) 要防的类别。

**已核实**：[driver.ts:440](../../src/lib/pipeline/driver.ts#L440) 的 `upstreamSse.push` **从不设 `synthetic`**；`SseEventRecord.synthetic` 当前联合类型 `"keepalive" | "anchor" | "synthetic-message-start"`（[types.ts:164](../../src/lib/history/types.ts#L164)）无 hook 取值。

**决策**：
1. **扩展 `SseEventRecord.synthetic`** 增加 `"hook-mock"`（onExchange 合成的整个上游流）与 `"hook-rewrite"`（rewriteUpstreamFrame 改写/注入的单帧）、`"hook-replay"`（replayFromHistory 回放帧）三个取值。**改动范围（勘探核实，修正初稿假设）**：只需改 [history/types.ts:164](../../src/lib/history/types.ts#L164) 一处联合——ui-v4 [SseEventsSegment.tsx:27-34](../../ui-v4/src/components/detail/segments/SseEventsSegment.tsx#L27) 只把 `synthetic` 当字符串渲染（**无 exhaustive switch/Record**，故初稿「打爆 ui-v4 穷尽 Record」是过度假设，不成立）；后端 [client-sink.ts:167](../../src/lib/pipeline/client-sink.ts#L167) 的复制联合是 **forwarded 侧**采样参数，hook 上游轨标记不流经它（可选对称扩展，非必需）。`typecheck:ui-v4` 仍跑（守 `~backend/*` 纯度）但不会因此 union 报错。
2. **上游-original track 永远记 hook 改写前的真实帧**：`rewriteUpstreamFrame` 在 [driver.ts:446](../../src/lib/pipeline/driver.ts#L446) 采样**之后**介入（§3.2 已定位），故上游轨天然是 pre-hook 真实帧；改写只进 forwarded 投递侧。
3. **`onExchange` 全 mock 的流**（hook 即上游、无真实上游可言）：这些帧进上游轨时**强制打 `synthetic:"hook-mock"`**——driver 在 `getUpstreamHook()?.onExchange` 生效且 hook 未调 `next`（返回的流带内部 mock 标记）时，给 `upstreamSse.push` 的记录标记 `hook-mock`。这是 richest-data-flow「合成物必打标记」的落地。
4. attempt 级 provenance（可选增强）：`UpstreamResponseData` 可增 `source?: "upstream" | "hook-mock" | "hook-replay"`，`attempts[].effectiveSource`（[types.ts:339](../../src/lib/history/types.ts#L339)）是现成近亲落点。首版以帧级 `synthetic` 标记为准，attempt 级 source 记 §10 待评估。

## 4. hook 模块契约 + helper 工具箱

### 4.1 模块形状

一个 ad-hoc TS 文件，`export` 关心的挂载点（示意）：

```ts
// exp/my-hook.ts —— 同一模块按 wire/env/frame 参数自辨，无声明式匹配
import { mockUpstreamError, mockAnthropicMessage, replayFromHistory } from "~/lib/pipeline/hooks"

export const onRequest = (env) => { /* 改 env.body / 不返回（undefined）直通 */ }

export const onExchange = async (wire, env, next) => {
  if (env.model?.id === "claude-opus-4-8") return mockUpstreamError(400, { type: "invalid_request_error" })
  return next() // 其余真发 GHC
}

export const rewriteUpstreamFrame = (frame, env) => frame // 改/丢帧（返回 undefined 丢弃）
```

### 4.2 helper 工具箱

从稳定路径 `~/lib/pipeline/hooks` 导入（hook 文件在同进程加载，别名可解析——见 §6 工程约束）：

| helper | 产出 | 覆盖用途 |
|---|---|---|
| `sse(event, dataObj)` / `streamOf(frames, headers?)` | 单帧 / 打包成 UpstreamStream | 通用积木 |
| `mockAnthropicMessage(text)` | 格式合法完整 Anthropic SSE 序列（message_start→content_block_start→deltas→stop→message_delta→message_stop） | mock 上游响应 |
| `mockCcChunks(text)` | 格式合法完整 CC/OpenAI chunk 序列 | mock 上游响应 |
| `mockGeminiResponse(text)` | 格式合法 Gemini generateContent 响应 | mock 上游响应 |
| `mockUpstreamError(status, body?)` | 抛出真正的 `HTTPError`，其 `.responseText` 携带 `body`（见下契约） | 注入故障 + **驱动 reactive retry 腿**（核心动机） |
| `replayFromHistory(reqId \| filter)` | 从 history `upstreamResponse.sseEvents` 重建 UpstreamStream | 录制-回放（见 §5） |
| `delay(ms)` / `truncateAfter(n, stream)` | 延迟 / 断流包装器 | 注入延迟/断流 |

**`mockUpstreamError` 契约（评审 H3，已核实）**：核心动机是「驱动 reactive retry 腿」，但 reactive 策略的 `canHandle` 匹配依据是 `error.message` 正则 **与** `error.raw.responseText`（[tool-field-rejection-retry.ts:89](../../src/lib/anthropic/tool-field-rejection-retry.ts#L89) 等），而 `classifyError` 只对 `instanceof HTTPError` 保留 `responseText`（[classify.ts:50](../../src/lib/error/classify.ts#L50)）。故 helper **必须**构造真正的 `HTTPError(message, status, responseText, …)`，`body` 序列化进 `responseText`。若只塞 `{type:"invalid_request_error"}`（如 §4.1 示例的简化），`canHandle` 不命中 → 核心用途**静默失败**。因此 helper 附带**命中各 reactive 策略的判别性 body 预设**：`mockUpstreamError.toolFieldRejection()` / `.serverToolRejection()` / `.unsupportedBeta()` / `.cacheControlSubfield()` 等（每个产出该策略正则能命中的 responseText 腔），并用**独立 oracle**（真跑一遍 driver 确认策略被触发）校验、而非自证。

**raw 逃生口**：`onExchange` 可直接返回手构的 `UpstreamStream`（`frames` 为 `AsyncIterable<SseFrame>`），造**任意畸形帧序列**（原始动机）。helper 是便利层，非唯一途径。

**逃生口守卫语义（评审 L2）**：`onExchange` 不调 `next` 返回的 mock 流**绕过** `guardSseIterable`（idle/shutdown/client-abort 守卫）与 adaptive rate-limiter（均在 `transport.send` 内、[driver.ts:310](../../src/lib/pipeline/driver.ts#L310) 之下）。这是设计使然（mock 无需真实守卫），但 helper 文档须提醒：手构 mock 流不具备 idle-guard 语义，若要测超时/断流须自行在 raw 逃生口构造。

**独立 oracle 校验**（TDD 纪律，非自证）：格式 helper 产出的帧序列必须用**独立的现有 accumulator**（`create*StreamAccumulator`）重放校验其合法性，而非拿 helper 自己的输出比对自己。

## 5. 录制-回放：复用 history.db

history 每请求已自动录上游原始帧到 `upstreamResponse.sseEvents: Array<SseEventRecord>`，`SseEventRecord = { offsetMs, type, raw, synthetic? }`（[src/lib/history/types.ts:142](../../src/lib/history/types.ts#L142)）。

**关键：`raw` 只是 `data:` 负载，不含 event 行（评审 H4，已核实）**。[driver.ts:440](../../src/lib/pipeline/driver.ts#L440)：`raw: frame.data ?? ""`，event 名单独进 `type`，且对无 event 行的帧被**伪造**成 `"message"`/`"keepalive"`（[types.ts:145](../../src/lib/history/types.ts#L145) 注释亦证）。这决定回放的保真度按格式分层：
- **Anthropic**：`frame.event` 恒有（`message_start` 等）→ `type` == 真 event 名 → **可无损 round-trip**（核心场景够用）。
- **CC/OpenAI、Gemini**：chunk **无 event 行** → `type` 被伪造成 `"message"` → 回放必须从 `type` 区分「真 event 名 vs 伪造标签」，对伪造标签 **不写 event 行**（否则注入上游从未发过的 `event:message`）。

`replayFromHistory(reqId | filter)`：
1. 按 `reqId`（或过滤器如 `{ model, endpoint, latest: true }`）查 history entry。
2. 取 `attempts.at(-1).upstreamResponse.sseEvents`（最终 attempt 的上游原始帧）。
3. 按上述格式分层把每条 `{type, raw}` 重建为 `SseFrame`：Anthropic 直接 `{event:type, data:raw}`；CC/Gemini 对伪造标签只 `{data:raw}`。产出 `AsyncIterable<SseFrame>`，包装成 `UpstreamStream`（headers 从记录的 `upstreamResponse` 头重建，缺失则空 Headers）。
4. **回放的帧进上游轨时打 `synthetic:"hook-replay"`**（§3.4——回放的是「历史真实帧的复制」，非本次真实上游通信，须可辨识）。

**M2 澄清（评审）**：上游-original track（`upstreamResponse.sseEvents`）的记录**从不含** proxy 合成的 keepalive/anchor 帧（那些只在 forwarded track `clientResponse.sseEvents` 有 `synthetic` 标记，[types.ts:148](../../src/lib/history/types.ts#L148)）。故回放读上游轨时**无需过滤 synthetic**（上游轨本就没有）——初稿的「过滤 synthetic 帧」是把两条 track 搞混的死逻辑，已删除。若确需回放含 keepalive 的 forwarded 视图，另提，读 `clientResponse.sseEvents`。

**零新录制路径**：录制天然已发生（每请求），回放只读。这是选「复用 history」而非独立 cassette 的核心收益。

## 6. config 声明 + 加载 + 仅 API 热重载

### 6.1 config section

新 `hooks` section（Zod `.strict()`，对齐 [src/lib/config/schema.ts](../../src/lib/config/schema.ts) 现有模式）：

```yaml
hooks:
  upstream_module: "./exp/my-hook.ts"   # 未设 = 特性完全关闭、零开销
  enabled: false                         # 默认 false；true 才加载
```

映射进 `state`（`hooksUpstreamModule` / `hooksEnabled`），登记 config 完整性矩阵。**完整触点清单（评审 L1 计数更正 + HIGH-1 补漏，均已核实）**：

1. `schema.ts` — 新 `HooksConfigSchema = z.object({...}).strict()` + `export type HooksConfig = z.infer<...>`（对齐 [schema.ts:883](../../src/lib/config/schema.ts) 导出惯例）。
2. `config.ts` — apply 映射（config → state）。
3. `state.ts` — `MutableState` 接口声明 **+** `mutableState` 初值字面量（[state.ts:1615](../../src/lib/state.ts#L1615) 引 `CONFIG_MANAGED_DEFAULTS`）——**两处编辑点**。
4. `CONFIG_MANAGED_DEFAULTS` — 登记默认值（见 HIGH-2 语义澄清）。
5. `resetConfigManagedState` — 重置逻辑（见 HIGH-2）。
6. setter。
7. **`route.ts:257 mergeConfigIntoDocument()`**（评审 HIGH-1 补漏）——PUT `/api/config/yaml`（config UI 写路径）为每个 nested section 显式写一行（[route.ts:257-304](../../src/routes/config/route.ts#L257)：history/openai_responses/shutdown/…）。**漏了它 config UI 就无法持久化 `hooks` section**（PUT 静默丢弃）。须补 `hooks` 分支。
8. bundled `config.yaml` 注释 + `/api/config` 完整性守卫测试（[tests/config/config-effective-route.http.test.ts:46](../../tests/config/config-effective-route.http.test.ts#L46) 强制任何进 `CONFIG_MANAGED_DEFAULTS` 的键出现在 `/api/config`）。

**HIGH-2 语义澄清（config 声明态 vs 实际生效态分离，已核实矛盾）**：`hooksEnabled`/`hooksUpstreamModule` 进 `CONFIG_MANAGED_DEFAULTS` 后会随 config 热重载/PUT 被 `applyConfigToState`（每请求，[config.ts:488](../../src/lib/config/config.ts#L488)）+ `resetConfigManagedState`（每次 PUT，[route.ts:131](../../src/routes/config/route.ts#L131)）改写，但**实际加载的 hook 模块单例**（`getUpstreamHook()`）只有 `POST /api/hooks/reload` 才重载。若不调和，`GET /api/config` 会显示声明态、实际跑的可能是旧模块——config 声明与生效态发散且不可观测。**决策**：
- `hooksUpstreamModule`/`hooksEnabled` 是 config **声明**（意图），进 state 正常（供 `/api/config` 显示意图）；但 `applyConfigToState` **不触发模块加载/重载**（模块加载只在启动期一次 + `POST /api/hooks/reload`）——即它们是「声明字段」而非「热重载生效字段」，spec 明确二者脱钩。
- 「实际生效态」（当前加载的模块 + 版本 + 上次重载结果）经独立的 `GET /api/hooks` 暴露（见 §6.5），与 `/api/config` 的声明态并存、可对账。

### 6.5 生效态可查面 `GET /api/hooks`（评审 MEDIUM-1）

§6.3 的 POST 回执是 ephemeral 的（只发起者可见）。新增 `GET /api/hooks` 返回常驻生效态：`{ enabled, declaredModule, loadedModule, loadedAt, version, exports: [...], lastReloadError? }`。`version`/`loadedAt` 用重载时的时间戳（§6.3 的 data-URL 唯一性时间戳）。回答「现在跑的是哪个模块/哪个版本、上次重载是否失败」——满足诊断诉求，对齐 richest-data-flow 常驻暴露富状态。

### 6.2 加载器（新 leaf `src/lib/pipeline/hooks/loader.ts`）

- **启动时**：`enabled && upstream_module` 已设 → 用 §6.3 的 data-URL 机制加载一次 → 校验导出形状（`onRequest`/`onExchange`/`rewriteUpstreamFrame` 至少一个、且为函数）→ 存入 module-global。失败 → warn-continue，**绝不阻塞启动**、module-global 保持 `undefined`（直通）。
- **module-global 单例** + `getUpstreamHook()` getter（对齐项目 state/models 单例模式）；driver 经 getter 读取，未配置时为 `undefined` → 所有挂载点惰性直通、**生产零开销**。

### 6.3 仅 API 热重载

新端点 `POST /api/hooks/reload`（归属 `/api/hooks`，对齐 [src/routes/index.ts:88-94](../../src/routes/index.ts#L88-L94) 的 `/api/*` 管理路由）：

1. **加载机制（评审 B1，Bun 1.3.14 实测修正）**：读磁盘源 → `new Bun.Transpiler({ loader: "ts" }).transformSync(src)` → `import("data:text/javascript," + encodeURIComponent(js))`。每次 data-URL specifier 唯一 → 绕过 ESM 缓存重新加载。
   > **不用 `?v=` cache-busting query**（not-adopted）：初稿假设 `import(url + "?v=" + Date.now())` 是 Bun/Node 通用手法，但**实测为假**——Bun 按解析后的文件路径缓存、忽略 query string，`.ts`/`.mjs` 均静默返回旧模块。`?v=` 是 Node 专有手法。data-URL 方案实测重载成功，且**仍解析 `~/` 别名 import**（保住 §4.2 helper 契约——data-URL 模块与 exp/ 真实文件的别名解析均已实测通过）。详见项目记忆 [[reference-bun-esm-cache-busting-query-fails-data-url-works]]。
2. **校验形状**：成功 → **原子替换** module-global + 记 `loadedAt`/`version`；失败 → **保留旧 hook** + 返回错误 JSON + 记 `lastReloadError` + warn-continue，**绝不杀进程**（严格对齐项目 [config 哲学：警告并继续](../memory/feedback-config-philosophy-separate-compat-and-warn-continue.md)——运行时热重载绝不因配置/代码问题杀进程）。
3. **富数据回执**（`richest-data-flow`）：`{ ok, module, exports: ["onExchange","rewriteUpstreamFrame"], version, error? }`——让调用者确认加载了哪些挂载点。常驻生效态另经 `GET /api/hooks` 查（§6.5）。

**不做 per-request mtime 检查**（用户否决）：改完 hook 文件 → 手动 `curl -X POST .../api/hooks/reload` → 即刻生效。

### 6.4 工程约束

ad-hoc hook 文件用 `import()` 在**同进程**加载（Bun 直接跑 .ts）。要用 `~/...` 别名 import helper，文件须处于别名可解析的位置——**建议放 `exp/` 或 `tests/`**（别名已配、符合项目 `keep-poc-in-project`）。放仓库外则需相对路径或包导出。对内部开发工具这是可接受约束，README/config 注释须说明。

## 7. 正交微改动：根路径重定向

[server.ts:88](../../src/server.ts#L88) `server.get("/", (c) => c.text("Server running"))` → `c.redirect("/openapi.json")`。UI 仍在 `/ui`、`/ui-v4`，不受影响。**单独 commit**，与 hook 特性解耦。

## 8. 边界与暂缓

- **上游 WS（Responses ws:/responses）**：`onExchange` 收口在 `Transport.send`，覆盖 http-transport（messages/cc/gemini）+ responses-transport 的 HTTP 腿。Responses 的**上游 WebSocket** 腿（[src/routes/responses/ws.ts](../../src/routes/responses/ws.ts)）是 transport-internal 的独立通道——本特性首版覆盖 `Transport.send` 边界即可（四用途在 http 腿全满足）；WS 腿的 hook 若需要，记 `docs/todo/deferred-backlog.md` 后续。
- **非流式响应**：`onExchange` 返回的 `UpstreamStream` 可带 `nonStream`；helper 覆盖流式为主，非流式 mock 用 raw 逃生口构造 `{ nonStream, headers }`。
- **`rewriteUpstreamFrame` 与 driver 现有 `RunResponseOpts.onUpstreamFrame`**（[types.ts:243](../../src/lib/pipeline/types.ts#L243)）：后者是 handler 内部的 upstream-original 采样 hook（观察用）。本特性的挂载点已**改名为 `rewriteUpstreamFrame`**（评审 M3）并**定位在 [driver.ts:446](../../src/lib/pipeline/driver.ts#L446) 采样之后**（§3.2），故上游-original track 天然记 pre-hook 真实帧、改写只进 forwarded 侧——初稿「留到实现时确认」的先后关系已在 §3.2/§3.4 钉死（评审 H2）。

## 9. 测试策略（TDD）

- **单元**：
  - 加载器：形状校验、**data-URL 重载**（改文件→重载拿到新版本，回归 B1）、warn-continue 不抛、失败保留旧 hook + 记 `lastReloadError`。
  - helper 工具箱：各 mock 产出合法帧序列——用独立 accumulator oracle 校验（§4.2），非自证。`mockUpstreamError` 的判别性 body 预设 → 真跑 driver 确认对应 reactive 策略 `canHandle` 命中（评审 H3，独立 oracle 非自证）。
  - driver 各挂载点触发：未导出=直通的**字节等价**；`onExchange` 的 **L1×L2 调用多重性**（评审 M1，挂计数 hook 观测真实调用次数）；`onRequest` 一次性（retry 多轮只调一次，评审 H1）。
- **可观测性（评审 BLOCK-1/H2/MEDIUM-3，承重）**：
  - mock 帧在 history `upstreamResponse.sseEvents` 带 `synthetic:"hook-mock"`、`rewriteUpstreamFrame` 改写帧带 `hook-rewrite`、`replayFromHistory` 帧带 `hook-replay`；真实上游帧**不带**标记。
  - **上游-original track 记 pre-hook 真实帧**：挂一个改写 hook，断言上游轨是原始帧、forwarded 轨才是改写后帧。
  - `GET /api/hooks` 生效态 + 重载回执 `exports` 与**实际触发**的挂载点一致（挂带副作用 hook 观测真被调，非只信自报，对齐 `pass-null 不自证`）。
- **集成**（非 4141 端口起隔离实例，protect-user-main-server）：
  - 挂 `mockUpstreamError.toolFieldRejection()` hook → 实测 reactive retry 腿真被触发（原始动机）。
  - 挂 `replayFromHistory` → 实测离线回放某历史 entry、无 GHC 调用；Anthropic 无损、CC/Gemini 不注入伪造 event 行（评审 H4）。
  - `POST /api/hooks/reload` → 改 hook 文件后 data-URL 重载生效、坏 hook 保留旧 + warn + `lastReloadError` 可查。
  - **与 L2 buffered-retry 交互**（评审 L1）：`onExchange` 与 `responsesBufferedRetry`/`protect_streaming_generation` 并存时的调用次序/次数定向测试。
- **golden 字节等价（评审 MEDIUM-2，机制指定）**：按 `large-refactor` skill 纪律——改动**前**用 master driver 代码对代表性输入预捕获输出作 golden fixture，branch 上同输入重放比对，证「hook 未配置时 driver 输出逐字节等价」（真实回归风险是新增的 `getUpstreamHook()` 读取 + phase 边界回调即便未配置也扰动热路径，非「早返回」那么浅）。

## 10. 活文档归属（收尾必更）

- [docs/DESIGN.md](../DESIGN.md)「活的架构现状」：新增 hook 挂载点行（driver 编排、三挂载点、config-gated）。
- 新 config section：[docs/DESIGN.md](../DESIGN.md) 配置节 + bundled `config.yaml` 注释。
- ADR：是否需要——hook 机制是新架构层，若评审认为够格则补 `docs/decisions/`（记「为何 driver 编排多挂载点而非 transport decorator」）。
- 上游 WS 腿暂缓：`docs/todo/deferred-backlog.md`。

## 11. 评审裁决记录（record-not-adopted / 已核实）

2 轮 subagent 对抗评审（general-purpose 可行性 + general-purpose config/可观测/可测）+ 主会话亲手实测核实。异模型第二意见（gpt-5.5）因 Anthropic `/v1/messages` 拒非-Anthropic vendor 而失败——**恰是本类特性要解决的问题**，已用第二个 Claude 角色补位。

| 发现 | 严重度 | 核实方式 | 裁决 |
|---|---|---|---|
| B1 `?v=` cache-busting 在 Bun 失效 | BLOCK | **亲手 Bun 1.3.14 探针复现**（`?v=` 返回旧模块、data-URL 重载成功且保 `~/` 别名） | **采纳**，§6.3 改 data-URL |
| BLOCK-1 = H2 mock/改写帧毒化 history 上游轨无标记 | BLOCK | 双评审交叉印证 + 读 [driver.ts:440](../../src/lib/pipeline/driver.ts#L440)（push 从不设 synthetic、在 446 前） | **采纳**，新增 §3.4 承重不变量 |
| H1 onRequest 落 retry 循环内 | HIGH | 读 [driver.ts:187-196](../../src/lib/pipeline/driver.ts#L187)（一次性点）+ 291 循环 | **采纳**，移到循环外一次性点 |
| H3 mockUpstreamError 须真 HTTPError+responseText | HIGH | 读 tool-field-rejection-retry.ts:89 + classify.ts:50 | **采纳**，§4.2 契约 + 判别性预设 |
| H4 raw 只存 data、CC/Gemini 回放有损 | HIGH | 读 [driver.ts:440](../../src/lib/pipeline/driver.ts#L440) `raw: frame.data ?? ""` | **采纳**，§5 格式分层保真 |
| HIGH-2 CONFIG_MANAGED_DEFAULTS 与仅-API 重载矛盾 | HIGH | 读 config.ts:488 + route.ts:131 | **采纳**，声明态/生效态脱钩 + GET /api/hooks |
| HIGH-1 = L1 config 触点漏 mergeConfigIntoDocument / 计数 | HIGH/LOW | 读 [route.ts:257-304](../../src/routes/config/route.ts#L257) | **采纳**，§6.1 完整触点清单 |
| M1 onExchange L1×L2 放大 | MEDIUM | 读 [driver.ts:751](../../src/lib/pipeline/driver.ts#L751) 第二调用点 | **采纳**，§3.2 调用多重性 |
| M2 §5 步骤4 过滤 synthetic 是空操作 | MEDIUM | 读 [types.ts:148](../../src/lib/history/types.ts#L148)（synthetic 仅 forwarded 轨） | **采纳**，删该步 + 澄清两轨 |
| M3 新挂载点与既有 onUpstreamFrame 同名 | MEDIUM | 读 [types.ts:243](../../src/lib/pipeline/types.ts#L243) | **采纳**，改名 `rewriteUpstreamFrame` |
| MEDIUM-1 无常驻生效态可查面 | MEDIUM | — | **采纳**，§6.5 `GET /api/hooks` |
| MEDIUM-2 golden oracle 机制未指定 | MEDIUM | — | **采纳**，§9 引 large-refactor 预捕获机制 |
| L2 mock 流绕过 guardSseIterable/rate-limiter | LOW | 读 driver.ts:310 之下 | **采纳**，§4.2 helper 文档提醒 |

**核实为「无问题」（记录以免复议）**：§3.1「6 处 handler 一行不改」成立（唯一 `deps.transport.send` 在 driver.ts:310）；§6.4 `~/` 别名对 exp/ 内 hook + data-URL 模块均实测解析；启动期 `import()` .ts hook Bun 可跑（失效的只是 `?v=` **重载**）；§7 根路径微改动平凡。
