# 事实证伪复评 R3

- **评审范围：** 主树工作区 `HANDOVER.md`／`KICKOFF.md`，SHA256 分别为 `d7093f0afcc622b5fe05bcad7a13425b664fe2a80c99c0f4deea73cb952606e6`、`dabf1d1ef0a78de6a8dd18b5f1a3f9569b5d320f7ace2d7f818d132b57ab15ad`；未重扫 history。
- **总体 verdict：** 修复 major 后可定稿。
- **计数：** 0 blocker / 2 major。
- **双视角覆盖证据：** 机械核对 R2 三项、当前 Agent schema 声称、三个 packet 的 tree／branch／HEAD／ancestry／WIP／path gate，并走查“复制 packet→用 `isolation:"worktree"` 派发→首条 Bash gate”及 B.4→B.2/B.5.1→B.5.2→B.5.3；同时尝试错误状态假绿与正确状态假红。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:119-121,130-168,187-222,241-276` — 三份 packet 要求派发前填入 Agent tool 返回的 `WORKTREE`／branch，却只有 `isolation:"worktree"`、没有 `cwd`；隔离树在 dispatch 后才产生，构造同一次 dispatch prompt 时拿不到其返回路径。
证据：当前 runtime 的既有 Agent 调用只接受 `isolation:"worktree"`；`rg -n 'WORKTREE=' KICKOFF.md` 仅命中 packet 的 prose，三个首条 Bash gate 均无赋值／`export`，却以 `: "${WORKTREE:?}" ...` 读取 shell 环境。正确隔离 agent 照抄 gate 会在首行 false-red；手工以运行后 `pwd` 回填则已不是“派发前实例化／首条 gate”。
修复建议：dispatch 前只冻结可知的 source full SHA；agent 首条调用从 `pwd -P`／`git rev-parse --show-toplevel` 取得 tool-bound tree 与 generated branch，再对 source SHA ancestry、clean WIP 和允许路径做 gate。不得要求 coordinator 预知 tool-returned path，也不要把 prompt prose 当 shell env。

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:30-38` — R2 的敏感 argv verifier 仍未关闭：脚本对完整原始 `/proc/$pid/cmdline` 输出稳定、无盐 SHA-256。
证据：`:36-38` 在任何 redaction 前 hash `raw`；若 argv 含 `--token 1234` 等低熵 secret，观察者可枚举候选并逐个重算整条 argv hash。`:42-82` 随后的形状脱敏不撤回已经发布的 verifier；env 值已改为 presence-only，但 argv 仍 OPEN。
修复建议：删除 `argv_sha256`；只输出 allowlist 后的 executable／script／安全 flag 及其余位置的 `<redacted>` shape。若必须比较两次 argv，只在同一进程内比较原始 bytes 并输出一次性 `same/different`，不落可复用 digest。

## R2 三项 disposition

1. **CLOSED — review commit 状态。** `HANDOVER.md:25` 现在精确列出 `0840b929` 的 8 个文件，并诚实标记首轮／R2 reports 为待提交 WIP；没有预言最终 hash。
2. **CLOSED — B 段顺序。** `HANDOVER.md:83-87,97-123` 与 `KICKOFF.md:4,115` 一致：先 B.4 身份／WIP gate，B.2 evidence 与 B.5.2 A4 并行，自然样本缺失不阻断 A4，只阻断 B.5.3 Phase B 因果裁决。
3. **OPEN — 敏感 env／argv。** env 已不输出 digest（`KICKOFF.md:98-110`），但 raw argv digest 仍是低熵逐值 verifier，见本轮 major。

## 范围完整性

- **A 段完整。** `HANDOVER.md:27-70` 保留 A0–A3 已落面、A1 002／真实库验收／A3 六 major 与 review/CI 未闭合边界，未把偏线成果冒充 CANCEL 修复。
- **B 段完整。** `HANDOVER.md:72-123` 保留 CANCEL 未修、历史窗口与新鲜样本边界、旧样本降级、未决线索、A4 canonical 缺口及 A4→预注册→Phase B 顺序；未发现新增 blocker/major。
