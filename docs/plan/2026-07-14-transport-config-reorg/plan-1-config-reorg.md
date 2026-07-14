# Plan 1 — Config 重组 + 读路径迁移 + state 拆分

> 归属：`docs/plan/2026-07-14-transport-config-reorg/README.md` 阶段 P1。上游：[spec](../../spec/2026-07-14-upstream-transport-config-reorg.md) §4 D1/D2/D3/D4/D6、§5 迁移表、§6 相邻修正；[ADR](../../decisions/2026-07-14-transport-config-three-axis-organization.md)。

## Goal

把 `timeouts.upstream_keepalive` / `timeouts.upstream_h2_ping` / `openai_responses.client_ws_keep_open` / `openai_responses.max_ws_frame_bytes` / `openai_responses.max_client_ws_connections` / `openai_responses.max_upstream_ws_connections` 六个旧键迁移进新的三轴归位（`upstream_transport.*` / `server.responses_ws.*`），补齐 `session_connect_timeout`（h2 段）与 `pooled_connection_idle_timeout`（websocket 段）两个尚不存在旋钮的 schema/state 骨架（P2 才接线到真实连接），拆分 `state.ts` 的 `setTimeoutConfig`/`setResponsesConfig` 使三轴的订阅通知互不干扰，并顺带修正 `upstreamH2PingInterval` 变化不触发热重载监听器的既有疏漏。本阶段**不改**任何连接建立/使用逻辑（P2 职责），**不改** PUT 写回（P3 职责），**不改**热重载 reconcile（P4 职责）。

## Architecture

三轴归位（ADR D1）：请求生命周期 watchdog 留在 `timeouts.*`（协议无关）；上游出向连接配置移入新顶层 `upstream_transport.*`（按协议分 `http2`/`websocket` 子段，`tcp_keepalive_probe_delay` 是 TCP 层公共项留在顶层）；客户端面向的入向 WS 配置移入新顶层 `server.responses_ws.*`（D6 整组迁移）。`session_connect_timeout` 留在 `upstream_transport.http2.*` 而非公共段（D3：这是单次分阶段连接建立上限，非总请求期限，代理路径最坏 2×，且只对 h2 传输有意义）。D5：新旋钮与既有旋钮一律遵守「absence=默认值 / `0`=禁用 / 正数=值」，包括为 `tcp_keepalive_probe_delay` 保留的 legacy `0→absence` 迁移特例。本阶段不触及 D7（热重载 reconcile，P4）。

## Tech Stack

不引入新依赖。沿用 Zod v4 pipeline（`schema.ts` 当前形状 + `compat.ts` 迁移 + `validation.ts` 两段式安全解析）、`bun:test` + 项目 `test-isolation` 骨架（`tests/helpers/isolated-fixture.ts` 的 `PATHS` 临时目录模式，见 `timeout-guardrail.unit.test.ts`）、`bun run generate:config-schema` 重新生成 `config.schema.json`。

## Global Constraints（摘自 README，逐字对齐）

1. `0` 语义在所有数值旋钮上必须一致（absence=默认 / `0`=禁用 / 正数=值）。
2. 新旋钮只影响新建连接（P2 范围）；本阶段新增的 `sessionConnectTimeout`/`pooledConnectionIdleTimeout`/`softMaxUpstreamWsConnections` 三个 state 字段在 P1 完成时**尚未被任何连接代码读取**——这是有意的分阶段留白，Task 5 会显式记录。
3. 每会话 active-stream 计数必须恰好递减一次（P4 职责，本阶段不涉及）。
4. 正在 retire 的会话的 PING/keepalive 定时器必须存活到 drain 完成（P4 职责，本阶段不涉及）。
5. SSOT-types：本阶段不新增跨前后端类型（P5 职责）。
6. PUT 迁移绝不静默丢字段：本阶段新增的 `upstream_transport`/`server` 顶层键，P3 必须能被 `mergeConfigIntoDocument` 处理——Task 8 在收尾时显式标注这个交接点，供 plan-3 的 Task 1 核对。
7. 经验验证：本阶段是纯 schema/state/config-apply 改动，无连接行为可观测——用 schema round-trip + state 快照断言作为本阶段的 oracle（P2 才需要连接级独立 oracle）。
8. 测试隔离：一律走 `PATHS.APP_DIR`/`PATHS.CONFIG_YAML` 临时目录重定向 + `resetConfigCache()`/`resetApplyState()`/`resetConfigManagedState()`，绝不碰真实 `$HOME` 或 4141 端口主服务器。
9. 细粒度提交：每个 Task 完成后用 `git commit -F <msgfile> -- <精确路径>` 提交。

## 文件总览

| 文件 | 改动 |
|---|---|
| `src/lib/config/schema.ts` | 新增 `UpstreamTransportHttp2ConfigSchema`/`UpstreamTransportWebsocketConfigSchema`/`UpstreamTransportConfigSchema`/`ResponsesWsIngressConfigSchema`/`ServerConfigSchema`；`TimeoutsConfigSchema` 移除 `upstream_keepalive`/`upstream_h2_ping`；`ResponsesConfigSchema` 移除 `client_ws_keep_open`/`max_ws_frame_bytes`/`max_client_ws_connections`/`max_upstream_ws_connections`；顶层 `ConfigSchema` 新增 `upstream_transport`/`server` |
| `src/lib/config/compat.ts` | `CONFIG_MIGRATIONS` 末尾追加 6 条迁移规则 |
| `src/lib/state.ts` | `MutableState` 新增 3 字段；拆分 `setTimeoutConfig`（收窄）+ 新增 `setUpstreamTransportConfig`/`onUpstreamTransportChange`；拆分 `setResponsesConfig`（收窄）+ 新增 `setResponsesWsIngressConfig`；`CONFIG_MANAGED_DEFAULTS` 补 3 个新默认值；`resetConfigManagedState()` 同步改写调用点 |
| `src/lib/config/config.ts` | `applyConfigToState()` 里 `config.timeouts`/`responsesConfig` 分支拆分改写，新增 `config.upstream_transport`/`config.server` 分支 |
| `src/lib/proxy.ts` | `ensureTimeoutSubscription()` 同时订阅 `onUpstreamTransportChange`；范围受限修正 keepalive/h2-ping JSDoc 里的"Node-only"措辞 |
| `config.yaml` | 迁移六个旧键的注释块到新位置；新增 `session_connect_timeout`/`pooled_connection_idle_timeout` 的注释占位（值留空，走 schema 默认） |
| `config.schema.json` | `bun run generate:config-schema` 重新生成（机械，无需手写 diff） |
| `tests/config/config-compat.unit.test.ts` | 追加 6 条迁移用例 |
| `tests/config/config-schema-json-export.unit.test.ts` | 追加新顶层键出现在 JSON Schema 的断言 |
| 新增 `tests/config/transport-config-state.unit.test.ts` | `setUpstreamTransportConfig`/`onUpstreamTransportChange`/`setResponsesWsIngressConfig` 的行为测试 |

---

## Task 1 — schema.ts：新增 upstream_transport 三段 Zod schema

**Files**
- Modify: `src/lib/config/schema.ts`（在 `TimeoutsConfigSchema` 定义之后、`// ==== Top-level Config schema ====` 分隔线之前插入新 schema；约在现有第 818 行之后）

**Interfaces**
- Produces：`UpstreamTransportHttp2ConfigSchema`（Zod object）、`UpstreamTransportWebsocketConfigSchema`（Zod object）、`UpstreamTransportConfigSchema`（Zod object）—— 均导出供 Task 4（顶层挂载）、Task 6（state 拆分注释交叉引用）、plan-2/plan-4 的类型引用使用。
- 类型别名：`export type UpstreamTransportConfig = z.infer<typeof UpstreamTransportConfigSchema>`。

**Steps**

1. 写失败测试：在 `tests/config/config-schema-json-export.unit.test.ts` 追加一个新 `test`，断言顶层 JSON Schema 里存在 `upstream_transport` 且其 `http2`/`websocket` 子段字段名正确（此测试此刻会失败，因为 schema 还没有这个键）。

```ts
test("upstream_transport section: http2 + websocket sub-sections with expected leaf keys", () => {
  const json = toJsonSchema()
  const upstreamTransport = pickObjectSchema((json.properties as Record<string, unknown>).upstream_transport)
  const utProps = upstreamTransport.properties as Record<string, unknown>
  expect(utProps.tcp_keepalive_probe_delay).toBeDefined()

  const http2 = pickObjectSchema(utProps.http2)
  const http2Props = http2.properties as Record<string, unknown>
  expect(http2Props.ping_interval).toBeDefined()
  expect(http2Props.session_connect_timeout).toBeDefined()

  const websocket = pickObjectSchema(utProps.websocket)
  const wsProps = websocket.properties as Record<string, unknown>
  expect(wsProps.pooled_connection_idle_timeout).toBeDefined()
  expect(wsProps.soft_max_connections).toBeDefined()
})
```

2. 跑 `bun test tests/config/config-schema-json-export.unit.test.ts` 确认新增用例失败（`upstream_transport` 为 `undefined`），其余既有用例仍通过。

3. 在 `src/lib/config/schema.ts` 里，紧接 `TimeoutsConfigSchema` 定义（第 818 行 `.strict()` 之后）插入：

