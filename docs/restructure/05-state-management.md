# 05 — 全局状态治理（P1）

## 现状

`src/lib/state.ts`（236 行）导出一个 `state` 单例对象，包含 25+ 可变字段。

### 字段分类

| 类别 | 字段 | 来源 |
|------|------|------|
| **认证** | `githubToken`、`copilotToken`、`tokenInfo`、`copilotTokenInfo`、`accountType` | token 模块设置 |
| **模型** | `models`、`modelIndex`、`modelIds`、`modelOverrides` | `start.ts` 缓存 + config |
| **行为开关** | `autoTruncate`、`compressToolResults…`、`stripServerTools`、`dedupToolCalls`、`stripReadToolResult…`、`contextEditingMode`、`normalizeResponsesCallIds` | config.yaml + CLI |
| **超时** | `fetchTimeout`、`streamIdleTimeout`、`staleRequestMaxAge` | config.yaml |
| **关闭** | `shutdownGracefulWait`、`shutdownAbortWait` | config.yaml |
| **History** | `historyLimit`、`historyMinEntries` | config.yaml |
| **杂项** | `verbose`、`showGitHubToken`、`vsCodeVersion`、`rewriteSystemReminders`、`adaptiveRateLimitConfig`、`serverStartTime` | 多处 |

### 问题

1. **无封装**：任何模块可直接 `state.xxx = value` 修改任何字段
2. **无追踪**：无法得知某字段何时被谁修改
3. **配置来源三处**：`state.ts` 默认值 → `config/config.ts` 热重载 → `start.ts` CLI 参数，优先级隐式
4. 仅 `setServerStartTime` 和 `rebuildModelIndex` 有专用 setter

## 短期方案：引入 setter + readonly

### 步骤

1. 将 `State` 接口的所有字段标记为 `readonly`
2. 导出分组 setter 函数，setter 内部通过类型断言绕过 readonly
3. 所有直接赋值改为调用 setter

```ts
// 示例
export interface State {
  readonly autoTruncate: boolean
  readonly fetchTimeout: number
  // ...
}

export function setBehavior(updates: Partial<Pick<State, "autoTruncate" | "fetchTimeout" | ...>>) {
  Object.assign(state, updates)
}
```

### 分组 setter 设计

| setter | 管辖字段 |
|--------|---------|
| `setAuth(...)` | githubToken, copilotToken, tokenInfo, copilotTokenInfo, accountType |
| `setModels(...)` | models, modelIndex, modelIds, modelOverrides |
| `setBehavior(...)` | autoTruncate, compressToolResults…, stripServerTools, dedupToolCalls, … |
| `setTimeouts(...)` | fetchTimeout, streamIdleTimeout, staleRequestMaxAge |
| `setShutdownConfig(...)` | shutdownGracefulWait, shutdownAbortWait |
| `setHistoryConfig(...)` | historyLimit, historyMinEntries |

### 配置优先级文档化

在 `state.ts` 顶部注释中明确：

```
配置优先级（高 → 低）：
1. CLI 参数（--auto-truncate, --no-auto-truncate）
2. config.yaml（热重载）
3. state.ts 默认值
```

## 中期方案：按领域拆分

如果 `state.ts` 随功能增长超过 400 行，可拆分为：

```
src/lib/state/
├── index.ts          # barrel + 兼容性 re-export
├── auth.ts           # 认证相关状态
├── models.ts         # 模型缓存状态
├── behavior.ts       # 行为开关
└── timeouts.ts       # 超时和关闭配置
```

当前 236 行不急，短期 setter 方案足够。

## 验证

- [ ] `State` 接口所有字段为 `readonly`
- [ ] 所有 `state.xxx = value` 改为 setter 调用
- [ ] `typecheck` 通过
- [ ] `test` 通过
