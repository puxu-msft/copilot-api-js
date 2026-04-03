# 上游 WebSocket 实现回应 260330-1

## 总结

Claude 这份审阅整体是可靠的，但需要区分三类情况：

1. **真实且需要立即修正的 correctness / lifecycle 问题**
2. **方向正确、但更适合作为语义澄清或测试补强的问题**
3. **并非真实缺陷，或当前设计本身更合理的问题**

本轮已基于代码复核后实施以下改动：

- 修复 `isOpen` 在 `socket === null` 时误判为 `true`
- 修复 `connect()` 握手失败路径未主动关闭 socket 的清理缺口
- 将请求级 abort listener 生命周期绑定到 request 完整生命周期，而不是仅依赖 generator `finally`
- 为 `RequestContext → history → TUI tag` 的 transport 流转补上显式测试
- 为 `isWsResponsesSupported()` 补充注释，明确其与 legacy endpoint 推断的语义差异

验证结果：

- `bun run typecheck` 通过
- 目标测试 125 个全部通过
- 目标改动文件的 eslint 检查通过

## 逐条回应

### Finding 1 — `isOpen` 在 socket 为 null 时返回 `true`

**结论：接受，并已修复。**

这是一个真实 bug。原实现：

```ts
return socket?.readyState === socket?.OPEN
```

在 `socket === null` 时会退化为 `undefined === undefined`，导致未连接实例被误报为 open，进而影响 `findReusable()` 的复用判断。

已改为：

```ts
return socket !== null && socket.readyState === socket.OPEN
```

并新增单测覆盖：

- 未连接时 `isOpen === false`
- 建连后为 `true`
- `close()` 后恢复为 `false`

### Finding 2 — `connect()` 握手失败路径的 socket / listener 清理

**结论：接受，并已修复。**

Claude 的判断是对的：原来的 `onOpenError` 只 reject，不保证主动触发关闭流程。虽然很多 WS 实现会在 `error` 后紧接 `close`，但把清理寄托给“实现通常会这样做”不够稳。

现在在握手失败时主动：

- 调用 `activeSocket.close(1001, "Handshake failed")`
- 让统一的 `handleClose` 路径回收 listener、socket 引用和 manager 中的活动连接

新增单测验证握手失败时会主动关闭底层 socket。

### Finding 3 — `sendRequest()` 的 abort listener 生命周期

**结论：接受，并已修复。**

这条的关键不在“send 同步抛错是否泄漏”，那一段原本已经处理对了；真正的问题是：

- 若 `send()` 成功
- 但后续通过 `failRequest()` / `finishRequest()` 结束
- 且上层消费者没有继续消费 generator

那么仅依赖 generator `finally` 来移除 abort listener 就不够稳。

本轮改为把 abort 清理器提升为连接内的 request 生命周期状态：

- request 开始时注册 `currentAbortCleanup`
- `finishRequest()` / `failRequest()` 都会主动执行并清空它
- generator `finally` 仅作为兜底，不再是唯一清理点

这比单纯“在 finally 里 removeEventListener”更可靠，也更符合资源生命周期绑定原则。

### Finding 4 — `create()` 返回 Promise 但不负责 connect

**结论：不采纳为代码修改。**

这是一个接口语义讨论点，不是 correctness bug。

当前分层是：

- manager 负责创建 / 复用连接对象
- caller 决定何时真正发起 `connect()`

这允许调用方在确认需要发送首个请求前，保留对连接时机的控制，也让复用判定与连接建立解耦。修复 Finding 1 后，这里不会再引入“未连接对象被错误复用”的风险。

因此，本轮不把 `create()` 改为“创建即连接”。保持现状更清晰，也更利于 manager 只承担池管理职责。

### Finding 5 — fallback 后 HTTP transport 记录

**结论：Claude 自检正确，无需修改。**

当前实现已经是正确的：

- 正常 HTTP 路径记录 `http`
- WS 首事件前失败时记录 `upstream-ws-fallback`
- 不会在 fallback 后再被覆盖成 `http`

这点我复核过，保持不变。

### Finding 6 — `isWsResponsesSupported()` 与 `isEndpointSupported()` 不对称

**结论：接受其“可读性提醒”，不接受“按对称性改行为”。**

行为上当前实现是对的：legacy 模型不能被隐式视为支持 `ws:/responses`。

因此本轮没有改逻辑，只补充了注释，明确：

- `isEndpointSupported()` 对 legacy 模型保留宽松兼容
- `isWsResponsesSupported()` 必须要求模型显式声明 `ws:/responses`

这能减少未来维护时误把“语义不对称”当成“实现不一致”的概率。

### Finding 7 — `createAsyncQueue.iterate()` failure 后可能二次 throw

**结论：不采纳。**

这条不是实际缺陷。

`fail()` 期间 waiter 会直接收到 rejected promise，generator 会因此结束；循环顶部的 `if (failure) throw failure` 是对后续调用者的同步保护，不会构成额外行为错误，也不会导致重复抛错链路的用户可见问题。

因此本轮不做无收益改动。

### Finding 8 — transport 在 context / history / TUI 的流转测试不足

**结论：接受，并已补齐。**

这条很有价值。虽然 transport 字段当时已经实现，但缺少跨层流转的显式守护测试，后续重构时容易退化。

本轮新增验证：

- `RequestContext.setAttemptTransport()` 会更新 `ctx.transport`
- `toHistoryEntry()` 会写入 entry 级 `transport` 和 attempt 级 `transport`
- history consumer 初次插入 entry 时会带上 transport
- completed/failed 更新时会向 history 更新 transport
- TUI attempts 更新时会正确映射：
  - `upstream-ws -> ws`
  - `upstream-ws-fallback -> ws→http`

## 延伸修正

除直接回应 Claude 的 Finding 外，本轮还顺手做了两类“举一反三”的收敛：

1. **把资源清理统一到 request 生命周期**
   避免 future refactor 再次把 listener 清理放回消费端控制流。

2. **把 transport 看作一条完整链路而非局部字段**
   现在测试覆盖已经明确守住：
   `responses-client -> RequestContext -> history -> TUI`

这两点比单点修补更重要，因为它们直接降低了后续维护时的隐性回归概率。

## 本轮实际改动

代码：

- `src/lib/openai/upstream-ws-connection.ts`
- `src/lib/models/endpoint.ts`

测试：

- `tests/unit/upstream-ws-connection.test.ts`
- `tests/component/request-context.test.ts`
- `tests/component/context-consumers.test.ts`
- `tests/component/history-store.test.ts`

## 验证

执行并通过：

```bash
bun run typecheck
bun test tests/unit/upstream-ws-connection.test.ts tests/unit/upstream-ws.test.ts tests/unit/openai-responses-client.test.ts tests/component/request-context.test.ts tests/component/context-consumers.test.ts tests/component/history-store.test.ts
./node_modules/.bin/eslint src/lib/openai/upstream-ws-connection.ts src/lib/models/endpoint.ts tests/unit/upstream-ws-connection.test.ts
```

## 收敛结论

Claude 这份审阅里，**Finding 1 / 2 / 3 / 8 值得落地**，**Finding 6 值得补充说明但不应改行为**，**Finding 4 / 7 不应为了“看起来更完整”而修改现有设计**。

也就是说，这份审阅**总体可信且有实施价值**，但正确的处理方式不是全盘照搬，而是：

- 修正真实 bug
- 加强生命周期管理
- 补上跨层测试
- 保留当前已经合理的接口边界