```ts
export const UpstreamTransportHttp2ConfigSchema = z
  .object({
    /** Upstream HTTP/2 PING keepalive interval in seconds (0 = disabled). Same semantics as the migrated `timeouts.upstream_h2_ping`. Default 15. Works on both Bun and Node (node:http2 transport is runtime-neutral). */
    ping_interval: nullableNonnegativeInt(),
    /**
     * TCP connect + TLS handshake deadline in seconds for a single h2 session
     * establishment attempt (0 = no timeout). This is a per-attempt connect
     * ceiling, NOT a total request deadline — a proxied connection tunnels a
     * pre-TLS socket then layers TLS, so the worst case is up to 2x this value
     * (connect-to-proxy + TLS-through-tunnel). See
     * docs/decisions/2026-07-14-transport-config-three-axis-organization.md D3.
     * Default 10 (mirrors the previous hardcoded CONNECT_TIMEOUT_MS).
     */
    session_connect_timeout: nullableNonnegativeInt(),
  })
  .strict()
export type UpstreamTransportHttp2Config = z.infer<typeof UpstreamTransportHttp2ConfigSchema>

export const UpstreamTransportWebsocketConfigSchema = z
  .object({
    /**
     * Idle timeout in seconds for a pooled (not-in-use) upstream Responses WS
     * connection before it is proactively closed (0 = never idle-close).
     * Default 300 (mirrors the previous hardcoded DEFAULT_IDLE_TIMEOUT_MS = 5min).
     */
    pooled_connection_idle_timeout: nullableNonnegativeInt(),
    /** Soft cap on upstream WS pool size (default 32; 0 = unlimited). Was `openai_responses.max_upstream_ws_connections`. */
    soft_max_connections: nullableNonnegativeInt(),
  })
  .strict()
export type UpstreamTransportWebsocketConfig = z.infer<typeof UpstreamTransportWebsocketConfigSchema>

/**
 * `upstream_transport.*` — outbound connection behavior toward the GHC upstream,
 * organized by protocol (D1 three-axis reorg). Distinct from `timeouts.*`
 * (protocol-agnostic request-lifecycle watchdogs) and `server.responses_ws.*`
 * (inbound client-facing WS ingress limits).
 */
export const UpstreamTransportConfigSchema = z
  .object({
    /** Upstream TCP keepalive initial-probe delay in seconds (0 = use undici/Node default, NOT "disabled" — see compat.ts migration for the legacy 0→absence special case). Was `timeouts.upstream_keepalive`. Default 15. Works on both Bun and Node. */
    tcp_keepalive_probe_delay: nullableNonnegativeInt(),
    http2: nullableSection(UpstreamTransportHttp2ConfigSchema),
    websocket: nullableSection(UpstreamTransportWebsocketConfigSchema),
  })
  .strict()
export type UpstreamTransportConfig = z.infer<typeof UpstreamTransportConfigSchema>
```

   注意：`tcp_keepalive_probe_delay` 的字段注释与既有 `timeouts.upstream_keepalive` 的语义不同——旧字段注释写的是"0 = use undici default 60s"（即 0 也是"禁用显式配置，走 undici 内置默认"），新字段延续同一语义但**不再叫"disabled"**，因为 D5 统一语义后 `0` 必须真正表示"disabled"（P2 会把 undici `connect` 选项改成显式 `keepAlive:false`）。此处只重组 schema 位置，不改变值的解释——值解释的变化在 P2 处理，schema 层保持字段类型/默认值不变（仍是 `nullableNonnegativeInt()`，默认 15）。

4. 跑 `bun test tests/config/config-schema-json-export.unit.test.ts` —— 此时仍会失败（顶层 `ConfigSchema` 还没挂 `upstream_transport` 键），留到 Task 4 完成后再转绿；本步骤只是把 schema 定义本身写出来，不急于让顶层测试通过。跑 `bun run typecheck` 确认新增的类型定义本身不产生编译错误（此时 `UpstreamTransportConfigSchema` 未被引用会有 `noUnusedLocals` 风险——若报错，在文件顶部保留 export，typecheck 应该视其为已使用的导出，不会报未使用）。

5. `git add -- src/lib/config/schema.ts tests/config/config-schema-json-export.unit.test.ts && git commit -F <msgfile> -- src/lib/config/schema.ts tests/config/config-schema-json-export.unit.test.ts`，提交信息：`feat(config): add UpstreamTransportConfigSchema (http2 + websocket sub-sections)`。

---

## Task 2 — schema.ts：新增 server.responses_ws 段，从 TimeoutsConfigSchema/ResponsesConfigSchema 摘除旧字段

**Files**
- Modify: `src/lib/config/schema.ts`

**Interfaces**
- Produces：`ResponsesWsIngressConfigSchema`、`ServerConfigSchema`、对应类型别名。
- Modifies：`TimeoutsConfigSchema`（移除 `upstream_keepalive`/`upstream_h2_ping`）、`ResponsesConfigSchema`（移除 `client_ws_keep_open`/`max_ws_frame_bytes`/`max_client_ws_connections`/`max_upstream_ws_connections`）。

**Steps**

1. 写失败测试：在 `config-schema-json-export.unit.test.ts` 追加：

```ts
test("server.responses_ws section holds the migrated client-facing WS ingress limits", () => {
  const json = toJsonSchema()
  const server = pickObjectSchema((json.properties as Record<string, unknown>).server)
  const serverProps = server.properties as Record<string, unknown>
  const responsesWs = pickObjectSchema(serverProps.responses_ws)
  const rwsProps = responsesWs.properties as Record<string, unknown>
  expect(rwsProps.keep_open).toBeDefined()
  expect(rwsProps.max_frame_bytes).toBeDefined()
  expect(rwsProps.max_connections).toBeDefined()
})

test("timeouts section no longer carries upstream_keepalive / upstream_h2_ping (moved to upstream_transport)", () => {
  const json = toJsonSchema()
  const timeouts = pickObjectSchema((json.properties as Record<string, unknown>).timeouts)
  const timeoutsProps = timeouts.properties as Record<string, unknown>
  expect(timeoutsProps.upstream_keepalive).toBeUndefined()
  expect(timeoutsProps.upstream_h2_ping).toBeUndefined()
})

test("openai_responses no longer carries the WS ingress / upstream-ws-cap fields (moved out)", () => {
  const json = toJsonSchema()
  const responses = pickObjectSchema((json.properties as Record<string, unknown>).openai_responses)
  const responsesProps = responses.properties as Record<string, unknown>
  expect(responsesProps.client_ws_keep_open).toBeUndefined()
  expect(responsesProps.max_ws_frame_bytes).toBeUndefined()
  expect(responsesProps.max_client_ws_connections).toBeUndefined()
  expect(responsesProps.max_upstream_ws_connections).toBeUndefined()
})
```

2. 跑测试确认三个新用例中，`server.responses_ws` 相关的失败（section 不存在），`timeouts`/`openai_responses` 相关的**此刻会通过**（因为旧字段仍在——这两个断言是 Task 2 步骤 3 完成后才会从"通过"变成继续通过，实际验证的是移除动作；先记录这一步的真实起点：先跑一次确认这两个断言当前是 FAIL，因为旧字段还在，`toBeUndefined()` 判定失败）。

3. 编辑 `TimeoutsConfigSchema`（第 787-818 行），删除 `upstream_keepalive`/`upstream_h2_ping` 两个字段：

```ts
export const TimeoutsConfigSchema = z
  .object({
    /** Max seconds between SSE events (0 = no timeout). Was top-level `stream_idle_timeout`. */
    stream_idle: nullableNonnegativeInt(),
    /** Max seconds from request start to receiving HTTP response headers (0 = no timeout). Was top-level `fetch_timeout`. */
    response_header: nullableNonnegativeInt(),
    /**
     * Per-model stream-idle timeout override (seconds), keyed by model-name
     * substring with `"*"` wildcard. A match wins over `stream_idle`; 0 = disabled.
     * Bundled default `{ gpt-5.5: 600 }`. Per-key merged with the user table
     * (a user `{}` does NOT wipe the bundled entry). App-guard only — does not
     * touch the undici dispatcher. See ADR 2026-07-12-per-model-idle-timeout-is-app-guard-only.
     */
    stream_idle_overrides: StreamIdleOverridesSchema.nullable()
      .transform((v): z.infer<typeof StreamIdleOverridesSchema> | undefined => v ?? undefined)
      .optional(),
    /**
     * Per-model response-header (first-byte) timeout override (seconds), same
     * keying/merge semantics as `stream_idle_overrides`. A match wins over
     * `response_header`; 0 = disabled. Bundled default `{}` (no built-in value).
     */
    response_header_overrides: ResponseHeaderOverridesSchema.nullable()
      .transform((v): z.infer<typeof ResponseHeaderOverridesSchema> | undefined => v ?? undefined)
      .optional(),
    /** Max seconds an active request may live before the stale reaper forces failure (0 = disabled). Was top-level `stale_request_max_age`. */
    stale_request_max_age: nullableNonnegativeInt(),
  })
  .strict()
```

   （`upstream_keepalive`/`upstream_h2_ping` 两行连同各自的 JSDoc 注释整段删除；其余字段顺序、注释原样保留。）

4. 编辑 `ResponsesConfigSchema`（第 661-687 行），删除 `client_ws_keep_open`/`max_ws_frame_bytes`/`max_client_ws_connections`/`max_upstream_ws_connections` 四个字段：

