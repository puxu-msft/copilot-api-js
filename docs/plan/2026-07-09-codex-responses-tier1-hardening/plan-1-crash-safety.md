# Phase 1 — 上游-WS lifecycle 崩溃防护

> REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`。步骤用 `- [ ]` 追踪。
> 隐含遵守 [README.md](./README.md) Global Constraints。**Spec**: [../../spec/2026-07-09-codex-responses-tier1-hardening.md](../../spec/2026-07-09-codex-responses-tier1-hardening.md) R2 + §1.2。

**Goal:** 消除上游-WS lifecycle 回调（WHATWG `EventTarget` 监听器）与裸 `setTimeout` 内抛出升级为 `uncaughtException → process.exit(1)` 的一类崩溃向量。

**Architecture:** 在 `crash-safety.ts` 新增第三个原语 `guardCallback(fn, onEscape)`（同步回调 try/catch 工厂，EventTarget 版的 `withErrorSink`/`withRejectionObserver` 孪生）；把 `upstream-ws-connection.ts` 每个 `addEventListener` 处理器 + idle `setTimeout` 用它包裹，抛出经 `onEscape` 降级为 warn + 标记不可用 + 失败在途请求（可被 Phase 3 恢复），永不逃逸。

**已实证的关键事实（本机 probe，Bun 与 Node 一致）：**
- 抛出的 EventTarget 监听器：`dispatchEvent` **不同步抛**，错误**异步逃逸为 `uncaughtException`**（`main.ts:24-27` → `process.exit(1)`）。
- 被 `guardCallback` 包裹：`onEscape` 捕获，**零** `uncaughtException`。
- ⟹ 崩溃防护测试必须断言**无 `uncaughtException`**（子进程测试），**不能**用 `.not.toThrow()`（`dispatchEvent` 本就不同步抛，该断言对监听器抛出是空的）。

**为何需要（§1.2）：** 现 6 个 `addEventListener` 处理器 + idle `setTimeout` 裸挂。Phase 0 的 `closeUpstreamWs` 已封住 close 那一行的 `DOMException`（源头层），但处理器内**任何其它**未预期抛出（`opts.onClose` 外部回调抛、`currentQueue.push` 抛、catch 块内二次抛）仍逃逸崩溃。`guardCallback` 是更宽的 per-callback 网（纵深防御第二层，类比 h2 握手两层）。

---

## Task 1.1：`guardCallback` 原语 + 单元测试

**Files:**
- Modify: `src/lib/transport/crash-safety.ts`（新增 `guardCallback` + 扩模块 doc 到"三原语"）
- Test: `tests/transport/crash-safety.unit.test.ts`（若不存在则 Create；先 grep 现有 crash-safety 测试位置）

**Interfaces:**
- Produces: `export function guardCallback<A extends unknown[]>(fn: (...args: A) => void, onEscape: (error: unknown) => void): (...args: A) => void` —— 返回一个包装器：调用 `fn(...args)`，若同步抛出则调 `onEscape(error)` 并**吞掉**（不 rethrow），返回 `undefined`。正常时透传 `fn` 的执行（void 返回）。

- [ ] **Step 1：定位/创建 crash-safety 测试文件**

Run: `ls tests/transport/ 2>/dev/null; grep -rln "withErrorSink\|withRejectionObserver\|crash-safety" tests/`
Expected：找到既有 crash-safety 测试文件；若无，新建 `tests/transport/crash-safety.unit.test.ts`。

- [ ] **Step 2：写失败测试**

```ts
import { describe, expect, mock, test } from "bun:test"
import { guardCallback } from "~/lib/transport/crash-safety"

