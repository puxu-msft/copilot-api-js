# 阶段 3：覆盖率提升计划

> 目标：系统性补齐现有代码的测试覆盖，最终达到行覆盖率 80%、分支覆盖率 70%。

## 当前基线

> 以下数据采集于 2026-03-28（大型重构后）。阶段 1 实施前应运行 `bun run test:cov` 刷新实际覆盖率。

| 指标 | 值 |
|------|---|
| `src/lib/` 源文件总数 | 107 |
| `src/routes/` 路由文件总数 | 21 |
| 测试文件总数 | 71 |
| 未测试的源文件（不含 index/types） | ~46 |
| 核心 handler 直接覆盖 | 0/3（messages、chat-completions、responses handler 无 HTTP 测试）。history handler 已有 route-mounted `app.request()` 覆盖（`history-api.test.ts`），但尚未纳入统一 `tests/http/` 框架 |
| 行/分支覆盖率 | **未配置**（阶段 1 目标：建立基线） |

**重构影响**：大型重构将多个大文件拆分为子模块（`error.ts` → 5 文件、`sanitize.ts` → 4 文件、`store.ts` → 6 文件等）。源文件数量从 ~80 增至 107，但单文件职责更清晰，可测性更高。

## 优先级定义

| 级别 | 定义 | 标准 |
|------|------|------|
| **P0** | 核心请求路径 | 用户每次请求都经过的代码 |
| **P1** | 关键业务逻辑 | 影响请求成功率、数据正确性的模块 |
| **P2** | 辅助模块 | UI 日志、配置路径、token 提供者等 |

## P0：核心请求路径

### Handler 层

核心 handler 是所有模块的胶水层，目前缺少直接覆盖。

| 文件 | 行数 | 测试策略 | 测试层 |
|------|------|---------|--------|
| `routes/messages/handler.ts` | 476 | mock `createAnthropicMessages`，验证 model 校验、sanitize 调用、流式/非流式分发、错误处理 | HTTP |
| `routes/chat-completions/handler.ts` | 371 | mock `createChatCompletions`，验证 OpenAI 格式处理 | HTTP |
| `routes/responses/handler.ts` | 237 | mock responses client，验证 call ID 标准化、model 校验 | HTTP |
| `routes/responses/ws.ts` | 300 | WebSocket 传输层：消息收发、连接生命周期、错误帧 | **WS**（不在 HTTP 测试中） |
| `routes/responses/pipeline.ts` | 77 | 适配器和策略组装正确性 | Component |
| `routes/history/handler.ts` | 141 | History REST API CRUD 操作 | HTTP |

> 注意：WebSocket 路由通过 `registerWsRoutes(app, wsUpgrade)` 注册（与 HTTP 路由 `registerHttpRoutes` 分离），`app.request()` 无法覆盖。协议逻辑已有 `tests/unit/responses-websocket.test.ts` 覆盖，传输层测试归入 `tests/ws/`。

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
| `routes/index.ts` (`registerHttpRoutes`) | HTTP 路由注册完整性 | HTTP |
| `routes/index.ts` (`registerWsRoutes`) | WS 路由装配与传输路径 | WS (Integration) |
| `routes/models/route.ts` | `GET /models` 返回模型列表 | HTTP |
| `routes/token/route.ts` | `GET /api/tokens` 返回 token 信息 | HTTP |
| `server.ts` | 404 处理、favicon 204、全局错误处理 | HTTP |

**打包为一个测试文件**（使用 `createFullTestApp()`，因为根路由、health、404 定义在 `server.ts` 而非 `registerHttpRoutes()`）：

```
tests/http/basic-routes.test.ts:
├── GET / → 200 "Server running"
├── GET /health → 200/503（根据 token 状态）
├── GET /models → 200 + 模型列表结构
├── GET /favicon.ico → 204（静默）
├── GET /nonexistent → 404
└── 全局错误 handler → Anthropic 错误格式
```

## P1：关键业务逻辑

### 错误处理模块（重构后拆分）