```ts
export const ResponsesConfigSchema = z
  .object({
    normalize_call_ids: nullableBoolean(),
    upstream_ws: nullableBoolean(),
    /**
     * Opt-in mid-stream buffered retry for the Responses SSE/HTTP path (default false; Codex
     * auto-retry is opt-in). Accepts a bare boolean (`enabled` shorthand) or a map
     * `{ enabled, max_retries, buffer_cap_bytes, heartbeat_sec }` whose caps override the
     * shared top-level `buffered_retry.*` for this vendor (see resolveBufferedCaps).
     */
    buffered_retry: nullableBufferedRetry(),
    fix_stream_ids: nullableBoolean(),
    /**
     * Strip the `image_generation` builtin tool from inbound Responses
     * requests. The Copilot upstream rejects it (failing the whole request),
     * and some clients (e.g. Codex CLI) auto-inject it. Default false.
     */
    strip_image_generation_tool: nullableBoolean(),
  })
  .strict()
```

5. 紧接 `ResponsesConfigSchema` 定义之后插入新 `ResponsesWsIngressConfigSchema` 与 `ServerConfigSchema`（后者先只含 `responses_ws` 一个子段，为未来其他 `server.*` 子段留出扩展空间）：

```ts
/**
 * `server.responses_ws.*` — inbound client-facing Responses WebSocket ingress
 * limits (D6: moved out of `openai_responses.*` as a whole group, since these
 * govern the DOWNSTREAM client connection, not the upstream GHC connection —
 * distinct axis from `upstream_transport.websocket.*`).
 */
export const ResponsesWsIngressConfigSchema = z
  .object({
    /** Keep the client WS connection open across turns instead of closing after each response. Was `openai_responses.client_ws_keep_open`. Default false. */
    keep_open: nullableBoolean(),
    /** Optional cap on inbound WS frame bytes (default 0 = unlimited; set positive to opt into a hard cap). Was `openai_responses.max_ws_frame_bytes`. */
    max_frame_bytes: nullableNonnegativeInt(),
    /** Max concurrent client WS connections (default 256; 0 = unlimited). Was `openai_responses.max_client_ws_connections`. */
    max_connections: nullableNonnegativeInt(),
  })
  .strict()
export type ResponsesWsIngressConfig = z.infer<typeof ResponsesWsIngressConfigSchema>

/** `server.*` — inbound/ingress-facing server configuration (currently just `responses_ws`). */
export const ServerConfigSchema = z
  .object({
    responses_ws: nullableSection(ResponsesWsIngressConfigSchema),
  })
  .strict()
export type ServerConfig = z.infer<typeof ServerConfigSchema>
```

6. 跑 `bun test tests/config/config-schema-json-export.unit.test.ts` —— `timeouts`/`openai_responses` 移除断言此刻应转绿；`server.responses_ws` 断言仍失败（顶层 `ConfigSchema` 还没挂 `server` 键，留到 Task 4）。

7. `git commit -F <msgfile> -- src/lib/config/schema.ts tests/config/config-schema-json-export.unit.test.ts`，提交信息：`refactor(config): extract server.responses_ws ingress schema out of openai_responses/timeouts`。

---

## Task 3 — schema.ts：顶层 ConfigSchema 挂载 upstream_transport / server

**Files**
- Modify: `src/lib/config/schema.ts`（第 920-982 行区间的 `ConfigSchema` 定义）

**Steps**

1. （沿用 Task 1/2 已写的失败断言，此步骤让它们转绿。）在 `ConfigSchema` 定义里，`timeouts: nullableSection(TimeoutsConfigSchema),` 一行之后插入两个新键：

```ts
    timeouts: nullableSection(TimeoutsConfigSchema),
    upstream_transport: nullableSection(UpstreamTransportConfigSchema),
    server: nullableSection(ServerConfigSchema),
    telemetry: nullableSection(TelemetryConfigSchema),
```

   （即在既有 `timeouts` 与 `telemetry` 两行之间插入新的两行，其余字段顺序不变。）

2. 跑 `bun test tests/config/config-schema-json-export.unit.test.ts` —— 全部（含 Task 1/2 遗留的失败用例）应全部转绿。

3. 跑 `bun run typecheck` 确认无编译错误（此时 `applyConfigToState`/`state.ts` 尚未消费新字段，`Config` 类型的新增可选字段不会破坏任何既有调用点，因为 TS 结构化类型下新增可选属性向后兼容）。

4. 跑 `bun test tests/config/` 全量确认没有其他既有测试因为 schema 形状变化而回归（预期：`config-strict-parse.unit.test.ts`/`bundled-config.unit.test.ts` 等如果硬编码列举了 `timeouts`/`openai_responses` 的字段列表可能需要关注，但不修改，仅观察输出；若有意外失败记录到本 Task 的执行笔记里，留给下一 Task 排查而非跳过）。

5. `git commit -F <msgfile> -- src/lib/config/schema.ts`，提交信息：`feat(config): mount upstream_transport + server sections onto top-level ConfigSchema`。

---

## Task 4 — compat.ts：追加 6 条迁移规则（含 0→absence 特例）

**Files**
- Modify: `src/lib/config/compat.ts`（`CONFIG_MIGRATIONS` 数组末尾，紧接现有最后一条 `migrateValue("anthropic.stream_keepalive_mode", ...)` 之后）
- Modify: `tests/config/config-compat.unit.test.ts`（追加用例）

**Interfaces**
- 全部使用已有的 `renameLeaf`/`removeKey` builder，无需新增 builder 函数。

**Steps**

1. 写失败测试，追加到 `tests/config/config-compat.unit.test.ts` 末尾（`describe` 块内，紧邻现有测试之后）：

```ts
  test("timeouts.upstream_keepalive → upstream_transport.tcp_keepalive_probe_delay", () => {
    const result = validateConfig({ timeouts: { upstream_keepalive: 20 } })
    expect(result.upstream_transport?.tcp_keepalive_probe_delay).toBe(20)
    expect((result.timeouts as Record<string, unknown> | undefined)?.upstream_keepalive).toBeUndefined()
    expect(warnedMessages().some((m) => m.includes("upstream_keepalive"))).toBe(true)
  })

  test("timeouts.upstream_keepalive: 0 migrates to absence (not tcp_keepalive_probe_delay: 0) so the new default (15) applies", () => {
    const result = validateConfig({ timeouts: { upstream_keepalive: 0 } })
    expect(result.upstream_transport?.tcp_keepalive_probe_delay).toBeUndefined()
    expect((result.timeouts as Record<string, unknown> | undefined)?.upstream_keepalive).toBeUndefined()
    expect(warnedMessages().some((m) => m.includes("upstream_keepalive"))).toBe(true)
  })

  test("timeouts.upstream_h2_ping → upstream_transport.http2.ping_interval", () => {
    const result = validateConfig({ timeouts: { upstream_h2_ping: 30 } })
    expect(result.upstream_transport?.http2?.ping_interval).toBe(30)
    expect((result.timeouts as Record<string, unknown> | undefined)?.upstream_h2_ping).toBeUndefined()
  })

  test("openai_responses.client_ws_keep_open → server.responses_ws.keep_open", () => {
    const result = validateConfig({ openai_responses: { client_ws_keep_open: true } })
    expect(result.server?.responses_ws?.keep_open).toBe(true)
    expect((result.openai_responses as Record<string, unknown> | undefined)?.client_ws_keep_open).toBeUndefined()
  })

  test("openai_responses.max_ws_frame_bytes → server.responses_ws.max_frame_bytes", () => {
    const result = validateConfig({ openai_responses: { max_ws_frame_bytes: 65536 } })
    expect(result.server?.responses_ws?.max_frame_bytes).toBe(65536)
  })

  test("openai_responses.max_client_ws_connections → server.responses_ws.max_connections", () => {
    const result = validateConfig({ openai_responses: { max_client_ws_connections: 128 } })
    expect(result.server?.responses_ws?.max_connections).toBe(128)
  })

  test("openai_responses.max_upstream_ws_connections → upstream_transport.websocket.soft_max_connections", () => {
    const result = validateConfig({ openai_responses: { max_upstream_ws_connections: 64 } })
    expect(result.upstream_transport?.websocket?.soft_max_connections).toBe(64)
    expect((result.openai_responses as Record<string, unknown> | undefined)?.max_upstream_ws_connections).toBeUndefined()
  })

  test("multiple upstream_transport.http2 legacy leaves accumulate into one sub-section", () => {
    const result = validateConfig({ timeouts: { upstream_keepalive: 12, upstream_h2_ping: 8 } })
    expect(result.upstream_transport?.tcp_keepalive_probe_delay).toBe(12)
    expect(result.upstream_transport?.http2?.ping_interval).toBe(8)
  })
```

2. 跑 `bun test tests/config/config-compat.unit.test.ts` 确认新增 8 个用例全部失败（`CONFIG_MIGRATIONS` 还没有这些规则，`result.upstream_transport` 恒为 `undefined`）。

3. 在 `src/lib/config/compat.ts` 的 `CONFIG_MIGRATIONS` 数组末尾（紧接现有最后一条 `migrateValue("anthropic.stream_keepalive_mode", ...)`，数组闭合 `]` 之前）追加：

