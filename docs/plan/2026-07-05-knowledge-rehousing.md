# 知识重新归位工程 — 计划 + 实施状态 + 交接

> **实施状态（2026-07-05）：全部完成（Phase 0/A/B1/B2/C/D/E）。**
> - **Phase C**（记忆库降引用层）✅：25 活记忆全部处置（16 stub 指 skill/ADR + 精炼保留 + pass-null 合并 verification 簇 + v4/ghc project stub），删 15，归档 2，反链零悬挂；`docs/memory/MEMORY.md` 重写为「话题→归属」引用地图（25 文件全索引、链接全解析）。
> - **Phase D**（CLAUDE.md 重构）✅：照 `CLAUDE.ref.2.md` 风格六节重构，删 user-level 逐字重复、内联战例下沉链接、保留项目增量（13.8KB→12KB，增量密度高未强压 5-6KB 以免损失 always-on 项目指令）。
> - **Phase E**（核验 + 合并）✅：3 个 subagent 逐句 diff 核「skill 迁入 ⊇ 原记忆正文」——12 条零遗漏，2 条实质补回（large-refactor §6 第二种 index 污染形态 + setup-claude-code CLI config-respect 意图归位 deferred-backlog）；doc-sync 跨文档 grep 修 15 deleted slug 的悬挂 `[[]]` 反链（self-consistent→pass-null 机械 repoint 8 处 + homeless slug 去链 5 处），全仓 `[[]]` 零悬挂（正样本自证）。
> - 提交至 `chore/knowledge-rehousing` 分支，待 `git merge --no-ff` 回 master。
> **工作位置**：worktree `.worktrees/knowledge-rehousing`，分支 `chore/knowledge-rehousing`。

## Context（为什么做）

user-level instructions 更新后，项目 `CLAUDE.md` 与记忆库大量与全局规则逐字重复。用户四轮澄清确立两个目标：
1. **CLAUDE.md 参照姊妹项目范本 `CLAUDE.ref.2.md`（ghc2api-go）全面重构**：每条原则一句话 + `→ [归属]` 链接，删 user-level 逐字重复，内联战例下沉。13.8KB→~5-6KB。**ref.2 是风格范本非路径范本**（本项目实际是 `docs/DESIGN.md`/`docs/decisions/`/`docs/spec/`/`docs/plan/`，无 architecture/PROGRESS/ROADMAP）。
2. **记忆库降为纯引用层**：每条教训实质搬到正式归属（skill/docs/ADR/CLAUDE.md/archive），记忆只留引用。用户定的最终形态：**能一两句说清+有归属→删文件、MEMORY.md 留引用行；说不清（厚方法论）→实质搬 skill、记忆重写为引用 stub**。

## 已完成（5 commits，master..HEAD）

- `d96a607` track 两个曾未追踪的记忆文件（`project-ghc-feature-alignment-landed`、`reference-settle-freezes...`）——本应追踪、遗漏。
- `f93b5a5` **新建 2 项目 skill**：`persistence-async-invariants`（迁入 sync-to-async + record-signals + settle-freezes 三条全文）、`telemetry-architecture`（迁入 telemetry-registry 三支柱 + model-key-split 全文）。
- `c82fd93` **并入 5 已有 skill**：`history-sqlite-schema`←migration-framework+content-addressed；`large-refactor`←byte-equivalence(§7)+sed-touched；`empirical-verification`←multidim；`debugging-frontend-tests`←verify-ui-with-build；`test-isolation`←tests-never-touch（Bun os.homedir 陷阱）。
- `1e104c5` + `4db07ca` **DESIGN 加「类型架构」节**（承接 SSOT-types）+ 配置节加 config-key 纪律；**建 `docs/todo/deferred-backlog.md`**（承接 ghc memory_tool / context-edits telemetry / RFC 审计三条 pending）；**归档 2 条完成叙事**到 `docs/archive/memory/`（pre-response-abort、audit-rfcs）。

**关键：所有厚方法论的实质内容已完整迁入 skill/DESIGN/todo（"不丢实质"已保证）。剩余是记忆文件降级 + CLAUDE.md 重构，源实质都已有归属。**

## 剩余 Phase C — 记忆库降引用层（40 条活记忆 + MEMORY.md）

**处置清单（每条最终形态）**：

