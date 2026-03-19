# Copilot 认证

## 概述

通过 GitHub Copilot 扩展获取 OAuth token，用于访问 Copilot API。认证 token 由 `CopilotTokenManager`（`src/lib/token/`）管理，支持自动续期和并发安全。

## 账户类型

| 账户类型 | Base URL |
|----------|----------|
| `individual` | `api.githubcopilot.com` |
| `business` | `api.business.githubcopilot.com` |
| `enterprise` | `api.enterprise.githubcopilot.com` |

## Token 管理

`CopilotTokenManager` 负责 Copilot API token 的生命周期：

- **自动续期**：token 过期前自动刷新
- **并发安全**：多个请求同时触发刷新时只执行一次
- **重试策略**：`TokenRefreshStrategy` 在收到 401/403 时触发 token 刷新后重试

## GitHub Token 获取

初始 GitHub OAuth token 通过以下方式获取：

1. CLI `--github-token` 参数直接提供
2. 从 VS Code / JetBrains / Vim 等编辑器的 Copilot 扩展配置中读取
3. `auth` 子命令进行 device flow 认证

相关代码：`src/lib/token/`
