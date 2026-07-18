# 上游传输配置三轴重组 —— 实施计划总览

- Spec：[docs/spec/2026-07-14-upstream-transport-config-reorg.md](../../spec/2026-07-14-upstream-transport-config-reorg.md)
- ADR：[docs/decisions/2026-07-14-transport-config-three-axis-organization.md](../../decisions/2026-07-14-transport-config-three-axis-organization.md)
- 上游 ADR：[docs/decisions/2026-07-12-per-model-idle-timeout-is-app-guard-only.md](../../decisions/2026-07-12-per-model-idle-timeout-is-app-guard-only.md)
- 执行者 kick-off：[plan-kickoff.md](./plan-kickoff.md)

## 目标（Goal）

把混杂在 `timeouts.*` / `openai_responses.*` 里的传输层旋钮，按三轴重新归位：

1. **请求生命周期看门狗**（`timeouts.*`，与传输协议无关）——`response_header` / `stream_idle` / 及其 overrides / `stale_request_max_age`。
2. **上游出站连接**（`upstream_transport.*`，按协议分组）——TCP keepalive、h2 ping、h2 连接超时、WS 池空闲超时、WS 软上限。
3. **客户端入站连接**（`server.responses_ws.*`）——客户端 WS keep-open、连接数硬上限、帧大小上限。

同时补齐两个此前不存在的旋钮（`session_connect_timeout`、`pooled_connection_idle_timeout`）、统一 `0` 语义（absence=默认／`0`=禁用／正数=值）、让新旋钮真正影响新连接、让 PUT 写回归一化新键（不再每次加载都告警）、让配置热更新对**已存在**的 h2 session／WS 连接生效（而非只影响新连接），并把这些状态暴露到 `/api/status` + ui-v4。

## 架构（Architecture，已在 spec/ADR 定稿，计划层不重新决策）

三轴放置（D1）、单向依赖（D2：`timeouts.*` ×1.5 派生 undici 上限，但 per-model override 不传播到 undici）、`session_connect_timeout` 留在 h2 小节而非公共层（D3：单阶段超时，非总截止时间，代理路径最坏 2×）、WS 无 keepalive 键（D4：诚实表达能力边界——undici WS 在 Bun/Node 行为不同，见下方 `runtime-split`）、`0` 语义统一（D5）、ingress 整组迁移（D6）、热更新主动 reconcile（D7：基于 generation 的 retire-and-replace，而非 drain-then-replace）。

## 技术栈（Tech Stack）

不引入新依赖。沿用现有 Zod schema pipeline（`schema.ts` + `compat.ts` + `validation.ts`）、`yaml` 包的 `ConfigDocument`（`setIn`/`deleteIn` 保留注释）、`node:http2` + `undici`（`undici/index.js` 子路径，非裸 specifier）、`bun:test` + 项目 `test-isolation` skill 的 DI/临时目录约定。

## 全局约束（Global Constraints——逐字对齐 spec 项目级要求，每个 Task 必须遵守）

1. **`0` 语义在所有数值旋钮上必须一致**：absence（键不存在）= 使用 schema 默认值；显式 `0` = 该旋钮完全禁用（不套用任何内建 runtime 默认值）；正数 = 该值（按需做单位换算）。任何一处新增数值旋钮如果做不到这一点即视为未完成。
2. **新旋钮只影响新建连接**（P2 范围）；已存在连接受配置热更新影响是 P4 的专属职责，且必须是 **generation-based retire-and-replace**，不是 drain-then-replace（P1-P3 阶段严禁引入任何"等旧连接排空再建新连接"的逻辑）。
3. **每会话 active-stream 计数必须恰好递减一次（exactly-once）**，覆盖正常结束／错误／取消／headers 前失败／响应前中止／会话关闭或复位等所有路径——这是 P4 h2 reconcile 与既有 `http2-client.ts:243-261` 不变量的共同前提，实现前必须先枚举全部递减点。
4. **正在 retire 的会话的 PING／keepalive 定时器必须存活到 drain 完成**——保护正在进行中的长思考流；这是 `http2-client.ts:243-261` 已有不变量，P4 绝不能破坏它。
5. **SSOT-types**：任何新类型/接口在后端定义一次，ui-v4 通过 `~backend/*` re-export 消费，禁止在 ui-v4 侧重复定义或手写副本；P5 必须跑 `bun run typecheck:ui-v4` 验证。
6. **PUT 迁移绝不静默丢字段**：`upstream_transport`/`server` 新增顶层 section 必须被 `mergeConfigIntoDocument` 处理，否则被迁移的规范化值会在写回时消失（P3 专属职责，当前是已确认的真实缺口，见下方"跨阶段共享接口清单"）。
7. **经验验证（independent oracle）**：任何声称"新旋钮生效"的测试，必须观察真实连接行为变化（真实 socket/timer/池状态），不能只断言 `state.xxx` 被赋值——那只是"配置读取正确"，不是"配置生效"。
8. **测试隔离**：一律走 DI/临时目录/state 快照（`setStateForTests`+`autoRestoreState`、`useIsolatedRuntime`、`setHttp2SessionFactoryForTests`、`setUpstreamWsConnectionFactoryForTests`），绝不触碰真实 `$HOME` 或 4141 端口主服务器。
9. **细粒度提交**：每个 Task 完成后用显式 pathspec `git commit -F <msgfile> -- <精确路径>` 提交，conventional commits，不加模型署名。

