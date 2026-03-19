# 测试覆盖审计报告

> 生成日期：2026-03-02
> 范围：`src/lib/`、`src/routes/`、`tests/`

## 一、汇总统计

| 类别 | 数量 |
|------|------|
| 源文件（`src/lib/`） | 64 |
| 源文件（`src/routes/`） | 15 |
| 测试文件总数 | 54 |
| 单元测试（`tests/unit/`） | 23 |
| 组件测试（`tests/component/`） | 20 |
| 集成测试（`tests/integration/`） | 4 |
| E2E 测试（`tests/e2e/`） | 4 |
| 契约测试（`tests/contract/`） | 3 |
| **约计测试用例** | **~948** |

## 二、测试基础设施

### helpers/

| 文件 | 用途 |
|------|------|
| `factories.ts` | `mockModel()` 等共享工厂函数 |
| `fake-stream.ts` | 可控异步流生成器，支持 abort |
| `fixtures.ts` | `loadFixturePair()`、`loadFollowupPair()` — 加载 JSON fixture |
| `mock-adapter.ts` | `FormatAdapter` mock（pipeline 测试） |
| `mock-server.ts` | Server mock（shutdown 测试） |
| `mock-strategy.ts` | `RetryStrategy` mock |
| `mock-tracker.ts` | Request tracker mock |

### fixtures/（真实 API 数据）

| 格式 | 场景 |
|------|------|
| `anthropic-messages/` | simple, tool-use（含 followup） |
| `openai-chat-completions/` | simple, tool-call（含 followup） |
| `openai-responses/` | simple, function-call（含 followup） |

### 运行命令

```
bun test tests/unit/                  # 默认 test
bun test tests/                       # test:all
bun test tests/unit/ tests/component/ tests/contract/ tests/integration/   # test:ci（不含 e2e）
bun test tests/e2e/                   # 需要真实 GitHub token
```

## 三、覆盖矩阵

### 充分覆盖的模块

| 源模块 | 测试文件 | 级别 | 用例数 |
|--------|----------|------|--------|
| `lib/error.ts` | `unit/error.test.ts` + `error-persistence.test.ts` + `contract/error-format.test.ts` | 单元+契约 | 57 |
| `lib/utils.ts` | `unit/utils.test.ts` | 单元 | 22 |
| `lib/adaptive-rate-limiter.ts` | `component/rate-limiter.test.ts` + `unit/rate-limiter-shutdown.test.ts` | 组件+单元 | 28 |
| `lib/shutdown.ts` | `component/shutdown.test.ts` + `integration/shutdown-abort-flow.test.ts` | 组件+集成 | 35 |
| `lib/sanitize-system-reminder.ts` | `unit/system-reminder.test.ts` | 单元 | 27 |
| `lib/system-prompt.ts` | `unit/system-prompt-manager.test.ts` | 单元 | 39 |
| `lib/config/config.ts` | `unit/rewrite-rule.test.ts` + `component/config-hot-reload.test.ts` | 单元+组件 | 28 |
| `lib/history/store.ts` | `component/history-store.test.ts` + `history-summary.test.ts` + `history-api.test.ts` | 组件 | 90 |
| `lib/history/ws.ts` | `unit/history-ws.test.ts` + `component/history-ws-integration.test.ts` | 单元+组件 | 33 |
| `lib/models/resolver.ts` | `component/model-resolver.test.ts` + `e2e/model-resolution.test.ts` | 组件+E2E | 55 |
| `lib/models/endpoint.ts` | `component/supported-endpoints.test.ts` + `e2e/model-endpoint-completeness.test.ts` | 组件+E2E | 15 |
| `lib/anthropic/sanitize.ts` | `unit/message-sanitizer.test.ts` + `dedup-tool-calls.test.ts` + `strip-read-tool-result-tags.test.ts` + `server-tool-rewriting.test.ts` | 单元 | 100 |
| `lib/anthropic/stream-accumulator.ts` | `component/stream-accumulator.test.ts` + `integration/stream-shutdown-race.test.ts` | 组件+集成 | 46 |
| `lib/anthropic/features.ts` (modelSupports*) | `unit/anthropic-features.test.ts` | 单元 | 26 |
| `lib/anthropic/message-mapping.ts` | `unit/message-mapping.test.ts` | 单元 | 11 |
| `lib/auto-truncate/index.ts` | `unit/auto-truncate-common.test.ts` + `component/auto-truncate.test.ts` | 单元+组件 | 61 |
| `lib/openai/sanitize.ts` | `unit/sanitize-openai.test.ts` + `integration/sanitize-then-translate.test.ts` | 单元+集成 | 11 |
| `lib/openai/orphan-filter.ts` | `unit/orphan-filter-openai.test.ts` | 单元 | 18 |
| `lib/request/pipeline.ts` | `component/pipeline.test.ts` + `integration/pipeline-with-strategy.test.ts` | 组件+集成 | 19 |
| `lib/context/manager.ts` | `component/context-manager.test.ts` | 组件 | 11 |
| `lib/context/request.ts` | `component/request-context.test.ts` | 组件 | 23 |
| `lib/tui/format.ts` | `unit/tui-format.test.ts` | 单元 | 26 |
| `routes/history/api.ts` | `component/history-api.test.ts` | 组件 | 23 |
| `routes/responses/handler.ts` (转换函数) | `unit/responses-conversion.test.ts` | 单元 | 17 |

