# 批 6 执行件：把 `session-closeout` 并入 `closing-a-development-session`

> **状态：草稿 · 已过一轮部分评审 · 未执行**　　核验基线 `4629ae8f`（2026-08-08）　　分支：`master`（共享主树）
>
> 本文件是**映射表 + 执行顺序**，是批 6 的验收门（「零未映射条目」）。前五批已落地并提交，见文末「已完成部分」。
>
> ⚠️ **「零未映射」门当前未通过，本文件尚不可据以执行。** 独立评审对源文件**第 1–100 行**已查出 **8 条未映射语义条目**（见「评审已查出的缺口」节）；**101–204 行与 `handover.md` / `complete-plan.md` / `verification-log.md` 三个配套文件尚未被评审覆盖**。执行前必须补完这些条目并重新过门。

## 映射粒度的口径（评审逼出来的，写在最前面）

**映射表的条目单位是「语义条目」，不是「行号区间」。** 在表里写一个宽区间（如 `:34-43`）并不能证明该区间内每条纪律都有归属——评审明确拒绝把宽区间本身当作已映射。**每条可独立丢失的纪律都要有自己的一行。** 这也是「零内容丢弃」唯一可机械证明的形式。

## 为什么有这份文件

用户 2026-08-08 两次裁决：① 收尾编排权归 user-level skill `closing-a-development-session`；② **把项目 skill `session-closeout` 并入它，不保留两个收尾入口**。

并入不是复制粘贴：`closing-a-development-session` 在 `~/.claude/skills/`、**对所有项目生效**，而 `session-closeout` 里有大量 copilot-api-js 专有绑定。归属切分原则：**通用方法论并入全局 skill，项目专有绑定并入项目 `CLAUDE.md`**（项目 doc 路由本就规定项目增量归 CLAUDE.md）。**零内容丢弃。**

## 两个必须先知道的硬约束

1. **目标是生成产物。** `~/.claude/skills/closing-a-development-session/` 实为 `source.json` + `render_skill.py` + `tests/test_skill.py`；`SKILL.md` 由 `source.json` 渲染。**直接编辑 SKILL.md 会被覆盖并撞守卫。** 流程固定为 **改 `source.json` → 跑 `render_skill.py` → 跑 `tests/test_skill.py` 绿**。
   守卫的硬约束：frontmatter 字段恰为 `{name, description}`；九个 `## 1..9` 标题按序且 `closeout-contract` 块唯一；description 必须仍含 `session-wide`、`multiple closeout surfaces`、`not for a routine branch` 三个子串。若并入需要新增阶段或改 contract stage 列表，**必须同批改 `source.json` 的 contract 与测试期望**，不得让渲染结果与守卫失配。
2. **跨仓交付顺序不可颠倒。** 先全局侧落地并提交 → 再改项目侧指针 → **最后才删 `.claude/skills/session-closeout/`**。颠倒会制造「旧归属已删、新归属未提交」的窗口，任何并发会话都会读到断链。全局侧不可提交（无写权限或有他人 WIP）时**停在该步并报告**，不推进删除。

## 映射表（验收门：**零未映射条目**）

源 = `.claude/skills/session-closeout/`（SKILL.md 204 行 + `handover.md` + `complete-plan.md` + `verification-log.md`）。
目标三选一：**G** = 全局 `source.json` 的某 stage；**P** = 项目 `CLAUDE.md`；**D** = 已有的专门 sub-skill（只需确认它已覆盖，不搬内容）。

### 正文六步 + 3b + 6b

