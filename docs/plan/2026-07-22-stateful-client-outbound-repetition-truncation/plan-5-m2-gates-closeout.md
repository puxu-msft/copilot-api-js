# Plan P5 — M-2 实证门 + 默认升级 + 收尾

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施。步骤用 `- [ ]` 复选框跟踪。
>
> **权威 spec：** [`docs/spec/2026-07-22-stateful-client-outbound-repetition-truncation.md`](../../spec/2026-07-22-stateful-client-outbound-repetition-truncation.md) §6（端点分档 + M-2 门）/ §8.3（WS）/ §8.4（Gemini 排除）/ §10（P5 phase）。总览 [`README.md`](README.md)——「Produces / 冻结契约」+「红线 R5/R6」是本相位的核心约束，冲突以 README 为准。
>
> **前置依赖：** P4（三端近似语义 + 非流式折叠全部落地）。本相位**不新增功能**，只做「实证 + 升级门槛 + 收尾」。

**Goal（spec §6/§10，R5/R6）：** 给 CC / Responses HTTP / Responses WS 三端各自跑一次独立的 M-2 keepalive 实证 harness（真 h2/HTTPS 上游、非 4141 端口、真实客户端当 oracle、造 >300s 缓冲期验证不断连）；**只有过门的端点**才把该端点的重复截断语义从「近似档（forward-live + 命中即停）」升级为「精确档（块内缓冲 + eager-start + keep_copies 份）」（R5：绝不先升级再验证）；收尾——doc-sync（DESIGN.md 活架构行、streaming.md 行为变更表、deferred-backlog §9 关闭 + 新增 Gemini 排除条，R6）、记忆维护、plan 头部实施状态注解。

**Architecture：** 三个独立的 M-2 harness（`exp/repetition-truncation-cc-idle-oracle/`、`exp/repetition-truncation-responses-http-idle-oracle/`、`exp/repetition-truncation-responses-ws-idle-oracle/`），复用 block-level-buffered-retry 特性已验证过的传输拓扑约定（h2/HTTPS mock 上游、Node 起 mock + Bun 起代理、armPing/armSilent 两臂对照）——但这次测的是**本特性**的截断缓冲期保活（Anthropic 精确档已在 P2 验证过；CC/Responses/WS 的精确档尚未验证，处于近似档），而非 block-level-buffered-retry 的缓冲期保活（两者概念相似但门控对象不同，spec §6 明确这是本特性独立的 M-2 门，不能复用 block-level-buffered-retry 已过的门当作本特性也过）。

**Tech Stack：** TypeScript / Bun（代理）+ Node（mock 上游，type-stripping 直跑）+ 真实客户端 oracle（`@anthropic-ai/sdk`/`openai` SDK/codex CLI，按端点选择）。

**Global Constraints（每任务隐含，逐字来自 README）：**
- **R5**：端点默认升级（近似→精确）必须在该端点 M-2 门通过**之后**的 commit——绝不先升级语义再验证 idle。
- **R6**：landing 关 deferred-backlog §9（client.outbound 全 sink-egress 统一化条目，本计划完整实现之）+ 新增 Gemini 排除条 + DESIGN.md 活架构行 + streaming.md 行为表。
- **no-auto-server**：agent 写 harness，**不自跑代理**；用户执行 M-2 oracle 并回填结果。可跑 `bun run typecheck`/`lint:all`/`bun test`。
- **绝不碰 4141 主服务器**：harness 起的代理实例用非 4141 端口，按 PID 精确清理（`ss -ltnp | grep <port>` 定位 → 精确 kill，绝不 `pkill`/`killall`）。
- **细粒度提交**：每任务末显式 pathspec commit（`git commit -F <msgfile> -- <精确路径>`），conventional commits，无模型署名。

---

## 消费的上游契约（P4 提供，P5 不改名）

1. **三端近似档实现**（P4 Task 1-3）：CC/Responses(HTTP+WS) 的 `client.outbound` 近似档分支——P5 升级时会**替换**这些分支为精确档实现（复用 P2 Anthropic 精确档的 eager-start + 块内缓冲范式，不是重新发明）。
2. **`state.repetitionTruncation`**（P0）配置 state，P5 不新增字段。
3. **`resolveCcBufferedAndHeartbeat`/`resolveResponsesBufferedAndHeartbeat`**（既有 block-level-buffered-retry 基础设施，`src/routes/{chat-completions,responses}/buffered-config.ts`）——本特性的精确档缓冲期保活复用同一批 keepalive 帧工厂（`ccKeepaliveFrame`/`responsesKeepaliveFrame`），P5 的 harness 拓扑直接借鉴 `exp/{cc,responses}-keepalive-idle-oracle/` 已验证的机制（mock 传输选型、armPing/armSilent 设计），但断言目标是本特性截断缓冲期的保活，不是复用其历史结论。

---

## 任务列表（TDD，bite-sized）

- [ ] **Task 1** — CC M-2 harness：精确档缓冲期 keepalive 实证（`exp/repetition-truncation-cc-idle-oracle/`）
- [ ] **Task 2** — Responses HTTP M-2 harness：精确档缓冲期 keepalive 实证
- [ ] **Task 3** — Responses WS M-2 harness：精确档缓冲期 keepalive 实证
- [ ] **Task 4** — CC 默认升级（近似→精确，R5 门后）
- [ ] **Task 5** — Responses HTTP 默认升级（近似→精确，R5 门后）
- [ ] **Task 6** — Responses WS 默认升级（近似→精确，R5 门后）+ §8.3 WS 精确档对 Codex 体验评估
- [ ] **Task 7** — doc-sync（DESIGN.md + streaming.md + deferred-backlog R6）
- [ ] **Task 8** — 记忆维护 + plan 归档头部注解 + 收尾提交

---

### Task 1 — CC M-2 harness：精确档缓冲期 keepalive 实证

> **红线 R5：** Task 4（CC 默认升级近似→精确）**必须**在本 oracle armPing 通过**之后**。绝不先升级再验证。no-auto-server：agent 写 harness，用户跑代理执行。

**背景（为何这是独立于 block-level-buffered-retry 的新 M-2 门）：** `exp/cc-keepalive-idle-oracle/` 已验证「CC buffered-retry 缓冲整响应期间，`ccKeepaliveFrame()` 心跳能重置 undici 300s body-idle 墙」——但那验证的是 block-level-buffered-retry 特性的缓冲窗口（`chat_completions.buffered_retry`）。本特性的精确档截断（若 Task 4 升级后启用）引入一个**不同的缓冲窗口**：为了拿到「整段文本」判定是否重复，精确档必须持有当前 block 的全部 delta 直到 block 结束才能一次性折叠+转发（同 P2 Anthropic 精确档的 eager-start 范式）——CC 没有「block」概念（终止-only），故 CC 精确档若要做「块内缓冲」，必须先定义「CC 的 block 是什么」。**这是 Task 4 升级实现本身要回答的设计问题**（见 Task 4），但 Task 1 的 harness 必须先能测「不管 CC 精确档的块边界怎么定义，缓冲期心跳确实撑得住」——故 harness 设计上不预设块边界策略，而是**直接测试「CC 整个响应期间持续输出重复文本、代理精确折叠到 keep_copies 份、心跳撑住整个缓冲期」的最坏情况**（缓冲期上界 = 整个生成期，与 block-level-buffered-retry 的终止-only 缓冲期同构，可安全复用其传输拓扑结论）。

**Files:**
- 新建 `exp/repetition-truncation-cc-idle-oracle/mock-upstream.ts`
- 新建 `exp/repetition-truncation-cc-idle-oracle/run-proxy-arm.sh`
- 新建 `exp/repetition-truncation-cc-idle-oracle/oracle-config.yaml`
- 新建 `exp/repetition-truncation-cc-idle-oracle/REPORT.md`

**Interfaces：** 无生产代码。拓扑：`真实 openai-node 客户端（无自定义 timeout，同 exp/cc-keepalive-idle-oracle 的 oracle-client.mjs 复用） ──/chat/completions（流式）──▶ copilot-api PROXY（repetition_truncation.enabled:true + chat_completions 已升级为精确档，此 harness 跑在 Task 4 升级前的临时分支上以便先测）──ghc_api_base_url（https/h2）──▶ mock-upstream.ts（持续吐重复文本，:8801）`。

> **鸡生蛋说明：** Task 1 的 harness 要测「精确档」的缓冲期保活，但精确档要到 Task 4 才实现。解法：Task 1 的 harness 针对的是 Task 4 实现后的产物——**先写 harness（本 Task），Task 4 实现精确档时临时切到本 harness 验证，验证通过后才允许 Task 4 的 commit 落地默认升级**（即 Task 1 产出的是"待用"的验证工具，Task 4 是"用它"的消费者，二者时间线交织但职责分离：Task 1 只产出 harness 代码，不产出生产代码；Task 4 产出生产代码 + 依赖 Task 1 harness 的验证结果）。这与 block-level-buffered-retry 的 P2/P3/P4 M-2 harness 先行、Task 6/4/3 翻默认在后的模式完全一致。

**Step 1.1 — mock 上游。** 创建 `exp/repetition-truncation-cc-idle-oracle/mock-upstream.ts`（Node，h2/HTTPS，自签证书，仿 `exp/cc-keepalive-idle-oracle/mock-upstream.ts` 传输选型——**必须** h2/HTTPS 而非明文 http，复用已实测确认的 Bun-undici 传输缺陷规避）：

