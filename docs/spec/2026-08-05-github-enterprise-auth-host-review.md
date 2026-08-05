# GitHub Enterprise 鉴权主机设计评审与处置

- 日期：2026-08-05
- 评审对象：[2026-08-05-github-enterprise-auth-host.md](./2026-08-05-github-enterprise-auth-host.md)
- reviewer：独立 GPT reviewer，隔离 worktree，固定基线 `7dc82aaf1e84d3907a0e563377f9c6f656cfdaa9`
- 前一书面版本结论：`PASS：可进入书面规格阶段。`
- 最终状态：合并态评审与最后一项 debug 负向验收复核均通过
- 最终结论：`PASS：规格可交用户审阅`

## 1. 可核验命题

首次评审逐条核验了以下当前状态：

1. device code 与 OAuth poll 固定使用 `GITHUB_BASE_URL=https://github.com`。
2. `/user`、`/copilot_internal/v2/token` 与 `/copilot_internal/user` 固定使用 `GITHUB_API_BASE_URL=https://api.github.com`。
3. `login` 在 token 网络请求前调用 `applyConfigToState()`，但其它 token-aware CLI 接线并不一致。
4. `ghc_api_base_url` 只进入 Copilot 模型上游，不改变 GitHub OAuth/API token 请求。
5. token persistence 只有一个 `githubTokenPath`，文件只含纯 token，不记录 authority。
6. token runtime 持有 manager、refresh timer 与在途 refresh；endpoint 若做 live getter 会混合身份生命周期。
7. live probe 只能证明匿名/无效凭据下的限定响应，不能证明企业成功鉴权链。

## 2. 首轮发现与处置

| 发现 | 级别 | 处置 |
|---|---:|---|
| 无效 `github` 配置可能被 `validateConfig()` 剥离并静默回退公共 GitHub | major | 采纳。`github` 子树在一般 warn-strip 前严格原子校验，身份配置窄域 fail-closed。 |
| authority 来源、canonicalization 与 token path 碰撞规则未冻结 | major | 采纳。authority 唯一来自 canonical Web/OAuth origin；企业 token path 使用完整 SHA-256。 |
| `debug info/models`、`logout` 等入口没有共享 config/proxy/runtime bootstrap | major | 采纳。所有 token-aware CLI 收敛到 `bootstrapTokenCommand()`。 |
| proxy 用单一 Copilot origin 预采样，无法覆盖三个 origin | major | 采纳。改为逐 origin 的 CLI→env→config→direct policy。 |
| resolver/mock 单测可能漏掉 CLI composition seam | major | 采纳。增加入口矩阵、独立 expected、正反控制与 mutation。 |
| 建议采用 `@octokit/auth-oauth-device` | major | 最初暂不采纳，复评后撤回并采纳，见下一节。 |

## 3. Octokit 分歧与裁决

主会话最初认为 Octokit 的单一 `baseUrl` 无法表达 GHEC Web/API 分域。reviewer 反驳：Octokit 的两个 route 都属于 OAuth Web origin，GitHub REST API 仍由项目 client 访问独立 API origin，二者不存在冲突。

源码复核确认 reviewer 正确：

- `@octokit/oauth-methods` 的 `createDeviceCode` 请求 `POST /login/device/code`。
- `exchangeDeviceCode` 请求 `POST /login/oauth/access_token`。
- 两者使用同一个 injected request，正好应绑定 Web/OAuth origin。
- `/user` 与 `/copilot_internal/*` 不交给该 OAuth request。

随后在 Node 24.16.0 与 Bun 1.3.14 上运行受控 PoC。首版 PoC 证明高层包可经自定义 fetch adapter 把一次 device-code 与两次 token poll 全部送往 `https://msft.ghe.com/...`，并处理 HTTP 200 body `slow_down`。

书面规格 fresh review 随后发现，高层包的 polling sleep 使用不可注入、无 signal 的裸 `setTimeout`。外层 deadline race 无法清除 sleeper，与本项目“取消后零遗留 timer/promise”契约冲突。最终处置因此进一步收敛：采用 `@octokit/oauth-methods@6.0.3` 的 `createDeviceCode`／`exchangeDeviceCode` 维护 OAuth wire 解析，由项目自己的 abortable scheduler 处理 `authorization_pending`、`slow_down` cadence、deadline 与取消；项目继续管理三端点、authority、persistence、transport 与 proxy。修订版 PoC 在 Node/Bun 上验证低层 methods 同样只访问 Web origin，并把 `slow_down` 暴露给项目 scheduler。

## 4. 复评发现与处置

### 4.1 `ensurePaths()` 先触碰公共 token

reviewer 指出 `src/lib/config/paths.ts:88-91` 在严格 GitHub 配置解析前创建公共 token 文件，违反 fail-closed 顺序。

处置：拆成 `ensureAppDirectory()` 与 authority-specific storage action。无效 GitHub 配置在任何 token 文件访问前失败。read-only/delete 模式不创建空 token。

### 4.2 GHES API root 带 base path

reviewer 指出显式 `api_base_url` 若被当作 origin，会误拒绝标准 GHES `https://host/api/v3`。

处置：区分 `GitHubAuthority`/Web origin 与 endpoint base URL。API/Copilot base URL 可带 path；共享 helper 保留 base path 追加 route，并拒绝 suffix query/fragment/authority。

### 4.3 一般配置管线遗漏

