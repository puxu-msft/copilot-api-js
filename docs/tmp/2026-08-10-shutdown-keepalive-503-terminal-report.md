# 终态报告 · shutdown keep-alive 503（2026-08-10）

> 本文件是收尾规程 `closing-a-development-session` 的 `draft_terminal_report` 产物。**状态：草稿，待独立评审**。

## 1. 交付了什么

`--restart` 零停机接管期间，客户端被钉在垂死的旧进程上持续收 `503 Server is shutting down`。两条机制都能造成，事故证据**不足以区分**，因此都堵：

- **(A)** 客户端 keep-alive 连接池复用指向旧进程的 socket → 新增最外层 `shutdownConnectionCloseMiddleware`（`src/lib/observability/middleware.ts`），关机期**经该中间件且最终状态 4xx/5xx** 的响应带 `Connection: close`；注册于 `src/server.ts`（config/token 中间件**之前**）与 `tests/helpers/test-app.ts`（`preMiddleware` 之前）。
- **(B)** 旧进程尚未走到关 listener → `server.close(false)` 移到 `gracefulShutdown` Step 1 **所有 await 之前**（`src/lib/shutdown.ts`）。

**已知残留（有意未决）**：drain 期间正常完成的 2xx、以及已提交 200 后流内失败的 SSE，都拿不到该头（头已发出）；后果是客户端下次请求先吃一条 503 再重连。覆盖它需在流式响应提交头之前决策。

## 2. 提交与位置

分支 `worktree-shutdown-keepalive-503`，worktree `/home/xp/src/copilot-api-js/.claude/worktrees/shutdown-keepalive-503`。

**master 已在收尾期间前进**：用户已把本分支合并进 master（merge commit `6d212286`），同期还有同伴会话的十余个提交（Task 37 seam / delivery 系列）。这一度使双方分叉、早先写的 `--ff-only` 失效——这份报告曾按快进描述下一步，是被合并动作反向弄陈旧的（由独立评审判为 blocker）。

**现已复位**：master 已合入本分支（并据此完成合并态验证，见第 3 节），`master...HEAD` 回到 `0 N`，master 是本分支祖先。当前差异以命令为准，不写死数字：

```
git -C <worktree> rev-list --left-right --count master...HEAD   # 左=master 独有，右=本分支独有
git -C <worktree> log --oneline master..HEAD                    # 本分支尚未进 master 的提交
```

截至本报告定稿，本分支仅剩收尾产物未合并（收尾清单、conventions 订正、本报告）；修复本体与其文档、测试、探针归档均已随 `6d212286` 进入 master。

**未推送**。发布是用户的决定。

## 3. 验证

| 项 | 结果 | 口径 |
|---|---|---|
| `bun run typecheck` | 绿 | 合并态新产出 |
| `bunx eslint <改动文件>` | 绿（`exp/` 的 3 条 ignore 警告为预期，eslint 配置忽略该目录） | 特性态产出 |
| `bun run test:backend`（特性态） | **7692 pass / 0 fail / 43 skipped** | 仅本分支内容 |
| `bun run test:backend`（**合并态**） | **7696 pass / 0 fail / 45 skipped** | 已把 master（含同伴 Task 37 / delivery 系列十余提交）合入本分支后重跑 |
| 变异对照（5 组） | 均按预期变红并还原 | 见收尾清单 5.1–5.5 |
| 探针（4 个） | 均可从归档位置复跑；Bun 探针含正样本对照（关闭端口 → `rc=1`） | 见 `exp/shutdown-keepalive-503/README.md` |

`verify_installed_location` **已完成**：master 已合入本分支并重跑全后端档位，因此这不再只是隔离特性态的绿。合并方向也因此复位——`master...HEAD` 现为 `0 N`，master 是本分支祖先，用户侧重新是干净快进。

⚠️ 但**「交付位置」不等于「运行位置」**：见第 7b 节，4141 实例是否已加载新代码未经验证，本报告不作断言。

## 4. 独立评审

