# GitHub Enterprise 鉴权主机实施 Kick-off

- 类型：kick-off prompt
- 实施状态：未实施
- 规格批准状态：用户已于 2026-08-05 批准；任务规模为中小型
- 权威计划：[2026-08-06-github-enterprise-auth-host.md](./2026-08-06-github-enterprise-auth-host.md)
- 权威规格：[../spec/2026-08-05-github-enterprise-auth-host.md](../spec/2026-08-05-github-enterprise-auth-host.md)

复制以下内容到新的实施会话：

---

实施已批准的 GitHub Enterprise 鉴权主机计划。

## 启动 gate

1. 先读 `CLAUDE.md`、`docs/DESIGN.md`、`docs/spec/2026-08-05-github-enterprise-auth-host.md` 和 `docs/plan/2026-08-06-github-enterprise-auth-host.md`。
2. 使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，严格按计划 Task 1→6 串行实施；不要重新设计已批准范围。
3. 在独立 worktree/分支实施。确认该 plan/spec 已先合入 master；若尚未合入，停止并报告，不在文档特性分支上直接实施。
4. 派 implementer 前创建 `docs/tmp/2026-08-06-github-enterprise-auth-host-progress-impl.md`，按 `session-closeout` §6b 写任务起始 SHA、分支、worktree、plan 和连续性判断；每个实现 commit 同时更新并提交该文件。
5. 不启动、停止或触碰 4141 主服务器。所有本地服务器验证只能使用非 4141 端口并按精确 PID 清理；本计划正常不需要服务器。
6. 不 push、不 amend、不 stash、不 reset、不整仓 add；每个任务使用精确 pathspec 和 Conventional Commits。
7. TDD：每个任务先红后绿，计划列出的 mutation control 必须真实执行；“写了 mutation”不等于已证明判据有鉴别力。
8. reviewer 若因网络/API 错误中断，永远用 `SendMessage` 恢复同一 reviewer，不换 agent、不换模型、不重派相同任务。
9. 长远正确与完整优先，不以中小型任务为由削减配置事务、provider 负向入口、per-origin proxy、live evidence 或文档同步。

## 第一步

从计划 Task 1 开始：建立 `GitHubEndpointSnapshot`、path-preserving route primitive、严格 raw URL guard 与 `github` 配置 schema。先写 `tests/config/github-endpoints.unit.test.ts` 并确认缺模块导致红，再写实现。

## 每个 Task 的完成报告

报告以下内容后再进入下一 Task：

- 本 Task 的 commit SHA 和精确文件列表。
- 红→绿命令与 mutation control 的实际失败机制。
- targeted tests、`bun run typecheck` 的结果。
- `file:line + 怪味类型 + 本轮处置/后续` 的结构怪味扫描。
- 内部替代方案、判据判别力、成熟第三方方案三项反思。
- 独立 reviewer 的 findings 与处置；有修订时用同一 reviewer 复评。

Task 6 完成后跑计划中的完整后端门禁、合并态独立评审和文档同步。若有权 `msft.ghe.com` live chain 仍因账号权限阻塞，明确标记未验证，不得用 mock/匿名 401/403 冒充成功。
