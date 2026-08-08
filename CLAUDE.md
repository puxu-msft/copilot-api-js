# 项目级 agent 指令（与全局指令冲突时，以本文件为准）

`copilot-api-js` 把 GitHub Copilot（项目内简称 **GHC**）的模型能力，暴露为多种主流 AI API 兼容端点（OpenAI Chat Completions / Responses、Anthropic Messages、Google Gemini generateContent、Azure deployments），底层直连 Copilot 的 REST/WebSocket 上游；含 History Web UI 前端子项目（`ui-v4/`，经 `~backend/*` re-export 后端类型）。

本文件只写 user-level 规则之上的**项目增量**（项目定位、doc 归属、本项目特有纪律）；通用工作原则不重述，指向 user-level 规则（`~/.claude/rules/00-user/`）。

## 文本风格偏好

- **多用中文、拒绝无意义硬折行、确保用词可解码。** → user-rule `20-text-formatting`。项目修正：中文句子里引号用 `“”` 或 `""` 皆可。
- **记忆 / 文档语言约定。** 记忆文件正文 / frontmatter `description` / MEMORY.md 索引钩子一律中文；逐字保留 ASCII 的：文件名与 `name:`/slug、`file:line`、`[[slug]]` 内 slug、code/JSON/shell 与行内 code、技术标识符（tool_use、signature、printWidth、SSE 等）；结构标签 `**Why:**`/`**How to apply:**`/`**Related:**` 保留英文。

## 文档路由

`docs/` 是本项目架构与决策的**权威来源层**，新会话 / 接手先读 [docs/DESIGN.md](docs/DESIGN.md)（尤其「活的架构现状」表——**当前活/wip/bypass/退役路径以此为准**），再下到具体 spec / ADR。README、CLAUDE.md、skill、HANDOVER 与 memory 可以按各自读者需要完整复述，但必须引用同一个权威 doc / ADR / spec，冲突时回到该来源裁决；不得把“单一事实源”误解成“同一事实只能出现一次”，也不得为了 DRY 把完成任务所需的上下文削成裸指针。易变状态与数字若复述，须带权威引用和快照/commit/date；类型 owner、明细账→派生摘要、活跃进度写入权移交等真正的单写入源仍保持唯一。→ user-rule `41-doc-mgmt` `one-authority-allows-contextual-restatement`。

面向不同读者的三份始终生效文档：
- [README.md](README.md) —— 面向用户：功能、安装、使用、示例。
- CLAUDE.md（本文件）—— 面向 AI Agent 的 **always-on** 指令（中文）：项目定位、原则、纪律、风格。
- [docs/memory/MEMORY.md](docs/memory/MEMORY.md) —— 面向 AI Agent 的战例**引用层**：话题 → 归属地图（每条教训实质已下沉 skill / docs / ADR，记忆只留 stub 或精炼实例）。

各类知识的固定归属（都在 `docs/`）：
- 架构总览、模块划分、分层、**类型架构（SSOT-types）** → [docs/DESIGN.md](docs/DESIGN.md)。
- **对客户端暴露的 HTTP 端点（端点 SSOT）** → [docs/API.md](docs/API.md)（vendor 兼容 / 管理 API / 基础设施 / History REST / WebSocket，含字段级备注）。DESIGN.md「路由」节只留指针、深层路由架构在「活的架构现状」；活的全表面真相 = 运行实例 `GET /openapi.json`。
- 关键设计决策 + 理由 → [docs/decisions/](docs/decisions/) ADR（一决策一文件）。
- 模块契约 / 兼容行为 / 管线 → `docs/spec/*.md` 与 `docs/<topic>.md`（`anthropic-compat` / `streaming` / `tool-use` / `request-pipeline` 等）。
- 设计 / 实现计划 → `docs/plan/`，**放仓库内、不放 `~/.claude/plans/`**（便于多会话版本控制、共享、审查）。
- 暂缓项 / 结构性待办 → [docs/todo/deferred-backlog.md](docs/todo/deferred-backlog.md)（含根因 / 当前行为 / 理想架构 / 为何暂缓 / 若做需改什么）。
- 操作性调试知识 → 项目 skill（`.claude/skills/`）；废弃文档 / 完成叙事 → `docs/archive/`。

## 本项目的工作哲学（什么是好的？）