| 轮次 | 角色 | 结论 |
|---|---|---|
| 代码/覆盖面评审 | 异模型 reviewer | 2 major（pre-gate 绕过、admission 中止路径），已整改 |
| 对抗性证伪 | verifier | 证实生产接线假绿；证实「任何失败响应」为过度声称 |
| 因果链裁决 | arbiter | 驳回「空洞即证明」；提出 (B′) |
| 合并态评审 | Claude reviewer | 0 blocker / 2 major / 4 minor，全部处置 |
| 整改裁决 | 未卷入第三方 | 支持我对 commit 类型争议的驳回；判 3 项整改不足，已补 |
| 收尾清单对账 | explorer | **六遍，无一为空**；轨迹 16→4→4→1→2→1 |

**尚未评审**：本报告自身（本轮送审中）。

## 5. 临时状态

job 临时目录 `/home/xp/.claude/jobs/94a67bb3/tmp`：**6 个文件，零删除**，全部有处置（4 个承重探针已归档进 `exp/shutdown-keepalive-503/` 并复跑；2 个 schema 内省脚本判为可弃但保留）。目录交由 harness 过期。明细见 `docs/tmp/2026-08-10-shutdown-keepalive-503-closeout-manifest.md` A 节。

**保留的他人 WIP**：无——本 worktree 为本会话独占新建。

## 6. 可复用资产（`recommend_assets`）

**已实施**
- `docs/lifecycle.md`「优雅重启」：记录两条机制、两条修复、已知残留，并订正当年「只修探针没修生产」的 PoC 注记。
- `.claude/skills/process-lifecycle-shutdown/SKILL.md`：首信号两条义务入册。
- `docs/coding-conventions.md`：澄清 discovery baseline **每次测试都在跑**，新增/删除测试文件须同提交同步。
- `docs/ws-openai-responses.md`：以现码重写已删除的四阶段模型。

**仅建议、未实施**
- `closing-a-development-session` Step 7 建议补一条：评审对**工作树状态**的自述同样需复核（现规程只要求复核其对代码的绝对断言）。已按该 skill 的协议写入其 `verification-log.md`，由 skill 所有者裁决。
- `positive-control-your-tests` 可考虑扩一节：**被委派的**变异（你派出去的评审在你的树里做变异）与自己做变异的还原纪律不同。

**明确不建议新增资产**
- 「派 agent 必须用工具参数绑定目录」**已有规则**（user-rule `20-tool-use-preference` 的 `bind-delegate-directory`，并指向 skill `proving-where-a-command-ran`）。本轮是**违反已有规则**，不是缺规则；再造一条只会稀释。

## 7. 下一步

1. **合并剩余的收尾产物**。master 已合入本分支，因此这一步是干净快进：

   ```
   git -C /home/xp/src/copilot-api-js merge --ff-only worktree-shutdown-keepalive-503
   ```

   ⚠️ **执行前请自行确认主检出干净**。规程要求合并前检查主树工作区与 index，但隔离 worktree 的护栏拒绝本会话对共享检出做任何 git 操作，**我结构上查不到**；主树是否有同伴未提交改动我无从得知。同期有同伴会话在活动，这一点尤其要看。

2. **重启 4141 实例才会生效**——见下节。

## 7b. 运行实例尚未验证（重要）

**合并进 master、测试全绿，都不等于你正在用的 4141 实例已加载新代码。** 本报告**不对当前运行实例的版本作任何断言**：我没有、也不会重启用户的主服务器（项目纪律 `protect-user-main-server`）。

两点后果：

- 修复要**下次重启**才生效；
- **那次重启本身仍走旧代码的关机路径**——执行 drain 的是当前这个跑着旧码的进程。所以症状可能**最后再出现一次**，再往后才受保护。

## 7c. 本报告自身的归宿

本报告与收尾清单（`docs/tmp/2026-08-10-shutdown-keepalive-503-closeout-manifest.md`）**必须提交**，否则随 worktree 删除而丢失——`docs/tmp/` 是项目约定的评审与草稿落点。本报告在定稿评审通过后随收尾提交进入本分支，再随第 7 节第 1 步合并。

## 8. 未查明的遗留项

事故当天新实例从启动到开始监听耗时 **803 秒**（12:48:42 → 13:02:06），把暴露窗口整体拉长。已确认 `initHistory()` 在监听之前 `await`、且当时 1.3 GB 的库正被前任持有写入——**但成因未经证实**，与本次修复无关，值得单独立项。