| # | 源（`SKILL.md` 行号） | 内容 | 目标 | 备注 |
|---|---|---|---|---|
| 1 | `:8` | 「收尾是完成的一部分、按序走完无需提醒」 | **G** intro | 全局 intro 已有等价语义，核对后合并措辞，不新增段 |
| 2 | `:10` | **上下文将满时 §6 先做**的唯一顺序例外 + 「草稿·未评审」状态 | **G** stage 9 前置 / 新增 contract 条目 | **易漏第 1 条**。全局九阶段目前**没有**这个例外，必须新增；若需动 contract stage 列表，同批改测试期望 |
| 3 | `:12` | 「用完欠一笔账」→ verification-log | **G** stage 7 + 目标目录新建 `verification-log.md` | 见下「自验日志两分」 |
| 4 | `:14-22`（§1 subagent audit） | 多视角派活、正交视角、`property → acceptance` 四项机械对账、原 reviewer 复评范围、逐条落盘 + `REPORT_FILE` 绝对路径 | **G** stage 7 | 全局 stage 7 已有「closeout artifacts 必评审」，**缺**四项机械对账与逐条落盘，需并入 |
| 5 | `:24-32`（§2 doc-sync） | 三条跨文档 grep 门（旧状态词清零 / 关键词逐个核对 / broken-link 与 L1 守卫） | **G** stage 4 + **P** | **易漏第 3 条**。grep 命令里的 `docs/` 路径与 L1 守卫名是项目专有 → P；「通过性结论不能口头宣告、必做跨文档扫描」是通用 → G |
| 6 | `:34-43`（§3 归档） | 四档状态注解（已完成/部分完成/未实施/仅研究）、`exp/<topic>/` README 必含「它没有证明什么」、collision guard、`-review`/`-research` 命名 | **G** stage 3 + **P** | 方法归 G；`docs/plan/`、`exp/<topic>/`、`.claude/plans/` 具体落点归 P |
| 7 | `:45-51`（§3b job tmp） | 逐文件对账硬门、七步固定顺序、清单先过独立评审才可删、复扫新文件使先前评审作废 | **G** stage 2 + stage 5 | 全局 stage 2/5 **已有**该内容（措辞高度一致，疑似已从本 skill 吸收过一轮）——**逐句比对后折进去，不新建平行小节** |
| 8 | `:53-55`（§4 教训与记忆） | 边界 distill、体检既有库、deep-read 正文别只看钩子 | **G** stage 3 + **P** | 记忆语言约定、`docs/memory/MEMORY.md` 落点归 P |
| 9 | `:57-59`（§5 细粒度提交） | 精确 pathspec + 提交前 stat 复核、conventional commits、不加署名 | **G** stage 6 + **D**（`git-preference:coordinating-a-shared-git-worktree`） | 命令黑白名单已由 D 权威维护，G 只留约束与指针 |
| 10 | `:61-71`（§6 交接总纲） | HANDOVER/KICKOFF 分工判据、一致性门、位置约定、提交时机、**紧急纠错例外的三条限制与可观察动作序** | **G** 新增 stage 或 stage 9 扩展 | **易漏第 2 条**（`:71` 那段紧急例外）。全局目前无交接阶段，这是本批最大的一块新增 |
| 11 | `:73-81`（HANDOVER 必含项） | 头部状态行 / 入口指引 / 硬事实带证据等级 / 审计计数否定结论写边界 / 与冻结 spec 对账三句 / 待办带验收判据与证伪方式 / 自己犯过的错绑复发点 | **G** 同上 | 逐条并入，一条都不能省 |
| 12 | `:83-90` | 交接必须过 §1 评审 + 默认两视角表（判据证伪 / 接手方第一人称走查）+ 可替换槽位 | **G** stage 7 | 与 #4 合并进同一阶段 |
| 13 | `:92-152`（§6b 进度文件） | 完整二分判据、一 agent 一文件、frontmatter 必含 `<base>`、`--first-parent` 对账脚本**及其五个承重写法**、三样记录、两种收口、共树/判活两条调度纪律、容量终态分类、新 agent 接力五步协议、切分判据、record-now-adjudicate-later | **G** 新增 stage（**非收尾触发**）+ **P** 常驻触发条 | **本批第二大块。** 见下「两个非收尾触发」 |
| 14 | `:154` | 每轮改完 HANDOVER 立刻回查 KICKOFF | **G** 同 #10 | |
| 15 | `:156` | 产物必须进仓库并提交（先 `git add` 立刻 `git commit -F`，别只 add） | **G** stage 2 | |
| 16 | `:158-162` | 写之前先查 peer（路径口径为主、`-S` 搜字面量）、命中后的升级信号、核验基线 `<sha>` 写头部 | **G** 同 #10 + **D**（`moving-shared-head-is-not-failure` 归 user-rule） | |
| 17 | `:164` | KICKOFF 四条写法 + 「测试门禁现状最易腐、必须标核验日期与复验触发器」 | **G** 同 #10 | |
| 18 | `:166` | **交接要在 `docs/` 里有可发现入口**、入口本身也是评审对象、不新造占位条目 | **G** 同 #10 + **P** | **易漏第 4 条** |
| 19 | `:168` | 任务收尾后回来关掉交接（改状态行 / `superseded-by` / 不删）、禁止两份并列自称唯一入口 | **G** 同 #10 | |
| 20 | `:170-200`（自验节 V1–V19 + 定期度量） | 断言表与验法 | **拆分**：通用条目 → **G** 的新 `verification-log.md`；项目实例证据 → 留项目侧 | 见下 |
| 21 | `:202-204`（判定纪律） | 通过性结论不自证、先用正样本证明检查触达 | **G** intro 或 stage 7 | |

