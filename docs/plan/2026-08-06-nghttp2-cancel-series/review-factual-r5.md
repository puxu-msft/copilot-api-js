# 事实证伪复评 R5

- **评审范围：** 主树候选 `HANDOVER.md@d7093f0afcc622b5fe05bcad7a13425b664fe2a80c99c0f4deea73cb952606e6`、`KICKOFF.md@c65eb648da4091649c2dee3be4ae17aa4696f02879bf360dac7f0d5814c16056`；仅复核 R4 两项及 allowlist 新接缝。
- **总体 verdict：** 修复 major 后可定稿。
- **计数：** 0 blocker / 3 major。
- **双视角覆盖：** 核对用户提供的 10 个 Bash／17 个 Python heredoc 语法绿与 exact-mode PoC 四臂；再模拟 attached short-option secret、completion 从错误 cwd 运行、非后代 HEAD、以及“禁写文件提交后再 revert”的 false-green。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:40-57` — argv[0] 之外仍会明文输出带附着值的 short option。
证据／失败场景：`:53-54` 对所有单横线 token 原样 `print(value)`；`-psecret`、`-HAuthorization:Bearer...` 或 `-C/secret/path` 都把 value/path 泄露。长 option 与 positionals 已 redacted，raw digest 已删除，但“任何 argv[1:] value 不输出”仍可假绿。
修复建议：argv[1:] 不输出原 token；最稳妥是仅输出 `<option-redacted>`／`<positional-redacted>` shape。若保留 short option name，必须有项目 CLI 的封闭 allowlist，不能泛化解析 attached value。

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:239-332,466-559,709-802` — 完成态 gate 接收 `WORKTREE`，但所有 Git 查询都在 ambient cwd 执行，未核 cwd／top-level 等于 root。
证据／失败场景：`git diff`、`git status`、`git rev-parse` 均无 `-C root`，Python 也未断言 `Path.cwd().resolve()==root`。agent 首门曾在正确树不保证主会话“独立重跑”仍在该树；若错误 cwd 恰有 allowlist 内同名变更，gate 可绿，同时读取的是另一树的 committed/WIP 集合。
修复建议：PYFINAL 开头机械核 `cwd==root` 且 `git -C root rev-parse --show-toplevel==root`，并给每条 Git 命令显式 `-C str(root)`；主会话仍从 Agent 登记路径独立复跑。

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:268-291,495-518,738-761` — packet 1 所称“committed paths”实际只是 BASE 与 HEAD 的净 tree diff，且最终不要求 BASE 是 HEAD 祖先。
证据／失败场景：`git diff base..HEAD` 会漏掉“禁写文件 commit 后再 revert”的历史触碰；对 sibling／rebased HEAD 也照常比较两棵树。只要净差异落在 allowlist 且 report 存在，subset mode 可绿，违背 carrier 固定在 BASE 与 committed-path 审计。
修复建议：先 `git merge-base --is-ancestor BASE HEAD`；再以逐 commit 的 `git log --format= --name-status -z BASE..HEAD`／`diff-tree` 枚举 union，rename/copy 两端同样纳入。净 `git diff` 可留作交叉验证，不能充当 committed history 集合。

## R4 disposition

1. **OPEN — argv 脱敏。** argv[0] basename、PID／cwd／exe 与 History 指纹仍足以核身份；长 option／positionals已脱敏，但 attached short-option value 仍泄露，见第 1 条。
2. **OPEN — allowlist 完成门。** carrier 位于 BASE、hash／路径语法、自授权禁止、WIP 与 rename/copy 两端、packet 0/2 exact report＋HEAD==BASE、packet 1 subset＋report 存在均已实现；用户提供 PoC 的四臂结果也支持这些子门。但 ambient-tree 与 committed-history 两个 false-green 尚未闭合，见第 2／3 条。
3. **语法与已有 PoC：未发现 blocker/major。** 10 个 Bash blocks、17 个 Python heredoc 语法全绿；临时 PoC 显示 exact report 正样本 rc0，额外 WIP／额外 commit／未授权 rename source 均 rc1。该 PoC 未覆盖本轮两类反例。
