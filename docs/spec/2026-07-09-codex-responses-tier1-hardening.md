# Spec：Codex / Responses 路径抬到 tier-1 健壮性基线

- 状态：草案（待 subagent 对抗审查 + 用户复核）
- 日期：2026-07-09
- 归属：`docs/spec/`；配套 plan 落 `docs/plan/`，ADR（如需）落 `docs/decisions/`
- 相关：[upstream-stream-truncation-detection](./upstream-stream-truncation-detection.md)、[upstream-http2-transport](./upstream-http2-transport.md)、`docs/v4/03-spec/retry-transport.md`、ADR richest-data-flow、skill `debugging-server-crashes` / `bun-upstream-transport` / `claude-code-connection` / `ghc-api-reference`

## 1. 背景与动机（Why）

### 1.1 触发事件（已实证根因）

一条 gpt-5.5 的 **Codex CLI**（`/v1/responses`，openai-responses 格式，走上游 WebSocket）请求，流式 124s 后失败，`attempt.error = "invalid code"`、`state = failed`、0 tokens。

根因经实测定位（非推断）：

- `"invalid code"` 全仓源码无匹配；node_modules 内**唯一**来源是 `undici/lib/web/websocket/util.js` 的 `validateCloseCodeAndReason` —— WHATWG WebSocket API 只允许 `close()` 传 `1000` 或 `3000–4999`，否则同步抛 `DOMException('invalid code', 'InvalidAccessError')`。
- `src/lib/openai/upstream-ws-connection.ts` 定义 `CLOSE_CODE_GOING_AWAY = 1001`，在 **6 处** lifecycle 关闭点调用 `socket.close(1001, ...)`：idle-timeout、parse-error、socket-error、handshake-failed、send-failed、going-away。
- 用本项目 undici 实测：`close(1001)` → `InvalidAccessError: invalid code`；`close(1000)` 正常。
- 旧的 `ws` 包容忍 1001（RFC 6455 层面 1001 是合法**线路**关闭码）；迁移到 undici WebSocket 后，WHATWG API 层的这条禁令让 latent bug 暴露。

### 1.2 放大隐患：进程崩溃向量

上述 6 处 close 调用**未包裹在 crash-safety 内**：

- idle-timeout 的 `socket.close(1001)` 在**裸 `setTimeout` 回调**里（`upstream-ws-connection.ts:100`），抛出的 `DOMException` 无捕获 → 冒泡成 `uncaughtException` → `main.ts` 的 handler `process.exit(1)`（见 skill `debugging-server-crashes`：一条良性 lifecycle 事件放大成整进程崩溃，杀掉所有并发请求）。
- `handleMessage` 的 catch 块（parse-error 分支）自身又调 `close(1001)` —— **catch 内二次抛出**，同样逃逸。

即：这不仅是单请求失败，还是一类**崩溃向量**。

### 1.3 战略动机：Codex / Responses 成为 tier-1

Codex（Responses API）将是本项目的**一等公民**支持对象。上述 bug 暴露出 Responses / 上游-WS 路径的健壮性**未对齐** Anthropic 路径（后者身经百战：下游保活、崩溃防护、反应式重试、截断检测均已成熟）。本 spec 的目标是把整条 Responses 路径抬到与 Anthropic 同级的 tier-1 健壮性基线，而非只修单个关闭码（`root-cause-over-patch` + 消除同族问题）。

`ws:responses` 上游 WebSocket 是一等公民传输，**保留并硬化**，不退役（见 §7 未采纳备选）。

## 2. 目标与非目标

### 2.1 目标（What）

1. **WHATWG-WS 正确性**：上游 WebSocket 的所有 undici API 用法合规，lifecycle 关闭永不使用 WHATWG 禁用码；根因回归可复现转绿。
2. **崩溃防护**：任何上游-WS lifecycle 回调（事件监听器、定时器）内的抛出**不能**升级为 `uncaughtException` / `process.exit`。消除的是一类向量，不是单点。
3. **下游客户端保活**：Responses 流式路径对 Codex 注入保活帧，长 reasoning 静默期不触发 Codex 的 300s idle 超时；与 Anthropic 保活机制对齐、复用同一节流配置。
4. **传输失败反应式重试**：Responses 路径的传输中断 / 上游-WS drop / 网络错误被判定为 retryable，与 Anthropic 的格式无关重试对齐（消除"一次 transport-close 即 settle failed"）。
5. **上游保活 / 截断检测 parity 核验**：核验上游-WS 路径的上游保活与截断检测与 h2 / Anthropic 基线等价，补齐缺口。
6. **测试覆盖**：以上每条配回归测试，含 L1 守卫（本可拦下 close(1001) 的存在性 / 契约测试）。

