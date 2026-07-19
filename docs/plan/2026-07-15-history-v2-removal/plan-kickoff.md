# Kick-off Prompt —— History V2 层移除执行

复制以下内容开启新会话（或派给 subagent-driven 执行）执行本计划。

---

你要在 worktree `/home/xp/src/copilot-api-js/.worktrees/v2-removal`（分支 `feat/history-v2-removal`，off `master` @ `5187c386`）执行一次大型 DESTRUCTIVE 重构：移除 copilot-api-js 的 History V2 SQLite 层（`entries_v2`/`entry_stages` 及其全部读写代码），使 History V3（`history-v3.db`，内容寻址存储）成为唯一持久化实现，并把三项用户裁决保留的基础设施（persist-guard 写守卫、DB-health 三件套、Umzug 迁移框架骨架）真正接入 V3——**这三项是本次必做项，不是可选 backlog**。

## 必读

1. `docs/plan/2026-07-15-history-v2-removal/plan.md`（本计划全文——Goal/Architecture-after/Global Constraints/分阶段计划/Cutover 表/采纳子计划/排除暂缓项，全部已写明具体 file:line）。
2. `docs/todo/v2-removal-scope.md`（原始 blast-radius 调研 + 用户裁决记录，plan.md 的依据）。
3. skill `history-sqlite-schema`（`.claude/skills/history-sqlite-schema/SKILL.md`）——V3 当前 schema/写路径/reaper 双源的权威描述。

## 工作方式

- **TDD**：每个新行为（尤其 Phase 4b/4c/4d 的三项采纳）先写失败测试，再实现，再转绿。plan.md §5 已给出每项采纳所需的新测试文件名与断言要点。
- **严格按 plan.md 的 phase 顺序执行，不可跳跃或合并**（Phase 1 必须在任何 V2 代码删除之前完成——它是把测试地基从 `attachHistorySink` 迁走的最高风险环节）。
- **每个 phase 结束单独提交**（conventional commits，无模型署名，显式 pathspec）。每次提交前跑 `bun run typecheck` + `bun run test:backend`（Phase 4d 额外跑 `bun run lint:all`——`src/` 下 `@typescript-eslint/no-floating-promises` 是 **error 级别**，`initHistory` 改 async 后 `src/` 里遗漏 `await` 会让 lint 直接失败退出，必须清零；但 `tests/**` 关闭了该规则，遗漏 `await` 不会被 lint/typecheck 拦截、只会造成运行时时序 flaky，需要对 `tests/` 下每个 `initHistory(` 调用点人工逐一核实补了 `await`，不能依赖 CI 兜底）。
- **不得半坏中间态落盘**——如果某个 phase 内工作量过大需要拆分（plan.md 已预留 Phase 1a/1b、Phase 4a/4b/4c/4d 的拆分空间），拆分后的每个子步骤自身也必须绿。
- Phase 1 的 A/B/C 类测试文件分类，plan.md §7 已说明：这是"计划到实现"必然存在的最后一层颗粒度，需要你逐文件逐用例按判据（断言 History 行为契约 vs 断言 V2 内部结构/序列化格式）机械判断，不是待用户裁决的开放问题。
- 遇到**真正的门控问题**（plan.md 里没写清楚、执行中发现的架构矛盾、需要改变已定范围）才停下来问；顺序执行、doc-sync、提交这些不算岔路，直接做。
- 若发现 Phase 3 深入 `entries.ts` 后发现某些函数（如 `finalizeEntry`/`persistEntry*`）在生产确认无调用者、需要连带删除而非精简保留，这属于 plan.md 已预判并说明的"Phase 1 初步分类需要 Phase 3 精确修正"的正常情形，按 plan.md §3 Phase 3 的说明处理即可，无需额外请示。
- **`no-destructive-workspace-loss`**：本次是大删除，但都在 `feat/history-v2-removal` 分支上，git 历史可恢复；仍需遵守细粒度提交纪律，方便审查与必要时的部分回退。
- 遇到 `docs/todo/deferred-backlog.md` 尚不存在或需要新增条目（D-2 in-flight 可见性、可能的 `history.archive.*` config 键清理）时按 plan.md §6 的格式补充。

## 收尾

完成 Phase 5 后：
1. 派 subagent 做一次合并态对抗 review（裁判轴：长远正确 + 完整，尤其核实三项采纳是否真的生效而非"文件存在但未接线"）。
2. doc-sync 校验：跨文档 grep `entries_v2|history/sqlite/read|history/sqlite/write|insertCompletedEntry|attachHistorySink` 确认无残留引用（归档文档除外）。
3. 归档本 plan（若项目约定要求）+ 提炼教训写入 memory。
