# WebSearch 收尾文档／协议独立评审

- **评审范围**：当前未提交文档改动及其引用的 WebSearch 翻译生产代码、测试、Git 对象与全局 Git skill。
- **总体 verdict**：修复 major 后可进入下一阶段。
- **blocker 数**：0。
- **双视角覆盖证据**：
  - **机械核对**：逐文件对比 HEAD→工作树改动；扫描 `web_search_preview`／`web_search`／`tool_choice` 残留；对账三条生产翻译腿及测试；核 Git merge first-parent stat、路径数、source／target patch-id；对账 memory frontmatter／正文／MEMORY 索引／全局 skill；扫描占位链接、状态标记、未完成 checkbox 与 verification log。
  - **第一人称执行**：模拟 Anthropic→Responses 的 builtin／function／过滤／named／any 分支，Responses→Anthropic 与 Responses→CC 的降级分支；模拟接手者按“landed plan”判断是否仍需执行；模拟收尾者依据 verification log 决定独立审计是否已完成。

## 事实性发现

[MAJOR] /home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/plan/2026-07-14-anthropic-responses-direct-bridge/plan.md:3,39,56-86,118-163,211-227 — 已 landed 的 plan 同时把任务写成未来 gated／未执行。
证据：行 3 声称 Phase 0-7 “全部完成”，但 Phase 0/1/2 的步骤仍为 `- [ ]`；行 39、211-227 仍写“待 Phase 0 FINDINGS 敲定”与未来开工时展开。正确状态（全部完成）会被这些执行指令判成未完成，接手者会重复起真 GHC 探针或重做阶段。
修复建议：按最终事实把已完成步骤勾为 `[x]`，将 gated／待敲定段改成历史实施结果并链接具体 FINDINGS／commit；若保留原计划快照，则整份明确标成不可执行历史并把终态清单放到单一活入口，不能仅靠顶端一句覆盖相反正文。

[MAJOR] /home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/memory/reference-worktree-bun-add-needs-main-tree-install-after-merge.md:57-63 — memory 在声明全局 skill 为方法 SSOT 的同时复制了一套可执行集成／恢复规范。
证据：行 61 规定 ancestry 命令、cherry-pick 决策与 patch-id gate，行 63 规定 reset／revert 分支；同一规范已在 `/home/xp/.claude/my/git-preference/skills/isolating-from-a-shared-git-worktree/SKILL.md:37-68` 维护，且全局 skill 还有 memory 未复制的 non-empty patch-id gate、merge net-effect postcondition、empty/merge/multi-commit 边界。两份会独立漂移；MEMORY.md:3 又声明索引是纯引用层。
修复建议：memory 只保留本轮事故证据、精确数字与“何时触发”钩子，方法直接指向全局 skill 对应节；删除本地 `How to apply`／恢复配方的规范性复述。同步精简 frontmatter description 与 MEMORY 索引为触发词＋动作内核＋skill 指针。

[MAJOR] /home/xp/src/copilot-api-js/.worktrees/anchor-alloc/.claude/skills/session-closeout/verification-log.md:54-60 — 收尾日志在本轮独立审计已实际执行后仍以“未执行”作为终态，审计闭环不可追踪。
证据：行 60 诚实记录了主会话当时受约束、未调用 Agent；但本报告即为随后执行的独立文档／协议评审，且已核 C1-C6、生产代码、测试与 Git 对账。若按当前日志执行，接手者仍会把审计判为 pending；日志也尚未记录本轮 verdict、findings 与 REPORT_FILE 证据。
修复建议：保留行 60 作为历史事实，紧随追加“限制已解除／审计已执行”的新记录，引用本报告绝对路径，写明 0 blocker、3 major 及未投证实票的原因；major 修复复审后再记录最终 adjudication，不能把作者自评写成证实。

## C1-C6 核验结论

