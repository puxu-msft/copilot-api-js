# fix: deadline 驱动的 keepalive —— 立即首 ping + cadence 节流 + clamp 离线远

> **实施状态：已完成**
> **落地**：723ac1f
> **现状锚点**：运行时选项 `streamKeepalivePingSec`（clampKeepaliveCadence ≤40）
> **备注**：cadence 上限 40 + 冷启动立即首 ping 按 plan 落地

## 设计（三层协调）
deadline(CC body-idle ≈60s, 实测 ping@45s 存活) 才是危险线，cadence 是实现手段。三层各司其职：

1. **立即首 ping（commit 冷启动）**：commit 因 pre-response stall 跑满窗口才触发（已知上游异常）。开 200 后**立即发一个 ping**——
   - 缓解快速失败：客户端立刻进 body 流，上游随后快速失败时错误帧紧跟透传、无需先等一个 cadence。
   - 消除假设依赖：不赌「200 headers 重置 CC body-idle」，立即一个真 body 帧明确确立 idle 基准。
   - 余量拉满：首 body 帧 0 延迟。
2. **cadence = ping 之间最小间隔**（节流）：发完一个 ping 后 `lastRealMs=now`，tick 排下个在 `+cadence`，不背靠背。真实帧同样刷新 lastRealMs 抑制冗余 ping。当前 tick 机制已保证，无需改。
3. **cadence 上限离 deadline 远**（安全）：`clampKeepaliveCadence` 上限从 `deadline-1`(59，贴线) 改为留大余量的值，最坏 ping 间隔也远 <60。

## 改动
1. `src/lib/config/config.ts` `clampKeepaliveCadence`：`KEEPALIVE_CADENCE_MAX` 从 59 → **40**（= deadline-20，留 ≥20s 余量；<实测安全的 45s）。warn 文案同步。
2. `src/routes/messages/handler-v4.ts` commit 分支：开 200 + sink 后、`await p` 前，**立即 `sink.write(ANTHROPIC_PING).catch(()=>{})`**。
   - gating：仅 commit 冷启动（进 commit 分支 = `streamCommitAfterSec>0` 且 window fired）；`commitAfter=0` immediate-bypass 不发（保 byte-identical）；settled-within-window 不发（上游已有真帧）。
   - heartbeat 启用时才发（`pingSec>0`）。

## 测试
- commit stall describe：断言首 forwarded 帧是 ping 且在 commit 时刻（不等 cadence）。
- byte-identical（commitAfter=0+ping=0）：仍纯上游字节、无立即 ping。
- clamp：cadence=50 → clamp 到 40（新上限）。
- 现有 cadence ping 测试时机调整。

## 收尾
typecheck + bun test tests/anthropic tests/config + subagent 复审 + DESIGN ping/commit_after 行补「commit 冷启动立即首 ping + cadence 上限 40」。
