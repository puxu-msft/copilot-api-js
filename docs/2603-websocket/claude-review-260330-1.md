# 上游 WebSocket 实现审阅 260330-1

## 审阅范围

对照 `docs/2603-websocket/` 设计文档，审阅 Codex 的 Phase 1 实现。
涉及文件：核心实现 4 个、集成修改 ~20 个、新增测试 2 个。

全量测试结果：1419 pass，0 fail。

## 结论

实现质量高，与设计文档对齐度好。核心架构（连接管理器、fallback 状态机、shutdown 四阶段集成）全部正确落地。以下是发现的问题和改进建议。

## Findings

### 1. [高] `isOpen` 在 socket 为 null 时返回 `true`

`upstream-ws-connection.ts:211-213`：

```typescript
get isOpen() {
  return socket?.readyState === socket?.OPEN
}
```

当 `socket === null` 时，`null?.readyState` 为 `undefined`，`null?.OPEN` 也为 `undefined`，`undefined === undefined` 为 `true`。这意味着**未连接的连接被报告为 open**。

`findReusable()` 在 `upstream-ws.ts:35` 检查 `connection.isOpen`——如果 socket 为 null 也返回 true，可能导致复用一个尚未连接的 connection。

**修正建议**：

```typescript
get isOpen() {
  return socket !== null && socket.readyState === socket.OPEN
}
```

### 2. [高] `connect()` 中 socket 的 `error` 事件监听器泄漏路径

`upstream-ws-connection.ts:132-168`：`connect()` 为 socket 注册了全局 handler（`handleMessage`、`handleError`、`handleClose`），然后在 Promise 内部再注册一次性的 `onOpenError`。

如果 `onOpenError` 触发，它只调用 `cleanup()`（移除一次性 listener）并 reject，但**不会**调用 `handleClose` 来清理全局 handler 和 socket 引用。结果是：
- `socket` 变量仍然持有一个已失败的 WebSocket 实例
- `handleMessage`、`handleError`、`handleClose` 仍在监听
- 后续的 `close` 事件最终会触发 `handleClose` 清理，但时序不确定

这不会导致功能错误（`close` 事件会最终到达），但如果底层 WS 实现在 error 后不触发 close，就会泄漏。

**修正建议**：在 `onOpenError` 中主动 `activeSocket.close()` 确保触发 `handleClose`。

### 3. [中] `sendRequest` 的 abort listener 在 send 失败时可能不被清理

`upstream-ws-connection.ts:186-198`：

```typescript
abortSignal?.addEventListener("abort", onAbort, { once: true })
try {
  socket.send(...)
} catch (error) {
  abortSignal?.removeEventListener("abort", onAbort)
  failRequest(...)
}
```

`failRequest` 设置 `busy = false` 并 `currentQueue?.fail(error)`，但 `onAbort` 的 listener 已经在 try 块外注册。如果 `send` 同步抛出，`removeEventListener` 在 catch 中正确执行。✅ 这条实际上处理正确。

但如果 `send` 成功但之后 socket 立即断开（handleClose 触发 failRequest），`onAbort` listener 的清理依赖 generator 的 `finally` 块（line 206）。如果 consumer 不遍历 generator，finally 不会执行。

**修正建议**：在 `failRequest` 中也移除 abort listener，或者将 abort listener 的生命周期绑定到 queue 而非 generator。

### 4. [中] `create()` 返回 `Promise.resolve(connection)` 但连接尚未建立

`upstream-ws.ts:56-57`：

```typescript
connections.set(key, connection)
return Promise.resolve(connection)
```

`create()` 的签名是 `Promise<UpstreamWsConnection>` 但它不调用 `connect()`——连接在 `responses-client.ts:61-63` 由调用方建立。这意味着 `connections` map 中可能存在未连接的 connection。

这与 `findReusable` 的 `isOpen` 检查联合工作（未连接的不会被复用），但如果 Finding 1 的 `isOpen` bug 未修复，就会导致复用未连接的 connection。

**修正建议**：修复 Finding 1 后此处自然安全。但可以考虑让 `create()` 直接调用 `connect()` 使接口语义更清晰。

### 5. [中] fallback 后 HTTP 路径不调用 `onTransport("http")`

`responses-client.ts:91-94`：

```typescript
if (!usedFallback) {
  opts?.onTransport?.("http")
}
return createResponsesViaHttp(prepared, opts?.headersCapture)
```

当不走 WS 路径时（`canUseUpstreamWebSocket` 为 false），`onTransport("http")` 被调用。✅
当 WS fallback 时，`onTransport("upstream-ws-fallback")` 在 line 80 被调用，但 `usedFallback = true` 导致 line 91-93 被跳过。✅ 正确——fallback 已经记录了 transport。

不过，HTTP headers capture 只在 `createResponsesViaHttp` 内部处理（line 118-119），fallback 路径传入的 `headersCapture` 正确。✅

### 6. [中] `isWsResponsesSupported` 对 legacy 模型返回 false，与 `isEndpointSupported` 不一致

`endpoint.ts:61-63`：

```typescript
export function isWsResponsesSupported(model: Model | undefined): boolean {
  if (!model?.supported_endpoints) return false
  return model.supported_endpoints.includes(ENDPOINT.WS_RESPONSES)
}
```

当模型没有 `supported_endpoints`（legacy 模型）时返回 `false`。这与 `isEndpointSupported` 的语义不同（后者对 legacy 模型返回 `true`）。

**这是正确的设计选择**——legacy 模型不应该走 WS。但如果有人期望与 `isEndpointSupported` 对称，可能产生困惑。建议在注释中说明。

### 7. [低] `createAsyncQueue` 的 `iterate()` 在 failure 后 check 不完整

`upstream-ws-connection.ts:279-281`：

```typescript
async *iterate() {
  for (;;) {
    if (failure) throw failure
```

如果在 `await` 等待期间 `fail()` 被调用，`drain()` 会 reject waiter。当 generator 被 resumed 后，`failure` 已经被设置，下一次循环检查会再次 `throw failure`。但 generator 已经因为 rejected promise 被终止，所以这里不会实际触发二次 throw。✅ 安全。

### 8. [低] TUI transport tag 和 history transport 字段的新增测试覆盖

新增了 `upstream-ws-connection.test.ts` 和 `upstream-ws.test.ts`，但对 transport 字段在 context/history 中的流转没有看到专门的新测试。现有测试可能间接覆盖，但建议添加：
- `setAttemptTransport("upstream-ws")` 后 context 的 `transport` 属性是否正确
- history entry 是否记录 transport

## 可改进之处

1. **连接空闲超时可配置化**：当前 `DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000` 硬编码。可以通过 `state` 暴露为配置项（但不紧急）。

2. **CAPI error 格式兼容**：`isCapiWebSocketError` 正确检测嵌套格式。`parseWebSocketEvent` 将其转换为扁平 `{ type: "error", code, message }` 格式。这与 SSE 路径的 error 事件格式一致。✅ 好做法。

3. **日志粒度**：WS 连接/复用/fallback 的日志用 `consola.warn`/`consola.debug`。建议在连接复用成功时也记录一条 debug 日志，方便调试。

## 验证

```
bun run typecheck  ✅
bun test           ✅ 1419 pass, 0 fail
```

## 总结

实现整体质量高，架构与设计文档对齐。最关键的问题是 Finding 1 的 `isOpen` null 安全——这会导致未连接的 connection 被 `findReusable` 误认为可用。其余问题为中低优先级的健壮性改进。
