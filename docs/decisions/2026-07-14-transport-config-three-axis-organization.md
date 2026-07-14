# ADR: 上游 transport 配置按「请求生命周期 × 通信方向 × 协议能力」三轴归位

- **状态**：Accepted
- **日期**：2026-07-14
- **相关**：[spec/2026-07-14-upstream-transport-config-reorg.md](../spec/2026-07-14-upstream-transport-config-reorg.md)、[decisions/2026-07-12-per-model-idle-timeout-is-app-guard-only.md](2026-07-12-per-model-idle-timeout-is-app-guard-only.md)（上位：per-model 超时只作 app-guard）、DESIGN.md「活的架构现状」transport 行、`src/lib/config/schema.ts`、`src/lib/transport/{http2-client,upstream-fetch,proxy-connect}.ts`、`src/lib/openai/upstream-ws*.ts`
- **决策来源**：用户在 brainstorming 中裁决（方案 A 修正版 + 三处分叉）；经两轮 GPT（异模型家族）对抗性评审硬化。

## 背景

上游有三条**彼此不对等**的连接路径：HTTP/1.1（undici，仅明文 SearXNG 窄回退）、HTTP/2（node:http2，所有 https 生产主路）、WebSocket（undici WS，Responses opt-in 备选路，runtime-split Bun 原生 / Node undici）。但配置既没按职责归位，也没暴露各自真实能力：

- 两个正交层被揉进一个 `timeouts` 段——**app-layer 请求看门狗**（`stream_idle` / `response_header` / `stale_request_max_age` + per-model 覆盖，ADR 2026-07-12 明确不碰 dispatcher）与 **连接/会话保活旋钮**（`upstream_keepalive` / `upstream_h2_ping`）生命周期完全不同却同段。
- 上游 WS 池容量散在 `openai_responses` 功能段（按 wire technology 而非职责归类）。
- h2 connect deadline（常量 10s）、WS 池空闲回收（常量 5min）硬编码，config 够不着。

「三者配置该共享还是拆三份」是伪二元：真正的轴不是 transport，而是**能力的职责归属**。

## 定夺

**配置沿三条真实职责轴组织，而非按 transport 或按「timeout vs transport」二元切分：**

1. **`timeouts.*`** —— 请求生命周期看门狗（transport 无关，天然全局共享）：`stream_idle` / `response_header` / `stale_request_max_age` + per-model 覆盖。保留原地。
2. **`upstream_transport.*`** —— 拨出去（egress）的连接 / 会话 / 池，按协议归属：`tcp_keepalive_probe_delay`（L4，undici+h2 共享）/ `http2.{ping_interval, session_connect_timeout}` / `websocket.{pooled_connection_idle_timeout, soft_max_connections}`。
3. **`server.responses_ws.*`** —— 客户端打进来（ingress）的连接：`keep_open` / `max_connections` / `max_frame_bytes`。

section 名本身表达方向与职责，不靠注释解释「transport 只管 upstream」。

### 连带子决策（同一设计一并定夺）

- **非完全正交、单向依赖须写准**：`timeouts.{response_header,stream_idle}` ×1.5 派生 undici safety ceiling，但 per-model overrides 不传播到 dispatcher（承 ADR 2026-07-12）。文档写明这条**单向**依赖，不宣称二层实现完全独立。
- **`connect_timeout` 留 h2 段（`http2.session_connect_timeout`）、不进 common**：它是 **per-stage** 上限非总 deadline（proxy 路 CONNECT + TLS 各吃一次、最坏 wall-clock ≈ 2×）。叫 common 会承诺三协议统一 wall-clock 而实际没有——假旋钮。待三路都接上统一 budget 再提升。
- **`0` 语义统一**：全 transport 键 **absence = 项目默认 / `0` = 明确禁用 / 正数 = 值**。消除现状隐藏分叉（`0` 在 undici 路→60s、h2 路→15s，且 `0` 从不是禁用）。`tcp_keepalive_probe_delay` 默认取 15（h2 现值，对抗 ~30s reaper 调优过）。**旧 `upstream_keepalive: 0` 迁成 absence**，其 undici 路 effective 从 60s 统一为 15s，是本决策批准的有意变更。**诚实例外**：`session_connect_timeout: 0` 在 SOCKS 代理下无法真禁用（`socks` 库 `timeout || 30_000` 地板），故配 SOCKS 时 validation 拒绝该键为 0（fail-fast），宁可报错也不静默套 30s 冒充禁用——诚实表达能力边界优先于语义整齐。
- **ingress 整组迁 `server.*`**：`client_ws_keep_open` / `max_client_ws_connections` / `max_ws_frame_bytes` 三键整组迁入，不留半吊子。`openai_responses.upstream_ws` 作 endpoint 路由开关留 Responses 域。
- **热重载对活连接主动 reconcile**（非「仅新连接生效」）：generation-based **retire-and-replace**、per-session active-stream exactly-once 计数、retiring session PING 存活至 drain、upstream soft-cap 与 client hard-cap 分治、WS idle 基于 `idleSince` 重调。与 persistence-async-invariants 的 drain 纪律同源。

## 诚实表达能力（承 internal-tool-security-posture / richest-data-flow 之外的第三条诚实原则）

- **WS 无 keepalive 配置键**：当前没有跨 runtime、经实证有效的 upstream WS keepalive primitive（Bun `.ping()` 是控制帧、不重置 idle-timeout、GHC 收益 PoC 未证；Node undici 无 `.ping()`）。capability 经 status 诊断暴露（`wsApplicationKeepalive: "unavailable"`），**不把 capability 伪装成 config**。将来须先 PoC 证「控制帧延长 GHC 连接寿命」再加键。
- **h2 保活非 Node-only**：`node:http2` 的 `setKeepAlive` + `session.ping()` 在 Bun+Node 都生效；纠正全仓 `Node-only` 误导注释。
- **命名反映真实语义**：`tcp_keepalive_probe_delay`（首探针延迟非布尔）、`pooled_connection_idle_timeout`（池空闲回收非在途静默）、`soft_max_connections`（软上限允许溢出）。
- **不建假抽象**：不预建泛型 per-protocol override resolver（无第二个真实覆盖分支前是「看似可扩展、实际未受约束」）；不建 http1 空段。

## 备选方案（未采纳）

- **方案 B（纯 per-transport 三 silo `transport.{http1,http2,ws}`）**：更「对称」，但把 TCP keepalive、connect 超时等协议无关旋钮强行复制三份，违「同一事实一处」、埋漂移债。撤销。
- **方案 C（capability-descriptor registry / transport profile 按 origin·proxy 命名档）**：最可扩展，但对 3 个 transport、无多 origin 差异需求是过度工程（为想象规模付现在的复杂度）。撤销，记 backlog 若未来有真实需求。
- **ingress 键留 `openai_responses` + ADR 标注归属**：次优。留下 client WS 生命周期被拆两处的半重组。撤销（用户裁决整组迁）。
- **热重载仅新连接生效**：改动小，但已有 h2 session / WS 连接不采用新值、运维误判 reload 已生效。撤销（用户裁决主动 reconcile）。

## 非目标（本决策不含）

- **不补 WS proxy 隧道**（真功能缺口、带 runtime-split 复杂度，另立项）。
- **transport 不加 per-model 维度**（h2 session 按 origin 池化且 multiplex 多模型，请求级 model 无法映射到共享 session；连接是 origin/proxy 共享资源、非模型所有）。model 维度只属 `timeouts.*_overrides` 那种「请求行为」。