### 部分覆盖的模块

| 源模块 | 已覆盖 | 未覆盖 |
|--------|--------|--------|
| `lib/anthropic/handlers.ts` | `supportsDirectAnthropicApi`、`processAnthropicStream` | 主 handler 函数、stream/non-stream 处理 |
| `lib/anthropic/features.ts` | `modelSupports*` 函数 | `buildAnthropicBetaHeaders`、`buildContextManagement`、`ensureOfficialTools`、`applyToolSearch` |
| `lib/anthropic/client.ts` | E2E 覆盖 | 无 mock 单元/组件测试 |
| `lib/request/recording.ts` | `buildResponsesResponseData` (10 cases) | `buildAnthropicResponseData`、`buildOpenAIResponseData` |
| `lib/openai/responses-stream-accumulator.ts` | 间接通过 recording test | `accumulateResponsesStreamEvent` 无直接流事件测试 |
| `lib/models/client.ts` | E2E 覆盖 | `cacheModels()` 无 mock 测试 |
| `lib/token/copilot-token-manager.ts` | shutdown mock | 并发安全机制无测试 |

### 完全无测试的模块

#### P0 — 高风险

| 源模块 | 功能 | 风险说明 |
|--------|------|---------|
| `lib/request/strategies/token-refresh.ts` | 401/403 → token 刷新重试 | ✅ 已覆盖 (`unit/token-refresh-strategy.test.ts`, 9 cases) |
| `lib/request/strategies/deferred-tool-retry.ts` | tool 错误解析 + 重试 | ✅ 已覆盖 (`unit/deferred-tool-retry-strategy.test.ts`, 14 cases) |
| `lib/context/consumers.ts` | context 事件 → history/tui 胶水层 | ✅ 已覆盖 (`component/context-consumers.test.ts`, 13 cases) |
| `lib/token/providers/device-auth.ts` | OAuth 设备流认证 | 无需测试：标准 OAuth 设备授权流（RFC 8628），依赖外部 GitHub API 和用户交互，无可有意义的 mock 测试点 |

#### P1 — 中等风险

