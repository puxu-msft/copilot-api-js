# 新会话 kick-off 提示词

复制下面整段作为新会话的第一条消息。

---

接手 copilot-api-js 上一轮未完的工作。**唯一入口是 [docs/plan/2026-07-27-keepalive-and-separator/HANDOVER.md](./HANDOVER.md)，请先完整读它**，再读它 §0 指向的三份研究报告中与你要动的那条线相关的那份。

## 硬性工作方式（用户 2026-07-27 决定）

**代码改动一律在隔离 worktree 进行，不要在共享主树上改代码。** 建树的命令与技法以 skill `git-preference:isolating-from-a-shared-git-worktree` 为准。本仓要知道的一条：`.worktrees/` 建在仓库内部，**向上解析主树的 `node_modules`，不是依赖隔离环境**（实测无 `node_modules` 的新树里 eslint 照样 exit 0）；真正会咬的是新树缺 gitignored 构建产物导致的稳定假红。

例外：`docs/plan/2026-07-27-keepalive-and-separator/` 下的交接与研究文档可以在主树直接改并即时提交——它们是入口，滞留分支上等于没写。**收尾与交接的完整 how-to 见 skill `session-closeout`（§6 是单一源，骨架见其 `handover.md`）**，本提示词只摘其中与你这次直接相关的部分。

合回 master 前先 `git log --oneline ..master -- <你改动的路径>`（方向别写反：`master..` 列的是你自己的提交）看并发会话在同一区域落了什么，再 `git log -S<你结论里的关键符号>`。上一轮就是因为没查，把一个 peer 早 6 小时修掉的缺陷写成了"不存在的缺陷"。

## 待办与优先级

交接文档 §3 有 T1–T6，每条带验收判据与证伪方式。用户已批准 T1–T4：

- **T1** commit 时机推迟到首个真实块（要求**源码 + 实证双证**不破坏 CC↔proxy 连接；必须与 `docs/spec/2026-07-23-upstream-silence-commit-timing.md` 合并设计）
- **T2** W3（首块已提交、块间无开块）兜底手段——**必须做实验**，骨架照抄 `exp/keepalive-escalation-wire/`
- **T3** 不可见 Unicode 的 PoC（五道门，落点是 `SEPARATOR_CARRIERS` 的 EMIT 轴）
- **T4** 删 `empty_text` 保活模式（**先确认它是否已被 escalation 取代**，别删还在用的）
- **T5** 顺序不变量审计的 6 个发现（2 CRITICAL，其中 Responses WS 缺 `acc.streamError` 分支是**已发生的漂移**，不是缺守卫）——**需要用户先裁决顺序**
- **T6** 零散项（`.codex` 空文件去留待用户一句话）

**先做哪条由用户定**；若用户没指定，按交接文档的建议顺序，并在动手前把你的计划和判据说给用户确认。

## 这一轮反复踩到的坑（交接 §5 有完整版）

1. `offsetMs` 是 **commit 相对**的，不是请求开始相对——上一轮据此做时间归因，得出了错误结论并写进了给用户的报告。
2. **空的检索结果不能证明不存在**：先证明你的检索式/投影**能**带出你要找的东西（正样本对照），再用它下否定结论。
3. **动手前先 `git log` 查 peer**：本轮有两处结论被并发会话已落地的提交推翻。
4. **SCC 环守卫会咬**：往 `src/lib/anthropic/sanitize/*` 里 import `state` 会把文件吸进 19 模块巨型 SCC。配置读留在装配层，解析结果向下传参。
5. **后端抖动时永远 `SendMessage` 恢复同一个 agent**，不换模型、不另派；并要求它边查边落盘（本轮 agent 中断 4 次）。

## 测试与门禁（**核验于 2026-07-28 12:20 / `847f8bc8`；接手第一件事是复验而非采信**）

- `bun run test:backend` 现在就是 `bun scripts/parallel-test.ts unit it http`（`1b8bdf2f`，2026-07-28 09:30 起不再前置 `build:history-search`），可以直接跑。本提示词早先版本说它"跑不起来、请用 parallel-test 替代"——那句**写下时（07-27 21:26）是对的**，12 小时后被这个提交作废，两者现在是同一条命令。这就是本节标核验时间的原因。
- `bun run lint:all` 常年红（主要是退役的 `ui/`），只对自己改动的文件跑 `bunx eslint`。
- 以上两条用户已明确**推迟**修复，不要顺手去修。
- **绝不**碰 4141 端口的用户主服务器；起测试实例用其它端口 + `XDG_DATA_HOME` 隔离，用后按 PID 精确 kill（绝不 `pkill`）。