### 改 stub（保留 slug 不悬挂反链，正文=「已归入 skill X」+一句钩子）— 桶4+桶2，16 条
已迁 skill 的，改为 stub 指向归属：
- → skill `persistence-async-invariants`：`methodology-sync-to-async-persistence-refactor-invariants`、`methodology-record-signals-at-committed-outcome-not-per-attempt`、`reference-settle-freezes-history-entry-record-before-fail`
- → skill `telemetry-architecture`：`pattern-extensible-telemetry-registry`、`reference-telemetry-model-key-split-success-vs-failure`
- → skill `history-sqlite-schema`：`methodology-migration-framework-hybrid-forward-runner`、`methodology-content-addressed-normalization-boundary-strip`
- → skill `large-refactor`：`feedback-byte-equivalence-is-proxy-calibrate-by-consumer`、`sed-touched-files-bundle-inflight-work`
- → skill `empirical-verification`：`feedback-multidim-completeness-audit-before-claiming-done`
- → skill `debugging-frontend-tests`：`feedback-verify-ui-with-build-not-just-typecheck`
- → skill `test-isolation`：`feedback_tests_never_touch_real_env`
- → skill `history-backfill`：`methodology-recoverable-backfill-cooperative-stop-and-keyset`、`methodology-derived-column-backfill-targeted-and-nonblocking`（确认已在该 skill）
- → ADR `docs/decisions/2026-07-05-richest-data-flow.md`：`feedback-richest-data-flow-store-complete-no-pruning`、`feedback-synthetic-data-must-be-distinguishable-from-real`

（stub 正文里的 `[[]]` 只保留仍存在的 slug；指向被删 slug 的改文字或改指 `pass-null`。）

### 精炼保留（无好归属/错配/只读 skill 不覆盖）— 桶4b，5 条
重写为精炼记忆（去厚叙事、留核心 + 项目实例）：
- `feedback-fix-all-comparison-sites`（运行时归一化 grep 全仓，**非**类型系统，不并 typescript-advanced-types；互链 route-variant）
- `feedback-architecture-map-optimize-agent-context-economy`（无 skill 域）
- `methodology-route-variant-to-existing-outcome-and-exhaustive-record-audit`（typescript-advanced-types 是通用 vendored skill、不并入）
- `git-commit-pathspec-commits-worktree-not-index`（归属 user skill `git-preference` 只读且**不含**"pathspec 取工作区非 index"这层，保留精炼+指 skill）
- `tooling-lint-staged-revert-blocks-edit`（已是指针形态，保留极简）

### verification 簇合并 — 桶3
- **保留 `feedback-pass-null-clean-not-self-validating` slug 作合并记忆**（12 反链枢纽，删它会悬挂 12 处）：重写为「主体引用 user skill `verifying-authoritative-claims` + 三方项目实例」——pass-null 三陷阱（空≠负/通过≠健全/子域0≠全域0）、self-consistent（L2 escalation 缺 `context-management-2025-06-27` beta header 400、三兼容层互转）、verify-doc-vs-code（陈旧/未实现/缺陷三方向、`git log -S`、陈旧文档加注解移 archive）。
- **`methodology-broken-reference-supply-vs-delete` 单独保留完整 oracle 论证**（补vs删的裁决全过程是独有教学价值，不压钩子；其正文 `[[self-consistent]]`/`[[verify-doc-vs-code]]` 改指 `[[feedback-pass-null-clean-not-self-validating]]`）。
- **删** `feedback-self-consistent-needs-independent-oracle`、`feedback-verify-doc-vs-code-direction-before-acting`（实质并入 pass-null 合并记忆）。inbound 反链改指 pass-null：byte-equivalence stub、broken-reference、`methodology-derived-column-backfill`（line18）。

### 删文件 + MEMORY.md 引用 — 桶1 通用方法（user-rule 覆盖），11 条
`feedback-dont-stop-when-direction-clear`(→user60)、`feedback-act-comprehensively-commit-on-done`(→user60+session-closeout)、`feedback-knowledge-routing-docs-vs-memory`(→user70)、`feedback-main-thread-impl-subagent-verify`(→user40)、`feedback-subagents-full-tool-access`(→user40)、`feedback-present-cohesion-over-future-use-yagni-not-veto`(→user60)、`feedback-distill-lessons-at-boundaries`(→user70+session-closeout)、`feedback-completion-updates-docs`(→session-closeout)、`feedback-test-overlap-across-altitudes-is-allowed`(通用测试原则)、`feedback-experiments-in-repo-exp-dir`(→上提 CLAUDE.md 一句)、`feedback-git-staging-and-local-commit-default-allowed`(项目决策史一句+git-preference)。这 11 条互相反链、一起删自然消失；外部指向仅 project-v4→main-thread（v4 stub 重写时去掉）。

