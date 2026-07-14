# Spec：上游 transport 配置重组（按「请求生命周期 × 通信方向 × 协议能力」三轴归位）

- 状态：草案（待用户审 → 转 plan）
- 日期：2026-07-14
- 上位依据：ADR [docs/decisions/2026-07-12-per-model-idle-timeout-is-app-guard-only.md](../decisions/2026-07-12-per-model-idle-timeout-is-app-guard-only.md)（per-model 超时只作 app-guard、不碰 dispatcher）
- 相关：[docs/DESIGN.md](../DESIGN.md)「活的架构现状」Codex/Responses 行、[docs/API.md](../API.md) 配置节
- 讨论：本 spec 经一轮 GPT（异模型家族）对抗性评审 + 用户三处分叉裁决定型；关键事实（`0` 语义分叉、h2 保活非 Node-only、proxy 路 connect 计时两段）均已亲手读代码核实。

## 1. 问题（Why）

上游有三条**彼此不对等**的连接路径，但它们的配置既没按职责归位，也没暴露各自真实能力：

| 路径 | 角色 | 库（Bun / Node） | 保活 | proxy |
|---|---|---|---|---|
| HTTP/1.1（undici） | 仅明文 `http://`（本地 SearXNG）窄回退 | 官方 undici（`undici/index.js` 子路径绕开 Bun shim，两 runtime 一致） | dispatcher `keepAliveInitialDelay` | ProxyAgent |
| HTTP/2（node:http2） | **所有 https 生产主路**（GHC/github/anthropic） | `node:http2` 官方内建，两 runtime 都跑 | 裸 socket `setKeepAlive` + `session.ping()`，**两 runtime 都生效** | proxy-connect（CONNECT/SOCKS5） |
| WebSocket（undici WS） | Responses 的 opt-in 备选路 | **runtime-split**：Bun 原生 `globalThis.WebSocket`（非官方 undici）/ Node 真 undici | **无有效应用层保活**（Bun `.ping()` 是控制帧、不重置 idle-timeout、GHC 收益 PoC 未证；Node undici 无 `.ping()`） | **无**（不走 proxy 隧道，本轮不补） |

现状的三个具体病灶：

