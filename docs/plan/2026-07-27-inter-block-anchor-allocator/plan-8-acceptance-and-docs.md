# P8 — 端到端验收与文档后果

> **前置**：P4、P5、P7。**产出**：三层 oracle 全绿 + ADR/记账 SSOT 的文档修订 + backlog 登记。

## Task 8.1：O-4 真 `@anthropic-ai/sdk` 累积顺序

> 这是**发现原 blocker 的手法**（重复 index probe 发现 `real@0 → anchor@0 → real@1` 被真 SDK 累积成 `first, second, empty-anchor`——anchor 被重排到末尾）。同一手法现在用作验收。

- [ ] **Step 1: 写测试**（`tests/e2e-client/anthropic-sdk.it.test.ts` 同款 in-process 真 proxy + 真 SDK + `setUpstreamFetchForTests`）

```ts
test("the SDK accumulates gap-anchor blocks IN WIRE ORDER, never reordered to the end", async () => {
  // 上游脚本：真实块 → 过 escalate deadline 的静默 → 真实块
  const msg = await client.messages.stream({...}).finalMessage()
  // 断言 content 的顺序与 wire index 顺序一致：
  //   content[0] = 第一个真实块的文本
  //   content[1] = 空 text（我们的 gap anchor）  ← 关键：它在中间，不在末尾
  //   content[2] = 第二个真实块的文本
  expect(msg.content.map(b => b.type === "text" ? b.text : b.type)).toEqual(["<first>", "", "<second>"])
})
test("POSITIVE CONTROL: a deliberately duplicated index DOES get reordered by the SDK", async () => {
  // 注入一个复用 index 0 的上游脚本，断言 SDK 输出确实变成 [first, second, ""]
  // ——证明这条 oracle 能咬住原 blocker 的故障形状，不是「反正都过」
})
```

- [ ] **Step 2**：跑，主测试绿 + 正样本对照证明其有裁决力。
- [ ] **提交** → `test(e2e-client): SDK accumulates gap anchors in wire order (real @anthropic-ai/sdk oracle)`

## Task 8.2：O-5 真 CC inter-block >300s

- [ ] **Step 1**：写 `exp/inter-block-anchor-allocator/idle-inter-block.ts` + `inter-block-hook.ts`——
  - hook 产：`message_start` → 真实块（含可识别 marker A）→ **>310s 静默** → 真实块（marker B）→ 终止；
  - 关键：静默**发生在两个真实块之间**（首块已 `content_block_stop`），这正是 C 失守、A 要覆盖的窗口；
  - config：`protect_streaming_generation: on`（块级 buffered，本改造的目标制度）+ `stream_keepalive_escalate_sec: 200`；
  - 非 4141 端口，按 PID 精确清理。
- [ ] **Step 2**：驱动真 `claude -p`，断言 `numTurns === 1` / `isError: false` / result 含 marker A **和** B / result **不含**保活痕迹。
- [ ] **Step 3**：**连跑 >= 3 次**证确定性（G2 当年的 302s stall 就是单跑一次得出的，后来被证根因在别处——时序结论必须多跑）。
- [ ] **Step 4**：对照组——把 `stream_keepalive_escalate_sec` 设 0（禁升级）再跑一次，**应当 FAIL**（~300s stall）。这条对照证明「PASS 是 gap anchor 挣来的，不是这次上游恰好快」。
- [ ] **Step 5**：结果 + 两组对照写进 `exp/inter-block-anchor-allocator/FINDINGS.md`。
- [ ] **提交** → `exp(anchor): real Claude Code >300s inter-block verdict with a no-escalation control arm`

## Task 8.3：O-6 字节等价复跑

- [ ] **Step 1**：跑 P0.1 的 `byte-equivalence.sh`，与基线对照。
- [ ] **Step 2**：**必须逐字节相同**。若不同——不是「可接受的小变化」，是 C3 结构性短路失效的信号，回 P1.4 查。
- [ ] **Step 3**：结果记入 FINDINGS。
- [ ] **提交** → `exp(anchor): confirm short-request byte equivalence after the full frontier migration`

