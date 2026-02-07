# AGENTS.md

## 规则

重要：使用中文对话回答和展示思考过程。
重要：使用中文对话回答和展示思考过程。
重要：使用中文对话回答和展示思考过程。

- **Always use the best, most complete solution.**
  Never take shortcuts or use workaround approaches. Always think deeply and choose the optimal implementation.
  - **Fix root causes, not symptoms.** Investigate why something doesn't work and fix the underlying mechanism, rather than adding workarounds or hardcoding fallback values.
  - **Prefer robust, maintainable solutions.** Even if a quick hack would work, choose the approach that is correct, complete, and future-proof.
  - **Lint serves readability, not the other way around.** If a lint rule doesn't improve readability, disable it rather than contorting the code to satisfy it.

- **始终使用最优、最完整的方案。**
  不走捷径，不用绕行方案。深入思考，选择最优实现。
  - **修复根本原因，而非表面症状。** 调查问题本质并修复底层机制，不要添加 workaround 或硬编码回退值。
  - **优选健壮、可维护的方案。** 即使 quick hack 能解决问题，也要选择正确、完整、经得起时间检验的方案。
  - **Lint 服务于可读性，而非反过来。** 如果某条 lint 规则无益于可读性，应禁用它，而非扭曲代码来满足它。

- **禁止启动服务器。**
  不要运行 `bun run dev`、`bun run start` 或任何会启动服务器的命令。如需验证服务器行为，请让用户来启动。可以运行 `bun run typecheck`、`bun run lint:all`、`bun test` 等非服务器命令。

- **禁止杀死运行中的项目进程。**
  不要使用 `kill`、`pkill`、`killall` 或类似命令终止本项目的运行实例。如需重启，请让用户手动操作。

- **禁止自动暂存或取消暂存 git 变更。**
  除非用户明确要求提交，否则不要运行 `git add`、`git reset`、`git restore --staged` 或任何修改 git 暂存区的命令。所有暂存决策交给用户。

## 项目概述

GitHub Copilot API 的逆向代理，将其暴露为 OpenAI 和 Anthropic 兼容端点。使得 Claude Code 等工具可以使用 GitHub Copilot 作为后端。

## 常用命令

```sh
bun install              # 安装依赖
bun run dev              # 开发模式（热重载）
bun run start            # 生产模式
bun run build            # 构建发布版（tsdown）
bun run typecheck        # 类型检查
bun run lint             # Lint 暂存文件
bun run lint:all         # Lint 所有文件
bun run knip             # 查找未使用的导出/依赖
bun test                 # 运行所有测试
bun test tests/foo.test.ts  # 运行单个测试文件
```

## API 端点

| 端点 | 用途 |
|------|------|
| `/v1/chat/completions` | OpenAI 兼容 chat |
| `/v1/messages` | Anthropic 兼容 messages |
| `/v1/messages/count_tokens` | Anthropic 兼容 token 计数 |
| `/v1/models` | 列出可用模型 |
| `/v1/embeddings` | 文本嵌入 |
| `/api/event_logging/batch` | Event logging（空操作） |
| `/usage` | Copilot 配额/用量统计 |
| `/health` | 健康检查 |
| `/token` | 当前 Copilot token 信息 |
| `/history` | 请求历史 Web UI（v1 和 v2） |
| `/history/ws` | WebSocket 实时历史更新 |
| `/history/api/entries` | 历史查询 API |
| `/history/api/sessions` | 会话列表 API |
| `/history/api/stats` | 统计 API |
| `/history/api/export` | 导出历史（JSON/CSV） |

## 代码风格

- 使用 `@echristian/eslint-config` + Prettier。运行 `eslint --fix` 自动格式化（不要直接使用 `prettier --write`）。
- 不使用分号。三元运算符放在行首。
- 严格 TypeScript（`strict: true`）。避免 `any`。
- ESNext 模块，不用 CommonJS。路径别名 `~/*` 映射到 `src/*`。
- 测试：使用 Bun 内置测试运行器。测试文件放在 `tests/` 目录，命名为 `*.test.ts`。
- 错误处理：使用显式错误类（参见 `src/lib/error.ts`）。避免静默失败。

## 关键配置

账户类型影响 Copilot API base URL：
- `individual` -> `api.githubcopilot.com`
- `business` -> `api.business.githubcopilot.com`
- `enterprise` -> `api.enterprise.githubcopilot.com`

`lib/state.ts` 中的关键运行时选项：

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `autoTruncate` | boolean | `true` | 响应式自动截断：限制错误时用截断的 payload 重试，对已知限制的模型进行预检查 |
| `compressToolResults` | boolean | `true` | 截断消息前先压缩旧的 tool_result 内容 |
| `redirectAnthropic` | boolean | `false` | 强制 Anthropic 请求走 OpenAI 转换 |
| `rewriteAnthropicTools` | boolean | `true` | 将服务端工具（web_search）重写为自定义格式 |

## 架构设计

@DESIGN.md
