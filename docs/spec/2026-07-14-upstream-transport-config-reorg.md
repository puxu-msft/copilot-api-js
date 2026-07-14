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
    session_connect_timeout: 10  # h2 **每建连阶段** 上限（秒），非总 deadline：proxy 路 CONNECT 与 upstream TLS 各吃一次，最坏 wall-clock ≈ 2×。暂留 h2 段——见 D3。
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
- **D3 `connect_timeout` 留 h2 段、命名 `session_connect_timeout`、不进 common**：当前只有 h2 接线，且 proxy 路 CONNECT 与 upstream TLS handshake **各吃一次** 同值 timeout（[proxy-connect.ts:41](../../src/lib/transport/proxy-connect.ts#L41) + [http2-client.ts:97,153](../../src/lib/transport/http2-client.ts#L97)），是**每阶段（per-stage）上限**、非总 deadline，proxy 路最坏 wall-clock ≈ 2×。叫 `common.connect_timeout` 会承诺三协议统一 wall-clock deadline 而实际没有——是假旋钮。schema/config 行内注释**必须写明 per-stage + proxy 最坏 2×**（防被读成总 deadline）。**未来**当 HTTP/1.1 + WS 也接上「从拨号到连接可用的单一 wall-clock budget（各阶段共享 remaining budget、不每阶段重置）」后，再提升进 common（届时或重命名为总-deadline 语义）。
- **D4 WS 无 keepalive 键**：schema 注释写「没有配置键，因为当前没有跨 runtime、经实证有效的 upstream WS keepalive primitive」；capability 经 status/诊断暴露（如 `wsApplicationKeepalive: "unavailable"`），但**不把 capability 伪装成 config**。将来若两 runtime 都有实现，须先 PoC 证「控制帧确实延长 GHC 连接寿命」再加键，不能仅凭 `.ping()` 存在。
- **D5 `0` 语义统一（用户裁决）**：全 transport 键统一 **absence = 项目默认 / `0` = 明确禁用 / 正数 = 值**。消除现状隐藏分叉——现状 `0` 在 undici 路→undici 内建 60s、在 h2 路→`DEFAULT_KEEPALIVE_MS` 15s（[proxy.ts:71](../../src/lib/proxy.ts#L71) vs [http2-client.ts:87](../../src/lib/transport/http2-client.ts#L87)），且 `0` **从不是禁用**。统一后 `tcp_keepalive_probe_delay` 的项目默认取 15（h2 现值，为对抗 ~30s reaper 调优过），undici 路也须改为遵循同默认 + 支持 `0=keepAlive:false` 真禁用。
- **D6 ingress 整组迁（用户裁决）**：新建窄 `server.responses_ws` 段，`client_ws_keep_open` + `max_client_ws_connections` + `max_ws_frame_bytes` **三键整组**迁入，不留半吊子。`openai_responses.upstream_ws` 作为 endpoint 路由开关留在 Responses 域。
- **D7 热重载主动 reconcile（用户裁决）**：不满足于「仅新连接生效」。承重纪律：**generation-based retire-and-replace**，且与 `persistence-async-invariants` 的 drain 纪律一致（pending/active 所有权独立于 event bus 或调用方 promise，close 前等真实 active set 清零）。
  - **h2 session（`ping_interval` / `tcp_keepalive_probe_delay` 变更）——retire-and-replace，非 drain-then-replace**（HIGH-2）：
    1. 旧 session **先原子移出可路由池 + 标记 `retiring`**，不再接新 stream。
    2. 新 generation session 可**立即/按下一请求**建立，**不等**旧 session drain（否则新请求继续进旧配置 session 或被旧长流阻塞、graceful drain 退化成服务停顿）。
    3. 旧 session 上已有 stream 独立 drain；**per-session active-stream 计数**归零后才 `session.close()`。
    4. active-stream 计数须自维护、**exactly-once decrement** 覆盖全路径：正常 body `end` / body `error` / body cancel / headers 前 request error / pre-response abort / session close·reset——**fetch promise settled ≠ drain done**（`Response` 在 headers 到达即 resolve，body 仍在消费，[http2-client.ts:393-490](../../src/lib/transport/http2-client.ts#L393)）。
    5. **retiring session 的旧 PING/keepalive timer 必须存活到 drain 完**（HIGH-4）——否则长思考在途流失去保护，违反既有不变量（[http2-client.ts:243-261](../../src/lib/transport/http2-client.ts#L243)：GOAWAY/移池后 PING 续跑至真正 close）。若用户 `ping_interval: 0` 要求立即停 PING，采「重调旧 timer 但仍 drain」而非直接清 timer。
    6. shutdown 须等所有 retiring session drain，或进既有 abort phase 后明确取消。
  - **generation race（在飞建连）**（HIGH-3）：每次 transport config change 递增 generation；session creation 捕获 generation；完成时若 generation 已过期则**不入当前池**、关闭旧 session、等待者重试取新 generation；多次快速 reload **coalesce 到最新 generation**（不启多轮互覆盖 reconcile）；reconcile 错误须记录可观测，**同步 listener 不得 throw 破坏 config apply、也不得 silently swallow**。可借鉴既有 `poolEpoch`（[http2-client.ts:217-273](../../src/lib/transport/http2-client.ts#L217)），但 `pending.clear()` ≠ drain（清 map 不取消/不观测在飞建连）。
  - **upstream WS soft cap（`soft_max_connections`）**（HIGH-5）：reload 时全 busy 允许暂超 cap（soft 语义）；但**每个 connection 从 busy→idle 时再触发 eviction 直到回落**（否则 reload 当下无 idle victim → 永久超额）；淘汰序 = idle LRU；`0` = 无限、不 evict。
  - **client ingress hard cap（`server.responses_ws.max_connections`，与 upstream soft cap 不同 policy）**（HIGH-5）：明确 reload 降 cap 时——是否关现有 idle keep-open client socket、active socket 是否允许 drain、超 cap 期间是否拒新连接、idle victim 是否 LRU、`keep_open: false` reload 时已有 idle keep-open socket 是否立即 normal-close。
  - **WS `pooled_connection_idle_timeout` 重调基于原 idle 起点**（HIGH-6）：connection 记 `idleSince`，新 deadline = `idleSince + newTimeout`（**非** `now + newTimeout`，否则每次 reload 无意延长老连接寿命）；新 deadline 已过→立即 close；增大→延到新绝对 deadline；改 0→取消 timer；busy 连接下次转 idle 时读最新配置起算。当前实现只持 timer、无 `idleSince`（[upstream-ws-connection.ts:102-137](../../src/lib/openai/upstream-ws-connection.ts#L102)），须补。
  - **`session_connect_timeout`**：只影响新连接（无法追溯已建连），文档写明。
  - **status API（可判定字段，HIGH-7）**：configured generation + values；h2 sessions（origin / generation / `active|retiring` / active-stream count / effective ping·TCP keepalive）；upstream WS（active/busy/idle 数 / generation / effective idle·cap）；reconcile 状态（`idle|running|failed` / last completed generation / last error）；runtime capability（Bun/Node + `wsApplicationKeepalive: "unavailable"`）。**禁止只返回一个 generation 数字就形式满足**。

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

迁移契约（补两轮 GPT 抓出的易漏项）：
- 新旧键并存 → 新键胜出、只发一次 deprecation warning。
- 多条旧键迁入同一新对象（`upstream_transport` / `server.responses_ws`）→ **missing-only 深合并**，后迁字段不得覆盖先迁字段。深合并边界须固定（HIGH-1）：新 parent 已存在且为 object → 逐叶新键优先；新 parent 已存在但为 scalar/array → **不得静默吞旧迁移值**、须在新 parent 路径报结构校验错；新叶为 `null`（PUT delete 语义）→ 视为用户显式新值仍优先、不让 legacy 值复活；两条 legacy rule 意外指向同一新叶 → registry 加守卫测试或明确 top-down 优先级。
- **PUT `/api/config` 的文档级迁移机制（BLOCK-2）**：现有 PUT 是把验证后的值**增量合并进原 YAML document**（[route.ts:113-135,257-305](../../src/routes/config/route.ts#L113)），验证后已丢旧键 provenance，`mergeConfigIntoDocument()` 既不知删哪个 legacy path、也不处理 `upstream_transport`/`server`，对 `0→absence` 更无新叶可写——**`renameLeaf` 单独做不到「回写规范化新 key」**。plan 须指定显式机制：① compat 层除 normalized value 外**返回 migration operations**（`{oldPath, newPath, migratedValue, deleteOnly}`）；② PUT writer 先删所有命中 legacy path、再写 normalized new path；③ 旧 keepalive `0` → **delete old path、不写 new path**；④ 清理迁空后的旧 section（不留空 `timeouts:` / `openai_responses:`）；⑤ 保留未触节点的 YAML 注释与格式。
- reset / hot-reload 后不因旧 state setter 归属残留而恢复错误默认。
- 同步面须区分两个表面（HIGH-8）：schema.ts、bundled `config.yaml`、runtime state defaults、**`config.schema.json`（`generate:config-schema` 生成物）**、API/config 文档。注意 `/openapi.json` 的 config route 当前是 free-form `z.record(z.string(), z.unknown())`（[route.ts:30-31](../../src/routes/config/route.ts#L30)）、**非**字段级 config schema 生成物；若本轮顺带把管理 API 收紧为精确 Config schema，再额外验收 `/openapi.json`。

## 6. 相邻正确化（本轮一并纳入）

1. state setter 拆 transport ownership：从 `setTimeoutConfig` 拆出 `setUpstreamTransportConfig`，别只迁 YAML 而内部 state 仍把 transport 字段归 timeout。
2. 变更通知重命名：`onTransportTimeoutChange`（[state.ts:1418](../../src/lib/state.ts#L1418)）现同时管 app timeout + TCP keepalive，命名已失真，随归位改名。
3. **全仓**修正 `Node-only` 误导注释：schema.ts、proxy.ts、state.ts 类型注释、config.yaml 四处（`node:http2` 保活在 Bun+Node 都跑）。
4. status/diagnostics 暴露：effective transport config、runtime capability、pool/session count、hot-reload generation。
5. `response_header` 文档语义提升为「首个上游进展 deadline」（HTTP：直到 headers；WS：直到连接成功且收 first event，[upstream-ws-attempt.ts:141](../../src/lib/openai/upstream-ws-attempt.ts#L141)）。
6. h2 PING 保留「best-effort keepalive，非 liveness teardown」说明（ack 被忽略，[http2-client.ts:168](../../src/lib/transport/http2-client.ts#L168)）；unacked-ping 快速判死是另一 backlog 项。

## 7. 验收标准（Acceptance）

- **运行语义等价（除 D5 明确批准的有意变更外，BLOCK-1）**：相同旧配置输入 ⇒ 迁移后相同 effective runtime state；新旧键并存以新键为准 + 单次 deprecation warning。**唯一有意例外**：旧 `timeouts.upstream_keepalive: 0` 迁成 absence，其在 undici 路的 effective default 从库默认 **60s → 统一为项目默认 15s**，是本次经用户批准的有意行为变更（非等价违背）。（整体非字节等价——key path 变、规范化输出变。）
- **迁移 golden-fixture 分别断言**：旧 positive 值→严格等价；旧 `0`→迁成 absence 并产生新默认 15、**不得**误迁成 disabled；新显式 `0`→两路真禁用。
- **新旋钮真接线**：`session_connect_timeout` / `pooled_connection_idle_timeout` 改配置后经独立 oracle 观测到实际连接行为变化（非仅 state 变），去掉对应硬编码常量。
- **`0` 语义一致（覆盖全数值键，NIT-2）**：`tcp_keepalive_probe_delay: 0` 两路真禁用（undici `keepAlive:false`）、absence 两路取默认 15、正数两路为该延迟；`ping_interval: 0`→无 timer；`session_connect_timeout: 0`→无 connect deadline；`pooled_connection_idle_timeout: 0`→不 evict；`soft_max_connections: 0` / ingress `max_connections: 0` / `max_frame_bytes: 0`→无限。容量键的 `0` 是**禁用该限制**、非禁用 transport。
- **热重载 reconcile 可观测**：改 `ping_interval` / capacity / `pooled_connection_idle_timeout` 后活连接按 D7 策略被 reconcile（含 retire-and-replace、generation race coalesce、idle-since 重调）；status API 返回 D7 规定的可判定字段（sessions/generation/reconcile 状态），非仅一个 generation 数字。
- **runtime-split 不引入假 schema 分叉**：保留的 WS 键（idle timeout / max connections）Bun+Node 都实现、schema 不按 runtime 分叉；真 runtime-split 的能力经 capability diagnostics 暴露、不进 config。
- **注释/文档无遗留误导**：scoped grep `upstream_keepalive` / `upstream_h2_ping` / `node:http2` 保活相关注释无错误 Node-only 描述（允许其他经核实真实的 Node-only 文本）；旧符号 `onTransportTimeoutChange` 零残留。

## 8. 影响面（files）

- config：`src/lib/config/schema.ts`、`compat.ts`、`config.yaml`、JSON Schema 生成物
- state：`src/lib/state.ts`（setter 拆分 + 变更通知改名 + defaults）
- transport：`src/lib/proxy.ts`（undici keepalive 0-语义 + 注释）、`src/lib/transport/http2-client.ts`（去 connect/idle 常量、reconcile 钩子）
- WS：`src/lib/openai/upstream-ws.ts`、`upstream-ws-connection.ts`（idleTimeoutMs 接线 + reconcile）
- ingress：`src/routes/responses/ws.ts`（读新 `server.responses_ws.*`）
- 观测：status/diagnostics API + ui-v4 消费端（若展示 effective config）
- 文档：DESIGN.md 活的架构现状、API.md 配置节、新 ADR

## 9. 待写 plan 时细化

- **h2 reconcile 机制**：per-session active-stream counter（exactly-once decrement 全路径）+ generation-捕获的 retire-and-replace + retiring session PING 存活至 drain；复用/借鉴既有 `poolEpoch`，但不以 `pending.clear()` 当 drain。re-entrancy 与 in-flight 保护对齐 persistence-async-invariants。
- **compat migration-operations**：compat 层返回 `{oldPath, newPath, migratedValue, deleteOnly}` 序列；文件 load 走 warn-continue 深合并、PUT writer 走「删旧 path + 写新 path（deleteOnly 只删）+ 清空 section + 保注释」。
- **独立 oracle 设计**：connect_timeout 用可控慢 accept 的探针、idle_timeout 用池状态 introspection、keepalive 用 `ss` 看内核 timer（empirical-verification skill）；迁移 golden-fixture 覆盖 §7 三类断言（positive 等价 / `0`→absence→15 / 新 `0`→禁用）。
- **status schema 定型**：按 D7 HIGH-7 的字段清单落成具体类型（SSOT-types：后端定义、ui-v4 经 `~backend/*` re-export）。
