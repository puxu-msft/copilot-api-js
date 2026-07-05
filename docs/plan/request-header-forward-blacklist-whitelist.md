# request-header 转发改造：blacklist/whitelist 双模式 + 重命名 + 新增 whitelist

> **实施状态：已完成**
> **落地**：—
> **现状锚点**：运行时选项 `requestHeaderBlacklist`/`requestHeaderWhitelist`/`strictRequestHeaders`；header-glob-strip.ts
> **备注**：重命名 + 双模式 + 新 whitelist 全落地，compat 迁旧键

## Context（为什么做）

当前 Anthropic 请求头转发策略由两个键控制，语义不够对称、命名不一致：
- `strict_request_headers`（bool）：`false`=透传（除 core+敏感黑名单外全转发）、`true`=只发 proxy 重建的 core 头、**完全不透传任何客户端头**。
- `strip_request_headers`（glob[]）：只在 `false`（透传）模式下从透传子集再剥掉指定头。

问题：`true` 模式过于绝对（core-only，无法选择性放行个别客户端头）；两键命名（`strict_*` / `strip_*`）不成体系。

**目标**（已与用户敲定）：
1. 把 `strict_request_headers` 重定义为**模式开关**——`false`=**blacklist 模式**（除黑名单外全转发）、`true`=**whitelist 模式**（只转发白名单匹配的客户端头）。**保留布尔键名**（用户选定；`true`=whitelist 读起来即"更严格"，语义自洽）。
2. `strip_request_headers` **重命名**为 `request_header_blacklist`（经 compat.ts 自动迁移旧键）。
3. 新增 `request_header_whitelist`（glob[]），whitelist 模式下"全面填充"除 proxy core 头之外允许透传的客户端头。

## 设计要点