### 配套文件

| # | 源 | 目标 | 备注 |
|---|---|---|---|
| 22 | `handover.md`（115 行模板） | **G** 目录下同名模板 | 模板里的 `docs/plan/`、`.worktrees/`、bun 测试档位替换为占位符，具体值留 **P** |
| 23 | `complete-plan.md`（90 行，四档状态注解格式） | **G** 目录下同名模板 | 同上 |
| 24 | `verification-log.md`（178 行） | **两分**：投票规则（V 编号定义、三次证实毕业、作者不能投证实票、证伪即改正文）→ **G** 新建 `verification-log.md`；**项目实例证据整体留项目侧**（迁 `docs/memory/` 或项目文档，保留原会话/sha 出处与**已积累票数，不重置**），由 P 指向 | 目标 skill 目录下**目前没有** `verification-log.md`；须写明迁入后 V 编号如何与既有 `tests/test_skill.py`、contract 共存、不重号 |

### 项目专有绑定 → `CLAUDE.md`（P 的完整清单）

`docs/plan/` / `docs/tmp/` / `exp/<topic>/` / `docs/memory/MEMORY.md` 的具体落点、`.worktrees/` 布局、bun 测试分档（`test:fast` / `test:backend` / `test:ci`）、**4141 禁区**、L1 守卫测试名、记忆语言约定。

`CLAUDE.md` 第 41 行（自验范式引用）与第 56 行（`session-closeout` 条）改写为**指向 `closing-a-development-session` 的触发条 + 项目落点表**。

### 两个非收尾触发（避免被「收尾」语义埋掉）

「派 implementer 前读进度文件协议」与「agent 报 `400 input exceeds the context window` 走接力」**离收尾语义最远**，而本仓 V11 已记录连续「派完才想起来」的负样本。因此**不只依赖 description 召回**：并入 description 的同时，**在项目 `CLAUDE.md` 保留一条常驻触发条**（always-on 每次加载）指向这两个协议，skill 正文只放 how-to。**这是归属安排，不是待验证的假设。**

## 评审已查出的缺口（8 条，源文件第 1–100 行；101 行之后与三个配套文件尚未评审）

独立评审（报告：`docs/tmp/2026-08-08-batch6-closeout-merge-plan-review.md`）按语义条目核对后，指出下列内容**在上表中没有对应条目**。执行前每条都要补进映射表并给出目标（G / P / D）：

