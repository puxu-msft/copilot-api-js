# NGHTTP2_CANCEL 接手提示词

> **状态：草稿·未评审**

你是新会话主会话，拥有编排权并负责调度 agents；agents 是叶子执行单元。先读 `/home/xp/.claude/jobs/2684f077/tmp/NGHTTP2-HANDOVER.md` 的状态头、系列会话坐标、Agent dispatch packet、A.2／A.3 与 B.3～B.5；再读 `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-history-read-path-and-h2-diagnostics.md` 的实施状态、A4、Phase B。按需读取 HANDOVER 的 Supporting evidence 与 `/home/xp/src/copilot-api-js/docs/{DESIGN.md,history.md,API.md}`，不要重新考古四个会话或重做已落 A1–A3 核账。

硬 gate：绝不停止、重启或 kill 4141；测试实例只能用非 4141 端口，并只按 PID 清理自己启动的进程。先验证运行进程代码身份，不能用配置文件、branch tip 或 `is-active` 代替 PID／进程持有配置／commit 或 build 指纹。先刷新 `master`、worktree、ancestry 与 WIP 归属，不碰 peer 改动。A4 canonical diagnostics 未按 explicit dispatch 区分 stream／session／local-abort 并落最终 History 前，不进入 Phase B，不调 PING cadence，不加 generic `NGHTTP2_CANCEL` retry。真实迁移、主库写入、备份覆盖和维护窗口未经用户逐项授权不得执行。关键 gate 必须有正确样本和目标缺陷 mutation。

第一步运行并记录：

```bash
git -C /home/xp/src/copilot-api-js rev-parse refs/heads/master
git -C /home/xp/src/copilot-api-js show -s --format='%H %cI %s' refs/heads/master
git -C /home/xp/src/copilot-api-js status --short
git -C /home/xp/src/copilot-api-js worktree list --porcelain
git -C /home/xp/src/copilot-api-js log --oneline fa2bfd2d902af444517b2fed1a44428c8bb47367..refs/heads/master
ss -ltnp 'sport = :4141'
```

当前成稿基线是 `master=17a7f612ba2cfda5c4c212555643b8626eb101d0`；Supporting evidence 的 A3 review 与运行现场锚定 `fa2bfd2d902af444517b2fed1a44428c8bb47367`，所以先核 `fa2bfd2d..17a7f612` 是否改变 HANDOVER 的 A3／A4 命题。若没有，按 HANDOVER B.4 从 A4 开工；A3 的 6 major 与文档／skill／todo gate 作为独立尾项关闭，不混写成 CANCEL transport 进展。

分派 agents 时，必须逐项提供 HANDOVER“Agent dispatch packet”要求的任务边界、session IDs、transcript／job／tasks 路径、repo／worktree、base／target full SHA、必读报告、已有结论与禁止重查范围、允许写路径、验收输出；缺失项明确写 `TBD`，不要让 agent 自猜。所有报告先落指定文件，再由主会话核对与处置。
