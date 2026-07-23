# B2 vs B5：上游静默恢复主线选型 PoC（2026-07-23）

关联 spec：[`docs/spec/2026-07-23-upstream-silence-commit-timing.md`](../../docs/spec/2026-07-23-upstream-silence-commit-timing.md) §6.1。执行：`gpt-souls:poc-runner`。

## 裁决

**B2 为主线，B5 作后续可配置的尾延迟优化层。** 长远完整形状 = 先做 driver-owned 的 pre-semantic recovery supervisor（B2 覆盖 post-commit pre-content）+ continuation（post-content），形成完整 post-commit 恢复面；B5 后续接同一 pending-open seam 优化延迟、非替代 B2。

## SDK wire oracle 实测（承重）

离线真 `@anthropic-ai/sdk` 0.106.0 探针（`sdk-wire-probe.ts`），无 GHC/无凭据/未碰 4141，4 场景 ×3 次确定：

```sh
bun run exp/silence-recovery-b2-vs-b5/sdk-wire-probe.ts
```

| 场景 | SDK 结果 | 结论 |
|---|---|---|
| 正常流正样本 | `text: "control"` | oracle 确实驱动+解析正常流 |
| `ping → fresh message_start → text@0` | `text: "B2 default ping splice"` | **默认 ping 模式：fresh message_start 自然成客户端首消息、无需 remap** |
| synthetic/enveloped message_start 后 dedup fresh message_start | `text: "B2 enveloped splice"` | enveloped_ping 可 dedup 连接 |
| synthetic empty text block@0 完结后 real text@1 | 空 block + `text: "B2 empty-text splice"` | empty_text 的 close-anchor + index remap 合法 |

→ 验证 spec §4 修订：**anchor remap 只是 `empty_text` 机件、非 B2 通用前提**。

## B2 不是 continuation 小变体（代码实证）

`runRequest` 只在拿到 ready upstream 后才 bind 返回（`driver.ts:311-374`）；pre-header 失败时 handler 只有 rejected `p`、无 CoordinatedCandidate、无 ready parent。`runContinuation` 要求 ready parent + `committedAny=true`（`coordinator.ts:143-153` / `driver.ts:1401-1454`）。

**B2 必须新建**（可复用 candidate/dispatch/history/budget/sink/reconcile 底层）：
1. pre-ready failure ownership（driver 持有 pending primary、把 pre-ready 失败结算为可追踪 parent）。
2. 统一 semantic-content gate（不能只看 `committedAny`；须覆盖 pre-ready + ready 后首 semantic frame 前 + live/buffered）。
3. sink lifetime supervisor（首失败路径不能 close sink 后再拼第二条）。
4. 三模式协议级回归矩阵（primary failure / recovery failure / abort / header-timeout / budget exhaustion）。
5. pre-ready primary / recovery / winner 的 discarded/failed/winner history settlement。

## server-tool 双执行 gate（B2 与 B5 共用）

复用 `classifyServerExecutionRisk`（`hedge-policy.ts:152-183`，从最终 target `PreparedRequest` 分类）。B2 fresh dispatch 前必调，条件 = 「未写真实 semantic content **且** `.kind === "none"`」。**保守 capability 预防、不能证明上游未执行**；`allowServerTools:true` 无条件放行不满足安全要求、主线不用它绕过；classifier 跳过无字符串 `type` 的 tool——若安全目标扩至畸形/未类型化 tool 需另加 stricter gate。

## B5 可行但仍是新 pre-ready 拓扑

现有 hedge post-header（`driver.ts:769-837` 需已 ready binding）。B5 需新建：pending-open race、pre-header winner predicate（建议按「first complete semantic block」而非「first header」，否则可能选中之后继续静默的流）、败者 semantic-frame delivery gate。candidate race/cancel/budget 子域比 B2 复用更多。

## 未验证门

真实 GHC 大 context fresh-retry 成功率（= spec Q2，决定 B2 根治 vs 退化 B3）、GHC cancel 计费语义、server tool 首 token 前执行时点、真实 CC 300s watchdog。
