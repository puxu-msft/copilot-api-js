# 阶段 2：测试分层设计

> 目标：每个测试层有明确的职责边界和编写规范，确保测试金字塔健康。

## 测试金字塔

```
                    ╱╲
                   ╱E2E╲           需要真实 token，CI 仅在 release 时运行
                  ╱──────╲
                 ╱  HTTP   ╲       Hono app.request()，mock 外部依赖
                ╱────────────╲
               ╱ Integration   ╲   多模块真实组合，mock 网络边界
              ╱──────────────────╲
             ╱    Contract         ╲  API 格式合规性验证
            ╱────────────────────────╲
           ╱      Component            ╲  单模块 + 协作者 mock
          ╱──────────────────────────────╲
         ╱          Unit                   ╲  纯函数，零依赖
        ╱════════════════════════════════════╲
```

| 层级 | 数量目标 | 执行速度 | CI 策略 |
|------|---------|---------|---------|
| Unit | 最多 (~60%) | < 1ms/case | 每次提交 |
| Component | 较多 (~20%) | < 10ms/case | 每次提交 |
| Contract | 适量 (~5%) | < 10ms/case | 每次提交 |
| Integration | 适量 (~10%) | < 100ms/case | 每次提交 |
| HTTP | 适量 (~5%) | < 50ms/case | 每次提交 |
| E2E | 少量 | < 30s/case | Release / 手动 |

## 1. Unit 测试

### 职责

测试**纯函数**和**无副作用**的逻辑单元。输入 → 输出，不涉及 I/O、全局状态、时间。

### 规范

- **零外部依赖**：不读 `state`、不发网络请求、不读文件系统
- **无 mock**：如果需要 mock 才能测，说明被测函数不够"纯"，考虑提取纯函数部分
- **快速**：每个用例 < 1ms
- **命名**：`tests/unit/<module-name>.test.ts`

### 适用模块

| 模块 | 测试内容 |
|------|---------|
| `lib/error.ts` | `classifyError()`、`parseRetryAfter()` |
| `lib/utils.ts` | 工具函数 |
| `lib/sanitize-system-reminder.ts` | 标签提取、移除 |
| `lib/repetition-detector.ts` | KMP 重复检测 |
| `lib/anthropic/message-mapping.ts` | 消息索引映射 |
| `lib/openai/orphan-filter.ts` | 孤儿 tool call 过滤 |
| `lib/openai/responses-conversion.ts` | Responses 数据格式转换 |
| `lib/request/truncation.ts` | 截断逻辑 |
| `lib/tui/format.ts` | 日志格式化 |

### 示例

```typescript
// tests/unit/error.test.ts
import { classifyError } from "~/lib/error"

test("classifyError: 429 → rate_limited", () => {
  const error = new HTTPError("Rate limited", 429, "")
  const result = classifyError(error)

  expect(result.type).toBe("rate_limited")
  expect(result.status).toBe(429)
})
```

### 反模式

```typescript
// BAD: unit 测试读全局 state
test("something", () => {
  state.autoTruncate = true  // ← 不应该出现在 unit 测试中
  const result = someFunction(input)
  expect(result).toBe(expected)
})

// GOOD: 纯函数接受参数
test("something", () => {
  const result = someFunction(input, { autoTruncate: true })
  expect(result).toBe(expected)
})
```

## 2. Component 测试

### 职责

测试**单个模块**的行为，协作者通过 mock 替代。验证模块的公开接口在各种输入（正常、边界、错误）下的行为。

### 规范

- **单一被测模块**：一个 component test 文件对应一个源模块
- **Mock 协作者**：网络请求、文件 I/O、其他模块的复杂行为
- **允许使用 state**：通过 `withTestState()` 隔离
- **命名**：`tests/component/<module-name>.test.ts`

### 适用模块

| 模块 | Mock 目标 | 测试内容 |
|------|----------|---------|
| `lib/request/pipeline.ts` | `adapter.execute()` | 重试逻辑、策略选择、maxRetries |
| `lib/shutdown.ts` | server、tracker | 4 阶段关闭流程 |
| `lib/auto-truncate/index.ts` | 无（纯状态机） | token 限制学习、预检查 |
| `lib/adaptive-rate-limiter.ts` | 时间（`Date.now`） | 3 模式状态转换 |
| `lib/history/store.ts` | 无 | CRUD、查询、内存限制 |
| `lib/context/manager.ts` | 无 | 请求跟踪、stale reaper |
| `lib/config/config.ts` | 文件系统 | 配置加载、热重载 |
| `lib/models/resolver.ts` | `state.models` | 别名解析、override 链 |

