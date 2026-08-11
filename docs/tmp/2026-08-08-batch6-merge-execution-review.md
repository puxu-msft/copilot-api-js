# Batch 6 merge execution B 级评审

- **评审范围**：项目仓提交 `e7a9cadb` 与全局仓提交 `7fa63ba`；重点核验原 `.claude/skills/session-closeout/SKILL.md` 的逐句迁移、两个 user-level skill 的触发与契约、项目侧落点、跨仓库指针及 rule 改指。
- **已读取／执行的证据**：删除前 204 行原 skill、两个全局 skill 及生成源／测试、项目 CLAUDE.md／归档／模板／重定向、rule 61、dependencies；执行 render check、7 项 unittest、全仓断链扫描与依赖解析。两个仓库均按绝对路径读取，未修改被评审对象。
- **总体 verdict**：存在 blocker；不可定稿。
- **blocker 数量**：2。

## 事实性发现

[major] `/home/xp/.claude/skills/writing-handover-docs/SKILL.md:22` — 全局 skill 仍硬编码 `copilot-api-js` 的状态入口 — 该 skill 对所有项目可发现，正文却指示读 `docs/DESIGN.md`“活的架构现状”及 spec／ADR；其他项目照做会访问不存在或语义不同的路径。这也是 B 级要求查找的项目专有泄漏。— 把该句移回项目 `/home/xp/src/copilot-api-js/CLAUDE.md:56` 或项目文档路由；全局正文只保留“从项目 CLAUDE.md 定位具名权威来源”的通用纪律。

[major] `/home/xp/src/copilot-api-js/docs/plan/templates/handover.md:5,7`、`/home/xp/src/copilot-api-js/docs/archive/2026-08-08-session-closeout-verification-log.md:11` — 搬迁后的 live 模板与归档证据仍含无效的相对 `SKILL.md` 链接 — 在新目录中它们分别解析到不存在的 `docs/plan/templates/SKILL.md` 与 `docs/archive/SKILL.md`；模板还把不存在文件的 §6 称为权威，接手者无法找到新协议。— 改成具名 user-level skill `writing-handover-docs`（不要伪造仓内相对路径），归档件第 11 行改成历史时点说明或指向全局 log；同步核对模板中的旧 §1／§3／§6 文字引用。

[blocker] `e7a9cadb^:.claude/skills/session-closeout/SKILL.md:12,170-200` — C1“零内容丢弃”失败：原 skill 的强制实战自验触发与 V1–V19 行为断言没有迁入任一新 skill 正文（V1 召回、V2a 顺序例外、V2b 接手可用、V3 模板可填、V4 peer 探针、V6 双件同步、V7 两个提交时点、V8 正交视角、V9 正控、V10 上游对账、V11 派活前召回、V12 每 commit 更新、V13 中断接续、V14 写入权转移、V15 逐条落盘、V16 property 对账、V17 紧急例外、V18 400 接力、V19 tmp manifest） — `/home/xp/.claude/skills/closing-a-development-session/verification-log.md:3` 反称“SKILL.md defines the claims”，但当前 SKILL.md 全文没有 self-verification／log 入口；该 log 的 V1–V5 也未写出多数原断言，项目归档 `/home/xp/src/copilot-api-js/docs/archive/2026-08-08-session-closeout-verification-log.md:5` 又明确不再追加。未来会话既不会被要求落票，也看不到进度文件触发／交接可接续性／接力数据保护等原 V11–V19 验法。— 把通用化后的原断言按归属迁入两个全局 skill，并在各正文设可达的“使用后记录”触发；项目 archive 只保留旧票，不能替代活的 claim 定义。

