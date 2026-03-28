# 阶段 3：覆盖率提升计划

> 目标：系统性补齐现有代码的测试覆盖，最终达到行覆盖率 80%、分支覆盖率 70%。

## 当前基线

| 指标 | 值 |
|------|---|
| 源文件总数 | ~80 |
| 有测试对应的源文件 | ~48 (~60%) |
| 测试用例总数 | ~1,200 |
| 路由/Handler 测试 | 0/15 |
| HTTP 层测试 | 0 |

详细覆盖矩阵见 [test-coverage-audit.md](../archive/test-coverage-audit.md)。

## 优先级定义

| 级别 | 定义 | 标准 |
|------|------|------|
| **P0** | 核心请求路径 | 用户每次请求都经过的代码 |
| **P1** | 关键业务逻辑 | 影响请求成功率、数据正确性的模块 |
| **P2** | 辅助模块 | UI 日志、配置路径、token 提供者等 |

## P0：核心请求路径

### Handler 层（HTTP 测试）

这是**最高优先级**——所有模块的胶水层，目前零覆盖。

| 文件 | 行数 | 测试策略 | 测试层 |
|------|------|---------|--------|
| `routes/messages/handler.ts` | 476 | mock `createAnthropicMessages`，验证 model 校验、sanitize 调用、流式/非流式分发、错误处理 | HTTP |
| `routes/chat-completions/handler.ts` | 358 | mock `createChatCompletions`，验证 OpenAI 格式处理 | HTTP |
| `routes/responses/handler.ts` | 235 | mock `createResponses`，验证 call ID 标准化、model 校验 | HTTP |
| `routes/responses/ws.ts` | 300 | WebSocket 升级、消息收发、错误处理 | HTTP |
| `routes/responses/pipeline.ts` | 77 | 适配器和策略组装正确性 | Component |

**每个 handler 的测试要点**：

#### `handleMessages`（`routes/messages/handler.ts`）

```
tests/http/messages.test.ts:
├── model 解析与校验
│   ├── 有效 Anthropic 模型 → 200/stream
│   ├── 无效模型 → 400
│   └── model override（opus → claude-opus-4.6）
├── 流式 vs 非流式
│   ├── stream: true → SSE Content-Type
│   └── stream: false → JSON Content-Type
├── sanitize 集成
│   ├── 孤儿 tool_use 被清除
│   └── system-reminder 按 config 处理
├── pipeline 集成
│   ├── 413 → auto-truncate 重试
│   ├── 401 → token refresh 重试
│   └── 网络错误 → network retry
├── 错误响应
│   ├── payload 解析失败 → 400
│   └── 上游 500 → 转发错误格式
└── 关闭期间
    └── shutdown 中 → 503
```

#### `handleChatCompletions`（`routes/chat-completions/handler.ts`）

```
tests/http/chat-completions.test.ts:
├── 请求格式
│   ├── OpenAI 标准格式 → 200
│   ├── 缺失 model → 400
│   └── 空 messages → 400
├── 流式处理
│   ├── stream: true → SSE
│   └── stream: false → JSON
├── Copilot header 构建
│   ├── intent header 正确
│   └── model header 正确
└── 错误处理
    ├── 上游错误转发
    └── rate limit → 429 + Retry-After
```

#### `handleResponses`（`routes/responses/handler.ts`）

```
tests/http/responses.test.ts:
├── model 校验
│   ├── 支持 /responses 的模型 → 200
│   └── 不支持的模型 → 400
├── call ID 标准化
│   ├── call_ → fc_ 转换
│   └── normalizeResponsesCallIds: false 时不转换
├── 流式处理
│   └── stream: true → SSE
└── 错误处理
    └── 400/500 错误转发
```

### 路由注册与基础路由

| 文件 | 测试内容 | 测试层 |
|------|---------|--------|
| `routes/index.ts` | 路由注册完整性 | HTTP |
| `routes/models/route.ts` | `GET /models` 返回模型列表 | HTTP |
| `routes/token/route.ts` | `GET /token` 返回 token 信息 | HTTP |
| `server.ts` | 404 处理、favicon 204、全局错误处理 | HTTP |

