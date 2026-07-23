# Plan-3: Anthropic 续写（治 incident）

> **依赖:** P0/P1/P2 + 门 G3（tool_use 前缀是否被上游接受，决定覆盖范围）。
> **目标:** 治 incident req_162——首块 text 已 commit、tool_use 中途 CANCEL → 续写救回。

**Files:**
- Create: `src/lib/codec/anthropic/continuation-builder.ts`（注册进 P0 registry）
- Test: `tests/anthropic/continuation-anthropic.it.test.ts` + `tests/e2e-client/continuation-anthropic.it.test.ts`（SDK oracle）

**Interfaces:**
- Consumes: `registerContinuationBuilder`（P0）、`CanonicalBlock`（P0）
- Produces: 注册 `"anthropic"` builder

---

### Task 3.1: Anthropic continuation-builder

- [ ] **Step 1: 写失败测试** —— 组装 `[原始 messages, {assistant: 已commit块}, {user: message}]`

```ts
// tests/anthropic/continuation-anthropic.it.test.ts
test("anthropic builder appends assistant(committed blocks) + synthetic user turn", () => {
  const orig = { messages: [{ role: "user", content: "write plan" }], model: "claude-opus-4.8", max_tokens: 4096 }
  const committed = [{ type: "text", text: "Now the plan." }]
  const req = buildAnthropicContinuation(orig, committed, "network issue. please continue")
  expect(req.messages).toEqual([
    { role: "user", content: "write plan" },
    { role: "assistant", content: [{ type: "text", text: "Now the plan." }] },
    { role: "user", content: "network issue. please continue" },
  ])
  // 原始 messages 逐字不变（cache 友好）；max_tokens/model 保留
})
test("tool_use committed block reconstructs to assistant tool_use content (G3-gated coverage)", () => { /* ... */ })
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 实现 + 注册** —— canonical 块 → Anthropic content 块;`registerContinuationBuilder("anthropic", buildAnthropicContinuation)`。**G3 分支:** G3 PASS → 支持 tool_use 前缀;G3 FAIL → committed 含末尾 tool_use 时该次不续写（builder 返回 undefined 信号 → driver partial-degrade），incident 场景（committed 只 text）不受影响。
- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `feat(anthropic): continuation-request builder`。

### Task 3.2: 缝合流 SDK oracle（客户端 wire 正确性）

- [ ] **Step 1: 写失败测试（SDK oracle，不自洽）** —— 真 `@anthropic-ai/sdk` 消费「已发块 + 续写块重编号」缝合流

```ts
// tests/e2e-client/continuation-anthropic.it.test.ts（仿 anthropic-buffered.it.test.ts）
test("SDK .finalMessage() assembles committed prefix + continuation blocks as one coherent message, no dup", async () => {
  // mock 上游：attempt1 = text 块@1 commit + tool_use@2 partial + RST
  //             attempt2(续写) = tool_use 块（重编号 index 接续）+ message_stop
  // 真 SDK 消费缝合流 → finalMessage content = [text, tool_use]，无重复 text，无协议破坏
})
```

- [ ] **Step 2: 跑，失败。**
- [ ] **Step 3: 接线** handler-v4 Anthropic 路径:续写块经 P1 分配器接续 index 写同一 sink;确认 message_start 只发一次（前 spec §10.10「exactly-one message_start」跨续写腿）。
- [ ] **Step 4: 跑，通过。**
- [ ] **Step 5: 提交** → `test(e2e): SDK oracle for anthropic continuation stitched stream`。

### Task 3.3: incident 复现 e2e（mock 上游）

- [ ] **Step 1: 写测试** —— 复现 req_162 形状:142.9s-类静默(顺序 anchor 保活) → text 块 → tool_use mid-RST → 续写 → 完整
- [ ] **Step 2-4:** mock 上游 hook（`upstream-hook-mocking`，四点契约）造该序列;起非-4141 proxy;断言最终客户端拿到完整 text + tool_use（incident 的 0-产出变完整）。
- [ ] **Step 5: 提交** → `test(e2e): incident req_162 shape recovered by continuation`。

### P3 收口

- [ ] `test:backend` 绿;incident 复现 e2e PASS = **主目标达成证据**。
- [ ] 连跑 10-25 次证时序确定性（续写触发依赖 mid-stream 掐断时序，FakeClock + ReadableStream controller）。