| 文件 | 行数 | 当前覆盖 | 需补充 |
|------|------|---------|--------|
| `lib/error/classify.ts` | 237 | 部分（原 `error.test.ts` 覆盖了合并前的逻辑） | 需审查拆分后是否完整 |
| `lib/error/forward.ts` | 204 | 部分（`error-format.test.ts` 覆盖部分） | 各状态码的 log 行为 |
| `lib/error/http-error.ts` | — | 部分 | — |
| `lib/error/parsing.ts` | — | 部分 | — |

### 自适应限流器

| 文件 | 行数 | 当前覆盖 | 需补充 |
|------|------|---------|--------|
| `lib/adaptive-rate-limiter.ts` | 558 | 有 component test | 需审查 3 模式完整转换 |

### Anthropic Sanitize 子模块（重构后拆分）

| 文件 | 行数 | 当前覆盖 | 需补充 |
|------|------|---------|--------|
| `lib/anthropic/sanitize/tool-blocks.ts` | 184 | 间接（`message-sanitizer.test.ts` 测试公共入口） | 需直接 unit test |
| `lib/anthropic/sanitize/content-blocks.ts` | — | 间接 | — |
| `lib/anthropic/sanitize/deduplicate-tool-calls.ts` | 151 | 有 `dedup-tool-calls.test.ts` | — |
| `lib/anthropic/sanitize/system-reminders.ts` | 103 | 间接 | — |

### Auto-Truncate 引擎与工具

| 文件 | 行数 | 当前覆盖 | 需补充 |
|------|------|---------|--------|
| `lib/auto-truncate/engine.ts` | 426 | 有 61 个测试（拆分前） | 审查 token 限制学习、预检查 |
| `lib/anthropic/auto-truncate/token-counting.ts` | 151 | 无 | 新增 |
| `lib/anthropic/auto-truncate/tool-utils.ts` | 165 | 无 | 新增 |
| `lib/openai/auto-truncate/token-counting.ts` | — | 无 | 新增 |

### Token 管理

| 文件 | 行数 | 测试策略 |
|------|------|---------|
| `lib/token/copilot-token-manager.ts` | 245 | mock `getCopilotToken`，测试刷新逻辑、过期检测、并发安全 |
| `lib/token/github-token-manager.ts` | 179 | mock 文件系统和 CLI，测试 token 获取、缓存、多 provider |
| `lib/token/github-client.ts` | 116 | mock HTTP，测试 API 调用格式 |

### API Client 层

| 文件 | 行数 | 测试策略 |
|------|------|---------|
| `lib/anthropic/client.ts` | 231 | mock `fetch`，测试请求构造、流式/非流式处理、错误映射 |
| `lib/openai/client.ts` | — | mock `fetch`，测试 OpenAI 请求构造 |
| `lib/openai/responses-client.ts` | 106 | mock `fetch`，测试 Responses 请求构造 |

### 其他 P1 模块

| 文件 | 行数 | 测试策略 |
|------|------|---------|
| `lib/anthropic/message-tools.ts` | 326 | 纯逻辑，unit test |
| `lib/anthropic/server-tool-filter.ts` | 160 | 纯逻辑，unit test |
| `lib/anthropic/sse.ts` | 124 | mock fetch stream |
| `lib/system-prompt/override.ts` | 154 | 纯逻辑，unit test |
| `lib/history/memory-pressure.ts` | 202 | mock 堆统计，测试 LRU 淘汰 |
| `lib/history/entries.ts` | 207 | CRUD 操作 |
| `lib/history/queries.ts` | 104 | 查询逻辑 |
| `lib/history/sessions.ts` | 102 | 会话管理 |
| `lib/history/stats.ts` | 138 | 统计计算 |
| `lib/models/tokenizer.ts` | 352 | 纯逻辑 |
| `lib/ws/broadcast.ts` | 350 | WebSocket 广播 |

## P2：辅助模块

