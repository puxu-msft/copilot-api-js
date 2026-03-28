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

```jsonc
{
  "scripts": {
    // 现有
    "test": "bun test tests/unit/",
    "test:all": "bun test tests/",
    "test:ci": "bun test tests/unit/ tests/component/ tests/contract/ tests/integration/",

    // 新增
    "test:cov": "bun test --coverage tests/unit/ tests/component/ tests/contract/ tests/integration/",
    "test:cov:report": "bun test --coverage --coverage-reporter lcov tests/unit/ tests/component/ tests/contract/ tests/integration/",
    "test:http": "bun test tests/http/"
  }
}
```

### 1.3 .gitignore

```
coverage/
```

### 1.4 覆盖率门禁

CI 中设置覆盖率阈值（最终目标）：
- 行覆盖率 ≥ 80%
- 分支覆盖率 ≥ 70%

初期不设硬门禁，先建立基线，逐步收紧。

## 2. 全局 State 隔离

### 2.1 问题

当前测试直接读写全局 `state` 对象，依赖手动 save/restore：

```typescript
// 当前方式 — 容易遗漏字段，test throw 时无法恢复
const original = state.immutableThinkingMessages
state.immutableThinkingMessages = true
afterEach(() => { state.immutableThinkingMessages = original })
```

`state` 有 30+ 个字段，每个测试只恢复自己修改的字段，但其他测试可能依赖它们的默认值。

### 2.2 方案：`withTestState()`

新建 `tests/helpers/test-state.ts`：

```typescript
import { state, type State } from "~/lib/state"

/** 保存 state 快照，执行 fn，无论成功失败都恢复 */
export async function withTestState(
  overrides: Partial<State>,
  fn: () => Promise<void> | void,
): Promise<void> {
  // 浅拷贝当前 state 所有字段
  const snapshot = { ...state }
  // 对 Map/Set 做深拷贝
  const indexSnapshot = new Map(state.modelIndex)
  const idsSnapshot = new Set(state.modelIds)
  const overridesSnapshot = { ...state.modelOverrides }

  try {
    Object.assign(state, overrides)
    await fn()
  } finally {
    // 恢复所有字段
    Object.assign(state, snapshot)
    state.modelIndex = indexSnapshot
    state.modelIds = idsSnapshot
    state.modelOverrides = overridesSnapshot
  }
}

/**
 * 为 describe block 提供 beforeEach/afterEach 自动隔离。
 * 用法：
 *   const { setState } = useTestState()
 *   test("...", () => { setState({ autoTruncate: false }); ... })
 */
export function useTestState() {
  let snapshot: Record<string, unknown> = {}
  let indexSnapshot: Map<string, unknown>
  let idsSnapshot: Set<string>

  beforeEach(() => {
    snapshot = { ...state }
    indexSnapshot = new Map(state.modelIndex)
    idsSnapshot = new Set(state.modelIds)
  })

  afterEach(() => {
    Object.assign(state, snapshot)
    state.modelIndex = indexSnapshot as any
    state.modelIds = idsSnapshot
  })

  return {
    setState: (overrides: Partial<State>) => Object.assign(state, overrides),
  }
}
```

### 2.3 迁移策略

- 新测试必须使用 `withTestState()` 或 `useTestState()`
- 现有测试在修改时逐步迁移，不一次性批量改
- 两种模式共存：单测试用 `withTestState(fn)`，describe block 用 `useTestState()`

## 3. HTTP 测试框架

### 3.1 问题

项目使用 Hono 框架但无 HTTP 层测试。所有测试直接调用函数，跳过中间件、路由注册、Content-Type 协商、HTTP 状态码。

### 3.2 方案：`createTestApp()`

新建 `tests/helpers/test-app.ts`：

```typescript
import { Hono } from "hono"

import { registerRoutes } from "~/routes"
import { forwardError } from "~/lib/error"

/**
 * 创建一个用于测试的 Hono app 实例。
 * 注册所有路由但跳过副作用中间件（token 验证、TUI 日志等）。
 */
export function createTestApp() {
  const app = new Hono()

  // 错误处理（与 server.ts 一致）
  app.onError((error, c) => forwardError(c, error))

  // 注册路由
  registerRoutes(app)

  return app
}

/**
 * 创建一个最小化的 Hono app，只注册指定路由。
 * 用于隔离测试单个 handler。
 */
export function createMinimalApp(
  setup: (app: Hono) => void,
) {
  const app = new Hono()
  app.onError((error, c) => forwardError(c, error))
  setup(app)
  return app
}
```

使用方式：

```typescript
import { createTestApp } from "../helpers/test-app"

const app = createTestApp()

test("POST /v1/messages returns 400 for unsupported model", async () => {
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

### 3.3 中间件隔离

`createTestApp()` 不注册以下中间件：
- `applyConfigToState()` — 测试不依赖文件系统
- `ensureValidCopilotToken()` — 测试不依赖真实 token
- `tuiMiddleware()` — 测试不需要 TUI 日志
- `cors()` / `trimTrailingSlash()` — 可选注册

需要测试中间件行为时，使用 `createMinimalApp()` 按需注册。

### 3.4 目录结构

新建 `tests/http/` 目录放置 HTTP 层测试：

```
tests/http/
├── messages.test.ts          # /v1/messages 路由
├── chat-completions.test.ts  # /chat/completions 路由
├── responses.test.ts         # /v1/responses 路由
├── models.test.ts            # /models 路由
├── health.test.ts            # /health 路由
└── error-handling.test.ts    # 全局错误处理
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
# CI pipeline
- bun run test:ci           # 单元 + 组件 + 契约 + 集成（不含 E2E）
- bun run test:http         # HTTP 层测试
- bun run test:cov:report   # 覆盖率报告（lcov 格式）
```

### 6.2 覆盖率趋势

- lcov 输出到 `coverage/lcov.info`
- CI 可上传到覆盖率服务（Codecov / Coveralls）跟踪趋势
- 初期只记录，不阻断；达到 60% 后开始设门禁

## 7. 实施检查清单

- [ ] 配置 `bunfig.toml` 覆盖率
- [ ] 扩展 `package.json` scripts
- [ ] `.gitignore` 添加 `coverage/`
- [ ] 创建 `tests/helpers/test-state.ts`
- [ ] 创建 `tests/helpers/test-app.ts`
- [ ] 扩展 `tests/helpers/factories.ts`
- [ ] 扩充 `tests/fixtures/` 目录
- [ ] 创建 `tests/http/` 目录结构
- [ ] 运行 `bun run test:cov` 建立基线
- [ ] 用新基础设施写一个示例 HTTP 测试验证可行性