```typescript
/**
 * Mock upstream for the repetition-truncation CC M-2 idle oracle.
 *
 * Emits a PATHOLOGICAL repeating text pattern continuously for SILENCE_SEC seconds (simulating the
 * req_1784742426806_1482 degenerate-repeat failure: "card\n\n（专注。）\n\n" x N), then a clean
 * finish_reason:"stop" terminator. Unlike the sibling block-level-buffered-retry harness (which
 * tests silence-then-tail), THIS harness tests continuous-repeat-then-tail — the exact-tier
 * repetition-truncation hook must buffer the ENTIRE run of repeats to fold them to keep_copies,
 * so the "silence" from the CLIENT's perspective is the whole buffering window, not literal
 * upstream silence (the upstream IS sending bytes continuously — the PROXY is what withholds them
 * from the client while it waits for the block to close).
 *
 * MUST be HTTPS/h2 (node:http2.createSecureServer) — a plaintext http:// mock forces the proxy's
 * undici HTTP/1.1 path, empirically confirmed (exp/responses-keepalive-idle-oracle) to abort the
 * upstream fetch almost immediately under Bun instead of surviving a long streaming window.
 */
import { createSecureServer } from "node:http2"
import { readFileSync } from "node:fs"

const PORT = Number(process.env.MOCK_UPSTREAM_PORT ?? 8801)
const SILENCE_SEC = Number(process.env.MOCK_REPEAT_SEC ?? 330) // > 300s wall — the pathological run's total duration
const MODEL_ID = process.env.MOCK_MODEL_ID ?? "gpt-5.4"
const UNIT = "card\n\n（专注。）\n\n"
const CHUNK_INTERVAL_MS = 1000 // one repeat unit per second — 330 units over the SILENCE_SEC window

const server = createSecureServer({
  key: readFileSync(new URL("./mock-key.pem", import.meta.url)),
  cert: readFileSync(new URL("./mock-cert.pem", import.meta.url)),
  allowHTTP1: true,
})

server.on("request", (req, res) => {
  const url = new URL(req.url ?? "/", `https://localhost:${PORT}`)
  console.log(`[mock] ${req.method} ${url.pathname} at +${(Date.now() - START_MS) / 1000}s`)

  if (url.pathname === "/models") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ data: [{ id: MODEL_ID, object: "model", vendor: "OpenAI", supported_endpoints: ["/chat/completions"] }] }))
    return
  }
  if (url.pathname !== "/chat/completions") {
    res.writeHead(404).end()
    return
  }

  res.writeHead(200, { "content-type": "text/event-stream" })
  const chunkPayload = (content: string, finish: string | null) =>
    `data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL_ID, choices: [{ delta: finish ? {} : { content }, index: 0, finish_reason: finish }] })}\n\n`

  let sent = 0
  const totalUnits = Math.floor((SILENCE_SEC * 1000) / CHUNK_INTERVAL_MS)
  const timer = setInterval(() => {
    if (sent >= totalUnits) {
      clearInterval(timer)
      res.write(chunkPayload("", "stop"))
      res.write("data: [DONE]\n\n")
      res.end()
      console.log(`[mock] STREAM COMPLETE at +${(Date.now() - START_MS) / 1000}s (sent ${sent} units)`)
      return
    }
    res.write(chunkPayload(UNIT, null))
    sent++
  }, CHUNK_INTERVAL_MS)
  req.on("close", () => clearInterval(timer))
})

const START_MS = Date.now()
server.listen(PORT, () => console.log(`[mock] listening on :${PORT} (h2/https), repeat-run ${SILENCE_SEC}s, model=${MODEL_ID}`))
```

（`mock-key.pem`/`mock-cert.pem` 自签证书，仿 `exp/responses-keepalive-idle-oracle/mock-cert.pem` 生成方式：`openssl req -x509 -newkey rsa:2048 -keyout mock-key.pem -out mock-cert.pem -days 365 -nodes -subj "/CN=localhost"`。）

**Step 1.2 — 臂设计。**

| 臂 | 代理配置 | 预期结果 | 证明 |
|---|---|---|---|
| **armPing**（门控） | `repetition_truncation.enabled:true`（CC 已切精确档，Task 4 的临时验证分支）+ `chat_completions.buffered_retry.heartbeat_sec:15`（或 `anthropic.stream_keepalive_ping_sec:15`） | `is_error=false`、`duration_ms > 330000`、客户端收到折叠后的 `keep_copies` 份 + marker | 精确档缓冲期心跳无条件重置 undici 300s 墙；330s 持续重复后干净收尾 |
| **armSilent**（对照） | heartbeat 强制关闭 | `is_error=true`（约 300s 处 `TypeError: terminated`） | 无保活 → 复现 idle-out，反证 armPing 的保活是承重的 |

**Step 1.3 — runner + REPORT 骨架。** `run-proxy-arm.sh` 仿 `exp/cc-keepalive-idle-oracle/run-proxy-arm.sh` 结构（用户手动起 mock → 起隔离代理 → 跑臂脚本）；`REPORT.md` 含拓扑图 + 臂表 + 上线门控判据（`armPing is_error=false && duration_ms>330000 且客户端可见 marker` = M-2 通过 → 允许 Task 4 落地默认升级）+ `Task 4 前置` 提示（结果待用户填）。

**Step 1.4 — commit（harness only，结果待用户填）。**
```bash
git add -- exp/repetition-truncation-cc-idle-oracle/
git commit -F - -- exp/repetition-truncation-cc-idle-oracle/ <<'EOF'
test(exp): CC repetition-truncation exact-tier M-2 idle oracle harness (R5 gate)

Continuous-repeat-then-tail mock upstream (h2/HTTPS) + isolated proxy (repetition_truncation
exact-tier CC branch, Task 4's implementation target) + real openai-node client oracle to verify
the buffering window's forced keepalive resets the consumer's 300s idle deadline while the exact
tier withholds a pathologically-repeating block awaiting its close. armPing (gate) vs armSilent
(control). Results pending user run (no-auto-server); armPing is_error=false &&
duration_ms>330000 && marker visible gates Task 4's default flip.
EOF
```

### Task 2 — Responses HTTP M-2 harness：精确档缓冲期 keepalive 实证

> **红线 R5：** Task 5（Responses HTTP 默认升级近似→精确）**必须**在本 oracle armPing 通过**之后**。

**背景：** 与 Task 1 同构，但 Responses 有中途块边界（`output_item.done`）——精确档在这里的语义更接近 P2 Anthropic 的原生范式（块内缓冲直到 `output_item.done`，而非像 CC 那样缓冲整个响应）。本 harness 测的缓冲窗口 = 「一个 output item 内部持续输出重复文本，代理缓冲整个 item 直到其 `output_item.done`（由折叠逻辑决定何时提前结束该 item 并合成 `output_item.done`）」。

**Files:**
- 新建 `exp/repetition-truncation-responses-http-idle-oracle/mock-upstream.ts`
- 新建 `exp/repetition-truncation-responses-http-idle-oracle/run-proxy-arm.sh`
- 新建 `exp/repetition-truncation-responses-http-idle-oracle/oracle-config.yaml`
- 新建 `exp/repetition-truncation-responses-http-idle-oracle/REPORT.md`

**Interfaces：** 无生产代码。拓扑：`真实 Codex CLI（复用 exp/responses-keepalive-idle-oracle 已验证的 codex exec --json oracle） ──/v1/responses──▶ copilot-api PROXY（repetition_truncation.enabled:true + Responses 已切精确档，Task 5 实现目标）──ghc_api_base_url（https/h2）──▶ mock-upstream.ts（单 item 内持续吐重复文本 330s，:8802）`。

**Step 2.1 — mock 上游。** 仿 Task 1 的 `mock-upstream.ts`，改为 Responses SSE 帧序：`response.created` → 单个 `output_item.added`（`type:"message"`）→ 每秒一个 `output_text.delta`（内容=`UNIT`）持续 330s → `output_item.done`（`content` 携全部 330 份原始文本，验证 upstream-original 轨完整性——**代理侧折叠只影响 forwarded 轨**，mock 侧永远吐真实完整内容，这样才能验证「代理确实主动截断了转发」而非「上游本来就吐得少」）→ `response.completed`。

```typescript
// exp/repetition-truncation-responses-http-idle-oracle/mock-upstream.ts
import { createSecureServer } from "node:http2"
import { readFileSync } from "node:fs"

const PORT = Number(process.env.MOCK_UPSTREAM_PORT ?? 8802)
const REPEAT_SEC = Number(process.env.MOCK_REPEAT_SEC ?? 330)
const MODEL_ID = process.env.MOCK_MODEL_ID ?? "gpt-5.5"
const UNIT = "card\n\n（专注。）\n\n"
const CHUNK_INTERVAL_MS = 1000
const START_MS = Date.now()

const server = createSecureServer({
  key: readFileSync(new URL("./mock-key.pem", import.meta.url)),
  cert: readFileSync(new URL("./mock-cert.pem", import.meta.url)),
  allowHTTP1: true,
})

const sse = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`

server.on("request", (req, res) => {
  const url = new URL(req.url ?? "/", `https://localhost:${PORT}`)
  console.log(`[mock] ${req.method} ${url.pathname} at +${(Date.now() - START_MS) / 1000}s`)

  if (url.pathname === "/models") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ data: [{ id: MODEL_ID, object: "model", vendor: "OpenAI", supported_endpoints: ["/responses"] }] }))
    return
  }
  if (url.pathname !== "/responses") {
    res.writeHead(404).end()
    return
  }

  res.writeHead(200, { "content-type": "text/event-stream" })
  res.write(sse("response.created", { sequence_number: 0, response: { id: "resp_mock", object: "response", status: "in_progress", model: MODEL_ID, output: [] } }))
  res.write(sse("response.output_item.added", { sequence_number: 1, output_index: 0, item: { id: "msg_0", type: "message", role: "assistant", content: [] } }))

  let sent = 0
  const totalUnits = Math.floor((REPEAT_SEC * 1000) / CHUNK_INTERVAL_MS)
  const fullText = UNIT.repeat(totalUnits + 1)
  const timer = setInterval(() => {
    if (sent >= totalUnits) {
      clearInterval(timer)
      res.write(sse("response.output_item.done", { sequence_number: 2 + sent, output_index: 0, item: { id: "msg_0", type: "message", role: "assistant", content: [{ type: "output_text", text: fullText }] } }))
      res.write(sse("response.completed", { sequence_number: 3 + sent, response: { id: "resp_mock", object: "response", status: "completed", model: MODEL_ID, output: [], usage: { input_tokens: 10, output_tokens: totalUnits * 4 } } }))
      res.end()
      console.log(`[mock] STREAM COMPLETE at +${(Date.now() - START_MS) / 1000}s (sent ${sent} units, full upstream-original text carries all ${totalUnits} — richest-data-flow)`)
      return
    }
    res.write(sse("response.output_text.delta", { sequence_number: 2 + sent, output_index: 0, content_index: 0, delta: UNIT }))
    sent++
  }, CHUNK_INTERVAL_MS)
  req.on("close", () => clearInterval(timer))
})