| 源 `file:line` | 未映射的内容 |
|---|---|
| `SKILL.md:1-6` | **frontmatter 与标题整体没有映射行**：description 的完整触发面、两个非收尾触发、以及「可执行细节只在正文」这条契约都未逐项归属。执行件虽有「两个非收尾触发」散文，但覆盖不了 description 其余内容 |
| `:8` | 该行的**权威拓扑**：`CLAUDE.md` 只负责 always-on 触发；本 skill 是 how-to / 判定纪律 / 模板的单一源；战例归各 `feedback-*` memory。上表 #1 只登记了「收尾是完成的一部分」 |
| `:15-16` | 「**采信任何声音权威前**也必须独立核验」、**显式价值轴**、以及对「无消费者/已通过/可安全删除」等绝对断言必须**亲自读其 `file:line` 并实测复核** |
| `:35-43` | plan 归属**逐文件核验**、`git mv` 保历史、**标题派生 kebab-ASCII slug**、重叠 plan「只搬不删不去重、交用户定夺」、实验 README 的「回答什么/结论/复跑配方」（上表只登记了「它没有证明什么」）、状态结论的**证据源与否定性正样本门** |
| `:50-51` | **项目专有的失败实例及其 archive provenance**（11 个未 disposition 文件、3.4 MiB patch、69 KiB status、7 个 commit-message 文件）——不能以「全局 stage 2/5 已有等价内容」为由静默丢弃，须明确留项目证据侧或迁为全局实例 |
| `:58-59` | 「**阶段完成即主动 commit、贯穿全程、不询问用户**」、以及「收尾必须把步骤 2–4 产生的文档/plan/memory **一并**提交」 |
| `:70-71` | 段末的**代码改动隔离边界**与两条项目实测：`.worktrees/` 会**向上解析主树 `node_modules`**；新树缺 gitignored 构建产物会造成**稳定假红**。P 清单里那句「`.worktrees/` 布局」覆盖不了这两条 |
| `:95-98` | §6b 协议的**经验依据**（中断时 3 个 commit 保住、4 个未提交文件的在途意图全丢）与**命名细则**：slug 由派活方预先指定、不能用 agent id、必须放文件名后缀、现有 9/9 文件的排序形状与「尚无同形先例」这个边界 |

**这 8 条揭示的共同形态**：上表按「小节」登记，而**纪律是按「句」丢失的**。补完之后，剩余的 101–204 行与三个配套文件必须按同一粒度重走一遍。

## 删除与重指（机械清单，逐条核）

删 `.claude/skills/session-closeout/` **必须在内容确认已迁入之后**。live 指针逐个重指（**行号以执行期 `rg` 实测为准，勿引用本文快照值**）：

- `CLAUDE.md`（两处：自验范式引用、`session-closeout` 条）
- `docs/memory/MEMORY.md`（三处）
- `docs/memory/session-closeout-and-handover.md`（整条 stub）
- `.claude/skills/large-refactor/SKILL.md`
- `.claude/skills/delivering-in-validated-batches/SKILL.md`
- 引用它的各 memory：`feedback-skill-claims-needing-field-proof-must-self-verify`、`methodology-downgrading-a-gate-needs-a-reachable-trigger`、`reference-subagent-transcript-5mib-gate-blocks-resume`、`feedback-resume-agent-always-sendmessage-never-agent-tool` 等

### 两个硬门（不做会真的坏掉）

1. `.claude/skills/delivering-in-validated-batches/dependencies.json` 声明 `session-closeout` 且带 `relative_path: .claude/skills/session-closeout/SKILL.md`，由该 skill 的 `validate.py` 在运行环境解析。**删除前必须改指并实跑 `validate.py`，确认依赖全部可解析。**
2. `~/.claude/rules/agents/61-agent-collaboration.md:13` 是 **user-level rule**，指向「skill `session-closeout` §6b」。它随本次归属变更失效，**必须同批改指**。改 user-level rule 属跨项目影响，**按 B 级处置：交未卷入的第三方评审后再落。**

### 历史文档不追溯重写

`docs/plan/`、`docs/rfc/`、`docs/tmp/`、`ui-v4/docs/plans/` 下约百份历史 plan/kickoff/review 提到 `session-closeout`，它们是**当时事实的记录，保持原样**；只在 `docs/memory/session-closeout-and-handover.md` 与 MEMORY.md 索引留一条「已并入 `closing-a-development-session`」的重定向，使按旧名检索的人能落到新归属。

