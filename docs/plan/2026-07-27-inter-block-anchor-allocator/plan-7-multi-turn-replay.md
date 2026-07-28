# P7 — 多轮空 anchor 历史回传

> **前置**：P0（核实部分可立刻起）；兜底实现部分依赖 P5（要有真 gap anchor 才能端到端测）。
> **承重项 8**（设计 §4.4 第 6 点 / 审查 F4）。

## 风险陈述（设计与审查的原话）

A 注入的空 text block 会进入 CC 的对话历史，下一轮原样发回上游；Anthropic 系上游对请求内空 text content block 有已知校验。现有全部真 CC 证据都是 `numTurns=1` **单轮**，多轮回传路径**从未走过**。若实测被拒，A 需提供「anchor 载体改为非空但不可见内容」或「入站清洗空 text block」的兜底——**两者属于 A 的必要范围，不是可选**。

## planner 复核：审查 F4 的一个事实断言为假

审查写「本仓库**没有**入站空 text block 清洗（`src/lib/anthropic/request-preparation.ts` 无相关处理，全仓 grep 未见）」。复核结论：**该断言为假**。

- `src/lib/anthropic/sanitize/content-blocks.ts:13` `filterEmptyAnthropicTextBlocks`——`block.text.trim() !== ""` 逐块过滤，正是该清洗。
- 接线链（逐跳核实过）：`sanitize/result.ts:53` 在 `finalizeAnthropicSanitization` 内**无条件**调用 → `sanitize/index.ts:81` `sanitizeAnthropicMessages` → `payload-rewrites.ts:117` 的 `sanitize-messages`（`appliesTo: () => true`，order 300）→ `ANTHROPIC_PAYLOAD_REWRITES` → `codec/anthropic/{codec,request-rewrite-adapter}.ts`。**生产 Anthropic 入站路径始终跑**。
- 被清空 content 的整条 message 有兜底：`sanitize/tool-blocks.ts:141/168` 的 `newContent.length === 0 → continue`。

**这不减小本相位范围**：风险方向（多轮回传从未实测）仍成立；只是补救成本很可能已为零。本相位因此从「实现兜底」重定位为「**核实既有清洗在 gap-anchor 回传形状下确实触达** + 真 CC 多轮实证」，并保留 FAIL 分叉下的兜底实现。

## Files

- Test（主体）: 新 `tests/anthropic/empty-anchor-replay-sanitize.it.test.ts`；新 `exp/inter-block-anchor-allocator/multi-turn-replay.ts`
- Modify（仅 FAIL 分叉）: `src/lib/anthropic/sanitize/content-blocks.ts` 或 anchor 载体

---

## Task 7.1：核实既有清洗触达 gap-anchor 回传形状

> `pass-null-clean-not-self-validating`：不能只跑一遍看它没报错，要**用正样本证明检查确实触达目标**。

- [ ] **Step 1: 写测试** —— 构造 CC 会实际回传的 assistant turn 形状

```ts
// tests/anthropic/empty-anchor-replay-sanitize.it.test.ts
test("an assistant turn carrying our empty gap-anchor text block is cleaned before going upstream", () => {
  // 构造 payload：assistant message，content = [text("real"), text(""), text("more")]
  //   —— 中间那个空 text block 就是我们注入的 gap anchor 被 CC 累积回传的形状
  const out = runAnthropicPayloadRewrites(payload, ctx)
  expect(contentTypesOf(out.payload)).toEqual(["text", "text"])   // 空块已被清掉
})
test("POSITIVE CONTROL: a non-empty text block is NOT removed", () => {
  // 证明上面的检查不是「全都删掉了」
})
test("an assistant turn that is ONLY an empty anchor block does not leave an empty message", () => {
  // content = [text("")] → 整条 message 应被丢弃（tool-blocks.ts 的 length===0 兜底）
  // 若这条红 → 是真缺口，进 Task 7.2 的兜底分叉
})
```

- [ ] **Step 2**：跑。**三条中任一红即进 7.2 分叉。**
- [ ] **Step 3**：核实**跨格式桥接腿**——`anthropic ↔ responses` 直接桥、`openai-cc` 反向重写等路径是否也过这个 sanitize。`rg -n "filterEmptyAnthropicTextBlocks|sanitizeAnthropicMessages" src/lib/codec/`。若某条腿绕过 → 记录为真缺口，进 7.2。
- [ ] **Step 4**：把核实结果（含每条腿的判定）写进本文件下方表。
- [ ] **提交** → `test(anthropic): verify empty gap-anchor blocks are sanitized on inbound replay`

## Task 7.2：FAIL 分叉的兜底（**仅当 7.1 或 7.3 红时执行**）

> 两条候选，**不预先选**——按 7.1/7.3 实测出的具体失败形状定：

- **兜底 α（清洗侧）**：补齐绕过 sanitize 的那条腿，或放宽 `filterEmptyAnthropicTextBlocks` 覆盖到未覆盖的位置。**优点**：治本，且对任何来源的空 text block 都生效。**α 可行则直接执行**，不必停。
- **兜底 β（载体侧）**：把 gap anchor 的载体从空 `text_delta` 换成「非空但客户端不可见」的内容。

