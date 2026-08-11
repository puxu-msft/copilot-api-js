## C3 · 映射完整性

本节按语义条目核对，而不是把映射表中的宽泛行号范围本身视为“已映射”；否则无法机械证明“零内容丢弃”。本轮范围仅为 `/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:1-100`。

- `/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:1-6` — frontmatter 与标题没有映射行；尤其 description 的完整触发面、两个非收尾触发和“可执行细节只在正文”契约未在映射表中逐项归属。执行件另有“两个非收尾触发”散文，但它不覆盖其余 description 内容，也未把 frontmatter 作为源条目登记。
- `/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:8` — #1 只登记“收尾是完成的一部分”，遗漏该行的权威拓扑：`CLAUDE.md` 只负责 always-on 触发，本 skill 是 how-to／判定纪律／模板的单一源，战例归 `feedback-*` memory。
- `/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:15-16` — #4 登记多视角与机械对账，却未登记“采信声音权威前也必须独立核验”、显式价值轴，以及对“无消费者／已通过／可安全删除”等绝对断言必须亲自读其 `file:line` 并实测复核。
- `/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:35-43` — #6 只列四档状态、实验边界、collision guard 与伴随文件命名，遗漏 plan 归属逐文件核验、`git mv` 保历史、标题派生 kebab-ASCII slug、重叠 plan“只搬不删不去重并交用户定夺”、实验 README 的“回答什么／结论／复跑配方”，以及状态结论的证据源与否定性正样本门。
- `/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:50-51` — #7 把整段归 G stage 2/5，但未处置项目专有失败实例及其 archive provenance：11 个未 disposition 文件、3.4 MiB patch、69 KiB status、7 个 commit-message 文件应明确留项目证据侧或迁入全局实例，不能靠“已有等价内容”静默丢弃。
- `/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:58-59` — #9 只登记 pathspec／stat／commit 格式，遗漏“阶段完成即主动 commit、贯穿全程、不询问用户”和“收尾必须把步骤 2–4 产生的文档／plan／memory 一并提交”。
- `/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:70-71` — #10 登记交接位置与紧急纠错，却未登记该段末尾的代码改动隔离边界及两条项目实测：`.worktrees/` 会向上解析主树 `node_modules`，新树缺 gitignored 构建产物会稳定假红；执行件的 P 完整清单仅写“.worktrees/ 布局”，覆盖不了这两条。
- `/home/xp/src/copilot-api-js/.claude/skills/session-closeout/SKILL.md:95-98` — #13 登记二分判据、一 agent 一文件和 frontmatter，但遗漏协议的经验依据（中断时 3 个 commit 保住、4 个未提交文件意图丢失）及命名细则：slug 由派活方预先指定、不能用 agent id、必须放文件名后缀、现有 9/9 文件排序形状与“尚无同形先例”的边界。