## 阶段 DAG

```
P1 (config reorg + read-path + state split)
 ├──> P2 (新旋钮真接线：h2 connect timeout / WS idle timeout / undici keepalive 0-语义)
 │     └──> P4 (热更新 reconcile：generation retire-and-replace)
 │           └──> P5 (status/diagnostics + ui-v4)
 └──> P3 (PUT 文档级迁移写回)
```

- P2、P3 都只依赖 P1（可并行执行，无共享文件交集：P2 动 `http2-client.ts`/`upstream-ws-connection.ts`/`upstream-ws.ts`/`proxy.ts`/`transport/proxy-connect.ts`（仅 `connectViaHttpConnect`——D5 的 `0`=禁用语义要在 HTTP CONNECT 代理隧道路径下真正成立，见 plan-2 Task 1 Step 3；`connectViaSocks` 不在此列，其 `0` 处理走 P1 Task 3 附加范围 B8 的配置校验层拒绝）；P3 动 `compat.ts`（新增函数，非改已有签名）/`validation.ts`/`routes/config/route.ts`）。
- P4 依赖 P2（要 reconcile 的旋钮必须先真实接线），不依赖 P3。
- P5 依赖 P4（状态面板要展示 reconcile 观测量）。
- 是否让 P2/P3 由同一 executor 顺序做、还是拆两个并行 worktree，由主会话按当前编排资源决定；本计划不代为指派执行主体。

## 各阶段目标与交付物

| 阶段 | 目标 | 关键交付物 | 文件 |
|---|---|---|---|
| P1 | schema 新增三个 section + 6 条 legacy 迁移 + state.ts setter 拆分改名 + config.yaml/schema.json 重写 + 误导性 "Node-only" 注释修正 | legacy 键仍可加载(迁移+告警一次)，新键在 schema 里，运行时语义等价(除 D5 批准的 undici 0→15 例外) | [plan-1-config-reorg.md](./plan-1-config-reorg.md) |
| P2 | `session_connect_timeout`/`pooled_connection_idle_timeout` 真实接线到新连接；undici keepalive 0-语义修真（`keepAlive:false` 而非"省略 connect 选项让 undici 60s 默认生效"） | 新旋钮对新连接可观测生效 + 独立 oracle 验证 | [plan-2-new-knobs-wiring.md](./plan-2-new-knobs-wiring.md) |
| P3 | compat 层暴露"本次迁移了哪些 legacy 路径"；PUT 写回时先删旧路径、再按新路径写规范化值、`0→absence` 只删不写、清空后的空 section 一并删除、保留未涉节点的注释 | 管理 API 写回新键，二次加载/PUT 不再告警 | [plan-3-put-migration.md](./plan-3-put-migration.md) |
| P4 | 基于 generation 的 h2 session retire-and-replace；WS 池按 `idleSince` 重新调度空闲计时器；upstream WS 软上限（忙态转空闲再驱逐）与 client 硬上限分离处理 | 热更新对已存在连接生效，且不破坏 in-flight 长思考流 | [plan-4-hot-reload-reconcile.md](./plan-4-hot-reload-reconcile.md)（**已实施**，`feat/transport-config-reorg` 分支 `f17f2b1b`/`71839a43`） |
| P5 | D7 HIGH-7 可判定字段（configured generation+values / h2 sessions / upstream WS / reconcile 状态 / runtime capability）接入 `/api/status`；SSOT-types 经 `~backend/*` re-export 给 ui-v4 | 诊断可观测，`typecheck:ui-v4` 绿 | [plan-5-status-diagnostics.md](./plan-5-status-diagnostics.md)（**已实施**，`feat/transport-config-reorg` 分支 `0ba9b32b`/`bf5e994c`/`0cc7cb6d`/`65be50cf`——**本计划最后一相，P1-P5 全部落地**） |

