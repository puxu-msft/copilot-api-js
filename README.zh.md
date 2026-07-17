# Copilot API Proxy \(Fork\)

> [!NOTE]
> 本项目是 [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api) 的 Fork，能用 :\)。

> [!WARNING]
> 这是 GitHub Copilot API 的反向代理，并非 GitHub 官方支持，随时可能失效。使用风险自负。

将你的 GitHub Copilot 订阅暴露为 OpenAI、Anthropic、AOAI（Azure OpenAI）以及 Google Gemini 兼容端点的反向代理，让 Claude Code、Codex、Gemini 及其他 AI Agent 工具都能通过同一个本地服务接入。

---

## 快速开始

### 从 npm 安装（推荐）

```sh
npx -y @hsupu/copilot-api start

# beta 版本
npx -y @hsupu/copilot-api@beta start
```

首次运行会自动触发 GitHub Device Flow 认证，并把 token 缓存到 `~/.local/share/copilot-api/`（可通过 `XDG_DATA_HOME` 覆盖）。

### 从源码运行

```sh
git clone https://github.com/puxu-msft/copilot-api-js.git
cd copilot-api-js
bun install
bun run dev --external-ui-url http://localhost:5173  # 后端热重载 + 把 /ui 反代到 Vite dev server
bun run dev:ui  # 在 Vite dev server 上启动前端开发模式

# 发布到 npm
BROWSER=wslview npm login
BROWSER=wslview npm publish --access public --tag beta
BROWSER=wslview npm dist-tag add @hsupu/copilot-api@0.8.3 latest
```

## 命令

| 命令 | 说明 |
|------|------|
| `start` | 启动 API 服务（如未登录会自动认证） |
| `login`（别名：`auth`） | 运行 GitHub Device Flow 认证，保存 GitHub token |
| `logout` | 清除已保存的 GitHub token |
| `debug usage` | 显示 Copilot 订阅用量和配额 |
| `debug info` | 输出诊断信息（路径、运行时、配置摘要） |
| `debug models` | 从 Copilot API 拉取并打印原始模型元数据 |
| `list-claude-code` | 列出本地安装的 Claude Code 版本 |
| `setup-claude-code` | 交互式配置 Claude Code 使用本代理 |

### `start` 选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `--port`, `-p` | `4141` | 监听端口 |
| `--host`, `-H` | `localhost` | `localhost`（v4+v6 loopback）、`any`（0.0.0.0+::）或指定地址 |
| `--account-type`, `-a` | 自动检测 | `individual` / `business` / `enterprise`（决定 API base URL）。省略时根据登录账户推断，回退为 `individual` |
| `--ghc-api-base-url` |  | 显式指定上游 GHC API base URL（如 `https://api.githubcopilot.com`）；设置后优先于 `--account-type` |
| `--github-token`, `-g` |  | 直接提供已签发的 GitHub token，跳过 auth 流程 |
| `--show-github-token` | `false` | 在日志中打印 GitHub token |
| `--proxy` |  | 覆盖出站代理 URL（http / https / socks5 / socks5h） |
| `--no-http-proxy-from-env` | 默认启用 | 忽略 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量 |
| `--no-rate-limit` | 默认启用 | 禁用自适应速率限制器 |

`--account-type` 决定上游 API base URL（除非被 `--ghc-api-base-url` 覆盖）：

| 类型 | API Base URL |
|------|--------------|
| `individual` | `api.githubcopilot.com` |
| `business` | `api.business.githubcopilot.com` |
| `enterprise` | `api.enterprise.githubcopilot.com` |

实验性选项：

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `--external-ui-url` |  | 把 `/ui` 反代到外部 Vite dev/build server |
| `--verbose`, `-v` | `false` | 详细日志（包含 Copilot token 刷新日志） |
| `--mock-rate-limiter-throttled` | `false` | 仅供测试：限速器超时后模拟上游 429 |

---

## 使用

### 配合 Claude Code 使用

运行交互式设置命令：

```sh
npx -y @hsupu/copilot-api setup-claude-code
```