[blocker] `e7a9cadb^:.claude/skills/session-closeout/SKILL.md:71,83-90,98` — C1 另有三组可独立纪律无归宿 — 原文要求交接件在主树修改、默认采用“判据证伪＋接手方第一人称走查”两视角，并把每个 implementer 的 progress 文件固定到 `docs/tmp/<date>-<topic>-progress-<slug>.md`；新 `/home/xp/.claude/skills/writing-handover-docs/SKILL.md` 未保留这些约束，项目 `/home/xp/src/copilot-api-js/CLAUDE.md:56` 也只说“评审与草稿报告”落 `docs/tmp/`。项目模板 `/home/xp/src/copilot-api-js/docs/plan/templates/handover.md:114` 反而引用“两视角”却不再定义。— 在项目 always-on 落点明确主树／progress 路径，把两视角定义迁入通用 handover skill。

[major] `/home/xp/.claude/skills/closing-a-development-session/SKILL.md:253` — 新并入的“整改后一律 resume 原 reviewer”与既有 B 级裁决规则冲突 — `/home/xp/.claude/rules/00-user/30-use-of-agents.md` 明定 level-B ruling 或已升级分歧不得复用卷入 reviewer；当前无条件措辞会让所有项目在 B 级处置时选错裁决者。— 改为引用 `adopting-agent-findings` 的分级路由：仅原规则允许的复审恢复原 reviewer，B 级／升级分歧换未卷入裁决者。

## 核验结论（未形成 blocker／major 的项目）

- **C2 通过**：`python3 render_skill.py --check` 退出 0；`python3 -m unittest discover -s tests` 为 `Ran 7 tests ... OK`。description 三个指定子串均存在；`## 1..9` 唯一且按序；`closeout-contract` 块唯一。该绿只证明生成一致性与结构 contract，不证明 C1 的语义迁移完整性。
- **C3／C4**：两个 skill 的方法主体未发现互相矛盾的重复版本；收尾编排与交接／progress／relay 的切分本身合理。progress 与 relay 虽远离“写交接”，但 `/home/xp/.claude/skills/writing-handover-docs/SKILL.md:3` 给了两个独立的非文档触发，项目 `/home/xp/src/copilot-api-js/CLAUDE.md:56` 又提供 always-on 触发；召回入口足够。例外是上述丢失纪律与 `:203` 的过窄 scope 结语，后者单独看不足 major。
- **C5**：`rg` 命中 106 个文件；97 个属 plan／RFC／tmp／archive 等历史记录，live 指针总体已改指。`dependencies.json` 的 4 个 `scope=user` 路径均按 `/home/xp/.claude/skills/` 解析存在且 frontmatter 匹配；真断链是上述迁移模板／归档相对链接及仍把已删除 skill 称为范式的 live memory。
- **C6 通过**：`/home/xp/.claude/rules/agents/61-agent-collaboration.md:13` 的新目标确实含两类容量终态（5 MiB 读取闸门与 context-window 400）及五步接力协议，见 `/home/xp/.claude/skills/writing-handover-docs/SKILL.md:180-195`。
- **C7**：`/home/xp/src/copilot-api-js/CLAUDE.md:56` 仍是 always-on 触发条，两个非收尾触发未被埋掉；项目落点覆盖 plan、experiment、report、memory、handover、worktree、job tmp、doc-sync、测试档位、4141。缺失的是上述 progress 精确路径、交接主树约束与默认评审视角。
- **“它没有证明什么”**：7 项 contract 测试未证明零内容丢弃、触发有效性、跨 skill 语义一致性或链接可达；归档旧票也未证明新 skill 的新 claim。`/home/xp/src/copilot-api-js/docs/plan/2026-08-08-closeout-skill-merge/EXECUTION.md:21` 把“原日志原样迁档”表述成“零内容丢弃的落点”，把保存历史证据误当成保存活的自验契约。

## 最终汇总

- **总体 verdict**：存在 blocker；不可定稿。
- **blocker**：2。
- **major**：3。
- **建议修复路由**：由 `gpt-souls:instruction-smith` 修复两个全局 skill／项目 always-on 指针与迁移模板，再由未卷入第三方重新做 B 级复评。
