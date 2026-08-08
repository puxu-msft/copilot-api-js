# 事实证伪复评 R4

- **评审范围：** 主树候选 `HANDOVER.md@d7093f0afcc622b5fe05bcad7a13425b664fe2a80c99c0f4deea73cb952606e6`、`KICKOFF.md@ead3146110e1f97302d5f8daa56ac4564e25e67d05da007c4f803eadc10e6bbd`；只复核 R3 两项及其修订接缝。
- **总体 verdict：** 修复 major 后可定稿。
- **计数：** 0 blocker / 2 major。
- **双视角覆盖：** 机械扫描 fetch/push、marker、7 个 shell block，并以替换后 `bash -n` 逐块验证 7/7 通过；第一人称走查 bootstrap→主会话核证→同 agent `SendMessage`→ff-only→实施／report→最终核证，双向注入错误 tree／branch／base／WIP／path 与正确 local-unpushed BASE。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:40-47,62-66` — argv 脱敏仍可把任意 path-shaped option value 当“script”明文输出，`--port` 的 value 也未验证为端口。
证据／失败场景：`script_index` 取 argv[1:] 第一个“不以 - 开头且像路径”的值，不解析它是否是前一未知 option 的参数；`bun --token /secret/value ./main.ts` 会在 :47 打印 `/secret/value`。`--port secret` 也会在 :65 明文打印。raw digest 已删除，但 R3 的“不输出敏感 argv value”仍可 false-green。
修复建议：只在已知 CLI 语法位置识别 script，或所有非 argv[0] 值一律 redacted；`--port` 仅在严格全数字且 1–65535 时输出，否则 redacted。运行身份仍由 `/proc/$pid/{cwd,exe}`、listener PID、History gitSha/dirty 核验。

[major] `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md:124-126,199-203,275-279,367-371` — 两阶段起点 gate 完整，但阶段 2 完成时没有最终 WIP／允许路径机械 gate，错误写入可假绿。
证据／失败场景：packet 0/verifier 只复核 HEAD 与 report SHA；agent 同时修改任意禁写文件但不 commit，HEAD 仍等于 BASE，现有完成门全过。Implementer 也可提交／遗留 plan A4/A5 范围外路径；主会话被要求独立复核“这些值”，未要求枚举最终 diff/status 对允许集合。
修复建议：完成时输出并由主会话独立复核 `BASE..HEAD` committed paths 加 porcelain WIP paths；packet 0/2 集合必须精确等于或包含唯一 report，packet 1 必须逐路径属于冻结 allowlist，rename/copy 两端都检查；出现额外路径即红。

## R3 disposition 与其余窄核结论

1. **OPEN — argv/env。** raw argv digest 与敏感 env digest 已删除，env credential-like 项仅 presence；但 argv path heuristic／未校验 `--port` 仍会泄露 value，见 major。
2. **CLOSED — post-dispatch handshake。** `KICKOFF.md:119-126` 已改为 Agent `isolation:"worktree"` bootstrap、主会话独立核登记 path／branch／status／ancestry、同 agent `SendMessage`、显式 shell-word exports，再 ff-only 到本地未推送 BASE；错误 tree／branch／HEAD／起始 WIP 均红，正确 ancestor BASE 可绿。
3. **ff-only／baseRef／shell literal：未发现 blocker/major。** `BOOTSTRAP_HEAD` 必须为 BASE 祖先，阶段 2 禁 fetch/push；正文和 shell marker 明令发送前替换。扫描无 `git fetch/push` 命令，7 个 shell block marker 替换后 `bash -n` 均 rc=0。
4. **marker／正文路径：未发现 blocker/major。** 两阶段避免预知 worktree；`__MAIN_SHELL_LITERAL_*__` 与 `__MAIN_TEXT_ABSOLUTE_*__` 的替换／单引号编码规则可执行，且明确禁止原样发送 marker、`<TBD>`、正文 `$WORKTREE` 与命令替换。
