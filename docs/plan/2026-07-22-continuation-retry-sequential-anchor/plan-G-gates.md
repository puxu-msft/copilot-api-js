# Plan-G: PoC 门簇（gate-first，先跑定可行性）

> 门先于承重实现。每门产出决定后续相位的实现分支。门用 `exp/` 探针 + mock 上游 + 真客户端 oracle，**不烧生产额度**（便宜模型 + 小 max_tokens + hook-mock 上游）。裁决 = 实测 > 文档 > 声称（skill `empirical-verification`）。

**Files（门产出物，keep-poc-in-project，force-add 到 git）:**
- Create: `exp/block-level-anchor-sequential/produce-oracle.ts`（G1）
- Create: `exp/block-level-anchor-sequential/idle-300s.ts`（G2，扩现有 run.ts）
- Create: `exp/continuation-shape/{anthropic-tooluse-prefix,cc-serial,cc-trailing,responses-prior-output}.ts`（G3/G4/G5）
- Create: `exp/continuation-shape/FINDINGS.md`（结论汇总）

---

## Gate G1: 顺序 anchor 代理产出侧（wire 抓包 oracle）

**Why:** spec §3.3 —— 现有 PoC（`hook.ts`）是手写裸帧，只证「CLI 接受 wire」，**未证「代理能产出 0/2/4… 穿插 anchor 的 wire」**。这是 P1 index 分配重写的产出侧验证的**下限探针**（先证目标形状能被产出，再谈实现）。

- [ ] **Step 1: 写 wire 抓包 oracle**

用生产 `makeAnchoredSseSink`（`handler-v4.ts`）+ 独立数组 sink（假 `SSEStreamingApi`，仿 `exp/block-level-anchor-coexist/oracle-wire.ts`），驱动一条「pre-content anchor open→delta→close → 真实块@1 → gap anchor open→delta→close → 真实块@3」的合成序列，抓 wire 逐帧断言 index 序列 = `[start@0, delta@0, stop@0, start@1, …, stop@1, start@2, delta@2, stop@2, start@3, …, stop@3]`，且**任一时刻至多一块 open**（维护 openSet，每帧后断言 `|openSet| ≤ 1`）。

```ts
// exp/block-level-anchor-sequential/produce-oracle.ts (骨架)
import { makeAnchoredSseSink } from "~/routes/messages/..." // 精确路径 P1 时确认
const written: Array<{event:string; index?:number}> = []
const fakeStream = { writeSSE: async (m) => { written.push(parse(m)) } }
// ... 驱动 sink 走顺序策略，喂 block_start@real/gap/close 序列 ...
// 断言：index 单调、单块 open 不变量、gap 处发的是 text_delta 非裸 ping
```

- [ ] **Step 2: 跑，记录当前实现能否产出**

Run: `bun run exp/block-level-anchor-sequential/produce-oracle.ts`
Expected（门前）：**FAIL 或不适用**——现 sink 是 coexist 单槽/块栈，产不出顺序序列。这是**预期的红**，证明 P1 需要真实现（非「已存在」）。记录当前 index 行为作对照。

- [ ] **Step 3: 门结论写入 FINDINGS**

在 `exp/block-level-anchor-sequential/FINDINGS.md` 追加「G1: 现实现产出形状 = X;顺序形状需 P1 index 分配重写」。**产出：P1 的红-绿基线**（P1 完成后此 oracle 转绿 = 代理产出侧验收）。

---

## Gate G2: 顺序 anchor 300s 死线重置（>300s 长-idle 真 CLI）

**Why:** spec §3.4 承重因果链 —— 门 FAIL → Anthropic 回退 live → 续写不触发 → incident 无解。必须实证空 `text_delta` 每 ~15s 重置 CC 300s no-real-content 死线。

- [ ] **Step 1: 扩 hook 加长-idle gap**

复制 `exp/block-level-anchor-sequential/hook.ts` → `idle-hook.ts`，在两真实块间插入 >300s 静默（gen 里 `await sleep`），期间每 15s 发一个 `content_block_delta@gapIndex text_delta ""`（顺序 anchor gap 保活）。

- [ ] **Step 2: 起 proxy + 真 claude，观测是否断连**

Run: `bun run exp/block-level-anchor-sequential/idle-300s.ts`（起非 4141 proxy + `driveClaudeCli`，timeout > 320s）
Expected: **PASS** = numTurns=1、两块保全、无 no-real-content 断连（对比 `exp/cc-idle-280s`：裸 ping 会断）。

- [ ] **Step 3: 结论 + 分支决策**