| 文件 | 测试策略 |
|------|---------|
| `lib/tui/console-renderer.ts` (414) | 纯 UI 输出，低优先级 |
| `lib/request/payload.ts` (104) | 辅助日志函数 |
| `lib/config/paths.ts` | `ensurePaths()` 目录创建 |
| `lib/token/providers/*.ts` | CLI/env/file token 提供者 |
| `lib/copilot-api.ts` | 常量和 header 构造（已有 unit test） |
| `lib/state.ts` (403) | readonly state + setter（核心 API 已通过其他测试间接覆盖） |
| `lib/ws/adapter.ts` | WebSocket adapter 创建 |
| `routes/event-logging/route.ts` | 静默消费，逻辑极简 |
| `routes/embeddings/route.ts` | Embeddings 转发 |
| `routes/history/assets.ts` | 静态文件服务 |
| `routes/config/route.ts` | 配置查看 API |
| `routes/logs/route.ts` | 日志查看 API |
| `routes/status/route.ts` | 状态查看 API |
| `routes/ui/route.ts` | Web UI 入口路由（已有 `history-ui-route.test.ts`） |

## Contract 测试扩充

| Contract | 现状 | 计划 |
|----------|------|------|
| `error-format.test.ts` | 有 | 扩展更多 HTTP 状态码 |
| `openai-types.test.ts` | 有 | — |
| `embeddings-types.test.ts` | 有 | — |
| `history-types.test.ts` | 有（新增） | — |
| **anthropic-response.test.ts** | 无 | 新增：验证非流式响应结构 |
| **sse-events.test.ts** | 无 | 新增：各 API 的 SSE 事件格式 |
| **responses-format.test.ts** | 无 | 新增：Responses API 格式 |

## 现有测试改进

### 全局 state 迁移 ✅ 已完成

所有 18 个涉及 state 的测试文件已迁移到 `setStateForTests()` / `snapshotStateForTests()` / `restoreStateForTests()` API。直接赋值 `state.xxx = ...` 为 0 处。

### 弱断言替换

在覆盖率提升过程中，顺便修复现有测试的弱断言：

| 模式 | 替换为 |
|------|--------|
| `expect(x).toBeDefined()` | `expect(x).toMatch(/.../)`、`expect(typeof x).toBe(...)` 等 |
| `try/catch + toBeDefined` | `expect(...).rejects.toThrow(...)` |
| `if (typeof x !== "string")` 守卫 | 先断言类型 `expect(typeof x).not.toBe("string")` |

## 里程碑

### M0：建立覆盖率基线（阶段 1 完成时）

**交付**：
- `bun run test:cov` 可运行并输出 text 报告
- 记录当前 line/branch 覆盖率数字作为基准

### M1：HTTP 测试框架 + 基础路由

**交付**：
- `tests/http/basic-routes.test.ts`（`/`、`/health`、`404`、`favicon`、全局错误）
- `tests/http/messages.test.ts`（至少 model 校验 + 错误处理）
- `tests/helpers/test-bootstrap.ts` 可用

**目标覆盖率**：从 M0 基线提升 5%

### M2：三大 Handler + WS 覆盖

**交付**：
- `tests/http/messages.test.ts` 完整
- `tests/http/chat-completions.test.ts` 完整
- `tests/http/responses.test.ts` 完整
- `tests/ws/responses-ws.test.ts`（WebSocket 传输层基础覆盖）

**目标覆盖率**：提升至 65%

### M3：P1 模块补齐

**交付**：
- Token 管理测试
- API Client 测试
- Sanitize 子模块直接测试
- Auto-truncate 引擎与工具测试
- History 子模块测试
- Memory Pressure 测试

**目标覆盖率**：提升至 75%

### M4：全面达标

**交付**：
- P2 模块测试
- Contract 测试扩充
- 弱断言全部替换

**目标覆盖率**：≥ 80% 行 / ≥ 70% 分支

## 执行原则

1. **新代码 TDD 优先**：从现在起，新特性和 bug 修复必须先写测试
2. **补测试不改实现**：补覆盖率阶段只加测试，不重构被测代码（除非为了可测性必须）
3. **每个 PR 只补一个模块**：避免大规模测试 PR 难以 review
4. **先写测试描述**：在动手写断言前，先列出所有 `test("should ...")` 描述，review 完整性
5. **渐进式门禁**：覆盖率门禁从 50% → 60% → 70% → 80% 逐步收紧
