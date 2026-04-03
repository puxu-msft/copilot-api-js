# 连接管理

## UpstreamWsManager

管理代理到 Copilot API 的上游 WebSocket 连接。

### 接口

```typescript
interface UpstreamWsManager {
  /** 查找可复用连接（匹配 statefulMarker + 模型一致 + 非 busy） */
  findReusable(opts: { previousResponseId: string; model: string }): UpstreamWsConnection | undefined

  /** 新建上游 WS 连接 */
  create(headers: Record<string, string>): Promise<UpstreamWsConnection>

  /** shutdown Phase 1：停止为新的内部执行流分配/复用上游 WS */
  stopNew(): void

  /** shutdown Phase 4：强制关闭所有连接 */
  closeAll(): void

  /** 活跃连接数 */
  readonly activeCount: number
}
```

### 连接复用策略

GHC 按 `conversationId + turnId` 复用上游 WS 连接。本项目作为代理，没有显式的 conversation/turn ID，但 `previous_response_id` 提供了等价的关联信号。

**复用规则**：

- 请求携带 `previous_response_id` → 查找持有该 marker 的连接
  - 找到且连接仍 open → **复用**（避免重传历史）
  - 找到但连接已关闭 → 新建连接
  - 找不到 → 新建连接
- 请求无 `previous_response_id`（新对话）→ 新建连接

这意味着代理↔上游的连接**天然是 multi-request**（同一 conversation 的多轮 tool call 共用连接），
即使客户端↔代理是每次独立的 HTTP 请求。两层的连接生命周期是独立的。

**连接清理**：
- 超时无新请求（如 5 分钟空闲）→ 关闭连接
- shutdown → 关闭所有
- 连接错误 → 从 map 移除

### UpstreamWsConnection

单个 WebSocket 连接的完整生命周期。

```typescript
interface UpstreamWsConnection {
  /** 建立到上游的 WebSocket 连接（含握手超时） */
  connect(opts?: { signal?: AbortSignal }): Promise<void>

  /**
   * 发送 response.create 并返回事件流。
   * 同一连接同一时刻只允许一个 active request（由 manager 保证）。
   * 如果连接 busy（前一个请求未终结），manager 应拒绝复用并新建连接。
   */
  sendRequest(
    payload: ResponsesPayload,
    opts?: { abortSignal?: AbortSignal },
  ): AsyncIterable<ResponsesStreamEvent>

  /** 连接是否可用（open 且非 busy） */
  readonly isOpen: boolean

  /** 连接是否正在处理请求（已发 response.create 但未收到终结事件） */
  readonly isBusy: boolean

  /** 上一次 response.id，用于后续请求的连接复用查找 */
  readonly statefulMarker: string | undefined

  /** 关闭连接 */
  close(): void
}
```

**abort signal 传播路径**：
- `connect()` 接收 signal → 握手超时或 shutdown 时取消
- `sendRequest()` 接收 signal → 内部 event iterator 通过 `raceIteratorNext({ abortSignal })` 响应
- 与现有 HTTP 路径一致（`combineAbortSignals(getShutdownSignal(), clientAbort.signal)`）

**单连接串行约束**：
- 由 `manager.findReusable()` 保证：返回前检查 `!connection.isBusy`
- busy 连接不可复用 → 调用方新建连接
- 不排队、不 supersede（Phase 1 不需要这些复杂机制）

### 生命周期

```
请求进入 createResponses()
  │
  ├─ 有 previous_response_id？
  │    └─ manager.findReusable({ previousResponseId: id, model: payload.model })
  │         ├─ 找到 open + 同模型 + 非 busy → 复用
  │         └─ 未找到 → 新建
  ├─ 无 previous_response_id
  │    └─ manager.create(headers) → connect({ signal })
  │
  ├── connection.sendRequest(payload)
  │     ├── 发送 { type: "response.create", ...payload }
  │     ├── yield events...
  │     └── 终结事件 → 更新 statefulMarker
  │
  └── 连接保持打开（等待下一次请求或空闲超时关闭）
```

### stateful marker