```ts
  // ── Transport config three-axis reorg (2026-07-14) ────────────────────────
  // timeouts.upstream_keepalive → upstream_transport.tcp_keepalive_probe_delay.
  // Special-cased 0→absence: the legacy field's 0 meant "let undici/Node pick
  // its own default" (NOT "disable keepalive"), which is exactly what an absent
  // new key means post-migration (schema default 15 applies only via absence;
  // migrating literal 0 forward would collide with the NEW field's disable
  // semantics established by D5). `transform` returning `undefined` skips the
  // merge entirely while the locator still deletes+warns the legacy key.
  renameLeaf("timeouts.upstream_keepalive", "upstream_transport.tcp_keepalive_probe_delay", {
    transform: (v) => (typeof v === "number" && v > 0 ? v : undefined),
    message: "timeouts.upstream_keepalive is renamed to upstream_transport.tcp_keepalive_probe_delay; a legacy value of 0 is migrated to absence (falls back to the new default) since 0 previously meant \"use the runtime default\", not \"disable\"",
  }),
  renameLeaf("timeouts.upstream_h2_ping", "upstream_transport.http2.ping_interval", {
    message: "timeouts.upstream_h2_ping is renamed to upstream_transport.http2.ping_interval",
  }),
  renameLeaf("openai_responses.client_ws_keep_open", "server.responses_ws.keep_open", {
    message: "openai_responses.client_ws_keep_open is renamed to server.responses_ws.keep_open (client-facing WS ingress config moved under server.*)",
  }),
  renameLeaf("openai_responses.max_ws_frame_bytes", "server.responses_ws.max_frame_bytes", {
    message: "openai_responses.max_ws_frame_bytes is renamed to server.responses_ws.max_frame_bytes",
  }),
  renameLeaf("openai_responses.max_client_ws_connections", "server.responses_ws.max_connections", {
    message: "openai_responses.max_client_ws_connections is renamed to server.responses_ws.max_connections",
  }),
  renameLeaf("openai_responses.max_upstream_ws_connections", "upstream_transport.websocket.soft_max_connections", {
    message: "openai_responses.max_upstream_ws_connections is renamed to upstream_transport.websocket.soft_max_connections (upstream-facing pool cap moved under upstream_transport.*)",
  }),
```

4. 跑 `bun test tests/config/config-compat.unit.test.ts` 确认全部转绿；跑 `bun test tests/config/` 全量确认无回归。

5. `bunx eslint src/lib/config/compat.ts tests/config/config-compat.unit.test.ts` 无缓存检查通过。

6. `git commit -F <msgfile> -- src/lib/config/compat.ts tests/config/config-compat.unit.test.ts`，提交信息：`feat(config): migrate 6 legacy transport/ws keys to the three-axis layout`。

---

## Task 5 — state.ts：拆分 setTimeoutConfig / 新增 setUpstreamTransportConfig + onUpstreamTransportChange

**Files**
- Modify: `src/lib/state.ts`（`MutableState` 接口第 693-706 行区间；`setTimeoutConfig`/`onTransportTimeoutChange` 第 1418-1447 行区间；`CONFIG_MANAGED_DEFAULTS` 第 1656-1657 行区间；`resetConfigManagedState()` 第 1788-1794 行区间）
- 新增: `tests/config/transport-config-state.unit.test.ts`

**Interfaces**
- Produces（须与 README「跨阶段共享接口清单」逐字一致）：
  ```ts
  export function setUpstreamTransportConfig(
    patch: Partial<
      Pick<
        MutableState,
        "upstreamKeepaliveDelay" | "upstreamH2PingInterval" | "sessionConnectTimeout" | "pooledConnectionIdleTimeout" | "softMaxUpstreamWsConnections"
      >
    >,
  ): void
  export function onUpstreamTransportChange(listener: () => void): () => void
  ```
- Modifies：`setTimeoutConfig` 的 patch 类型收窄为 `Partial<Pick<MutableState, "responseHeaderTimeout" | "streamIdleTimeout" | "staleRequestMaxAge" | "modelRefreshInterval">>`（移除 `upstreamKeepaliveDelay` | `upstreamH2PingInterval`）。

**Steps**

1. 写失败测试：新建 `tests/config/transport-config-state.unit.test.ts`：

```ts
/**
 * setUpstreamTransportConfig / onUpstreamTransportChange — the split-out
 * upstream-transport-axis state setter (three-axis config reorg, plan-1 Task 5).
 * Mirrors the existing pattern for setTimeoutConfig / onTransportTimeoutChange.
 */
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  onUpstreamTransportChange,
  setUpstreamTransportConfig,
  state,
} from "~/lib/state"

describe("setUpstreamTransportConfig / onUpstreamTransportChange", () => {
  let unsubscribe: (() => void) | undefined

  afterEach(() => {
    unsubscribe?.()
    unsubscribe = undefined
    // restore defaults so this file never leaks state into siblings
    setUpstreamTransportConfig({
      upstreamKeepaliveDelay: 15,
      upstreamH2PingInterval: 15,
      sessionConnectTimeout: 10,
      pooledConnectionIdleTimeout: 300,
      softMaxUpstreamWsConnections: 32,
    })
  })

  test("updates state fields", () => {
    setUpstreamTransportConfig({ sessionConnectTimeout: 20 })
    expect(state.sessionConnectTimeout).toBe(20)
  })

  test("upstreamH2PingInterval change notifies onUpstreamTransportChange listeners (fixes a pre-existing gap where setTimeoutConfig never notified on this field)", () => {
    let notified = 0
    unsubscribe = onUpstreamTransportChange(() => {
      notified += 1
    })
    setUpstreamTransportConfig({ upstreamH2PingInterval: 25 })
    expect(notified).toBe(1)
  })

  test("sessionConnectTimeout / pooledConnectionIdleTimeout / softMaxUpstreamWsConnections changes also notify", () => {
    let notified = 0
    unsubscribe = onUpstreamTransportChange(() => {
      notified += 1
    })
    setUpstreamTransportConfig({ sessionConnectTimeout: 5 })
    setUpstreamTransportConfig({ pooledConnectionIdleTimeout: 60 })
    setUpstreamTransportConfig({ softMaxUpstreamWsConnections: 8 })
    expect(notified).toBe(3)
  })

  test("setting the same value again does NOT notify (change-detection, mirrors setTimeoutConfig behavior)", () => {
    let notified = 0
    setUpstreamTransportConfig({ sessionConnectTimeout: 10 })
    unsubscribe = onUpstreamTransportChange(() => {
      notified += 1
    })
    setUpstreamTransportConfig({ sessionConnectTimeout: 10 })
    expect(notified).toBe(0)
  })

  test("unsubscribe stops further notifications", () => {
    let notified = 0
    unsubscribe = onUpstreamTransportChange(() => {
      notified += 1
    })
    unsubscribe()
    setUpstreamTransportConfig({ sessionConnectTimeout: 30 })
    expect(notified).toBe(0)
    unsubscribe = undefined
  })
})
```

2. 跑 `bun test tests/config/transport-config-state.unit.test.ts` 确认失败（模块未导出 `setUpstreamTransportConfig`/`onUpstreamTransportChange`，导入报错）。

3. 编辑 `MutableState` 接口（第 693-706 行附近），在 `upstreamH2PingInterval` 字段之后追加三个新字段：

```ts
  readonly upstreamKeepaliveDelay: number
  /* ... existing JSDoc unchanged ... */
  readonly upstreamH2PingInterval: number
  /**
   * TCP connect + TLS handshake deadline (seconds) for a single h2 session
   * establishment attempt. Was the hardcoded `CONNECT_TIMEOUT_MS` in
   * http2-client.ts; wired to real connection attempts in Plan 2. Default 10.
   */
  readonly sessionConnectTimeout: number
  /**
   * Idle timeout (seconds) for a pooled upstream Responses WS connection
   * before proactive close. Was the hardcoded `DEFAULT_IDLE_TIMEOUT_MS` in
   * upstream-ws-connection.ts; wired to real connections in Plan 2. Default 300.
   */
  readonly pooledConnectionIdleTimeout: number
  /**
   * Soft cap on concurrent upstream WS connections. Renamed from
   * `maxUpstreamWsConnections` (same semantics: 0 = unlimited) as part of the
   * upstream_transport.websocket.* reorg. Default 32.
   */
  readonly softMaxUpstreamWsConnections: number
```

   （原有 `upstreamKeepaliveDelay`/`upstreamH2PingInterval` 两行的既有 JSDoc **保留不动**，只在其后追加三个新字段声明。)

4. 编辑 `setTimeoutConfig`（第 1418-1434 行），收窄 patch 类型、移除 upstream 相关变更检测：

```ts
export function setTimeoutConfig(
  patch: Partial<Pick<MutableState, "responseHeaderTimeout" | "streamIdleTimeout" | "staleRequestMaxAge" | "modelRefreshInterval">>,
): void {
  const transportChanged =
    patch.responseHeaderTimeout !== undefined && patch.responseHeaderTimeout !== mutableState.responseHeaderTimeout
    || (patch.streamIdleTimeout !== undefined && patch.streamIdleTimeout !== mutableState.streamIdleTimeout)
  updateState(patch)
  if (transportChanged) {
    for (const listener of transportTimeoutListeners) listener()
  }
}
```

   （移除对 `upstreamKeepaliveDelay` 的比较条件——它不再是这个函数的 patch 类型成员；`transportTimeoutListeners` 集合本身、`onTransportTimeoutChange` 函数保持不变，proxy.ts 仍然订阅它来响应 `responseHeaderTimeout`/`streamIdleTimeout` 变化。）

5. 紧接 `onTransportTimeoutChange` 定义（第 1444-1447 行）之后，新增 `setUpstreamTransportConfig` + `transportUpstreamListeners` + `onUpstreamTransportChange`：

