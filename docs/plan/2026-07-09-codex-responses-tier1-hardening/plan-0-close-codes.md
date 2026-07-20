# Phase 0 — WHATWG-WS 关闭码正确性（止血）

> REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` 或 `executing-plans`。步骤用 `- [ ]` 追踪。
> 隐含遵守 [README.md](./README.md) 的 Global Constraints。**Spec**: [../../spec/2026-07-09-codex-responses-tier1-hardening.md](../../spec/2026-07-09-codex-responses-tier1-hardening.md) R1 + §1.1。

**Goal:** 上游 WebSocket lifecycle 关闭一律用 `1000`（不再 `1001`），恢复被击败的 WS→HTTP 降级；审计并处理全仓同族 WS 关闭码站点；§1.1 before-first-event 场景端到端转绿。

**Architecture:** 抽单一 `closeUpstreamWs(socket, reason)` 原语（1000 + try/catch 纵深防御），替换 `upstream-ws-connection.ts` 全部 6 处 `close(1001)`；审计下游服务端站点（`ws.ts` 1011/1013、`broadcast.ts` 1001）的运行时抛出行为，据实处理。

**为何 Phase 0 先行：** 这是 §1.1 真实事件的根因修复——`connection.close()`（`upstream-ws-attempt.ts:190`）的 `close(1001)` 抛 `DOMException` 先占了 `return {kind:"fallback"}`，击败 HTTP 降级。改成 1000 即恢复降级。独立可交付、可提交。

---

## Task 0.1：全仓 WS 关闭码审计（先建认知，再动手）

**Files:**
- 只读审计，无代码改动；结论写入本 task 的 commit message + 更新 spec R1.3 站点清单。

**Interfaces:**
- Produces: 一份「站点 → 运行时 → 是否抛出 → 处理决策」清单，供 0.2–0.5 消费。

- [ ] **Step 1：grep 全仓所有 WS close 站点**

Run:
```bash
cd /home/xp/src/copilot-api-js
grep -rn "\.close(100[0-9]\|\.close(101[0-9]\|CLOSE_CODE" src/ | grep -iv "node_modules"
```
Expected：至少命中
- `src/lib/openai/upstream-ws-connection.ts`（6 处 `CLOSE_CODE_GOING_AWAY=1001`，undici **客户端** WebSocket）
- `src/routes/responses/ws.ts`（`1011`/`1013`/`1000`，Hono `WSContext` **服务端**）
- `src/lib/ws/broadcast.ts:135`（`1001`，History UI 广播 **服务端**）

- [ ] **Step 2：分类各站点的运行时严格性**

判据：
- **undici 客户端 WebSocket**（`import { WebSocket } from "undici"`）= WHATWG 严格，`close(code)` 对 `code≠1000 && ∉[3000,4999]` 同步抛 `DOMException('invalid code')`。→ **必须改 1000**。
- **Bun/Hono 服务端**（`hono/ws` `WSContext`、Bun `ServerWebSocket`、`ws` 包）= 通常宽松，`1001/1011/1013` 于 RFC 6455 服务端合法。→ **实测是否抛**，不盲改语义正确的码。

Run（确认各文件的 WS 实现来源）：
```bash
grep -n "from \"undici\"\|from \"hono/ws\"\|WSContext\|ServerWebSocket\|from \"ws\"" src/lib/openai/upstream-ws-connection.ts src/routes/responses/ws.ts src/lib/ws/broadcast.ts
```
Expected：`upstream-ws-connection.ts` → undici（严格）；`ws.ts` → hono/ws（服务端）；`broadcast.ts` → 查其类型。

- [ ] **Step 3：实测服务端站点是否抛出**

对 `ws.ts`（1011/1013）与 `broadcast.ts`（1001）各写一次性探针，确认其运行时 `close(<code>)` 是否抛：
```bash
bun -e '
// 用与源文件相同的 WS 实现构造一个实例，调用 close(1011)/close(1013)/close(1001)，try/catch 打印是否抛。
// hono/ws 的 WSContext.close 委托底层 Bun ServerWebSocket.close；Bun 服务端 close 接受 1011/1013/1001。
// 若无法离线构造，记录“需运行期验证”并在 Phase 5 用集成测试覆盖。
'
```
Expected：记录结论（抛 / 不抛 / 需运行期验证）。**不盲改**。

- [ ] **Step 4：提交审计结论**

```bash
git add -- docs/spec/2026-07-09-codex-responses-tier1-hardening.md
git commit -F- -- docs/spec/2026-07-09-codex-responses-tier1-hardening.md <<'EOF'
docs(spec): record repo-wide WS close-code audit (R1.3)

