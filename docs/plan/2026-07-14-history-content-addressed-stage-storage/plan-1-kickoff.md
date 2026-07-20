# Kick-off Prompt — Phase-1 content-addressed stage 载体 执行

复制本文件全文作为新会话首条消息即可开跑。你是执行者(orchestrator),用 `superpowers:subagent-driven-development` 逐 task 执行,主会话当编排者、逐 task 派 fresh implementer + task reviewer。

## 你要做什么

在**已就绪的隔离 worktree** 里执行一份已定稿、已两轮对抗审查的 20-task TDD 计划,把 history 的 stage 存储从「累积完整 entry → finalize 全删重压」重构为 content-addressed(内容寻址、一生只压一次、增量写)。

## 环境(已就绪,勿重建)

- **worktree**: `/home/xp/src/copilot-api-js/.worktrees/history-cas-stage`(分支 `feat/history-cas-stage`,基于 master `62dcb2ac`)。**所有工作在此 worktree 内进行**,别在主树 `/home/xp/src/copilot-api-js` 改代码。
- **依赖已装**(`bun install` 已跑,1194 packages),基线测试绿(`bun test tests/history/sqlite/serialize.unit.test.ts` = 9 pass)。
- **计划(权威 spec)**: `docs/plan/2026-07-14-history-content-addressed-stage-storage/plan-1-carrier.md`(1838 行,20 task / 16 commit,Phase 0-4)。
- **上游 RFC(背景)**: `docs/rfc/2026-07-14-history-content-addressed-stage-storage.md`(§0 有两轮对抗审查并入记录,读它理解「为什么」)。
- **你的进度 ledger**: `.worktrees/history-cas-stage/.superpowers/sdd/progress-history-cas-stage.md`(**独立文件名**,别碰同目录 tracked 的 `progress.md`——那是 peer 会话 `upstream-error-client-shaping` 的 ledger,误提交进仓库,恢复原样勿覆盖)。每 task review 清后追加一行。

## 关键 setup 注意

- **task-brief 脚本不兼容本 plan 格式**:skill 的 `scripts/task-brief` 认 `### Task N` 标题,而本 plan 用 `### P0-T1` / `### P1-T2` 等。**须手动从 plan 提取每个 task 的全文**(Files/Interfaces/Steps 真实代码)写进 brief 文件交 implementer,别让 implementer 读整个 plan。
- **task 顺序**: Phase 0(P0-T1,P0-T2)→ Phase 1(P1-T1..T5)→ Phase 2(P2-T1..T5)→ Phase 3(P3-T1..T5)→ Phase 4(P4-T1..T3)。plan §6 Cutover 表 C0-C5 有逐 commit 终态不变量,严格按序。

## 承重约束(每个 task 的 reviewer 都要带上)

