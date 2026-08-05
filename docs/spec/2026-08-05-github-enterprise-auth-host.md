# GitHub Enterprise 鉴权主机与端点配置

- 状态：草案，待用户审阅
- 日期：2026-08-05
- 参考实现：[sxwxs/ghc-api#34](https://github.com/sxwxs/ghc-api/pull/34)
- 实验证据：[exp/github-enterprise-auth-host/](../../exp/github-enterprise-auth-host/)
- 评审记录：[2026-08-05-github-enterprise-auth-host-review.md](./2026-08-05-github-enterprise-auth-host-review.md)

## 1. 问题

当前 token 包把 GitHub Web 与 GitHub REST API 固定为公共 GitHub：`packages/token/src/ghc-auth-http.ts:9-10` 定义 `https://api.github.com` 与 `https://github.com`，`github-client.ts:32-89` 和 `copilot-client.ts:18-55` 据此完成五类请求。配置中的 `ghc_api_base_url` 只控制拿到 Copilot token 后的模型上游，不改变 OAuth、用户校验或 Copilot token exchange。

这使 GitHub Enterprise Cloud 数据驻留 tenant 无法完成鉴权。例如 `msft.ghe.com` 使用三个不同 origin：

```text
OAuth Web:  https://msft.ghe.com
GitHub API: https://api.msft.ghe.com
Copilot API:https://copilot-api.msft.ghe.com
```

2026-08-05 的实测先确认现有 token 请求 `https://api.github.com/user` 得到 `200` 且含登录名；同一枚当时公共有效的 token 随后请求 `https://api.msft.ghe.com/user`、`/copilot_internal/v2/token` 与 `/copilot_internal/user` 均得到 `401 Bad credentials`。该单样本证明 token persistence 不能把公共文件无条件回退给这个 tenant；它不构成“所有公共 token 在协议上都不能跨 authority”的全称结论。因此，支持企业主机不仅要求改 URL，还要求把 endpoint identity、token persistence、CLI bootstrap 与 proxy 选择放进同一套契约。

## 2. 用户已裁决的范围

本规格冻结以下需求：

1. 通过 `config.yaml` 配置，不新增一键写配置的 CLI 参数。
2. `*.ghe.com` tenant 支持一项配置联动派生 OAuth Web、GitHub API 与 Copilot API 三个端点。
3. 非标准部署可分别显式覆盖 GitHub Web、GitHub API 与 Copilot API。
4. 不同 GitHub authority 的长期 token 分开持久化。
5. 公共 GitHub 默认行为与现有 token 文件路径保持兼容。

## 3. 配置表面

新增顶层 `github` section：

```yaml
github:
  # GitHub Enterprise Cloud 数据驻留 tenant。
  # 接受 tenant Web、GitHub API 或 Copilot API host 的常见写法。
  enterprise_host: "msft.ghe.com"

  # 高级覆盖项。通常不需要设置。
  # web_base_url: "https://github.example.com"
  # api_base_url: "https://github.example.com/api/v3"

# 现有字段继续作为 Copilot API 的显式覆盖项。
# ghc_api_base_url: "https://copilot.example.com/api"
```

三个端点分别采用以下优先级：

| 端点 | 第一优先级 | 第二优先级 | 默认 |
|---|---|---|---|
| GitHub Web/OAuth | `github.web_base_url` | `github.enterprise_host` 派生 | `https://github.com` |
| GitHub REST API | `github.api_base_url` | `github.enterprise_host` 派生 | `https://api.github.com` |
| Copilot API | CLI `--ghc-api-base-url`，再到 `ghc_api_base_url` | `github.enterprise_host` 派生 | 现有 `account_type` 解析与自动推断 |

显式覆盖只覆盖对应端点。`github.web_base_url` 改变 GitHub identity 与 token authority；`github.api_base_url` 和 `ghc_api_base_url` 不改变 identity。该规则允许公共 GitHub identity 通过自定义 API gateway，也允许 GHES 分别声明 Web origin 与带 `/api/v3` 的 API root。

配置 HTTP PUT 继续使用既有 structured validation。写入 `github` 或 `ghc_api_base_url` 成功后，响应必须明确标注“重启或重新运行命令后生效”；不得替换当前进程的 token endpoint snapshot。

## 4. GHEC tenant 派生

`github.enterprise_host` 接受以下等价形式：

```text
msft.ghe.com
https://msft.ghe.com
https://api.msft.ghe.com
https://copilot-api.msft.ghe.com
```

解析器从输入中移除至多一个已知服务前缀 `api.` 或 `copilot-api.`，得到 tenant `msft.ghe.com`，再派生三个端点。

`enterprise_host` 必须满足：

- 使用 HTTPS；裸 hostname 按 HTTPS 解释。
- 使用默认 HTTPS 端口。
- hostname 规范化后严格属于 `*.ghe.com`，且不能等于 `ghe.com`。
- 不含 credentials、path、query 或 fragment。
- hostname 经 URL parser 做 IDNA 与小写规范化，并移除末尾的 DNS root dot。

校验顺序必须先检查原始输入结构，再交给 URL parser canonicalize。所有用户提供的 GitHub Web/API/Copilot URL 与 `enterprise_host` 均先拒绝任意反斜杠、ASCII C0 控制字符 `U+0000–U+001F` 和 `U+007F`；不得先 `trim()` 或依赖 WHATWG URL parser，因为 special-scheme URL 会把 `\` 当 `/`，并会静默移除 TAB、LF、CR 以及首尾空白控制字符。对带 scheme 的 `enterprise_host`／Web origin，authority 后只允许空字符串或单个尾 `/`；对裸 `enterprise_host` hostname，hostname 后不得有 `/`、`\`、`?` 或 `#`。因此 `/a/..`、`/a/%2e%2e`、`/%2e/`、`//`、重复 slash 与任何反斜杠即使会被 parser 归一化成另一个合法形状，仍须按原始输入被拒绝。完成这道检查后，才使用 URL parser 的 hostname/port/credentials 结果做 canonicalization。显式 API/Copilot endpoint 仍可包含正常的正斜杠 base path，例如 `/api/v3`。

不满足条件时，token-aware 命令在任何 token 文件、proxy 或网络访问之前失败。不得静默退回公共 GitHub。

## 5. 三种值对象

### 5.1 `GitHubAuthority`

`GitHubAuthority` 是 OAuth/Web installation origin 的 canonical string，只含 scheme、hostname 与必要的非默认端口。它不含 path、query、fragment 或 credentials。

规范化规则：

- scheme 与 hostname 小写。
- URL parser 负责 IDNA 与 dot-segment 规范化。
- hostname 移除末尾 root dot。
- HTTP 的 `:80` 与 HTTPS 的 `:443` 折叠；其它端口保留。
- pathname 必须为空或 `/`，输出 origin 时不保留尾 `/`。

### 5.2 Web base URL

`webBaseUrl` 同样必须是 origin。OAuth route 固定追加 `/login/device/code` 与 `/login/oauth/access_token`，不允许 base path。

显式 `github.web_base_url` 支持 HTTP、HTTPS、非默认端口及非 `ghe.com` host，供本地测试与自托管部署使用。它一旦存在，就成为 `GitHubAuthority` 的来源。

### 5.3 Endpoint base URL

`apiBaseUrl` 与 Copilot base URL 是 endpoint base URL，可包含规范化后的 base pathname，例如 `https://github.example.com/api/v3`。它们支持 HTTP、HTTPS、非默认端口和非 `ghe.com` host，但拒绝 credentials、query 与 fragment。

所有固定 route 通过共享 path-preserving helper 追加。helper 把 `/user` 视为相对 suffix，得到 `https://github.example.com/api/v3/user`；不得使用会把 base path 清空的 `new URL("/user", base)`。helper 同时拒绝 suffix 自带 query、fragment 或 authority 的输入。

## 6. 不可变启动快照

配置域产出不可变启动快照：

```ts
interface GitHubEndpointSnapshot {
  readonly authority: string
  readonly webBaseUrl: string
  readonly apiBaseUrl: string
  readonly copilotBaseUrlOverride?: string
  readonly githubTokenPath: string
}
```

`copilotBaseUrlOverride` 只在 CLI/config 显式覆盖或 `enterprise_host` 派生时存在。公共默认不冻结最终 Copilot URL，继续允许现有 `account_type` 自动推断在启动期间选择 business/enterprise/individual 上游。

GitHub Web/API endpoint、authority 和 token path 在 token runtime 生命周期内不变。`showGitHubToken` 与 `vsCodeVersion` 等现有 live getter 可继续热更新，但 endpoint 不得做 live getter。否则自动刷新计时器可能拿旧 token 请求新 authority，或把新 authority 的 token 写进旧路径。

## 7. 严格 GitHub 配置与一般配置容错

项目现有 `validateConfig()` 会警告并剥离非法字段，再回退默认。该策略适合大多数功能配置，但不适合身份与鉴权端点：无效 enterprise host 若被剥离，进程会静默访问公共 GitHub。

共享加载管线固定为：

1. `ensureAppDirectory()` 只创建 `APP_DIR`，不创建或访问 token 文件。
2. `parseUserConfigYamlRaw()` 用现有 YAML strict/unique-key 规则读取用户配置，返回未经 Zod 容错处理的 mapping；文件缺席返回 `{}`。
3. YAML 语法错误、重复键或非 mapping 顶层在 token-aware 命令中 fail-closed，因为系统无法证明错误没有改变 authority。
4. 对 raw mapping 中存在的 `github` 子树运行 strict、原子 `GitHubConfigSchema`；整个 section 通过或整个命令失败。
5. bundled config 的 `github` 子树采用同一 strict 校验，失败视为打包缺陷。
6. 严格 GitHub 校验通过后，完整 mapping 进入现有 deprecated migration、`validateConfig()` warn-strip 与 schema-driven bundled/user merge。
7. `prepareConfigApplication(effective, currentRuntime)` 在零副作用阶段完成全部 normalization、正则/映射编译、跨字段约束和 restart-only 差异计算，产出不可变 `ConfigApplicationPlan`；任何错误都在这里抛出。
8. `commitConfigApplication(plan)` 在一个同步配置事务中应用预计算 patch。commit 路径必须 no-throw；各 domain 的同步 change listener 在事务内只登记变化，事务结束后基于完整 before/after 状态 coalesce 发布，不能在半提交状态重建 dispatcher 或观察其它 domain。
9. commit 成功后才同时发布 effective config cache、accepted content generation/mtime 与诊断状态；之后从 committed effective config 与 CLI override 解析 endpoint snapshot。
10. 此后才执行 storage action、proxy policy 与 token runtime 安装。

`loadConfig()` 与 `applyConfigToState()` 复用上述 raw parser、validation 和 merge primitives，并保留现有 mtime cache 与一般配置热重载。GitHub snapshot 不随热重载改变。

启动与运行期采用不同失败反应，但共享同一 strict validator：

- 首次启动或一次性 CLI 命令没有 last-known-good（最后已知有效）状态。YAML 或 `github` 子树无效时直接失败，不能回退 bundled defaults。
- 运行中的进程发现用户文件 mtime 改变后，先对候选内容完成 raw parse、strict GitHub、一般 validation、bundled merge 与 `prepareConfigApplication()`。只有 prepare 全绿才进入 no-throw commit；若任何阶段失败，继续使用最后已知有效 effective config、全部 runtime domain state 与当前 endpoint snapshot，记录 `pending-invalid` 诊断。不得先更新 cache/mtime，不得把全部用户配置退回 bundled defaults，也不得让每个请求重复抛错。
- 失败内容以内容 generation（至少包含 mtime + size + 内容摘要）去重，而不是只用 mtime；这避免编辑器在同一时间戳内重写时把已修复文件误判为旧失败。下一次内容 generation 有效后，清除 `pending-invalid`，一般 hot-reload 字段从新 committed plan 生效；GitHub endpoint 变化仍只标记 pending-restart，不替换当前 snapshot。
- `PUT /api/config/yaml` 必须先在内存中把 disk-only migration patch、请求 payload 与 bundled defaults 合成最终 candidate，运行 strict validation + `prepareConfigApplication()`；全绿后才原子写配置文件。写盘成功后执行同一个 no-throw commit plan，不得再 reset 全局 state 后重新读取/重新验证；若写盘失败，runtime state 不变。

测试覆盖三段状态：有效配置生效→手工写入会在 apply-time 才失败的 generation 交叉约束或无效 GitHub/YAML 后，config cache、Anthropic/retry/model/generation 等所有 runtime domain 与 endpoint snapshot 均保持 last-known-good→修复文件后一般配置一次性发布而 endpoint 仍待重启。另用 listener 探针断言事务期间没有观察到混合 before/after 状态，且每个 domain 每次事务最多收到一次合并通知。

## 8. Token 按 authority 隔离

公共 authority `https://github.com` 精确沿用现有 `PATHS.GITHUB_TOKEN_PATH`，不迁移、不复制，也不改变现有用户文件。

其它 authority 使用：

```text
$APP_DIR/github_tokens/<sha256(canonical-authority)>
```

摘要使用完整 64 位小写十六进制 SHA-256。路径不包含 hostname、用户名、token 或其它可泄漏内容。目录与 token 文件沿用 owner-only 权限；Unix 文件模式为 `0600`。

只有 `github.web_base_url` 或 `enterprise_host` 改变 authority。API/Copilot override 不改变 token path。

Provider 语义：

- CLI 与环境变量 token 属于当前启动 snapshot，只在当前 authority 上校验，不写盘。
- file provider 只读当前 snapshot 的 token path，不回退其它 authority。
- device auth 成功后只写当前 snapshot 的 token path。
- 切换 authority 后找不到 token，应进入当前 authority 的 device flow，不读取公共 token。
- `logout` 只删除当前 authority 的 token，不扫描或删除其它 tenant。
- `debug info` 显示 canonical authority 与实际 token path，方便运维辨认当前身份。

## 9. 统一 token-aware CLI bootstrap

新增共享、幂等的 `bootstrapTokenCommand()`，覆盖：

- `login`／`auth`
- `logout`
- `debug info`
- `debug models`
- `debug usage`
- `start`
- `setup-codex`
- `setup-claude-code`

固定顺序：

```text
ensureAppDirectory
→ parse raw YAML
→ strict github validation
→ general validation + bundled merge
→ prepare no-side-effect application plan
→ no-throw transactional commit
→ publish effective config/cache/generation
→ resolve immutable endpoint snapshot
→ authority-specific storage action
→ per-origin proxy policy
→ install token runtime(snapshot)
```

storage action 与 provider policy 按命令区分：

- `login`：`write-on-success`。启动时不预创建空 token；device auth 成功后原子创建 authority 目录并以 `0600` 写 token。
- `start`／`setup-*`：`read-or-write-on-device-success`。先只读 CLI/env/当前 authority 文件；若均无 token，可进入 device flow，并只在成功后原子创建目录写盘。
- `debug info`：`read-only`。只报告当前 authority、token path 与文件是否存在，不构造会发网络请求的 token manager，也不创建空文件。
- `debug models`／`debug usage`：`read-only-noninteractive`。只接受 CLI token、环境 token或当前 authority 文件，禁止回落 device provider；缺 token 时明确提示先运行 `copilot-api login`，不创建目录或文件。
- `logout`：`delete`。直接删除当前 authority 文件，`ENOENT` 视为已退出；不得先创建再删除。

File provider 不再依赖预创建的空文件：缺失与空文件都表示 unavailable。device auth persistence 使用临时文件加原子 rename，成功前不改变旧 token；创建目录和文件后设置 owner-only 权限。

入口不得自行复制配置、proxy 或 runtime 装配步骤。`cacheVSCodeVersion()` 继续访问公共 `api.github.com/repos/microsoft/vscode`，因为它读取公共软件版本，不代表当前用户 identity。

## 10. OAuth device flow 采用 Octokit 低层 methods

采用设计阶段核验时的最新稳定版本 `@octokit/oauth-methods@6.0.3`，并使用其依赖族兼容的 `@octokit/request`。实施时重新查询 latest stable，不从本规格猜测未来版本。

不采用 `@octokit/auth-oauth-device` 高层状态机。锁定版本的高层实现以不可注入、无 signal 的 `setTimeout` 递归等待；外层 `Promise.race` 只能让调用方先返回，不能清除内部 sleeper，不满足本项目“deadline 后无遗留 timer/promise”的生命周期契约。

项目使用官方低层 `createDeviceCode` 与 `exchangeDeviceCode`，并自己拥有可取消调度：

- `createDeviceCode` 申请 device/user code并返回 `verification_uri`、`expires_in` 与初始 `interval`。
- 项目展示 verification payload，并为该展示 callback 传入 cancellation signal；callback 必须响应取消。
- 项目调用 `exchangeDeviceCode`。它把 HTTP 200 body 中的 `authorization_pending` 与 `slow_down` 暴露为带 `response.data.error` 的结构化错误。
- `authorization_pending` 后用当前 interval 等待；`slow_down` 后先把后续 interval 增加 7 秒，再等待；其它协议错误立即传播。
- 等待使用项目的 abortable scheduler，而不是裸 `setTimeout`；scheduler 同时服从 caller cancellation 与 `expires_in` 绝对 deadline。
- 每次 fetch 另有 15 秒单请求 timeout，并与 caller/deadline signal 合并。
- 成功、失败或取消后 scheduler、deadline timer 与在途 fetch 全部 settle，不允许 detached sleeper。

composition root 使用 `request.defaults({ baseUrl: snapshot.webBaseUrl, request: { fetch: tokenFetchAdapter } })` 构造 OAuth request。`tokenFetchAdapter` 转发到既有 `TokenFetch`／`upstreamFetch`，保留 HTTP/2、proxy、测试 mock 与错误观测 seam。Octokit 拥有 OAuth request/response 解析；项目拥有 endpoint、authority、persistence、poll cadence、deadline、取消与 transport。

## 11. Per-origin proxy policy

现有启动流程用单一 Copilot origin 预采样环境代理，再全局选择 env 或 config proxy。三个 origin 可能分别命中 `NO_PROXY` 或不同环境代理，因此该模型不再成立。

新的逐请求优先级为：

```text
CLI --proxy
→ 环境代理（仅在 --http-proxy-from-env 启用且该 origin 命中时）
→ config.yaml proxy fallback
→ direct
```

环境代理对某 origin 未命中或被 `NO_PROXY` 排除时，继续回落 config proxy，而不是直接连接。GitHub Web、GitHub API 与 Copilot API 均按自己的最终 origin 求值。HTTP/2 transport 与 undici dispatcher 必须消费同一个 policy，不得各自重写优先级。

## 12. 错误处理与可观测性

- 首次启动与一次性命令遇到无效 `github` section、无法派生的 `enterprise_host`、无效 identity origin 或 endpoint URL：在网络与 token 文件 I/O 前失败，错误点名配置路径与被拒原因。运行中的 mtime reload 失败则遵守 §7 的 last-known-good／`pending-invalid` 契约。
- device flow 使用服务端返回的 `verification_uri`，不硬编码展示 URL。
- OAuth deadline、用户拒绝、过期、网络错误与协议错误保持不同错误原因；不得吞掉为“没有 token”。
- 日志显示当前 authority、最终三个 base URL 和 token path；不显示 token、device code 或完整 OAuth 响应。
- 配置更新但 snapshot 未重启时，状态 API/日志应能显示“配置值待重启”和“当前生效 snapshot”两者，避免声明值冒充运行值。

## 13. 测试与验收

### 13.1 纯解析正样本

- 公共默认：Web `github.com`、API `api.github.com`、无 Copilot override、旧 token path。
- `msft.ghe.com`、`https://msft.ghe.com`、`https://api.msft.ghe.com`、`https://copilot-api.msft.ghe.com` 四种输入得到相同三端点与 authority。
- 大小写、尾 root dot 与显式默认端口规范化为同一 authority。
- 显式 Web/API/Copilot override 分别覆盖自己的端点。
- GHES `web_base_url=https://host` 加 `api_base_url=https://host/api/v3` 保留 API base path。
- HTTP、本地端口与非 `ghe.com` 的显式 origin/base URL 作为合法高级样本通过。

### 13.2 纯解析负样本

- `enterprise_host` 使用 HTTP、非默认端口、credentials、path、query、fragment、裸 `ghe.com` 或非 `*.ghe.com`。
- `enterprise_host` 与 Web base URL 的原始输入含可被 parser 洗掉的 path：`/a/..`、`/a/%2e%2e`、`/%2e/`、`/%2e%2e/`、`//` 或重复 slash。
- 任一 GitHub Web/API/Copilot URL 或 `enterprise_host` 含反斜杠、TAB、LF、CR、其它 `U+0000–U+001F` 或 `U+007F`；覆盖字符在 hostname 中间与输入首尾两类位置。
- Web base URL 含 path、query、fragment 或 credentials。
- API/Copilot base URL 使用非 HTTP(S)、credentials、query 或 fragment。
- route suffix 含 query、fragment、scheme 或 authority。

### 13.3 配置与启动顺序

- 无效 `github` section 时，token 文件、proxy 初始化与 network mock 调用次数全部为零。
- 其它无效配置字段继续 warn-strip，合法 GitHub snapshot 仍可构造。
- bundled/user merge、deprecated migration 与 sparse override 保持现有语义。
- CLI override 只覆盖对应 effective config，不绕过 strict GitHub 校验。
- `prepareConfigApplication()` 覆盖现有所有 apply-time failure：generation 三条交叉约束、所有 normalization/compile 与 restart-only 计算；prepare 失败时 cache、mtime、全部 runtime domain state 和 listener 调用次数保持不变。
- commit 期间 listener 看不到中间态；事务结束后只收到完整 before/after 的合并通知。注入“先发布 cache”“在第一个 setter 后通知 listener”“generation 校验留在 setter 之后”三种缺陷时测试必须变红。
- HTTP PUT 在写盘前对最终 candidate 执行 prepare；prepare 失败时磁盘与 runtime 均不变。写盘成功后复用同一个 plan，一次 no-throw commit；合法 endpoint 变更标记重启后生效，live snapshot 不变。

### 13.4 入口矩阵

对第 9 节列出的每个 token-aware 命令，断言最终 URL、authority、token path 与 proxy decision。期望值由测试独立写死，不调用生产 resolver 生成 expected。

provider policy 另有独立的无 token 入口矩阵，不能用有 token 的成功路径代替：

- `debug info` 在 CLI/env/file token 均缺失时仍成功输出 authority、token path 与 `tokenExists=false`；断言 token manager 构造次数、device provider 调用、network 请求和文件写入全部为零。
- `debug models` 与 `debug usage` 在 CLI/env/file token 均缺失时以确定性非零退出码失败，错误明确提示先运行 `copilot-api login`；断言 device provider、OAuth URL、network 请求和文件写入全部为零。
- 同两条 debug 命令在 CLI、env、当前 authority file 三种 token 来源下分别成功，证明禁止 device fallback 没有误伤合法非交互来源。
- `login`／`start`／`setup-*` 的无 token 对照仍允许 device provider，证明 provider restriction 只作用于 debug policy，而非全局删除交互能力。

测试必须能抓住以下 mutation：

1. 整个 bootstrap 被绕过。
2. 只有一个入口漏接 bootstrap。
3. `debug info` 偷偷构造或调用 network-capable manager。
4. `debug models/usage` 重新启用 device fallback。
5. debug 的非交互 provider restriction 被错误扩散到 login/start/setup。

### 13.5 Token persistence

- 公共 authority 继续读取原 `github_token`。
- 两个企业 authority 的 digest 与文件路径不同。
- API/Copilot override 不改变 token path；Web override 改变。
- 企业文件缺失时绝不回退公共文件。
- `logout` 只删当前 authority；read-only/delete 模式不创建空文件。
- 文件权限保持 `0600`。

### 13.6 OAuth 与 transport

- 使用真实 Octokit 低层 methods 和受控 fetch boundary，先返回 HTTP 200 `authorization_pending`／`slow_down`，再成功；断言项目 scheduler 的轮询次数、5→12 秒 interval 变化与最终 token。
- adapter 捕获的 OAuth URL 全部落在 `webBaseUrl`，GitHub API client URL 全部落在 `apiBaseUrl`。
- fake clock 下分别把 deadline/主动取消停在 verification callback、pending sleep、slow-down sleep 与在途 fetch；每种场景均断言调用方 settle、后续请求为零、timer 为零。
- 单请求 timeout 只终止该 fetch；若总 deadline 尚未到，协议策略可按错误类型决定是否继续，不能把两种 timeout 混为同一错误。
- Node 与 Bun 双运行时执行 adapter smoke test。

### 13.7 Proxy 正反控制

Web、API、Copilot 三个 origin 分别覆盖：CLI proxy、env proxy、`NO_PROXY`、env miss 后 config fallback、无配置 direct。注入“用 Copilot origin 替其它 origin 预采样”的旧缺陷后测试必须变红。

### 13.8 Live verification

匿名探针必须继续可复跑并记录命令、日期、状态与响应摘要。有权企业账号可用后补正向链：

```text
device authorization
→ GET /user
→ GET /copilot_internal/v2/token
→ GET <copilot-base>/models
```

mock 与匿名状态码不得冒充这条正向链成功。

## 14. 已有实证与证据边界

2026-08-05 对 `msft.ghe.com` 的脱敏探针得到：

| 请求 | 结果 | 结论边界 |
|---|---|---|
| `POST /login/device/code` | `200 application/json`，完整 device-flow 字段，verification host 为 `msft.ghe.com` | Web origin 与 device-code route 存在 |
| `POST /login/oauth/access_token`，无效 device code | HTTP 200 body `incorrect_device_code` | OAuth poll route 与协议错误处理存在 |
| `GET https://api.msft.ghe.com/user`，匿名 | `401 Must authenticate` | API host/path 存在，不证明有权 token 成功 |
| `GET https://api.msft.ghe.com/copilot_internal/v2/token`，匿名 | `401 Must authenticate` | token exchange host/path 存在，不证明 exchange 成功 |
| `GET https://copilot-api.msft.ghe.com/models`，匿名 | `403` | Copilot host/path 可达，不证明 entitlement 或 token 可用 |
| 同一枚 token 先过公共 `/user` 正向控制，再请求企业 GitHub API | 公共 `/user` 为 `200 + login`；企业三个请求均为 `401 Bad credentials` | 这枚当时公共有效的 token 被该 tenant 拒绝；不外推到所有 token |

2026-08-05 本次尝试使用的账号当时无权访问 `msft.ghe.com/login/device`，因此没有取得企业 GitHub token。成功 `/user`、token exchange 与 `/models` 仍是明确的未验证项；账号权限以后可能变化，应以重新运行 live probe 的结果为准。

## 15. 不采用的方案

### 15.1 只替换 `github.com`

不采用。它漏掉 GitHub API、Copilot API、token identity、CLI bootstrap 与 proxy，下一位复用者仍会踩同一问题。

### 15.2 四个顶层配置字段

不采用。`github` section 更能表达 Web/API 同属 GitHub identity，避免继续扩大顶层配置表面；既有 `ghc_api_base_url` 保持兼容。

### 15.3 用新 `upstream_endpoints` section 取代 `ghc_api_base_url`

不采用。它会制造 Copilot URL 新旧双源并要求无关迁移。现有字段职责明确，可继续作为显式 override。

### 15.4 单一 token 文件

不采用。同一枚 token 的公共 `/user` 正向控制为 `200 + login`，而该 tenant 的三条 API 请求均为 `401`；这已证明对当前 tenant 无条件回退公共 token 文件会产生错误身份状态。

### 15.5 继续完全手写 OAuth polling

不采用。Octokit 低层 methods 已维护 OAuth request/response 解析并暴露结构化协议错误；项目只实现自己必须拥有且上游高层包无法取消的 scheduler、deadline、endpoint adapter、transport 与 persistence。

## 16. 结构性改进

本功能同时修复以下已有结构怪味：

| 位置 | 怪味 | 本轮处置 |
|---|---|---|
| `packages/token/src/ghc-auth-http.ts:9-10` | 环境相关 endpoint 被写成 token-domain 常量 | 改为启动 snapshot 注入 |
| `packages/token/src/github-client.ts` 与 `copilot-client.ts` | 五条请求各自拼接常量 | 收敛到 endpoint snapshot 与 path-preserving append |
| `src/lib/config/paths.ts:88-91` | 创建应用目录与创建公共 token 文件职责捆绑 | 拆成 app-dir 与 authority storage 两步 |
| `packages/cli/src/auth.ts`、`debug.ts`、`start.ts`、`setup-*.ts` | bootstrap 重复且同族入口强弱不一 | 收敛为共享 `bootstrapTokenCommand` |
| `packages/cli/src/logout.ts:9-12` | logout 固定公共 token path | 删除当前 authority token |
| `packages/cli/src/start.ts:349-356` | 单 origin 预采样决定全局 proxy | 改为 per-origin policy |

## 17. 完成判据

实现完成必须同时满足：

1. 公共 GitHub 行为、旧 token 路径与 `account_type` 自动推断不回归。
2. GHEC 四种输入形式得到相同三端点，所有 token-aware CLI 使用同一 snapshot。
3. GHES 显式 Web/API 配置保留 `/api/v3` 等 base path。
4. 无效 GitHub 配置在任何身份相关 I/O 前 fail-closed，其它配置继续既有容错。
5. token、logout 与 debug 都按 authority 工作，不发生跨 authority fallback。
6. OAuth 使用 Octokit 低层 methods 解析协议，轮询由项目可取消 scheduler 驱动，并保留项目 transport、deadline 与零遗留 timer 契约。
7. proxy 逐 origin 求值，并通过 env/config/NO_PROXY 双向控制。
8. Node、Bun、backend 测试与架构守卫通过。
9. 有权 live probe 若仍因账号权限阻塞，交付必须明确标记未验证，不得把 mock 写成全链成功。