1. **两个正交层被揉进一个 `timeouts` 段**：`stream_idle` / `response_header` / `stale_request_max_age` + per-model 覆盖是 **app-layer 请求看门狗**（transport 无关，ADR 明说不碰 dispatcher）；而 `upstream_keepalive`（TCP/L4）、`upstream_h2_ping`（h2/L7 专属）是 **连接/会话保活旋钮**——两类生命周期完全不同却同段。
2. **上游 WS 池容量散在 `openai_responses` 功能段**（`max_upstream_ws_connections`），与「拨出去的连接」这一职责脱节。
3. **硬编码够不着的能力**：h2 的 connect deadline 是常量 `CONNECT_TIMEOUT_MS = 10_000`（[src/lib/transport/http2-client.ts:44](../../src/lib/transport/http2-client.ts#L44)）、WS 池空闲回收是常量 `DEFAULT_IDLE_TIMEOUT_MS = 5min`，config 完全够不着。

## 2. 目标与非目标（Scope）

**目标**：
- 把配置按三条真实职责轴归位：**请求生命周期看门狗 / upstream egress 连接 / client-facing ingress**。
- 接上「已存在但未暴露」的旋钮：h2 connect timeout、WS 池空闲回收。
- 诚实命名与诚实表达能力（不塞跨 runtime 无有效实现的死旋钮）。
- 修正全仓「Node-only」等误导注释与失真命名。
- 迁移对**现有运行语义等价**（非「配置字节等价」——key path 必然变），旧键 warn-continue、新键优先。
- 热重载对活连接**主动 reconcile**（用户裁决：不满足于「仅新连接生效」）。

**非目标（本轮不做，记入 backlog 若有价值）**：
- **不补 WS proxy 隧道**（真功能缺口，带 runtime-split 复杂度，另立项）。
- **不建泛型 per-protocol override resolver**（无第二个真实覆盖分支前是「看似可扩展、实际未受约束」的抽象）。
- **transport 不加 per-model 维度**（h2 session 按 origin 池化且 multiplex 多模型，请求级 model 无法映射到共享 session；连接/keepalive 更该按 origin/proxy/network 覆盖而非模型。model 维度只属 `timeouts.*_overrides` 那种「请求行为」）。
- **不建 transport profile（按 origin/proxy 的命名档）**：当前无足够真实的多 origin 差异需求，属过度工程。

## 3. 目标配置形态（What）

```yaml
# 层1 —— 请求生命周期看门狗（transport 无关，天然全局共享；保留原地）
timeouts:
  response_header: 600            # 首个上游进展 deadline（HTTP：直到 headers；WS：直到连接成功且收到 first event）
  response_header_overrides: {}   # per-model（请求行为维度，合理保留）
  stream_idle: 300               # 在途请求的帧间静默超时
  stream_idle_overrides:
    gpt-5.5: 600
  stale_request_max_age: 1200    # 请求总寿命上限（stale reaper）

# 层2 —— upstream egress：拨出去的连接 / 会话 / 池（协议归属）
upstream_transport:
  tcp_keepalive_probe_delay: 15  # L4 首探针延迟（秒）。0=禁用、absence=项目默认(15)。undici+h2 都吃。
                                 # 注：proxy 场景只保护「本机↔proxy」那段 TCP，不保证远端 GHC session 不被应用层 idle reaper 回收（那靠 h2 ping）。
  http2:
    ping_interval: 15            # L7 h2 PING（秒）。0=禁用。best-effort（ack 忽略）。两 runtime 都生效（非 Node-only）。
    session_connect_timeout: 10  # h2 建连 deadline（秒）。暂留 h2 段——见决策 D3。
  websocket:
    pooled_connection_idle_timeout: 300  # 池中空闲 WS 连接回收（秒）。与 timeouts.stream_idle 是两码事（后者是在途请求静默）。
    soft_max_connections: 32     # 上游 WS 池软上限：全忙时允许溢出，非硬拒绝。0=无限。
    # 无 keepalive 键：当前没有跨 runtime、经实证有效的 upstream WS keepalive primitive（见决策 D4）。

# 层3 —— client-facing ingress：客户端打进来的连接（新建窄段，整组迁移）
server:
  responses_ws:
    keep_open: false             # ← 迁自 openai_responses.client_ws_keep_open
    max_connections: 256         # ← 迁自 openai_responses.max_client_ws_connections
    max_frame_bytes: 0           # ← 迁自 openai_responses.max_ws_frame_bytes（0=无限）

# openai_responses 保留 endpoint 路由开关（不属 transport 也不属 ingress）
openai_responses:
  upstream_ws: false             # 该 endpoint 是否走上游 WS 路（endpoint-owned 路由策略）
  # ...其余 Responses payload 相关键不动
```

## 4. 关键决策（Decisions，将同步为 ADR）

- **D1 三轴归位**：配置主轴是「请求生命周期看门狗 / upstream egress / client-facing ingress」，而非「timeout vs transport」的二元。section 名（`timeouts` / `upstream_transport` / `server`）本身表达方向与职责，不靠注释解释「transport 严格只管 upstream」。
- **D2 非完全正交、单向依赖须写准**：`timeouts.response_header` / `stream_idle` 会 ×1.5 派生 undici 的 `headersTimeout` / `bodyTimeout`（safety ceiling），dispatcher 随其变化重建（[src/lib/state.ts](../../src/lib/state.ts)、[src/lib/proxy.ts:94](../../src/lib/proxy.ts#L94)）；但 per-model overrides **不**传播到 dispatcher（ADR 2026-07-12）。文档写明这条**单向**依赖，不宣称二层实现完全独立（防再次 doc-code 漂移）。
- **D3 `connect_timeout` 留 h2 段、不进 common**：当前只有 h2 接线，且 proxy 路 CONNECT 与 upstream TLS handshake **各吃一次** 同值 timeout（[proxy-connect.ts:41](../../src/lib/transport/proxy-connect.ts#L41) + [http2-client.ts:97,153](../../src/lib/transport/http2-client.ts#L97)），wall-clock 近 2 倍。叫 `common.connect_timeout` 会承诺三协议统一 wall-clock deadline 而实际没有——是假旋钮。故命名 `http2.session_connect_timeout`。**未来**当 HTTP/1.1 + WS 也接上「从拨号到连接可用的单一 wall-clock budget（各阶段共享 remaining budget、不每阶段重置）」后，再提升进 common。
- **D4 WS 无 keepalive 键**：schema 注释写「没有配置键，因为当前没有跨 runtime、经实证有效的 upstream WS keepalive primitive」；capability 经 status/诊断暴露（如 `wsApplicationKeepalive: "unavailable"`），但**不把 capability 伪装成 config**。将来若两 runtime 都有实现，须先 PoC 证「控制帧确实延长 GHC 连接寿命」再加键，不能仅凭 `.ping()` 存在。
- **D5 `0` 语义统一（用户裁决）**：全 transport 键统一 **absence = 项目默认 / `0` = 明确禁用 / 正数 = 值**。消除现状隐藏分叉——现状 `0` 在 undici 路→undici 内建 60s、在 h2 路→`DEFAULT_KEEPALIVE_MS` 15s（[proxy.ts:71](../../src/lib/proxy.ts#L71) vs [http2-client.ts:87](../../src/lib/transport/http2-client.ts#L87)），且 `0` **从不是禁用**。统一后 `tcp_keepalive_probe_delay` 的项目默认取 15（h2 现值，为对抗 ~30s reaper 调优过），undici 路也须改为遵循同默认 + 支持 `0=keepAlive:false` 真禁用。
- **D6 ingress 整组迁（用户裁决）**：新建窄 `server.responses_ws` 段，`client_ws_keep_open` + `max_client_ws_connections` + `max_ws_frame_bytes` **三键整组**迁入，不留半吊子。`openai_responses.upstream_ws` 作为 endpoint 路由开关留在 Responses 域。
- **D7 热重载主动 reconcile（用户裁决）**：不满足于「仅新连接生效」。逐键定生效策略：
  - capacity（`soft_max_connections` / `server.responses_ws.max_connections`）：立即应用，必要时主动回收超额 idle 连接。
  - `pooled_connection_idle_timeout`：重新调度当前 idle 连接的回收计时。
  - `http2.ping_interval` / `tcp_keepalive_probe_delay`：关闭并重建 idle h2 session；busy session drain 后替换。
  - `session_connect_timeout`：只影响新连接（无法追溯已建连），文档写明。
  - status API 暴露 configured vs effective-on-existing-connections 差异 + hot-reload generation。

## 5. 迁移（compat.ts，`renameLeaf`）

| 旧键 | 新键 | 备注 |
|---|---|---|
| `timeouts.upstream_keepalive` | `upstream_transport.tcp_keepalive_probe_delay` | + D5 值迁移：旧值 `0` → 迁成 absence（保「用默认」原意），非直接搬 0（否则语义翻转成禁用） |
| `timeouts.upstream_h2_ping` | `upstream_transport.http2.ping_interval` | 旧值 `0` 本就是禁用，语义不变，直接搬 |
| `openai_responses.max_upstream_ws_connections` | `upstream_transport.websocket.soft_max_connections` | soft-cap 语义在注释保留 |
| `openai_responses.client_ws_keep_open` | `server.responses_ws.keep_open` | |
| `openai_responses.max_client_ws_connections` | `server.responses_ws.max_connections` | |
| `openai_responses.max_ws_frame_bytes` | `server.responses_ws.max_frame_bytes` | |
| （新增，无旧键） | `upstream_transport.http2.session_connect_timeout` | h2 硬编码 10s 提升为可配 |
| （新增，无旧键） | `upstream_transport.websocket.pooled_connection_idle_timeout` | WS 硬编码 5min 提升为可配 |

迁移契约（补 GPT 抓出的易漏项）：
- 新旧键并存 → 新键胜出、只发一次 deprecation warning。
- 多条旧键迁入同一新对象（`upstream_transport` / `server.responses_ws`）→ **missing-only 深合并**，后迁字段不得覆盖先迁字段。
- PUT `/api/config` 路径回写**规范化后的新 key**。
- reset / hot-reload 后不因旧 state setter 归属残留而恢复错误默认。
- 五处必须同步：schema.ts、bundled `config.yaml`、runtime state defaults、JSON Schema 生成物（`/openapi.json`）、配置 API 文档——否则只是 YAML 表面迁移。

## 6. 相邻正确化（本轮一并纳入）

1. state setter 拆 transport ownership：从 `setTimeoutConfig` 拆出 `setUpstreamTransportConfig`，别只迁 YAML 而内部 state 仍把 transport 字段归 timeout。
2. 变更通知重命名：`onTransportTimeoutChange`（[state.ts:1418](../../src/lib/state.ts#L1418)）现同时管 app timeout + TCP keepalive，命名已失真，随归位改名。
3. **全仓**修正 `Node-only` 误导注释：schema.ts、proxy.ts、state.ts 类型注释、config.yaml 四处（`node:http2` 保活在 Bun+Node 都跑）。
4. status/diagnostics 暴露：effective transport config、runtime capability、pool/session count、hot-reload generation。
5. `response_header` 文档语义提升为「首个上游进展 deadline」（HTTP：直到 headers；WS：直到连接成功且收 first event，[upstream-ws-attempt.ts:141](../../src/lib/openai/upstream-ws-attempt.ts#L141)）。
6. h2 PING 保留「best-effort keepalive，非 liveness teardown」说明（ack 被忽略，[http2-client.ts:168](../../src/lib/transport/http2-client.ts#L168)）；unacked-ping 快速判死是另一 backlog 项。

## 7. 验收标准（Acceptance）

- **运行语义等价**：相同旧配置输入 ⇒ 迁移后相同 effective runtime state；新旧键并存以新键为准 + 单次 deprecation warning。（非字节等价——key path 变、规范化输出变。）
- **新旋钮真接线**：`session_connect_timeout` / `pooled_connection_idle_timeout` 改配置后经独立 oracle 观测到实际连接行为变化（非仅 state 变），去掉对应硬编码常量。
- **`0` 语义一致**：`tcp_keepalive_probe_delay: 0` 在 undici 路与 h2 路都真·禁用 keepalive；absence 两路都取默认 15；正数两路都为该延迟。
- **热重载 reconcile 可观测**：改 `ping_interval` / capacity / `pooled_connection_idle_timeout` 后，活连接按 D7 策略被 reconcile；status API 反映 configured vs effective + generation。
- **runtime-split 不引入假 schema 分叉**：保留的 WS 键（idle timeout / max connections）Bun+Node 都实现、schema 不按 runtime 分叉；真 runtime-split 的能力经 capability diagnostics 暴露、不进 config。
- **注释/文档无遗留误导**：全仓 grep `Node-only` / `onTransportTimeoutChange` 无失真残留。

## 8. 影响面（files）

- config：`src/lib/config/schema.ts`、`compat.ts`、`config.yaml`、JSON Schema 生成物
- state：`src/lib/state.ts`（setter 拆分 + 变更通知改名 + defaults）
- transport：`src/lib/proxy.ts`（undici keepalive 0-语义 + 注释）、`src/lib/transport/http2-client.ts`（去 connect/idle 常量、reconcile 钩子）
- WS：`src/lib/openai/upstream-ws.ts`、`upstream-ws-connection.ts`（idleTimeoutMs 接线 + reconcile）
- ingress：`src/routes/responses/ws.ts`（读新 `server.responses_ws.*`）
- 观测：status/diagnostics API + ui-v4 消费端（若展示 effective config）
- 文档：DESIGN.md 活的架构现状、API.md 配置节、新 ADR

## 9. 待写 plan 时细化

- reconcile 活连接的具体机制（h2 session drain-then-replace 的 re-entrancy 与 in-flight 保护，复用 persistence-async-invariants 的 drain 纪律）。
- 独立 oracle 设计：connect_timeout 用可控慢 accept 的探针、idle_timeout 用池状态 introspection、keepalive 用 `ss` 看内核 timer（empirical-verification skill）。
- 迁移的 golden-fixture：一批旧配置 → 断言 effective state 等价。
