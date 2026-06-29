# 认证与 Token 管理

Copilot 上游需要两层 token：GitHub OAuth token（长期）换取 Copilot token（短期、自动刷新）。本层封装在 `src/lib/token/`。

## 多源 Token Provider

GitHub token 按优先级从多源获取（`src/lib/token/providers/`）：`cli`（GitHub CLI）、`device-auth`（设备码登录）、`env`（环境变量）、`file`（持久化文件）。各 provider 声明优先级与可刷新性，`github-token-manager.ts` 按序取首个可用源并校验。

## 生命周期

`lifecycle.ts` 是进程级单例管理器，统一 init/teardown/accessors，防重复实例。`copilot-token-manager.ts` 负责 Copilot token 的刷新（min interval / max retries），刷新失败由 `request/strategies/token-refresh.ts` 反应式重试捕获。账户类型与元数据见 `types.ts`。

## 入口

CLI 子命令 `login`（别名 `auth`）/ `logout` 走 `src/main.ts`，服务器启动期 `src/start.ts` 完成 token 初始化。

详见 DESIGN.md「核心模块 · src/lib/token/」与「入口点」。