或手动创建/修改 `~/.claude/settings.json`：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "haiku",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "sonnet",
    "ANTHROPIC_MODEL": "opus[1m]",
    "ANTHROPIC_SMALL_FAST_MODEL": "haiku",
    "CLAUDE_CODE_SUBAGENT_MODEL": "opus",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_ENABLE_TELEMETRY": "0",
    "DISABLE_TELEMETRY": "1"
  }
}
```

### 配合 Codex CLI / OpenAI SDK 使用

把 `OPENAI_BASE_URL`（或等效变量）指向本代理：

```sh
export OPENAI_BASE_URL=http://localhost:4141/v1
export OPENAI_API_KEY=dummy
codex  # 或任意 OpenAI SDK 客户端
```

或创建/修改 `~/.openai/config.toml`：

```toml
model_provider = "ghc"

[model_providers]

[model_providers.ghc]
name = "ghc"
base_url = "http://localhost:4141/v1"
wire_api = "responses"
preferred_auth_method = "apikey"
```

### 配合 Gemini CLI 使用

```bash
export GOOGLE_GEMINI_BASE_URL=http://localhost:4141/v1beta
export GEMINI_API_KEY=dummy  # 不会被校验，但 CLI 要求该变量存在
gemini -p "hello"
```

### 使用 API 端点

#### OpenAI 兼容

每条路由都同时注册在无前缀、`/v1` 和 `/openai/v1` 之下。

| 端点 | 方法 |
|------|------|
| `/chat/completions` | POST |
| `/responses` | POST（同时支持 WS GET） |
| `/embeddings` | POST |
| `/models` | GET |
| `/models/:model` | GET |

#### Azure OpenAI 兼容

| 端点 | 方法 |
|------|------|
| `/openai/deployments/:deployment/chat/completions` | POST |
| `/openai/deployments/:deployment/embeddings` | POST |
| `/openai/deployments/:deployment/responses` | POST |

#### Anthropic 兼容

| 端点 | 方法 |
|------|------|
| `/v1/messages`、`/anthropic/v1/messages` | POST |
| `/v1/messages/count_tokens`、`/anthropic/v1/messages/count_tokens` | POST |
| `/anthropic/v1/models` | GET |
| `/anthropic/v1/models/:id` | GET |

`/v1/messages` 仅接受 Anthropic 厂商的模型——它直连 Copilot 的原生 Anthropic 端点。

#### Google Gemini 兼容

| 端点 | 方法 |
|------|------|
| `/v1beta/models/:model:generateContent` | POST |
| `/v1beta/models/:model:streamGenerateContent` | POST（SSE） |
| `/v1beta/models/:model:countTokens` | POST |

---

## 配置

推荐默认值以**包根目录的 [`config.yaml`](config.yaml)** 形式随 npm 发布。你的个人覆盖文件位于 `~/.local/share/copilot-api/config.yaml`。运行时**生效配置 = bundled defaults 深合并 user overrides**（同一 key 下 user 优先）：

- 顶层嵌套段（`anthropic`、`history`、`shutdown`、`openai-responses`、`rate_limiter`）：按字段合并。
- 自由形式 map（`model_overrides`、`anthropic.efforts_overrides` 等）：按 key 合并。
- `model_preference`：按 family 替换（未提供的 family 保留 bundled 默认）。
- 数组与标量:user 提供时整体替换。

从 user 文件中删除某个 key，下次重载时会自然回退到 bundled 默认值。

完整带注释的参考见 [`config.example.yaml`](config.example.yaml)（包含被注释掉的可选字段）。GitHub token、已学习的协商状态、SQLite history 数据库与 user config 一同存放在数据目录下：

- 默认：`~/.local/share/copilot-api/`
- 若设置了 `XDG_DATA_HOME`：`$XDG_DATA_HOME/copilot-api/`

大多数字段在运行时支持热重载（配置文件被监视）。

要点：

- `model_overrides` — 重写请求中的模型名（如 `opus → claude-opus-4.7-1m-internal`）。
- `model_preference` — 用于 `opus` / `sonnet` / `haiku` 解析的每个 family 的优先级列表。
- `disabled_models` — 在 `/models`、UI 选择器和回退解析中屏蔽已弃用/遗留模型。
- `anthropic.*` — cache-control 模式、tool 去重、thinking-block 策略、剥离服务端工具、上下文编辑、`tool_search`、`efforts_overrides`、`strip_beta_headers`、`reject_body_fields`、warmup 策略、system-reminder 重写。
- `openai-responses.*` — `normalize_call_ids`、`upstream_ws`、`fix_stream_ids`、`client_ws_keep_open`、`strip_image_generation_tool`、`max_ws_frame_bytes`、`max_client_ws_connections`、`max_upstream_ws_connections`。
- `rate_limiter.*` — 重试间隔、请求间隔、恢复超时、连续成功阈值。**需要重启。**
- `system_prompt_prepend` / `system_prompt_append` / `system_prompt_overrides` — 完整的 system prompt 修改管道（line 或 regex 替换，可选 `model` 过滤）。
- `history.success_limit` / `history.failure_limit` / `history.reaper_interval` / `history.db_path` — SQLite History 保留策略。
- `history.archive.*` — HOT→TIER-1→TIER-2 三层降温归档；后台任务按 durable unit 协作停，重启后续跑。
- `shutdown.graceful_wait` / `shutdown.abort_wait` — 首次信号自动执行四步关闭流水线；第二次 Ctrl+C 立即强退。
- `stream_idle_timeout` / `fetch_timeout` / `model_refresh_interval` / `stale_request_max_age` — 网络相关旋钮。
- `proxy` — 出站代理 URL。**需要重启。**

热重载语义为 *retain-on-absence*：缺失的 key 保留上次的值；显式给出的空值（`disabled_models: []`、`model_overrides: {}`）才会清空字段。

### 数据目录结构

```
~/.local/share/copilot-api/         # 或 $XDG_DATA_HOME/copilot-api/
├── config.yaml                     # 用户配置（热重载）
├── github_token                    # GitHub Device Flow token
├── copilot-token.json              # 缓存的 Copilot bearer（含过期时间）
├── history.db                      # HOT SQLite History（payload 经 zstd 压缩）
├── archive.db                      # TIER-1 归档索引/存储（启用时）
├── archive-t1-*.db                 # 不可变温层 session-generation units
├── archive-t2-*.db                 # 不可变冷层 session-generation units
├── negotiation-states.json         # 学习到的每模型禁用项（betas / body 字段 / efforts）
├── auto-truncate-limits.json       # 学习到的每模型 token 计数 calibration 因子
└── system-prompts/                 # 可选的 system prompt 转储（开启时）
```

### 环境变量

| 变量 | 说明 |
|------|------|
| `XDG_DATA_HOME` | 覆盖 `copilot-api/` 数据目录的父目录 |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | 除非传 `--no-http-proxy-from-env`，否则会被使用 |
| `NODE_ENV` | `npm run start` 会设为 `production`；影响日志详细度 |
| `BROWSER` | `auth` Device Flow 用于打开验证 URL |

---

## 内部 API 端点

### 管理 与 UI

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/status` | GET | 服务器状态（uptime、account 类型、模型数量、in-flight 等） |
| `/api/tokens` | GET | GitHub + Copilot token 信息（除非 `--show-github-token`，否则脱敏） |
| `/api/models` | GET | 内部模型目录（完整 Copilot 数据） |
| `/api/models/:model` | GET | 单个模型（内部完整结构） |
| `/api/config` | GET | 生效的运行时配置 |
| `/api/config/yaml` | GET / PUT | 读取 / 替换 `config.yaml`（触发完整重新应用） |
| `/api/logs` | GET | 最近的请求日志（内存环形缓冲） |
| `/api/event_logging/batch` | POST | 静默消费 Anthropic event-logging 信标 |
| `/health` | GET | 存活探针（200 / 503） |
| `/ui/*` | GET | 基于 Vuetify 的 History Web UI（静态 SPA） |

### History API

REST 位于 `/history/api/` 之下：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/history/api/entries` | GET | 分页条目列表（按 model / endpoint / status / session / 时间过滤） |
| `/history/api/entries/:id` | GET | 单个条目（解码后的 payload + response、headers、timing、billing） |
| `/history/api/entries` | DELETE | 批量删除（按 id 列表、session 或清空） |
| `/history/api/stats` | GET | 聚合计数、token 总量、计费倍率、模型分布 |
| `/history/api/sessions` | GET | Session 列表（基于 headers 推断的 Claude Code / Codex session） |
| `/history/api/sessions/:id` | GET | Session 详情（聚合 + 条目引用） |
| `/history/api/sessions/:id` | DELETE | 删除指定 session 的所有条目 |
| `/history/api/export` | GET | 以 JSON 导出 history |

WebSocket `/ws` 是带 topic 的总线，承载：

- `history` — 新条目、更新、finalize、删除事件
- `status` — 服务器状态变化
- `shutdown` — 排空开始 / 阶段切换
- （per-request）针对 in-flight 请求的实时 SSE 回放

---

## 许可证

[MIT](LICENSE)