- **C1 通过**：`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/openai/translate/anthropic-to-responses-request.ts:338-348,405-429` 产出裸 builtin 声明／choice；本轮 transcript 的 live 探针记录 HTTP 200、真实 `web_search_call`、History 同类 wire 且无 hook synthetic。RFC:178 的证据范围未超出“该精确请求被 GHC 接受”；没有泛化成所有 builtin／参数都受支持。
- **C2 通过（协议正确性）**：Anthropic→Responses 同源／存活性见实现 `:355-393,405-429` 与测试 `tests/openai/anthropic-to-responses-request.unit.test.ts:133-195`；Responses→Anthropic 见 `responses-to-anthropic-request.ts:417-451` 与测试 `:69-103,360-393`；Responses→CC 见 `responses-to-cc-request.ts:695-735` 与测试 `:106-162`。目标套件实跑 `86 pass / 0 fail`。错误状态（悬空 builtin／required／named）均有负样本，正确状态（function/custom sibling、auto/none、有效 named）有正样本，未见 false-green／false-red。
- **C3 通过**：`git diff 49adb9e5^1 49adb9e5 --shortstat` = `43 files changed, 6875 insertions(+), 231 deletions(-)`，name-only=43；正确提交 `631578b2` path set=7；源 `1d082158` 与目标 `631578b2` 的 stable patch-id 同为 `beaae9ed993497b265ab138c393d25f400d1b726`。
- **C4 除上述 plan major 外通过**：RFC／handoff／FINDINGS／DESIGN 的活契约均为裸 `{type:"web_search"}`；`web_search_preview` 仅作为明确否定的历史错称残留，没有 current-wire 漂移。
- **C5 除上述 SSOT major 外通过**：frontmatter `name` 与文件名一致，description／正文“五向”／MEMORY 索引一致；YAML frontmatter 完整。
- **C6 除上述审计闭环 major 外通过**：现有 V1/V9/V10 均按投票规则记“证伪／数据不足”，未把作者自评算证实；行 60 对当时未执行 Agent 审计的历史记录诚实。

## 其他机械扫描

- `git diff --check`／no-index diff check 未发现新增空白错误。
- 未发现替换导致的重复块或静默删除。
- `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/exp/anthropic-responses-direct/FINDINGS.md:99` 存在历史占位链接 `[W2 探针](#)`，属 minor，按本轮门槛不列 finding。
- 结构怪味：`plan.md:3,39-227`“终态声明覆盖相反执行正文”与 memory 方法双源均已作为 major 处置；其余目标范围未见需上报的 BLOCKER／MAJOR 结构怪味。

## 主观建议

未提出主观建议。

## 主会话处置

- **Plan 状态矛盾：采纳（C）**。Phase 0–2 checkbox 全改 `[x]`，Phase 0–6 标题统一已完成；“待 Phase 0／gated／开工时展开”改为历史 gate 与实施结果，并链接 FINDINGS。机械扫描 `^- [ ]` 与未来 gate 词均归零。
- **Memory 双 SSOT：采纳（C）**。第五方向只保留事故证据、43/6875/231 数字与触发症状；删除 ancestry/cherry-pick/patch-id/reset 配方，执行方法只指向 `git-preference:isolating-from-a-shared-git-worktree`。MEMORY 索引同步改为症状 + 两个 skill 指针。
- **Closeout log 陈旧：采纳（C）**。保留“初始未授权”的历史时点，追加“用户授权后两路独立审计已执行”、报告路径和当前 verdict；最终 protocol verdict 待 Round 2 后追加，不投作者证实票。

## Round 2

待原 reviewer 复审。

### Round 2 复审结果

- **评审范围**：仅复核 Round 1 的 3 条 major 及其整改相邻契约。
- **总体 verdict**：修复剩余 1 条 major 后可进入下一阶段。
- **blocker 数**：0；**major 数**：1。
- **双视角覆盖证据**：机械扫描 plan 的 unchecked／future gate／完成态词，memory 的方法性关键词与 skill 指针，closeout log 的历史时点／审计状态／投票级别；第一人称模拟接手者按 plan 收尾、按 memory 集成分支、按 log 判断审计是否闭环。

#### 事实性发现

