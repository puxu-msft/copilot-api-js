# Phase 5 — 测试收口 + doc-sync + 最终审查 + 合并

> REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` + `session-closeout` + `superpowers:finishing-a-development-branch`。
> 隐含遵守 [README.md](./README.md) Global Constraints。**Spec**: R6 + skill `session-closeout`（步数与内容以 skill 为准）。

**Goal:** 全套件 + lint 绿、L1 守卫齐备、活文档与代码同步、未采纳/推迟项归档、最终 whole-branch 对抗审查通过，然后合回 master。

---

## Task 5.1：doc-sync（活文档同步 + 审查揪出的更正）

**Files:**
- Modify: `docs/DESIGN.md`（「活的架构现状」——Responses 路径全貌）
- Modify: `docs/spec/2026-07-09-codex-responses-tier1-hardening.md`（§5.1 no-ping 更正、§1.1 runtime-split）
- Modify: `src/lib/pipeline/driver.ts`（`:114` 陈旧注释"no consumer"）
- Modify: `src/lib/openai/upstream-ws-connection.ts`（`closeUpstreamWs` 注释 runtime-conditional 澄清）
- Modify: `docs/todo/deferred-backlog.md`（汇总 Phase 3/4 推迟项）

- [ ] **Step 1：DESIGN.md「活的架构现状」更新 Responses 路径**
记录本特性的现状：上游-WS 关闭码 1000（`closeUpstreamWs`）、per-callback `guardCallback` 崩溃防护、下游 SSE+WS 保活（`responsesKeepaliveFrame`，20s）、opt-in buffered 重试（`responsesBufferedRetry` 默认 OFF）+ 截断/streamError gate、上游保活现状（WS ping Bun-only/prevention-only、buffered 重试承重）、idle 余量（streamIdleTimeout 300s 上限）。

- [ ] **Step 2：spec 更正（审查揪出的 doc-integrity）**
- §5.1（R5.1）"undici WS 无 ping() 方法"→ 更正为 runtime-split：Bun 原生 WS **有** ping()（但 prevention-only、不重置 frame-idle guard、GHC 收益未证）；Node/real-undici 无 ping()。结论（buffered 重试承重）不变。
- §1.1 根因叙事：补 runtime-split 注解——`close(1001)` 抛 "invalid code" 只在 real-undici/Node 路径；Bun 原生 WS 容忍 1001。fix（close 1000）两 runtime 皆安全。事件实例跑在 real-undici 路径。

- [ ] **Step 3：driver.ts:114 + closeUpstreamWs 注释更正**
- `driver.ts:114` "Phase 1: no consumer — every handler still uses runResponseSink" → 陈旧（Anthropic + 现 Responses 均消费 buffered）。更正。
- `upstream-ws-connection.ts` `closeUpstreamWs` 注释（"undici throws invalid code for 1001"）→ 加 runtime-conditional 澄清（real-undici throws；Bun 容忍；1000 两者皆安全）。

- [ ] **Step 4：deferred-backlog 汇总**
确认这些条目在 `docs/todo/deferred-backlog.md`（含根因/当前行为/理想/为何暂缓/若做需改什么）：
- 下游-WS（`ws.ts`）buffered 采用（Phase 3 范围外）。
- Responses-专属 buffered caps（现复用 `protectStreaming*`）。
- chat-completions + Gemini SSE 无 heartbeat（Task 2.1 发现）。
- WS 上游保活（Bun-only ping，gated on 真 GHC A/B）（Task 4.1，应已在）。
- protect_streaming telemetry 跨端点归因（Task 3.2 Minor）。

- [ ] **Step 5：跨文档一致性 grep**
Run: `grep -rn "no ping\|无 ping\|has ping(): false\|no consumer\|Responses has none" docs/ src/ | grep -v deferred-backlog`
Expected：无残留的已被更正的陈述（或都已加 runtime/现状澄清）。

- [ ] **Step 6：提交**（分文档 pathspec 提交）

---

## Task 5.2：全套件 + lint 绿 + L1 守卫齐备

- [ ] **Step 1：全后端测试**
Run: `bun test 2>&1 | tail -5`
Expected：全绿（含 Anthropic tripwire、Responses、crash-safety、idle-margin、buffered）。修任何失败（`dont-ignore-existing-errors`）。

- [ ] **Step 2：lint:all（全量权威、无缓存）**
Run: `bun run lint:all 2>&1 | tail -10`
Expected：0 error（记忆 `eslint-cache-false-pass`：用 lint:all 全量）。修 error。

- [ ] **Step 3：typecheck（含 ui-v4 若涉及——本特性不涉前端，跳过 build:ui）**
Run: `bun run typecheck 2>&1 | tail -2`
Expected：绿。

- [ ] **Step 4：L1 守卫齐备核验**
确认关键 L1 存在性/契约守卫在位：close-code 守卫（0.4）、crash-safety 子进程证明（1.3）、keepalive 注入（2.1/2.2）、buffered 重试/exhaustion（3.2/3.3）、idle 独立性（4.2）。

---

## Task 5.3：最终 whole-branch 对抗审查

- 用 `superpowers:requesting-code-review` 的 code-reviewer 模板，**most-capable 模型**，`scripts/review-package $(git merge-base master HEAD) HEAD`。
- 显式裁判轴（长远正确 + 完整，非 ROI/YAGNI）；带上账本的 Minor roll-up 列表让其裁定 merge 前必修项。
- 对 CRITICAL/HIGH 派 fix subagent（一次性带全部 findings）；Minor 记录。

---

## Task 5.4：合并决策（用户 sign-off）

- 合回 master 是 outward-facing、并发会话敏感操作——**presentar给用户决策**（`finishing-a-development-branch` 的选项：merge / PR / 保留分支）。
- 合并方式：本项目行级共存、优先 rebase + FF 或显式 pathspec；隔离 worktree 避并发。
- 合并后：归档 plan（头部实施状态注解）、记忆库提炼（本特性的 runtime-split + joint-review 教训）、清理 `.superpowers/sdd/` scratch。

---

## Phase 5 DoD

- [ ] DESIGN.md「活的架构现状」含 Responses 全貌；spec §5.1/§1.1 更正；driver/closeUpstreamWs 注释更正；deferred-backlog 汇总；跨文档 grep 一致。
- [ ] `bun test` 全绿 + `bun run lint:all` 0 error + typecheck 绿。
- [ ] 最终 whole-branch review 通过（CRITICAL/HIGH 清零）。
- [ ] 用户 sign-off 合并决策。
- [ ] 收尾：plan 归档 + 记忆提炼 + scratch 清理。
