# WebSocket 模块未完成优化清单（已全部清理）

> 创建日期：2026-06-03
> 最后更新：2026-06-03（包含 subagent 第二轮 review 发现的所有真问题修复）
> 范围：所有已知未完成 WS 优化的最终决策

---

## 总结

依据用户原则「真实存在的问题必须做、不在乎回归风险、在乎架构健康/可维护性/可观测性、不在乎向后兼容」，本清单原 18 项全部处理 + subagent 第二轮独立 review 发现的 7 个新真问题全部修复。

### 改动总览（两轮）

**第一轮（原 deferred items）**：15 项实施 / 1 项归档保留 / 2 项测试基础设施延后
**第二轮（subagent review 发现）**：1 HIGH + 5 MEDIUM + 1 LOW 全部修复

最终：**typecheck 通过，1624/1627 测试通过（3 skip），lint 在所有改动文件零错**。

---

## 第二轮：Subagent Review 新发现的真问题（全部已修）

### ✅ H1. 并发 connect() 中首调用者 abort 连坐其他 callers [已修]

**问题**：[upstream-ws-connection.ts:connect](src/lib/openai/upstream-ws-connection.ts) 原实现把首 caller 的 abort signal 直接绑到共享 `connectingPromise`，导致第二个 caller 不论自己 signal 状态都被连坐 reject。
**修复**：分离「共享 handshake promise」与「per-caller race」。handshake promise 内部不再绑任何 signal；每个 caller 在外层用自己的 signal 做 `Promise.race(handshake, abort)`，abort 只影响自己。
**架构收益**：连接管理器的并发语义清晰 — 共享 handshake 是「join 同一结果」，per-caller signal 是「我自己能等多久」，两个独立维度。
**测试**：`first caller abort does NOT propagate to second caller`

### ✅ M1. fire-and-forget setPhase 可能产生 unhandled rejection [已修]

**问题**：[shutdown.ts](src/lib/shutdown.ts) 的 `void setPhase(...)` 若 `broadcastAndFlush` 内部抛错会变成 unhandled rejection，shutdown 过程中崩溃。
**修复**：新增 `setPhaseFireAndForget` 助手，内部 `.catch(noop + warn log)`，phase1/2/3 用之；phase4/finalize 仍 `await setPhase`。
**架构收益**：明示「fire-and-forget 是有意决策」+ 兜底防御。

### ✅ M2. broadcastAndFlush 二次枚举 clients [已修]

**问题**：[broadcast.ts:broadcastAndFlush](src/lib/ws/broadcast.ts) 原实现 sendToEach 后又遍历 clients 一次收集 sent 列表，逻辑重复。
**修复**：`sendToEach` 返回 `{ delivered, dead }`，broadcastAndFlush 直接用 `delivered`。
**架构收益**：单次遍历 + 清晰返回契约。

### ✅ M3. bufferedAmount 三处 cast [已修]

**修复**：抽 `getBufferedAmount(ws): number` helper 集中类型断言。
**架构收益**：未来 WS adapter typings 改进时改一处。

### ✅ M4. onError 不 decrement 计数 [已修]

**问题**：[ws.ts:onError](src/routes/responses/ws.ts) 原实现依赖 onError → onClose 链触发 decrement，若 adapter 在某些错误路径不触发 onClose，计数泄漏。
**修复**：抽 `releaseConnection(ws)` 助手 + `decremented` WeakSet 保证幂等。onError 主动调 `releaseConnection`，onClose 也调（幂等无影响）。
**架构收益**：计数语义不依赖 adapter 行为细节；幂等是「自我保证」。

### ✅ M5. 未连接 placeholder 被 evict 后泄漏 pool size [已修]

**问题**：[upstream-ws.ts:evictOneIdleIfNeeded](src/lib/openai/upstream-ws.ts) 选 victim 时不区分 isOpen，未连接的占位被选中后 `connection.close()` 无 socket 可关 → onClose 不触发 → connections map 永久残留 → pool size 永久膨胀。
**修复（两端）**：
- evict 端：跳过 `!isOpen` 候选（占位不参与 eviction）
- close 端：[upstream-ws-connection.ts:close](src/lib/openai/upstream-ws-connection.ts) 若 socket 为 null 也调 `opts.onClose()`，确保占位被关时管理器能清理
**架构收益**：双端防御 — 即使 evict 改回选占位，close 也能正确清理；即使 close 不调 onClose，evict 也不会选占位。
**测试**：`skips not-yet-connected placeholders during eviction` + `close() before handshake completes still fires onClose` + `close() during in-flight handshake fires onClose exactly once`

### ✅ M6. state import 模块图风险 [已修]

**修复**：[upstream-ws.ts](src/lib/openai/upstream-ws.ts) state import 处加注释，说明当前是单向边、未来引入 cycle 时该改成 dynamic import。
**架构收益**：风险显式记录，后人维护时不踩坑。

---

## 第一轮：原 deferred items（全部已处理）

### ✅ A1. socket 赋值时机重构 [已完成]
**实施**：`socket = ws` 移到握手成功后；失败/abort 路径不留 module-level state。

### ✅ A2. idle handleError 主动关闭 [已完成]
**实施**：idle error 同时 `markUnusable()` + `socket.close()`。

