# NGHTTP2_CANCEL 交接件接手方复评 R3

- **评审范围：** 以新会话接手者第一人称，只读复核主树 `HANDOVER.md`／`KICKOFF.md`；未重做四会话考古。
- **绑定证据：** `sha256sum` 得 HANDOVER `d7093f0afcc622b5fe05bcad7a13425b664fe2a80c99c0f4deea73cb952606e6`、KICKOFF `dabf1d1ef0a78de6a8dd18b5f1a3f9569b5d320f7ace2d7f818d132b57ab15ad`，与派发件一致。按当前 Agent schema 只有 `isolation:"worktree"`、没有 `cwd` 的约束，逐字模拟三个 packet 的首次派发、首条 gate、报告回收与正确／错误样本。
- **总体 verdict：** 存在 blocker；修复后需复评。
- **blocker 数量：** 1。**major 数量：** 0。

## R2 四条 major 逐项处置

1. **CLOSED — argv／env 脱敏。** `KICKOFF.md:30-111` 只输出 argv 整体 SHA、allowlist identity、option 名和 `<redacted>`；敏感环境值既不打印也不逐值 digest。错误状态中的 `--token=x`、proxy URL positional 均走 `:72-81` redaction；正确的 executable／script／port 仍可见，未造成 false-red。
2. **OPEN／升级 blocker — 三个 packet 的 isolation/tree gate。** `KICKOFF.md:119-121` 要求派发前填写 tool-returned `WORKTREE`／generated branch，但 `isolation:"worktree"` 是 Agent 调用处理 prompt 时才创建树；当前无 `cwd`，调用方无法在构造同一次 prompt 前知道结果。三个首条 gate还直接引用未在 bash block 内赋值／export 的 `WORKTREE`、`EXPECTED_BRANCH`、`BASE_FULL_SHA` 等（`:138,195,249`），正确树也会在 `${WORKTREE:?}` 处立即退出。
3. **CLOSED（内容层）— Phase B 唯一轮次定位。** `HANDOVER.md:121-123` 固定 `<ROUND_ID>/{preregistration.md,data-manifest.json,results.md}`；`KICKOFF.md:277-289` 要求 ROUND_ID、路径、prereg hash、DATA_ROOT、manifest digest 与时间顺序全部实例化，错误轮次／hash／数据根会拒绝 verdict，正确轮次可通过。其执行仍受第 2 条 blocker 影响。
4. **CLOSED — 自然样本只阻断 Phase B。** `HANDOVER.md:83-87,107-109` 与 evidence packet `KICKOFF.md:125-180` 明确 `none observed` 也完成、evidence 与 A4 并行；A4 可直接依靠 h2c 双控推进。正确的“无自然样本”不再 false-red，旧样本也不能 false-green 成因果证据。

## 事实性发现

[blocker] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:119-121,130-168,187-222,241-276` — 三个“可复制 packet”在当前仅有 `isolation:"worktree"` 的 Agent schema 下无法完成首次正确派发。
接手者会因此要么在派发前猜 `WORKTREE`／generated branch，要么照抄后让正确隔离树在 `${WORKTREE:?}` 立即失败；若改成 agent 自取值，又会让错误树自证为正确树，恢复 false-green。
证据：worktree 由 Agent 调用与 prompt 同时创建，prompt 无法引用调用后的返回值；三个 bash block均无变量赋值，却以 `: "${WORKTREE:?}" ...` 开始。最后一行的“main 核证／提交”也到不了报告产出阶段。
修复建议：改成同一 agent 两步握手。首次用 `isolation:"worktree"` 派只读 bootstrap，让 agent 打印实际 `pwd/top-level/branch/HEAD/status` 后立即返回；main 对照 Agent 登记路径与预期 base 核证，再用 `SendMessage` 恢复同一 agent，传入冻结 literal，并在每个 bash block开头显式赋值／export；随后才允许写报告／实现。错误路径或 branch 必须红，正确隔离树必须绿。

## 三份 packet 双向结果

- **错误树／错误轮次：** frozen tree/branch/HEAD/hash 设计本可拒绝，但当前前置值不可获得；若由 agent 自我派生则错误树会 false-green。Phase B 的 ROUND_ID/hash/manifest gate 本身能拒绝错误轮次。
- **正确隔离树／无自然样本：** evidence、A4、Phase B 三个 packet都会先因未定义 shell 变量失败；其中无自然样本的业务 gate已正确，不阻断 A4。
- **报告闭环：** `KICKOFF.md:292` 的“隔离树落报告→main 核证／提交”目标正确，但当前 dispatch blocker 使三份报告均无法按文档到达；两步握手后应要求 agent 回报冻结 worktree绝对路径和 report hash，main再按该路径核证并精确提交。

## 结构怪味扫描

- `KICKOFF.md:119-121` — **事后生成值被要求事前注入／dispatch 时序倒置**；处置：本轮 blocker，改同一 agent bootstrap→main 核证→`SendMessage` 续跑。
- `KICKOFF.md:136-168,193-222,247-276` — **prompt 元数据未落成 shell 变量**；处置：与 blocker 同修，在续跑命令内显式赋值冻结 literal。
- 其余 R2 范围未发现新的 blocker／major；argv/env、Phase B 轮次和无自然样本三条均兼顾 false-green 与 false-red。
