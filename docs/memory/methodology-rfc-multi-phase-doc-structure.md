---
name: methodology-rfc-multi-phase-doc-structure
description: 大重构 RFC 要交给一组独立实现者并行执行时,文档拆 design/plan/prompts 三层 + per-phase self-contained kick-off + README 集中红线/DAG
metadata:
  type: feedback
---

当一个大重构的 RFC **要交给一组独立实现者分别完成**（而非自己一路实现）时，文档产物拆成**三层物理结构**（仿 `docs/v4/`，活范例见 `docs/archive/2606-landed-rfcs/response-pipeline/`）：

1. **`design.md`（RFC）** — 为什么这么改 + 接口契约（§接口）+ 各 phase 的 Stage 划分 + 与既有 deferred items 的推翻/取代关系（§deferred）。回答"WHY + 契约"。
2. **`<stage>-plan.md`（master plan）** — 每个 Task 的 TDD 步骤 + **factory/锚点表**（被迁移/复用的现有函数 `file:line` + order 常量）。回答"HOW + 锚在哪"。
3. **`prompts/`（per-phase kick-off）** — 每个 phase 一个**可直接粘给独立实现者的 self-contained 文件** + 一个 `README.md` 导航。回答"实现者照着干"。

**每个 per-phase prompt 的固定骨架**（self-contained，假设实现者零项目上下文 + questionable taste）：背景+为什么 / 必读（引用 design+plan+progress）/ 目标+改动锚点（含 factory `file:line` 表）/ TDD 步骤 / 验收 gate（byte-critical 则 golden 逐字节等价为硬 gate）/ 提交指引（精确 pathspec + conventional commit）/ 红线（引用 README，不在每个 phase 重复）。

**`prompts/README.md` 集中承载**：① phase 导航表（含前置）② **阶段依赖 DAG**——标清哪些 phase 格式独立可并行分派、哪条链 byte-critical 严格串行不可拆、共改哪些文件需协调合并顺序 ③ **通用红线**（git checkout 禁令、细粒度暂存、golden gate、subagent 全量工具、三能力守卫等，集中一处各 phase 引用）④ 通用必读清单。

**Why:** 多实现者并行的瓶颈不是"会不会写代码"，是"上下文与契约对不齐"——A 实现者不知道 B 改了共享文件、不知道 order 契约、把 byte-critical 链拆开并行做。三层结构把契约（design）、锚点（plan）、可执行 kick-off（prompts）分离，让每个实现者拿一个 phase 文件即可独立开工，而 README 的 DAG + 集中红线挡住"并行边界踩踏"和"红线在 N 个文件里漂移不一致"。这是 [[feedback-rfc-then-implement-for-large-refactors]] 的**产物组织维度**（那条记流程：brainstorm→RFC→≥3 轮对抗 review→实现；本条记交付物长什么样）。

**How to apply:**
- 自己一路实现的小重构**不需要**三层——直接 RFC + 主线实现即可。三层是为"分派给多人/多会话"才值得的开销。
- byte-critical 迁移类 phase（如响应改写迁 registry）：plan 里必给 **factory 锚点表**（复用现有核、不重写算法，呼应 [[feedback_prefer_mature_libs_for_scoped_components]]），phase prompt 里必带 **golden-fixture-pre-capture** gate（[[methodology-golden-fixture-pre-capture]]）+ commit-invariants（[[methodology-commit-invariants]]）。
- DAG 必须显式标注：哪些 phase 因 byte-critical 顺序契约**不可并行**（如"原子迁一组改写"不能逐条拆），哪些格式独立可并行但共改同一文件需排合并序。
- 收尾 phase 固定包含 whole-domain audit + 文档同步（[[feedback-completion-updates-docs]]）+ 用决策数据重走遗留 open question（[[feedback-give-user-decision-data-not-pitch]]），而非自动启动下一 Stage。
- `git mv` 重组已有扁平文档时，记得修相对路径引用（`../`/`../../` 层级随目录深度变）并核验解析。

不要把 rfc / spec / plan / prompt 混在一个扁平目录或单文件里——用户明确要求分层（2026-06-20）。