| 源模块 | 功能 |
|--------|------|
| `lib/openai/stream-accumulator.ts` | ✅ 已覆盖 (`unit/openai-stream-accumulator.test.ts`, 14 cases) |
| `lib/request/recording.ts` | ✅ 已覆盖 (`unit/recording.test.ts`, 19 cases — buildAnthropicResponseData + buildOpenAIResponseData) |
| `lib/openai/client.ts` | `createChatCompletions()` 主函数 |
| `lib/openai/responses-client.ts` | `createResponses()` 主函数 |
| `lib/proxy.ts` | HTTP 代理配置 |
| `lib/copilot-api.ts` | Copilot API 常量/头部构造 |
| `lib/token/github-token-manager.ts` | GitHub token 管理 |
| `lib/token/github-client.ts` | GitHub API 客户端 |
| `lib/token/copilot-client.ts` | Copilot token/usage API |

#### P2 — 低风险

| 源模块 | 功能 |
|--------|------|
| `lib/tui/console-renderer.ts` | 终端渲染（纯 UI） |
| `lib/request/payload.ts` | payload 大小日志（辅助函数） |
| `lib/config/paths.ts` | `ensurePaths()` |
| `lib/token/providers/cli.ts` | CLI token 提供者 |
| `lib/token/providers/env.ts` | 环境变量 token |
| `lib/token/providers/file.ts` | 文件 token |

### 路由层缺口

| 路由 | 测试情况 |
|------|---------|
| `routes/chat-completions/handler.ts` 主函数 | 仅 2 个 header 测试 + E2E 间接 |
| `routes/responses/handler.ts` 主函数 | 无直接测试 |
| `routes/messages/route.ts` | 无测试 |
| `routes/token/route.ts` | 无测试 |
| `routes/usage/route.ts` | 无测试 |
| `routes/event-logging/route.ts` | 无测试 |
| `routes/history/route.ts` | 无测试（WebSocket 升级） |

## 四、测试质量观察

### 优点

1. **message-sanitizer.test.ts**（69 cases）— 项目最完善的测试，覆盖复杂的 tool_use/tool_result 配对和所有 server tool 类型
2. **model-resolver.test.ts**（46 cases）— override 链、循环检测、modifier 后缀、bracket 符号全覆盖
3. **shutdown.test.ts**（28 cases）— 4 阶段关闭流程精确覆盖，mock deps 隔离副作用
4. **history-summary.test.ts**（39 cases）— summary 缓存一致性、searchText、过滤器全覆盖
5. **stream-shutdown-race.test.ts**（22 cases）— `raceIteratorNext` + abort signal 边界条件深入测试
6. **direct-channels.test.ts** — 使用真实 API fixture 做三种格式的结构验证

### 不足

1. 两个文件使用 `it()` 而非 `test()`（`dedup-tool-calls.test.ts`、`strip-read-tool-result-tags.test.ts`）
2. `chat-completions-service.test.ts` 仅 2 个 case，测 header 而非核心业务
3. token/auth 模块测试仅存在于 E2E 级别，CI 无法运行
4. OpenAI 系 stream-accumulator 与 Anthropic 系对比差距大（0 vs 24 tests）

## 五、推荐操作清单

按优先级排序：

| # | 操作 | 优先级 | 状态 |
|---|------|--------|------|
| 1 | ~~新增 `unit/token-refresh-strategy.test.ts`~~ | P0 | ✅ 完成 (9 cases) |
| 2 | ~~新增 `unit/deferred-tool-retry.test.ts`~~ | P0 | ✅ 完成 (14 cases) |
| 3 | ~~新增 `component/context-consumers.test.ts`~~ | P0 | ✅ 完成 (13 cases) |
| 4 | ~~新增 `unit/recording.test.ts`~~ | P1 | ✅ 完成 (19 cases) |
| 5 | 扩展 `unit/anthropic-features.test.ts` 覆盖高级函数 | P1 | 待定 |
| 6 | ~~新增 `unit/openai-stream-accumulator.test.ts`~~ | P1 | ✅ 完成 (14 cases) |
| 7 | 新增 `component/copilot-token-manager.test.ts` | P1 | 待定 |
| 8 | 新增 `component/anthropic-handler.test.ts` | P2 | 待定 |
| 9 | 新增 `component/route-handlers.test.ts`（Hono test client） | P2 | 待定 |
| 10 | 新增 `unit/responses-stream-accumulator.test.ts` | P2 | 待定 |