### 桶5 project 剩余，4 条
- `project-v4-pipeline-rearchitecture` → stub 指 `docs/DESIGN.md`「活的架构现状」+ `docs/archive/2606-landed-rfcs/response-pipeline/`；**消解陈旧首段矛盾**（第12行"本会话未写生产代码" vs 第19行"P0-P3已落地"——stub 只留"已落地、权威看 DESIGN"）。
- `project-ghc-feature-alignment-landed` → stub 指 skill `ghc-api-reference` + `docs/todo/deferred-backlog.md`（memory_tool pending 已在 backlog）。
- **删** `project-context-edits-receipt-telemetry-pending`（已进 todo backlog）、`project-new-config-key-must-document-in-bundled-config-yaml`（已进 DESIGN 配置节）。

### MEMORY.md 重写为「话题→归属」引用地图
一行一条，指向 skill/docs/ADR/user-rule；保留仍存在的 stub/精炼记忆条目。删除的 15 条不再有索引行（或合并到相关引用行）。

### Phase C 反链验证（G2）
`grep -rno '\[\[[a-z0-9_-]*\]\]' docs/memory/` 输出的每个 slug 必须仍存在（先用正样本证 grep 触达）。被删 15 slug（含 self-consistent/verify-doc-vs-code + 桶1 11 条 + context-edits/new-config）的 inbound 反链全部改文字或改指存活 slug。

## 剩余 Phase D — CLAUDE.md 照 ref.2 风格重构

小标题：文本风格偏好 / **文档路由（本项目实际布局**：`docs/DESIGN.md`/`docs/decisions/`(ADR)/`docs/spec/`/`docs/plan/`/`docs/memory/MEMORY.md`/`docs/archive/`）/ 工作哲学 / 工程纪律 / 工作流角色 / 经验教训。每条一句 + `→ [归属]`。**删除前逐条 diff user-level 确认纯重复**——保留项目增量（`think-proactively` 的"分基础/高级阶段"、`empirical-verification` 的"flaky 连跑10-25次/4141探针"、`dont-ignore-existing-errors`）。项目特有增量保留：internal-tool-security、no-auto-server、可恢复性判据、richest-data-flow 后端完整存、SSOT-types 指 DESIGN、config-key 纪律、concurrent-sessions 行级共存。目标 ~5-6KB。参照 `CLAUDE.ref.2.md`（worktree 内无此文件，读主树绝对路径 `/home/xp/src/copilot-api-js/CLAUDE.ref.2.md`）。

## 剩余 Phase E — 收尾

subagent 交付前独立核验（裁判轴=长远正确+完整+**无实质丢失**：逐条核 skill 迁入 ⊇ 原记忆正文）；doc-sync 跨文档 grep（正样本自证）；`git merge --no-ff chore/knowledge-rehousing` 回 master；把本 plan 归档留 `docs/plan/`；提示用户处置主树未追踪范本 `CLAUDE.ref.md`/`CLAUDE.ref.2.md`。

## 陷阱清单（务必读）

- **Write 覆盖已存在文件前必须先用 Read 工具读**（Bash cat 读的不算，会报 "File has not been read yet"）。
- **git 安全靠 isolated worktree**：worktree 内可自由删/改/提交，主树并发文件碰不到。`git rm` 删已追踪记忆文件可恢复。worktree 内 `docs/todo`/`docs/archive` 只有本工程文件（主树未追踪并发文件不在 worktree）。
- **stub 保留 slug 避免反链悬挂**——桶4/桶2 改 stub 不删，故指向它们的 `[[]]` 不悬挂；只有真删的 15 条需改 inbound 反链。
- **桶3 复用 `feedback-pass-null...` slug** 作合并记忆（12 反链枢纽），避免改 12 处。
- **B1 迁入完整性**：Phase E 必须 subagent 逐句 diff 核"skill 迁入 ⊇ 原记忆正文"（最高风险点，源正文含大量 file:line/数值证据/`\r` 容错/partial-DDL wedge 等）。
- 语言：记忆/CLAUDE.md 中文，逐字保留 ASCII 的 file:line/slug/技术标识符（见 CLAUDE.md 语言约定）。

## Kick-off prompt（新会话粘贴用）

> 继续「知识重新归位工程」。工作树 `.worktrees/knowledge-rehousing`（分支 `chore/knowledge-rehousing`），已完成 Phase 0/A/B1/B2（5 commits，所有厚方法论实质已迁入 skill/DESIGN/todo/archive）。读 `docs/plan/2026-07-05-knowledge-rehousing.md` 全文（含处置清单 + 反链清单 + 陷阱）。按其执行剩余 Phase C（40 条活记忆降 stub/精炼/合并/删 + 反链重写 + MEMORY.md 引用地图）、D（CLAUDE.md 照主树 `/home/xp/src/copilot-api-js/CLAUDE.ref.2.md` 风格重构、路径按本项目实际）、E（subagent 逐句 diff 核"迁入⊇原文" + merge --no-ff 回 master）。遵守 CLAUDE.md 全部原则；Write 覆盖前先 Read；细粒度 pathspec 提交。
