# Kick-off prompts — block 级缓冲重试

各阶段新会话/subagent 的开启指令。复制对应块给执行者。执行前先读 [`README.md`](README.md)（相位 DAG + 红线）+ 对应 `plan-N-*.md`。**顺序：P0 → P1（PoC 门）→ P2/P3/P4（可并行）**。

---

## P0 机制地基

```
读 docs/plan/2026-07-11-block-level-buffered-retry/README.md + plan-0-mechanism-floor.md + 权威 spec docs/spec/2026-07-11-block-level-buffered-retry.md。

用 superpowers:executing-plans（或 subagent-driven-development）逐任务实施 plan-0（3 Tasks：commitBoundaries 谓词 + driver 块级骨架行为中性 / telemetry partial-degrade + vendor 维度 / 共享配置键 + 迁移）。

铁律：P0 是纯新增、行为逐字不变（红线 R1）——commitBoundaries===undefined 必须逐字复现现整响应行为，默认全部仍关。每 Task TDD（先写失败测试→跑失败→最小实现→跑通过→显式 pathspec commit）。禁 mock 契约改动打爆 sibling（skill debugging-test-pollution）；新 module-global 单例登记 RESETTERS（skill test-isolation）。收尾跑 bun test tests/pipeline/ tests/observability/ tests/config/ 全绿 + bun run typecheck。P0 完成后 P1-P4 才能消费其接口契约。
```

---

## P1 Anthropic 块级（最硬，含 PoC 门）

```
读 README.md + plan-1-anthropic-block-level.md + spec §3.2/§3.3/§4/§5/§6.3/§9.3。依赖 P0 已 landed（commitBoundaries 骨架 + partial-degrade + resolveBufferedCaps）。

逐任务实施 plan-1（7 Tasks）。核心难点 = Task 2 sink 块栈（解 C1：单槽 openBlock 产不出块间 text_delta@0）+ Task 5 两段 PoC 门。

关键铁律：
- 红线 R3：Task 2 块栈 + 块间 text_delta@0 fallback 必须同一 commit（不留 C1 复发窗口）。
- 红线 R4：Task 6 默认翻 on 必须在 Task 5 两段 PoC 门 PASS 之后。
- Task 5 第二段「跑真实 Claude Code」须用户执行（no-auto-server）——agent 写探针 + 判据，停下等用户跑，按三分支结果（主/备/兜底）选 Task 6 的 anchor 接线。
- 不改算法核（decode/recover 的释放逻辑）——Task 4 是核实项，若测试红则停下核实、不改。
- Task 6 覆盖 req_484 golden fixture（单 tool_use block mid-block 截断 → 重试救回）。

收尾 bun test tests/messages/ tests/pipeline/ tests/codec/ 全绿 + typecheck。关 backlog:251-257（retreat bug）。
```

---

## P2 Responses HTTP

```
读 README.md + plan-2-responses-http.md + spec §3.1/§7.2/§9/§11。依赖 P0 已 landed。

逐任务实施 plan-2（7 Tasks）。要点：Responses codec 的 output_item.done 块级谓词 + via-chat-completions fallback 排除 buffered（buffered && !viaFallback，与 Gemini 同根因）+ keepalive M-2 实证门（exp/ 探针须用户执行）+ 默认翻 responses.buffered_retry true（R4 门后）。

关 backlog:308-314（Responses caps）。收尾 bun test tests/responses/ 全绿 + typecheck。
```

---

## P3 Chat Completions

```
读 README.md + plan-3-chat-completions.md + spec §3.1/§7.1/§9/§11。依赖 P0 已 landed。

逐任务实施 plan-3（4 Tasks）。CC 净新建终止-only buffered：接 driver buffered 分支、sawMessageStop=acc.finishReason!==""、[DONE] post-commit 追加、首块前 forced keepalive（backlog:316 CC 腿）+ M-2 实证门（exp/ 须用户执行）+ 默认翻 true（R4 门后、关 backlog:316 CC 腿）。

终止-only 下 partial-degrade 几乎不触发（预期）。收尾 bun test tests/chat-completions/ 全绿 + typecheck。
```

---

## P4 Responses-WS

```
读 README.md + plan-4-responses-ws.md + spec §7.3/§9。依赖 P0 + P2 已 landed（复用 Responses codec 谓词 + responses.buffered_retry 键）。

逐任务实施 plan-4（3 Tasks）。WS terminal-only：ws.ts 加选路（复用 responses 键不新造）+ close-code(1011)/commit/retreat 时序对齐（backlog:300-306 核心难点，三时序不变量）+ 默认随 responses 翻 true（R4 核 keepalive）。核实 WS 是否触 via-chat-completions fallback（若是则排除）。vendor 维度用 "responses_ws"（可区分）还是复用 "responses" 按 P0 landed 的 vendor 分桶定。

WS 测试须 Node ws server 夹具（Bun WS server 行为不忠实）。关 backlog:300-306。收尾 bun test tests/responses/ 全绿 + typecheck。
```

---

## 全阶段收尾（session-closeout）

```
P0-P4 全 landed 后：
1. 建 ADR docs/decisions/2026-07-11-block-level-buffered-retry.md（决策核 = 退役整响应 + 覆盖换体验，非「默认 on」表象）。
2. doc-sync：docs/DESIGN.md（流式写出行 + driver 例外 :57 + 配置表改名键/新默认 + :74-76「默认关」叙述）、docs/streaming.md、前身 RFC docs/archive/2606-landed-rfcs/streaming-upstream-rst-buffered-retry.md 加 superseded banner。
3. 新建 backlog 两条：Gemini buffered 结构不兼容排除（spec §7.4）、web_search no-search 直发暂未保护（spec §7.5，指向未来独立 spec）。
4. 派 subagent 审合并态（跨 phase 契约一致 + 集成接缝）。
5. 更新 README 状态表为「已实施」。
```