```ts
/**
 * Upstream-transport-axis config setter — the outbound-connection counterpart
 * to `setTimeoutConfig` (protocol-agnostic request watchdogs) and
 * `setResponsesWsIngressConfig` (inbound client-facing WS limits). Notifies
 * `onUpstreamTransportChange` listeners on ANY tracked field change, including
 * `upstreamH2PingInterval` — a pre-existing gap in the old combined
 * `setTimeoutConfig` (upstreamH2PingInterval changes never notified
 * `transportTimeoutListeners`) that this split fixes as a side effect.
 */
export function setUpstreamTransportConfig(
  patch: Partial<
    Pick<
      MutableState,
      "upstreamKeepaliveDelay" | "upstreamH2PingInterval" | "sessionConnectTimeout" | "pooledConnectionIdleTimeout" | "softMaxUpstreamWsConnections"
    >
  >,
): void {
  const changed =
    (patch.upstreamKeepaliveDelay !== undefined && patch.upstreamKeepaliveDelay !== mutableState.upstreamKeepaliveDelay)
    || (patch.upstreamH2PingInterval !== undefined && patch.upstreamH2PingInterval !== mutableState.upstreamH2PingInterval)
    || (patch.sessionConnectTimeout !== undefined && patch.sessionConnectTimeout !== mutableState.sessionConnectTimeout)
    || (patch.pooledConnectionIdleTimeout !== undefined && patch.pooledConnectionIdleTimeout !== mutableState.pooledConnectionIdleTimeout)
    || (patch.softMaxUpstreamWsConnections !== undefined && patch.softMaxUpstreamWsConnections !== mutableState.softMaxUpstreamWsConnections)
  updateState(patch)
  if (changed) {
    for (const listener of transportUpstreamListeners) listener()
  }
}

/** Subscribers notified after a hot-reload changes any `setUpstreamTransportConfig` field. Plan 2/4 (proxy.ts, http2-client.ts, upstream-ws*.ts) subscribe here to rebuild connections/reschedule timers. */
const transportUpstreamListeners = new Set<() => void>()

export function onUpstreamTransportChange(listener: () => void): () => void {
  transportUpstreamListeners.add(listener)
  return () => transportUpstreamListeners.delete(listener)
}
```

6. 编辑 `CONFIG_MANAGED_DEFAULTS`（第 1656-1657 行附近），在 `upstreamH2PingInterval: 15,` 之后追加三个新默认值：

```ts
  upstreamKeepaliveDelay: 15,
  upstreamH2PingInterval: 15,
  sessionConnectTimeout: 10,
  pooledConnectionIdleTimeout: 300,
  softMaxUpstreamWsConnections: 32,
```

7. 编辑 `resetConfigManagedState()` 里调用 `setTimeoutConfig({...})` 的那段（第 1788-1794 行），把 `upstreamKeepaliveDelay`/`upstreamH2PingInterval` 移出这次调用，改为紧接着的一次 `setUpstreamTransportConfig({...})` 调用：

```ts
  setTimeoutConfig({
    responseHeaderTimeout: CONFIG_MANAGED_DEFAULTS.responseHeaderTimeout,
    streamIdleTimeout: CONFIG_MANAGED_DEFAULTS.streamIdleTimeout,
    staleRequestMaxAge: CONFIG_MANAGED_DEFAULTS.staleRequestMaxAge,
    modelRefreshInterval: CONFIG_MANAGED_DEFAULTS.modelRefreshInterval,
  })
  setUpstreamTransportConfig({
    upstreamKeepaliveDelay: CONFIG_MANAGED_DEFAULTS.upstreamKeepaliveDelay,
    upstreamH2PingInterval: CONFIG_MANAGED_DEFAULTS.upstreamH2PingInterval,
    sessionConnectTimeout: CONFIG_MANAGED_DEFAULTS.sessionConnectTimeout,
    pooledConnectionIdleTimeout: CONFIG_MANAGED_DEFAULTS.pooledConnectionIdleTimeout,
    softMaxUpstreamWsConnections: CONFIG_MANAGED_DEFAULTS.softMaxUpstreamWsConnections,
  })
```

8. 找到 `mutableState` 初始化对象字面量里 `upstreamKeepaliveDelay: CONFIG_MANAGED_DEFAULTS.upstreamKeepaliveDelay,`（第 1938 行附近）与 `upstreamH2PingInterval: CONFIG_MANAGED_DEFAULTS.upstreamH2PingInterval,`（第 1939 行）两行之后，追加三个新字段的初始赋值：

```ts
  upstreamKeepaliveDelay: CONFIG_MANAGED_DEFAULTS.upstreamKeepaliveDelay,
  upstreamH2PingInterval: CONFIG_MANAGED_DEFAULTS.upstreamH2PingInterval,
  sessionConnectTimeout: CONFIG_MANAGED_DEFAULTS.sessionConnectTimeout,
  pooledConnectionIdleTimeout: CONFIG_MANAGED_DEFAULTS.pooledConnectionIdleTimeout,
  softMaxUpstreamWsConnections: CONFIG_MANAGED_DEFAULTS.softMaxUpstreamWsConnections,
```

   （注意：这是 `mutableState` 变量的初始字面量，不是 `resetConfigManagedState()` 函数体——两处都需要改，否则进程刚启动时 `state.sessionConnectTimeout` 是 `undefined` 而非默认值 10。用 `grep -n "upstreamH2PingInterval: CONFIG_MANAGED_DEFAULTS" src/lib/state.ts` 确认改到了两个出现点，而不是只改了其中一个。）

9. 跑 `bun test tests/config/transport-config-state.unit.test.ts` 确认全部转绿。跑 `bun run typecheck` 确认无编译错误。

10. 跑 `bun test tests/` 全量（不加 `--cache`，本项目 `lint:all`/关键测试均不使用缓存）确认无回归，特别关注任何直接构造 `MutableState` 字面量或 `setTimeoutConfig({upstreamKeepaliveDelay: ...})`/`setTimeoutConfig({upstreamH2PingInterval: ...})` 调用点的测试文件（`grep -rn "setTimeoutConfig(" src/ tests/` 逐个确认调用参数不再包含这两个字段——若有遗漏的调用点，TypeScript 编译期就会报类型错误，因为 patch 类型已收窄，不会是静默的运行时 bug）。

11. `bunx eslint src/lib/state.ts tests/config/transport-config-state.unit.test.ts` 无缓存检查通过。

12. `git commit -F <msgfile> -- src/lib/state.ts tests/config/transport-config-state.unit.test.ts`，提交信息：`feat(state): split setUpstreamTransportConfig out of setTimeoutConfig; fix upstreamH2PingInterval missing change notification`。

---

## Task 6 — state.ts：拆分 setResponsesConfig / 新增 setResponsesWsIngressConfig

**Files**
- Modify: `src/lib/state.ts`（`MutableState` 第 774/798/805/812 行区间的字段名保持不变，只调整哪个 setter 拥有它们；`setResponsesConfig` 第 1449-1466 行区间；`CONFIG_MANAGED_DEFAULTS`/`resetConfigManagedState()`/`mutableState` 初始字面量里 `clientWebsocketKeepOpen`/`maxWsFrameBytes`/`maxClientWsConnections`/`maxUpstreamWsConnections` 四处出现点）

**Interfaces**
- Produces：
  ```ts
  export function setResponsesWsIngressConfig(
    patch: Partial<Pick<MutableState, "clientWebsocketKeepOpen" | "maxWsFrameBytes" | "maxClientWsConnections">>,
  ): void
  ```
- Modifies：`setResponsesConfig` patch 类型收窄为 `Partial<Pick<MutableState, "normalizeResponsesCallIds" | "upstreamWebSocket" | "responsesBufferedRetry" | "fixResponsesStreamIds" | "stripImageGenerationTool">>`（移除 `clientWebsocketKeepOpen` | `maxWsFrameBytes` | `maxClientWsConnections` | `maxUpstreamWsConnections`）。
- **注意**：`maxUpstreamWsConnections` 字段本身在 Task 5 里已经**新增**为 `softMaxUpstreamWsConnections`（属于 `setUpstreamTransportConfig`），不属于本 Task 的 `setResponsesWsIngressConfig`——本 Task 只处理 `clientWebsocketKeepOpen`/`maxWsFrameBytes`/`maxClientWsConnections` 三个字段的迁移；但 `maxUpstreamWsConnections` 这个**旧字段名**仍然存在于 `MutableState` 里（Task 5 未删除它，只是新增了 `softMaxUpstreamWsConnections`）——本 Task 的 Step 3 会把 `MutableState` 里的 `maxUpstreamWsConnections` 字段**改名**为 `softMaxUpstreamWsConnections` 的唯一权威定义点，避免两个字段并存造成消费者读错的风险；`upstream-ws.ts` 的 `state.maxUpstreamWsConnections` 读取点在 Plan 2 Task 1 里统一改名为 `state.softMaxUpstreamWsConnections`。

**Steps**

1. 写失败测试：追加到 `tests/config/transport-config-state.unit.test.ts` 末尾新增一个 `describe` 块：

```ts
describe("setResponsesWsIngressConfig", () => {
  afterEach(() => {
    setResponsesWsIngressConfig({ clientWebsocketKeepOpen: false, maxWsFrameBytes: 0, maxClientWsConnections: 256 })
  })

  test("updates state fields", () => {
    setResponsesWsIngressConfig({ clientWebsocketKeepOpen: true })
    expect(state.clientWebsocketKeepOpen).toBe(true)
  })

  test("setResponsesConfig no longer accepts clientWebsocketKeepOpen/maxWsFrameBytes/maxClientWsConnections (compile-time narrowing, smoke-tested via runtime shape)", () => {
    // Runtime smoke test standing in for the compile-time guarantee: passing only
    // the fields still owned by setResponsesConfig must not throw and must not
    // touch the WS-ingress fields.
    const before = state.clientWebsocketKeepOpen
    setResponsesConfig({ normalizeResponsesCallIds: true })
    expect(state.clientWebsocketKeepOpen).toBe(before)
    setResponsesConfig({ normalizeResponsesCallIds: false })
  })
})
```

   同时在文件顶部 import 列表追加 `setResponsesConfig, setResponsesWsIngressConfig,`。

