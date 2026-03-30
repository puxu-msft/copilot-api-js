# 阶段 1：测试基础设施

> 目标：让"写好测试"变得简单——覆盖率工具链、helpers、state 隔离、HTTP 测试框架一应俱全。

## 1. 覆盖率配置

### 1.1 bunfig.toml

在 `[test]` 段追加覆盖率配置：

```toml
[test]
root = "./tests"
coverage = true
coverageReporter = ["text", "lcov"]
coverageDir = "coverage"
```

### 1.2 package.json scripts

基于当前 `package.json` 的增量修改（不覆盖已有的 `test:all`/`test:backend`/`test:ci`/`test:ui` 等命令）：

```jsonc
{
  "scripts": {
    // ── 新增 ──
    "test:cov": "bun test --coverage tests/unit/ tests/component/ tests/contract/ tests/integration/",
    "test:cov:report": "bun test --coverage --coverage-reporter lcov tests/unit/ tests/component/ tests/contract/ tests/integration/",
    "test:http": "bun test tests/http/",
    "test:ws": "bun test tests/ws/"
  }
}
```

**待讨论**：`test:backend` 和 `test:ci` 是否应纳入 `tests/http/` 和 `tests/ws/`。当前它们只包含 unit/component/contract/integration/e2e，新增的 HTTP 和 WS 测试需要显式加入还是独立运行，取决于 CI 策略。

### 1.3 .gitignore

```
coverage/
```

### 1.4 覆盖率门禁

CI 中设置覆盖率阈值（最终目标）：
- 行覆盖率 ≥ 80%
- 分支覆盖率 ≥ 70%

初期不设硬门禁，先建立基线，逐步收紧。

## 2. 全局 State 隔离 ✅ 已实现

> 本节记录已落地的方案。重构已将 state 改为 readonly + 专用 setter，无需额外 helper。

### 2.1 架构

`src/lib/state.ts` 的 `State` 接口所有字段均为 `readonly`。应用代码通过领域 setter 修改（`setModels()`、`setCliState()` 等），测试通过专用 API 修改：

| API | 用途 |
|-----|------|
| `snapshotStateForTests()` | 深克隆当前 state，返回 `StateSnapshot` |
| `setStateForTests(patch)` | 带克隆的 test-only 写入。自动 `rebuildModelIndex()` |
| `restoreStateForTests(snapshot)` | 从快照恢复（深克隆后写入） |
| `setModels(models)` | 设置 models 并自动重建索引 |

**所有对象型字段**（`models`、`tokenInfo`、`copilotTokenInfo`、`modelOverrides`、`systemPromptOverrides`、`rewriteSystemReminders`、`adaptiveRateLimitConfig`）均在 `cloneState()` / `cloneStatePatch()` 中有专门的深拷贝逻辑，无需调用者操心。

### 2.2 使用模式

```typescript
import { setStateForTests, snapshotStateForTests, restoreStateForTests } from "~/lib/state"

// 模式 1：beforeEach/afterEach 自动隔离（推荐 describe block）
let snapshot: StateSnapshot
beforeEach(() => { snapshot = snapshotStateForTests() })
afterEach(() => { restoreStateForTests(snapshot) })

test("...", () => {
  setStateForTests({ autoTruncate: false })
  // ...
})

// 模式 2：行内恢复（推荐单个 test）
test("...", () => {
  const snap = snapshotStateForTests()
  try {
    setStateForTests({ immutableThinkingMessages: true })
    // ...
  } finally {
    restoreStateForTests(snap)
  }
})
```

### 2.3 迁移状态

**已完成**。所有 18 个涉及 state 的测试文件已迁移到新 API。直接赋值 `state.xxx = ...` 为 0 处。

## 3. HTTP 测试框架

### 3.1 问题

当前已有零散的 route/handler 级 `app.request()` 测试（如 `history-api.test.ts`、`history-ui-route.test.ts`、`middleware-websocket.test.ts`），但尚未形成统一的 HTTP 测试框架——缺少以真实 server 装配路径（`onError`、`notFound`、根路由、`registerHttpRoutes`）为入口的完整 HTTP 层测试。

### 3.2 两级 App Helper

server 装配分布在两处：
- `src/server.ts`：定义根路由（`/`、`/health`）、全局 `onError`、`notFound`、中间件，调用 `registerHttpRoutes()`
- `src/routes/index.ts`：`registerHttpRoutes()` 注册所有 HTTP API 子路由；`registerWsRoutes()` 注册 WebSocket 路由