### 2.2 非目标（Out of scope）

- **不改动 Anthropic 专属的重试策略 / 保活实现**。仅当某能力天然通用、可无害抽取为共享原语时才动它，且这类抽取**记为未来可选项**下沉 `docs/todo/deferred-backlog.md`，不在本 spec 强制。
- **不退役上游-WS**（见 §7）。
- **不抽取统一"健壮流式 transport"抽象**（Anthropic + Responses 合流）—— driver 已是部分共享层，进一步合流属独立大重构，记为未来可选项，不在本 spec。
- 不改动客户端 Codex 侧（`refs/codex` 只读，用于核定其容忍契约）。

## 3. 需求详述（Requirements）

### R1 — WHATWG-WS 关闭码正确性

- **R1.1** 抽取单一关闭原语 `closeUpstreamWs(socket, reason)`，内部使用 `1000`（normal closure，WHATWG 允许），替换全部 6 处 `close(1001, ...)`。
- **R1.2** `closeUpstreamWs` 对 `close()` 自身的任何同步抛出做 try/catch + 记日志（纵深防御：即便未来误用别的 WHATWG 禁用码，也不逃逸）。
- **R1.3** undici-WebSocket 其它 API 用法合规扫描：`send()` 已被 `readyState === OPEN` 守卫（无 bug），核验并以测试固化该前置条件。
- **验收**：以 mock undici WebSocket 触发每一处 lifecycle 关闭，断言（a）不抛 `DOMException`；（b）socket 以 1000 关闭；（c）请求优雅 settle（复现 §1.1 的 "invalid code" 场景转绿）。

### R2 — 上游-WS lifecycle 崩溃防护

- **R2.1** 所有 WS 事件回调（`handleMessage` / `handleError` / `handleClose` / `onOpen` / `onOpenError` / `onAbort`）与 idle `setTimeout` 回调内的抛出被吞并路由到日志 / 请求失败通道，**永不**逃逸为进程级异常。
- **R2.2** 注意现有 crash-safety 原语适配性：`withErrorSink` 面向 node `EventEmitter`，而 undici WebSocket 是 WHATWG `EventTarget`（`addEventListener`）—— 需要面向 EventTarget 的包裹形态（每回调 try/catch 包装器，或新增对称原语），**不能**直接套 `withErrorSink`。计划阶段据此定原语形态。
- **R2.3** 消除同族：审查上游-WS 模块内所有裸 `setTimeout` / `addEventListener` 回调，统一经崩溃防护包裹（`learn-by-analogy`：socket / h2 session 已有对称防护，WS 独缺）。
- **验收**：注入一个会在回调内抛出的 fault，断言进程不退出、错误被记录、在途请求被 fail 而非 crash。

### R3 — Responses 下游客户端保活（Codex）

- **R3.1** Responses 流式路径注入保活帧。帧型经 `refs/codex` 源码核定（见 §4）：`event: <合成标记>` + `data: {"type":"response.<keepalive>"}`（合法 JSON、未知 `type`）。Codex 对其双重容忍（未知 type → `Ok(None)` 忽略；即便解析失败 → `continue`），**零客户端可见副作用**，且重置其 idle 钟。
- **R3.2** 保活帧打项目**合成标记**（合 ADR richest-data-flow：注入真实流的合成物必可辨识），history forwarded 轨记录、上游轨不含。
- **R3.3** 间隔复用 Anthropic 的 `streamKeepalivePingSec`（默认 20s，远 < Codex 300s idle 超时）与 `streamKeepaliveMode` 配置；不新增正交配置除非必要。
- **R3.4** 保活覆盖"上游响应头前静默"与"上游响应中 reasoning 静默"两段（对齐 Anthropic 的两层 idle 断连认知，见 skill `claude-code-connection`）。
- **验收**：模拟上游长静默（> 20s，< 300s），断言下游按间隔收到带标记的保活帧且 Codex SSE 解析器容忍（用 `refs/codex` 的容忍契约作 oracle：合法 JSON + 未知 type 不报错）。

