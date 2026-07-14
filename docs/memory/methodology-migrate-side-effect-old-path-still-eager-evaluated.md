---
name: methodology-migrate-side-effect-old-path-still-eager-evaluated
description: 迁移副作用到新路径时旧路径若仍被 eager 求值则双触发；live-only observability 回归 byte/history 测试抓不到，靠 review+探针逮
metadata:
  type: feedback
---

把一个**副作用**（如 `ctx.recordFeature`）从旧路径迁到新路径时，只「在新路径加上」不够——必须确认旧路径**真的不再执行**。踩坑（CellAssembly 出站迁移 C4）：`recordFeature("via-responses"/"via-chat-completions-fallback")` 从 handler 的 strategies 工厂迁到 leg.translateOut，但 driver 的 `deps.strategies(env)` 在 `driver.ts:228`（S4 exchange）+ `:654`（buffered re-exchange）**无条件 eager 求值**——即使 cell 已迁移、其返回值被丢弃，工厂体内的 `recordFeature` 仍触发 → **双触发**。

**为何 byte/history 测试抓不到**：`recordFeature` 只发 live observability bus（TUI 按 tag 去重、WS feed 不去重、history sink 显式丢弃 feature_applied）→ 逐字节 golden + history 双轨断言全绿。**只有 review + 自建探针**（`featureCalls===["via-responses","via-responses"]`）逮得到（否定性/通过性不自证——独立 reviewer 与主会话各自独立发现同一处，且 reviewer 进一步找到第二处 654）。

**根因修**（非延后到 C5 dead-code sweep，`root-cause-first` 不留活债）：抽 `resolveExchangeStrategies(deps, env)` **lazy 解析**——migrated cell `return cell.buildStrategies(env)` 提前返回、**绝不触达** `deps.strategies`。回归测试：mock codec 填 requestState 成 migrated env + spy `deps.strategies` 工厂、断言调用 0 次（正样本：初次因 mock ctx 缺 `setAttemptEffectiveRequest` 失败，证测试确实驱动 migrated 采样路径）。

**How to apply**：迁移任何有副作用的供料（strategies/rewrites 工厂、含 record/log/mutate 的闭包）时，grep 旧路径的**所有** driver 调用点（含 buffered/retry 分支），确认对新路径覆盖的分支**短路旧路径**；副作用是 live-only（不落盘）时，byte/history 测试是盲的，须 review + 计数探针。**Related**：[[feedback-multidim-completeness-audit-before-claiming-done]]（observability 维度最易漏，合成 vs 真实/单发 vs 双发）、[[feedback-pass-null-clean-not-self-validating]]（通过不自证）。承重设计见 RFC `docs/rfc/2026-07-13-inbound-codec-outbound-leg-split.md` + DESIGN.md「出站关切装配」行。