describe("guardCallback", () => {
  test("forwards args and return-less call when fn does not throw", () => {
    const seen: Array<unknown> = []
    const onEscape = mock(() => {})
    const guarded = guardCallback((a: number, b: string) => { seen.push(a, b) }, onEscape)
    guarded(1, "x")
    expect(seen).toEqual([1, "x"])
    expect(onEscape).not.toHaveBeenCalled()
  })

  test("catches a synchronous throw, routes it to onEscape, and does not rethrow", () => {
    const err = new Error("boom")
    let captured: unknown = null
    const guarded = guardCallback(() => { throw err }, (e) => { captured = e })
    expect(() => guarded()).not.toThrow()   // meaningful HERE: guardCallback itself must swallow
    expect(captured).toBe(err)
  })

  test("a throwing guarded EventTarget listener does not escape dispatchEvent", () => {
    // Locks the empirical model: without a guard the throw escapes as uncaughtException;
    // guarded, onEscape absorbs it and dispatchEvent completes cleanly.
    const target = new EventTarget()
    let escaped: unknown = null
    target.addEventListener("x", guardCallback(() => { throw new Error("listener-boom") }, (e) => { escaped = e }))
    expect(() => target.dispatchEvent(new Event("x"))).not.toThrow()
    expect(escaped).toBeInstanceOf(Error)
  })
})
```

- [ ] **Step 3：运行，确认失败**

Run: `bun test tests/transport/crash-safety.unit.test.ts`
Expected: FAIL —— `guardCallback` 未定义（import 报错）。

- [ ] **Step 4：实现 `guardCallback` + 扩 doc**

在 `crash-safety.ts` 追加：
```ts
/**
 * Wrap a synchronous callback so a throw is routed to `onEscape` instead of
 * escaping — the WHATWG-`EventTarget` twin of {@link withErrorSink}. A throwing
 * `addEventListener` listener (or a bare `setTimeout` callback) does NOT surface
 * synchronously to the dispatcher; it escapes ASYNCHRONOUSLY as an
 * `uncaughtException` → `main.ts` `process.exit(1)` (verified Bun + Node: a
 * throwing EventTarget listener never rejects/throws out of `dispatchEvent`,
 * it reports globally). `withErrorSink` CANNOT cover this: it relies on
 * `EventEmitter`'s "unhandled 'error' event rethrows" semantic, which
 * `EventTarget` does not have — attaching a no-op 'error' listener to an
 * EventTarget is inert.
 *
 * Unlike the other two primitives there is no single ownership chokepoint: each
 * listener / timer is its own escape point and needs per-callback context to
 * decide what to fail, so this MUST be applied at each registration site rather
 * than once. `onEscape` must itself be safe (warn + set flags / fail the
 * in-flight request) — a throw inside `onEscape` would re-escape.
 */
export function guardCallback<A extends unknown[]>(fn: (...args: A) => void, onEscape: (error: unknown) => void): (...args: A) => void {
  return (...args: A): void => {
    try {
      fn(...args)
    } catch (error) {
      onEscape(error)
    }
  }
}
```
并把模块顶部 doc 的"two helpers / two whole CLASSES"更新为三原语，加入 `guardCallback` 一段（EventTarget 类、无单一 chokepoint、须逐点应用）。

- [ ] **Step 5：运行，确认通过 + typecheck**

Run: `bun test tests/transport/crash-safety.unit.test.ts && bun run typecheck 2>&1 | tail -2`
Expected: PASS；typecheck 绿。

- [ ] **Step 6：提交**

```bash
git add -- src/lib/transport/crash-safety.ts tests/transport/crash-safety.unit.test.ts
git commit -F- -- src/lib/transport/crash-safety.ts tests/transport/crash-safety.unit.test.ts <<'EOF'
feat(crash-safety): add guardCallback for EventTarget sync-callback escapes

