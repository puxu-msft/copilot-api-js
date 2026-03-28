# 05 — 全局状态治理（P1）

## 已确认事实

`state.ts` 导出一个可变单例对象（25+ 字段），被以下 12 个文件直接赋值：

```
src/start.ts
src/auth.ts
src/check-usage.ts
src/debug.ts
src/setup-claude-code.ts
src/lib/config/config.ts
src/lib/copilot-api.ts
src/lib/models/client.ts
src/lib/state.ts
src/lib/token/index.ts
src/lib/token/copilot-token-manager.ts
src/lib/token/providers/base.ts
```

仅 `setServerStartTime` 和 `rebuildModelIndex` 有专用 setter。其余字段全部 `state.xxx = value` 直接写。

注意：`serverStartTime` 不是 `State` 接口的字段，而是 `state.ts` 中的独立导出变量。

## 字段分类

| 类别 | 字段 | 主要写入者 |
|------|------|-----------|
| **认证** | `githubToken`, `copilotToken`, `tokenInfo`, `copilotTokenInfo`, `accountType` | token 模块, auth.ts |
| **模型** | `models`, `modelIndex`, `modelIds`, `modelOverrides` | models/client.ts, start.ts |
| **行为开关** | `autoTruncate`, `compressToolResults…`, `stripServerTools`, `dedupToolCalls`, `stripReadToolResult…`, `contextEditingMode`, `normalizeResponsesCallIds`, `systemPromptOverrides`, `rewriteSystemReminders` | config.ts, start.ts |
| **超时** | `fetchTimeout`, `streamIdleTimeout`, `staleRequestMaxAge` | config.ts |
| **关闭** | `shutdownGracefulWait`, `shutdownAbortWait` | config.ts |
| **History** | `historyLimit`, `historyMinEntries` | config.ts |
| **杂项** | `verbose`, `showGitHubToken`, `vsCodeVersion`, `adaptiveRateLimitConfig` | start.ts, copilot-api.ts |
| **独立变量** | `serverStartTime`（非 State 字段） | start.ts（通过 setter） |

## 配置优先级

当前隐式优先级（未文档化）：

```
CLI 参数（start.ts）→ config.yaml 热重载（config.ts）→ state.ts 默认值
```

## 短期方案：setter + readonly

1. `State` 接口所有字段标记 `readonly`
2. 按领域导出分组 setter：

| setter | 管辖字段 |
|--------|---------|
| `setAuth(...)` | githubToken, copilotToken, tokenInfo, copilotTokenInfo, accountType |
| `cacheModels(...)` | models, modelIndex, modelIds（已有 `rebuildModelIndex`，可扩展） |
| `setBehavior(...)` | autoTruncate, compressToolResults…, stripServerTools, dedupToolCalls, contextEditingMode, … |
| `setTimeouts(...)` | fetchTimeout, streamIdleTimeout, staleRequestMaxAge |
| `setShutdownConfig(...)` | shutdownGracefulWait, shutdownAbortWait |
| `setHistoryConfig(...)` | historyLimit, historyMinEntries |
| `setMisc(...)` | verbose, showGitHubToken, vsCodeVersion, adaptiveRateLimitConfig |

3. 所有 12 个写入者改为调用 setter

4. 在 `state.ts` 顶部文档化配置优先级

## 迁移范围

**不仅是 `state.ts` 本身**——12 个写入者文件都需要修改。特别注意：
- CLI 命令层（`auth.ts`, `check-usage.ts`, `debug.ts`, `setup-claude-code.ts`）
- token 子模块（`token/index.ts`, `token/copilot-token-manager.ts`, `token/providers/base.ts`）
- config 热重载回调（`config/config.ts`）

## 验证

- [ ] `State` 接口所有字段为 `readonly`
- [ ] 12 个文件中的所有 `state.xxx = value` 改为 setter 调用
- [ ] `typecheck` + `test` 通过