### R4 — Responses 传输失败反应式重试

- **R4.1** Responses 路径已接 `buildOpenAiResponsesStrategiesForEnv` + driver 共享重试（S4 error-driven + L2 buffered）。缺口是**传输中断 / 上游-WS drop / 网络错误未被判定 retryable**（故根因请求 attemptCount=1）。补齐格式无关的传输重试策略（network / transport-close / server-5xx 等价），使 mid-stream WS drop 先重试（至少一次 HTTP fallback）再 settle。
- **R4.2** 仅补格式无关策略；**不搬** Anthropic 专属（thinking / betas / tool-field 等）。若发现某 Anthropic 策略实为通用、可无害共享 → 记 `docs/todo/deferred-backlog.md` 作未来可选，不在本 spec 落地。
- **R4.3** 与既有 matcher 的首命中语义兼容：新增策略前 grep 同错误子串既有 matcher，避免被更宽的先命中遮蔽（见记忆 `new-strategy-shadowed-by-broader-first-match`）。
- **验收**：模拟 mid-stream 上游-WS drop 与网络错误，断言触发重试（attempts > 1）、成功路径最终成功、彻底失败路径 settle failed 且保留 partial。

### R5 — 上游保活 / 截断检测 parity 核验

- **R5.1** 核验上游-WS 路径具备上游保活（WS ping 或等价），与 h2 路径的 TCP keepalive + h2 PING 基线（skill `bun-upstream-transport`）对齐；缺口补齐。
- **R5.2** 核验上游-WS 截断检测（clean drain 而无 `response.completed` 终止符 → 重试 / 失败，不冒充成功）与 driver 既有截断检测（`upstream-stream-truncation-detection.md`）等价。
- **R5.3** 复核 idle-timeout（默认 300s）与保活间隔的关系，确保长 reasoning 不被我方 idle guard 误杀。
- **验收**：以协议终止符缺失的 mock 流断言截断被识别为失败而非成功；以长静默 mock 断言上游保活维持连接。

### R6 — 测试覆盖与守卫

- **R6.1** 每条 R1–R5 配回归测试。
- **R6.2** L1 存在性 / 契约守卫：断言"WS 关闭永不传 WHATWG 禁用码"的守卫测试（本可拦下 close(1001)）。
- **R6.3** 根因黄金回归：端到端复现 §1.1（mock undici WS + idle-close），断言不崩、不 "invalid code"、优雅 settle。

## 4. Codex 容忍契约（核定依据，来自 `refs/codex` 只读）

权威源：`refs/codex/codex-rs/codex-api/src/sse/responses.rs::process_sse_with_treatment` 与 `codex-rs/codex-client/src/sse.rs`、`codex-rs/model-provider-info/src/lib.rs`。

- **idle 超时**：`DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000`（300s），可经 provider `stream_idle_timeout_ms` 覆盖。`timeout(idle_timeout, stream.next())`：**每个被 `eventsource()` emit 的 SSE 事件**重置该钟；超时 → `ApiError::Stream("idle timeout waiting for SSE")` 失败。
- **双重容忍**：
  - `data:` JSON 反序列化失败 → `debug!` + `continue`（跳过，不失败流）。
  - 反序列化成功但 `kind`/`type` 未知 → `process_responses_event` 的 `_ => { ... }` → `Ok(None)`（no-op，流继续）。
  - 两条都发生在 `stream.next()` yield 之后，故**均已重置 idle 钟**。
- **结论**：保活帧只需带非空 `data:` 的合法 JSON（未知 `type` 最稳），即可重置 Codex idle 钟且零副作用；对 GHC/OpenAI 未来 schema 变更免疫。

> 注：Codex 自身有 Codex→上游 的 WS 与 HTTP fallback，但本项目对 Codex 下游一律 SSE-over-HTTP（根因记录 `transport: http`），故下游保活面向 SSE。

## 5. 影响面（受影响组件）