## Task 8.4：ADR D2 第 3 点措辞修订（承重项 7）

> 原文约束的是**真实块**的 commit 顺序（"若 index=2 尚未闭合，则 index=3 虽已闭合也压住不发"）。A 把 synthetic anchor 也放进同一条 wire index 序列，等于把不变量的论域从「真实块」扩到「真实块 + 合成块，由单一 frontier 分配」。这是**兼容的加强**，不是冲突——但措辞必须同步，否则未来实现者读 D2 会以为 synthetic 帧不在该序列内（第二轮 GPT 审的 blocker 分析里已出现过这一误读）。

- [ ] **Step 1**：改 `docs/decisions/2026-07-22-continuation-retry-sequential-anchor.md` D2 第 3 点：
  - 论域扩为「**真实块 + 合成 anchor 块由单一 generation-scoped frontier 严格顺序分配**」；
  - 补一句「wire index 的唯一权威是 `AnchorIndexAllocator`；任何独立偏移量（历史上的 `anchorShift` / `continuationOffset`）已作废」；
  - D2 修订记录追加本次变更 + 日期 + 指向本 plan。
- [ ] **Step 2**：D2 第 2 点「当前按需升级只覆盖 pre-content ... >300s 完整覆盖等待方案 A」改为「已由方案 A 覆盖（本 plan）」，并把「后果」小节里「首块提交后的 >300s 客户端无-open窗口仍会断流，解除条件是方案 A 落地」标为**已解除**。
- [ ] **Step 3**：**ADR 改动需用户同意**（项目纪律：ADR 记录用户决策，改它要用户明确同意）。本 task 产出**改动草案**，交主会话呈用户拍板后再落。
- [ ] **提交** → `docs(adr): extend D2 sequential-index invariant to synthetic blocks under a single frontier`

## Task 8.5：Q5 公式作废（承重项 7）

- [ ] **Step 1**：`docs/plan/2026-07-22-max-tokens-continuation/plan-Q5-three-way-overlap.md` 追加 **round-3 修订记录**：
  - 明确作废 `wireIndex(i) = i + anchorShift + continuationOffset`；
  - 说明原因：A 之下 `anchorShift` 不再是 {0,1} 的二值量（多 anchor 时任意大），且 `continuationOffset` 已被 frontier 取代——**两个独立偏移不能继续叠加**；
  - 给替代记账表述：「wire index 由 generation-scoped `AnchorIndexAllocator` 单调分配；任一块（真实/anchor/continuation）的 wire index = 其 `allocate*` 调用时的 frontier 值。不存在可用公式从上游 index 推导 wire index——必须查 allocator 的记录。」
  - 该文件的时序图/示例序列相应更新（`anchor@0 → real@1 → continuation@2` 这类举例仍成立，但推导路径改为 frontier）。
- [ ] **Step 2**：跨文档 grep 验证无残留：`rg -n "anchorShift|i \+ 1 \+ continuationOffset" docs/ src/`。
- [ ] **Step 3**：同步核查其它引用该公式的文档（`docs/spec/2026-07-22-max-tokens-continuation.md`、`docs/memory/` 相关条目）。
- [ ] **提交** → `docs(plan): retire the additive wireIndex formula; the allocator frontier is the sole authority`

## Task 8.6：backlog / DESIGN / 记忆同步

- [ ] **Step 1**：`docs/todo/deferred-backlog.md`——
  - 关闭「>300s inter-block 保活」条目（若存在），注明由本 plan 闭合；
  - **新增** J（长 text 块 idle 分块）条目：根因 / 当前行为 / 理想架构 / 为何暂缓 / 若做需改什么 / 解除条件。它是 A 落地后的下游收益（把已缓冲文本先 commit 为完整真实块，客户端拿到**真内容**而非空 anchor），依赖本 plan 的 allocator。
  - **新增** B 的复活条件条目（`record-not-adopted`）：若 CC 改为非 eager tool 执行，或需要给 text/thinking 更干净的载体，方案 B（延迟 stop）值得重估。
