# 05 — 全局状态治理（P1）— 已完成

## 完成状态

| 项目 | 状态 | 结果 |
|------|------|------|
| `State` 接口改为只读视图 | ✓ 已完成 | 应用代码通过 `state: State` 读取，全字段 `readonly` |
| 生产代码直接写 `state.xxx = ...` 收口 | ✓ 已完成 | 生产代码改为通过 setter / 专用入口更新状态 |
| 状态写入按职责分组 | ✓ 已完成 | 认证、CLI、模型、Anthropic 行为、history、shutdown、timeout、responses 各有明确写入口 |
| 测试快照/恢复机制 | ✓ 已完成 | 提供 `snapshotStateForTests()` / `restoreStateForTests()` / `setStateForTests()` |

## 当前实现

`src/lib/state.ts` 现在区分了两层：

- `mutableState`：模块内部可变实现
- `state: State`：对外导出的只读视图

`State` 接口中的运行时字段已经全部标记为 `readonly`。生产代码不再直接执行 `state.xxx = value`，而是通过专用入口写入：

| 写入口 | 管辖范围 |
|--------|---------|
| `setGitHubToken()` | GitHub token |
| `setCopilotToken()` | Copilot token |
| `setTokenState()` | `tokenInfo` / `copilotTokenInfo` |
| `setCliState()` | `accountType` / `showGitHubToken` / `autoTruncate` / `verbose` |
| `setVSCodeVersion()` | `vsCodeVersion` |
| `setModels()` | `models`，并触发 `rebuildModelIndex()` |
| `setAnthropicBehavior()` | `stripServerTools` / `immutableThinkingMessages` / `dedupToolCalls` / `stripReadToolResultTags` / `contextEditingMode` / `rewriteSystemReminders` / `systemPromptOverrides` / `compressToolResultsBeforeTruncate` |
| `setModelOverrides()` | `modelOverrides` |
| `setHistoryConfig()` | `historyLimit` / `historyMinEntries` |
| `setShutdownConfig()` | `shutdownGracefulWait` / `shutdownAbortWait` |
| `setTimeoutConfig()` | `fetchTimeout` / `streamIdleTimeout` / `staleRequestMaxAge` |
| `setResponsesConfig()` | `normalizeResponsesCallIds` |
| `setServerStartTime()` | 独立导出变量 `serverStartTime` |

## 测试边界

测试仍然保留受控写入口，这属于刻意保留的能力，不是治理遗漏：

- `snapshotStateForTests()`
- `restoreStateForTests()`
- `setStateForTests()`

这样应用代码可以保持只读消费，而测试仍能快速构造 fixture、恢复现场和隔离副作用。

## 配置优先级

状态初始化与覆盖顺序仍然是：

```text
state.ts 默认值 → CLI / 启动期显式设置 → config.yaml 热重载更新
```

文档化和写入口已经分离完成，后续若要继续优化，重点应是“配置来源语义是否还要更细分”，而不是回到直接暴露可写单例。

## 验证

- [x] `State` 接口所有运行时字段为 `readonly`
- [x] 生产代码中不再存在 `state.xxx = value` 直接写入
- [x] 测试通过 `snapshotStateForTests()` / `restoreStateForTests()` / `setStateForTests()` 进行受控写入
