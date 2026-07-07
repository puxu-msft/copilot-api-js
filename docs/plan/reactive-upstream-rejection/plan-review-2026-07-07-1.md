# P1 plan —— subagent 对抗审查报告（2026-07-07, no.1）

- **被审对象**：[plan.md](plan.md) 的 **P1 section**（primitive + A + B）。
- **审查者**：general-purpose subagent，裁判轴显式设为「长远正确 + 完整 + 忠于冻结 RFC 决策，非 ROI/YAGNI」。
- **方法**：逐个核实 P1 引用的每个 code anchor 是否解析到真实符号；对抗性地尝试推翻各正确性主张（O6 baseline、互斥、meta 线程、半破碎 commit、错误 anchor）。

## 结论

**无 BLOCKER。** 每个 code anchor 都解析；O6 pre-S3 baseline 线程、`meta.sanitization` 端到端流转、B 独立集互斥与空集碰撞规避、config 5+1 站点镜像——全部对照代码核实为正确。

## VERIFIED-CORRECT（审查者对照代码确认，摘要）

- **O6 pre-S3 baseline**：`context.originalPayload` = adapter `deps.originalPayload` = `codec.getTruncateBaseline() ?? env.body` = preprocessed **pre-sanitize** payload；`?? env.body` fallback 保证非 undefined，`resanitize(...)` 不会抛。learn-before-resanitize 顺序正确（primitive 先 `mark` 后 `remediate`，故 re-run S3 时新学模型已解析到 reject mode，闭环成立）。
- **meta.sanitization 线程**：`recordRetryPipelineStateV4`（handler-v4.ts:604）确读 `meta.sanitization as SanitizationStats`；adapter 后置 onMeta、driver post-gate 触发——与 auto-truncate 完全同构。`result.stats` 运行时是 `SanitizationStats`，消费端 cast，无类型错。
- **有效模式放置**：`payload.model` 在 `sanitizeAnthropicMessages` 内已是 resolved outbound 名；web-search（orchestrator + web-search-direct）proactive 侧均经 `sanitizeAnthropicMessages`/`runAnthropicPayloadRewrites`，透明覆盖成立。
- **B 互斥/碰撞**：`findSupportedEfforts` 全 src 仅 `clampEffortLevel` 一个消费者，单点前置剥除足够；独立集永不存空数组，5 处碰撞结构性不适用；`setSupportedEfforts` 的 `effortUnsupportedModels.delete` 在 unchanged 早返回之前，互斥正确。effort-learning strategy 无需接线改动。
- **config 站点**：scalar `systemMessagesSanitize` 5 站点 + array `nonDeferredTools` 5 站点（含两处 `[...spread]` copy）全部核实；`nullableNonemptyStringArray` 允许 `[]`（可清空默认集，无锁死）。
- **primitive 非投机**：RFC §3.1 WARN-7 强制要求为 C/D/E 抽 primitive，A 作 P1 唯一消费者是忠实实现、不可裁。

## SHOULD-FIX（已全部采纳并折入 plan）

| # | 问题 | 采纳的修法 |
|---|---|---|
| 1 | Task 7 测试直接调 `clampEffortLevel`（模块私有、未 export） | 改为经公共入口 `prepareAnthropicRequest` 驱动测试，删直调变体（不为测破封装）|
| 2 | Task 3 测试用占位 harness 名 `applyConfig`/`resetConfigManagedState` | 注明照抄 `tests/config/config-merge.unit.test.ts` / `bundled-config.unit.test.ts` 真实 harness |
| 3 | web-search-direct 反应式覆盖未说明 | Task 5 加边界注：反应式 A 只 wire 进主 handler；web-search-direct 靠 proactive 默认集稳态覆盖（RFC §3.2 transparent coverage 在该路径 = proactive-only）|
| 4 | 内存集 `systemRejectModels` 与 config `state.systemRejectModels` 同名易混 | 内存集重命名 `learnedSystemRejectModels`；持久化文件键仍 `systemRejectModels`（schema 与变量名解耦）|
| 5 | `clearAnthropicFeatureNegotiationForTests`「clears the 6 maps」注释漂移 | Task 2/6 edit list 加同步更新注释计数（6→8，P2 C1 再→9）|

## 未采纳（记录 + 理由）

- **Informational：RFC 引用 `src/lib/request/driver.ts:253/168/209`（实际是 `src/lib/pipeline/driver.ts`）。** 不改 RFC（已冻结、已过三轮 review；改动风险 > 收益）。**plan 的 anchor 表已用正确路径 `pipeline/driver.ts`**（审查者确认），执行者只读 plan，不受影响。留此记录供 RFC 未来读者。