server.listen(PORT, () => console.log(`[mock] listening on :${PORT} (h2/https), repeat-run ${REPEAT_SEC}s, model=${MODEL_ID}`))
```

**Step 2.2 — 臂设计。**

| 臂 | 代理配置 | 预期结果 | 证明 |
|---|---|---|---|
| **armPing**（门控） | `repetition_truncation.enabled:true`（Responses 已切精确档）+ `stream_keepalive_ping_sec:20`（复用 `response.ping` 强制心跳） | `is_error=false`、`duration_ms > 330000`、Codex 收到折叠后的 `keep_copies` 份 + marker，`turn.completed` | `response.ping` 心跳无条件重置 Codex 300s 死线；330s 持续重复的单 item 缓冲期内心跳撑住 |
| **armSilent**（对照） | 心跳强制关闭（`stream_keepalive_ping_sec:0`） | `is_error=true`（`turn.failed`，约 300s 处） | 无保活 → 复现 idle-out |

**Step 2.3 — runner + REPORT 骨架。** 仿 `exp/responses-keepalive-idle-oracle/run-proxy-arm.sh`（复用其 codex exec 驱动 + `--json` 事件解析逻辑，只换 mock 端口/静默模式为"持续重复"而非"纯静默"）。REPORT.md 门控判据：`armPing is_error=false && duration_ms>330000 && turn.completed 携带 marker` = 通过 → 允许 Task 5。

**Step 2.4 — commit（harness only）。**
```bash
git add -- exp/repetition-truncation-responses-http-idle-oracle/
git commit -F - -- exp/repetition-truncation-responses-http-idle-oracle/ <<'EOF'
test(exp): Responses HTTP repetition-truncation exact-tier M-2 idle oracle harness (R5 gate)

Single output_item emitting a continuous pathological repeat for 330s (upstream-original carries
the FULL text — richest-data-flow, only the forwarded track is truncated) + isolated proxy
(exact-tier Responses branch, Task 5's implementation target) + real Codex CLI oracle. Verifies
response.ping resets Codex's 300s idle deadline during the item's exact-tier buffering window.
Results pending user run; armPing pass gates Task 5's default flip.
EOF
```

### Task 3 — Responses WS M-2 harness：精确档缓冲期 keepalive 实证

> **红线 R5：** Task 6（Responses WS 默认升级近似→精确）**必须**在本 oracle armPing 通过**之后**。

**背景（WS 特有考量，spec §8.3）：** WS 传输的 keepalive 机制与 HTTP 不同——`ws.ts` 复用同一个 `responsesKeepaliveFrame()` 作为 app-layer 帧（非 WS protocol ping，理由见 `ws.ts:340-360` 的既有注释：protocol ping 对标准 WS 消费者呈现为非 `message` 事件，Codex 风格消费者靠 app 事件重置死线则收不到效果）。本特性精确档在 WS 上的块内缓冲逻辑与 Task 2 的 Responses HTTP 分支共享同一套折叠核心（P4 Task 3 已验证 client.outbound 挂载点对 WS/HTTP 透明），故本 harness 的核心问题是**验证 WS 传输层本身（而非挂载点）在精确档缓冲期间的连接治理（idle timer / close 时序）不会抢先断开**——这是 WS 特有的连接生命周期机制（`ws.ts` 的 `CLIENT_KEEP_OPEN_IDLE_MS` 等），HTTP SSE 没有这层。

**Files:**
- 新建 `exp/repetition-truncation-responses-ws-idle-oracle/mock-upstream.ts`（复用 Task 2 的 mock，仅端口不同）
- 新建 `exp/repetition-truncation-responses-ws-idle-oracle/run-proxy-arm.sh`
- 新建 `exp/repetition-truncation-responses-ws-idle-oracle/oracle-config.yaml`
- 新建 `exp/repetition-truncation-responses-ws-idle-oracle/REPORT.md`

**Interfaces：** 无生产代码。拓扑：`真实 Codex CLI（走 ws:/responses 客户端连接，非上游 WS——需核实 codex 是否走客户端↔代理的 WS transport，若 codex 默认走 HTTP 则需改用 exp/ws-upstream-keepalive 记录过的 headless WS 客户端脚本，见 Step 3.1 核实）  ──ws:/responses（客户端↔代理 WS）──▶ copilot-api PROXY（repetition_truncation.enabled:true + Responses WS 已切精确档，Task 6 实现目标）──ghc_api_base_url（https/h2，上游仍走 HTTP，非上游 WS——`upstream_ws:false` 隔离变量，同 exp/responses-keepalive-idle-oracle 的既有约定）──▶ mock-upstream.ts（单 item 内持续吐重复文本 330s，:8803）`。

**Step 3.1 — 核实 oracle 选择（读码，非猜测）。** 先确认 Codex CLI 是否会主动使用客户端↔代理的 `ws:/responses` 端点（而非始终走 HTTP `/responses`）：
```bash
grep -n "ws:/responses\|websocket\|WebSocket" ~/.claude/refs/codex-*/  2>/dev/null | head -20 || echo "codex 源码未在本机缓存，需运行时探测"
```
若 codex 默认不主动发起客户端侧 WS 连接（大概率——`ws:/responses` 更多是代理**主动**对上游发起的选择，客户端侧 WS 入口是给愿意用 WS 的客户端库准备的可选传输），则本 harness 的 oracle **不能用 codex exec**（它会走 HTTP，测的是 Task 2 而非 Task 3）。改用一个**headless WS 客户端脚本**（仿 `exp/ws-upstream-keepalive/probe-api.mjs` 的探测手法，但这次是**客户端角色**——连接代理的 `GET /v1/responses` WS 端点、发 `response.create`、计时到收满一份折叠响应），断言"连接期间是否被动断开"用一个明确的 idle 判据：客户端侧发起连接后**不主动发任何后续帧**（模拟一个只等待单次响应的消费者），代理若在 330s 缓冲期内因自身连接治理（如 `CLIENT_KEEP_OPEN_IDLE_MS`，虽然那个是给 keep-open 语义用的 5 分钟 idle，需核实是否在**响应生成期间**也生效还是只在**响应之间**生效）误伤连接，才是本 harness 要抓的缺陷。

**Step 3.2 — mock 上游。** 与 Task 2 完全相同（同一个 `mock-upstream.ts`，只是端口 `:8803`）——上游侧走 HTTP（`upstream_ws:false`，隔离变量，不测代理→上游的 WS，只测客户端→代理的 WS）。

**Step 3.3 — headless WS 客户端 oracle（若 Step 3.1 确认 codex 不适用）。**

```javascript
// exp/repetition-truncation-responses-ws-idle-oracle/ws-oracle-client.mjs
/**
 * Headless WS oracle client for the Responses WS repetition-truncation M-2 gate. Connects to the
 * proxy's client-facing `GET /v1/responses` WS endpoint (NOT the upstream WS — that's a separate,
 * already-excluded variable via upstream_ws:false), sends ONE response.create, and waits passively
 * for either a terminal frame (response.completed/.failed) or a close event — measuring wall-clock
 * duration and whether the connection survived its own exact-tier buffering window (a WS-specific
 * concern distinct from Task 2's HTTP SSE: the client-facing WS connection has its OWN idle/close
 * governance, ws.ts's CLIENT_KEEP_OPEN_IDLE_MS etc, which could in principle race with the
 * repetition-truncation buffering window even if the app-layer response.ping keepalive is correct).
 */
import WebSocket from "ws"

const PROXY_URL = process.env.PROXY_URL ?? "ws://localhost:4144/v1/responses"
const MODEL_ID = process.env.MOCK_MODEL_ID ?? "gpt-5.5"
const CEIL_MS = Number(process.env.CEIL_MS ?? 420_000)

const start = Date.now()
const ws = new WebSocket(PROXY_URL)
let settled = false

const timeout = setTimeout(() => {
  if (settled) return
  settled = true
  console.log(JSON.stringify({ is_error: true, duration_ms: Date.now() - start, reason: "ceil-timeout" }))
  ws.terminate()
  process.exit(1)
}, CEIL_MS)

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "response.create", response: { model: MODEL_ID, input: "trigger the repeating mock", stream: true } }))
})

let sawMarker = false
ws.on("message", (raw) => {
  const event = JSON.parse(raw.toString())
  if (typeof event.delta === "string" && event.delta.includes("duplicated outputs truncated")) sawMarker = true
  if (event.type === "response.completed" || event.type === "response.failed") {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    console.log(JSON.stringify({ is_error: event.type === "response.failed", duration_ms: Date.now() - start, saw_marker: sawMarker, terminal_type: event.type }))
    ws.close()
    process.exit(event.type === "response.failed" ? 1 : 0)
  }
})

ws.on("close", (code) => {
  if (settled) return
  settled = true
  clearTimeout(timeout)
  console.log(JSON.stringify({ is_error: true, duration_ms: Date.now() - start, close_code: code, reason: "closed-before-terminal" }))
  process.exit(1)
})

ws.on("error", (err) => {
  if (settled) return
  settled = true
  clearTimeout(timeout)
  console.log(JSON.stringify({ is_error: true, duration_ms: Date.now() - start, error: String(err) }))
  process.exit(1)
})
```

**Step 3.4 — 臂设计。**

| 臂 | 代理配置 | 预期结果 | 证明 |
|---|---|---|---|
| **armPing**（门控） | `repetition_truncation.enabled:true`（WS 已切精确档）+ `stream_keepalive_ping_sec:20` | `is_error=false`、`duration_ms > 330000`、`saw_marker:true`、`terminal_type:"response.completed"` | app-layer `response.ping` + WS 连接治理均未在精确档缓冲期内误断连接 |
| **armSilent**（对照） | 心跳强制关闭 | `is_error=true`（约 300s 处，`close_code` 或超时判据） | 无保活 → 复现 idle-out |

**Step 3.5 — runner + REPORT 骨架。** `run-proxy-arm.sh` 驱动 `ws-oracle-client.mjs`（`npm i ws` 或用仓库已有依赖——先 `grep '"ws"' package.json` 确认 `ws` 包已是既有依赖，若无则用 Bun/Node 内建 `WebSocket` 全局对象改写脚本、不新增依赖）。REPORT.md 门控判据：`armPing is_error=false && duration_ms>330000 && saw_marker` = 通过 → 允许 Task 6。

**Step 3.6 — commit（harness only）。**
```bash
git add -- exp/repetition-truncation-responses-ws-idle-oracle/
git commit -F - -- exp/repetition-truncation-responses-ws-idle-oracle/ <<'EOF'
test(exp): Responses WS repetition-truncation exact-tier M-2 idle oracle harness (R5 gate)