2. 跑 `bun test tests/config/transport-config-state.unit.test.ts` 确认新增用例失败（`setResponsesWsIngressConfig` 未导出）。

3. 编辑 `setResponsesConfig`（第 1449-1466 行），收窄 patch 类型：

```ts
export function setResponsesConfig(
  patch: Partial<
    Pick<MutableState, "normalizeResponsesCallIds" | "upstreamWebSocket" | "responsesBufferedRetry" | "fixResponsesStreamIds" | "stripImageGenerationTool">
  >,
): void {
  updateState(patch)
}
```

4. 紧接其后新增 `setResponsesWsIngressConfig`：

```ts
/**
 * Client-facing Responses WS ingress config — split out of `setResponsesConfig`
 * (server.responses_ws.* three-axis reorg). Distinct from `setUpstreamTransportConfig`'s
 * `softMaxUpstreamWsConnections` (that governs the OUTBOUND upstream WS pool cap;
 * this governs INBOUND client connection limits).
 */
export function setResponsesWsIngressConfig(
  patch: Partial<Pick<MutableState, "clientWebsocketKeepOpen" | "maxWsFrameBytes" | "maxClientWsConnections">>,
): void {
  updateState(patch)
}
```

5. 在 `MutableState` 接口里，把第 812 行的 `readonly maxUpstreamWsConnections: number` 改名为 `readonly softMaxUpstreamWsConnections: number`（沿用其既有 JSDoc 注释，只改字段名）——**这与 Task 5 Step 3 新增的字段是同一个字段的唯一定义**（Task 5 的 Step 3 描述里提到的"追加三个新字段"实际只新增 `sessionConnectTimeout`/`pooledConnectionIdleTimeout` 两个真正新增字段；`softMaxUpstreamWsConnections` 是本 Task 通过**改名**旧 `maxUpstreamWsConnections` 得到的，不是重复声明）。

   **执行顺序修正**：因为 Task 5 的描述里把 `softMaxUpstreamWsConnections` 也列进了 `setUpstreamTransportConfig` 的 Pick 类型和 `CONFIG_MANAGED_DEFAULTS`/初始字面量新增块，而该字段的**接口声明改名**实际发生在本 Task，执行者须按以下顺序合并两个 Task 的改动，避免出现"字段声明缺失"的编译错误：
   - 在 Task 5 Step 3 编辑 `MutableState` 接口时，**只**追加 `sessionConnectTimeout`/`pooledConnectionIdleTimeout` 两个字段（不追加 `softMaxUpstreamWsConnections`，因为它是改名而非新增）。
   - 在本 Task 的这一步（Step 5），把已存在的 `readonly maxUpstreamWsConnections: number` 原地改名为 `readonly softMaxUpstreamWsConnections: number`。
   - Task 5 里所有引用 `softMaxUpstreamWsConnections` 的代码（`setUpstreamTransportConfig` 的 Pick 类型、`CONFIG_MANAGED_DEFAULTS`、`resetConfigManagedState()`、`mutableState` 初始字面量）在改名完成之前会编译失败（引用了尚不存在的字段名）——这是预期的中间态：Task 5 提交时这些引用点已经写好但字段还叫 `maxUpstreamWsConnections`，`bun run typecheck` 在 Task 5 末尾会报错；**执行者应当把 Task 5 Step 3 和本 Task 的 Step 5 合并成一次连续编辑再跑 typecheck**（即：先完整应用 Task 5 的 `MutableState` 追加 + 本 Task 的改名，再跑一次 `bun run typecheck`），Task 5 的"跑 typecheck 确认无编译错误"这一步实际上要等本 Task 完成后才能真正转绿——**在 Task 5 执行时，若 typecheck 报 `softMaxUpstreamWsConnections` 不存在，属已知的跨 Task 依赖，继续往下执行本 Task 的 Step 5 完成改名，不要在 Task 5 停下排查**。

6. 更新 `CONFIG_MANAGED_DEFAULTS` 里的 `maxUpstreamWsConnections: 32,`（第 1685 行）改名为 `softMaxUpstreamWsConnections: 32,`（若 Task 5 Step 6 已经追加了同名新键，删除重复，只保留一个）。

7. 更新 `resetConfigManagedState()` 里 `setResponsesConfig({...})` 调用块（第 1827-1836 行），移除 `clientWebsocketKeepOpen`/`maxWsFrameBytes`/`maxClientWsConnections`/`maxUpstreamWsConnections` 四行，改为：

```ts
  setResponsesConfig({
    normalizeResponsesCallIds: CONFIG_MANAGED_DEFAULTS.normalizeResponsesCallIds,
    upstreamWebSocket: CONFIG_MANAGED_DEFAULTS.upstreamWebSocket,
    responsesBufferedRetry: CONFIG_MANAGED_DEFAULTS.responsesBufferedRetry,
    fixResponsesStreamIds: CONFIG_MANAGED_DEFAULTS.fixResponsesStreamIds,
    stripImageGenerationTool: CONFIG_MANAGED_DEFAULTS.stripImageGenerationTool,
  })
  setResponsesWsIngressConfig({
    clientWebsocketKeepOpen: CONFIG_MANAGED_DEFAULTS.clientWebsocketKeepOpen,
    maxWsFrameBytes: CONFIG_MANAGED_DEFAULTS.maxWsFrameBytes,
    maxClientWsConnections: CONFIG_MANAGED_DEFAULTS.maxClientWsConnections,
  })
```

   （`softMaxUpstreamWsConnections` 的重置已经在 Task 5 Step 7 的 `setUpstreamTransportConfig({...})` 调用块里处理，不在此处重复。）

8. 更新 `mutableState` 初始字面量里 `maxUpstreamWsConnections: CONFIG_MANAGED_DEFAULTS.maxUpstreamWsConnections,`（第 1952 行）改名为 `softMaxUpstreamWsConnections: CONFIG_MANAGED_DEFAULTS.softMaxUpstreamWsConnections,`（若 Task 5 Step 8 已追加同名行，删除重复）。

9. `grep -rn "maxUpstreamWsConnections" src/` 确认所有剩余引用点——预期唯一剩下的引用是 `src/lib/openai/upstream-ws.ts` 第 331 行的 `maxConnections: () => state.maxUpstreamWsConnections`，这个改名留给 Plan 2 Task 1（该文件的改动属于"新旋钮真实接线"范畴，本 Task 只负责 state.ts 侧的改名，不跨阶段改 upstream-ws.ts）。**在本 Task 完成时，这一个残留引用点会导致 `bun run typecheck` 报错**（字段不存在）——这是一个刻意的跨阶段边界：由于 `state.maxUpstreamWsConnections` 被整体改名而 Plan 2 尚未开始，**本 Task 额外允许**在 `upstream-ws.ts` 的这一行做一次最小改名（仅改 `state.maxUpstreamWsConnections` → `state.softMaxUpstreamWsConnections`，不改其他任何逻辑），使 P1 阶段结束时整个仓库 typecheck 保持绿色；Plan 2 Task 1 会在此基础上继续接线 `pooledConnectionIdleTimeout`。

10. 跑 `bun run typecheck` 确认全绿；跑 `bun test tests/config/transport-config-state.unit.test.ts` 确认全部转绿；跑 `bun test tests/` 全量确认无回归（重点关注 `tests/responses/` 目录下任何直接调用 `setResponsesConfig({maxUpstreamWsConnections:...})` 或 `setResponsesConfig({clientWebsocketKeepOpen:...})` 等旧签名的测试文件，`grep -rn "setResponsesConfig(" tests/` 逐个确认）。

11. `bunx eslint src/lib/state.ts src/lib/openai/upstream-ws.ts tests/config/transport-config-state.unit.test.ts` 无缓存检查通过。

12. `git commit -F <msgfile> -- src/lib/state.ts src/lib/openai/upstream-ws.ts tests/config/transport-config-state.unit.test.ts`，提交信息：`refactor(state): split setResponsesWsIngressConfig out of setResponsesConfig; rename maxUpstreamWsConnections to softMaxUpstreamWsConnections`。

---

## Task 7 — config.ts：applyConfigToState() 接线新 schema 到新 setter

**Files**
- Modify: `src/lib/config/config.ts`（第 850-869 行 `config.timeouts` 分支；第 886-903 行 `responsesConfig` 分支）
- 新增: `tests/config/transport-config-apply.unit.test.ts`

**Steps**

1. 写失败测试，新建 `tests/config/transport-config-apply.unit.test.ts`（沿用 `timeout-guardrail.unit.test.ts` 的临时目录脚手架模式）：

