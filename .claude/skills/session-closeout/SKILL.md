---
name: session-closeout
description: 当 copilot-api-js 会话/阶段收尾时使用——交付、汇报、ExitPlanMode、提交前，或任务要跨会话继续。触发症状：「这轮做不完了」「上下文快满了」「compact 之前要做什么」「给下个会话写个交接」「新会话怎么接手」「归档一下」；即使用户只说「先记一下进度」也用本 skill。正文是收尾六步（subagent 独立核验 / doc-sync / 归档 plan 与实验产物 / 提炼教训与维护记忆 / 细粒度提交 / 跨会话交接）的 how-to、判定纪律与模板的单一源——**可执行细节只在正文，必须读正文**。
---

# 会话/阶段收尾任务

收尾 == “完成”的一部分：按序走完下面六步、**无需用户提醒**（CLAUDE.md `session-closeout` 明写「按序做完无需提醒」，最易漏的正是它——「能复述规则 ≠ 落笔前过了一遍」）。CLAUDE.md `session-closeout` 是 always-on 触发器（六步名 + 指向本 skill）；本 skill 是每步 how-to、判定纪律与模板（[complete-plan.md](complete-plan.md) / [handover.md](handover.md)）的**单一源**。战例（why/失败形态）在各 `feedback-*` 记忆，本 skill 只放 how-to。

**唯一的顺序例外：触发原因是「上下文将满」时，§6 先做、其余顺延。** 交接是六步里**唯一不可重做**的产物——§1–§5 的成果丢了下个会话还能重来，交接丢了整轮工作无人接得上；而 §1（派 subagent 并逐条复核 `file:line`）与 §2（跨文档 grep）恰是六步里上下文开销最大的两步，按序走必然烧光预算走不到 §6。先把 HANDOVER/KICKOFF 落盘提交，再按剩余预算回头补 §1–§5，补不完的作为待办写进 HANDOVER。

## 1. subagent audit —— 交付前独立核验

交付/报告/ExitPlanMode/采信任何声音权威前，**永远派 subagent** 多视角对抗核验，不在主会话直接做。prompt 里显式写裁判轴「长远正确 + 完整」（subagent 默认 ROI/YAGNI，与本项目冲突）。吸收其客观事实，对其「无消费者/已通过/可安全删除」等绝对断言**亲自对照代码/实测复核、读它引用的每个 `file:line`**，绝不照搬。详见 CLAUDE.md `subagent-explicit-rubric`、skill `empirical-verification`、user-level skill `verifying-authoritative-claims`。

## 2. doc-sync + 验证

把已落地机制回填常驻活文档（DESIGN.md「活的架构现状」+ 模块图、README 路由/端点表、coding-conventions、模块文档、config 表），删过时 pending 记忆。**「doc-sync 完成」是通过性结论、不能口头宣告**——必做跨文档 grep 扫描：

- `grep -rn '暂缓\|暂未\|未实现\|TODO\|reserved\|无源' docs/` —— 本次特性的旧状态词全清零。
- `grep -rln '<新端点/新字段/新机制关键词>' docs/ README.md` —— 逐个核对该提的都提了。
- broken-link / L1 守卫测试绿。

只改最显眼处必漏其余（DESIGN 可能多行、README 多表、模块文档、RFC 汇总行、记忆正文）。旧 slug 名 `completion-includes-doc-sync`（历史文档仍用此名引用本步）。战例：2026-06-24 曾漏 5 处未 doc-sync（原 memory `feedback-completion-updates-docs` 已并入本步 + user-rule `41-doc-mgmt`）。

## 3. 归档 plan 与实验产物 —— 迁 `docs/plan/`、就地 `exp/<topic>/` + 状态/边界注解

把 `.claude/plans/` 与 `~/.claude/plans/` 里**属于本项目**的 plan 迁进 `docs/plan/<meaningful-name>.md`，并加头部实施状态注解。

