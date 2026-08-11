# 事实证伪复评 R6

- **评审范围：** 主树候选 `HANDOVER.md@d7093f0afcc622b5fe05bcad7a13425b664fe2a80c99c0f4deea73cb952606e6`、`KICKOFF.md@2c2b79e7fafd0e30264929f472648247775657c7385c0067fc8692759a9f4bc7`；仅复核 R5 三项与扩表接缝。
- **总体 verdict：** 修复 major 后可定稿。
- **计数：** 0 blocker / 1 major。
- **双视角覆盖：** 核对 10 Bash／17 Python 语法与扩展 PoC 六臂；另主动以仓库既有 merge `2d4f400d` 对比 all-parent 与 first-parent diff，检查合法 merge 的 false-red。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:308-315,568-575,844-851` — 逐 commit union 对 merge 使用 `diff-tree -m` 比较所有 parents，会把第一父 BASE 早已存在、仅相对第二父不同的路径误算成 agent 触碰。
证据：`git diff-tree -r -m --name-only 2d4f400d` 同时列 History 与 `docs/DESIGN.md` 等 7 个 docs；但 `git diff-tree -r --name-only 2d4f400d^1 2d4f400d` 只列 History。若 BASE 是第一父且合法 merge 只引入 allowlisted History，当前 gate 仍因那些既有 docs false-red。
修复建议：每个非 root commit 只审 `commit^1 → commit`，侧支 commits 已由 `rev-list BASE..HEAD` 各自审计；这样仍抓 merge conflict resolution、commit-revert 与 rename/copy 两端，而不把第一父既有内容归给本次 merge。

## R5 disposition

1. **CLOSED — argv。** `KICKOFF.md:40-49` 对 argv[1:] 仅输出固定 long-option／short-option／positional shape，不输出原 token、值、路径、digest 或长度；PID、cwd、exe 与 History 指纹仍承担身份核验。
2. **CLOSED — root/cwd/top-level。** 三份 PYFINAL 在 `:247-263`／`:507-523`／`:783-799` 绑定 cwd 与 top-level，并让全部 Git subprocess 以 `cwd=root` 执行；扩展 PoC 的错误 ambient cwd 为红。
3. **OPEN — committed history union。** BASE ancestor、逐 commit、revert、net cross-check、WIP 与 rename/copy 已闭合；但合法 merge 的 all-parent false-red 尚未闭合，见本轮 major。
4. **CLOSED — allowlist maintenance。** `KICKOFF.md:97-104` 要求 interim 先独立验旧 allowlist、WIP clean 后 main 冻结 bytes、唯一 parent／仅 carrier／blob hash／clean 四门、NEW_BASE 保持 descendant，并以同一 agent `SendMessage` 续跑；不可提交 WIP 明确保留、不 reset/restore。
5. **PoC 边界：** 合法 subset、错误 cwd、非祖先、commit 后 revert 与 maintenance 四门结果支持相应 gate；未覆盖本轮合法 merge 反例。