- **长远、泛用优先于短期、将就。** → user-rule `10-core-principles` `long-term-wins` + `60-feat-dev-workflow` `against-yagni-on-feature`。项目增量：架构健康 / 可维护性 / 可观测性 **> 向后兼容、回归风险**；结构性重写**可接受的不做理由仅两种**——债项经查为虚，或重写实证不改善清晰/可扩展/可观测；用户没要求"零改动/字节等价"时**不自设约束**否决正确重构；暂缓项必须完整文档化进 `docs/todo/`。
- **necessity-claim-must-be-falsifiable。** 凡论证主张「不采用 X 就无法满足目标/不变量」，或据此排除其他用户选项，**无论措辞和载体**，均登记为 `necessity claim`。在设计首次交用户或定稿前的**既有评审**中，把该 claim 与替代方案表列入核验清单；表内覆盖更小、同规模异形与更大方案，并逐项写明违反的已冻结目标/契约/不变量及 `file:line`、实验或契约证据。**独立 reviewer 未明确判定 claim 成立前，不得把它作为事实交用户裁决**；收口沿用 `multi-round-before-consensus`（复审无未决 blocker/major），不得由提出者自称「已共识」。本条只增加既有评审的核验项，**不新增评审轮**。
- **可行性与择优分开。** 任一替代方案同样闭合，就撤回「唯一/必须」，按 `one-option-or-the-best-option` 比较全部可行方案，并按 `record-not-adopted` 记录取舍。**较小方案可行只推翻唯一性，不自动胜出**；最终推荐依据长远正确 + 完整的具体收益，不依据「小」或「彻底」的标签。
- **无向后兼容负担。** 本项目对旧版本无硬性兼容义务：破坏性改动是长远正确的形状时可**强制迁移旧→新**、允许短期报错 / 功能不可用，长远计划**不留双轨包袱**（执行期为对照确认临时双轨是合理的）——绝不拿"迁移麻烦"把正确改进降级为"可选/等以后"。
- **有意义且完整 > 最小能交付。** 分基础/高级等多个执行阶段，但每层都朝真正能用推进（`think-proactively`）；"最小能交付"只在执行阶段是合理判断，不用于砍范围。
- **best-complete-solution。** 修根本原因非表面症状（→ user-rule `root-cause-over-patch`）；命名反映实际职责（累积 vs 处理、收集 vs 转换）；Lint 服务于可读性——无益的规则禁用它而非扭曲代码；保留已有的有意义注释；同目录文件互相导入用相对路径 `./foo` 而非 `~/lib/...`。约定见 [docs/coding-conventions.md](docs/coding-conventions.md)。
- **internal-tool-security-posture。** 本项目是开发用途、内部个人使用的工具，默认所有信息**全量暴露**（运维/诊断价值 > 假想泄露风险），绝不为"信息泄露/安全"顾虑阻塞任务或做多余处理；但**不豁免真实安全缺陷**（凭据硬编码、注入、密钥写日志、真实数据丢失）。→ ADR [docs/decisions/2026-07-05-internal-tool-security-posture.md](docs/decisions/2026-07-05-internal-tool-security-posture.md)。
- **richest-data-flow。** 数据以最丰富形式流动、决策交给末端；后端存储必须完整（永不为 DRY/YAGNI/无消费者裁剪），前端可选择性呈现；注入真实流的合成帧必打可辨识标记。→ ADR [docs/decisions/2026-07-05-richest-data-flow.md](docs/decisions/2026-07-05-richest-data-flow.md)。
- **single-source-of-truth-types。** 类型只在产生/拥有方定义一次、消费端 re-export（后端类型在后端定义、前端经 `~backend/*` re-export）。→ [docs/DESIGN.md](docs/DESIGN.md)「类型架构」节。
- **empirical-verification。** 裁决依据是亲手实测（可信度：实测 > 文档推断 > 单方声称；executor/reviewer/文档/记忆都可能错）：flaky/时序测试连跑 10–25 次确认确定性、主张与观测冲突时写最小探针（4141 History API、`ss` 看内核 keepalive）、fake timers + mock 随机源是根因修复非症状掩盖；否定性/通过性/自洽/doc-vs-code 结论**不自证**（先用正样本证检查触达目标、wire 正确性用独立 oracle、文档与代码不一致先确证方向）。**指令类产物（skill/rules）里需要实战检验的断言必须在该 skill 内置自验表 + 记录文件**，让未来会话在正常使用中顺手证伪，绝不写成交接备注或「留给新会话」——范式见 user-level skill `closing-a-development-session` 的 `verification-log.md`（投票规则的唯一权威）与本仓各 skill 的自验表、[[feedback-skill-claims-needing-field-proof-must-self-verify]]。→ skill `empirical-verification` / `verifying-authoritative-claims`、实例 [pass-null](docs/memory/feedback-pass-null-clean-not-self-validating.md)。

## 本项目的工程纪律

