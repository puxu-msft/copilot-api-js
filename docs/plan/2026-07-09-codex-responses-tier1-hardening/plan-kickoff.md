# Kickoff — 继续 Codex/Responses tier-1 硬化（Phase 1–5）

> 复制本文开启新会话，继续执行。前置：Phase 0 已完成并落在隔离分支。

## 当前状态（截至 Phase 0 完成）

- **分支/worktree**：`feat/codex-responses-tier1` @ `.worktrees/codex-responses-tier1`（从 master `8a19c33f` 分出）。
- **Spec（单一事实源）**：[../../spec/2026-07-09-codex-responses-tier1-hardening.md](../../spec/2026-07-09-codex-responses-tier1-hardening.md)（v2，经两轮对抗审查 + 亲手核验）。
- **Plan overview**：[README.md](./README.md)（Phase DAG、Global Constraints、commit invariants、各阶段 task 骨架）。
- **进度账本**：`.superpowers/sdd/progress.md`（gitignored scratch；恢复以此 + `git log` 为准，别重跑已完成 task）。
- **执行取向**：`superpowers:subagent-driven-development`——每 task：task-brief 文件 → implementer subagent（显式指定 model + 工作在 worktree）→ `scripts/review-package BASE HEAD` → task-reviewer subagent（spec + quality）→ 修复环 → 记账本 → 下一个。BASE 用你派 implementer 前记录的 commit，别用 `HEAD~1`。

## Phase 0 已完成 ✅（止血落地）

4 个提交 `540e109b..02c5f9ef`：抽 `closeUpstreamWs(socket, reason)`（1000 + 防御 try/catch），替换上游 6 处 `close(1001)`；§1.1 before-first-event fallback 黄金回归；L1 契约守卫（6 路径 StrictFakeSocket 断言 no-throw + code===1000）；下游服务端码固化（Bun 容忍 1011/1013/1001，comment-only）。**§1.1 实测事件已修**（close 1000 → 恢复 WS→HTTP 降级）。typecheck 绿、`tests/responses/` + history-ws 271 pass。

Minor roll-up（留最终 whole-branch review 裁定）：0.3 reason 串 pin；0.4 idle-timeout 30ms 真实计时器裕度（27/27 clean，fake-timers 为已记录回退）。

## 剩余 Phase 1–5（just-in-time 写详细 TDD plan 再执行）

各阶段目标/交付物/依赖见 [README.md](./README.md)「各阶段目标与交付物」+ spec R2–R6。要点复述：

1. **Phase 1 — 崩溃防护**（spec R2，依赖 Phase 0 `closeUpstreamWs`）：`crash-safety.ts` 新增 `guardCallback(fn, onEscape)`（EventTarget 同步回调 try/catch 工厂，**禁用** `withErrorSink`——在 WHATWG EventTarget 上是 no-op 虚假保护）；`upstream-ws-connection.ts` 每 `addEventListener` + 裸 `setTimeout` 包裹，`onEscape → markUnusable + failRequest + consola.warn`。fault-injection 测试（监听器抛出 + idle-timeout 定时器抛出两形状 → 进程不退出、请求 fail）。注意：Phase 0 的 0.4 已发现 idle-timeout close 在 setTimeout 内——正是此处崩溃向量的锚点。

2. **Phase 2 — 下游保活**（spec R3）：Responses SSE 保活帧 `event:<marker>\ndata:{"type":"response.<keepalive>"}`（合成标记，Codex 双重容忍见 spec §4）；间隔复用 `streamKeepalivePingSec`（20s），**不复用** `streamKeepaliveMode`（Anthropic 帧型）；复用 `makeSseSink` heartbeat hook；覆盖 header-前 + reasoning 静默两段；`ws.ts` 下游 WS 保活（应用帧 vs 协议 ping，形态 plan 定）。决策：R3.3 帧型/配置。

3. **Phase 3 — buffered 重试 + 截断 gate**（spec R4+R5.2，依赖 Phase 2）：Responses 采用 driver 的 `runResponseBufferedSink`（**只新增 caller，不改签名**；`sawMessageStop:()=>acc.status!==""`、`anchor:undefined`、Responses `protectStreaming*` 对等键）；**默认 live**（用户确认 mid-stream auto-retry 默认关、可配置启用）；buffering ⇒ 强制 Phase 2 保活；R5.2 截断在实际 `runResponseSink` 路径核验。Anthropic golden tripwire 保绿。

4. **Phase 4 — 上游保活 PoC + idle 余量**（spec R5.1+R5.3，可并行 2/3）：PoC 两问（undici WS upgrade socket 能否 TCP keepalive，`ss` 验；GHC 是否转发/容忍带外 WS 帧），PoC 入 `exp/ws-upstream-keepalive/` + 结论文档；预置"不可行则 R4 承重"；R5.3 独立核 `streamIdleTimeout` 相对最长 reasoning 静默余量（下游保活**不**重置上游 idle guard）。

5. **Phase 5 — 测试收口 + doc-sync**（spec R6）：L1 守卫补全、§1.1 黄金回归纳套件、Anthropic 爆炸半径 tripwire；`docs/DESIGN.md`「活的架构现状」更新 Responses 条目（close 码/保活/buffered 采用）；`driver.ts:114` 陈旧注释更正；未采纳/推迟项入 `docs/todo/deferred-backlog.md`（含 §7 条件性提取项：liveness 调度器共享化 gate 在 Phase 4 PoC、完整传输合流、Responses 专属 keepalive 键）。

## 收尾（全部 Phase 完成后）

- 最终 whole-branch review（`superpowers:requesting-code-review` 的 code-reviewer，most-capable model，`scripts/review-package $(git merge-base master HEAD) HEAD`），带上 Minor roll-up 列表裁定。
- `superpowers:finishing-a-development-branch` 合回 master（本项目行级共存、显式 pathspec）。
- 按 skill `session-closeout` 走完收尾（步数与内容以 skill 为准，勿在此冻结）。
- 待探究点动态捕获（用户约定）：过程中发现的扩展方向落 `docs/todo/deferred-backlog.md` + spec §8 追加 O 指针。