因此需要**两个不同粒度的 helper**：

新建 `tests/helpers/test-app.ts`：

```typescript
import { Hono } from "hono"

import { registerHttpRoutes } from "~/routes"
import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"

// ─── Browser probe paths (mirror server.ts) ───
const browserProbePaths = new Set(["/favicon.ico", "/.well-known/appspecific/com.chrome.devtools.json"])

/**
 * 创建完整装配的测试 app。
 * 复制 server.ts 的行为（onError、notFound、根路由、health、API 路由），
 * 但跳过副作用中间件（config 热重载、token 验证、TUI 日志、CORS）。
 *
 * 用途：basic-routes 测试、需要验证根路由 / 404 / 全局错误处理的场景。
 */
export function createFullTestApp() {
  const app = new Hono()

  // 全局错误处理（与 server.ts 一致）
  app.onError((error, c) => {
    if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
      return c.text("", 500)
    }
    return forwardError(c, error)
  })

  // 404 处理（与 server.ts 一致）
  app.notFound((c) => {
    if (browserProbePaths.has(c.req.path)) {
      return c.body(null, 204)
    }
    return c.json({ error: "Not Found" }, 404)
  })

  // 根路由
  app.get("/", (c) => c.text("Server running"))

  // Health check
  app.get("/health", (c) => {
    const healthy = Boolean(state.copilotToken && state.githubToken)
    return c.json(
      {
        status: healthy ? "healthy" : "unhealthy",
        checks: {
          copilotToken: Boolean(state.copilotToken),
          githubToken: Boolean(state.githubToken),
          models: Boolean(state.models),
        },
      },
      healthy ? 200 : 503,
    )
  })

  // 注册 HTTP API 路由（不含 WS，WS 需要 upgrade adapter）
  registerHttpRoutes(app)

  return app
}

/**
 * 创建最小化的测试 app，只注册指定路由。
 * 用途：隔离测试单个 handler 或路由子树。
 */
export function createMinimalApp(setup: (app: Hono) => void) {
  const app = new Hono()
  app.onError((error, c) => forwardError(c, error))
  setup(app)
  return app
}
```

**为什么不直接 `import { server } from "~/server"`**：
`server.ts` 在模块顶层创建 `server` 实例并注册中间件（`applyConfigToState`、`ensureValidCopilotToken`、`tuiMiddleware`）和 HTTP 路由。直接导入会执行这些副作用，且全局单例无法在测试间隔离。`createFullTestApp()` 在每次调用时创建新实例，跳过副作用中间件。

### 3.3 运行时 Bootstrap

核心 handler 依赖多个运行时单例。未初始化时 handler 会直接抛错，即使上游 API 全部 mock 好了。

**必须在 HTTP 测试 setup 中初始化**：

| 单例 | 初始化函数 | 来源 | 不初始化的后果 |
|------|-----------|------|-------------|
| RequestContextManager | `initRequestContextManager()` | `src/lib/context/manager.ts` | `getRequestContextManager()` 抛 Error |
| History Store | `initHistory()` | `src/lib/history/index.ts` | context consumers 写入失败 |
| Context Consumers | `registerContextConsumers()` | `src/lib/context/consumers.ts` | 请求完成后 history 不记录 |

新建 `tests/helpers/test-bootstrap.ts`：

```typescript
import { resetAdaptiveRateLimiter } from "~/lib/adaptive-rate-limiter"
import { initRequestContextManager } from "~/lib/context/manager"
import { registerContextConsumers } from "~/lib/context/consumers"
import { clearHistory, initHistory } from "~/lib/history"
import { _resetShutdownState } from "~/lib/shutdown"
import { tuiLogger } from "~/lib/tui"

let initialized = false

/**
 * 初始化 HTTP 测试所需的运行时单例。
 * 幂等：多次调用只初始化一次。
 *
 * 在 HTTP 测试的 beforeAll 中调用。
 */
export function bootstrapTestRuntime() {
  if (initialized) return

  // History store（context consumers 依赖它）
  initHistory(false, 100)

  // Request context manager + consumers
  const manager = initRequestContextManager()
  registerContextConsumers(manager)

  initialized = true
}

/**
 * 重置测试间需要清理的全局状态。
 * 在 HTTP 测试的 afterEach 中调用。
 *
 * 对应 bootstrapTestRuntime 初始化的模块 + handler 执行中产生的副作用。
 */
export function resetTestRuntime() {
  // 1. shutdown 状态
  _resetShutdownState()

  // 2. history 数据（handler 执行后会写入 history entries）
  clearHistory()

  // 3. TUI logger（handler 执行后会注册/完成 request entries）
  tuiLogger.clear()

  // 4. rate limiter（如果测试初始化了 rate limiter）
  resetAdaptiveRateLimiter()
}
```