```
请求 1 → response.completed { response: { id: "resp_abc" } }
                                          │
                                statefulMarker = "resp_abc"
                                          │
请求 2（带 previous_response_id: "resp_abc"，同模型）
  → manager.findReusable({ previousResponseId: "resp_abc", model: "gpt-5.2" }) → 找到连接 → 复用
  → 上游跳过重发已缓存的历史
```

- `response.completed` → 保存 `response.id` 为 marker
- `response.failed` / `response.incomplete` / `error` → **不更新** marker
- 客户端显式传入的 `previous_response_id` 优先（客户端比代理更了解对话状态）
- `response.failed` / `response.incomplete` 后连接仍可保留（marker 不更新，后续请求需新建或用旧 marker）

### Headers 兼容策略

WebSocket 握手 headers 在连接建立时固定。复用连接时后续请求不能更新这些 headers。

GHC 的做法：复用时不检查 headers 兼容性（`chatWebSocketManager.ts:177-179` 直接返回已有连接）。

本项目中，同一 conversation 的不同请求可能在以下字段上变化：

| 字段 | 变化场景 | 连接级 invariant？ |
|------|---------|-------------------|
| `x-request-id` | 每次请求不同 | ❌ 纯追踪，不影响上游行为 |
| `X-Agent-Task-Id` | 每次请求不同 | ❌ 纯追踪 |
| `openai-intent` | user turn → `conversation-panel`，tool round → `conversation-agent` | ⚠️ 待验证 |
| `X-Interaction-Type` | 同 intent | ⚠️ 待验证 |
| `X-Initiator` | `user` vs `agent` | ⚠️ 待验证 |
| `copilot-vision-request` | 有图片时 `true` | ⚠️ 待验证 |
| `modelRequestHeaders` | 模型元数据定义 | ⚠️ `previous_response_id` 不保证同模型 |

**模型变化策略**：

`previous_response_id` 只表达状态关联，不保证 follow-up 请求使用同一模型。
如果 `payload.model` 与连接建立时的模型不同：
- **保守方案（推荐）**：模型变化时不复用，新建连接。简单、安全。
- **激进方案**：允许复用。需要外部证据证明上游支持跨模型 follow-up。

`findReusable()` 的匹配条件应为：`statefulMarker` 匹配 **且** 模型一致 **且** 非 busy。

**可选策略**：

- **宽松策略**（GHC 做法）：完全忽略 headers 差异，沿用已有连接。假设上游 WS 只在握手时读取这些头，后续请求的语义变化不影响服务端行为。
- **保守策略**：定义一组连接级 invariant 字段（如 `intent` + `vision`），仅当 invariant 匹配时复用。不匹配时新建连接。

**初始推荐**：采用宽松策略启动，同时记录每次复用时 headers 差异的日志。如果上游出现因 headers 不一致导致的错误，再切换到保守策略。

### 超时

- **握手超时**: 复用 `state.fetchTimeout`（默认 300 秒）
- **事件流空闲超时**: 复用 `state.streamIdleTimeout`（默认 300 秒）
- **连接空闲超时**: 无新请求到达的最大等待时间（如 5 分钟），超时后关闭连接释放资源

### 优雅关闭

与 `shutdown.ts` 四阶段语义精确对齐：

1. **Phase 1**（停止接受新连接）→ `upstreamWsManager.stopNew()`
   - 不再为新的内部执行流分配或复用上游 WS
   - 已有 in-flight 请求不受影响
2. **Phase 2**（等待自然完成）→ in-flight 上游 WS 请求**继续正常完成**
   - 不发 close frame，不主动断开
   - 与 HTTP 路径行为一致
3. **Phase 3**（abort signal + 等待）→ abort signal 传播到 WS 事件流的空闲超时
   - 不立即 `closeAll()`
   - 通过 abort signal 让 `raceIteratorNext` 中断等待
   - 连接仍保持打开，等待正在处理的事件完成
4. **Phase 4**（强制关闭）→ `upstreamWsManager.closeAll()`
   - 发送 WS close frame（code 1001 Going Away）
   - 强制关闭所有连接
