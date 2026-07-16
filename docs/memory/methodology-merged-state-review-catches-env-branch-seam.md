---
name: methodology-merged-state-review-catches-env-branch-seam
description: 并发分片实现的特性，「每片单测绿 + 全量套件零新增失败」都证不了环境/路径分支的集成缝——合并态对抗审查 + 三环境第一人称走查才逮得到
metadata:
  type: feedback
---

并发多 agent 分片实现一个跨「环境/路径分支」的特性时，**per-task 单测全绿 + 我亲手跑的全量套件 ground-truth 零新增失败，都证不了「某条路径分支的集成缝」**。这类缺陷只有**合并态对抗审查 + 对每条路径做第一人称走查**才逮得到。

**Why:** 优雅重启并发 3 wave/~10 agent 落地，每个 task TDD 自守、我又亲手跑全量 `test:backend`（5140 pass / 6 fail 全基线、零新增）——全绿。但合并态 Claude reviewer（GPT 实现→Claude 审的异模型）逐条走 systemd/pm2/bare-metal **三条路径**，逮到 MAJOR：reclaim/VACUUM 的 overlap 数据保护 gate 在一个**只由 bare-metal takeover 分支填充的 registry**，supervised（systemd/pm2）路径走 `{kind:"skip"}` 从不填充 → 完全裸奔（脏写 + SQLITE_BUSY 丢记录）。per-task 单测喂了 `setExcludedPredecessor(...)` 后验行为，恰好**掩盖了「supervised 下 registry 从不被填充」这一集成事实**；全量套件也测不到（没有起两个 supervised 实例并发的用例）。根因=把「数据完整性保护」错误耦合进「pidfile-guard 跳过」分支。

**How to apply:** ① 特性含**环境/模式分支**（supervised vs bare-metal、prod vs test、A/B 后端）时，合并态审查 prompt 必须**点名让 reviewer 对每条分支做第一人称走查**（照 deploy 脚本/文档逐行走一遍，别只读 diff）；② 警惕「保护逻辑 gate 在一个只有部分路径填充的状态」——数据完整性/安全不变量应由**环境无关的判据**（如进程存活性 `isProcessAlive`）自身强制，别依赖某条路径记得填的外部名单（根因修=退役脆的 registry、改存活性裁决，三路径天然统一）；③ 单测「喂了 X 后验行为」证不了「生产会不会喂 X」——补一条**不喂 X 直接走集成入口**的测试逼出缺口（reviewer 建议的「supervised env 下 resolveManualStartup 返 skip 时 reclaim 仍不误刷 live 前任行」正是此意）；④ 与 [[methodology-cross-phase-integration-seam-only-caught-at-merged-state]]、[[methodology-full-primitive-not-partial-else-silent-field-drop]] 同族（合并态才现的缝）。**Related:** review 后置策略（实现期并发狂奔 + 合并态一次性对抗审查）用对了，但审查 prompt 要显式覆盖所有路径分支。