```ts
/**
 * applyConfigToState() wiring for the three-axis transport config reorg —
 * config.upstream_transport.* / config.server.responses_ws.* must reach the
 * matching state setters (plan-1 Task 7).
 */
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  //
  applyConfigToState,
  resetApplyState,
  resetConfigCache,
  setBundledConfigForTests,
} from "~/lib/config/config"
import { PATHS } from "~/lib/config/paths"
import { state } from "~/lib/state"

let tmpDir: string
let savedAppDir: string
let savedConfigYaml: string

async function writeConfig(content: string): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
  await fs.writeFile(PATHS.CONFIG_YAML, content, "utf8")
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "transport-config-apply-"))
  savedAppDir = PATHS.APP_DIR
  savedConfigYaml = PATHS.CONFIG_YAML
  ;(PATHS as { APP_DIR: string }).APP_DIR = tmpDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = path.join(tmpDir, "config.yaml")
  resetConfigCache()
  resetApplyState()
  setBundledConfigForTests({})
})

afterEach(async () => {
  ;(PATHS as { APP_DIR: string }).APP_DIR = savedAppDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = savedConfigYaml
  await fs.rm(tmpDir, { recursive: true, force: true })
  resetConfigCache()
  resetApplyState()
  setBundledConfigForTests(null)
})

describe("applyConfigToState — upstream_transport.* / server.responses_ws.*", () => {
  test("upstream_transport.tcp_keepalive_probe_delay reaches state.upstreamKeepaliveDelay", async () => {
    await writeConfig("upstream_transport:\n  tcp_keepalive_probe_delay: 22\n")
    await applyConfigToState()
    expect(state.upstreamKeepaliveDelay).toBe(22)
  })

  test("upstream_transport.http2.ping_interval reaches state.upstreamH2PingInterval", async () => {
    await writeConfig("upstream_transport:\n  http2:\n    ping_interval: 33\n")
    await applyConfigToState()
    expect(state.upstreamH2PingInterval).toBe(33)
  })

  test("upstream_transport.http2.session_connect_timeout reaches state.sessionConnectTimeout", async () => {
    await writeConfig("upstream_transport:\n  http2:\n    session_connect_timeout: 7\n")
    await applyConfigToState()
    expect(state.sessionConnectTimeout).toBe(7)
  })

  test("upstream_transport.websocket.pooled_connection_idle_timeout reaches state.pooledConnectionIdleTimeout", async () => {
    await writeConfig("upstream_transport:\n  websocket:\n    pooled_connection_idle_timeout: 120\n")
    await applyConfigToState()
    expect(state.pooledConnectionIdleTimeout).toBe(120)
  })

  test("upstream_transport.websocket.soft_max_connections reaches state.softMaxUpstreamWsConnections", async () => {
    await writeConfig("upstream_transport:\n  websocket:\n    soft_max_connections: 9\n")
    await applyConfigToState()
    expect(state.softMaxUpstreamWsConnections).toBe(9)
  })

  test("server.responses_ws.keep_open reaches state.clientWebsocketKeepOpen", async () => {
    await writeConfig("server:\n  responses_ws:\n    keep_open: true\n")
    await applyConfigToState()
    expect(state.clientWebsocketKeepOpen).toBe(true)
  })

  test("server.responses_ws.max_frame_bytes reaches state.maxWsFrameBytes", async () => {
    await writeConfig("server:\n  responses_ws:\n    max_frame_bytes: 4096\n")
    await applyConfigToState()
    expect(state.maxWsFrameBytes).toBe(4096)
  })

  test("server.responses_ws.max_connections reaches state.maxClientWsConnections", async () => {
    await writeConfig("server:\n  responses_ws:\n    max_connections: 12\n")
    await applyConfigToState()
    expect(state.maxClientWsConnections).toBe(12)
  })
})
```

2. 跑 `bun test tests/config/transport-config-apply.unit.test.ts` 确认全部失败（新 schema 字段没有被 `applyConfigToState` 消费，state 字段保持默认值而非测试里写的值）。

3. 编辑 `src/lib/config/config.ts` 里的 `config.timeouts` 分支（第 850-869 行区间），移除 `t.upstream_keepalive`/`t.upstream_h2_ping` 两行，新增 `config.upstream_transport` 分支：

```ts
  if (config.timeouts) {
    const t = config.timeouts
    if (t.response_header !== undefined) setTimeoutConfig({ responseHeaderTimeout: t.response_header })
    if (t.stream_idle !== undefined) setTimeoutConfig({ streamIdleTimeout: t.stream_idle })
    if (t.stale_request_max_age !== undefined) setTimeoutConfig({ staleRequestMaxAge: t.stale_request_max_age })
    // ... existing stream_idle_overrides / response_header_overrides via setTimeoutOverridesConfig unchanged ...
  }
  if (config.model_refresh_interval !== undefined) setTimeoutConfig({ modelRefreshInterval: config.model_refresh_interval })

  const upstreamTransport = config.upstream_transport
  if (upstreamTransport) {
    if (upstreamTransport.tcp_keepalive_probe_delay !== undefined)
      setUpstreamTransportConfig({ upstreamKeepaliveDelay: upstreamTransport.tcp_keepalive_probe_delay })
    if (upstreamTransport.http2?.ping_interval !== undefined) setUpstreamTransportConfig({ upstreamH2PingInterval: upstreamTransport.http2.ping_interval })
    if (upstreamTransport.http2?.session_connect_timeout !== undefined)
      setUpstreamTransportConfig({ sessionConnectTimeout: upstreamTransport.http2.session_connect_timeout })
    if (upstreamTransport.websocket?.pooled_connection_idle_timeout !== undefined)
      setUpstreamTransportConfig({ pooledConnectionIdleTimeout: upstreamTransport.websocket.pooled_connection_idle_timeout })
    if (upstreamTransport.websocket?.soft_max_connections !== undefined)
      setUpstreamTransportConfig({ softMaxUpstreamWsConnections: upstreamTransport.websocket.soft_max_connections })
  }
```

   （只展示改动涉及的行；`stream_idle_overrides`/`response_header_overrides` 经 `setTimeoutOverridesConfig` 的既有代码原样保留，不在此 diff 范围内。）

4. 编辑 `responsesConfig` 分支（第 886-903 行区间），移除 `client_ws_keep_open`/`max_ws_frame_bytes`/`max_client_ws_connections`/`max_upstream_ws_connections` 四行，新增 `config.server` 分支：

```ts
  const responsesConfig = config.openai_responses
  if (responsesConfig && responsesConfig.normalize_call_ids !== undefined) setResponsesConfig({ normalizeResponsesCallIds: responsesConfig.normalize_call_ids })
  if (responsesConfig && responsesConfig.upstream_ws !== undefined) setResponsesConfig({ upstreamWebSocket: responsesConfig.upstream_ws })
  if (responsesConfig && responsesConfig.buffered_retry !== undefined) {
    applyVendorBufferedRetry(responsesConfig.buffered_retry, "responses", (enabled) => setResponsesConfig({ responsesBufferedRetry: enabled }))
  }
  if (responsesConfig && responsesConfig.fix_stream_ids !== undefined) setResponsesConfig({ fixResponsesStreamIds: responsesConfig.fix_stream_ids })
  if (responsesConfig && responsesConfig.strip_image_generation_tool !== undefined)
    setResponsesConfig({ stripImageGenerationTool: responsesConfig.strip_image_generation_tool })

  const responsesWsIngress = config.server?.responses_ws
  if (responsesWsIngress) {
    if (responsesWsIngress.keep_open !== undefined) setResponsesWsIngressConfig({ clientWebsocketKeepOpen: responsesWsIngress.keep_open })
    if (responsesWsIngress.max_frame_bytes !== undefined) setResponsesWsIngressConfig({ maxWsFrameBytes: responsesWsIngress.max_frame_bytes })
    if (responsesWsIngress.max_connections !== undefined) setResponsesWsIngressConfig({ maxClientWsConnections: responsesWsIngress.max_connections })
  }
```

5. 在 `src/lib/config/config.ts` 顶部 import 区块里追加 `setResponsesWsIngressConfig, setUpstreamTransportConfig,` 到既有 `import { ... } from "~/lib/state"` 语句里（与 `setTimeoutConfig`/`setResponsesConfig` 同一条 import）。

6. 跑 `bun test tests/config/transport-config-apply.unit.test.ts` 确认全部转绿；跑 `bun run typecheck` 全绿；跑 `bun test tests/config/` 全量确认无回归（特别是 `config-hot-reload.it.test.ts`——它可能断言了旧的 `timeouts.upstream_keepalive`/`openai_responses.client_ws_keep_open` 热重载路径，若失败，按新路径改写断言而非跳过，记录在本 Task 的执行笔记里）。

7. `bunx eslint src/lib/config/config.ts tests/config/transport-config-apply.unit.test.ts` 无缓存检查通过。

8. `git commit -F <msgfile> -- src/lib/config/config.ts tests/config/transport-config-apply.unit.test.ts`，提交信息：`feat(config): wire upstream_transport.* / server.responses_ws.* into applyConfigToState`。

---

## Task 8 — proxy.ts 订阅接线 + Node-only 注释修正 + config.yaml/config.schema.json 收尾

**Files**
- Modify: `src/lib/proxy.ts`（`ensureTimeoutSubscription()` 第 228-232 行区间；`getUpstreamKeepAliveDelayMs`/`getUpstreamH2PingIntervalMs` 附近 JSDoc）
- Modify: `src/lib/config/schema.ts`（`tcp_keepalive_probe_delay`/`ping_interval` 字段注释，若仍残留"Node-only"措辞）
- Modify: `src/lib/state.ts`（`upstreamKeepaliveDelay`/`upstreamH2PingInterval` 字段 JSDoc，若含"Node-only"措辞）
- Modify: `config.yaml`（重写第 156-198 行 timeouts 段落 + 816 行附近 responses 段落，迁移到新位置）
- Regenerate: `config.schema.json`

**Steps**