### 双模式共享安全地板
两模式都先过 `selectPassthroughHeaders`（[request-header-forward.ts:80](src/lib/anthropic/header-policy/request-header-forward.ts#L80)）——**去 proxy core 键 + 去敏感黑名单**（凭据 cookie/authorization/x-api-key + framing content-length/host/transfer-encoding 等）。这是**硬地板**，whitelist **不能**覆盖它（whitelist 只在"已安全可转发集"内做选择）。secure-by-default：绝不因 operator 把 `cookie` 写进白名单就向 GHC 转发客户端凭据。然后按模式分叉：
- **blacklist 模式**（strict=false）：`pruneHeaders(safe, requestHeaderBlacklist)` —— 安全集再剥黑名单 glob（现有行为，仅改键名）。
- **whitelist 模式**（strict=true）：`keepHeaders(safe, requestHeaderWhitelist)` —— 安全集只留白名单 glob 命中者（**新行为**：strict=true 不再是 core-only，而是 core + 白名单客户端头）。

模式选择激活哪个名单：blacklist 模式忽略 whitelist，whitelist 模式忽略 blacklist。空白名单 `[]` = whitelist 模式只发 core（等于旧 strict=true 行为）。

### 新原语 `keepHeaders`（header-glob-strip.ts）
`pruneHeaders`/`compileHeaderStrip` 的**保留版对偶**：`keepHeaders(headers, patterns)` + `compileHeaderAllow(patterns)`——只保留 name 匹配任一 glob 者。**关键语义反转**：`compileHeaderStrip([])` 返回 null（不剥任何）→ pruneHeaders 全留；`compileHeaderAllow([])` 匹配**零**个 → keepHeaders 返回 `{}`（空白名单=不放行任何客户端头）。复用现有 `globToRegExp`。

### 默认白名单（全面集，基于实测 Claude Code 入站头分类）
```yaml
request_header_whitelist:
  - accept
  - anthropic-dangerous-direct-browser-access
  - x-app
  - x-claude-code-*
  - x-stainless-*
```
覆盖实测 21 个入站头里"core 之外的安全头"：SDK 遥测 `x-stainless-*` + Claude Code 族 `x-claude-code-*`（**glob 一并覆盖 `x-claude-code-session-id` 与 subagent 标识 `x-claude-code-agent-id`**——后者被 telemetry agentKind 维度消费，见 [sessions.ts:61-66](src/lib/history/sessions.ts#L61)，单列 session-id 会漏 agent-id）+ `x-app` + `accept` + `anthropic-dangerous-direct-browser-access`。core（authorization/anthropic-version/anthropic-beta/content-type/user-agent…）与 framing（accept-encoding/connection/content-length/host）不入白名单（前者 core 自带、后者地板剥除）。**反直觉点（注释须说明）**：白名单里写**真 core 头**（如 user-agent）是 no-op——会被安全地板剥掉，因为 `{...selected, ...core}` 由 proxy core 兜底；`accept` 非 core（`copilotHeaders` 不含它），故白名单放行 `accept` 是有效的。

## 改动清单（按既有 stripRequestHeaders 模板 + compat renameLeaf）

1. **[header-glob-strip.ts](src/lib/anthropic/header-policy/header-glob-strip.ts)** — 新增 `compileHeaderAllow` + `keepHeaders`（复用 `globToRegExp`；空名单→keep nothing）。**同步更新该文件 module-doc + [request-header-forward.ts](src/lib/anthropic/header-policy/request-header-forward.ts) module-doc**（现注释只描述"passthrough + strip"单链，须改为双模式 blacklist/whitelist 模型）。
2. **[request-preparation.ts](src/lib/anthropic/request-preparation.ts) buildAnthropicHeaders（~L265-273）** — 把 `if (!strict)` 单分支改为：先 `selectPassthroughHeaders` 取安全集，再按 `state.strictRequestHeaders` 分叉 `keepHeaders(safe, whitelist)`（true）/ `pruneHeaders(safe, blacklist)`（false），`{ ...selected, ...core }`。更新该处内联注释（L257-264）。
3. **[schema.ts](src/lib/config/schema.ts)** — `strip_request_headers`→`request_header_blacklist`；新增 `request_header_whitelist: nullableNonemptyStringArray()`；重写 `strict_request_headers` JSDoc（blacklist/whitelist 模式语义）。
4. **[state.ts](src/lib/state.ts)** — `stripRequestHeaders`→`requestHeaderBlacklist`（**7 站点**：字段 L189 / cloneState L712 / cloneStatePatch L768 / patch-key 联合 L856 / CONFIG_MANAGED_DEFAULTS L1058 / reset 表 L1147 / init 表 L1263）；**新增** `requestHeaderWhitelist: ReadonlyArray<string>`（同 7 站点，含 cloneState/cloneStatePatch 的数组深拷贝）。默认 blacklist=`["x-anthropic-billing-header"]`、whitelist=上述全面集。**逐处 Edit、`grep -c` 对账**（防平行块错位，见 [[large-refactor-toolkit-sed-grep-status]]）。
5. **[config.ts](src/lib/config/config.ts) ~L496** — 重命名映射 `a.request_header_blacklist`→`requestHeaderBlacklist`；新增 `a.request_header_whitelist`→`requestHeaderWhitelist`。
6. **[compat.ts](src/lib/config/compat.ts) CONFIG_MIGRATIONS** — 加 `renameLeaf("anthropic.strip_request_headers", "anthropic.request_header_blacklist")`（无 transform，glob[]→glob[]）。
7. **[config.yaml](config.yaml)** — `strip_request_headers`→`request_header_blacklist`；新增 `request_header_whitelist`（全面集 + 双语注释，含上述"白名单写 core 头=no-op"反直觉点）；重写 `strict_request_headers` 注释为模式语义。**blacklist 默认 `x-anthropic-billing-header` 注释须诚实标注**：当前 CC 已把 attribution 改为请求体 `system[0]`、由 `strip_attribution_header` 接管，本 HTTP 头 blacklist 项现为**防御性**（旧版 CC / 其它客户端的 HTTP 头形态）。**强制项**（`new-config-key-must-document-in-bundled-config-yaml`，见 DESIGN 配置节）。
8. **[docs/DESIGN.md](docs/DESIGN.md)** — 运行时选项表：重写 `strictRequestHeaders` 行（模式语义）；`stripRequestHeaders` 行→`requestHeaderBlacklist`；新增 `requestHeaderWhitelist` 行。**另修 DESIGN.md:69**（HTTP header 捕获表里"`strictRequestHeaders=false` 时 `wire.headers` 含透传+剥离后的客户端头"——"剥离后"措辞对 whitelist 模式不准，改为模式中性表述）。

## 测试（TDD）

- **[header-glob-strip.unit.test.ts](tests/anthropic/header-policy/header-glob-strip.unit.test.ts)** — 加 `keepHeaders`/`compileHeaderAllow`：glob 命中保留、未命中剔除、**空名单→`{}`**（与 pruneHeaders 空名单→全留对比）、大小写、PROTECTED 无关（keep 无 protected 逻辑）。
- **[request-header-passthrough.unit.test.ts](tests/anthropic/header-policy/request-header-passthrough.unit.test.ts)** — 重命名旧断言；新增 whitelist 模式单测（安全集 ∩ 白名单）。
- **[request-header-passthrough.it.test.ts](tests/anthropic/request-header-passthrough.it.test.ts)** — **改写既有 `"strict=true … no passthrough"`（L63-66）**：新语义下它不再是"零透传"。重写为 whitelist 模式断言 + **补放行正样本**（白名单命中的客户端头如 `x-stainless-os`/`x-claude-code-agent-id` 在 strict=true **进** outbound——否则放行路径只有否定性断言、无正样本，违 [[feedback-pass-null-clean-not-self-validating]]）；非白名单头（`x-custom`）**不进**；core 仍优先。**加边界**：`strictRequestHeaders:true` + `requestHeaderWhitelist:[]` → 客户端头全无、仅 core（钉死 plan 声称的"空白名单≡旧 strict=true core-only"等价，M2）。blacklist 模式（strict=false）回归不变。
- **[config-compat.unit.test.ts](tests/config/config-compat.unit.test.ts)** — 加迁移断言：`strip_request_headers: [...]` → `request_header_blacklist`，user 设新键时新键优先。
- **[config-hot-reload.it.test.ts](tests/config/config-hot-reload.it.test.ts)** — 旧 `strip_request_headers` 条目**改名** `request_header_blacklist`（configKey + stateKey 两处同步，否则 R1/R2 测不存在的 yaml 键）；新增 `request_header_whitelist` 条目（sample≠默认）。两者满足 schema-叶子完整性守卫（L880 附近）。

## 验证

- `bun run typecheck`
- `bun test tests/anthropic/header-policy tests/anthropic/request-header-passthrough.it.test.ts tests/config`
- `bun run test:backend`（全套件，含 resetters/config 完整性守卫）
- `bun run lint`
- `grep -rn "stripRequestHeaders\|strip_request_headers\|strictRequestHeaders" src tests docs`（应仅剩 compat.ts 迁移源键 + 文档历史性 prose；config 表/state/schema 零残留；`strictRequestHeaders` 语义漂移点〔含 DESIGN.md:69〕全改为模式中性表述）
- 收尾：subagent audit（裁判轴=长远正确+完整）→ 文档 grep 核验 → 提交。

## 提交纪律（shared worktree——config.yaml 仍有 peer 在飞 relocation）
config.yaml 当前混有并发会话的 relocation 改动。提交时：用 `git apply --cached` 按 hunk 只暂存我的行，**绝不** `git add -A`；提交用 **`git commit -F msg`（无 pathspec）** 提交 index，**绝不** `git commit -- <path>`（取工作区版会扫入 peer relocation，见 [[git-commit-pathspec-commits-worktree-not-index]]）。其余文件 `git add -- <精确路径>`。

## 决策记录（已定）
- **模式开关**：保留 `strict_request_headers` 布尔（用户选定），false=blacklist/true=whitelist。
- **whitelist 默认**：全面集（accept / anthropic-dangerous-direct-browser-access / x-app / **`x-claude-code-*`** glob〔覆盖 session-id + subagent agent-id〕/ x-stainless-*）。
- **安全地板硬约束**：core + 敏感黑名单（凭据/framing）在两模式都强制剥除，whitelist 不可覆盖（secure-by-default）。
- **迁移**：strip_request_headers 经 compat.ts 自动迁 request_header_blacklist（无硬破坏）。
- **blacklist 默认值保留 `["x-anthropic-billing-header"]`**（忠实"重命名"=不改默认；reviewer 指出该 HTTP 头当前 CC 已不发、attribution 改走 body 由 `strip_attribution_header` 接管，故该项现为**防御性死配置**——保留无害且覆盖旧版/其它客户端的 HTTP 头形态，仅在 config.yaml 注释里诚实标注，不擅自清空）。
