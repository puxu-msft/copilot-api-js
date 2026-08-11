# NGHTTP2_CANCEL 交接件接手方窄复核 R5

- **评审范围：** 以接手者第一人称，真走查三个 packet 的 allowlist 冻结、两阶段读取、完成 gate、扩表续跑与 main 独立回收；兼查 argv 脱敏和两阶段握手。未重做会话考古。
- **绑定证据：** `sha256sum` 得 HANDOVER `d7093f0afcc622b5fe05bcad7a13425b664fe2a80c99c0f4deea73cb952606e6`、KICKOFF `c65eb648da4091649c2dee3be4ae17aa4696f02879bf360dac7f0d5814c16056`。独立抽取检查 10 个 Bash block 与 17 个 Python heredoc，均语法通过。复跑 `/home/xp/.claude/jobs/2684f077/tmp/allowlist-gate-poc.qj8n_0rh`：唯一 report `rc=0`，extra WIP／extra commit／rename fixture 均 `rc=1`；该 PoC 均从 fixture repo cwd 运行，未覆盖下述错 cwd 反例。
- **总体 verdict：** 存在 blocker；修复后需复评。
- **blocker 数量：** 1。**major 数量：** 2。

## 事实性发现

[blocker] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:240-333,467-560,710-803` — 三份完成 gate 接收 `WORKTREE`，但所有 `git diff/status/rev-parse` subprocess 都未设 `cwd=root`，完成 block 也未核当前 `pwd/top-level`。
接手者会因此让 agent 或 main 在 ambient checkout 枚举路径，却从隔离树读取 report／allowlist；若 ambient 树恰有同名 report WIP，错误隔离树的越权改动可 false-green，main“双跑”也不能闭环。
证据：PoC 只有在 `cwd=fixture` 时符合预期；`PYFINAL` 的 `root` 仅用于文件路径，Git 命令均继承调用者 cwd。
修复建议：每个 Git subprocess 显式 `cwd=root`，并在 Python 开头核 `git -C root rev-parse --show-toplevel == root`；shell 同时核 `pwd -P`／top-level。agent 与 main 都用同一冻结脚本再跑正负 PoC。

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:40-57` — argv 并未“完全脱敏”：任意单横线参数会逐字打印。
接手者会因此把 `-pSECRET`、`-HAuthorization:...` 或其他短选项内联 credential 原值写进 preflight 记录。
证据：`:53-54` 对 `value.startswith("-")` 执行 `print(...={value})`；只有双横线参数的值在 `:45-52` 被 redacted。
修复建议：除 `argv[0]` basename 外，所有 argv 项只输出类别／位置；单横线项整体输出 `<redacted-short-option>`，不尝试解析组合短选项。

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:104,562` — “发现额外必要文件后更新 allowlist、提交新 BASE、同 agent 重新 bootstrap”未定义已有 commits／WIP 如何进入新 BASE。
接手者会因此在主线旧 BASE 上只提交新 allowlist；若 agent 已有实现 commits，新 BASE 与当前 agent HEAD 分叉，`:100,361` 的 ancestry gate必红，正确实施无法继续；若直接丢弃 agent WIP则造成数据损失。
证据：扩表条款没有要求 agent 先把当前允许路径冻结为 commit，也没有规定 main 以该 HEAD 为祖先构造新 BASE；阶段 2 只允许 ff-only。
修复建议：agent 停止前报告并提交当前 allowlist 内工作；main 双跑 interim path gate，先把该 HEAD 纳入协调分支，再提交扩展 allowlist，使 `old agent HEAD` 是 `new BASE` 祖先；有未提交且不可提交 WIP 时停止并显式交接，不得重置。

## 三 packet 走查结论

- **allowlist 生成／冻结：** `KICKOFF.md:104` 已明确 main 逐文件生成、与 reviews 一并提交进 BASE 并冻结 hash；packet 0／2 exact-report 与 packet 1 subset-report 的策略正确。
- **阶段 1／2：** 三组 bootstrap 与 `SendMessage` literal 注入未回归；错误 tree／branch／base／初始 WIP 会被首 gate 拒绝，正确 fresh-origin 可 ff-only 到 BASE。
- **完成路径集：** 算法覆盖 committed＋WIP 和 rename/copy 两端；给定正确 cwd 时，唯一 report 正样本通过，extra WIP／commit／rename 反样本转红。当前 blocker 是它未把 Git 查询绑定到 `WORKTREE`。
- **packet 0／2 与 packet 1：** 给定正确 cwd，exact-report 和合法 subset 均可通过，越权路径会红；但 main 回收必须先修 cwd 绑定，扩表续跑必须先修新 BASE lineage。

## 结构怪味扫描

- `KICKOFF.md:240-803` — **路径参数与 Git ambient cwd 双源**；处置：blocker，所有 Git 查询绑定 `root`。
- `KICKOFF.md:104,562` — **allowlist 扩表与 commit lineage 接缝缺失**；处置：major，冻结中间 HEAD 后构造 descendant BASE。
- 其余窄复核范围未发现新的 blocker／major。