- **归属核验**：`~/.claude/plans/` 虽实际专用于本项目，仍须逐个 grep 标记确认（`copilot-api-js`/`src/lib`/`DESIGN.md`/`ui-v4`），非本项目的不动。
- **迁移**：项目本地 `.claude/plans/`（git 追踪）→ `git mv` 保留历史（显示为 rename）；全局非仓库文件 → `mv`。命名从 plan 首个 `#`/`##` 标题派生 kebab-ASCII slug、弃随机 codename；移动前 collision guard（脚本逐个校验源存在 + 目标不存在，零覆盖），别与既有 `docs/plan/*.md` 碰撞。
- **subagent `-agent-XXXX.md` 审查伴随文件**：迁为 `<parent-slug>-review.md`；同父多份按 **mtime 升序** `-review`/`-review-2`；研究型（非审查，如 OTel 选型）记 `-research`（用户 2026-07-04 明确选“一并移动为独立文件”）。
- **只搬不删不去重**：与既有手工精选 plan（`*-plan.md` + `*_prompt.md`）主题重叠也保留两份原始存档，删/合并交用户定夺。
- **实验/探针产物同样归档**：`exp/<topic>/` + README 写清「回答什么问题 / 结论 / **它没有证明什么** / 复跑配方」。「没有证明什么」是必填项——探针的配置决定了它只激活一条路径，不写边界，下一个人（含三小时后的自己）会当成全覆盖（范式：`exp/keepalive-escalation-wire/README.md`；失效模式见 skill `empirical-verification`）。
- **头部实施状态注解**：四档（已完成/部分完成/未实施/仅研究）+ 配套文件类型注解 + 判定纪律，格式与四档示例见本 skill 的模板 [complete-plan.md](complete-plan.md)。判定是**事实性主张**，靠证据（DESIGN 状态表 / archive RFC / `git log -S` / 生效 config 键）不凭标题；否定性核验用正样本证明 grep 触达（空≠不存在）。

## 4. 提炼教训 + 维护记忆库

边界（phase/会话/交接）主动 distill 可复用经验（按 CLAUDE.md「文档路由」节判归属），顺手体检既有库：陈旧→修、近义→互链、冗余→删。**判断某记忆是否已覆盖时 deep-read 正文、别只看索引钩子**（钩子会掩盖「写窄/写偏」）。记忆正文/description/索引钩子一律中文（保留 slug、`file:line`、wiki 链接、技术标识符）。详见 CLAUDE.md「文本风格偏好」的记忆语言约定行、user-rule `41-doc-mgmt`（原 memory `feedback-distill-lessons-at-boundaries` 已并入此步）。

## 5. 细粒度提交

阶段完成即主动 commit（贯穿全程、不问“要我提交吗”），收尾把 2–4 产生的文档/plan/记忆改动一并提交。**严格细粒度暂存、绝不整仓暂存、提交前 stat 复核只含本次改动**——具体命令黑白名单（`git add -p`/显式 pathspec vs 禁 `git add -A`/`-am`）与并发会话行级共存技法见 CLAUDE.md「细粒度、每阶段提交」/「concurrent-sessions 行级共存」两条、user-level skill `git-preference:coordinating-a-shared-git-worktree`（单一源，勿在此复述以免漂移）。conventional commits、不加 Claude 署名。战例：完成即提交、不问“要我提交吗”（原 memory `feedback-act-comprehensively-commit-on-done` 已并入本步 + user-rule `21-git-workflow` 的 `commit-when-meaningful`）。

## 6. 跨会话交接 —— HANDOVER + KICKOFF

触发：任务跨会话（用户要求 / 上下文将满 / 阶段收尾但任务未完）。user-rule `01-core-principles` 的 `handover-if-context-window-almost-full` 管 **when**，本节是 **how**；骨架照抄同目录模板 [handover.md](handover.md)，本节只写判定纪律。

**两份文档的分工判据**（不写清必然写重，而重复的那份一定先陈旧）：**HANDOVER = 完整档案**，这轮工作的唯一事实源，按需查阅、可以长；**KICKOFF = 能整段复制成新会话第一条消息的提示词**（user-rule `40-dev-workflow`：kick-off prompt doc *for the user to copy*），只放「不先知道就会做错」的东西，其余一律指向 HANDOVER 的小节号、**绝不复述内容**。

**位置**：`docs/plan/<date>-<topic>/HANDOVER.md` + `KICKOFF.md`（目录式）。本仓另有 21 份历史扁平式 `docs/plan/<date>-handover-<topic>.md`——**目录式是新约定，旧的不追溯迁移**（MEMORY.md 多条指针指向扁平式路径，迁了会全断）。**在主树直接改并即时提交**——入口文档滞留在特性分支上等于没写（与 CLAUDE.md `docs-merge-before-execute` 同源）。**代码改动才进隔离 worktree**：命令与技法以 skill `git-preference:isolating-from-a-shared-git-worktree` 为准（勿在此复制），只记本仓的两条实测——`.worktrees/` 建在仓库内部、**向上解析主树 `node_modules`，不是依赖隔离环境**；真正会咬的是新树缺 gitignored 构建产物导致的稳定假红（见 [[reference-worktree-bun-add-needs-main-tree-install-after-merge]]）。