## 六、覆盖率热力图

```
src/lib/
├── error.ts                    ████████████ 充分 (57 tests)
├── utils.ts                    ████████████ 充分 (22 tests)
├── state.ts                    ████░░░░░░░░ 间接
├── shutdown.ts                 ████████████ 充分 (35 tests)
├── adaptive-rate-limiter.ts    ████████████ 充分 (28 tests)
├── sanitize-system-reminder.ts ████████████ 充分 (27 tests)
├── system-prompt.ts            ████████████ 充分 (39 tests)
├── proxy.ts                    ░░░░░░░░░░░░ 无测试
├── copilot-api.ts              ░░░░░░░░░░░░ 无测试
├── anthropic/
│   ├── handlers.ts             ████░░░░░░░░ 部分 (P0 缺口)
│   ├── client.ts               ████░░░░░░░░ 仅 E2E
│   ├── sanitize.ts             ████████████ 充分 (100 tests)
│   ├── stream-accumulator.ts   ████████████ 充分 (46 tests)
│   ├── auto-truncate.ts        ████████░░░░ 较充分
│   ├── features.ts             ████████░░░░ 部分 (高级函数缺)
│   └── message-mapping.ts      ████████████ 充分 (11 tests)
├── auto-truncate/
│   └── index.ts                ████████████ 充分 (61 tests)
├── config/
│   ├── config.ts               ████████████ 充分 (28 tests)
│   └── paths.ts                ░░░░░░░░░░░░ 无测试
├── context/
│   ├── manager.ts              ████████████ 充分 (11 tests)
│   ├── request.ts              ████████████ 充分 (23 tests)
│   └── consumers.ts            ████████████ 充分 (13 tests)
├── history/
│   ├── store.ts                ████████████ 充分 (90 tests)
│   └── ws.ts                   ████████████ 充分 (33 tests)
├── models/
│   ├── resolver.ts             ████████████ 充分 (55 tests)
│   ├── endpoint.ts             ████████████ 充分 (15 tests)
│   └── client.ts               ████░░░░░░░░ 仅 E2E
├── openai/
│   ├── client.ts               ████░░░░░░░░ 仅 E2E
│   ├── sanitize.ts             ████████░░░░ 较充分 (11 tests)
│   ├── orphan-filter.ts        ████████████ 充分 (18 tests)
│   ├── auto-truncate.ts        ████████░░░░ 组件覆盖
│   ├── stream-accumulator.ts   ████████████ 充分 (14 tests)
│   ├── responses-client.ts     ░░░░░░░░░░░░ 无测试
│   └── responses-stream-acc.ts ████░░░░░░░░ 间接
├── request/
│   ├── pipeline.ts             ████████████ 充分 (19 tests)
│   ├── recording.ts            ████████░░░░ 部分 (Responses only)
│   ├── strategies/
│   │   ├── auto-truncate.ts    ████████████ 充分 (17 tests)
│   │   ├── token-refresh.ts    ████████████ 充分 (9 tests)
│   │   └── deferred-tool.ts    ████████████ 充分 (14 tests)
│   └── payload.ts              ░░░░░░░░░░░░ 无测试
├── token/
│   ├── copilot-token-manager.  ████░░░░░░░░ 间接
│   ├── providers/device-auth.  ░░░░░░░░░░░░ 无测试 (P0)
│   └── ...                     ░░░░░░░░░░░░ 无需测试（标准 OAuth 设备流）
└── tui/
    ├── format.ts               ████████████ 充分 (26 tests)
    ├── tracker.ts              ████████░░░░ 部分 (6 tests)
    ├── middleware.ts            ████████░░░░ 组件 (8 tests)
    └── console-renderer.ts     ░░░░░░░░░░░░ 无测试
```