reviewer 指出 token bootstrap 不能只解析 `github`，否则 proxy 与其它命令配置会绕过 bundled defaults、deprecated migration 与 warn-strip。

早期处置：固定 raw YAML→strict GitHub→一般 validation→bundled merge→apply effective config→snapshot 的单一管线。该形状随后被 fresh re-review 证明仍会部分发布，已由 §6 的 prepare→no-throw transactional commit 两阶段事务取代，不是当前方案。

进一步复核发现 `loadRawConfigFile()` 当前已调用 `validateConfig()`，所以 strict GitHub 不能简单放在该函数之后。规格要求拆开 raw YAML parser 与 Zod validation，在两者之间裁决原始 `github` 子树。

## 5. 最终复评

最终 reviewer 对以下形状明确给出通过：

- YAML parse error 对 token-aware 命令 fail-closed。
- raw `github` 子树在一般 recovery 前 strict parse。
- 其它字段继续现有 migration、warn-strip、bundled merge 与 hot-reload cache。
- effective config 与 CLI override 共同解析 immutable snapshot。
- storage、per-origin proxy 与 runtime 安装均在 snapshot 之后。
- endpoint base path 经 URL parser canonicalization 后由 path-preserving helper 追加。

最终原文：`PASS：可进入书面规格阶段。`

## 6. 书面规格 fresh review 的新增处置

已提交书面版本的独立复评又发现五处 major，并均纳入当前规格：

1. 高层 `auth-oauth-device` 的内部 sleep 不可取消。改用低层 `oauth-methods` + 项目 abortable scheduler。
2. 运行时 mtime reload 遇到无效 GitHub/YAML 时，既不能整体退 bundled defaults，也不能每请求抛错。首版改为 last-known-good + `pending-invalid`，但 fresh re-review 指出当前 `applyConfigToState()` 会先发布 cache、逐项修改 singleton，后面才可能因 generation 交叉约束抛错，仍会留下混合状态。最终规格改为两阶段配置事务：零副作用 `prepareConfigApplication()` 覆盖所有可能失败的 normalization/compile/cross-field check；no-throw `commitConfigApplication()` 延迟/coalesce listener；commit 后才发布 cache/content generation。PUT 在写盘前 prepare 最终 candidate，写盘后复用同一 plan。
3. `debug info` 与 `debug models/usage` 不能共用含 device fallback 的 read-only policy。前者纯只读；后两者只接受 CLI/env/file token，缺失时提示先 login。
4. URL parser 会把 `/a/..` 与编码 dot-segment 洗成 `/`。首轮修订只检查 `/ ? #`，复评又发现 WHATWG 会把反斜杠当 `/`，并静默移除 TAB/LF/CR。最终 validator 在 parser 前对所有 URL 字段拒绝 `\`、`U+0000–U+001F`、`U+007F`；origin 另外检查严格 raw path grammar，再 canonicalize。Node/Bun 探针对两种行为给出一致结果。
5. 跨-authority 401 探针缺公共正向控制。脚本现先要求同一 token 的公共 `/user` 为 `200 + login`，再运行企业请求；结论限定为该枚 token 与该 tenant。

这些修改属于重写后的新版本，已重新触发独立复评。原 fresh reviewer 的 transcript 被平台清理、无法恢复，因此由一名未参与前轮的新 reviewer 接手，只复核这五项修订；该 reviewer 首次长回复遇 API 中断后，按同一上下文分段续跑，最终逐项判定 OAuth、两阶段配置事务、debug/storage policy、raw URL guard 与实验证据均为 `FIXED`。合并态评审随后发现 debug policy 虽有行为契约，却缺少无 token 分支的独立验收；最终规格补上 `debug info` 零 manager/network/write、`debug models/usage` 零 device fallback、合法 CLI/env/file 正样本与反向 mutation，闭合最后一处 criteria seam。

## 7. 合并态评审与最终收口

合并态 reviewer 对固定提交 `b4864d8c5f400d883f4d5a6f30251a8c687206d3` 的主规格、评审记录与实验产物做整体对账。两阶段配置事务、PUT、OAuth scheduler、raw URL guard、per-origin proxy 与实验证据相互一致；唯一剩余 major 是 debug provider policy 缺少无 token 分支的可判别验收。

规格随后补充：

- `debug info` 无 token 时断言 manager、device、network、write 全为零。
- `debug models/usage` 无 token 时断言非零退出、login 提示以及 device/OAuth/network/write 全为零。
- CLI、env、current-authority file 三个成功样本防 false-red。
- login/start/setup 的 device 成功样本与三类 mutation 防 provider restriction 误扩散。

同一 reviewer 复核后判定该补丁同时覆盖正确状态与错误状态，最终原文为：`PASS：规格可交用户审阅`。

## 8. 双向判据

评审要求测试同时防两类失败：

- false-green：resolver 正确但某个 CLI 没接线、企业路径回退公共 token、Copilot explicit override 被 enterprise 派生覆盖、proxy 用错 origin 仍全绿。
- false-red：公共 GitHub默认、四种 GHEC 输入、HTTP/非默认端口的显式 origin、GHES `/api/v3`、混合显式 override 被过严校验拒绝。

测试 expected 必须由独立 oracle 写死，不得调用生产 resolver 生成 expected。live probe 必须同时记录“证明了什么”和“没有证明什么”。