### 示例

```typescript
// tests/component/pipeline.test.ts
import { createMockAdapter } from "../helpers/mock-adapter"
import { createRetryStrategy } from "../helpers/mock-strategy"

test("retries with new payload from strategy", async () => {
  let callCount = 0
  const adapter = createMockAdapter({
    execute: mock(async () => {
      if (++callCount === 1) throw new HTTPError("Too large", 413, "")
      return { result: { ok: true }, queueWaitMs: 5 }
    }),
  })
  const strategy = createRetryStrategy({ data: "truncated" })

  const result = await executeRequestPipeline({
    adapter,
    payload: { data: "original" },
    originalPayload: { data: "original" },
    strategies: [strategy],
    model: undefined,
  })

  expect(result.totalRetries).toBe(1)
  expect(result.effectivePayload).toEqual({ data: "truncated" })
})
```

## 3. Contract 测试

### 职责

验证本项目产出的**数据结构符合外部 API 的契约**。不关心内部实现，只关心输入/输出的格式合规性。

### 规范

- **面向外部消费者**：测试的是"其他系统能不能正确消费我们的输出"
- **使用真实 fixture**：从 `tests/fixtures/` 加载
- **结构验证**：检查必需字段存在、类型正确、格式合规
- **命名**：`tests/contract/<contract-name>.test.ts`

### 适用场景

| Contract | 说明 |
|----------|------|
| `error-format` | 错误响应符合 Anthropic `{type: "error", error: {...}}` 格式 |
| `openai-types` | Chat Completions 响应符合 OpenAI 规范 |
| `embeddings-types` | Embeddings 响应格式 |
| `anthropic-response` | **新增**：Anthropic 非流式响应结构 |
| `sse-events` | **新增**：各 API 的 SSE 事件格式合规 |
| `responses-format` | **新增**：Responses API 格式 |

### 示例

```typescript
// tests/contract/anthropic-response.test.ts
import { loadFixturePair } from "../helpers/fixtures"

test("Anthropic simple response has required fields", () => {
  const { response } = loadFixturePair("anthropic-messages", "simple")

  // 必需字段
  expect(response.id).toMatch(/^msg_/)
  expect(response.type).toBe("message")
  expect(response.role).toBe("assistant")
  expect(Array.isArray(response.content)).toBe(true)
  expect(response.model).toMatch(/^claude-/)
  expect(response.stop_reason).toBeOneOf(["end_turn", "stop_sequence", "tool_use", "max_tokens"])

  // usage 结构
  expect(typeof response.usage.input_tokens).toBe("number")
  expect(typeof response.usage.output_tokens).toBe("number")
})
```

## 4. Integration 测试

### 职责

测试**多个真实模块协同工作**，只在最外层网络边界 mock。验证模块间的交互、数据流转、错误传播。

### 规范

- **真实模块组合**：pipeline + strategy + sanitize + truncation 一起工作
- **仅 Mock 网络边界**：`adapter.execute()` 模拟 API 响应
- **允许 state**：通过 `withTestState()` 设置
- **验证行为链**：一个用例覆盖多步数据流转
- **命名**：`tests/integration/<scenario>.test.ts`

### 适用场景

| 场景 | 涉及模块 |
|------|---------|
| `pipeline-with-strategy` | pipeline + real classifyError + real autoTruncateStrategy |
| `sanitize-then-translate` | sanitize → responses-conversion |
| `shutdown-abort-flow` | shutdown + stream abort + tracker |
| `stream-shutdown-race` | stream race + abort signal |
| **新增** `full-request-chain` | sanitize → pipeline → stream → recording |
| **新增** `model-resolution-routing` | model resolve → endpoint check → adapter 选择 |
| **新增** `token-refresh-recovery` | pipeline + token-refresh strategy + retry |

### 示例

```typescript
// tests/integration/full-request-chain.test.ts
test("sanitize → pipeline → recording: complete anthropic chain", async () => {
  await withTestState({ autoTruncate: true }, async () => {
    // 构造一个包含孤儿 tool_result 的 payload
    const payload = mockAnthropicPayload({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: {} }] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
          { type: "tool_result", tool_use_id: "orphan", content: "stale" },
        ]},
      ],
    })

    // sanitize 应清除孤儿
    const sanitized = sanitizeAnthropicMessages(payload)
    expect(sanitized.blocksRemoved).toBeGreaterThan(0)

    // pipeline 应成功执行
    const adapter = createMockAdapter({
      execute: mock(async () => ({ result: mockAnthropicResponse(), queueWaitMs: 10 })),
    })
    const result = await executeRequestPipeline({
      adapter,
      payload: sanitized.payload,
      originalPayload: payload,
      strategies: [],
      model: undefined,
    })
    expect(result.response).toBeDefined()
  })
})
```