**打包为一个测试文件**：

```
tests/http/basic-routes.test.ts:
├── GET / → 200 "Server running"
├── GET /health → 200/503（根据 token 状态）
├── GET /models → 200 + 模型列表结构
├── GET /token → 200 + token 信息
├── GET /favicon.ico → 204（静默）
├── GET /nonexistent → 404
└── 全局错误 handler → Anthropic 错误格式
```

## P1：关键业务逻辑

### 自适应限流器

| 文件 | 行数 | 当前覆盖 | 需补充 |
|------|------|---------|--------|
| `lib/adaptive-rate-limiter.ts` | 527 | 有 28 个 component test | 需审查是否覆盖 3 模式完整转换 |

**测试要点**：
- Normal → Rate-limited（收到 429）
- Rate-limited → Recovering（cooldown 到期）
- Recovering → Normal（连续成功达标）
- Recovering → Rate-limited（恢复期间再次 429）
- `rejectQueued()`（shutdown 时清空队列）
- 并发请求排队行为

### Token 管理

| 文件 | 行数 | 测试策略 |
|------|------|---------|
| `lib/token/copilot-token-manager.ts` | 245 | mock `getCopilotToken`，测试刷新逻辑、过期检测、并发安全 |
| `lib/token/github-token-manager.ts` | 179 | mock 文件系统和 CLI，测试 token 获取、缓存、多 provider |
| `lib/token/copilot-client.ts` | — | mock HTTP，测试 API 调用格式 |

```
tests/component/copilot-token-manager.test.ts:
├── 首次获取 token
├── token 过期后自动刷新
├── 并发刷新只触发一次
├── 刷新失败后的恢复
└── 距过期 < 5分钟时主动刷新
```

### API Client 层

| 文件 | 行数 | 测试策略 |
|------|------|---------|
| `lib/anthropic/client.ts` | 228 | mock `fetch`，测试请求构造（header、body）、流式/非流式处理、错误映射 |
| `lib/openai/client.ts` | 67 | mock `fetch`，测试 OpenAI 请求构造 |
| `lib/openai/responses-client.ts` | 82 | mock `fetch`，测试 Responses 请求构造 |

```
tests/component/anthropic-client.test.ts:
├── 请求构造
│   ├── header: x-api-key、anthropic-version、beta headers
│   ├── body: model、messages、max_tokens
│   └── Copilot endpoint URL 构建
├── 非流式响应
│   ├── 成功 → 解析 JSON
│   └── 错误 → throw HTTPError
├── 流式响应
│   ├── 成功 → 返回 AsyncIterable
│   └── 中途断开 → 错误处理
└── direct vs copilot 路由
    ├── Anthropic vendor → direct API
    └── 非 Anthropic → copilot proxy
```

### Message Tools 预处理

| 文件 | 行数 | 测试策略 |
|------|------|---------|
| `lib/anthropic/message-tools.ts` | 326 | 纯逻辑，可 unit test |

```
tests/unit/message-tools.test.ts:
├── preprocessTools()
│   ├── tool 注入（defer_loading tools）
│   ├── server tool 剥离（stripServerTools = true）
│   ├── 空 tools 数组处理
│   └── 重复 tool 名去重
└── 各种 tool 类型处理
```

### Feature Negotiation

| 文件 | 行数 | 测试策略 |
|------|------|---------|
| `lib/anthropic/feature-negotiation.ts` | 33 | 纯逻辑 |
| `lib/anthropic/thinking-immutability.ts` | 28 | 纯逻辑 |

```
tests/unit/feature-negotiation.test.ts:
├── 特性检测
│   ├── thinking 支持
│   ├── context_management 支持
│   └── 未知模型默认行为
```

### Auto-Truncate 引擎

| 文件 | 行数 | 当前覆盖 | 需补充 |
|------|------|---------|--------|
| `lib/auto-truncate/index.ts` | 425 | 有 61 个测试 | 审查 token 限制学习、预检查逻辑 |

### Memory Pressure

| 文件 | 行数 | 测试策略 |
|------|------|---------|
| `lib/history/memory-pressure.ts` | 202 | mock 堆统计，测试 LRU 淘汰、最小保留 |