## 承重不变量（跨阶段，任何阶段都不得违反）

- **`0` 语义一致性**（见上方全局约束 #1）——P1 定义 schema/state 层面的 0=禁用，P2 让 0 真正在 runtime 层面禁用（而非"省略选项让第三方库默认值生效"），P4 的 reconcile 也要正确处理"新值是 0"（禁用后不应残留旧定时器）。
- **retire-and-replace 而非 drain-then-replace**（全局约束 #2、#3、#4）——P4 专属，但 P1-P3 的任何代码都不能预先引入"等旧连接耗尽"式逻辑，避免和 P4 的设计冲突。
- **legacy 键 0→absence 特例**——`timeouts.upstream_keepalive: 0` 迁移时只删旧键、不写新键（让 schema 默认值 15 生效，这是 spec §7 批准的唯一"运行时语义改变"例外：undici 从"60s 内建默认"变成"15s 配置默认"）；其余 5 条迁移都是直接值搬运，运行时语义不变。
- **SSOT-types**（全局约束 #5）——只有 P5 新增跨端类型，且必须走 `~backend/*` re-export。

## 跨阶段共享接口清单（各阶段落笔前必读，保证类型/签名一致）

### P1 产出，P2/P3/P4 消费

**`src/lib/config/schema.ts` 新增导出**：
```ts
export const UpstreamTransportHttp2ConfigSchema = z.object({
  ping_interval: nullableNonnegativeInt(),
  session_connect_timeout: nullableNonnegativeInt(),
}).strict()

export const UpstreamTransportWebsocketConfigSchema = z.object({
  pooled_connection_idle_timeout: nullableNonnegativeInt(),
  soft_max_connections: nullableNonnegativeInt(),
}).strict()

export const UpstreamTransportConfigSchema = z.object({
  tcp_keepalive_probe_delay: nullableNonnegativeInt(),
  http2: nullableSection(UpstreamTransportHttp2ConfigSchema),
  websocket: nullableSection(UpstreamTransportWebsocketConfigSchema),
}).strict()

export const ResponsesWsIngressConfigSchema = z.object({
  keep_open: nullableBoolean(),
  max_connections: nullableNonnegativeInt(),
  max_frame_bytes: nullableNonnegativeInt(),
}).strict()

export const ServerConfigSchema = z.object({
  responses_ws: nullableSection(ResponsesWsIngressConfigSchema),
}).strict()
```
顶层 `ConfigSchema` 新增两个可选键：`upstream_transport: nullableSection(UpstreamTransportConfigSchema)`、`server: nullableSection(ServerConfigSchema)`。

**`src/lib/state.ts` 新增/改名**：
- `setUpstreamTransportConfig(patch: Partial<Pick<MutableState, "upstreamKeepaliveDelay" | "upstreamH2PingInterval" | "sessionConnectTimeout" | "pooledConnectionIdleTimeout" | "softMaxUpstreamWsConnections">>): void` —— 触发新监听器集合。
- `onUpstreamTransportChange(listener: () => void): () => void` —— 新监听器订阅函数（返回取消订阅函数，镜像 `onRequestWatchdogChange` 的既有签名形状）。
- `setResponsesWsIngressConfig(patch: Partial<Pick<MutableState, "clientWebsocketKeepOpen" | "maxWsFrameBytes" | "maxClientWsConnections">>): void` —— 纯 `updateState`，无监听器。
- `setTimeoutConfig` 收窄为 `Partial<Pick<MutableState, "responseHeaderTimeout" | "streamIdleTimeout" | "staleRequestMaxAge" | "modelRefreshInterval">>`，`transportChanged` 门控只保留 `responseHeaderTimeout`/`streamIdleTimeout`。
- **`onTransportTimeoutChange` 改名为 `onRequestWatchdogChange`（`transportTimeoutListeners` 同步改名为 `requestWatchdogListeners`）**——spec §6 相邻正确化第 2 条 + §7 验收「旧符号 `onTransportTimeoutChange` 零残留」均已明确要求改名，不因"拆分后它已经不再管 TCP keepalive、语义自洽"而豁免（P1 起草阶段一度以此为由保留原名，经 gpt reviewer 对抗审查 + 用户裁决判定不成立：spec 白纸黑字要求改名，不是"名字凑巧还说得通就不用改"）。新名 `onRequestWatchdogChange` 对齐 D1 轴名"请求生命周期看门狗"（`timeouts.*`）。P1 必须做到**旧符号零残留**：函数体、`transportTimeoutListeners` 集合、所有 import/调用点（`proxy.ts` 订阅处、测试文件）全部同步改名，`grep -rn "onTransportTimeoutChange\|transportTimeoutListeners" src/ tests/` 在 P1 提交后必须零命中。
- `MutableState` 新增字段：`sessionConnectTimeout: number`（秒，0=禁用）、`pooledConnectionIdleTimeout: number`（秒，0=禁用）、`softMaxUpstreamWsConnections: number`（0=无上限，替代 `maxUpstreamWsConnections` 的角色，字段直接改名）。
- `CONFIG_MANAGED_DEFAULTS` 新增：`sessionConnectTimeout: 10`、`pooledConnectionIdleTimeout: 300`、`softMaxUpstreamWsConnections: 32`（值等于旧 `maxUpstreamWsConnections` 默认）。