Sites: upstream-ws-connection.ts (6x undici client, MUST fix 1001->1000);
ws.ts (1011/1013 Hono server); broadcast.ts:135 (1001 History-UI broadcast
server). Server-side codes verified <抛/不抛/需运行期验证>.
EOF
```
（若审计只更新了 spec 的站点清单则提交 spec；若无 spec 改动，本 task 结论并入 0.2 的 commit。）

---

## Task 0.2：`closeUpstreamWs` 原语 + 替换 6 处（上游客户端）

**Files:**
- Modify: `src/lib/openai/upstream-ws-connection.ts`（`:14` 常量、6 处 close 站点 `:101,:146,:160,:218,:294,:341`）
- Test: `tests/responses/upstream-ws-connection.unit.test.ts`（新增 throwing-socket 变体 + 更新 `:155` 断言）

**Interfaces:**
- Produces: 模块内私有 `closeUpstreamWs(socket: WebSocketLike | null | undefined, reason: string): void`（内部用 `1000`，try/catch 吞抛出 + `consola.warn`）。供 Phase 1 的 `guardCallback` 组合（纵深防御两层）。

- [ ] **Step 1：写失败测试（throwing socket 证明修复）**

在 `tests/responses/upstream-ws-connection.unit.test.ts` 顶部（`FakeSocket` 之后）加一个模拟 undici 严格性的变体，并加一个断言"握手失败以 1000 关闭、且严格 socket 不致命"的测试：

```ts
/** Mimics undici's WHATWG close-code validation: throws on any code that is
 *  neither 1000 nor within [3000,4999], exactly like the real client WebSocket. */
class StrictFakeSocket extends FakeSocket {
  override close(code?: number, reason?: string): void {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException("invalid code", "InvalidAccessError")
    }
    super.close(code, reason)
  }
}

test("closes with WHATWG-legal 1000 on handshake failure (strict socket does not throw)", () => {
  const socket = new StrictFakeSocket()
  const connection = createUpstreamWsConnection({
    headers: {},
    model: "gpt-5.5",
    createSocket: () => socket,
  })
  // Handshake error before open → active close. Must NOT throw, and must use 1000.
  expect(() => socket.dispatchEvent(new Event("error"))).not.toThrow()
  expect(socket.closeCalls).toEqual([{ code: 1000, reason: "Handshake failed" }])
})
```

- [ ] **Step 2：运行，确认失败**

Run: `bun test tests/responses/upstream-ws-connection.unit.test.ts -t "WHATWG-legal 1000"`
Expected: FAIL —— 现代码用 `1001`，`StrictFakeSocket.close(1001)` 抛 `DOMException`（`toThrow` 命中）或 `closeCalls` 记到 `1001`。

- [ ] **Step 3：实现 `closeUpstreamWs` + 替换常量与 6 处**

在 `upstream-ws-connection.ts`：把 `:14` 改为
```ts
const CLOSE_CODE_NORMAL = 1000
```
新增原语（放在 `createUpstreamWsConnection` 内部或模块级，能访问 `WebSocketLike`）：
```ts
/** Close an upstream WS with the WHATWG-legal normal-closure code (1000).
 *  undici's client WebSocket throws DOMException('invalid code') for 1001/1011/etc;
 *  the try/catch is defense-in-depth so a close never escalates a callback throw. */