> **扩展清理的原则**：`resetTestRuntime()` 应覆盖 handler 执行一次请求后可能产生的所有全局副作用。
> 如果后续新增了其他全局单例（如 WS client 集合），也应同步加入此函数。

**使用方式**：

```typescript
import { beforeAll, afterEach } from "bun:test"
import { createFullTestApp } from "../helpers/test-app"
import { bootstrapTestRuntime, resetTestRuntime } from "../helpers/test-bootstrap"

beforeAll(() => {
  bootstrapTestRuntime()
})

afterEach(() => {
  resetTestRuntime()
})

const app = createFullTestApp()

test("POST /v1/messages returns 400 for unsupported model", async () => {
  // 现在 handler 可以正常执行了
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "nonexistent",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
    }),
  })

  expect(res.status).toBe(400)
  const body = await res.json()
  expect(body.error.type).toBe("invalid_request_error")
})
```

### 3.4 WebSocket 测试 — 独立目录，Integration 性质

WebSocket 路由通过 `registerWsRoutes(app, wsUpgrade)` 注册，与 HTTP 路由 (`registerHttpRoutes`) 分离。WS 路由需要一个 `UpgradeWebSocket` adapter，该 adapter 在 `start.ts` 中由 `createWebSocketAdapter()` 创建后传入。

**`app.request()` 无法覆盖 WebSocket 路径**。WebSocket 测试需要独立策略：

- **协议逻辑**（payload 解析、事件格式、错误帧）：当前已有 `tests/unit/responses-websocket.test.ts` 覆盖，属于 Unit 层
- **传输层**（upgrade 注册、消息收发、连接生命周期）：需要真实 WebSocket 连接

**WS 测试的定位**：`tests/ws/` 是**按协议类型归类的 Integration 测试**。它在目录上独立分组（因为技术边界与 HTTP 不同），但本质是 Integration 级别——必须走真实连接，不使用 mock WSContext。

WebSocket 测试放在 `tests/ws/` 目录，不归入 `tests/http/`。详见 [03-test-layers.md](03-test-layers.md) 的 WebSocket 测试定义。

### 3.5 目录结构

```
tests/
├── http/                         # HTTP 层测试（app.request()）
│   ├── basic-routes.test.ts      # /、/health、404、favicon、全局错误
│   ├── messages.test.ts          # POST /v1/messages
│   ├── chat-completions.test.ts  # POST /chat/completions
│   ├── responses.test.ts         # POST /v1/responses
│   └── models.test.ts            # GET /models
├── ws/                           # WebSocket 传输层测试（新增）
│   └── responses-ws.test.ts      # WS /v1/responses
└── helpers/
    ├── test-app.ts               # createFullTestApp / createMinimalApp
    └── test-bootstrap.ts         # bootstrapTestRuntime / resetTestRuntime
```

## 4. Factory 体系

### 4.1 现状

当前 `tests/helpers/factories.ts` 仅有 4 个 factory，全部针对 OpenAI Chat Completions 格式。

### 4.2 扩展计划

在 `tests/helpers/factories.ts` 中补充：

