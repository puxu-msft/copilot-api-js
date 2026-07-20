# Phase 2 — Responses 下游客户端保活（Codex）

> REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`。步骤用 `- [ ]` 追踪。
> 隐含遵守 [README.md](./README.md) Global Constraints。**Spec**: [../../spec/2026-07-09-codex-responses-tier1-hardening.md](../../spec/2026-07-09-codex-responses-tier1-hardening.md) R3 + §4。

**Goal:** Responses 流式路径（SSE 与下游 WS）在长 reasoning 静默期向客户端注入保活帧，使 Codex（300s idle）与其它消费者不因静默断连；帧型 Codex-容忍、打项目合成标记。

**Architecture:** `makeSseSink` 已内置完整 heartbeat（`heartbeat.intervalSec` + `pingFrame` + `emitKeepalive` 自动打 `synthetic:"keepalive"` 采样入 forwarded 轨）。Responses 当前 `makeSseSink(...)` 调用（`handler-v4.ts:267`）**未传 heartbeat**（"Responses has none"）。Phase 2：新增一个 Responses 专属固定保活帧 + 把 heartbeat 接进 SSE sink；下游 WS（`ws.ts` / `makeWsSink`）按 R3.5 补等价保活。

**已定事实（spec §4，`refs/codex` 核定）：** Codex `stream_idle_timeout` 默认 300s，**每个 emit 的 SSE 事件**重置；对**未知 `type`** 的 `data:` 帧双重容忍（`continue` / `Ok(None)`），零副作用。⟹ 保活帧 = 带非空 `data:` 的合法 JSON、未知 `type`（`event:` 行可选但加上更稳）。间隔复用 `state.streamKeepalivePingSec`（20s ≪ 300s）；**不复用** `streamKeepaliveMode`（Anthropic 帧型枚举）。

---

## Task 2.1：Responses SSE 保活帧 + 接入 sink heartbeat

**Files:**
- Create: `src/lib/codec/openai-responses/keepalive.ts`（保活帧工厂，就近于 responses codec）
- Modify: `src/routes/responses/handler-v4.ts`（`makeSseSink` 传 heartbeat；线程 client-abort 信号进 `pumpStreamingV4`）
- Test: `tests/responses/responses-keepalive.unit.test.ts`（Create）

**Interfaces:**
- Produces: `export function responsesKeepaliveFrame(): ClientFrame` → 返回固定帧 `{ event: "response.ping", data: JSON.stringify({ type: "response.ping" }) }`（未知/合成 `type`，Codex 容忍；`ClientFrame` 从 `~/lib/pipeline/types`）。
- Consumes: `makeSseSink` 的 `SseSinkHeartbeat`（`client-sink.ts`）；`state.streamKeepalivePingSec`。

- [ ] **Step 1：O4 前置核定 —— 保活帧对非-Codex 标准 OpenAI Responses SDK 的容忍**

Codex 容忍已由 spec §4 钉死。对标准 OpenAI Responses SDK 消费者做一次核定（`empirical-verification`：别假设）：
Run:
```bash
cd /home/xp/src/copilot-api-js/.worktrees/codex-responses-tier1
ls node_modules/openai 2>/dev/null && grep -rn "unknown\|default:\|switch.*event.type\|parse.*event\|ResponseStreamEvent" node_modules/openai/**/streaming* node_modules/openai/**/responses* 2>/dev/null | head
grep -rln "responses" refs/ 2>/dev/null | head
```
判据：确认标准 SDK 对未知 SSE 事件 `type` 是**忽略/透传**（绝大多数 SDK 如此）还是抛错。
- 若忽略/透传 → `response.ping` 帧安全，继续。
- 若某 SDK 抛错 → 记录并在 keepalive.ts 注释说明，选用 SDK 也容忍的最稳形态（如带完整最小字段的未知事件）。
将结论写进 keepalive.ts 顶部 doc（引 spec §4 + 本核定）。

- [ ] **Step 2：写失败测试**

```ts
import { describe, expect, test } from "bun:test"
import { responsesKeepaliveFrame } from "~/lib/codec/openai-responses/keepalive"

describe("responsesKeepaliveFrame", () => {
  test("is a data-bearing SSE frame with a valid-JSON, synthetic (non-real) type", () => {
    const f = responsesKeepaliveFrame()
    expect(f.data).toBeTruthy()               // Codex resets idle only on data-bearing emitted events (§4)
    const parsed = JSON.parse(f.data as string)
    expect(typeof parsed.type).toBe("string") // valid JSON with a type
    expect(parsed.type).toMatch(/ping/)       // clearly-synthetic, not a real Responses event
    expect(f.event).toBe(parsed.type)         // SSE event line mirrors the JSON type
  })
})
```

- [ ] **Step 3：运行，确认失败**

Run: `bun test tests/responses/responses-keepalive.unit.test.ts`
Expected: FAIL —— `responsesKeepaliveFrame` 未定义。

- [ ] **Step 4：实现帧工厂**

`src/lib/codec/openai-responses/keepalive.ts`:
```ts
import type { ClientFrame } from "~/lib/pipeline/types"