## 执行顺序（不可颠倒）

1. 全局侧取 baseline：`git -C ~/.claude --no-optional-locks status --short`，确认无他人 WIP、目标文件 ownership。
2. **全局侧先落并提交**：改 `source.json` → `render_skill.py` → `python3 -m unittest` 跑 `tests/test_skill.py` 绿 → 新建通用 `verification-log.md` → 提交。
3. user-level rule `61-agent-collaboration.md` 的改指，**经未卷入的第三方评审后单独提交**。
4. 项目侧改全部 live 指针 + `CLAUDE.md` 落点表 + `dependencies.json`，实跑 `validate.py`。
5. **最后**删 `.claude/skills/session-closeout/`，复跑全仓 `rg 'session-closeout'` 逐条 disposition。
6. 两侧各自 `git status` 复核；**均不 push**。

## 下一步（执行前必须先做完）

1. **补完映射表**：把上面 8 条缺口逐条落成映射行；随后按**语义条目**粒度重走 `SKILL.md:101-204` 与 `handover.md` / `complete-plan.md` / `verification-log.md`。
2. **重新过「零未映射」门**：交独立评审，逐段确认无遗漏（本轮评审只覆盖了 1–100 行，且因两次 `Server error mid-response` 分段进行）。
3. 门通过后才进入下面的「执行顺序」。

## 验收判据

- 映射表**零未映射条目**（粒度＝语义条目，不是行号区间）（含上面点名的四条易漏项与自验条目的两分归属）；通读只作补充、不作证据。
- `tests/test_skill.py` 绿；description 三个必留子串仍在；九标题按序、contract 块唯一。
- `validate.py` 依赖解析全通过。
- 全仓 `rg 'session-closeout'` 逐条 disposition：live 指针已改指，历史 plan/rfc/tmp 保留原文。
- 收尾主场景静态核对：以「feature 已合并，请收尾和清理旧 worktree/ledger 并给最终报告」读一遍并入后的正文，确认单一入口、逐项委托专门 sub-skill、终态报告槽齐全、边界写明普通 `git merge`/PR 决策只走 `finishing-a-development-branch`。
- 本批**额外按 B 级处置**：改 user-level skill 与 rule、影响所有项目，评审必须交**未卷入的第三方**，并单独确认零内容丢弃与零断链。

## 本轮方法（承前五批，不变）

**不做 eval、不建 `evals/`、不用 TDD**（用户 2026-08-08 明确否决；也撞 user-rule `implementation-before-tests` 与 `solve-the-task-before-building-proof-infrastructure` 两条 `[hard]`）。每批只做两件事：**静态检查**（frontmatter 与目录名一致、description 只写 when-to-use、引用的 `file:line` 逐个打开确认、易变事实不写进 skill、旧措辞 `rg` 后逐条 disposition）+ **独立评审**（先列可核验 claims，派异模型 instruction reviewer，只读、给 `REPORT_FILE` 绝对路径、显式写裁判轴「长远正确 + 完整」；修复后**恢复同一 reviewer** 复评至 0 blocker/major）。

## 已完成部分（前五批，均已提交本地 master，未 push）

| 批 | 内容 | commit |
|---|---|---|
| 1 | 纠正 `debugging-claude-client-connection` 陈旧事实 + backlog 记一条 `pipelineInfo.responseHeaderTimeoutMs` 无生产写点 | `cbf0b54a` |
| 2 | 新增 `anthropic-precontent-recovery` | `d64630e4` |
| 5 | 新增 `enforcing-invariants-across-mechanism-layers` | `4629ae8f` |
| 3+4 | `test-isolation` config 热加载轴 + 新增 `owned-singleton-lifecycle` + backlog 记 registry 两个 test-seam 缺口 | 复评中，见 `docs/tmp/2026-08-08-batch34-test-isolation-and-singleton-review.md` |

三批评审报告均在 `docs/tmp/`，逐轮 finding 与处置可查。