function closeUpstreamWs(socket: WebSocketLike | null | undefined, reason: string): void {
  try {
    socket?.close(CLOSE_CODE_NORMAL, reason)
  } catch (error) {
    consola.warn(`[upstream-ws] close(${CLOSE_CODE_NORMAL}) threw (ignored): ${error instanceof Error ? error.message : String(error)}`)
  }
}
```
把 6 处 `socket?.close(CLOSE_CODE_GOING_AWAY, "<reason>")` / `ws.close(...)` / `socket.close(...)` 全替换为 `closeUpstreamWs(socket, "<reason>")`（reason 字符串不变：`"Idle timeout"`/`"Parse error"`/`"Socket error"`/`"Handshake failed"`/`"Send failed"`/`"Going away"`）。注意 `:218` 变量名是 `ws`。

更新既有断言 `tests/responses/upstream-ws-connection.unit.test.ts:155`：
```ts
expect(socket.closeCalls).toEqual([{ code: 1000, reason: "Handshake failed" }])
```
（其余 `:229,:278,:379,:408` 用 `.some(c => c.reason === ...)` 检 reason，无需改。）

- [ ] **Step 4：运行，确认通过**

Run: `bun test tests/responses/upstream-ws-connection.unit.test.ts`
Expected: PASS（含新测试 + 更新后的 `:155`）。

- [ ] **Step 5：确认无 1001 残留 + typecheck**

Run:
```bash
grep -n "1001\|CLOSE_CODE_GOING_AWAY" src/lib/openai/upstream-ws-connection.ts   # expect: no matches
bun run typecheck 2>&1 | tail -3
```
Expected: grep 无输出；typecheck 绿。

- [ ] **Step 6：提交**

```bash
git add -- src/lib/openai/upstream-ws-connection.ts tests/responses/upstream-ws-connection.unit.test.ts
git commit -F- -- src/lib/openai/upstream-ws-connection.ts tests/responses/upstream-ws-connection.unit.test.ts <<'EOF'
fix(upstream-ws): close with WHATWG-legal 1000, not 1001