> **⚠ β 是停下回报的分叉（plan review major 新增，原 plan 遗漏）**：β **不是实现细节**——它改变客户端可见协议与最终文本：会改 O-4 的 SDK 累积结果、客户端渲染、写进用户对话历史的内容，以及**冻结设计所选的 carrier 形状本身**。让 executor 自行选 β 等于把产品/协议裁决交给实现者。
>
> **纪律**：若实测证明 α 不可行、必须转 β，**停下回主会话/用户裁决**，并在获批后补一套独立的客户端矩阵（零宽字符在真 CC / 真 SDK / History UI 三处的可见性与累积行为）再冻结载体。**不得**自行改载体后继续。

- [ ] **Step 1**：按实测失败形状判定 α 还是 β。α → 继续；**β → 停，回报**。
- [ ] **Step 2**（α）：TDD 实现。
- [ ] **Step 3**：7.1 / 7.3 转绿。
- [ ] **提交** → `fix(anthropic): <α 的具体描述>`

## Task 7.3：真 CC 多轮回传（O-7 —— **已按 plan review major 重写**）

> **依赖 P5**（要有真 gap anchor 才有东西回传）。
>
> **原方案会假绿**：它只断言 `numTurns >= 2`，而本仓库**已把 `num_turns > 1` 当作 stall 的可观测签名**（`tests/e2e-client/anthropic-cli.e2e.test.ts:50` "empty-string end_turn STALLS the agent loop (num_turns>1, result empty)"）。即同一个值既可能表示「按设计的工具第二轮」，也可能表示「agent 空转重问」——**它无法区分成功与失败**。
>
> **另一个范围限定**：本 oracle 用 upstream hook，故它能独立证明的是「真 CC 怎样回传 + 我方送出的第二轮请求体长什么样」，**不是**「真 GHC 是否接受」。后者只能由「生产 sanitize 后的请求体」oracle 或靶向真上游补证——本 task 覆盖前者，后者列入 backlog（P8.6）。

- [ ] **Step 1**：写 `exp/inter-block-anchor-allocator/multi-turn-replay.ts`——**确定性 tool-use mock**：
  - 非 4141 端口起测试服务器（`spawn-proxy` + `drive-claude-cli` harness）；
  - upstream hook 第一轮：产「真实块 → 过 escalate deadline 的静默（触发 gap anchor）→ **唯一一个 `tool_use` 块**（固定 id）」；
  - hook 第二轮：收到 tool_result 后产一个含 marker 的终局响应；
  - hook **落盘每一轮的上游请求体**并**计数命中次数**。
- [ ] **Step 2**：断言（**四条缺一不可**）——
  1. **CC 确实执行了工具**，且第二轮回传的 `tool_result` 的 `tool_use_id` **精确等于**第一轮那个 id；
  2. **上游命中次数恰为 2**（排除 stall 重问 / 第三轮）；
  3. 第二轮落盘的请求体中：既有正确的 `tool_result`，**又不含任何空 text content block**；
  4. 最终 `result` 含 marker 且非空，`isError: false`。
- [ ] **Step 3**：**mutation**——故意让 mock 按 Anthropic 真实校验规则拒绝空 text block（返回 400），并临时绕过 sanitize，确认本测试**转红**。这证明它能咬住空块泄漏，而不是「反正都过」。
- [ ] **Step 4**：**连跑 >= 3 次**证确定性。
- [ ] **Step 5**：结果写进 `exp/inter-block-anchor-allocator/FINDINGS.md`。FAIL → 进 7.2（β 需停下回报）。
- [ ] **提交** → `exp(anchor): deterministic tool-use multi-turn replay oracle for empty gap anchors`

## Task 7.4：History 侧的可辨识性

> ADR `richest-data-flow`：注入真实流的合成帧必打可辨识标记。gap anchor 的三个帧（start/delta/stop）进 forwarded 轨时的标记必须正确，否则运维无法区分「模型真的产了个空块」与「我们注入的」。

- [ ] **Step 1: 写测试**：驱动一次 gap anchor 场景，断言 History `clientResponse.sseEvents` 中三个 anchor 帧分别带 `synthetic:"anchor"` / `"keepalive"` / `"anchor"`，且**上游原始轨完全不含**这三帧。
- [ ] **Step 2**：跑；红则修（P5 的 gap injector 若用了 `sink.write` 而非 `writeAnchor`/`writeKeepalive` 就会红）。
- [ ] **提交** → `test(history): gap anchor frames are marked synthetic and absent from the upstream track`

## 核实结果（实施期填写）

| 路径 | 是否过 `filterEmptyAnthropicTextBlocks` | 判定 |
|---|---|---|
| Anthropic messages 直连 | _待填_ | |
| anthropic → responses 桥 | _待填_ | |
| openai-cc 反向重写 | _待填_ | |
| 真 CC 第二轮实测 | _待填_ | |

## P7 收口

- [ ] 7.1 三条全绿（或 7.2 已闭合；**若走 β 则须已获用户批准**）。
- [ ] O-7 连跑 3 次全 PASS，每次都满足**四条断言**（tool_id 精确匹配 / 上游命中恰为 2 / 第二轮无空 text block / marker 非空）。**不得**以 `numTurns >= 2` 单独作为通过判据。
- [ ] O-7 的 400-mutation 验证过该测试能咬住空块泄漏。
- [ ] FINDINGS 已记录，并注明本 oracle 的**范围限定**：证明的是「CC 如何回传 + 我方送出什么」，非「真 GHC 是否接受」（后者列 backlog）。