/**
 * A synthetic forward-idle keepalive frame for the Responses SSE stream. Codex's SSE
 * reader (refs/codex codex-api/src/sse/responses.rs) resets its 300s stream_idle_timeout
 * on EVERY emitted SSE event and tolerates an unknown `type` (JSON parse-fail → `continue`;
 * unknown kind → `Ok(None)`), so a data-bearing frame with a clearly-synthetic type resets
 * the idle clock with zero client-visible effect (spec §4). A bare SSE comment would NOT
 * work — eventsource_stream does not emit an event for a comment-only frame, so it wouldn't
 * reset the clock. The forwarded-history record is marked `synthetic:"keepalive"` by the
 * sink's emitKeepalive; this benign `response.ping` type is itself the on-wire tell.
 * O4: standard OpenAI Responses SDK tolerates unknown event types (verified Task 2.1 Step 1).
 */
export function responsesKeepaliveFrame(): ClientFrame {
  return { event: "response.ping", data: JSON.stringify({ type: "response.ping" }) }
}
```

- [ ] **Step 5：运行，确认通过**

Run: `bun test tests/responses/responses-keepalive.unit.test.ts`
Expected: PASS。

- [ ] **Step 6：接入 SSE sink heartbeat + 线程 client-abort**

在 `handler-v4.ts`：
- `pumpStreamingV4` 的 `PumpStreamingV4Options` 加 `clientAbortSignal?: AbortSignal`；`streamSSE` 回调里把 `clientAbort.signal` 传进 `pumpStreamingV4({ ..., clientAbortSignal: clientAbort.signal })`（`clientAbort` 是 `handleResponsesV4` 内既有的 AbortController；确认其作用域可达传参处，不可达则从 `env.ctx` 取客户端断连信号）。
- 改 `:267` 的 sink 构造为：
```ts
const keepaliveSec = state.streamKeepalivePingSec
const sink = makeSseSink(stream, {
  onForwarded: (record) => forwardedSseEvents.push(record),
  streamStartMs,
  ...(keepaliveSec > 0 && {
    heartbeat: {
      intervalSec: keepaliveSec,
      pingFrame: responsesKeepaliveFrame(),
      clientAbortSignal: opts.clientAbentSignal, // client disconnect suppresses pings
    },
  }),
})
```
（修正拼写为 `opts.clientAbortSignal`。）
- 把 `:261` 注释 "No heartbeat (Responses has none)." 更新为描述现在的 Responses 保活（引 spec §4 / R3）。
- 加 `import { responsesKeepaliveFrame } from "~/lib/codec/openai-responses/keepalive"` 与 `import { state } from "~/lib/state"`（若未导入）。

- [ ] **Step 7：写 sink 接线行为测试（fake timers）**

在 `tests/responses/responses-keepalive.unit.test.ts` 加一个用 fake timers 驱动 `makeSseSink` 的测试，证 forward-idle 触发注入且打标记：
```ts
import { makeSseSink } from "~/lib/pipeline/client-sink"
// ... build a fake SSEStreamingApi capturing writeSSE calls; use bun's fake timers or a manual clock.
test("forward-idle injects the keepalive frame, marked synthetic in the forwarded track", async () => {
  const written: Array<{ event?: string; data?: string }> = []
  const forwarded: Array<{ synthetic?: string; type: string }> = []
  const stream = { writeSSE: async (f: { event?: string; data?: string }) => { written.push(f) } } as never
  const sink = makeSseSink(stream, {
    onForwarded: (r) => forwarded.push(r as never),
    heartbeat: { intervalSec: 0.05, pingFrame: responsesKeepaliveFrame() },
  })
  await new Promise((r) => setTimeout(r, 120)) // > interval, no real write → ping fires
  sink.close?.()
  expect(written.some((f) => f.event === "response.ping")).toBe(true)
  expect(forwarded.some((r) => r.synthetic === "keepalive")).toBe(true)
})
```
（若 bun fake timers 更稳则用 fake timers；时序测试连跑 10× 确认无 flaky —— `empirical-verification`。）

- [ ] **Step 8：运行全套 + typecheck**

Run: `bun test tests/responses/ && bun run typecheck 2>&1 | tail -2`
Expected: PASS；typecheck 绿。连跑保活时序测试 10×：`for i in $(seq 1 10); do bun test tests/responses/responses-keepalive.unit.test.ts 2>&1 | grep -E "pass|fail" | tail -1; done | sort | uniq -c` → 全 "0 fail"。

- [ ] **Step 9：提交**

```bash
git add -- src/lib/codec/openai-responses/keepalive.ts src/routes/responses/handler-v4.ts tests/responses/responses-keepalive.unit.test.ts
git commit -F- -- src/lib/codec/openai-responses/keepalive.ts src/routes/responses/handler-v4.ts tests/responses/responses-keepalive.unit.test.ts <<'EOF'
feat(responses): downstream SSE keepalive for Codex long-reasoning silence

