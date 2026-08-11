# NGHTTP2_CANCEL 交接件接手方最终走查 R7

- **评审范围：** 只核 merge history gate 的正确／错误双向判别，并确认三个 packet、扩表流程、argv 与 root-bound allowlist 既有闭环未回归；未重做会话考古。
- **绑定证据：** `sha256sum` 得 HANDOVER `d7093f0afcc622b5fe05bcad7a13425b664fe2a80c99c0f4deea73cb952606e6`、KICKOFF `df5229906260cf9a80ea9bcdd42700444183a2fdd5155494b53a8de5ed184d47`。独立抽取 10 个 Bash block与 17 个 Python heredoc，语法均通过。复跑 `/home/xp/.claude/jobs/2684f077/tmp/merge-history-gate-poc.mhwjmpv4` 的预定五臂：合法 merge `rc=0`；side forbidden、main forbidden、merge-resolution extra、commit 后 revert 均 `rc=1`。
- **总体 verdict：** **0 blocker／0 major，可定稿。**
- **blocker 数量：** 0。

## Merge 双向走查

- **合法 merge 正确可过：** `KICKOFF.md:309-321,574-586,855-867` 以 `rev-list BASE..HEAD` 枚举全 DAG；每个 side/main commit 对自己的 first parent 审计，merge commit 只对 first parent 审计最终引入与 conflict-resolution 路径。合法 fixture 的 side `src/allowed.ts` 在 allowlist，first-parent 基线已有内容不被误算，最终 `rc=0`，无 false-red。
- **side 越权会红：** side commit 本身在 `rev-list` 集合中，其 first-parent diff 捕获 `forbidden-side.txt`；PoC `rc=1`。即使 merge resolution 随后删除它，逐 commit 并集仍保留触碰历史。
- **main 越权会红：** BASE 后 first-parent 链上的 `forbidden-main.txt` 由该 main commit 的 parent diff捕获；PoC `rc=1`。
- **merge resolution 越权会红：** merge 对 first parent 的 diff捕获仅在 merge 结果新增的 `forbidden-merge.txt`，PoC `rc=1`；不会把另一 parent 已独立审计的整棵内容误当 resolution，同时 side commit 仍单独受审。
- **commit→revert 不会洗白：** 每个 commit 的路径集合取并集，net diff只作额外 tripwire；`forbidden.txt` 即使后来 revert，PoC仍 `rc=1`。

## 三 packet 与扩表回归检查

- packet 0／2 的 `exact-report` 仍要求 `HEAD == BASE` 且最终路径集合严格等于唯一 report；它们不会合法产生 merge commit，越权 commit／WIP 必红。
- packet 1 的 `subset-report` 可接受 allowlist 内的正常多 commit与合法 merge，仍要求 report 存在；DAG audit覆盖 side/main/merge-resolution 三个入口，没有因支持 merge 而放松路径边界。
- 扩表仍为 `interim-subset → clean INTERIM_HEAD → 唯一 carrier maintenance commit → descendant NEW_BASE → 同一 agent bootstrap`（`KICKOFF.md:98-105,637`）；合法 commits不会被丢，无法提交的 WIP原样保留并停止，未回归分叉或数据丢失。

## 既有 CLOSED 项回归检查

- **argv：** `KICKOFF.md:31-50` 除 executable basename 外仅输出固定 token 类别，不暴露 option 名、值、路径、digest或长度。
- **root-bound gate：** 三份 `PYFINAL` 均先核 ambient cwd／top-level，并为全部 Git subprocess 传 `cwd=root`；agent与main从错误 cwd执行会红。
- **allowlist：** carrier仍在 BASE 中按固定路径与 hash冻结，不得自授权；committed DAG路径与 porcelain WIP合并后只准精确 allowlist，main必须在 Agent登记 worktree独立复跑。

## 双向结论

- **false-green：** side、main、merge-resolution、revert 四类越权均被独立 PoC咬住。
- **false-red：** 合法 side merge、正常多 commit、唯一 report与无自然样本的 A4路径均保持可达。

## 事实性发现

未发现 blocker或 major。

## 结构怪味扫描

- 扫描范围：三个 `PYFINAL` 的 DAG枚举、first-parent diff、net tripwire、WIP并集及 packet／扩表接缝。判据为 merge双计导致合法路径误拒、只审 first parent漏 side、只审 side漏 resolution、revert洗白。当前实现与五臂 PoC均覆盖这些形态，未发现需新增 backlog 的 blocker／major怪味。
