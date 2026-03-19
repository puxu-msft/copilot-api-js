# 优雅关闭与请求生命周期

## 优雅关闭

`src/lib/shutdown.ts` 实现 3 阶段优雅关闭：

### Phase 1: Drain（立即）
- 停止接受新请求
- 标记服务器为 draining 状态

### Phase 2: Graceful Wait
- 等待活跃请求自然完成
- 超时：`state.shutdownGracefulWait` 秒（默认 60）

### Phase 3: Abort
- 向所有仍在进行的请求发送 abort signal
- 等待 handler 处理 abort 并清理
- 超时：`state.shutdownAbortWait` 秒（默认 120）

## 请求上下文管理

`RequestContextManager`（`src/lib/context/manager.ts`）跟踪所有活跃请求的生命周期：

- 每个请求创建一个 `RequestContext`（`src/lib/context/request.ts`）
- 状态机：`pending` → `streaming` → `completed` / `failed`
- 消费者注册（`src/lib/context/consumers.ts`）：请求完成时通知所有注册的消费者

### Stale Request Reaper

- `state.staleRequestMaxAge`：活跃请求最大存活秒数（默认 600，0 = 禁用）
- 超时的请求由 reaper 强制清理，防止泄漏
- 安全网机制：正常情况下请求应通过 stream 完成或超时自然终结

## 错误持久化

`ErrorPersistenceConsumer`（`src/lib/context/error-persistence.ts`）作为请求上下文消费者，在请求失败时将错误信息持久化到文件系统，便于事后诊断。

相关代码：`src/lib/shutdown.ts`、`src/lib/context/`