## 5. HTTP 测试

### 职责

通过 Hono `app.request()` 发起**真实 HTTP 请求**到应用，验证路由注册、中间件、HTTP 状态码、Header、Content-Type、SSE 流格式。

### 规范

- **通过 HTTP 层进入**：使用 `createTestApp().request()` 或 `createMinimalApp()`
- **Mock 上游 API**：handler 内部的 client 调用需要 mock
- **验证 HTTP 级别行为**：状态码、Content-Type、Header、响应体结构
- **命名**：`tests/http/<route-name>.test.ts`

### 适用场景

| 路由 | 测试内容 |
|------|---------|
| `POST /v1/messages` | model 校验、流式/非流式切换、错误响应格式 |
| `POST /chat/completions` | OpenAI 格式请求/响应 |
| `POST /v1/responses` | Responses API、call ID 标准化 |
| `GET /models` | 模型列表格式 |
| `GET /health` | 健康检查状态码 |
| `POST /v1/messages/count_tokens` | Token 计数响应 |
| `*` | 全局错误处理（404、500） |

### 示例

```typescript
// tests/http/health.test.ts
import { createTestApp } from "../helpers/test-app"

const app = createTestApp()

test("GET /health returns 503 when no token", async () => {
  await withTestState({ copilotToken: undefined, githubToken: undefined }, async () => {
    const res = await app.request("/health")

    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.status).toBe("unhealthy")
    expect(body.checks.copilotToken).toBe(false)
  })
})

test("GET /health returns 200 when tokens present", async () => {
  await withTestState({ copilotToken: "test", githubToken: "ghp_test" }, async () => {
    const res = await app.request("/health")

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("healthy")
  })
})
```

### HTTP 测试中的 mock 策略

HTTP 测试需要 mock 的是**上游 API 调用**（`createAnthropicMessages`、`createChatCompletions` 等），而不是 handler 内部逻辑。方式有两种：

1. **Module mock**：Bun 支持 `mock.module()` mock 整个模块的导出
2. **依赖注入**：将 client 函数通过参数传入 handler（需要重构，后续考虑）

当前推荐方案 1，低侵入：

```typescript
import { mock } from "bun:test"

// Mock 上游 client
mock.module("~/lib/anthropic/client", () => ({
  createAnthropicMessages: mock(async () => ({
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Hello" }],
    model: "claude-sonnet-4",
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  })),
}))
```

## 6. E2E 测试

### 职责

使用**真实 GitHub token** 调用真实 Copilot API，验证端到端功能。

### 规范

- **需要环境变量**：`GITHUB_TOKEN`
- **不在 CI 常规流程中运行**：仅 release 前或手动触发
- **超时宽松**：30s+ per case
- **命名**：`tests/e2e/<scenario>.test.ts`
- **使用 `describeWithToken` 保护**：无 token 时自动跳过

### 现有覆盖

| 文件 | 内容 |
|------|------|
| `copilot-api.test.ts` | Models API、Chat Completions、Anthropic Direct、Tool Calling |
| `extended-api.test.ts` | 扩展 API 功能 |
| `model-resolution.test.ts` | 真实模型解析 |
| `model-endpoint-completeness.test.ts` | 模型端点完整性 |

### 需要加强

- Responses API E2E
- Streaming E2E（验证 SSE 事件完整性）
- 多轮对话 E2E

## 7. Mock 使用规范

### 何时使用 Mock