- **protect-user-main-server。** **绝不**杀死用户已启动在 **4141 端口**的主服务器实例——不对它用 `kill`/`pkill`/`killall`，也不做任何会终止它的操作（它承载用户的实时使用、History、诊断，误杀不可接受）。**允许**在**其他端口**用默认或自定义配置启动新的测试服务器来验证行为（如 `bun run start --port <非4141>` 或配置 `--port`），用后自行清理**自己启动的**那个测试实例（按 PID 精确 kill，绝不 `pkill`/`killall` 泛杀以免误伤 4141 主服务器）。非服务器命令（`bun run typecheck`/`lint:all`/`bun test`）照常。→ 实测服务器行为见 skill `empirical-verification`（4141 History API 探针）。
- **细粒度、每阶段提交。** 一律显式 pathspec（`git add -- <精确路径>`、`git commit -F <msgfile> -- <精确路径>`），每语义单元一提交、conventional commits、不加模型署名 → user-rule `50-git-workflow`。本项目 2026-06-29 起**无 pre-commit 门禁**（lint-staged/simple-git-hooks 已移除），lint 靠手动 + subagent review → [docs/memory/tooling-lint-staged-revert-blocks-edit.md](docs/memory/tooling-lint-staged-revert-blocks-edit.md)。
- **docs-merge-before-execute（文档先合主线、执行是独立决策）。** 定稿的 plan/spec/ADR/文档（连同其使能基础设施如守卫/脚手架）**先合并回 master 主线**，再单独考虑是否/何时执行——绝不把定稿文档搁在特性分支上等执行。理由：主线是 plan/spec 单一事实源、避免文档滞留分支、执行决策针对已合并文档做。流程：文档定稿（经 subagent 评审）→ 合 master → **停下等用户拍板是否起执行** → 执行走隔离 worktree 新分支。（用户 2026-07-23 确立，`以后都这样`。）
- **测试分档：默认 `test`=快速档、非全后端验证。** `bun run test`（=`test:fast`）只跑 unit+http（~快速反馈）；**pre-push/交付前用 `bun run test:backend`**（unit+it+http 全后端）；`test:it`/`test:pty`/`test:e2e` 按需、`test:ci`=backend+pty+e2e。**前端（`ui/`、`ui-v4/`）测试必须显式单独触发**（`test:ui`/`test:ui-v4`/`test:e2e-ui`），后端档位脚本一律不得聚合前端（2026-07-27 起；原 `test:all`/`test:acceptance` 已删除，守卫在 `tests/infra/test-discovery-matrix.unit.test.ts`）。后缀 `{unit,it,http,pty,e2e}`=真相域**绝不按速度命名**、tier=脚本按后缀组合；改 `.unit→.it` 唯一充分条件是实测确认真集成。unit/it/http/backend/cov 脚本带 `bun test --parallel`（每文件独立 worker、破单进程超线性退化+消除污染型 flaky）；`test:fast`/`test:backend` 进一步走 `scripts/parallel-test.ts`（按耗时缓存 LPT 均衡分片、片内共享缓存，fast ~5.5s vs --parallel 12s；查污染回退 `test:fast:isolated`），pty/e2e 不并行（终端/限流冲突）。retry backoff 经 `abortableDelay` 缩放 seam 在测试下瞬时。L1 守卫 `test-discovery-matrix` 防孤儿。**history-search 的 native 产物默认不构建**（2026-07-28）：`native/history-search/*.node` 是 gitignored 构建产物，`bun install`（`prepare`→`build`）与各测试档位脚本**都不再强制构建它**——否则没有 Rust toolchain 的机器连 `bun install` 都过不去，而任何新建 worktree 里也天然没有该产物。依赖它的测试改为 `describe.skipIf(!isNativeHistorySearchAvailable())`：**有产物就真跑、没有就显式 skip，绝不红**（环境性的红太容易被当成「既有失败」挥手放过——2026-07-28 就发生过一次）。想真跑先 `bun run build:history-search`；`test:ci` 会自己先构建，保证这批测试不会烂掉。**同一交付合并后不因“刚合并”主动重跑全量测试**：沿用该交付在合并前/合并态已有的验收证据；只有用户明确要求或该交付出现实际失败时才复验，后续改动仍须通过各自的交付/合并前门禁。约定见 [docs/coding-conventions.md](docs/coding-conventions.md)「测试组织」、设计见 [docs/spec/2026-07-14-test-tiering-by-speed.md](docs/spec/2026-07-14-test-tiering-by-speed.md)。
- **concurrent-sessions 行级共存。** 本仓库常有并发 agent 会话同时改动，**核心立场：行级共存，绝不整文件退让**（功能不矛盾则两份改动都该落地，绝不以"别人也碰了这文件/怕冲突"把自己该做的推给别会话——退让本身是错）。**isolated worktree 与 shared worktree 两模式并列可行**，区别只在谁做行级仲裁：isolated worktree + 独立分支（放 `./.worktrees/`）各会话 HEAD/index 独立、靠 `git merge` 三方合并**自动合非冲突行**；**shared worktree 是主要高级技巧所在**——同文件不重叠行 + 显式 pathspec commit（`git commit -- <路径>` 取工作区当前内容、免疫 peer 并发 `git add` 的 index TOCTOU race），同文件需 hunk 级只提自己那几行则 `git apply --cached` 过滤 + 无-pathspec commit。→ skill `git-preference:coordinating-a-shared-git-worktree`（shared 树协作）/ `git-preference:isolating-from-a-shared-git-worktree`（隔离 worktree）、[docs/memory/git-commit-pathspec-commits-worktree-not-index.md](docs/memory/git-commit-pathspec-commits-worktree-not-index.md)。
- **monorepo-scc-解环纪律。** 仓库正按 monorepo workspace 拆分（已抽 `packages/{foundation,token,cli}`；`core` 仍是 19 模块巨型 SCC、过渡态）。两条常驻纪律：① **顺手解环**——碰到某 core 模块时，顺手把它对 `state` 的读迁到窄读接口 / 顺手减一条跨模块环边，别让 SCC 横向长新成员；② **拆包用模板**——剥离新域走 [docs/plan/monorepo-split/plan-token-package.md](docs/plan/monorepo-split/plan-token-package.md) 的「通用 DomainPeel Contract」表 + 执行技巧（记忆 `methodology-domain-peel-execution-techniques`：setStateForTests-shim+snapshot-fold 吸收 N 测试零改动、ambient 端口 floor、peek/get 分层、foundation 裸包名需 tsconfig path、边界守卫全 import 形态），下一步排序见 [docs/todo/deferred-backlog.md](docs/todo/deferred-backlog.md)（telemetry/models 边缘域优先、state 解耦第一）。**机器护栏**：`tests/architecture/package-boundaries.unit.test.ts`（包边界：新包拒 `~/`+core，正样本对照）+ `circular-deps-ratchet.unit.test.ts`（SCC 环快照 ratchet：新增环/新成员即 fail、只减不增；降环后 `bun run scripts/update-circular-deps-baseline.ts` 重冻结）。破坏性搬迁走 spec [docs/spec/2026-07-22-monorepo-workspace-split.md](docs/spec/2026-07-22-monorepo-workspace-split.md)。
- **no-destructive-workspace-loss。** 唯一判据是**可恢复性**：会丢失 git 救不回的工作（未提交/未暂存改动、未追踪文件）的操作绝不做，后果可恢复（已提交、git 历史在）的被权限允许时正常做；撤销自己刚做的编辑用**重新编辑**而非回退；**绝不以"清理死代码/无消费者"为名擅自删**。→ 同上 skill。
- **scope-ambiguity-then-ask。** 范围/意图歧义**先用代码+invariant 自解**（答案已被代码钉死就自己定并写推理、别仪式化提问）；确属用户偏好/风险取舍的真分叉才 `AskUserQuestion`，且摆 3-4 个带量化影响的选项而非 yes/no。**方向明确就别停**（执行顺序不是岔路；代码改完→文档同步→提交都直接做，只有矛盾/非此即彼/上下文不足/破坏性不可逆才停）→ user-rule `60` `dont-stop-if-clear`。
- **no-premature-stop。** 不因 turn 长度/token 额度**或编译中间态**（删了函数但调用方还引用）停顿、设检查点或延后，推进到下一个 typecheck 绿或完成 checkpoint 再停；独立的跨文件 Edit/工具一律**消息内并行**，绝不串行。
- **dont-ignore-existing-errors。** 不把已有的测试失败、类型错误、导入缺失当"与我无关"，所有遇到的错误都必须修（放任会掩盖新问题、使回归失去意义）；修前先读实际代码和类型定义确认根因，不猜测。
- **subagent-explicit-rubric。** 审查/复审**永远派 subagent**、多视角对抗，不在主会话直接做（实现在主线、subagent 作独立核验层）；用户长期授权当前及未来会话主动运行任意 subagent、无需逐次询问，**同时运行最多 10 个**（只授权派发与并发数，不扩张远端发布、破坏性操作、外部写入等权限边界）；subagent 默认持 ROI/YAGNI 价值观与本项目冲突，派活必须 prompt 里**显式写裁判轴**（长远正确 + 完整），吸收其客观事实、对其判断谨慎取舍；reviewer 的"无消费者/可安全删除/已通过"等绝对断言**亲自对照代码/实测复核**，行动前读它引用的每个 `file:line`。→ user-rule `40-use-of-agents` + skill `verifying-authoritative-claims`。
- **session-closeout（编排权已外移，本条只留触发与项目落点）。** 会话/阶段收尾（交付/报告/ExitPlanMode/提交前/任务跨会话/上下文将满）是「完成」的一部分，**按序做完无需提醒**。**方法与顺序的唯一权威 = user-level skill `closing-a-development-session`**（九阶段 + 机器可读 contract）；**交接、KICKOFF、派 implementer 前的进度文件协议、agent 容量终态接力 = user-level skill `writing-handover-docs`**。项目 skill `session-closeout` 已于 2026-08-08 并入这两者并删除，别再按旧名找。**本项目的落点**（skill 只写通用方法，具体路径归这里）：plan 迁 `docs/plan/`、实验产物就地 `exp/<topic>/`（README 必含「它没有证明什么」）、评审与草稿报告落 `docs/tmp/`、**派 implementer 的进度文件固定为 `docs/tmp/<date>-<topic>-progress-<slug>.md`**（slug 由派活方在派活时指定、kebab-ASCII、不用 agent id）、**交接件与其 `docs/` 入口在主树改主树提交、绝不进特性分支**（只有代码改动才进隔离 worktree）、记忆索引 `docs/memory/MEMORY.md`（记忆语言约定见「文本风格偏好」）、交接件 `docs/plan/<date>-<topic>/HANDOVER.md` + `KICKOFF.md`（目录式是新约定，历史扁平式不追溯迁移）、隔离 worktree 放 `.worktrees/`（**注意它向上解析主树 `node_modules`，新树缺 gitignored 构建产物会造成稳定假红**）、`$CLAUDE_JOB_DIR/tmp` 逐文件对账、doc-sync 的跨文档 grep 扫 `docs/` 与 L1 守卫测试、测试分档见「测试分档」条、**4141 主服务器禁区见 `protect-user-main-server`**。**两个非收尾触发别被「收尾」语义埋掉**：① 派 implementer 执行多语义 commit、或单 commit 但历时长/需试错的工作时，**派活前**先读 `writing-handover-docs` 的进度文件协议；② agent 报 `400 context window exceeded` / `input exceeds the context window` 时，那是单调不可恢复终态，**停止原 agent、派新 agent 按同 skill 的接力协议接手**，不要继续 `SendMessage`。

