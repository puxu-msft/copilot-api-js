# ADR：聚合指标交给 Prometheus/Grafana，退役 `/api/stats` 自建聚合

- 日期：2026-07-22
- 状态：**已决策（用户 2026-07-22）**，分阶段落地（见「后果/迁移」——非立即删码）
- 决策者：用户
- 相关：`docs/spec/operational-stats-and-lineage-removal.md`（registry 三支柱）、`docs/spec/2026-07-13-telemetry-tiered-storage.md`（telemetry.db 分层存）、skill `telemetry-architecture`

## 背景

本项目自建了一套聚合遥测设施：`/api/stats`（JSON，按维度 breakdown，多窗口 `sinceStart/7d/30d/90d/lifetime` + DDSketch 分位 + top-N）+ `telemetry.db` 三层 rollup（5min/hourly/daily + cumulative）+ ui-v4/ui 的 stats 展示。`/metrics`（Prometheus text-exposition）与 `/api/stats` **同源**（都投影 telemetry registry `getDimensionBreakdown`），`/metrics` 只出 `sinceStart` 窗。

## 决策

**以 `/metrics`（Prometheus）为一等聚合出口，聚合可视化与告警交给 Grafana；退役 `/api/stats` 及其专属的多窗口 rollup / DDSketch 存 / stats UI。**

理由（`battle-tested-over-hand-rolled`）：`/api/stats` 相对 `/metrics` 多出的三样——**多窗口、分位、top-N/维度交叉**——恰是 Prometheus/Grafana 的原生本职：
- 多窗口 = Prometheus 抓 counter 存时序后 `increase(...[30d])`/`rate()` 任意窗；**我们的 telemetry.db 三层 rollup 本质在重造 Prometheus 已有的东西**。
- 分位 = `/metrics` 已出 Prometheus histogram，Grafana `histogram_quantile()` 直接算；**不需自存 DDSketch**。
- top-N/维度交叉 = Grafana `topk()` + label 分组的基本操作。

即：只要 `/metrics` 的 label + histogram 铺够，`/api/stats + telemetry.db 长窗 rollup + DDSketch + stats UI` 这一整套对有 Prometheus 的部署是冗余的。

## 边界：什么保留、Grafana 给不了的

**保留（非聚合指标、Grafana 替代不了）**：
- **History DB + History UI**——per-request 明细/取证（高基数：request-id/session/任意 client UA/tool 名会撑爆 Prometheus label，本就该留在 History）。与遥测聚合正交、独立存在。
- **`/api/status`**——健康快照（health/auth/quota/rate-limiter/memory/shutdown/model 计数），高频轮询，非维度 breakdown。
- **实时在途面板 + TUI footer**——live 视图，非 stats 的活。
- **`/metrics` + telemetry registry + `getDimensionBreakdown`（sinceStart 内存路径）**——`/metrics` 仍靠它，**不删**。

**退役（Prometheus 可替代）**：
- `/api/stats` 路由（`src/routes/stats/`）。
- telemetry.db 的**长窗 rollup + DDSketch 存**（`src/lib/telemetry/read.ts` 的 30d/90d/lifetime 路径 + sketch）——仅服务 /api/stats 长窗。
- ui/ui-v4 的 stats 聚合页（`ui/src/composables/useOperationalStats.ts` 等）。

## 后果 / 迁移（分阶段，破坏性，须避开并发热区）

**不立即删码**——telemetry 区正被并发会话热改（2026-07-17 起 retry-fire telemetry、generation topology、V2-removal），且退役是破坏性方向。正确顺序：

1. **先 `/metrics` label/histogram 补齐（enabling，非破坏）**：把 `/api/stats` 现有维度 breakdown（model/endpoint/client/agentKind/tool/…）+ 分布（duration/queue/token histogram）在 `/metrics` 上以 Prometheus 原生形态铺全，确保聚合能力无损迁移到 Prometheus 侧。
2. **增加 Grafana 支持（新增，非破坏）**：`docs/GRAFANA.md`（部署/scrape 配置示例）+ 示例 dashboard JSON（provisioning）+ README 指引。
3. **再退役自建聚合（破坏性，最后做）**：删 `/api/stats` 路由 + telemetry.db 长窗 rollup/DDSketch + stats UI。此步须确认并发 telemetry 工作已落定、且 §1 label 无损覆盖后才动。

`telemetry.db` 的 sinceStart/7d 内存路径、cumulative、双轨计数是否全退还是保 `/metrics` 所需子集，在第 3 步专项 spec 里按「/metrics 实际依赖」精确裁决——本 ADR 只定方向，不预判 telemetry.db 的最终形态。

## 对进行中特性的影响

- **上游 disconnect 归因（子项目 1）的 metrics** → 定为 **bus-counter sink → `/metrics`**（`{kind,endpoint,phase}` label，照 `retryStrategyFires` 先例），**不走** `/api/stats` registry 维度。天生 Grafana 友好，且是本方向的第一个实践。见 `docs/spec/2026-07-14-upstream-disconnect-attribution.md`。
- 后续任何新聚合指标一律 **`/metrics`-first**，不再往 `/api/stats` 加维度。

## 未采纳
- **维持自包含 stats UI（不依赖 Prometheus）**：牺牲「开箱即用内置统计」换取不手搓时序库。用户取舍：接受依赖 Prometheus/Grafana 做聚合可视化，本工具是开发/内部用途，运维方自备监控栈是合理前提。
