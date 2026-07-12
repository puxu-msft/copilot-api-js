# Phase 1：driver 三挂载点

> 依赖：Phase 0（`getUpstreamHook()` + `UpstreamHook` 类型）。产出：driver 在三个 phase 边界回调 hook。与 Phase 2（history 标记）耦合紧，建议同一执行者连做。
> **红线**：`hooks` 未配置（`getUpstreamHook()` === undefined）时 driver 输出**逐字节等价**——每个 Task 都以此为回归底线。

**Interfaces consumed**：`getUpstreamHook()`（Phase 0）；driver 内部函数 `runRequest`/`runExchange`/`runResponse`（[driver.ts:161/275/402](../../src/lib/pipeline/driver.ts#L161)）。

---

## Task 1.0：golden 字节等价 oracle 预捕获（改动前先锁 master 行为）

**Files:** Create `tests/pipeline/hooks/driver-passthrough-golden.it.test.ts`。

按 `large-refactor` skill 纪律——**在改 driver 前**用 master 代码对代表性输入捕获 driver 输出作 golden fixture，后续每 Task 重放比对，证「hook 未配置时字节等价」。

- [ ] **Step 1：写 golden 测试** — 用现有 driver 单测的 mock codec/transport（参考 `tests/pipeline/` 现有 driver 测试），跑一个流式请求经 `runRequest`+`runResponse`，把产出的 `ClientFrame[]` 序列化存为 golden。断言 `getUpstreamHook()===undefined` 时输出 === golden。
- [ ] **Step 2：跑绿**（此刻 driver 未改，golden === 自身，建立基线）。
- [ ] **Step 3：commit**。

## Task 1.1：`onRequest` 挂载点（一次性，retry 循环外）

**Files:** Modify `src/lib/pipeline/driver.ts`（[runRequest](../../src/lib/pipeline/driver.ts#L187) 行 187 后）；Test `tests/pipeline/hooks/driver-hookpoints.unit.test.ts`。

**插入点**（勘探 B.1，行 187 `runRewriteIn` 后、191 前）：

```ts
  const rewritten = runRewriteIn(deps, routed)

  // Hook point: onRequest — one-shot logical-request rewrite, OUTSIDE the retry loop
  // (a per-attempt replay would clobber reactive strategies' env fixes — spec §3.2 H1).
  const hook = getUpstreamHook()
  const afterHook = hook?.onRequest ? (hook.onRequest(rewritten) ?? rewritten) : rewritten

  const strategies = typeof deps.strategies === "function" ? deps.strategies(afterHook) : deps.strategies
  const { upstream, env: settled } = await runExchange(deps, afterHook, strategies)
```

- [ ] **Step 1：写失败测试** — 挂 `onRequest` 改 `env.body`（打标记字段），跑 `runRequest`，断言 exchange 收到改后 env；未挂时 body 不变（golden 等价）。挂 retry 场景（strategy 触发多 attempt），断言 onRequest 只调**一次**（评审 H1，用计数 hook）。
- [ ] **Step 2：跑确认失败** → **Step 3：插入代码** → **Step 4：跑绿 + golden 等价 + typecheck**。
- [ ] **Step 5：commit**。

## Task 1.2：`onExchange` 挂载点（核心，包裹 transport.send）

**Files:** Modify `src/lib/pipeline/driver.ts`（[runExchange](../../src/lib/pipeline/driver.ts#L310) 行 310）；Test 同上。

**包裹点**（勘探 B.2，行 310）：

```ts
    try {
      const hook = getUpstreamHook()
      const upstream = hook?.onExchange
        ? await hook.onExchange(wire, current, () => deps.transport.send(wire, current))
        : await deps.transport.send(wire, current)
      // ... 行 311+ 头捕获逻辑不变
```

- [ ] **Step 1：写失败测试** —
  - 挂 `onExchange` 不调 next、返回合成 `{frames, headers}` → driver 用合成流、`deps.transport.send` **未被调**（mock transport 计数）。
  - 挂 `onExchange` 调 next 后包裹返回流 → 真 transport 被调、返回流是包裹后的。
  - 挂抛 `HTTPError(…, 400, responseText)` 的 hook → driver catch 走 strategy 分支（reactive retry 腿）。
  - 未挂 → `deps.transport.send` 直调（golden 等价）。
- [ ] **Step 2：跑确认失败** → **Step 3：插入代码** → **Step 4：跑绿 + golden + typecheck**。
- [ ] **Step 5：commit**。

## Task 1.3：`rewriteUpstreamFrame` 挂载点（逐帧，采样后）

**Files:** Modify `src/lib/pipeline/driver.ts`（[runResponse](../../src/lib/pipeline/driver.ts#L446) 行 446-449 间）；Test 同上。

**插入点**（勘探 B.3，行 447 `onUpstreamFrame` 采样后、449 `passThrough` 前）——保证上游轨记 pre-hook 真实帧：

```ts
      if (frame.data !== "[DONE]") {
        upstreamSse.push({ ... })          // 行 440：上游轨记 PRE-hook 原始帧（不变）
        if (upstreamSse.length === 1) env.ctx.setSseEvents(upstreamSse)
        opts?.onUpstreamFrame?.(frame)     // 行 446：既有观察 sink（不变）
      }
      // Hook point: rewriteUpstreamFrame — per-frame rewrite AFTER upstream-original sampling,
      // so the upstream track keeps pre-hook real frames (spec §3.2/§3.4 H2). undefined → drop.
      const hook = getUpstreamHook()
      let effFrame: UpstreamFrame | undefined = frame
      if (hook?.rewriteUpstreamFrame && frame.data !== "[DONE]") {
        effFrame = hook.rewriteUpstreamFrame(frame, env)
        if (effFrame === undefined) continue  // dropped
      }
      for (const rewritten of passThrough([effFrame], rewrites, states, 0, sampleAction)) {
```

> 注：`hook` getter 每帧调开销极小（module-global 读）；未配置时 `hook===undefined` 直接跳过，`effFrame===frame`，`passThrough([frame], …)` 与原行 449 逐字节等价。

- [ ] **Step 1：写失败测试** —
  - 挂改写 hook（改 `frame.data`）→ forwarded 帧是改后的、**上游轨 `upstreamSse` 是 pre-hook 原始帧**（关键不变量，读 `env.ctx` 的 sseEvents 断言）。
  - 挂返回 `undefined` 的 hook → 该帧被丢弃（不出现在 forwarded）。
  - 未挂 → forwarded === 原始（golden 等价）。
- [ ] **Step 2：跑确认失败** → **Step 3：插入代码** → **Step 4：跑绿 + golden + typecheck**。
- [ ] **Step 5：commit**。

**Phase 1 出口验收**：三挂载点单测绿 + golden 字节等价（未配置零回归）+ `typecheck` + `typecheck:ui-v4` 绿。上游轨记 pre-hook 帧的不变量有测试守护。
