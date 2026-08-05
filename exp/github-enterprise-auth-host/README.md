# GitHub Enterprise 鉴权主机探针

本目录保留 2026-08-05 设计阶段的两类证据：真实 `msft.ghe.com` 匿名端点探针，以及 Octokit device-flow transport adapter 的受控 PoC。

## 文件

- `probe-anonymous.mjs`：真实访问 `msft.ghe.com`、`api.msft.ghe.com` 与 `copilot-api.msft.ghe.com`，只输出状态、content type 与非敏感字段存在性。
- `probe-cross-authority-token.mjs`：可选探针。通过环境变量读一个现有公共 GitHub token，验证它不能跨 authority 用于企业 API；不输出 token 或完整响应。
- `probe-octokit-adapter.mjs`：用受控 fake fetch 验证 Octokit 的 URL、HTTP 200 `slow_down` 处理和最终 token/scopes。
- `package.json`／`package-lock.json`：固定 PoC 当时使用的依赖版本。

## 运行匿名真实端点探针

```bash
node exp/github-enterprise-auth-host/probe-anonymous.mjs
```

2026-08-05 的结果摘要：

```text
POST https://msft.ghe.com/login/device/code                 200 application/json
POST https://msft.ghe.com/login/oauth/access_token          200 incorrect_device_code
GET  https://api.msft.ghe.com/user                          401 Must authenticate
GET  https://api.msft.ghe.com/copilot_internal/v2/token     401 Must authenticate
GET  https://copilot-api.msft.ghe.com/models                403
```

脚本会真实申请一枚短期 device code，但只输出字段存在性和 `verification_uri` 的 hostname，不打印或保存 `device_code`／`user_code`。

## 运行跨 authority token 探针

该探针会向真实企业 API 发出三个带 token 的请求。只有在你明确愿意使用当前 token 做此验证时才运行：

```bash
GITHUB_TOKEN="$(<"${XDG_DATA_HOME:-$HOME/.local/share}/copilot-api/github_token")" \
  node exp/github-enterprise-auth-host/probe-cross-authority-token.mjs
```

2026-08-05 使用现有公共 GitHub token 的结果是 `/user`、`/copilot_internal/v2/token` 与 `/copilot_internal/user` 均返回 `401 Bad credentials`。脚本不打印 token，只输出 token 长度、短 SHA-256 指纹与响应摘要；指纹只用于确认三次请求使用同一个输入，不是凭据替代品。

## 运行 Octokit adapter PoC

```bash
npm install --prefix exp/github-enterprise-auth-host --ignore-scripts
node exp/github-enterprise-auth-host/probe-octokit-adapter.mjs
bun exp/github-enterprise-auth-host/probe-octokit-adapter.mjs
```

期望输出中：

- 一次请求落到 `https://msft.ghe.com/login/device/code`。
- 两次请求落到 `https://msft.ghe.com/login/oauth/access_token`。
- 第一次 poll 的 HTTP 200 body 是 `slow_down`，库继续轮询。
- 最终 `tokenReturned=true` 且 scopes 为 `read:user`。

设计阶段实测 Node 24.16.0 与 Bun 1.3.14 均通过。

## 它证明了什么

- GHEC tenant Web origin 的两个 OAuth route 存在，且返回 GitHub device-flow 协议形状。
- 企业 GitHub API host 的 `/user` 与 token exchange path 存在并要求企业凭据。
- 企业 Copilot host 的 `/models` path 可达且受保护。
- 公共 GitHub token 不能直接跨 authority 用于 `api.msft.ghe.com`。
- Octokit 可通过自定义 fetch adapter 把两个 OAuth route 都送往 Web origin，并处理 HTTP 200 `slow_down`。

## 它没有证明什么

- 没有证明当前用户能完成 `msft.ghe.com` device authorization；当前用户无权访问该页面。
- 没有取得企业 GitHub token，所以没有证明 `/user` 成功、Copilot token exchange 成功或企业 `/models` 成功。
- 匿名 `401`／`403` 只证明当时的 host/path 与保护行为，不证明 entitlement、模型目录或生产 SLA。
- Octokit PoC 使用受控 fake fetch，不证明项目 composition root、proxy、HTTP/2 transport 或 token persistence 已正确接线。
- 这些探针不替代实现后的入口矩阵、mutation control 与有权 live probe。
