# ADR 2026-07-14：请求首包/时序埋点（request timing instrumentation）

- 状态：Accepted（实施完成，隔离 worktree `feat/timing-instrumentation`）
- 关联：spec [docs/spec/2026-07-14-request-timing-instrumentation.md](../spec/2026-07-14-request-timing-instrumentation.md)、plan [docs/plan/2026-07-14-request-timing-instrumentation.md](../plan/2026-07-14-request-timing-instrumentation.md)
- 相关 ADR：[richest-data-flow](2026-07-05-richest-data-flow.md)、telemetry `docs/spec/2026-07-13-telemetry-tiered-storage.md`

## 背景

排查两条 15 分钟超时请求（`req_1783967876376_569` / `req_1783967868640_568`）时发现:代理**无任何首包/TTFB 埋点**,首包时刻只能解 4MB blob 反推,且帧 `offsetMs` 在缓冲模式下折叠、原点是 `streamStartMs`(≈commit)而非 `started_at`,不可靠。实证 60 样本:上游真实 TTFT p50≈6s,但客户端可见首包 p50≈79s/max≈356s——因所有长请求走缓冲(客户端全程 keepalive、真实内容末尾一次性刷出)。

## 决策

在**各事件真实发生点**捕获 7 个权威时刻,存两处、两套原点。

- **D1 — 两轴分开存储**:上游 4 刻(`upstreamHeadersAt`/`upstreamMessageStartAt`/`upstreamFirstTokenAt`/`upstreamLastTokenAt`)存**每个 Attempt**(绝对 epoch instant,落 `attempts[]` blob);客户端 3 刻(`streamOpenMs`/`firstRealMs`/`bufferHoldStartMs`)存 **entry 列**(offset 相对 `started_at`)。
  - **否决**单一 ctx ledger + `onAttemptReset` 清空:实测 `onAttemptReset` 只覆盖 L2 缓冲腿,L1 error-driven 重试(主流)漏掉。
  - **否决**上游存 entry 列:retry 后 committed attempt 的 epoch 换算 entry-offset 会含前序 attempt + backoff,可 > 单 attempt durationMs——数学矛盾。存绝对 epoch 到 attempt 根除此矛盾。
- **D2 — fleet 分位走遥测 DDSketch registry**,非手搓 SQL(battle-tested-over-hand-rolled)。3 点接线:`SettledTelemetryInput` 加字段 + `TelemetrySink` 投影 committed attempt 的 `upstreamFirstTokenAt - startedAt`(真 TTFT)+ `HISTOGRAMS` 注册。接受注册同时新增 3 个 `/metrics` fixed-bucket Prometheus histogram family。
- **D3 — 不回填**,老行 NULL(对齐 request_bytes/multiplier 等 additive 列范式)。老 blob 帧 offset 原点是 streamStartMs(从不落盘),无法可靠换算到 started_at。
- **D4 — additive 列走 `migrateEntriesColumns.wanted`**(table_info 幂等 ALTER),非 Umzug。
- **D5 — 谓词轴**:`upstream*At` 用 `env.targetEndpoint`(上游/翻译后格式)谓词、`clientFirstRealMs` 用 `clientFormat`(下游格式)谓词。谓词收**完整帧**(openai/gemini 上游是 data-only 无 event 行,靠 JSON.parse;type-string 永不命中)。
- **D6 — 命名**:`client_stream_open_ms` 是服务端应用层「决定发 200」的时刻,**非**可证明的 client-visible ACK(故不叫 `client_commit_ms`)。跨 upstream/client 非全局单调(延迟提交路径 `clientStreamOpenMs` 墙钟可早于 `upstreamHeadersAt`)。

## 后果

- 承重教训:新增 per-attempt 字段须过**两段显式投影**(`Attempt → HistoryEntryData.attempts[]` 的 `request.ts` map + `HistoryEntryData → HistoryEntry` 的 `toHistoryAttempts` allowlist);新增 entry 字段须过 `toHistoryEntry` + `onTerminal` + `updateEntry` Pick + 列式 `buildHeadRow`/`META_KEYS`/`deserializeEntry`。任一段漏 copy 即 typecheck-绿但静默丢——**证伪只能靠端到端 round-trip 经真实终态链**。同族:[[settle-freezes-history-entry-record]] / [[fix-all-comparison-sites]]。
- 消费:per-request 明细经 `/history/api/entries/:id`(deserialize 重组 timing.client + attempts upstream*At)+ ui-v4 详情 MetaSegment;fleet 分位经 `/api/stats?window=30d+` DDSketch 或 `/metrics`。近期窗口(sinceStart/7d)无 sketch,走 fixed-bucket。
- **观测非治理**:本 ADR 只埋点,不改缓冲行为。「所有长请求缓冲、客户端可见首包≈全程」的 UX 问题 + fleet 分位排除 aborted 的盲区,记 `docs/todo/deferred-backlog.md`。