Client-facing ws:/responses connection oracle (headless WS client, or codex CLI if Step 3.1
confirms it uses the client-side WS transport) against the exact-tier buffering window during a
continuous single-item pathological repeat. Isolates WS-specific connection governance (idle/close
timers) from the shared app-layer response.ping mechanism already verified for HTTP (Task 2).
Results pending user run; armPing pass gates Task 6's default flip.
EOF
```

### Task 4 — CC 默认升级（近似→精确，R5 门后）

> **Step 4.1 是硬性前置门，不可跳过：** 读 `exp/repetition-truncation-cc-idle-oracle/REPORT.md` §4 结果表，确认 armPing 行 `is_error=false && duration_ms>330000 && marker 可见`。**未通过则停**，不实现本 Task 的生产代码，本 Task 降级为「记录未通过 + 保持近似档 + 更新 backlog」。

**Files:**
- 修改截断 hook 文件（P4 Task 1 定位/新建的同一文件，如 `src/lib/pipeline/hooks/builtin/repetition-truncation.ts`）——CC 分支从「近似档」替换为「精确档」
- 修改 `tests/repetition-truncation/cc-approximate.it.test.ts`（P4 Task 1 产出）→ 重命名/改写为 `tests/repetition-truncation/cc-exact.it.test.ts`（语义已变，旧近似档断言不再成立）
- 修改 `docs/todo/deferred-backlog.md`（若 Step 4.1 门未过，记新 backlog 条；若门过，本条不产生 backlog，直接推进）

**Interfaces:**
- **Consumes：** `collapseRepetition`（P0，与 Anthropic 精确档同款调用方式：整块累积文本一次性折叠）、`state.repetitionTruncation`（P0）。
- **CC 精确档的「block」定义（本 Task 的核心设计决策，spec 未预先给出——CC 无天然中途块边界）：** CC 是纯文本流（无 Anthropic 式的 `content_block_start/stop`），要做「块内缓冲」必须自行定义缓冲边界。采用**最简单且与 Anthropic 精确档最一致的定义**：**整个响应体是一个块**——缓冲从流开始到 `finish_reason` 落地（即与 CC 既有 buffered-retry 特性的 terminal-only 边界完全对齐，复用同一「commit 边界=终止」概念，不新造边界机制）。这意味着 CC 精确档的首字节时延 = 整个生成期（与近似档"零延迟实时转发"形成鲜明对比，spec §7 行为变更表需在本 Task 后更新对应行——见 Task 7）。

**CC 精确档实现：**

```ts
interface CcExactState {
  buffer: string // 累积的完整 delta 文本，直到 finish_reason 落地才一次性折叠+emit
  finished: boolean
}

function ccExactCreateState(): CcExactState {
  return { buffer: "", finished: false }
}

function ccExactTransform(frame: ClientFrame, s: CcExactState): FrameAction {
  const parsed = parseCcChunk(frame.data)
  if (!parsed) return { kind: "emit", frames: [frame] } // unparseable — passthrough (never swallow unknown shapes)
  if (parsed.finishReason !== null && parsed.finishReason !== undefined) {
    s.finished = true
    return { kind: "buffer" } // hold the terminal chunk too — flush() emits everything at once, atomically
  }
  if (typeof parsed.content === "string" && parsed.content !== "") s.buffer += parsed.content
  return { kind: "buffer" }
}