FINDINGS 记 G2 verdict。**PASS → P1 顺序 anchor 采用、Anthropic 默认 on 可达;FAIL → 升级问题**：顺序 anchor gap 保活不重置死线 → 须换保活载体（如 gap 也用真实块级 text 而非空 delta），或 Anthropic 长静默场景回退 live 且 incident 目标须与用户重议（spec §3.4）。

---

## Gate G3: Anthropic 已-commit-完整-tool_use-块作前缀

**Why:** spec §4.3/§10 —— 现有 PoC 前缀是纯文本，未验证「assistant 以完整 tool_use 块结尾 + 后接 user（非 tool_result）」是否被上游接受。

- [ ] **Step 1: 构造带完整 tool_use 前缀的续写请求**

```ts
// exp/continuation-shape/anthropic-tooluse-prefix.ts
const body = {
  model: "claude-haiku-4.5", max_tokens: 128, stream: false,
  tools: [{ name: "get_x", description: "...", input_schema: {...} }],
  messages: [
    { role: "user", content: "..." },
    { role: "assistant", content: [
      { type: "text", text: "First I check A." },
      { type: "tool_use", id: "toolu_x", name: "get_x", input: { a: 1 } }, // 完整 tool_use 作前缀结尾
    ]},
    { role: "user", content: "network issue. please continue" },
  ],
}
// POST 到 4141 /v1/messages（只读探针，不 spawn），看是否 400
```

- [ ] **Step 2: 跑，看上游是否接受**

Run: `bun run exp/continuation-shape/anthropic-tooluse-prefix.ts`
Expected: 记录 —— PASS（接受、正常续写）或 400（拒绝 tool_use 前缀 + user）。

- [ ] **Step 3: 分支**

PASS → Anthropic 续写覆盖「已 commit tool_use 块」场景;FAIL → Anthropic 续写限「committed 只含 text/末块非 tool_use」场景（incident 属此，仍达成主目标），多 tool_use 链非首个截断回退 partial-degrade。FINDINGS 记结论。

---

## Gate G4: CC index 串行性（先验风险偏高）

**Why:** spec §7/§9 —— `stream-accumulator.ts:114-131` 用 index-keyed Map 容忍乱序，说明串行非纯假设。CC 块边界重建（P5）依赖串行。

- [ ] **Step 1: 造真实并行 tool_call 的 CC 流**

发一个促使**多个并行工具调用**的 CC 请求（`/chat/completions` stream:true，`gpt-5.4-mini`，prompt 要求同时调 2 个工具），**逐 chunk dump** `choices[0].delta.tool_calls[].index` 序列。

- [ ] **Step 2: 判串行 vs 交错**

Run: `bun run exp/continuation-shape/cc-serial.ts`
Expected: 记录 index 到达序列。**串行** = index 0 的所有 argument delta 连续、再 index 1;**交错** = 0/1 delta 混插。

- [ ] **Step 3: 分支**

串行 → P5 用「index 跳变 = 前块完成」边界判据;交错 → P5 边界判据须换（如只在 finish_reason 前的完整 JSON 边界，或退回 CC terminal-only）。FINDINGS 记 verdict + 样本序列。

---

## Gate G5: CC tool_calls 尾随约束 + Responses prior-output 续写

**Why:** spec §4.3/§7 —— CC 续写在「已 commit 完整 tool_call + 后续被截」窄场景撞 OpenAI 尾随约束;Responses 续写形状未验证。

- [ ] **Step 1: CC 尾随约束探针**

`/chat/completions` 非流式，messages 含 `assistant{tool_calls:[完整]}` + 直接接 `user`（无 tool role），看上游是否 400。

- [ ] **Step 2: Responses prior-output 续写探针**

`/v1/responses`（或 `/responses`）请求，`input` 含已 `done` 的 output_item + 合成 user follow-up，看 GHC Responses 是否接受续写。

- [ ] **Step 3: 跑 + 分支**

Run: `bun run exp/continuation-shape/{cc-trailing,responses-prior-output}.ts`
Expected 记录:CC 尾随窄场景 PASS/FAIL（FAIL→该窄子集 partial-degrade）;Responses 续写 PASS/FAIL（FAIL→Responses 续写回退 partial-degrade，HTTP/WS 共此结论）。FINDINGS 汇总五门 verdict 表。

---

## 门簇收口

- [ ] **汇总:** `exp/continuation-shape/FINDINGS.md` 五门 verdict 表（PASS/FAIL + 样本 + 对后续相位的分支决策）。
- [ ] **提交:** `git add -f -- exp/continuation-shape/ exp/block-level-anchor-sequential/produce-oracle.ts exp/block-level-anchor-sequential/idle-*.ts` + `git commit -F <msg> -- <精确路径>`。
- [ ] **门 → 相位映射回填 README DAG**（哪些门 FAIL 触发哪条 fallback，写进对应 plan-N 头部）。
