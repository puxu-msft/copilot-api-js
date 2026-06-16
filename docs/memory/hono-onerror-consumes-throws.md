---
name: hono-onerror-consumes-throws
description: "Hono 的 server.onError() 会在 handler 抛出传播回中间件 catch 块**之前**就消费掉它——除非你显式跳过 onError,否则中间件的 try/catch 是死代码"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 74cbbf78-f572-4505-b8b0-b822b5e0292e
---

在一个注册了 `server.onError(...)` 的 Hono 服务器中,中间件的执行模型是:

1. Handler 抛出
2. Hono 同步调用 `onError(err, c)`
3. onError 返回一个 Response(通常经由 `forwardError(c, err, ...)`)
4. 抛出被转换为那个 Response——**不**传播
5. 中间件的 `await next()` 正常 resolve(没有抛出)
6. 中间件环绕 `next()` 的 `try/catch` **永远不会**触发

**Implication**: 在一个注册了 `onError` 的项目里,任何做 `try { await next() } catch (err) { ...handle... }` 的中间件代码都是死代码。更干净的模式:

```typescript
// Trust that next() doesn't throw (onError handles it).
await next()
// Check c.res.status — onError sets it to >= 400 on failure.
if (c.res.status >= 400) { /* error path */ }
```

**Discovery context**: 当我在 `src/lib/observability/middleware.ts` 里写了一个防御性的 `try/catch + ctx.failIfNotFinalized(err)` 块时被这个坑到了。Subagent 抓到了它——`server.ts:39` 中的 `forwardError(c, ..., 'anthropic'|'openai'|'gemini')` 总会设置一个 4xx/5xx 响应。错误可见性来自 `next()` 之后的 `c.res.status >= 400`,这个我本来就有。

**When the catch DOES matter:**
- 完全绕过 Hono 的路由(自定义 upgrade handler、原始 WebSocket——`responses/ws.ts`)
- 如果你曾经有条件地 `c.onError(null)` 或使用了不同的错误处理器栈
- 对于 stdio / 非 HTTP 入口点(链路中没有 Hono)

对这些入口点,把 `ctx.failIfNotFinalized()` 当作防御性原语保留(这也是它出现在本项目 RequestContext API 表面上的原因)。

**Tested 2026-06-14 against Hono ~4.x running on Bun 1.3.14.** 行为记录在 https://hono.dev/api/hono#onerror。

Related: [[feedback-mine-the-pass-with-warn]](抓到了这个)。