function ccExactFlush(s: CcExactState, reason: FlushReason): Array<ClientFrame> {
  if (reason === "client-aborted") return [] // client already left — discard buffered content, per §3.3
  const cfg = { minPatternLength: state.repetitionTruncation.minPatternLength, minRepetitions: state.repetitionTruncation.truncationMinRepetitions, keepCopies: state.repetitionTruncation.keepCopies }
  const result = collapseRepetition(s.buffer, cfg)
  const finalText = result.matched ? result.collapsed + state.repetitionTruncation.markerTemplate.replace("<num>", String(result.truncatedCount)) : s.buffer
  if (result.matched) {
    env.ctx.recordRepetitionTruncation({ blockIndex: 0, truncatedCount: result.truncatedCount, forwardedBeforeDetection: 0, unitLength: result.unitLength })
  }
  // Re-emit as a single content chunk (delta carries the whole finalText) + the terminal chunk (finish_reason
  // restored from whatever was buffered — CC terminal chunks carry no content, so a plain re-synthesis is safe).
  return [ccContentChunk(finalText), ccTerminalChunk()] // helpers mirroring the frame shapes seen in transform
}
```

（`ccContentChunk`/`ccTerminalChunk` 是本文件已有或新增的小 helper，构造 CC chunk 字面量，字段对齐 `parsed` 里读到的 `id`/`model`/`index`；`env.ctx.recordRepetitionTruncation`、`FlushReason` 均是 P0/P1 冻结契约的既有符号。）

**Step 4.1 — 门控确认。** 读 `exp/repetition-truncation-cc-idle-oracle/REPORT.md`，确认 armPing 已回填 `is_error=false && duration_ms>330000 && marker 可见`。**未通过则跳到 Step 4.6**（降级路径）。

**Step 4.2 — 写失败测试（改写 P4 近似档测试为精确档语义）。** 编辑 `tests/repetition-truncation/cc-approximate.it.test.ts` → 重命名 `cc-exact.it.test.ts`，把断言从「~8 份」改为「恰好 `keep_copies`（1）份」：

```ts
test("204x pathological repeat: client sees EXACTLY keep_copies (1) copy + marker (exact tier, post-M-2-gate)", async () => {
  setStateForTests({ repetitionTruncation: { enabled: true, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" } })
  const sse = await (await streamRequest(/* CC repeated-text fixture, 204x */)).text()
  const occurrences = sse.split("card\\n\\n（专注。）\\n\\n").length - 1
  expect(occurrences).toBe(1) // EXACT tier: exactly keep_copies, not ~8 (approximate tier's old behavior)
  expect(sse).toContain("duplicated outputs truncated")
  // marker reports the FULL truncated count now (exact tier semantics, spec §6/§7 — was "post-hit count" under approximate)
  expect(sse).toMatch(/\(203 duplicated outputs truncated\)/)
})

test("first-byte latency: exact tier delays the entire response to generation end (spec §7 updated row)", async () => {
  // unlike the approximate tier (zero extra delay, forward-live), the exact tier buffers the WHOLE
  // response (CC's block = the entire generation, no mid-stream boundary) — first byte arrives only
  // at finish_reason. This is the documented tradeoff of upgrading past the M-2 gate.
})
```

**Step 4.3 — 跑失败。** `bun test tests/repetition-truncation/cc-exact.it.test.ts` → 红（生产代码仍是近似档）。

**Step 4.4 — 最小实现。** 在截断 hook 文件内，把 CC 分支的 `transform`/`flush` 替换为上方设计的 `ccExactTransform`/`ccExactFlush`（删除 P4 Task 1 的 `ccApproximateTransform`/近似档专属状态，保留文件内其他格式分支不动）。

**Step 4.5 — 跑通过 + 回归。** `bun test tests/repetition-truncation/` 全绿（含 P4 Task 5 的双缓冲时序测试——**需重新审视**：CC buffered_retry 本就是「终止才提交」，本特性精确档现在也是「终止才提交」，两者边界完全重合，P4 Task 5 的"截断挂在 buffered-merge 之后"排序验证依然成立，但断言内容需要从"~8 份"更新为"恰好 keep_copies 份"——同步改 `tests/repetition-truncation/cc-buffered-plus-truncation.it.test.ts` 的断言）。`bun run typecheck`。

```bash
for i in $(seq 1 15); do bun test tests/repetition-truncation/cc-exact.it.test.ts || { echo "FLAKY at $i"; break; }; done
```

**Step 4.6 — 降级路径（若 Step 4.1 门未过）。** 不实现精确档，在 `docs/todo/deferred-backlog.md` 新建条：

```markdown
## CC 重复截断精确档升级未过 M-2 门（保持近似档，2026-07-22）

- **根因**：`exp/repetition-truncation-cc-idle-oracle/` 的 armPing 实测未满足 `is_error=false && duration_ms>330000`（具体失败模式见该 harness REPORT.md §4）。
- **当前行为**：CC 端点保持 P4 落地的近似档（forward-live + 命中 `truncation_min_repetitions` 份即停 + marker），零 idle 风险，功能完整但非精确一份。
- **理想架构**：CC 精确档（整响应缓冲到 finish_reason，一次性折叠到 keep_copies 份）——本 Task 已设计好实现（见本文件 Task 4 的 `ccExactTransform`/`ccExactFlush`），仅缺 M-2 实证通过。
- **为何暂缓**：R5 硬约束——绝不先升级语义再验证 idle 安全性。
- **若做需改什么**：① 重新诊断 harness 失败根因（心跳间隔/timeouts 配置/mock 传输选型，参照 harness REPORT.md 排障提示）；② 门过后按本 plan 文件 Task 4 的既有设计直接实现（无需重新设计）。
```

**Step 4.7 — commit（按 Step 4.1 结果二选一）。**

若门过（Step 4.5 路径）：
```bash
git add -- src/lib/pipeline/hooks/builtin/repetition-truncation.ts tests/repetition-truncation/cc-exact.it.test.ts tests/repetition-truncation/cc-buffered-plus-truncation.it.test.ts
git commit -F - -- src/lib/pipeline/hooks/builtin/repetition-truncation.ts tests/repetition-truncation/cc-exact.it.test.ts tests/repetition-truncation/cc-buffered-plus-truncation.it.test.ts <<'EOF'
feat(repetition-truncation): upgrade CC to exact tier (M-2 gate passed, R5)

CC's "block" = the entire response (no mid-stream boundary, aligned with CC's existing
terminal-only buffered_retry commit point) — buffers the whole generation, collapses once at
finish_reason to EXACTLY keep_copies copies + marker reporting the full truncated count. Replaces
the P4 approximate tier (forward-live + stop-on-~truncation_min_repetitions) now that
exp/repetition-truncation-cc-idle-oracle confirmed the buffering window's forced keepalive holds
past 330s. First-byte latency now matches "delay to generation end" (spec §7 table updated, Task 7).
EOF
```

若门未过（Step 4.6 路径）：
```bash
git add -- docs/todo/deferred-backlog.md
git commit -F - -- docs/todo/deferred-backlog.md <<'EOF'
docs(repetition-truncation): CC exact-tier upgrade deferred — M-2 gate not passed (R5)

exp/repetition-truncation-cc-idle-oracle armPing did not satisfy is_error=false &&
duration_ms>330000. CC stays on the P4 approximate tier (zero idle risk, functionally complete).
Backlog records the ready-to-implement exact-tier design (this plan's Task 4) pending gate re-run.
EOF
```

### Task 5 — Responses HTTP 默认升级（近似→精确，R5 门后）

> **Step 5.1 前置门（不可跳过）：** 读 `exp/repetition-truncation-responses-http-idle-oracle/REPORT.md`，确认 armPing `is_error=false && duration_ms>330000 && turn.completed 携带 marker`。未过 → 降级路径（同 Task 4 Step 4.6 模式，见 Step 5.6）。

**Files:**
- 修改截断 hook 文件（Responses HTTP 分支，P4 Task 2 定位/新建）——从近似档换精确档
- 修改 `tests/repetition-truncation/responses-http-approximate.it.test.ts` → 重命名 `responses-http-exact.it.test.ts`
- 修改 `docs/todo/deferred-backlog.md`（若门未过）

**Interfaces：**
- **Consumes：** `collapseRepetition`（P0）、`state.repetitionTruncation`（P0）。
- **Responses 精确档的「block」定义：** 与 CC 不同，Responses **天然有中途块边界**（`output_item.done`）——精确档直接复用这个边界，对齐 P2 Anthropic 的范式（eager-start：`output_item.added` 立即转发保持 wire 上 item open，只缓冲 `output_text.delta`，到 `output_item.done` 才一次性折叠+flush）。这比 CC 精确档（缓冲整个响应）更精细，首字节时延只到"该 item 结束"而非"整个生成结束"（多 item 响应里，前面已完成的 item 不受影响——与 P4 Task 2 近似档的"per-item 独立检测窗口"设计保持一致，只是从"检测窗口"升级为"缓冲窗口"）。

**Responses 精确档实现：**

```ts
interface ResponsesExactState {
  perItem: Map<number, string> // outputIndex → accumulated delta text, buffered until output_item.done
}

function responsesExactCreateState(): ResponsesExactState {
  return { perItem: new Map() }
}

function responsesExactTransform(frame: ClientFrame, s: ResponsesExactState): FrameAction {
  const parsed = parseResponsesFrame(frame)
  if (!parsed) return { kind: "emit", frames: [frame] }
  if (parsed.type === "response.output_item.added") return { kind: "emit", frames: [frame] } // eager-start: forward immediately, keep wire item OPEN
  if (parsed.type === "response.output_text.delta") {
    const idx = parsed.data.output_index as number
    s.perItem.set(idx, (s.perItem.get(idx) ?? "") + (parsed.data.delta as string))
    return { kind: "buffer" } // buffered until output_item.done — the block-aware keepalive (P2 mechanism,
                               // shared across all exact-tier consumers) fills this window with empty deltas
  }
  if (parsed.type === "response.output_item.done") {
    const idx = parsed.data.output_index as number
    const buffered = s.perItem.get(idx) ?? ""
    s.perItem.delete(idx)
    const cfg = { minPatternLength: state.repetitionTruncation.minPatternLength, minRepetitions: state.repetitionTruncation.truncationMinRepetitions, keepCopies: state.repetitionTruncation.keepCopies }
    const result = collapseRepetition(buffered, cfg)
    if (!result.matched) return { kind: "emit", frames: [frame] } // no repetition — the ORIGINAL output_item.done (with its full content) passes through untouched
    env.ctx.recordRepetitionTruncation({ blockIndex: idx, truncatedCount: result.truncatedCount, forwardedBeforeDetection: 0, unitLength: result.unitLength })
    const marker = state.repetitionTruncation.markerTemplate.replace("<num>", String(result.truncatedCount))
    const collapsedFrame = responsesItemDoneWithCollapsedText(frame, result.collapsed + marker) // helper: replaces item.content[].text with the collapsed+marker text, keeps id/output_index/role
    return { kind: "emit", frames: [collapsedFrame] }
  }
  return { kind: "emit", frames: [frame] } // other frame types (created/completed/error/etc) pass through untouched
}

function responsesExactFlush(_s: ResponsesExactState, _reason: FlushReason): Array<ClientFrame> {
  return [] // no cross-item leftover to flush at stream end — each item settles at its own output_item.done
}
```

**Step 5.1 — 门控确认。** 读 harness REPORT.md，确认门过。未过 → 跳 Step 5.5。

**Step 5.2 — 写失败测试。** 编辑/重命名 `tests/repetition-truncation/responses-http-approximate.it.test.ts` → `responses-http-exact.it.test.ts`，断言从「~8 份」改为「恰好 keep_copies」，且保留 P4 已验证的「suppression 按 item 独立重置」测试（精确档下这条依然成立，只是从「抑制」变成「缓冲」语义）：

```ts
test("204x pathological repeat within ONE item: client sees EXACTLY keep_copies (1) copy + marker (exact tier)", async () => {
  setStateForTests({ repetitionTruncation: { enabled: true, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" } })
  const sse = await (await streamRequest(/* single-item 204x-repeat Responses fixture */)).text()
  const occurrences = sse.split("card\\n\\n（专注。）\\n\\n").length - 1
  expect(occurrences).toBe(1)
  expect(sse).toContain("duplicated outputs truncated")
  expect(sse).toMatch(/\(203 duplicated outputs truncated\)/) // exact tier: full truncated count
})

test("multi-item response: a truncated item0 does not delay item1's own timely output_item.done (eager-start per-item boundary)", async () => {
  // item0: 204x repeat (buffered+collapsed) → output_item.done fires once item0's OWN block closes.
  // item1: clean prose, forwarded live/normally, its output_item.done is NOT held up by item0's buffering.
  const sse = await (await streamRequest(/* two-item fixture: item0 repeats, item1 clean */)).text()
  expect(sse).toContain("duplicated outputs truncated") // item0 collapsed
  expect(sse).toContain("NORMAL_ITEM1_TEXT") // item1 untouched
})
```

**Step 5.3 — 跑失败 → 最小实现。** 替换截断 hook 文件内 Responses 分支为 `responsesExactTransform`/`responsesExactCreateState`/`responsesExactFlush`（删除 P4 Task 2 的 `responsesApproximateTransform`/`suppressingItems` 状态）。`bun test tests/repetition-truncation/responses-http-exact.it.test.ts` → 绿。`bun run typecheck`。

**Step 5.4 — 回归（P4 Task 3 WS 覆盖 + Task 5 双缓冲无关但需确认 P4 Responses 全套件不受影响）。**
```bash
bun test tests/repetition-truncation/ tests/responses/ 2>&1 | tail -60
for i in $(seq 1 15); do bun test tests/repetition-truncation/responses-http-exact.it.test.ts || { echo "FLAKY at $i"; break; }; done
```

**Step 5.5 — 降级路径（若 Step 5.1 门未过）。** 同 Task 4 Step 4.6 模式，新建 backlog 条目（结构对齐，改指 Responses HTTP harness + 本 Task 的 `responsesExactTransform` 设计）。

**Step 5.6 — commit（按结果二选一）。**

若门过：
```bash
git add -- src/lib/pipeline/hooks/builtin/repetition-truncation.ts tests/repetition-truncation/responses-http-exact.it.test.ts
git commit -F - -- src/lib/pipeline/hooks/builtin/repetition-truncation.ts tests/repetition-truncation/responses-http-exact.it.test.ts <<'EOF'
feat(repetition-truncation): upgrade Responses HTTP to exact tier (M-2 gate passed, R5)

Reuses Responses' native output_item.done block boundary (eager-start: output_item.added
forwarded immediately, deltas buffered per output_index, collapsed to EXACTLY keep_copies at
output_item.done) — aligned with the Anthropic P2 exact-tier pattern. Per-item buffering scope
means a truncated item never delays a sibling item's own timely completion. Replaces the P4
approximate tier now that exp/repetition-truncation-responses-http-idle-oracle confirmed
response.ping holds the item's buffering window past 330s.
EOF
```

若门未过：
```bash
git add -- docs/todo/deferred-backlog.md
git commit -F - -- docs/todo/deferred-backlog.md <<'EOF'
docs(repetition-truncation): Responses HTTP exact-tier upgrade deferred — M-2 gate not passed (R5)

exp/repetition-truncation-responses-http-idle-oracle armPing did not satisfy the pass criteria.
Responses HTTP stays on the P4 approximate tier. Backlog records the ready-to-implement exact-tier
design (this plan's Task 5) pending gate re-run.
EOF
```

### Task 6 — Responses WS 默认升级（近似→精确，R5 门后）+ §8.3 WS 精确档对 Codex 体验评估

> **Step 6.1 前置门（不可跳过）：** 读 `exp/repetition-truncation-responses-ws-idle-oracle/REPORT.md`，确认 armPing 通过。未过 → 降级路径（Step 6.5）。

**Files:**
- 核实截断 hook 文件的 Responses 分支是否已因 Task 5 的实现天然覆盖 WS（P4 Task 3 已证明 client.outbound 挂载点对 WS/HTTP 透明——若该判断依然成立，本 Task **无需新生产代码**，只需 WS 专属的回归测试 + spec §8.3 的评估记录）
- 新建 `tests/repetition-truncation/responses-ws-exact.it.test.ts`
- 修改 `docs/todo/deferred-backlog.md`（若门未过，或若 §8.3 评估认为精确档对 Codex WS 体验有负面影响需要记录）

**Interfaces：** 复用 Task 5 的 `responsesExactTransform`（同一实现，同一挂载点，spec §5.3 表格里 WS 与 HTTP 共用同一套边界定义——`response.output_item.done`；spec §8.3 唯一提到的 WS 特殊点是 `ws.ts:376` 的 buffered-retry `commitBoundaries` 故意省略，那是另一特性（block-level-buffered-retry）的机制，与本特性的 client.outbound 挂载点正交，P4 Task 3 已核实两者不共享判定逻辑）。

**Step 6.1 — 门控确认。** 读 harness REPORT.md。未过 → 跳 Step 6.4。

**Step 6.2 — 核实自动覆盖 + 写回归测试。** 参照 P4 Task 3 的核实模式：

```bash
grep -n "output_item.done\|commitBoundaries" src/routes/responses/ws.ts
```

确认精确档的 `output_item.done` 缓冲/折叠逻辑（挂在 P3 下沉后的 `delivery/session.ts`）与 WS 的 buffered-retry `commitBoundaries` 省略（挂在 driver 的 `runResponseBufferedSink`）确实是两条独立的判定路径——若确认，新建 `tests/repetition-truncation/responses-ws-exact.it.test.ts`：

```ts
/**
 * Responses WS exact-tier repetition truncation — verifies the Task 5 exact-tier implementation
 * (shared client.outbound mount point, transport-agnostic post-P3) transparently covers ws:/responses
 * with IDENTICAL per-item eager-start buffering semantics as HTTP. Pure regression, no new
 * production logic expected (per Step 6.2's verification).
 */
test("WS: 204x repeat within one item collapses to EXACTLY keep_copies (1) + marker, same as HTTP exact tier", async () => {
  setStateForTests({ repetitionTruncation: { enabled: true, minPatternLength: 10, truncationMinRepetitions: 8, keepCopies: 1, markerTemplate: "(<num> duplicated outputs truncated)" } })
  const frames = await collectWsFrames(/* single-item 204x-repeat WS fixture */)
  const textDeltas = frames.filter((f) => f.type === "response.output_item.done")
  expect(textDeltas).toHaveLength(1)
  const finalText = (textDeltas[0].item.content[0] as { text: string }).text
  expect((finalText.match(/card\n\n（专注。）\n\n/g) ?? []).length).toBe(1)
  expect(finalText).toContain("duplicated outputs truncated")
})
```

**Step 6.3 — §8.3 WS 精确档对 Codex 体验评估（spec §8.3 明确要求，非可选）。** spec §8.3 原文：「过 WS M-2 门后评估精确档对 Codex WS 体验的影响」——这是一个**主动评估**任务，不是自动通过。核心问题：精确档在 WS 上的「块内缓冲」意味着 Codex 收到某个 output item 的内容会被延迟到该 item 关闭（与 HTTP 精确档同样的时延权衡），**但 WS 场景下 Codex 是否对"逐字符实时流式显示"有比 HTTP SDK 更强的交互性预期**（例如终端 UI 的打字机效果）？读 Codex 客户端源码或既有记忆核实：

```bash
grep -rn "output_text.delta\|streaming.*display\|typewriter" ~/.claude/refs/codex-*/ 2>/dev/null | head -20 || echo "codex 源码本机未缓存，凭 exp/responses-keepalive-idle-oracle 已有的 codex exec 行为观察判定"
```

若 Codex CLI 本身是**批处理式**消费（`codex exec --json` 拿到完整 `turn.completed` 才处理，不逐字符渲染——这是 `exp/responses-keepalive-idle-oracle` 已实测的运行模式），则精确档的块内缓冲对 Codex **无感知影响**（评估结论：安全）。若 Codex 存在交互式 TUI 模式对逐字符流式有强依赖，需要在 REPORT/backlog 记录这个权衡，交给用户判断是否仍要默认精确档（或该场景需要例外配置）。**读码判定，不猜测**——将结论写入 `exp/repetition-truncation-responses-ws-idle-oracle/REPORT.md` 新增一节「§8.3 评估结论」。

**Step 6.4 — 跑通过 + 提交。**
```bash
bun test tests/repetition-truncation/responses-ws-exact.it.test.ts
for i in $(seq 1 15); do bun test tests/repetition-truncation/responses-ws-exact.it.test.ts || { echo "FLAKY at $i"; break; }; done
bun run typecheck
```

**Step 6.5 — 降级路径（若 Step 6.1 门未过）。** 同 Task 4/5 模式，新建 backlog 条（指向本 harness + Task 6 的复用设计）。

**Step 6.6 — commit（按结果二选一）。**

若门过：
```bash
git add -- tests/repetition-truncation/responses-ws-exact.it.test.ts exp/repetition-truncation-responses-ws-idle-oracle/REPORT.md
git commit -F - -- tests/repetition-truncation/responses-ws-exact.it.test.ts exp/repetition-truncation-responses-ws-idle-oracle/REPORT.md <<'EOF'
feat(repetition-truncation): confirm Responses WS exact tier via shared mount point (M-2 gate passed, R5)

client.outbound is transport-agnostic post-P3 — Task 5's exact-tier implementation transparently
covers ws:/responses with no additional production code. Regression test locks identical per-item
eager-start buffering semantics as HTTP. Spec §8.3 evaluation (REPORT.md new section): Codex CLI's
--json batch-consumption mode is unaffected by per-item buffering (no interactive typewriter
dependency observed) — exact tier is safe to default for WS.
EOF
```

若门未过：
```bash
git add -- docs/todo/deferred-backlog.md
git commit -F - -- docs/todo/deferred-backlog.md <<'EOF'
docs(repetition-truncation): Responses WS exact-tier upgrade deferred — M-2 gate not passed (R5)

exp/repetition-truncation-responses-ws-idle-oracle armPing did not satisfy the pass criteria.
Responses WS stays on the P4 approximate tier. Backlog records the ready-to-implement exact-tier
path (reuses Task 5's HTTP implementation via the shared client.outbound mount point) pending gate
re-run.
EOF
```

### Task 7 — doc-sync（DESIGN.md + streaming.md + deferred-backlog，R6）

**Files:**
- `docs/DESIGN.md`（新增「活的架构现状」表行——重复截断特性；「client.outbound」既有行的覆盖缺口叙述需更新——P3/P4/P5 完整实现了 sink-egress 统一化，deferred-backlog §9 条目关闭）
- `docs/streaming.md`（「截断检测」节旁新增重复截断行为表；若 §5.6 双缓冲小节存在则同步）
- `docs/todo/deferred-backlog.md`（关闭 `client.outbound 全量 sink-egress 统一化` 条目 [:825行]；新增 Gemini 排除条；若 Task 4/5/6 有任何门未过，对应降级 backlog 条已在各自 Task 内建立，本 Task 只做交叉核验不重复）

**Interfaces：** 无生产代码——doc 与 code 对账（review-merged-state）。

**Step 7.1 — DESIGN.md 新增特性行。** 在「活的架构现状」表新增一行（紧邻 block-level-buffered-retry 行，两者概念相关）：

```markdown
| 重复输出截断（stateful client.outbound + repetition truncation） | `[done]`（或 `[wip]` 若 Task 4/5/6 任一门未过——按实际结果填） | 退化重复输出（GHC 204x 死循环文本重复实证 `req_1784742426806_1482`）折叠到 `keep_copies` 份（默认 1）+ 可辨识 marker。机制：`client.outbound` leaf 从单帧升级为有状态 `createState/transform/flush`（同构 `ResponseRewrite`），挂载点下沉到 `delivery/session.ts` 串行写 choke point（覆盖渲染帧 + sink 合成/心跳/anchor 帧，`client.outbound` 全量 sink-egress 统一化—— **backlog:825 条目已关闭**，见下）。特性纯核 `text-repetition/collapse.ts`（KMP 思路 whole-text 累积，非复用告警用 `repetition-detector.ts` 的有损滑窗——两套阈值解耦：告警 `minRepetitions:3`、截断 `truncation_min_repetitions:8`）。**端点分档**（M-2 实证门驱动升级）：Anthropic 默认精确一份+eager-start（块内缓冲直到 `content_block_stop`）；CC/Responses(HTTP+WS) 首版近似档（forward-live + 命中 `truncation_min_repetitions` 份即停），各自过独立 M-2 keepalive 实证门（`exp/repetition-truncation-{cc,responses-http,responses-ws}-idle-oracle/`）后升级为精确档（CC 的"block"=整响应对齐其既有 terminal-only buffered_retry 边界；Responses 复用天然 `output_item.done` 边界，per-item 缓冲）。非流式（`transformWhole`）三端独立第二挂载点，共享同一纯核，恒精确语义。`truncatedCount`/`forwardedBeforeDetection` per-endpoint 语义不可比（精确档=全部/0，近似档=命中后/`truncation_min_repetitions`）。marker 帧走 `DeliverySyntheticKind:"repetition-truncated"`（`writeToSink`/`syntheticKind()` 全站点）。**不含 Gemini**（`flushResponse` 循环外合成结构不兼容，与 block-level-buffered-retry §7.4 同根因，见 backlog）。默认 `repetition_truncation.enabled:false`（opt-in，关闭时全端点逐字节等价） | `src/lib/text-repetition/{collapse,approximate-collapse}.ts`、`src/lib/pipeline/hooks/builtin/repetition-truncation.ts`、`src/lib/pipeline/delivery/{session,types}.ts`、`src/lib/codec/{anthropic/response-rewrite-adapters,openai-cc/response-rewrites,openai-responses/response-rewrites}.ts`、[spec/2026-07-22-stateful-client-outbound-repetition-truncation.md](spec/2026-07-22-stateful-client-outbound-repetition-truncation.md)、[decisions/2026-07-22-stateful-client-outbound.md](decisions/2026-07-22-stateful-client-outbound.md)、[plan/2026-07-22-stateful-client-outbound-repetition-truncation/](plan/2026-07-22-stateful-client-outbound-repetition-truncation/) |
```

**核对既有「上游 hook 中间件」行的 `client.outbound` 覆盖缺口叙述**（`docs/DESIGN.md:88`）：该行现有文字「`client.outbound` 覆盖缺口：只覆盖 `codec.renderResponse` 渲染帧，sink 层合成/心跳/anchor 帧不经 render→yield 点……full sink-egress 统一化记 deferred-backlog」——**本特性（P1-P3）已经消解这个缺口**（挂载点下沉到 `delivery/session.ts`），需要把这句改写为「已下沉到 `delivery/session.ts` 串行写 choke point，覆盖全量 client 字节（P1-P3，2026-07-22 stateful client.outbound + repetition truncation 特性实现）」并删除「记 deferred-backlog」的过时指向（backlog 条目已关闭，见 Step 7.3）。

**Step 7.2 — streaming.md 新增行为表。** 在「截断检测」小节旁（或新增「重复截断」小节）加：

```markdown
`repetition_truncation`（`src/lib/text-repetition/`）折叠退化重复输出，`enabled:false`（默认）时全端点逐字节等价。开启后各端点差异表：

| 端点 | 首字节时延 | 客户端看到的重复 | marker `<num>` 语义 |
|---|---|---|---|
| Anthropic `/v1/messages` | 延到该 text 块 `content_block_stop`（其他块/心跳不延） | 恰好 `keep_copies`（默认 1）份 | 被截全部份数 |
| Chat Completions | 若已过 M-2 门升级精确档：延到整个生成结束（终止-only 边界）；否则近似档：无额外延迟 | 精确档：恰好 `keep_copies`；近似档：~`truncation_min_repetitions`（默认 8）份 | 精确档：全部；近似档：命中后份数 |
| Responses HTTP/WS | 若已过 M-2 门升级精确档：延到该 output item 的 `output_item.done`（per-item，其他 item 不受影响）；否则近似档：无额外延迟 | 同上 CC 行的精确/近似两档 | 同上 |
| Gemini | 不在范围（结构不兼容，见 backlog） | — | — |

详见 [spec/2026-07-22-stateful-client-outbound-repetition-truncation.md](spec/2026-07-22-stateful-client-outbound-repetition-truncation.md) §6/§7、运行时选项 `repetition_truncation.*`。
```

（若 Task 4/5/6 某端点门未过，本行按实际状态填「近似档」而非「若已过门」的条件句——**Task 7 实施时以 Task 4/5/6 的真实落地结果为准填写这张表，不要保留条件句式，那是本 plan 撰写时的占位表述**。）

**Step 7.3 — deferred-backlog 关闭 + 新增 Gemini 排除条。** 关闭 `docs/todo/deferred-backlog.md` 现有 `## client.outbound 全量 sink-egress 统一化`（约 `:825` 行）条目——在该条目前加 `✅ 已解决` 前缀（对齐既有 backlog 惯例，如 `:560` 行的写法），保留原文字作历史记录，追加一句：

```markdown
> ✅ **已解决（2026-07-22，`docs/plan/2026-07-22-stateful-client-outbound-repetition-truncation/`）**：挂载点已下沉到 `delivery/session.ts` 串行写 choke point（P3 §9b），覆盖全量 client 字节（渲染帧 + sink 合成/心跳/anchor 帧）+ 统一 forwarded-轨 provenance 标记（`DeliverySyntheticKind`）。重复截断是首个消费该统一挂载点的 first-party 特性。
```

新增 Gemini 排除条（对齐 spec §8.4，仿 block-level-buffered-retry 的 Gemini 排除条写法）：

```markdown
## 重复输出截断不含 Gemini（结构不兼容，2026-07-22）

- **根因**：Gemini 的 CC→Gemini 整流翻译器（`createGeminiStreamTranslator`）把 `flushResponse` 产出的终态帧（含 `finishReason`/`usage`）放在 driver 循环**外**合成——与本特性挂载点（`client.outbound`，挂在循环内的 sink-egress 层）看不到彼此。这与 block-level-buffered-retry §7.4 排除 Gemini 的**同一结构性根因**（`flushResponse` post-loop 不可见）。
- **当前行为**：Gemini `/v1beta/.../generateContent` 端点不受重复截断影响——退化重复输出（若发生）会原样转发给 Gemini 客户端，与本特性落地前行为一致。
- **理想架构**：需要把 `flushResponse` 的终态产出重构进 driver 循环内（与 block-level-buffered-retry backlog 里 Responses via-fallback 排除条、Gemini 排除条同一理想架构，三处可合并解决）。
- **为何暂缓**：spec §8.4 用户已裁决排除（2026-07-22 AskUserQuestion）；改造 `flushResponse` 是独立、跨特性的结构性工作单元，超出本特性范围。
- **若做需改什么**：① 把 Gemini stream translator 的终态帧产出移进 driver 循环内（或让 driver 感知 handler post-loop flush 作为 client.outbound 的最终挂载点）；② 与 block-level-buffered-retry backlog 的 Responses via-fallback 排除条、Gemini §7.4 排除条合并统一重构；③ Gemini 侧补重复截断集成测试。发现方：spec §8.4（2026-07-22），P5 Task 7 doc-sync 时正式登记。
```

**Step 7.4 — 跨文档 grep 验证（review-merged-state）。**
```bash
grep -rn "repetition_truncation\|repetition-truncation\|client.outbound.*覆盖缺口\|sink-egress 统一化" docs/DESIGN.md docs/streaming.md docs/todo/deferred-backlog.md
```
确认无「client.outbound 只覆盖渲染帧」的过时叙述残留（应已被 Step 7.1 的改写覆盖）；确认 DESIGN.md 新增行与 streaming.md 新增表的端点分档描述互相一致（不出现一处说"CC 已升级精确档"另一处仍说"近似档"的矛盾——以 Task 4/5/6 的实际落地结果为唯一事实源）。

**Step 7.5 — commit.**
```bash
git add -- docs/DESIGN.md docs/streaming.md docs/todo/deferred-backlog.md
git commit -F - -- docs/DESIGN.md docs/streaming.md docs/todo/deferred-backlog.md <<'EOF'
docs(repetition-truncation): sync DESIGN + streaming + backlog for the full feature landing (R6)

DESIGN.md: new "活的架构现状" row for stateful client.outbound + repetition truncation; updated
the pre-existing client.outbound coverage-gap note (now resolved via P3's sink-egress descent).
streaming.md: per-endpoint behavior table (first-byte latency / repeats seen / marker semantics),
reflecting Task 4/5/6's actual exact-vs-approximate landing state per endpoint. Backlog: closed
the client.outbound sink-egress unification entry (825) + new Gemini exclusion entry (spec §8.4,
same flushResponse-post-loop root cause as block-level-buffered-retry §7.4). Cross-doc grep
verified no stale "renderResponse-only coverage" narrative remains.
EOF
```

### Task 8 — 记忆维护 + 归档头部注解 + 收尾提交

**Files:**
- `docs/memory/MEMORY.md`（新增一行 project stub，指向本特性——按现有 project stub 格式）
- `docs/plan/2026-07-22-stateful-client-outbound-repetition-truncation/README.md`（顶部追加实施状态注解，仿既有 plan 归档惯例）
- `docs/plan/2026-07-22-stateful-client-outbound-repetition-truncation/plan-{0,1,2,3,4,5}-*.md`（若存在，各自顶部同步简短状态行——本相位文档只确认 P4/P5 头部，P0-P3 头部由各自实施者收尾时维护，此处仅核验不重复劳动）

**Interfaces：** 无生产代码——纯知识沉淀（skill `session-closeout`）。

**Step 8.1 — 核对是否有值得沉淀的教训。** 回顾 P4/P5 实施期间的非平凡发现（按 `distill-lessons-at-boundaries`），候选（**实施者按实际执行中遇到的真实情况筛选，非本 plan 写作阶段虚构**）：
- 若 Task 1-3 的 harness 实测过程中发现 mock 传输选型/timeouts 配置有新的坑（不同于 block-level-buffered-retry 已记录的坑），沉淀为新 memory 或追加到既有 `reference-spawn-fails-silently-hits-peer-server-verify-port-ownership.md` 类似的参考记忆。
- 若 CC/Responses 精确档的"block 定义"决策（Task 4/5 的设计段落）引出用户对语义的调整意见，作为 `feedback-*` 记忆记录（用户偏好）。
- 若 Task 6 的 §8.3 评估发现 Codex 确有交互式流式依赖（与本 plan 撰写时的预判"批处理式，无影响"相反），这是**重大的实测纠正**，必须沉淀为 `methodology-*` 记忆（对齐记忆库「先假设后核实、发现纠正必须记录」的一贯纪律）。

**Step 8.2 — MEMORY.md 新增 project stub（若判定值得记录）。** 仿现有格式（如 `project-block-level-buffered-retry-execution.md` 一行 stub），新增：

```markdown
- [有状态 client.outbound + 重复截断（P0-P5 全 landed 或部分 gated，见各 harness REPORT）](project-stateful-client-outbound-repetition-truncation.md) — 三层机制(§9a有状态化/§9b sink-egress下沉/特性纯核)+端点分档(Anthropic精确/CC-Responses近似→M-2门后升级)；权威 spec+plan+DESIGN 活架构行
```

（若本特性所有 M-2 门均未过、长期停留在近似档，仍应记 stub——「已交付但未全量升级」是合法的项目现状，非隐藏信息。）

**Step 8.3 — 归档 plan 头部实施状态注解。** 在 `README.md` 顶部（`# 有状态 client.outbound + 重复截断` 标题下）插入一段（仿 `docs/plan/2026-07-14-request-timing-instrumentation.md:3` 等既有惯例）：

```markdown
> **实施状态（<实际完成日期>）：** P0-P5 全部 task 完成。Anthropic 精确档（P2）+ 三端非流式折叠（P4）+ CC/Responses(HTTP+WS) 首版近似档（P4）落地；<按 Task 4/5/6 实际结果填：例如「CC/Responses HTTP/Responses WS 三端 M-2 门全通过、均已升级精确档」或「CC 门未过保持近似档（见 backlog）、Responses HTTP/WS 门过已升级精确档」>。doc-sync 完成（DESIGN.md 活架构行 + streaming.md 行为表 + backlog §9 关闭 + 新增 Gemini 排除条）。
```

**注：本步骤的具体填写内容取决于 Task 4/5/6 的真实执行结果（用户运行 M-2 harness 后的实际裁决）——本 plan 撰写阶段无法预知，实施者在 Task 8 执行时据实填写，不得虚构「已通过」的结果。**

**Step 8.4 — 核对 P0-P3 plan 头部（若本次实施顺带发现遗漏）。** 若在推进 P4/P5 过程中发现 P0/P1/P2/P3 的 plan 文件（`plan-0-foundation.md` 等，若已存在）缺少完成后的头部状态注解，一并补上（`sync-plan-with-impl` 纪律——保持 plan 与实施同步，不留"文档说未完成、代码已完成"的漂移）；若这些文件尚不存在（本次 P4/P5 撰写时 README/kickoff 之外只有此二相位文件），跳过本步骤，留给 P0-P3 各自实施时处理。

**Step 8.5 — 全套件最终回归。**
```bash
bun run test:backend
bun run typecheck
bun run lint:all
```

**Step 8.6 — commit.**
```bash
git add -- docs/memory/MEMORY.md docs/memory/project-stateful-client-outbound-repetition-truncation.md docs/plan/2026-07-22-stateful-client-outbound-repetition-truncation/README.md
git commit -F - -- docs/memory/MEMORY.md docs/memory/project-stateful-client-outbound-repetition-truncation.md docs/plan/2026-07-22-stateful-client-outbound-repetition-truncation/README.md <<'EOF'
docs(repetition-truncation): closeout — memory stub + plan archival status header

Session-closeout per skill session-closeout: memory index entry pointing to this feature's
landing state (exact-vs-approximate per endpoint, per the actual M-2 gate outcomes); README.md
header annotated with the final implementation status (P0-P5 complete, per-endpoint tier state
filled from Task 4/5/6's real gate results, not assumed).
EOF
```

> **subagent 审查提醒（不是本 plan 的一个 Task，是执行纪律）：** 按项目 CLAUDE.md「session-closeout」流程，本 Task 8 提交前应已完成 subagent audit（P4/P5 全部代码 + doc 变更的合并态审查）——若尚未做，在 Task 8 之前插入一轮独立 review（`reviewer`/`gpt-souls:reviewer`，判据轴：长远正确+完整），本 plan 不再单列该步骤（属通用收尾纪律，非本特性专属，见 README 已引用的 `subagent-review-before-finalize`）。

---

## 末尾自审（提交 P5 给用户前）

### spec 覆盖核对（spec §6/§8.3/§8.4/§10，缺任一即砍范围，不接受）
- [ ] CC/Responses HTTP/Responses WS 三端各自独立 M-2 keepalive harness（非复用同一份/非跳过任一端）：Task 1/2/3。
- [ ] 每端点升级前置门检查（Step X.1）+ **R5 硬约束**（绝不先升级再验证）：Task 4/5/6 全部内建门控确认步骤 + 降级路径。
- [ ] §8.3 WS 精确档对 Codex 体验评估（非自动跳过，主动核实批处理 vs 交互式流式依赖）：Task 6 Step 6.3。
- [ ] §8.4 Gemini 排除条正式登记 backlog（非仅在 spec 里提一句）：Task 7 Step 7.3。
- [ ] R6 doc-sync 三处（DESIGN.md 活架构行 + 既有 client.outbound 覆盖缺口叙述更新、streaming.md 行为表、deferred-backlog §9/:825 条目关闭）：Task 7。
- [ ] 记忆维护 + plan 归档头部注解（`session-closeout` 流程）：Task 8。
- [ ] 每任务测试独立 flaky 确认（连跑 10-15 次）：Task 4/5/6 的最小实现步骤均含。

### 占位扫描（禁 TBD/占位）
- [ ] `grep -rn "TODO\|TBD\|FIXME\|占位\|placeholder" docs/plan/2026-07-22-stateful-client-outbound-repetition-truncation/plan-5-m2-gates-closeout.md` → 仅本行 + 骨架阶段遗留的字面「待填」措辞命中（后者全部已在正文替换为真实内容或显式标注为「实施时按真实结果填写」的字段，非本 plan 自身的占位缺口——分辨方式：真占位是"该写代码却没写"，本 plan 里的"待填"全部是"结果依赖用户运行时产出、无法在 plan 撰写阶段预先编造"，两者性质不同，已在相应段落显式注明）。
- [ ] 所有 harness 代码（mock-upstream.ts、ws-oracle-client.mjs）均为真实可运行的完整实现（含端口/证书/帧格式细节），非伪代码骨架。
- [ ] 所有生产代码实现（`ccExactTransform`/`ccExactFlush`/`responsesExactTransform`/`responsesExactCreateState`/`responsesExactFlush`）均为完整函数体，非签名骨架。

### 与 P0-P4 契约类型一致
- [ ] `collapseRepetition(fullText, cfg): CollapseResult` 签名与 README 冻结契约一致——Task 4/5 的精确档实现与 P2 Anthropic 精确档、P4 非流式折叠使用同一纯核+同一调用约定（整块累积文本一次性折叠），未另建变体。
- [ ] `FlushReason`（`"commit-boundary"|"natural-drain"|"client-aborted"|"upstream-truncated"`）在 Task 4 的 `ccExactFlush(s, reason)` 里正确处理 `"client-aborted"` 分支（丢弃缓冲，不写已关闭 sink，对齐 spec §3.3 生命周期契约）。
- [ ] `env.ctx.recordRepetitionTruncation`（P0 落地的 ctx 写入方法，Task 4/5 沿用同一符号，未改名）。
- [ ] `truncatedCount`/`forwardedBeforeDetection` 语义在精确档升级后正确切换：**精确档** `forwardedBeforeDetection` 恒为 `0`（Task 4/5 实现里显式写 `forwardedBeforeDetection: 0`），`truncatedCount` = 被截全部份数（`collapseRepetition` 对整块累积文本一次性折叠的结果，非近似档"命中后份数"）——这是 P4 近似档与 P5 精确档语义切换的核心差异点，已在 Task 4/5 测试的 marker 断言（`toMatch(/\(203 duplicated outputs truncated\)/)`）里验证。
- [ ] `keep_copies` 字段语义：升级后（精确档），`keep_copies` **正式生效**用于裁剪份数（`cfg.keepCopies = state.repetitionTruncation.keepCopies`，`collapseRepetition` 内部按此裁剪到恰好 `keep_copies` 份）——与 P4 近似档"`keep_copies` 是死参数、不影响裁剪"形成鲜明对照，这正是 spec §6/§7「`keep_copies` 键仅精确档有意义」的字面体现：P4 阶段该键存在但未生效，P5 升级后才真正生效。**这是本 plan 系列（P4+P5）对这条 spec 约束的完整覆盖**——P4 若单独看似乎"定义了却没用"，P5 补齐了"用"的那一半，两个 plan 合起来才是完整实现，非某一个 plan 单独砍范围。
- [ ] `DeliverySyntheticKind:"repetition-truncated"` 通道复用（Task 4/5 的 marker 帧构造不重新发明 provenance 通道）。

### 与 spec 不一致处 / 未采纳建议（record-not-adopted）
- **CC 精确档「block」定义 = 整个响应**（Task 4 设计段落）：spec 全文未给出 CC 精确档的块边界定义（spec §6/§7 只说"过门后升级为精确一份"，未说"精确到什么粒度的一份"）。P4/P5 的工程决策是"复用 CC 既有 buffered_retry 的终止-only 边界"，而非引入一个 CC 独有的、与其他机制不一致的新边界概念。这是必要的工程决策而非砍范围——**若用户认为 CC 应该有更细粒度的块概念（如按标点/段落人为切块），需要在 spec 层面先定义，本 plan 未预设该扩展**，已在 Task 4 自审记录。
- **鸡生蛋结构（Task 1-3 harness 先行、Task 4-6 消费者在后，但 harness 断言的正是 Task 4-6 尚未实现的目标形态）**：这是 M-2 门控模式的固有特性（block-level-buffered-retry 的 P2/P3/P4 同样如此，见 `exp/{cc,responses}-keepalive-idle-oracle/` 的落地时序），非本 plan 独创的设计缺陷——harness 产出的是"验证工具"，Task 4/5/6 产出"被验证的实现"，工具先于被验证对象存在是完全合理的（工具本身不依赖实现细节，只依赖"缓冲期心跳能否保活"这个更底层的传输机制问题）。
- **Task 6 Step 6.3 的 §8.3 评估依赖对 Codex 客户端源码/行为的判断，本 plan 给出的预判（"批处理式消费，无交互式流式依赖"）基于 `exp/responses-keepalive-idle-oracle` 已有的观察（`codex exec --json` 用法），但这是**本 plan 撰写阶段的推断，非最终结论**——Task 6 实施时必须重新核实（读码或行为观测），若与预判不符，plan 里已设计了"记录权衡、交回用户判断"的分支路径，不会因预判错误而堵塞流程。
- **降级路径的 backlog 条目在 Task 4/5/6 内各自内联而非集中在 Task 7**：这是有意的组织决策——每个 Task 的降级 backlog 与其升级实现紧密耦合（同一 Task 内二选一），若集中放 Task 7 会割裂"为什么降级"与"降级到哪"的上下文；Task 7 的 backlog 工作只处理**必然存在**的两项（sink-egress 统一化关闭 + Gemini 排除），不重复处理三个可能存在、可能不存在的门控失败 backlog。

### 收尾纪律核对（session-closeout，对齐 CLAUDE.md）
- [ ] subagent 审查（P4+P5 全部产出的合并态对抗审查）：已在 Task 8 末尾以提醒形式标注，未作为可勾选 Task（这是主会话编排决策——由谁在哪执行审查不是本 plan 的职权范围，只提醒必须发生）。
- [ ] 全套件回归（`test:backend` + `typecheck` + `lint:all`）：Task 8 Step 8.5。
- [ ] 文档live doc lookback（DESIGN.md/streaming.md/backlog 三处已确认同步，非只有 git log）：Task 7 Step 7.4 跨文档 grep 验证。

