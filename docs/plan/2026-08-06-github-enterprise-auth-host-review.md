# GitHub Enterprise 鉴权主机实施计划评审与处置

- 日期：2026-08-06
- 评审对象：[2026-08-06-github-enterprise-auth-host.md](./2026-08-06-github-enterprise-auth-host.md)、[2026-08-06-github-enterprise-auth-host-kickoff.md](./2026-08-06-github-enterprise-auth-host-kickoff.md)
- 事实权威：[已批准规格](../spec/2026-08-05-github-enterprise-auth-host.md)
- reviewer：规格阶段原 reviewer，经 `SendMessage` 恢复上下文复用
- 最终结论：`PASS：计划可定稿`

## 第一轮：4 major

| Finding | 处置 |
|---|---|
| `validateConfig()` 在 prepare 阶段立即 warning/登记 warn-once，违反零副作用 | 拆出纯 `prepareDeprecatedConfigMigration()` 与 `prepareConfigValidation()`；diagnostics 作为带 `dedupKey` 的数据进入 plan，成功 commit 后才登记/输出。 |
| Reload/PUT 可并发 prepare/commit stale plan | 所有 config 入口经过 rejection-tolerant `runConfigTransaction()`；reload commit 前复核 disk content generation，PUT 在队列内完成 read→prepare→atomic write→commit；补 barrier 与 stale-plan mutation。 |
| Task 2 曾写 `assertStrictGithubConfig(raw.github)`，漏顶层 `ghc_api_base_url` | 统一传完整 raw top-level mapping；boot/reload/PUT 同表覆盖 `github.*` 与顶层 URL，并用 `raw.github` mutation 证判别力。 |
| 只测 shared bootstrap primitive，真实 CLI 可继续旧接线 | 驱动真实 runner，并加 source guard、整段绕过/单入口绕过/start 预采样 mutations。 |

复评结果：并发与 strict-call 两项 `FIXED`；validation diagnostics 与 debug runner 接口仍有 2 major。

## 第二轮：2 major

| Finding | 处置 |
|---|---|
| `ConfigValidationPlan.diagnostics` 到 `ConfigApplicationPlan` 丢 `dedupKey` | `validateAndMergeConfig()` 返回 `{config, diagnostics}`；prepare options 接收 `validationDiagnostics`；最终 plan 使用 `ConfigDiagnostic[]`；测试删除传递接线后变红。 |
| `runDebug()` 只代表 info，计划驱动不到内联的 models/usage callbacks | 明确抽出/导出 `runDebugModels()`、`runDebugUsage()`；8 个真实 runner 分别测试；两个 network runner 各覆盖无 token 与 CLI/env/current-file 三正样本；6 个物理 CLI 文件 source guard。 |

复评结果：两项均 `FIXED`；相邻的 queue/CAS、完整 raw strict call、结构化 patch、catalog-before-flush 与 deferred listener 契约保持完整。最终原文：`PASS：计划可定稿`。

## 额外自审修订

在评审轮次之间，主会话还自行发现并修正：

- 计划 Markdown 曾含真实 NUL 字节，改为字面 `\u0000`，重新确认零控制字节。
- 配置事务不能以函数 closure 冒充 no-throw，改为结构化 `ConfigDomainPatch`／`ConfigAfterCommitEffect` 穷尽解释。
- Disabled-model catalog 必须在 listener flush 前与 state 一致，改为 commit 内 domain patch。
- Foundation listener flush 每 listener 隔离错误，单个 listener 不能破坏 commit。
- Token 敏感文件不能 rename 后才 chmod，扩展共享 `atomicWriteText(...,{mode:0o600})` 让 temp file 首次可见即安全。
- OAuth provider 不再 catch-all→null，计划定义可判别的 `GitHubDeviceAuthError.kind`。
- 状态 API 同时展示 active endpoint snapshot 与 pending-invalid/pending-restart，避免声明值冒充运行值。

## 评审边界

计划已评审的是可执行性、接口接缝、TDD/mutation 鉴别力与范围完整性；产品代码尚未实施。`msft.ghe.com` 有权 device authorization→`/user`→token exchange→`/models` 成功链仍未验证，执行期按计划继续保留该边界。