| 组件 | 变更性质 |
|---|---|
| `src/lib/openai/upstream-ws-connection.ts` | R1 关闭原语、R2 崩溃防护 |
| `src/lib/openai/upstream-ws.ts` / `upstream-ws-attempt.ts` | R2 回调防护核验、R5 上游保活核验 |
| `src/lib/transport/crash-safety.ts` | R2.2 可能新增 EventTarget 形态原语 |
| `src/routes/responses/handler-v4.ts` | R3 下游保活注入（当前明写 "Responses has none"） |
| `src/lib/codec/openai-responses/strategies.ts`（及相关） | R4 传输重试策略 |
| Responses SSE sink / 合成帧标记 | R3.2 合成标记 |
| `src/lib/state.ts` / config | R3.3 复用既有 keepalive 配置（尽量不新增） |
| 测试（后端 `*.test.ts`，含 mock undici WS） | R6 |

## 6. 阶段划分（交付顺序，细节留给 plan）

1. **Phase 0 — WHATWG-WS 正确性**（R1）：关闭原语 + 6 处替换 + 合规扫描 + 根因回归。独立可交付，直接止血。
2. **Phase 1 — 崩溃防护**（R2）：回调 / 定时器崩溃防护，消除进程崩溃向量。
3. **Phase 2 — 下游保活**（R3）：Codex 保活帧注入（帧型 / 间隔已被 §4 钉死）。
4. **Phase 3 — 传输重试对齐**（R4）：格式无关传输重试策略。
5. **Phase 4 — 上游保活 / 截断 parity**（R5）：核验补缺。
6. **Phase 5 — 测试收口**（R6）：贯穿各阶段，最后统一守卫 / 黄金回归收口。

每阶段：`typecheck` + `lint:all` + 针对性 `bun test` 绿灯 → 逐语义单元 pathspec 提交（`no-auto-server`，不启服务器）。

## 7. 未采纳备选（record-not-adopted）

- **退役 Responses 上游 WS、改 HTTP-only**：能一劳永逸躲开 WS 复杂度（连接池 / 复用 / 熔断 / 关闭码正确性），但违背 `root-cause-over-patch` + `against-yagni`，且用户已明确 `ws:responses` 为一等公民。close 码是一行修复，不为躲 bug 砍有效优化。**不采纳**。
- **抽取统一健壮流式 transport（Anthropic + Responses 合流）**：DRY 收益最大但触及已稳定的 Anthropic 路径、风险高；driver 已提供部分共享层。**记为未来可选**，不在本 spec。
- **为保活新增正交配置键**：优先复用 `streamKeepalivePingSec` / `streamKeepaliveMode`；仅当 Codex 语义确实要求独立节流时才新增（届时记录理由）。

## 8. 风险与开放问题

- **O1**（R2.2）：EventTarget 崩溃防护原语的确切形态（新原语 vs 每回调包装）留给 plan / architect 定。
- **O2**（R4）：传输重试与 L2 buffered-retry 的交互（mid-stream drop 已 emit 部分帧时的 all-or-nothing 语义）需在 plan 明确，避免向 Codex 重复投递已渲染帧。
- **O3**（R5）：上游-WS 是否已有等价 ping 保活为**核验项**，结论以实测（`ss` 看内核 keepalive / 探针）为准，不凭代码推断（`empirical-verification`）。
- **O4**：保活帧是否需同时兼容非-Codex 的 Responses 客户端（如直连 OpenAI SDK 的 `/v1/responses` 消费者）—— §4 的"合法 JSON + 未知 type"选择对标准 OpenAI Responses SSE 消费者同样最稳，plan 阶段以标准 SDK 复核。

## 9. 验收总览（Definition of Done）

- §1.1 根因请求场景端到端复现并转绿（不崩、不 "invalid code"、优雅 settle 或成功重试）。
- R1–R6 各自验收项通过，测试纳入套件。
- 长静默场景下 Codex 不触发 300s idle 超时。
- mid-stream 上游-WS drop 触发重试而非直接 failed。
- 进程崩溃向量以 fault-injection 测试证明消除。
- 文档同步：`docs/DESIGN.md`「活的架构现状」更新 Responses 路径条目；未采纳 / 推迟项入 `docs/todo/deferred-backlog.md`。