```
tests/component/memory-pressure.test.ts:
├── 正常堆使用 → 不淘汰
├── 高堆使用 → LRU 淘汰最旧条目
├── 淘汰不低于 historyMinEntries
├── 堆统计获取失败 → 安全降级
└── 连续监控周期
```

## P2：辅助模块

| 文件 | 测试策略 | 优先级 |
|------|---------|--------|
| `lib/tui/console-renderer.ts` | 纯 UI 输出，低优先级 | P2 |
| `lib/request/payload.ts` | 辅助日志函数 | P2 |
| `lib/config/paths.ts` | `ensurePaths()` 目录创建 | P2 |
| `lib/token/providers/cli.ts` | CLI token 提供者 | P2 |
| `lib/token/providers/env.ts` | 环境变量 token | P2 |
| `lib/token/providers/file.ts` | 文件 token | P2 |
| `lib/token/providers/base.ts` | 基类 | P2 |
| `lib/copilot-api.ts` | 常量和 header 构造 | P2 |
| `lib/proxy.ts` | 已有 unit test | P2（扩展） |
| `routes/event-logging/route.ts` | 静默消费，逻辑极简 | P2 |
| `routes/usage/route.ts` | 使用量查询转发 | P2 |
| `routes/history/assets.ts` | 静态文件服务 | P2 |
| `routes/embeddings/route.ts` | Embeddings 转发 | P2 |

## Contract 测试扩充

| Contract | 现状 | 计划 |
|----------|------|------|
| `error-format.test.ts` | 有 | 扩展更多 HTTP 状态码 |
| `openai-types.test.ts` | 有 | — |
| `embeddings-types.test.ts` | 有 | — |
| **anthropic-response.test.ts** | 无 | 新增：验证非流式响应结构 |
| **sse-events.test.ts** | 无 | 新增：各 API 的 SSE 事件格式 |
| **responses-format.test.ts** | 无 | 新增：Responses API 格式 |

## 现有测试改进

### 弱断言替换

在覆盖率提升过程中，顺便修复现有测试的弱断言：

| 模式 | 数量 | 替换为 |
|------|------|--------|
| `expect(x).toBeDefined()` | 99 | `expect(x).toMatch(/.../)`、`expect(typeof x).toBe(...)` 等 |
| `try/catch + toBeDefined` | ~5 | `expect(...).rejects.toThrow(...)` |
| `if (typeof x !== "string")` 守卫 | ~20 | 先断言类型 `expect(typeof x).not.toBe("string")` |

### 全局 state 迁移

在修改现有测试文件时，同步将手动 save/restore 替换为 `withTestState()` 或 `useTestState()`。

## 里程碑

### M1：HTTP 测试框架 + 基础路由（阶段 1 完成后立即）

**交付**：
- `tests/http/basic-routes.test.ts`（health、models、404 等）
- `tests/http/messages.test.ts`（至少 model 校验 + 错误处理）

**目标覆盖率**：从基线提升 5%

### M2：三大 Handler 完整覆盖

**交付**：
- `tests/http/messages.test.ts` 完整
- `tests/http/chat-completions.test.ts` 完整
- `tests/http/responses.test.ts` 完整

**目标覆盖率**：提升至 65%

### M3：P1 模块补齐

**交付**：
- Token 管理测试
- API Client 测试
- Message Tools 测试
- Memory Pressure 测试

**目标覆盖率**：提升至 75%

### M4：全面达标

**交付**：
- P2 模块测试
- Contract 测试扩充
- 弱断言全部替换
- State 隔离全部迁移

**目标覆盖率**：≥ 80% 行 / ≥ 70% 分支

## 执行原则

1. **新代码 TDD 优先**：从现在起，新特性和 bug 修复必须先写测试
2. **补测试不改实现**：补覆盖率阶段只加测试，不重构被测代码（除非为了可测性必须）
3. **每个 PR 只补一个模块**：避免大规模测试 PR 难以 review
4. **先写测试描述**：在动手写断言前，先列出所有 `test("should ...")` 描述，review 完整性
5. **渐进式门禁**：覆盖率门禁从 50% → 60% → 70% → 80% 逐步收紧