[MAJOR] /home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/plan/2026-07-14-anthropic-responses-direct-bridge/plan.md:287-289 — 已存在且顶端声明 landed 的 ADR 仍被列成未来收尾动作。
证据：行 3 已链接现存 `2026-07-14-lossless-per-pair-bridge.md` 并称 Phase 0-7 全完成；但 traceability 表仍写“收尾（landed 后写 ADR）”，行 289 又命令“写 ADR”。接手者照正文执行会重复创建／重写同一 ADR；主会话所称“未来 gate 词归零”也被该命中反证。
修复建议：把 OQ4 行改为“已完成／ADR 链接”，把行 289 改成历史实施结果；再机械扫描所有 `待|后写|收尾（landed 后）|开工|gated` 并逐条 disposition。

#### 已闭合项

- **原 Plan major：部分闭合**。Phase 0-7 标题与 checkbox 已统一完成，Phase 0 gate 已明确为历史；仅上述 ADR 收尾残留未闭合。
- **Memory 双 SSOT major：已闭合**。`reference-worktree-...md:57-63` 只保留事故证据与触发动作，执行规范唯一指向全局 skill；`MEMORY.md:64` 同步为症状＋两个 skill 指针，未复述 ancestry／patch-id／恢复配方。
- **Closeout log major：已闭合到当前时点**。`verification-log.md:60-61` 保留初始未授权历史，同时记录授权后两路审计、报告路径、Round 1 verdict 与“不投证实票”；在本 Round 2 结束前把 protocol verdict 标为 pending 是准确的，待主会话据本节追加“Round 2：剩 1 major”。

#### 主观建议

未提出主观建议。

## Round 2 处置

- **ADR 未来动作残留：采纳（C）**。Traceability 的 OQ4 行改为已完成并链接现存 ADR；末尾“landed 后写 ADR”改为历史收尾结果。全 plan 的未来执行词重新机械扫描。

## Round 3

待原 reviewer 复审。

### Round 3 复审结果

- **评审范围**：仅复核 Round 2 剩余的 plan 状态 major。
- **总体 verdict**：**可定稿**。
- **blocker 数**：0；**major 数**：0。
- **双视角覆盖证据**：机械扫描全 plan 的 `待|后写|收尾（landed 后）|开工|gated|[ ]` 与全部完成态标记；第一人称从顶端状态、Phase DAG、各阶段标题／checkbox、traceability 到收尾结果顺序执行，确认没有入口要求重跑已完成阶段或重写 ADR。

#### 事实性发现

未发现 BLOCKER／MAJOR。Round 2 剩余 major 已闭合：`plan.md:287` 将 OQ4 标为“✅ 已完成”并链接现存 ADR，`:289` 改为“收尾结果：ADR 已落地”，与 `:3` 的 Phase 0-7 全完成一致。

扫描命中 disposition：
- `plan.md:5` 的字面量 `- [ ]` 位于历史 worker 格式说明中，不是实际 unchecked task；全文件实际任务均为 `[x]`，不会把正确完成态判成未完成。该旧模板措辞最多属 minor，不影响定稿。
- `plan.md:39` 的“历史 gate（已关闭）”与“不再是待执行入口”明确否定未来动作；不是冲突。
- 未命中“后写”“收尾（landed 后）”“开工”“gated”或实际 `[ ]` task。

#### 主观建议

未提出主观建议。

### Round 4 最终日志复核

- **评审范围**：仅核对 `.claude/skills/session-closeout/verification-log.md:54-61` 的两路独立评审闭环记录。
- **总体 verdict**：**可定稿**。Blocker：0；Major：0。
- **双视角覆盖证据**：机械对账两份报告的路径与逐轮 verdict；第一人称按日志判断“初始未审→授权后审计→整改复审→最终放行”的时间线。
- **事实性发现**：未发现问题。协议/doc↔code 路径与 Round 1 `0 blocker / 3 major`、Round 2 剩 1 major、Round 3 `0/0 可定稿` 均与报告一致；instruction/Git 路径与 Round 1 2 major、Round 2 剩 1 major、Round 3 可定稿一致。
- `verification-log.md:60` 保留初始未执行审计的历史时点，`:61` 明确记录限制解除后审计已执行并闭环；二者顺序无矛盾，未重新引入原“终态仍显示未审”的 major。
- `verification-log.md:61` 明确“本轮编辑该 log，按投票规则不投证实票”，没有把作者自评计作证实。