Third crash-safety primitive, the EventTarget twin of withErrorSink. A throwing
addEventListener listener / bare setTimeout callback escapes asynchronously as
uncaughtException (verified Bun+Node); withErrorSink can't cover it (EventTarget
has no unhandled-'error'-rethrow semantic). guardCallback routes the throw to a
per-site onEscape instead. Applied to upstream-ws in the next task.
EOF
```

---

## Task 1.2：把 `guardCallback` 接入 `upstream-ws-connection.ts` 全部回调点

**Files:**
- Modify: `src/lib/openai/upstream-ws-connection.ts`
- Test: `tests/responses/upstream-ws-connection.unit.test.ts`（onClose-throw 接线测试）

**Interfaces:**
- Consumes: `guardCallback`（Task 1.1）。
- Produces: 全部 lifecycle 回调经 `guardCallback` 包裹；模块内 `onCallbackEscape(error)` 闭包 = `consola.warn` + `markUnusable()` + `failRequest(toError(error))`。

**包裹清单（每处 `addEventListener` 的 handler + idle setTimeout）：**
- `handleMessage`（`:221` 注册）→ 包裹，onEscape = `onCallbackEscape`
- `handleError`（`:222`）→ 包裹，onEscape = `onCallbackEscape`
- `handleClose`（`:223`）→ 包裹，onEscape = `onCallbackEscape`（**opts.onClose 是外部回调，真实逃逸源**）
- `onOpen`（`:234`）→ 包裹，onEscape = warn + `reject(new Error("Upstream WebSocket open handler failed"))`（握手期，无在途请求）
- `onOpenError`（`:235`）→ 包裹，onEscape = warn + `reject(...)`
- connect `onAbort`（`:257`）→ 包裹，onEscape = warn + `reject(...)`
- sendRequest `onAbort`（`:292`）→ 包裹，onEscape = `onCallbackEscape`
- idle `setTimeout`（`:112`）→ 包裹回调，onEscape = warn + `markUnusable()`（空闲，无在途请求）

- [ ] **Step 1：写失败测试（onClose 抛出 = 真实逃逸向量）**

在 `tests/responses/upstream-ws-connection.unit.test.ts` 加：
```ts
test("a throwing onClose does not escape handleClose (guarded)", async () => {
  const socket = new FakeSocket()
  const connection = createUpstreamWsConnection({
    headers: {}, model: "gpt-5.5",
    createSocket: () => socket,
    onClose: () => { throw new Error("onClose boom") },
  })
  void connection.connect().catch(() => {})
  socket.open()
  // Drive a close; handleClose calls opts.onClose which throws. Guarded → must
  // NOT propagate out of dispatchEvent (the async uncaughtException escape point).
  expect(() => socket.dispatchEvent(new CloseEvent("close", { code: 1000, reason: "x" }))).not.toThrow()
})
```
（注：`.not.toThrow()` 在这里只弱证 dispatchEvent 不同步抛；真正的"无 uncaughtException"证在 Task 1.3 子进程测试。本测试的价值是证 handleClose 被接线包裹且 onClose 抛出被吸收，配合 Task 1.3 才完整。）

- [ ] **Step 2：运行，确认失败**

Run: `bun test tests/responses/upstream-ws-connection.unit.test.ts -t "throwing onClose"`
Expected: FAIL —— 未包裹时 `opts.onClose?.()`（`:188`）抛出经 `guardCallback` 缺失而逃逸；bun:test 会把它记为 uncaughtException 导致该测试失败/报错。

- [ ] **Step 3：实现接线**

在 `createUpstreamWsConnection` 内：
- 加 `import { guardCallback } from "~/lib/transport/crash-safety"`（与现有 import 分组一致）。
- 定义 `const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))`。
- 定义 `const onCallbackEscape = (error: unknown): void => { consola.warn(\`[upstream-ws] callback threw; failing request + dropping connection (model=${opts.model}): ${toError(error).message}\`); markUnusable(); failRequest(toError(error)) }`。
- 把 `handleMessage`/`handleError`/`handleClose` 的**定义**改为 `const handleMessage = guardCallback((event: Event) => { ...原体... }, onCallbackEscape)`（三者同理；handler 体不变，只外包）。注意 `handleClose` 内部有对 `handleMessage`/`handleError`/`handleClose` 的 `removeEventListener` 引用——包裹后引用的是包裹后的同名 const，天然一致（移除的正是注册的那个函数引用）。
- idle `setTimeout`：`idleTimer = setTimeout(guardCallback(() => { closeUpstreamWs(socket, "Idle timeout") }, (error) => { consola.warn(\`[upstream-ws] idle-timer callback threw (model=${opts.model}): ${toError(error).message}\`); markUnusable() }), idleTimeoutMs)`。
- `onOpen`/`onOpenError`：包裹为 `guardCallback(() => { ...原体... }, (error) => { cleanup(); reject(toError(error)) })`（onEscape 需能访问 `cleanup`/`reject`——它们在同一 Promise executor 作用域内）。
- connect `onAbort`（`:249`）：包裹，onEscape = `(error) => { signal.removeEventListener("abort", onAbort); reject(toError(error)) }`。
- sendRequest `onAbort`（`:285`）：包裹，onEscape = `onCallbackEscape`。

（保持所有 reason 串、warn 文案语义不变；不改 handler 逻辑本体，只加外层网。）

- [ ] **Step 4：运行，确认通过 + 全 WS 测试 + typecheck**

Run: `bun test tests/responses/upstream-ws-connection.unit.test.ts && bun run typecheck 2>&1 | tail -2`
Expected: PASS（含新测试 + 既有 21 个）；typecheck 绿。

- [ ] **Step 5：提交**

```bash
git add -- src/lib/openai/upstream-ws-connection.ts tests/responses/upstream-ws-connection.unit.test.ts
git commit -F- -- src/lib/openai/upstream-ws-connection.ts tests/responses/upstream-ws-connection.unit.test.ts <<'EOF'
fix(upstream-ws): guard all lifecycle callbacks against uncaughtException escape

Every addEventListener handler (handleMessage/handleError/handleClose/onOpen/
onOpenError/onAbort) and the idle setTimeout is now wrapped in guardCallback,
routing any unexpected throw to onEscape (warn + markUnusable + failRequest, or
reject for handshake) instead of letting it escalate to uncaughtException →
process.exit(1). Covers external opts.onClose throws and any handler-body throw.
EOF
```

---

## Task 1.3：子进程崩溃防护证明（faithful "无 uncaughtException / 不 exit"）

**Files:**
- Create: `tests/responses/upstream-ws-crash-safety.sub.test.ts`（子进程 harness）+ 一个被 spawn 的 fixture 脚本（inline 或 `tests/responses/fixtures/ws-crash-probe.ts`）
- 可选 Create: `exp/ws-callback-crash-safety/`（PoC + 结论，若 harness 需要独立脚本，按 `keep-poc-in-project`）

**Interfaces:**
- Consumes: 接线后的 `createUpstreamWsConnection`（Task 1.2）。

**方法：** spawn 一个 bun 子进程，装 `process.on("uncaughtException", () => process.exit(42))`（复刻 `main.ts` 语义），在其中构造一个会在 lifecycle 回调里抛出的场景（如 `onClose` 抛出，或注入让 handler 抛的 seam），驱动该回调。断言：
- **接线后**（guardCallback 生效）：子进程**不** exit(42)，正常 exit(0)（onEscape 吸收，无 uncaughtException）。
- **反证**（临时移除某处 guardCallback 或直接对未包裹的 EventTarget 抛）：子进程 exit(42)。反证在测试内用一个"裸抛监听器"子进程对照即可，不必真改源码。

- [ ] **Step 1：写子进程 harness 测试**

```ts
import { describe, expect, test } from "bun:test"

async function runProbe(mode: "guarded" | "raw-control"): Promise<number> {
  const proc = Bun.spawn(["bun", "tests/responses/fixtures/ws-crash-probe.ts", mode], {
    stdout: "pipe", stderr: "pipe",
  })
  return await proc.exited
}

describe("upstream-ws crash safety (subprocess)", () => {
  test("raw unguarded throwing EventTarget listener crashes (exit 42) — control", async () => {
    expect(await runProbe("raw-control")).toBe(42)
  })
  test("guarded upstream-ws lifecycle callback throw does NOT crash (exit 0)", async () => {
    expect(await runProbe("guarded")).toBe(0)
  })
})
```

- [ ] **Step 2：写 fixture 脚本** `tests/responses/fixtures/ws-crash-probe.ts`

```ts
// Spawned by upstream-ws-crash-safety.sub.test.ts. Installs main.ts's crash policy,
// then either (raw-control) throws from an unguarded listener → exit 42, or
// (guarded) drives a real upstream-ws lifecycle callback that throws (onClose)
// and relies on guardCallback → stays alive → exit 0.
process.on("uncaughtException", () => process.exit(42))
process.on("unhandledRejection", () => process.exit(42))

const mode = process.argv[2]

if (mode === "raw-control") {
  const t = new EventTarget()
  t.addEventListener("x", () => { throw new Error("control-boom") })
  t.dispatchEvent(new Event("x"))
  // uncaughtException fires async → exit(42) before this settles.
  setTimeout(() => process.exit(0), 100)
} else {
  const { createUpstreamWsConnection } = await import("~/lib/openai/upstream-ws-connection")
  // Minimal EventTarget fake socket; onClose throws to exercise the guarded handleClose.
  class FakeSocket extends EventTarget {
    readyState = 0; readonly OPEN = 1; readonly CONNECTING = 0
    send() {} close() { this.readyState = this.OPEN; this.dispatchEvent(new CloseEvent("close", { code: 1000, reason: "x" })) }
    open() { this.readyState = this.OPEN; this.dispatchEvent(new Event("open")) }
  }
  const socket = new FakeSocket()
  const conn = createUpstreamWsConnection({ headers: {}, model: "gpt-5.5", createSocket: () => socket as never, onClose: () => { throw new Error("onClose-boom") } })
  void conn.connect().catch(() => {})
  socket.open()
  socket.dispatchEvent(new CloseEvent("close", { code: 1000, reason: "x" }))
  // If guardCallback works, no uncaughtException → we exit 0 after a tick.
  setTimeout(() => process.exit(0), 100)
}
```
（`~/` 路径别名在子进程需 bun 的 tsconfig paths 解析——若 spawn 的 bun 不自动解析 `~`，改用相对 import 或 `bunfig`/`tsconfig` 已配置的解析；实现时先验证 `bun tests/responses/fixtures/ws-crash-probe.ts guarded` 能跑通再断言。）

- [ ] **Step 3：运行，确认对照 + 目标都符合**

Run: `bun test tests/responses/upstream-ws-crash-safety.sub.test.ts`
Expected: PASS —— raw-control exit 42（证 harness 能抓崩溃），guarded exit 0（证接线防住）。若 guarded 也 42，说明某回调未包裹，回到 Task 1.2 补。

- [ ] **Step 4：连跑确认确定性（时序子进程）**

Run: `for i in $(seq 1 10); do bun test tests/responses/upstream-ws-crash-safety.sub.test.ts 2>&1 | grep -E "pass|fail" | tail -1; done | sort | uniq -c`
Expected: 10× "0 fail"（`empirical-verification`：子进程/时序测试连跑确认无 flaky）。

- [ ] **Step 5：提交**

```bash
git add -- tests/responses/upstream-ws-crash-safety.sub.test.ts tests/responses/fixtures/ws-crash-probe.ts
git commit -m "test(upstream-ws): subprocess proof — guarded callbacks don't crash the process" -- tests/responses/upstream-ws-crash-safety.sub.test.ts tests/responses/fixtures/ws-crash-probe.ts
```

---

## Phase 1 DoD

- [ ] `guardCallback` 原语 + 单元测试（1.1）。
- [ ] 全部 lifecycle 回调 + idle timer 经 `guardCallback` 接线（1.2）。
- [ ] 子进程证明：guarded 回调抛出不崩（exit 0），对照裸抛崩（exit 42），10× 无 flaky（1.3）。
- [ ] `bun run typecheck` + `bun test tests/responses/ tests/transport/` 绿。
- [ ] 各 task 细粒度 pathspec 提交。

## 交给 Phase 2

崩溃防护完成后，上游-WS 路径的两层防御（Phase 0 源头 `closeUpstreamWs` + Phase 1 per-callback `guardCallback`）齐备。Phase 2 转向**下游**：给 Codex 注入 SSE 保活帧（帧型/间隔见 spec §4）。