undici's client WebSocket throws DOMException('invalid code') on close(1001)
(only 1000 / 3000-4999 allowed). All 6 lifecycle close sites now go through
closeUpstreamWs() (1000 + defensive try/catch). Fixes the "invalid code"
failure that defeated the WS->HTTP fallback.
EOF
```

---

## Task 0.3：§1.1 before-first-event 黄金回归（降级恢复）

**Files:**
- Test: `tests/responses/upstream-ws.unit.test.ts` 或 `tests/responses/openai-responses-client.it.test.ts`（就近于 `attemptUpstreamResponsesWs` 的既有测试）

**Interfaces:**
- Consumes: `attemptUpstreamResponsesWs`（`src/lib/openai/upstream-ws-attempt.ts`），返回 `{kind:"ok"|"fallback"}`；fallback 分支在 `catch` 内 `connection.close()` 后 `return {kind:"fallback"}`。

- [ ] **Step 1：写回归测试**

驱动一个"首事件前失败"的上游 WS（用 `StrictFakeSocket` + 让 `sendRequest`/握手前触发 error），断言 `attemptUpstreamResponsesWs` 返回 `{ kind: "fallback" }` 而**不抛** `"invalid code"`：
```ts
test("before-first-event WS failure falls back to HTTP (close does not defeat fallback)", async () => {
  // Arrange a WS attempt whose first-event wait fails, using a StrictFakeSocket
  // so connection.close() would throw DOMException('invalid code') on the old code.
  // Assert the attempt resolves to { kind: "fallback" }, not a thrown "invalid code".
  const attempt = await attemptUpstreamResponsesWs(/* wire+headers driving pre-first-event failure */)
  expect(attempt.kind).toBe("fallback")
})
```
（具体 arrange 依 `attemptUpstreamResponsesWs` 既有测试的注入点；用其 `createSocket`/manager 注入 `StrictFakeSocket`。）

- [ ] **Step 2：运行**

Run: `bun test tests/responses/upstream-ws.unit.test.ts -t "falls back to HTTP"`
Expected: PASS（0.2 修复后）。若在 0.2 前跑，应 FAIL（`connection.close()` 抛 `"invalid code"` 先占 fallback return）。

- [ ] **Step 3：提交**

```bash
git add -- tests/responses/upstream-ws.unit.test.ts
git commit -m "test(upstream-ws): golden regression for before-first-event HTTP fallback" -- tests/responses/upstream-ws.unit.test.ts
```

---

## Task 0.4：L1 契约守卫（关闭永不传禁用码）

**Files:**
- Test: `tests/responses/upstream-ws-connection.unit.test.ts`

- [ ] **Step 1：写守卫测试**

用 `StrictFakeSocket` 遍历触发每个 lifecycle 关闭点（idle-timeout / parse-error / socket-error / handshake / send-failed / going-away），断言**任一** close 都不抛且 code 为 1000：
```ts
test("no lifecycle path ever calls close() with a WHATWG-forbidden code", async () => {
  // drive each of the 6 lifecycle close paths on a StrictFakeSocket;
  // assert none throws and every recorded closeCall.code === 1000.
  // (reuse the existing per-path tests' driving code; assert on socket.closeCalls codes.)
})
```

- [ ] **Step 2：运行 + 提交**

Run: `bun test tests/responses/upstream-ws-connection.unit.test.ts`
Expected: PASS。
```bash
git add -- tests/responses/upstream-ws-connection.unit.test.ts
git commit -m "test(upstream-ws): L1 guard — close never uses a WHATWG-forbidden code" -- tests/responses/upstream-ws-connection.unit.test.ts
```

---

## Task 0.5：下游服务端站点处理（`ws.ts` / `broadcast.ts`）

**Files:**
- 依 0.1 结论：若实测**抛出** → Modify `src/routes/responses/ws.ts`（`:144,:496,:595`）/ `src/lib/ws/broadcast.ts:135` + 对应测试；若**不抛**（服务端码合法）→ 仅在测试固化行为 + 记录结论，不改语义正确的码。

**Interfaces:**
- Consumes: Task 0.1 的运行时结论。

- [ ] **Step 1：据 0.1 结论决定动作**

- 若服务端运行时容忍 1011/1013/1001（预期）：加/保留固化测试（`tests/history/history-ws.unit.test.ts:171` 已断言 `[1001,...]`；`ws.ts` 加等价固化），并在测试注释写明"服务端码于 RFC6455 合法且运行时容忍"。**不改**。
- 若实测抛出：把服务端 close 也走各自的安全包裹（服务端等价的 try/catch），**保留语义正确的码**（1011/1013 服务端合法），仅加防抛；或据运行时要求调整。

- [ ] **Step 2：运行相关测试 + 提交**

Run: `bun test tests/responses/ tests/history/history-ws.unit.test.ts`
Expected: PASS。
```bash
git add -- <改动文件>
git commit -m "<fix|test>(ws): <server close-code handling per audit>" -- <改动文件>
```

---

## Phase 0 DoD

- [ ] `grep -rn "close(1001\|CLOSE_CODE_GOING_AWAY" src/lib/openai/` 无输出。
- [ ] §1.1 before-first-event 场景：修复后降级 HTTP（0.3 绿）。
- [ ] L1 契约守卫绿（0.4）。
- [ ] 下游服务端站点有实测结论 + 固化测试（0.5）。
- [ ] `bun run typecheck` + `bun test tests/responses/ tests/history/` 绿。
- [ ] 各 task 已细粒度 pathspec 提交。

## 交给 Phase 1

Phase 1 复用本阶段的 `closeUpstreamWs`（源头层），叠加 `guardCallback`（per-callback 网）构成崩溃防护两层。`StrictFakeSocket` 变体供 Phase 1 的 fault-injection 复用。