### ✅ A3. logHeaderReuseDiff 用 getHeaderCaseInsensitive [已完成]
**实施**：抽 [fetch-utils.ts:getHeaderCaseInsensitive](src/lib/fetch-utils.ts) 工具函数。

### ✅ A5. broadcast 批量删除 [已完成]
**实施**：抽 `sendToEach` + `dropClients`，再不在迭代中改 clients。

### ✅ A6. iterateSseEvents 助手 [已完成]
**实施**：[stream.ts:iterateSseEvents](src/lib/stream.ts) 统一抽取 SSE iterator cast。

### ✅ B1. combineAbortSignals lifecycle 文档化 [已完成]
**实施**：JSDoc 注释 WeakRef 语义与长寿场景的最佳实践。

### ⚪ B2. create() 假 async [永久保留]
用户明确决定。

### ✅ B3. CONNECTING 状态 connect 等待 [已完成]
**实施**：`connectingPromise` 缓存 in-flight 握手；不再抛 "already connecting"。**第二轮 H1 进一步完善了 abort 隔离**。

### ✅ B4. copilotWsUrl fail-fast [已完成]
**实施**：非 HTTP-family 协议抛错。

### ✅ B5. 文档 Phase 3 abort 链路 [已完成]
**实施**：[connection-management.md](docs/2603-websocket/connection-management.md) 新增链路说明。

### ✅ C1. /api/status 暴露 disabled_until [已完成]
**实施**：`disabledUntilMs` getter + `/api/status` 字段。

### ✅ C2. parse error 同步标记 unusable [已完成]
**实施**：`unusable` 标志同步设置，`isOpen` 检查。

### ✅ C3. 客户端 WS 最大连接数 [已完成]
**实施**：`liveConnectionCount` + `releaseConnection` 幂等助手（M4 后强化）。

### ✅ C4. WS 帧大小配置化 [已完成]
**实施**：`state.maxWsFrameBytes`，0 = 无限。

### ✅ C5. upstream 池上限配置化 [已完成]
**实施**：`maxConnections` 接受 getter 形式，支持热重载。

### ✅ C6. broadcastAndFlush [已完成]
**实施**：按 `bufferedAmount` 轮询直到 drain 或 deadline；setPhase 改返回 Promise。**第二轮 M2/M3 进一步重构**。

---

## 测试改进 — 11 项新增 / 2 项归档

### ✅ 新增单元测试（11 项）

**第一轮（8 项）**：
- `concurrent connect() shares in-flight handshake` — B3 覆盖
- `idle socket error marks unusable and closes the socket` — A2 覆盖
- `parse error mid-stream synchronously marks unusable` — C2 覆盖
- `disabledUntilMs reflects armed deadline and resets on success` — C1 覆盖
- `max upstream pool size accepts a getter for hot-reload semantics` — C5 覆盖
- `custom maxWsFrameBytes is honored by the cap check` — C4 覆盖
- `rejects new connections beyond maxClientWsConnections` — C3 覆盖
- `recordFallback counter freeze 断言加强`

**第二轮（3 项）**：
- `first caller abort does NOT propagate to second caller` — H1 覆盖
- `skips not-yet-connected placeholders during eviction (M5 leak guard)` — M5 覆盖（evict 端）
- `close() before handshake completes still fires onClose` + `close() during in-flight handshake fires onClose exactly once` — M5 覆盖（close 端）

### 📅 A4. node-ws 并发测试 [归档]

切到 node 部署时再做。

### 📅 C8. Bun fakeTimers [归档]

测试 API 偏好不是架构问题。

---

## 验证结果

```
typecheck: ✅ pass
lint:      ✅ 改动文件零错（tests/ws/responses-ws.test.ts:61 是预先存在的 require-await，与本轮无关）
tests:     ✅ 1624 pass / 0 fail / 3 skip （Ran 1627 tests across 110 files）
```

## 架构影响总结（两轮合计）

| 方向 | 改进 |
|------|------|
| **生命周期清晰度** | A1/B3/H1 — socket 状态污染面收敛到成功路径；并发 connect() 不再抛错、不再连坐 abort |
| **资源不可用同步标记** | A2/C2 — 异步 close 事件不再是「可不可复用」的唯一来源 |
| **占位对象生命周期** | M5 — eviction 不再选未连接的占位；占位 close 也能正确清理 |
| **可配置性 + 热重载** | C3/C4/C5 — 三个 magic number 全配置化；upstream pool cap 支持 getter 形式热重载 |
| **可观测性** | C1/C6/M1 — `/api/status` 暴露恢复时间；shutdown 广播帧保证送达；shutdown 阶段错误有日志 |
| **共享工具** | A3/A5/A6/M3 — 四个 helper 收敛重复代码 |
| **架构文档** | B1/B5/M6 — combineAbortSignals 生命周期、Phase 3 abort 链路、state import 风险 |
| **fail-fast** | B4 — 防御未来引入非 HTTP base URL |
| **错误处理幂等性** | M1/M4 — fire-and-forget 不再 unhandled；连接计数 release 幂等 |

## 等待后续触发的工作

- **A4**：用户切到 node-ws 部署时
- **C8**：迁移到 Bun fakeTimers 时（无紧迫性）

其余全部已落地，**包含 subagent 独立审查发现的所有真问题**。