1. `grep -n "Node-only" src/lib/proxy.ts src/lib/config/schema.ts src/lib/state.ts` 列出所有需要修正的位置（预期命中 `schema.ts` 的 `upstream_keepalive`/`upstream_h2_ping` 字段注释——现已随 Task 1/2 迁移到新字段 `tcp_keepalive_probe_delay`/`ping_interval`，若 Task 1 撰写时已经去掉"Node-only"措辞则此处只需确认；`proxy.ts` 里 `getUpstreamKeepAliveDelayMs`/`getUpstreamH2PingIntervalMs` 函数的 JSDoc 若含"Node-only"需要改写为准确描述：TCP keepalive 走 `node:tls`/`node:net` 的 socket API，在 Bun 和 Node 上都可用；h2 PING 走 `node:http2`，同样两个运行时都支持——"Node-only"这个措辞是历史遗留的不准确描述，实际是 runtime-neutral）。

2. 写失败测试：本步骤是纯注释修正，无可自动化断言的行为差异（writing-plans 允许对纯文档性改动用"人工可复现验证"代替 TDD）——用 `grep -c "Node-only" src/lib/proxy.ts src/lib/config/schema.ts src/lib/state.ts` 在改动前后对比计数下降到 0，作为验证手段而非单元测试。

3. 修正 `proxy.ts` 里的注释（若存在，示例改法）：

```ts
/** Upstream TCP keepalive initial-probe delay in ms, or undefined if disabled (0). Works on both Bun and Node (node:tls socket API is runtime-neutral). */
```

4. 编辑 `ensureTimeoutSubscription()`（第 228-232 行）：

```ts
function ensureTimeoutSubscription(): void {
  if (timeoutSubscriptionInstalled) return
  onTransportTimeoutChange(rebuildUpstreamDispatcher)
  onUpstreamTransportChange(rebuildUpstreamDispatcher)
  timeoutSubscriptionInstalled = true
}
```

   在文件顶部 import 区块追加 `onUpstreamTransportChange,` 到既有 `import { ... onTransportTimeoutChange ... } from "~/lib/state"` 语句里。

5. 写一个失败测试验证这条新订阅确实生效（这才是本 Task 真正的 TDD 核心断言，而非注释措辞）：在既有 proxy 相关测试文件（`grep -rln "onTransportTimeoutChange\|rebuildUpstreamDispatcher" tests/` 定位，若未找到专属测试文件则新建 `tests/transport/proxy-transport-config-subscription.unit.test.ts`）追加：

```ts
test("setUpstreamTransportConfig change triggers dispatcher rebuild (ensureTimeoutSubscription must also subscribe onUpstreamTransportChange)", () => {
  // ensureTimeoutSubscription() is invoked lazily by the dispatcher getter — call
  // it once via the public entry point to install the subscription, then flip a
  // tracked field and assert the dispatcher was rebuilt (observable via whatever
  // existing test seam surfaces a rebuild — e.g. a spy on the exported dispatcher
  // getter, or the http2/undici agent identity changing).
  // Concrete assertion mechanism depends on the existing test seam in the located
  // file — mirror its pattern for the analogous onTransportTimeoutChange test.
})
```

   执行者须先 `grep -rn "rebuildUpstreamDispatcher\|onTransportTimeoutChange" tests/` 找到既有对 `onTransportTimeoutChange` 触发重建的测试用例，照抄其断言机制（例如比较 dispatcher 对象引用变化），只是把触发源换成 `setUpstreamTransportConfig`。**若找不到既有的 dispatcher-rebuild 测试文件**，改为最小充分验证：mock/spy `onUpstreamTransportChange` 本身被调用过一次（`import * as state from "~/lib/state"` + `spyOn(state, "onUpstreamTransportChange")`，触发 proxy 模块初始化路径后断言 `spy).toHaveBeenCalled()`），并在本 Task 的执行笔记里记录选用的是哪种断言机制。

6. 跑测试确认失败（修正前 `ensureTimeoutSubscription` 未调用 `onUpstreamTransportChange`），应用 Step 4 的改动后跑通。

7. 重写 `config.yaml`：把第 187 行 `upstream_keepalive: 15` 和第 198 行 `upstream_h2_ping: 15` 从 `timeouts:` 段落里删除（连同其行内注释一并移除），在文件里新增一个 `upstream_transport:` 顶层段落（放在 `timeouts:` 段落之后，参照既有段落的双语注释风格）：

```yaml
# ============================================================================
# Upstream transport / 上游传输
# ============================================================================
# Outbound connection behavior toward the GHC upstream, organized by protocol.
# Distinct from `timeouts.*` (protocol-agnostic request-lifecycle watchdogs).
# 面向 GHC 上游的出站连接行为，按协议组织；区别于 timeouts.*（协议无关的请求生命周期看门狗）。

# upstream_transport:
#   tcp_keepalive_probe_delay: 15
#   http2:
#     ping_interval: 15
#     session_connect_timeout: 10
#   websocket:
#     pooled_connection_idle_timeout: 300
#     soft_max_connections: 32
```

   同时把第 816 行附近 `client_ws_keep_open: false` 从 `openai_responses:` 段落移除，在文件里新增一个 `server:` 顶层段落：

```yaml
# ============================================================================
# Server / inbound ingress / 服务端·入站
# ============================================================================
# Client-facing inbound limits — distinct from upstream_transport.* (outbound to GHC).
# 面向客户端的入站限制——区别于 upstream_transport.*（出站到 GHC）。

# server:
#   responses_ws:
#     keep_open: false
#     max_frame_bytes: 0
#     max_connections: 256
```

   （具体行号在实际编辑时以 `grep -n "upstream_keepalive\|upstream_h2_ping\|client_ws_keep_open\|max_ws_frame_bytes\|max_client_ws_connections\|max_upstream_ws_connections" config.yaml` 重新定位为准，因为本 Task 之前的改动可能已轻微移动行号；删除动作以精确匹配到的行内容为准，不按本文档写死的行号盲改。）

8. 跑 `bun run generate:config-schema` 重新生成 `config.schema.json`（机械脚本，产出基于 Task 1-7 已完成的 Zod schema，无需手工核对 diff 逐行——脚本本身是既有工具，只验证跑完之后 `bun run typecheck` 仍然通过、且 `git diff config.schema.json` 里能看到新增的 `upstream_transport`/`server` 键与移除的旧字段）。

9. 跑 `bun run lint:all` 全量（本项目 2026-06-29 起无 pre-commit 门禁，收尾靠手动全量 lint）确认无新增违规；跑 `bun run typecheck` 全绿；跑 `bun test tests/config/ tests/transport/` 全量确认无回归。

10. `git commit -F <msgfile> -- src/lib/proxy.ts src/lib/config/schema.ts src/lib/state.ts config.yaml config.schema.json tests/transport/proxy-transport-config-subscription.unit.test.ts`（若 Step 5 新建了该测试文件；否则去掉这一路径），提交信息：`fix(proxy): subscribe onUpstreamTransportChange in ensureTimeoutSubscription; correct misleading Node-only wording; sync config.yaml + config.schema.json`。

---

## 自审记录（Self-Review）

**Spec 覆盖映射**：

| Spec/ADR 条目 | 覆盖 Task |
|---|---|
| D1 三轴归位 | Task 1/2/3 |
| D2 单向依赖（timeouts ×1.5 派生但不传播）| 本阶段不涉及派生逻辑改动，`stream_idle_overrides`/`response_header_overrides` 保持原样在 `timeouts.*`，未受三轴重组影响——确认无需新增 Task |
| D3 `session_connect_timeout` 留在 h2 段 | Task 1（schema 位置）+ Task 5（state 字段）+ Task 7（apply 接线）|
| D4 WS 无 keepalive 键 | 本阶段 `UpstreamTransportWebsocketConfigSchema` 里没有任何 WS keepalive 字段——设计已满足，无需额外 Task，仅在此记录确认 |
| D5 统一 0 语义 | Task 1（字段注释显式说明）+ Task 4（0→absence 迁移特例）|
| D6 入向整组迁移 | Task 2（`ResponsesWsIngressConfigSchema`/`ServerConfigSchema`）+ Task 4（三条迁移规则）|
| §5 迁移表 6 条 | Task 4 全覆盖 |
| §6 相邻修正（Node-only 注释）| Task 8 |
| §7 验收（新增旋钮存在于 schema+state，且默认值与旧硬编码常量一致）| Task 1/2（schema 默认值）+ Task 5（state 默认值 10/300/32）|

**占位符扫描**：全文档搜索 `TBD`/`TODO`/`类似 Task`/"加错误处理" —— 无命中（Task 6 Step 9 提到的"跨阶段边界"是显式设计说明，非占位符）。

**类型一致性**：`setUpstreamTransportConfig`/`onUpstreamTransportChange`/`setResponsesWsIngressConfig` 的签名在 Task 5/6 定义后，被 Task 7（config.ts 消费）、Task 8（proxy.ts 消费）原样引用，未出现签名漂移。`softMaxUpstreamWsConnections` 字段名在 Task 5（`setUpstreamTransportConfig` Pick 类型引用）与 Task 6（`MutableState` 改名声明点）之间存在有意的跨 Task 依赖，已在 Task 6 Step 5 里显式记录执行顺序，避免执行者误判为矛盾。

**已知的跨阶段遗留（记入 plan-kickoff.md 的"spec 缺口/待裁决"清单，不在本阶段解决）**：
- `sessionConnectTimeout`/`pooledConnectionIdleTimeout` 两个新 state 字段在 P1 结束时未被任何连接代码读取（P2 职责，Global Constraint 2 已注明）。
- `config.yaml` 的新 `upstream_transport`/`server` 段落写的是注释掉的占位示例（不取消注释、保持默认行为），这是延续既有 `config.yaml` 全文档的"示例默认注释"风格（对照 Task 8 Step 7 引用的既有段落风格），不是遗漏。