### 大特性的工作流角色

- 小改动（单语义单元）直接在主线调研 → 计划 → subagent review → 实现 → subagent review → 提交；大特性走**设计→计划→执行**三步流水线 → user-rule `60-feat-dev-workflow`（spec-driven）。
- 本项目 doc 归属：spec → `docs/spec/`、plan → `docs/plan/`、ADR → `docs/decisions/`、执行者用 worktree → `.worktrees/`。大型（≥1000 行）结构性重构走 RFC-first + commit invariants → skill `large-refactor`。

## 本项目的经验教训

战例库索引在 [docs/memory/MEMORY.md](docs/memory/MEMORY.md)（话题 → 归属地图，深层教训在各 skill/ADR 正文）。几条承重、常驻高价值：

- **通过/空/干净/自洽/doc-vs-code 结论不自证**——先用正样本证检查触达目标、wire 正确性用独立 oracle。→ [pass-null-clean-not-self-validating](docs/memory/feedback-pass-null-clean-not-self-validating.md)。
- **引用缺失符号的编译错误有两种相反修复**——补符号（定义滞后）vs 删引用（aspirational 违契约），按消费者契约 + 独立 oracle 裁决，别反射式"让它编译"。→ [broken-reference-supply-vs-delete](docs/memory/methodology-broken-reference-supply-vs-delete.md)。
- **归一化键/id bug 几乎总在多比较点复发**——grep 全仓逐处修 + 抽单一共享 primitive；正向版用类型系统前置逼出全站点。→ [fix-all-comparison-sites](docs/memory/feedback-fix-all-comparison-sites.md)、[route-variant-to-existing-outcome](docs/memory/methodology-route-variant-to-existing-outcome-and-exhaustive-record-audit.md)。
- **架构图价值轴 = Agent 上下文经济 + 可信度**（非可推导性），逐文件叶子树是负债 → 目录级关系图 + 现状小节 + L1 存在性守卫测试。→ [architecture-map-optimize-agent-context-economy](docs/memory/feedback-architecture-map-optimize-agent-context-economy.md)。
