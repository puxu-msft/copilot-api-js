# 交接：block 级缓冲重试 —— 收尾阶段（仅剩用户实证门 + 门后落地）

**给用户 / 下一个会话的收尾指令。** 机制已全部落地并通过评审；剩余全部 gated 在用户执行的实证门。

## 现状快照（2026-07-13）

- **P0-P4 机制全部 landed + 独立评审通过**；**whole-branch capstone review 通过**（0 blocker / 0 major，ready-to-merge-pending-gates）。
- **收尾 doc 已做**：ADR `docs/decisions/2026-07-11-block-level-buffered-retry.md`、DESIGN.md「活的架构现状」block 级缓冲重试行 + tier-1 行 WS clause 修正、plan-4 Task 1 代码块订正、记忆库更新。
- **durable ledger** `.superpowers/sdd/progress.md` = 权威逐 Task 进度（每 Task commit + concern）。
- worktree `.worktrees/block-level-buffered-retry`（分支 `feat/block-level-buffered-retry`，从 master `88a11516`）。**默认全 OFF（opt-in），无向后兼容破坏——可安全合并**，默认翻转是门后独立步骤。

## 剩余工作（全部 gated 在用户跑实证门）

**四个默认翻转/接线，一律等对应实证门通过后落地：**

| 待办 | 门（用户跑） | 门后落地 |
|---|---|---|
| **P2 T6** Responses 默认 ON | keepalive M-2 oracle `exp/responses-keepalive-idle-oracle/`（armPing `is_error=false && duration_ms>300000` && armSilent 复现 idle-out） | 改 config 默认 `openai_responses.buffered_retry.enabled=true` |
| **P3 T4** CC 默认 ON | keepalive M-2 oracle `exp/cc-keepalive-idle-oracle/`（同判据，openai-node SDK oracle） | 改 config 默认 `chat_completions.buffered_retry.enabled=true` |
| **P4 T3** WS 默认 ON | 随 Responses 门（WS 复用 `responses.buffered_retry` 键、无独立键） | 随 P2 T6 自动继承；关 backlog:300-306 剩余项②（heartbeat parity 若门覆盖） |
| **P1 T6** Anthropic 接线 + 默认 ON | PoC stage-2 `exp/block-level-anchor-coexist/`（真 Claude Code 接受两块并存 + 空 text_delta 重置 300s 死线） | 接线 `commitBoundaries=anthropicCommitBoundaries` + telemetryVendor `"anthropic"`（P0 已删临时 guard 改真记账，故只需传谓词）+ anchor 栈接线（R3 同 commit）+ req_484 golden + 改 config 默认 |

**⚠️ 落地翻转的唯一正确方式（承重，实测过的坑）**：默认值改 **config.yaml / schema 默认**（`applyConfigToState()` 每请求从 config 重导，见 `system-prompt/override.ts:48,73` + `start.ts:287/473` 注释=热重载 by-design），**绝不**靠 `state` 字段突变（会被每请求重导覆写）。测试设非默认 caps 用 `setBufferedRetryOverride(vendor, ...)` 非 `setStateForTests`（旧标量键 `protectStreamingMaxRetries` post-P0 已删）。

**PoC stage-2 三分支决策**（P1）：全 PASS→主形状（块级 + 空 text 锚点）；criterion ② FAIL→备选（每块 close@0 重开）；备选 FAIL→兜底（整响应缓冲仅 Responses/CC、Anthropic 保持 live 或 whole-response）。三分支的接线差异见 spec §4.5。

## 门未过怎么办

对应端点默认保持 `false`（opt-in），不牺牲安全换默认开（spec §4.5 三级 fallback 精神）。该 Task 降级为「保持 opt-in、文档记门未过」，不阻塞合并。

## 承重提醒（收尾会话必知）

1. **读 ledger 起步**：`cat .worktrees/block-level-buffered-retry/.superpowers/sdd/progress.md`——机制 Task 全 complete，别重派；只做上表四项 + 各自门。
2. **CC-live 默认心跳=保留**（已裁：parity Anthropic/Responses live，已向用户 FYI 可 override）。
3. **exp/ 是 gitignored**（`.gitignore:25`），提交 harness 用 `git add -f`。keepalive mock 必须 `node:http2`（明文 http 让 Bun-undici 上游假性 abort，false-negative）。
4. **subagent API 近期不稳**：失败按 BLOCKED（补上下文/换模型/内联接管）。
5. **合并前可选**：P2/P3/P4 的几个 per-task review 曾按 tiered-review-by-risk 批入「合并态评审」——whole-branch review 已覆盖集成缝（0 blocker），可视作已了；若要极致严格可对 T3/T4/close-timing 再补 per-task 眼。

## 新会话开场（门通过后复制这段）

```
接续「block 级缓冲重试」收尾。机制全 landed+reviewed、whole-branch review 通过、doc 收尾已做。先读 ledger：
cat /home/xp/src/copilot-api-js/.worktrees/block-level-buffered-retry/.superpowers/sdd/progress.md
+ 交接表 docs/plan/2026-07-11-block-level-buffered-retry/HANDOFF.md「剩余工作」。

用户已跑完的实证门结果在各 exp/*/REPORT.md。据结果落地默认翻转/P1 接线（见 HANDOFF 表 + 三分支决策）。
关键：翻转改 config.yaml/schema 默认（经 applyConfigToState 传播），绝不靠 state 突变。
每项落地后跑 typecheck + 相关测试 + 更新 ledger + DESIGN.md 该行状态（[wip]→[done]、默认 OFF→ON）。
在 worktree .worktrees/block-level-buffered-retry（分支 feat/block-level-buffered-retry）。用 subagent-driven，接线类改动派 reviewer。
```
