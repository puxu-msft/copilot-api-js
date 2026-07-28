---
name: session-closeout
description: 当 copilot-api-js 会话/阶段收尾时使用（交付/报告/ExitPlanMode/提交前/任务跨会话）——收尾六步完整清单、how-to 与判定纪律的单一源：subagent 交付前独立核验、doc-sync 跨文档 grep 验证、plan 与实验产物归档（四档状态注解模板）、记忆库提炼与维护、细粒度阶段提交、**跨会话交接（HANDOVER + KICKOFF：产物必须进仓库、待办带验收判据与证伪方式、自己犯过的错要写进去）**。走完整流程须读正文。
---

# 会话/阶段收尾任务

收尾 == “完成”的一部分：按序走完下面六步、**无需用户提醒**（CLAUDE.md `always-on-not-background` 最易漏的正是它——「能复述规则 ≠ 落笔前过了一遍」）。CLAUDE.md `session-closeout` 是 always-on 触发器（五步名 + 指向本 skill）；本 skill 是每步 how-to、判定纪律、plan 状态注解模板的**单一源**。战例（why/失败形态）在各 `feedback-*` 记忆，本 skill 只放 how-to。

## 1. subagent audit —— 交付前独立核验

交付/报告/ExitPlanMode/采信任何声音权威前，**永远派 subagent** 多视角对抗核验，不在主会话直接做。prompt 里显式写裁判轴「长远正确 + 完整」（subagent 默认 ROI/YAGNI，与本项目冲突）。吸收其客观事实，对其「无消费者/已通过/可安全删除」等绝对断言**亲自对照代码/实测复核、读它引用的每个 `file:line`**，绝不照搬。详见 CLAUDE.md `subagent-explicit-rubric`、skill `empirical-verification`、user-level skill `verifying-authoritative-claims`。

## 2. doc-sync + 验证

把已落地机制回填常驻活文档（DESIGN.md「活的架构现状」+ 模块图、README 路由/端点表、coding-conventions、模块文档、config 表），删过时 pending 记忆。**「doc-sync 完成」是通过性结论、不能口头宣告**——必做跨文档 grep 扫描：

- `grep -rn '暂缓\|暂未\|未实现\|TODO\|reserved\|无源' docs/` —— 本次特性的旧状态词全清零。
- `grep -rln '<新端点/新字段/新机制关键词>' docs/ README.md` —— 逐个核对该提的都提了。
- broken-link / L1 守卫测试绿。

只改最显眼处必漏其余（DESIGN 可能多行、README 多表、模块文档、RFC 汇总行、记忆正文）。旧 slug 名 `completion-includes-doc-sync`（历史文档仍用此名引用本步）。战例：2026-06-24 曾漏 5 处未 doc-sync（原 memory `feedback-completion-updates-docs` 已并入本步 + user-rule 70）。

## 3. 归档 plan —— 迁 docs/plan + 头部实施状态注解

把 `.claude/plans/` 与 `~/.claude/plans/` 里**属于本项目**的 plan 迁进 `docs/plan/<meaningful-name>.md`，并加头部实施状态注解。

- **归属核验**：`~/.claude/plans/` 虽实际专用于本项目，仍须逐个 grep 标记确认（`copilot-api-js`/`src/lib`/`DESIGN.md`/`ui-v4`），非本项目的不动。
- **迁移**：项目本地 `.claude/plans/`（git 追踪）→ `git mv` 保留历史（显示为 rename）；全局非仓库文件 → `mv`。命名从 plan 首个 `#`/`##` 标题派生 kebab-ASCII slug、弃随机 codename；移动前 collision guard（脚本逐个校验源存在 + 目标不存在，零覆盖），别与既有 `docs/plan/*.md` 碰撞。
- **subagent `-agent-XXXX.md` 审查伴随文件**：迁为 `<parent-slug>-review.md`；同父多份按 **mtime 升序** `-review`/`-review-2`；研究型（非审查，如 OTel 选型）记 `-research`（用户 2026-07-04 明确选“一并移动为独立文件”）。
- **只搬不删不去重**：与既有手工精选 plan（`*-plan.md` + `*_prompt.md`）主题重叠也保留两份原始存档，删/合并交用户定夺。
- **实验/探针产物同样归档**：`exp/<topic>/` + README 写清「回答什么问题 / 结论 / **它没有证明什么** / 复跑配方」。「没有证明什么」是必填项——探针的配置决定了它只激活一条路径，不写边界，下一个人（含三小时后的自己）会当成全覆盖（范式：`exp/keepalive-escalation-wire/README.md`；失效模式见 skill `empirical-verification`）。
- **头部实施状态注解**：四档（已完成/部分完成/未实施/仅研究）+ 配套文件类型注解 + 判定纪律，格式与四档示例见本 skill 的模板 [complete-plan.md](complete-plan.md)。判定是**事实性主张**，靠证据（DESIGN 状态表 / archive RFC / `git log -S` / 生效 config 键）不凭标题；否定性核验用正样本证明 grep 触达（空≠不存在）。