- [ ] **Step 2**：`docs/DESIGN.md`「活的架构现状」——更新 keepalive 行：正常 cadence 裸 ping、逼近 `stream_keepalive_escalate_sec` 时按需升级、**升级覆盖 pre-content 与 inter-block 两类窗口**、wire index 由 generation frontier 统一分配。
- [ ] **Step 3**：`docs/todo/2026-07-22-client-proxy-keepalive-300s.md`——标为已闭合，指向本 plan 与 FINDINGS。
- [ ] **Step 4**：`docs/spec/2026-07-27-inter-block-keepalive-carrier.md` 头部加实施状态注解（方案 A 已落地 + commit）。
- [ ] **Step 5**：记忆库——更新 `docs/memory/MEMORY.md` 相关 stub；提炼本次教训（至少两条候选：① 「同名方法在两条 sink 实现上语义分歧，测试装在宽松那条 → 生产缺陷测不到」；② 「审查报告的 absence 断言（『全仓 grep 未见』）必须亲自复核」——后者是 `verifying-authoritative-claims` 的又一实例）。
- [ ] **提交** → `docs: sync live docs and backlog after the frontier allocator landed`

## Task 8.7：合并态审查

- [ ] **Step 1**：派**异模型** reviewer 做 merged-state review（本计划是 Claude 驱动 planner 写的 → 用 `gpt-souls:reviewer`）。prompt 必须显式写裁判轴：**长远正确 + 完整**（非 ROI/YAGNI），架构健康 > 回归风险。
- [ ] **Step 2**：重点交待给 reviewer 的检查面——
  - 三处 remap 是否真的全走单一权威（架构守卫是否可绕过）；
  - C3 结构性短路在**每一条**格式路径上都成立吗（Anthropic 之外的 vendor 走 allocator 时 `anchorsOpened()===0` 是否恒真）；
  - P6 的 freeze/close 裁决是否在**所有**终局路径上正确（`closeAnchorIfOpen` / driver 终端 / pump 的多个终端分支）；
  - `AnchorState` 字段语义变更后，是否有站点仍按旧语义读（`anchorBlockOpen` 的残留）；
  - 跨 phase 集成缝：P4 的 leg 语义 × P5 的 gap anchor（续写腿里发生 gap 静默会怎样？——**这个组合本计划没有专门 task，是 reviewer 应重点挑的缺口，也是 planner 主动登记的已知薄弱面**）。
- [ ] **Step 3**：吸收其客观事实，对其判断谨慎取舍；其「无消费者/可安全删/已通过」类绝对断言**亲自对照代码复核**（本 plan 的 P7 就是一例反面教材）。
- [ ] **Step 4**：未采纳的建议逐条记录理由（`record-not-adopted`）。

## Task 8.8：全量收口

- [ ] `bun run typecheck` + `bun run lint:all`（**不带 cache**）绿。
- [ ] `bun run test:backend` 绿（不是 `test:fast`——交付前必须全后端）。
- [ ] O-1 ~ O-8 八条 oracle 逐条记录结果。
- [ ] 归档：本 plan 目录各文件头部加实施状态注解 + commit hash。

## 验收记录（实施期填写）

| oracle | 结果 | 证据位置 |
|---|---|---|
| O-1 单调无复用 | _待填_ | |
| O-2 maxOpen===1 | _待填_ | |
| O-3 real@0→anchor@1→real@2 | _待填_ | |
| O-4 真 SDK 顺序 | _待填_ | |
| O-5 真 CC >300s（含对照组） | _待填_ | |
| O-6 字节等价 SHA | _待填_ | |
| O-7 真 CC numTurns>=2 | _待填_ | |
| O-8 心跳跨 commit 存活 | _待填_ | |