| 场景 | 是否 Mock | 说明 |
|------|----------|------|
| 网络请求（HTTP API 调用） | **是** | 测试不应依赖外部服务可用性 |
| 文件系统（config 读取） | **是** | 使用临时目录或 mock |
| 全局 state | **隔离** | 使用 `withTestState()` |
| 时间（`Date.now()`） | **视需要** | rate limiter 等时间敏感逻辑需要 mock |
| 随机数 | **视需要** | ID 生成等需要确定性结果时 |
| 被测模块的内部函数 | **否** | 测试行为而非实现 |
| 同层模块间的协作 | **否**（integration）/**是**（component） | 取决于测试层级 |

### Mock 粒度原则

1. **Unit**：零 mock。如果需要 mock 才能 unit test，说明函数需要提取纯逻辑
2. **Component**：mock 协作者的公开接口（不 mock 内部实现细节）
3. **Integration**：仅 mock 最外层 I/O 边界（网络、文件系统）
4. **HTTP**：mock 上游 API client，其他模块用真实实现
5. **E2E**：零 mock

### Mock 反模式

```typescript
// BAD: mock 内部实现细节
spyOn(module, "_internalHelper").mockReturnValue(...)

// BAD: mock 太深导致测试不验证任何东西
mock(async () => expectedResult)  // 直接返回期望结果

// BAD: 全局 mock 不清理
beforeAll(() => { globalThis.fetch = mockFetch })
// missing afterAll cleanup

// GOOD: mock 边界接口
const adapter = createMockAdapter({ execute: mock(async () => ({ ... })) })

// GOOD: mock 后清理
afterEach(() => { mockRestore() })
```

## 8. 断言规范

### 禁止的弱断言模式

```typescript
// BAD: toBeDefined 不验证值
expect(response).toBeDefined()

// BAD: try/catch 不保证 throw
try {
  await riskyOperation()
} catch (error) {
  expect(error).toBeDefined()
}

// BAD: if 守卫跳过断言
if (typeof content !== "string") {
  expect(content).toHaveLength(3)
}
```

### 正确的断言模式

```typescript
// GOOD: 验证具体值
expect(response.id).toMatch(/^msg_/)
expect(response.choices).toHaveLength(1)
expect(response.choices[0].message.content).toBe("Hello")

// GOOD: expect().rejects 验证 throw
await expect(riskyOperation()).rejects.toThrow(HTTPError)
await expect(riskyOperation()).rejects.toThrow(/Too large/)

// GOOD: 先断言类型，再断言值
expect(typeof content).not.toBe("string")
expect(Array.isArray(content)).toBe(true)
expect(content).toHaveLength(3)
// 或使用 Bun 的 toBeArrayOfSize
expect(content).toBeArrayOfSize(3)

// GOOD: toEqual 验证结构
expect(result).toEqual({
  action: "retry",
  payload: { data: "truncated" },
})

// GOOD: toMatchObject 验证子集
expect(response).toMatchObject({
  type: "message",
  role: "assistant",
})
```

### 断言密度指南

每个 `test()` block 应有 **2-5 个有意义的断言**。一个断言太少（可能遗漏），超过 10 个太多（考虑拆分）。

## 9. 测试目录约定

```
tests/
├── unit/                          # 纯函数测试
│   ├── error.test.ts              # → src/lib/error.ts
│   ├── utils.test.ts              # → src/lib/utils.ts
│   └── <module-name>.test.ts
├── component/                     # 单模块 + mock 协作者
│   ├── pipeline.test.ts           # → src/lib/request/pipeline.ts
│   ├── shutdown.test.ts           # → src/lib/shutdown.ts
│   └── <module-name>.test.ts
├── contract/                      # API 格式合规性
│   ├── error-format.test.ts
│   ├── openai-types.test.ts
│   └── <contract-name>.test.ts
├── integration/                   # 多模块真实组合
│   ├── pipeline-with-strategy.test.ts
│   └── <scenario>.test.ts
├── http/                          # HTTP 层测试（新增）
│   ├── messages.test.ts
│   ├── health.test.ts
│   └── <route-name>.test.ts
├── e2e/                           # 真实 API 测试
│   ├── copilot-api.test.ts
│   └── <scenario>.test.ts
├── helpers/                       # 测试工具
│   ├── factories.ts               # 数据工厂
│   ├── fixtures.ts                # fixture 加载器
│   ├── test-state.ts              # state 隔离（新增）
│   ├── test-app.ts                # Hono 测试 app（新增）
│   ├── mock-adapter.ts
│   ├── mock-strategy.ts
│   ├── mock-server.ts
│   ├── mock-tracker.ts
│   └── fake-stream.ts
└── fixtures/                      # 真实 API 数据
    ├── anthropic-messages/
    ├── openai-chat-completions/
    └── openai-responses/
```

### 命名规则

| 规则 | 说明 |
|------|------|
| 文件名 | `<source-module-name>.test.ts`（与源文件同名） |
| 嵌套模块 | 用 `-` 连接：`anthropic-features.test.ts` → `lib/anthropic/features.ts` |
| 场景测试 | 用场景命名：`pipeline-with-strategy.test.ts` |
| describe | 使用被测函数/类名：`describe("classifyError", ...)` |
| test | 使用 "should" 句式：`test("should return rate_limited for 429", ...)` |