- **BLOCK-1**: 新 schema(`stage_blob` 表 / `entry_stages.hash` 列 / 索引 / `entry_stages_resolved` VIEW)**进 floor**(`schema.ts` 的 `SCHEMA_SQL` + 新 `migrateEntryStagesColumns`,被 `connection.ts` 无条件调),Umzug migration 001 仅作存量库 catch-up。**理由**:`openInMemoryDatabase` 不跑 `applyForwardMigrations`,16 个既有 history 测试走它——schema 只在 001 里则这些测试对新 schema 覆盖是假的。P1-T2 有 floor-alone 回归测试钉死此不变量。
- **BLOCK-2**: pre-check-before-compress 与 orphan GC 的 TOCTOU——`insertCompletedEntry` 同步 tx 内对 pre-check 命中的 hash **二次 `SELECT` 复核**,GC 抢先清走则退回**同步** `compressBytes`(不是 async 孪生,已在 tx 回调内不能 await)现算现插,防悬空引用。P3-T2 有受控时序回归测试。
- **无损载体**: stage_blob 用**无损稳定键序 JSON(仅递归键排序、不剥任何字段)** + **全宽 256-bit sha256**;绝不复用 `msg_blob` 的有损 canonical(那剥 cache_control、是搜索身份)。byte-equivalence golden 用**冻结内联快照**(`toMatchInlineSnapshot`/写死 JSON)非「再读同一行」的恒真式。
- **BLOCK-A 负样本回归**: `cache_control-shifted twin entries reconstruct losslessly`(P2-T5)——两个只差 cache_control 位置的 twin entry 必须 hash 不同、各自还原原位、绝不 dedup。这是数据丢失红线守卫,必须保留且真能证伪。
- **orphan GC 每站点**: deleteSession / deleteEntries / clearAllEntries / **reaper**(reaper.ts,不在 write.ts)四站点全 hook;`clearAllEntries` 补裸 `DELETE FROM stage_blob`。
- **backfill**(P4)仿 `search-index-backfill.ts` 骨架:history_meta version 守卫 + (started_at,id) keyset 续跑 + cooperative-stop(循环内触发,别在 run 前——入口会 reset stopRequested=false)+ 非阻塞分批 + never-throw + dedup-ratio tripwire + scan 谓词排除 in-flight 行(`status NOT IN active`)。backfill 与实时写**共享 `deriveStageRefs` 单一原语**(hash 一致,别搞两套推导)。
- **工程纪律**: Bun-first(`bun test` 唯一 CI 后端);TDD 先写失败测试;细粒度 conventional commits + **显式 pathspec**(`git commit -- <精确路径>`);**绝不 kill 4141 端口用户主服务器**(测试用 `useIsolatedRuntime` DI 临时库,别碰真实 `~/.local/share/copilot-api/history.db`);typecheck 用 `bun run typecheck`。

## open question(未定,交用户 — 不阻塞执行)

decision #9 hash 域前缀:plan 选了 `sha256(domainPrefix + canonical)`(前缀 `stagev1:` 混入 hash 输入、存 `zstd(canonical)` 不含前缀)。两种读法均技术自洽、后果良性(前缀只做 hash namespace 隔离、读侧从不重建 hash 故 byte-equivalence 不受影响)。**按 plan 现选(带前缀版)实现即可**,用户若要改会另行告知。

## 执行纪律(subagent-driven-development skill)

- 每 task:手动提取 brief → 派 fresh implementer(gpt-souls:implementer,明确 model)→ implementer TDD 红/绿/commit/自审 → `scripts/review-package BASE HEAD`(BASE=派 implementer 前记录的 commit,非 HEAD~1)→ 派 task reviewer(spec 合规 + 代码质量两个 verdict)→ Critical/Important 派 fix subagent → 清了追加 ledger 一行。
- **连续执行**,别 task 间问用户「要继续吗」。只有 BLOCKED 无法解决 / 真歧义 / 全完成才停。
- reviewer prompt 别预判/别说「不要 flag X」/别粘会话历史,带 brief+report+review-package 三个文件路径 + 承重约束 verbatim。
- 全 20 task 完成 → 派终局 whole-branch review(最强 model)→ `superpowers:finishing-a-development-branch`。

## 收尾(全 task + 终局 review 清后)

1. merge 回 master 前先 `git merge master`(分支可能落后 peer 并发提交)。
2. `superpowers:session-closeout`:doc-sync(DESIGN.md「活的架构现状」history 行 + 「类型架构」若动)+ 跨文档 grep 验证。
3. 记忆库维护(`docs/memory/`):把执行中的承重教训提炼进 skill / stub。
4. **阶段 2**(per-entry coalescing writer 队列)是独立后续:RFC §6 已有协议级设计,阶段 1 landed + 实测(事件循环 max-gap 对比、双重压缩 CPU 节省、去重率)后另起 brainstorm + spec。

先读 plan 全文 + RFC §0,建 20 个 todo,然后从 P0-T1 开始。