```typescript
// === Anthropic 格式 ===

/** 创建 Anthropic MessagesPayload */
export function mockAnthropicPayload(
  overrides?: Partial<MessagesPayload>,
): MessagesPayload

/** 创建带 tool_use 的 assistant 消息 */
export function mockToolUseMessage(
  tools: Array<{ id: string; name: string; input: unknown }>,
): MessageParam

/** 创建 tool_result 用户消息 */
export function mockToolResultMessage(
  results: Array<{ tool_use_id: string; content: string }>,
): MessageParam

/** 创建带 thinking block 的 assistant 消息 */
export function mockThinkingMessage(
  thinking: string,
  text: string,
): MessageParam

/** 创建 server_tool_use + web_search_tool_result 消息对 */
export function mockServerToolPair(
  toolName: string,
  input: Record<string, unknown>,
): { assistant: MessageParam; user: MessageParam }

// === Responses API 格式 ===

/** 创建 ResponsesPayload */
export function mockResponsesPayload(
  overrides?: Partial<ResponsesPayload>,
): ResponsesPayload

// === 通用 ===

/** 创建 HTTPError */
export function mockHTTPError(
  status: number,
  body?: string,
): HTTPError

/** 创建 ApiError */
export function mockApiError(
  type: ApiError["type"],
  overrides?: Partial<ApiError>,
): ApiError

/** 创建 RequestContext */
export function mockRequestContext(
  overrides?: Partial<RequestContext>,
): RequestContext
```

### 4.3 设计原则

- **默认值合理**：每个 factory 开箱即用，返回合法的数据
- **overrides 模式**：`Partial<T>` spread 覆盖，只指定关心的字段
- **可组合**：复杂场景通过组合简单 factory 构建
- **类型安全**：返回精确类型，不用 `as any`

## 5. Fixture 扩充

### 5.1 现状

```
tests/fixtures/
├── anthropic-messages/      simple, tool-use
├── openai-chat-completions/ simple, tool-call
└── openai-responses/        simple, function-call
```

共 6 个场景，仅覆盖非流式 happy path。

### 5.2 扩充计划

```
tests/fixtures/
├── anthropic-messages/
│   ├── simple/              request.json, response.json
│   ├── tool-use/            request.json, response.json, followup-*
│   ├── streaming/           request.json, events.jsonl         # 新增
│   ├── thinking/            request.json, response.json        # 新增
│   ├── server-tool/         request.json, response.json        # 新增
│   └── errors/              # 新增
│       ├── 413.json         payload-too-large 响应
│       ├── 429.json         rate-limited 响应
│       └── 400-token.json   token-limit 响应
├── openai-chat-completions/
│   ├── simple/
│   ├── tool-call/
│   ├── streaming/           request.json, events.jsonl         # 新增
│   └── errors/              # 新增
│       ├── 413.json
│       └── 429.json
└── openai-responses/
    ├── simple/
    ├── function-call/
    ├── streaming/           request.json, events.jsonl         # 新增
    └── errors/              # 新增
```

### 5.3 Fixture 捕获工具

日后考虑添加 fixture 录制工具，从实际 API 请求中捕获。当前手动创建即可。

## 6. CI 集成

### 6.1 测试命令

```yaml
# CI pipeline（计划新增的命令）
- bun run test:http         # HTTP 层测试
- bun run test:ws           # WebSocket 传输层测试
- bun run test:cov:report   # 覆盖率报告（lcov 格式）

# 现有命令（参考，不修改）
# test:ci → test:backend → unit + component + contract + integration + e2e
# test:all → test:backend + test:ui
# test:acceptance → test:backend + test:ui + test:e2e-ui
```

### 6.2 覆盖率趋势

- lcov 输出到 `coverage/lcov.info`
- CI 可上传到覆盖率服务（Codecov / Coveralls）跟踪趋势
- 初期只记录，不阻断；达到 60% 后开始设门禁

## 7. 实施检查清单

- [ ] 配置 `bunfig.toml` 覆盖率
- [ ] 扩展 `package.json` scripts（新增 `test:cov`、`test:cov:report`、`test:http`、`test:ws`）
- [ ] `.gitignore` 添加 `coverage/`
- [x] ~~创建 `tests/helpers/test-state.ts`~~ — 已由 `state.ts` 内置 API 取代
- [ ] 创建 `tests/helpers/test-app.ts`（`createFullTestApp` / `createMinimalApp`）
- [ ] 创建 `tests/helpers/test-bootstrap.ts`（`bootstrapTestRuntime` / `resetTestRuntime`）
- [ ] 扩展 `tests/helpers/factories.ts`
- [ ] 扩充 `tests/fixtures/` 目录
- [ ] 创建 `tests/http/` 目录结构
- [ ] 创建 `tests/ws/` 目录结构
- [ ] 运行 `bun run test:cov` 建立覆盖率基线
- [ ] 用新基础设施写一个示例 HTTP 测试验证可行性（`tests/http/basic-routes.test.ts`）