## 4. 提炼教训 + 维护记忆库

边界（phase/会话/交接）主动 distill 可复用经验（按 CLAUDE.md `knowledge-routing` 判归属），顺手体检既有库：陈旧→修、近义→互链、冗余→删。**判断某记忆是否已覆盖时 deep-read 正文、别只看索引钩子**（钩子会掩盖「写窄/写偏」）。记忆正文/description/索引钩子一律中文（保留 slug、`file:line`、wiki 链接、技术标识符）。详见 CLAUDE.md 风格偏好 `memory` 行、user-rule 70（原 memory `feedback-distill-lessons-at-boundaries` 已并入此步 + user-rule 70）。

## 5. 细粒度提交

阶段完成即主动 commit（贯穿全程、不问“要我提交吗”），收尾把 2–4 产生的文档/plan/记忆改动一并提交。**严格细粒度暂存、绝不整仓暂存、提交前 stat 复核只含本次改动**——具体命令黑白名单（`git add -p`/pathspec vs 禁 `git add -A`/`-am`）与并发会话行级共存技法见 CLAUDE.md `fine-grained-staging-per-phase-commit`/`concurrent-sessions-line-coexistence`、user-level skill `git-preference:coordinating-a-shared-git-worktree`（单一源，勿在此复述以免漂移）。conventional commits、不加 Claude 署名。战例：完成即提交、不问“要我提交吗”（原 memory `feedback-act-comprehensively-commit-on-done` 已并入本步 + user-rule 60）。

## 6. 跨会话交接 —— HANDOVER + KICKOFF

触发：任务跨会话（用户要求 / 上下文将满 / 阶段收尾但任务未完）。user-rule `handover-if-context-window-almost-full` 管 **when**，本节是 **how**。

**位置与分工**：`docs/plan/<date>-<topic>/HANDOVER.md` + `KICKOFF.md`，**在主树直接改并即时提交**——入口文档滞留在特性分支上等于没写（与 CLAUDE.md `docs-merge-before-execute` 同源）。**代码改动才进隔离 worktree**（`git worktree add .worktrees/<topic> -b feat/<topic>` 后 `bun install`，否则 eslint exit 127；见 skill `git-preference:isolating-from-a-shared-git-worktree`）。

**HANDOVER 必含**（缺一条就会让接手会话重走弯路）：

- **入口指引**：先读什么、每份材料在什么时机读。
- **已确证的硬事实**，逐条标证据等级（实测 / 源码读证 / 推断），并写明「别再重新推导」。
- **每条待办带验收判据 + 证伪方式**，不写「大概/也许」；用户已批准的、已裁决的、仍待裁决的分叉分开标。
- **自己犯过的错与其成因**。只列结论的交接，会让接手会话**重犯产出这些结论的错误**——本轮交接里写进了两条被自己推翻的结论（错读 commit-relative 时间基、未查 peer 就断言缺陷不在我方），它们比结论本身更有用。

**产物必须进仓库并提交**（这一条踩过实亏）：

- `/tmp` 里的 subagent 报告、wire 抓包、探针输出**一重启就没**；共享 worktree 里的**未追踪文件离一次 `git clean` 只差一步**——本轮三份研究报告就是在提交前被并发会话的清理抹掉，靠 `/tmp` 原件才救回。**先 `git add` 再写引用它们的交接**。
- subagent 的结论也要落进产物文件而非只靠 return 正文（见 [[methodology-background-agent-result-surfacing-failure]]）。

**KICKOFF 的写法**：① 工作方式硬性要求放最前（worktree、文档例外、合并前查 peer）；② 待办含用户批准状态与优先级，未裁决的明确标「需用户先定」；③ 这一轮反复踩的坑；④ 测试门禁现状与禁区（哪些命令在本机跑不起来、哪些是用户已明确推迟的、绝不碰的东西）。

**写之前先 `git log --oneline -20`**：并发会话可能已经落地或推翻了你要交接的内容——本轮写交接时 T1 已被 peer 动过、一条根因结论已被 peer 早 6 小时的提交作废。交接一旦陈旧，危害大于没有。

## 判定纪律（贯穿全步）

「已完成/未实施」「doc-sync 完成」「无残留」都是通过性/事实性结论，**不自证**——先用一个已知应命中的正样本证明检查触达了目标（空≠不存在、通过≠健全）。详见 CLAUDE.md `empirical-verification`、user-level skill `verifying-authoritative-claims`。