**HANDOVER 必含**（缺一条就会让接手会话重走弯路）：

- **头部状态行**：`进行中 / 已被接手（谁）/ 已完成（落地 commit）/ 已失效（原因）` + **核验基线 `<sha>` 与日期** + 当前分支/worktree + 未提交与未追踪清单 + 已跑门禁及其结果。这是防陈旧的机制本身——§6 写着「交接一旦陈旧，危害大于没有」，而接手方面对 `docs/plan/` 下二十多份交接，没有状态行就判断不出哪份是活的。
- **入口指引**：先读什么、每份材料在什么时机读。
- **已确证的硬事实**，逐条标证据等级（实测 / 源码读证 / 推断），并写明「别再重新推导」。
- **每条待办带验收判据 + 证伪方式**，不写「大概/也许」；用户已批准的、已裁决的、仍待裁决的分叉分开标。
- **自己犯过的错与其成因**。只列结论的交接，会让接手会话**重犯产出这些结论的错误**——本轮交接里写进了两条被自己推翻的结论（错读 commit-relative 时间基、未查 peer 就断言缺陷不在我方），它们比结论本身更有用。

**产物必须进仓库并提交**（这一条踩过实亏）：

- `/tmp` 里的 subagent 报告、wire 抓包、探针输出**一重启就没**；共享 worktree 里的**未追踪文件离一次 `git clean` 只差一步**——本轮三份研究报告就是在提交前被并发会话的清理抹掉，靠 `/tmp` 原件才救回。
- 动作要走完：**`git add -- <精确路径>` 之后立刻 `git commit -F <msgfile> -- <精确路径>` 落成提交，再写引用它们的交接。** 只 `git add` 只做到一半——文件确实不再会被 `git clean` 删掉，但留在共享 index 里会被 peer 的无-pathspec `git commit` 卷走。
- subagent 的结论也要落进产物文件而非只靠 return 正文（见 [[methodology-background-agent-result-surfacing-failure]]）。

**写之前先查 peer，并且要写清查完做什么**：

- 检索：`git log --oneline ..master -- <你改动或下结论涉及的路径>`（**方向别写反**：`master..` 列的是你自己的提交）+ `git log -S<你结论里的关键符号>`。`-20` 这种无 path 限定的条数截断，在并发八个 worktree 时只覆盖两三小时。
- 命中后的动作：受影响的**硬事实**重新核验，核不动就降级为「待验证假设」；受影响的**待办**改写或标注「已被 `<sha>` 作废」。本轮就有一条根因结论被 peer 早 6 小时（author date）的提交悄悄作废。
- 落盘时把**核验基线 `<sha>`** 写进头部状态行，让接手方一眼看出新鲜度。

**KICKOFF 的写法**：① 工作方式硬性要求放最前（worktree、文档例外、合并前查 peer）；② 待办含用户批准状态与优先级，未裁决的明确标「需用户先定」；③ 这一轮反复踩的坑；④ 测试门禁现状与禁区（哪些命令在本机跑不起来、哪些是用户已明确推迟的、绝不碰的东西）——**这类信息最易腐，必须标「核验于 `<日期>` / `<sha>`」并写明「接手第一件事是复验而非采信」**：本轮 KICKOFF 判死刑的 `test:backend`，在写下它的 1 小时 40 分钟**之前**就已被 peer 修好，而它建议的「替代命令」与它现在是同一条。

**任务收尾后回来关掉交接**：待办全部关闭时把状态行改成「已完成 + 落地 commit」，被新交接取代时写 `superseded-by`，**不删**（按 §3 的归档纪律处理）。同主题已有活交接时更新它或建立显式取代链，**禁止两份并列自称唯一入口**。

## 判定纪律（贯穿全步）

「已完成/未实施」「doc-sync 完成」「无残留」都是通过性/事实性结论，**不自证**——先用一个已知应命中的正样本证明检查触达了目标（空≠不存在、通过≠健全）。详见 CLAUDE.md `empirical-verification`、user-level skill `verifying-authoritative-claims`。