**`proxy.ts` 订阅点**：`ensureTimeoutSubscription()` 必须同时订阅 `onRequestWatchdogChange`（app 看门狗变化，改名后的新符号）与 `onUpstreamTransportChange`（TCP keepalive 变化），二者任一触发都要 `rebuildUpstreamDispatcher()`——这是 P1 必须改到位的接线，否则 P2 的 undici keepalive 0-语义修复在热更新时不会生效。

### P2 产出，P4 消费

- `src/lib/transport/http2-client.ts` 导出 `getSessionConnectTimeoutMs(): number`（0=禁用，不设超时）。
- `src/lib/openai/upstream-ws.ts` 导出 `getPooledConnectionIdleTimeoutMs(): number`（0=禁用，永不 idle-timeout）；`createUpstreamWsManager` 的 `create()` 调用 `connectionFactory` 时新增 `idleTimeoutMs: getPooledConnectionIdleTimeoutMs()` 入参。**导出（非私有函数）是用户裁决锁定的结论**：P4 的 `rescheduleIdleTimeout`/reconcile 复用同一个函数计算新 idle deadline，避免重复实现 `state.pooledConnectionIdleTimeout * 1000` 换算逻辑（DRY）；plan-2 早前把这一点记录为"若主会话有不同偏好可能收窄为私有函数"的开放项，现已裁决为定案，不再是待定项。
- `src/lib/openai/upstream-ws-connection.ts`：`UpstreamWsConnection` 接口新增 `rescheduleIdleTimeout(newIdleTimeoutMs: number): void` 方法（P4 专用；P2 只需保证 `idleTimeoutMs` 从 state 读取，P4 才真正调用重调度）。

### P3 产出（不影响 P2/P4，独立分支）

- `src/lib/config/compat.ts` 新增导出：
  ```ts
  export interface ConfigMigrationApplyResult {
    value: Record<string, unknown>
    legacyPathsRemoved: ReadonlyArray<string>
  }
  export function extractAndTranslateDeprecatedWithOps(raw: Record<string, unknown>): ConfigMigrationApplyResult
  ```
- `src/lib/config/validation.ts`：`ConfigValidationResult` 的 `valid: true` 分支新增 `legacyPathsRemoved: ReadonlyArray<string>` 字段；`validateConfig`/`validateConfigInput` 内部改用 `extractAndTranslateDeprecatedWithOps`（老的 `extractAndTranslateDeprecated` 私有函数删除，避免逻辑分叉）。
- `src/routes/config/route.ts`：`mergeConfigIntoDocument` 新增对 `upstream_transport`/`server` 顶层键的处理；PUT handler 在调用 `mergeConfigIntoDocument` 前先按 `validation.legacyPathsRemoved` 删除 YAML doc 里的旧路径，并清理因此变空的父节点。

### P4 产出，P5 消费