Wire the sink's forward-idle heartbeat into the Responses SSE path (was "none").
Injects a synthetic response.ping frame every streamKeepalivePingSec (20s) of
forward silence — a data-bearing, unknown-type frame Codex tolerates (§4) and
that resets its 300s idle clock; marked synthetic:"keepalive" in the forwarded
history track, absent from the upstream track. Reuses the keepalive INTERVAL
(not the Anthropic-shaped mode enum).
EOF
```

---

## Task 2.2：下游 WS-to-client 保活（`ws.ts`，R3.5）

**Files:**
- Modify（依 Step 1 结论）: `src/lib/pipeline/client-sink.ts`（`makeWsSink` 加可选 heartbeat）+ `src/routes/responses/ws.ts`（传 heartbeat）
- Test: `tests/responses/…`（WS 保活行为）

**Interfaces:**
- Consumes: `responsesKeepaliveFrame`（Task 2.1）、`state.streamKeepalivePingSec`。

- [ ] **Step 1：核定下游 WS 是否需应用层保活（empirical）**

标准/浏览器 WS 有协议级 ping/pong；但服务端是否**自动**发 ping 取决于运行时。核定 Bun/Hono `WSContext`（`ws.ts` 用的）是否自动保活：
Run:
```bash
grep -rn "ping\|pong\|idleTimeout\|sendPings\|keepalive" node_modules/hono/dist/**/ws* 2>/dev/null | head
# 探针：Bun.serve websocket 是否有 sendPings 选项 / 默认行为
bun -e 'const s=Bun.serve({port:0,fetch(r,sv){if(sv.upgrade(r))return;return new Response("no")},websocket:{sendPings:true,message(){},open(){}}}); console.log("Bun ws sendPings option accepted:", typeof s==="object"); s.stop(true)'
```
判据：
- 若 Bun/Hono 服务端**默认或可配置**自动发 protocol ping 且下游能靠它保活 → 记录结论，**无需**应用层帧（协议 ping/pong 已 keep-alive）；仅在 doc/测试固化该依赖。
- 若不自动、或 Codex 式 WS 消费者依赖应用层事件 → 给 `makeWsSink` 加与 `makeSseSink` 同构的可选 heartbeat（复用 `responsesKeepaliveFrame`），`ws.ts` 传入。

将结论（走协议 ping vs 应用层帧）写进 `ws.ts` 注释 + 本 task commit message。

- [ ] **Step 2（条件）：给 `makeWsSink` 加 heartbeat（仅当 Step 1 判需应用层）**

镜像 `makeSseSink` 的 heartbeat 结构（interval + fixed pingFrame + `synthetic:"keepalive"` 采样 + `close`/timer unref + clientAbort 抑制）。`makeWsSink` 现无 heartbeat 参数——加 `WsSinkOptions.heartbeat?: { intervalSec; pingFrame; clientAbortSignal? }`，实现 forward-idle timer（可抽 `makeSseSink`/`makeWsSink` 共用的 heartbeat 内核，避免重复——但保持 driver 不变；若抽取，作为 client-sink.ts 内部私有 helper）。

- [ ] **Step 3：写测试**

依 Step 1 结论：协议 ping → 固化"服务端自动保活"的探针测试；应用层帧 → forward-idle 注入 keepalive 帧 + 标记，同 2.1 Step 7 形态。

- [ ] **Step 4：运行 + typecheck + 提交**

Run: `bun test tests/responses/ && bun run typecheck 2>&1 | tail -2`
Expected: PASS。
```bash
git add -- <改动文件>
git commit -m "feat(responses): downstream WS-to-client keepalive parity (R3.5)" -- <改动文件>
```

---

## Phase 2 DoD

- [ ] Responses SSE forward-idle 按 `streamKeepalivePingSec` 注入 `response.ping`，打 `synthetic:"keepalive"`（2.1）。
- [ ] 帧型对 Codex（§4）与标准 OpenAI SDK（O4 核定）均容忍。
- [ ] 下游 WS-to-client 保活有结论 + 实现/固化（协议 ping 或应用层帧）（2.2）。
- [ ] 保活时序测试连跑 10× 无 flaky。
- [ ] `bun run typecheck` + `bun test tests/responses/` 绿；Anthropic 保活/其它路径未回归。
- [ ] 各 task 细粒度 pathspec 提交。

## 交给 Phase 3

下游保活就位后，Phase 3 的 buffered 重试（commit 前零真实帧）才有前提——buffering ⇒ 强制启用本阶段的保活（spec R4.3(a)）。Phase 3 采用 driver 的 `runResponseBufferedSink`（opt-in、默认 live）。