- `src/lib/transport/http2-client.ts` 新增导出：
  ```ts
  export interface H2SessionStatusRow {
    origin: string
    generation: number
    lifecycle: "active" | "retiring"
    activeStreamCount: number
    effectivePingIntervalMs: number
    effectiveKeepAliveMs: number | undefined
  }
  export function getH2SessionStatusSnapshot(): ReadonlyArray<H2SessionStatusRow>
  export function getH2ReconcileStatus(): { state: "idle" | "running" | "failed"; lastCompletedGeneration: number; lastError: string | null }
  ```
- `src/lib/openai/upstream-ws.ts` 新增导出：
  ```ts
  export interface UpstreamWsStatusRow {
    key: string
    model: string
    state: "connecting" | "busy" | "idle"
    generation: number
  }
  export function getUpstreamWsStatusSnapshot(manager: UpstreamWsManager): ReadonlyArray<UpstreamWsStatusRow>
  export interface UpstreamWsReconcileStatus {
    state: "idle" | "running" | "failed"
    lastCompletedGeneration: number
    lastError: string | null
  }
  export function getUpstreamWsReconcileStatus(manager: UpstreamWsManager): UpstreamWsReconcileStatus
  ```
  `UpstreamWsReconcileStatus` 是合并态审查 major 修复后追加的对称契约——`getH2ReconcileStatus()` 早已给 h2 侧提供 reconcile-run 可观测性（`idle`/`running`/`failed`），但 WS 侧最初只有 `reconcileForConfigChange()` 本身且**无 never-throw 守卫**，违反 spec §4 D7 HIGH-3（三个 transport 订阅者共享 state.ts 同一个无 try/catch 的 listener 循环，任一订阅者抛错会静默跳过其后注册的订阅者）。修复把 `reconcileForConfigChange()` 主体包 try/catch（catch 记录失败状态 + `consola.error`、绝不 re-throw，逐字镜像 h2 侧既有实现），并新增 `UpstreamWsManager.reconcileStatus()` 方法 + `getUpstreamWsReconcileStatus(manager)` 自由函数暴露该状态，供 P5 与 `getH2ReconcileStatus()` 对称渲染两个 transport 的 reconcile 健康度。

以上签名在各阶段计划文档中保持逐字一致；如某阶段执行中发现必须偏离，须先回来更新本节，不得在单阶段文档里私自改名。

**`UpstreamWsStatusRow.state` 的 `"connecting"`（非 `"active"`）是 reviewer + 用户裁决的强制改名**：`H2SessionStatusRow.lifecycle` 的 `"active"` 语义是"已建立、可路由"，而 WS 侧原计划的 `"active"` 却表示"尚未建立"——两个同名字面量在同一状态面板里含义互反，是明显的 footgun。裁决=WS 侧改用 `"connecting"` 消除反义；映射规则不变：`!isOpen → "connecting"`，`isOpen && isBusy → "busy"`，`isOpen && !isBusy → "idle"`。P4（实现+测试）、P5（mock/Badge 渲染/过滤/API 测试）须逐字同步这个改名，不得残留 `"active"` 作为 WS 状态字面量。

## 自审记录（本计划落笔前的 spec 覆盖检查）

- spec §4 D1-D7：D1→P1 schema 布局；D2→P1 state 拆分 + proxy.ts 双订阅点；D3→P1 schema 归属 h2 小节 + P2 真实接线；D4→P1（WS section 无 keepalive 键，只有 idle timeout/soft cap）；D5→P1 schema 层 + P2 runtime 层双落地；D6→P1 compat 迁移；D7→P4 全部。
- spec §5 迁移表 6 条 legacy 键：全部在 P1 Task 中逐条落地为 `renameLeaf` 调用（含 0→absence 特例）；BLOCK-2 PUT 机制在 P3 全部覆盖。
- spec §6 adjacent 更正（誤导性 "Node-only" 注释、`upstream-ws-attempt.ts:141` 文档更正）：并入 P1 的收尾 Task。
- spec §7 验收：等价性 golden-fixture 测试、独立 oracle、`0` 语义全面一致、热更新可观测性、runtime-split 不引入假分叉、注释扫描无遗留——分别映射进 P1（等价性+注释）/P2（独立 oracle）/P4（热更新可观测）/P5（状态面板）。

## 发现的 spec 缺口 / 需主会话裁决的分叉

见 [plan-kickoff.md](./plan-kickoff.md) 末尾"待主会话裁决"一节——本计划已按"最小合理假设"把这些缺口填平并在各 Task 里注明依据，若主会话不认可假设，仅需替换对应 Task 的具体字段名/默认值，不影响整体阶段结构。
