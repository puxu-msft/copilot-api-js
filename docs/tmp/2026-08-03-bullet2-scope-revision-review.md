# `c12a635` bullet 2 范围修订评审

- 评审范围：`/home/xp/.claude` 冻结提交 `c12a635` 中 `proving-where-a-command-ran` skill、配套中英 always-on 规则与 `verification-log.md`。
- 裁判轴：长远正确 + 完整；同时检查 false-green 与 false-red。

## 已读取／执行的证据

- 直接读取 `c12a635b50060ffcbc36484d9538c552d7bc2488` 的四个被审文件、提交 diff，以及三份背景材料；行号均按冻结对象计。
- 对触发性措辞做全文件检索，不只检查提交说明点名的行。
- 边界探针：同一条 `git -C /home/xp/.claude status --short --untracked-files=no` 分别从 `/home/xp/.claude` 与 `/home/xp/src/copilot-api-js` 启动，输出 hash 均为 `e3b0c442…b855`；裸 `git show c12a635` 在前者返回完整 SHA，在后者以 `unknown revision`、`rc=128` 失败。

## 总体 verdict

**修复 major 后可进入下一阶段。Blocker：0。** 修订确实修正了 canonical bullet 2 与 always-on `root-each-bash-call` 主入口，但同一 skill 的 gate 内仍有宽窄冲突，frontmatter 与 sibling always-on 条目仍构成第二触发面；V1R 明细也没有按新模板落地。

## 事实性发现

[major] `/home/xp/.claude/skills/proving-where-a-command-ran/SKILL.md:103,138` — gate 内部仍同时维护两套范围 — 第 103 行要求“Every load-bearing Bash call”重述 gate，第 138 行只要求结果 tree-dependent 且支撑 decision/claim 的命令重述；第 28 行只能说明它们不扩张进入 gate 的触发集，不能让两条互相矛盾的 gate 内义务同时成立。进入 gate 后，一条 cwd-independent 但 load-bearing 的 hash/read 在第 103 行下必须 gate、在第 138 行下不必，仍会产生 false-red 分类分歧。修复建议：第 103 行也使用与 canonical bullet 2 相同的可观察谓词，或明确定义 `load-bearing` 在本文中仅指 tree-dependent 结果；不要靠第 28 行的元说明遮盖正文冲突。

[major] `/home/xp/.claude/skills/proving-where-a-command-ran/SKILL.md:3,23-28` — frontmatter 不是可有意保留的窄摘要，而是尚未闭合的 discovery trigger — description 首句只覆盖“result only means something…”并用 isolated worktree／second clone／sandbox／scratch dir 限定场景；canonical bullets 还包含任何 specific-tree delegation、cwd-sensitive cleanup 与 reset-notice investigation。未来 agent 在加载正文前只能看到 description，第 28 行的“canonical”声明对未加载 skill 的会话不可达，不能阻止 false-negative。此前 arbiter 也已在 `/home/xp/src/copilot-api-js/docs/tmp/2026-08-03-v1r-scope-arbitration.md:32` 指出它比 bullet 1 窄。修复建议：让 description 覆盖四类触发的上位症状，但仍只写 when-to-use，不复述 gate 流程。

[major] `/home/xp/.claude/rules/00-user/20-tool-use-preference.md:12,16`、`/home/xp/.claude/rules/00-user_zh/20-tool-use-preference.md:14,18` — sibling always-on 条目重新引入了“任意结果支撑论断都 gate”的旧宽口径 — `root-each-bash-call` 行已加 tree-dependent 限定，但 `bind-delegate-directory` 紧接着仍写 “When its result is about to support a claim, run the gate”／“它的结果要支撑论断，仍走…gate”，没有同一限定。跨两仓绝对路径读取的 delegate 正是裁决中被排除的第七处 exposure；按这条仍会被收回。修复建议：两语种 line 16/18 同步引用 canonical predicate，或明确该句只适用于 delegate 结果的 provenance 确实会随执行树变化时。

[major] `/home/xp/.claude/skills/proving-where-a-command-ran/SKILL.md:24`、`/home/xp/.claude/skills/proving-where-a-command-ran/verification-log.md:79-85` — `why tree-dependent` 仍是理由栏，不是稳定判据；`git -C <abs> status` 暴露了歧义 — 固定参数时，`git -C /home/xp/.claude status` 从两个 shell cwd 得到相同结果，ambient cwd 不能改变目标，因此按此 skill 要防的 wrong-landing 风险应在 trigger 外；但它确实“读的是某棵树的状态”，审计者也能如实填写“状态随目标树而变”而把它计入。当前字段未要求做 ambient-cwd 反事实，故不能压住凭感觉分类。修复建议：把结果类判据改成“保持命令及其绝对参数不变，仅改变 ambient shell cwd，结果的值／解释或所选对象是否可能改变”；记录 candidate cwd、被选对象与反事实后果。`git -C <abs> status` 因固定 selector 在外，裸 `git status` 在内。

[major] `/home/xp/.claude/skills/proving-where-a-command-ran/verification-log.md:25,33-38,75-85` — tally 与 V1R aggregate 文案表面对账，但不存在模板要求的六条 exposure 明细，明细 SSOT 尚未建立 — tally 写 `6 exposures / 6 misses`，记录区也只重复同一个 aggregate，并用“all six”概括；没有六个 transcript line/tool id、逐项 trigger、`why tree-dependent`、boundary 与 invoked yes/no。模板第 79-81 行明确要求 one line per exposure，因此无法从 records 独立重算 6，提交说明所称“追加逐条记录”不成立。修复建议：把裁决已保留的六次 delegation 各写一条完整明细；再从这六条生成 aggregate 与 tally。

[minor] `/home/xp/.claude/skills/proving-where-a-command-ran/SKILL.md:24` — 将裸 `git show <sha>` 无限定地列为 cwd-independent 过宽 — 实测同一命令在 `/home/xp/.claude` 成功、在项目仓库失败，说明它至少依赖 cwd 做 repository discovery；只有固定绝对 repo selector、完整 object id，并约束 replace/config 等 repo-local 解释因素后，才适合作为稳定反例。此处虽然错树通常变成显式失败而非 false-green，但示例字面会误导审计者。修复建议：改为 `git -C <absolute-repo> --no-replace-objects show <full-object-id>` 一类真正固定 selector 的例子，或只保留绝对路径读取／内容 hash。

## 已核实但不构成发现

- 中英文本次改动语义等价：英文第 12 行与中文第 14 行同样收窄，英文第 16 行与中文第 18 行也同样保留了上述过宽缺陷；未发现单侧分岔。
- bare `git status` 若用来证明“当前目标 branch clean”，ambient cwd 可选择另一仓库，命中 bullet 2；`git -C <abs> status` 固定目标，不应仅因结果描述一棵树就命中。

## 结构怪味扫描

- 范围：skill 的 description／Overview／canonical bullets／gate／self-verification、两份 always-on rule、V1R tally 与 records。怪味类型：同一触发谓词多源复述且强弱不一；处置：本轮不修改，以上 5 个 major 分别要求归一 canonical predicate、消除派生视图双写。

# `483fcda` 复审

- 评审范围：复核上一轮 5 major + 1 minor、两项附加修订，以及反事实判据的双向鉴别力。
- 已执行证据：读取冻结提交四文件及完整 diff；机械重算 V1R 明细；从两个 cwd 对跑 bare `git status`、absolute-path `rg`，并构造“claim-bearing digest 固定、仅诊断 cwd 改变”的反例。
- 总体 verdict：**修复 major 后可进入下一阶段。Blocker：0；Major：3；Minor：0。** 上一轮六项中，明细对账、frontmatter、gate `:103`、双语 rule 与 `git show` 示例均闭合；反事实判据仍有一条 false-red，另有一处旧宽口径和一次不完整 reset。

## 事实性发现

[major] `/home/xp/.claude/skills/proving-where-a-command-ran/SKILL.md:24`、`/home/xp/.claude/skills/proving-where-a-command-ran/verification-log.md:97` — 反事实仍把“整条命令任一输出变化”与“支撑论断的结果变化”混在一起，会产生新 false-red — 实测 absolute-path `rg` 从两个 cwd 得到同一 hash，正确排除；bare `git status` 得到不同 hash，正确纳入。但构造命令同时输出 cwd 诊断和绝对文件 digest 时，两次整体输出 hash 不同，而真正支撑“文件内容为何”的 digest 完全相同；按当前“can the value … change”字面仍会误收。修复建议：反事实比较**实际用于支撑 claim 的投影**，问“ambient cwd 能否改变所选对象或 claim-bearing value/interpretation”，忽略不参与该 claim 的诊断字段。`rg <absolute-path>` 证明该绝对范围无命中时在外；`bun test --config <abs>` 只有在 test discovery、module resolution、配置相对路径等也全部不受 cwd 影响时才在外。

[major] `/home/xp/.claude/skills/proving-where-a-command-ran/SKILL.md:161,163` — Common mistakes 仍残留第三套无条件宽口径 — 第 161 行“delegated agent … never showed gate output → No printed provenance, no claim”会再次否定第 24 行排除的 cwd-independent delegate 结果；第 163 行却明确说 absolute-path／commit-object evidence survives untouched，两句互相冲突。第 28 行的 canonical 元声明不能替代正文归一。修复建议：第 161 行限定为“tree-dependent green”或“命中 canonical bullet 1/2 的结果”。

[major] `/home/xp/.claude/skills/proving-where-a-command-ran/verification-log.md:24,68-72` — description 变更后的 V1/V1R reset 没有真正执行 — 第 70 行说 cohort 不得跨 revision、未来从 revision commit 重锚，但第 68 行标题仍冻结旧窗口 `[2026-08-03T08:44:41Z, 2026-09-02T08:44:41Z)`；更严重的是 tally 仍保留 session `99de83ce` 的 V1 confirming，而该观察发生在新 description 生效前，不能给新度量对象投票。修复建议：把旧 V1 票与 6/6 一并移入带 text-version 的历史区，当前 tally 清零；将新 cohort 明确锚到 `483fcda` 的 committer time `2026-08-03T21:09:00Z` 并给出对应 cutoff，删除旧窗口标题的现行权威外观。

## 已核实闭合项

- V1R 记录区有 6 个不同 tool_use id、6 个 bullet-1 delegation、6 个 `invoked: no`；可独立重算为 `6 exposures / 6 misses`，与 aggregate、tally 一致，第七候选的排除理由也已记录。
- 中英 always-on 两份语义等价；description 已覆盖四类 canonical trigger；`SKILL.md:103,138` 当前一致。

## 结构怪味扫描

- 范围：description、canonical bullets、gate、Common mistakes、双语 rules、V1/V1R lifecycle。怪味：范围谓词在 Common mistakes 残留无条件复述；度量对象变更未原子更新 window 与 tally。处置：本轮不修改，以上 2 个 major 分别要求归一与原子 reset。

# `9c3e996` 收口复审

- 总体 verdict：**修复 major 后可进入下一阶段，不能收口。Blocker：0；Major：2；Minor：1。** `SKILL.md` 的 claim-bearing projection 与 Common mistakes 已闭合，但 log 未同步，且本提交自己再次改变 trigger text 后仍锚旧 commit。

## 事实性发现

[major] `/home/xp/.claude/skills/proving-where-a-command-ran/verification-log.md:97` — 反事实的操作协议仍是旧的“整值／解释／对象”判据，形成第四套口径 — `SKILL.md:24` 已要求比较 claim-bearing projection，但 log 的审计指令仍写“can the value, the interpretation, or the object selected change? Yes → exposure”，会把“cwd 诊断变、论断所据 digest 不变”的已知 false-red 再收回来；而 V1R auditor 实际按 log 执行。修复建议：同步为选中对象或 claim-bearing projection，并在 line shape 中要求记录该 projection。

[major] `/home/xp/.claude/skills/proving-where-a-command-ran/verification-log.md:68-70` — 新窗口锚点在创建它的同一提交中已经陈旧 — `9c3e996` 修改了 canonical bullet 2 的 trigger 判据，却仍称 `483fcda` 是“last revised the trigger text”；`9c3e996` 的 committer time 为 `2026-08-03T21:13:21Z`。因此当前窗口头 4 分 21 秒按旧反事实、后续按新 projection，正是协议禁止的混词版本。修复建议：锚到 `9c3e996`（若再改 trigger，则锚最终修订 commit）并据其时间重算 30 天 cutoff。

[minor] `/home/xp/.claude/skills/proving-where-a-command-ran/verification-log.md:24,48` — 旧 V1 票不应留下“下次 cohort 可转移”的悬案 — 该观察对应 test/mutation acceptance，旧、新 trigger 语义都覆盖，但 V1 测的是 description 是否在运行时自动浮现；description 文本已改，旧观察不能实证新文本的 retrieval 行为，语义蕴含不能替代新运行观测。当前不计票是正确的；未卷入方现在即可裁定它只作历史、永不转入当前 tally，无需等 cohort。因当前 tally 已为 0，不造成现时假绿，定 minor。

## 结构怪味扫描

- 范围：canonical bullet、V1R 执行协议、窗口锚点、历史票生命周期。怪味：定义已改而执行协议与度量锚未原子跟随；处置：以上 2 major 要求同提交归一。

# `fd1ce2c` 复审

- 总体 verdict：**修复 major 后可进入下一阶段，不能收口。Blocker：0；Major：1；Minor：0。** 反事实两载体已归一，旧 V1 票已永久归历史，未发现第四套范围口径；但新的 anchor detector 会静默漏掉合法重写。

## 事实性发现

[major] `/home/xp/.claude/skills/proving-where-a-command-ran/verification-log.md:70-76` — 锚点命令依赖四条 bullet 的英文行首，无法可靠找“trigger text 最后变更” — 当前命令能返回 `9c3e996`，但把同一语义合法改写为 `Any result…`、`Before delegating…`、`Cleanup, deletion…` 时，三条都被 `grep -E` 静默 MISS；未来 reviewer 一旦改措辞但未改这份 regex，cohort 就混版本且判据仍绿。修复建议：不要解析自然语言行首。最稳妥的保守锚点是 `git log -1 --format='%H %cI' -- SKILL.md`，任意正文编辑都重置窗口，代价只是 false-red 式延后而不会混口径；若必须只追 trigger 区，应引入稳定机器标记／独立 trigger 文件并对整段 hash，而不是枚举句首。

## 已核实闭合项

- `SKILL.md:24` 与 log `:107` 各唯一命中 claim-bearing projection；诊断流变化、论断投影不变时明确排除，未发现第三方向失效。
- Common mistakes、gate、description、双语 always-on 规则与 canonical bullets 未发现新的范围分岔；当前 V1=0、V1R=0，旧票无 pending。

## 结构怪味扫描

- 范围：trigger 定义／执行协议／历史锚。怪味：用自然语言句首 regex 充当语义变更检测器；处置：本轮不修改，以上 major 要求改成稳定机械边界。

# `50514de` 复审

- 总体 verdict：**修复 major 后可进入下一阶段，不能收口。Blocker：0；Major：1；Minor：0。** 保守 anchor 本身可靠，但 fingerprint 的“可保留旧锚”优化仍有可复现 false-green。

## 事实性发现

[major] `/home/xp/.claude/skills/proving-where-a-command-ran/verification-log.md:74-81` — 指纹抽取器在结构变化后的**下一次** trigger 编辑会静默漏报 — 文本认为 frontmatter 加字段只会 false-red：第一次确实会让第 3 行从 description 变成新字段并触发重锚；但若随后把这个新指纹记录为基线，抽取器从此只 hash 第 3 行新字段，不再 hash 已移到第 4 行的 description。实测模拟“插入 `metadata: v1`”后再修改 description，两版指纹均为 `f0a918f1a6abff04`，而 description 确实不同。`When to use` 标题若改写导致该段永久抽空，同样会在重录空指纹后失明。修复建议：最稳妥是删除 fingerprint 豁免，只用 whole-file 保守 anchor；若保留优化，抽取脚本必须验证 YAML 中恰有一个 `description`、目标 heading／终止 marker 各恰有一个且顺序正确，任何结构不符都**禁止保留旧锚**，不能把异常抽取结果登记成新基线。

## 已核实项

- whole-file `git log -1` 不会漏 trigger 修改；问题只在第 2 步允许 fingerprint 相同后回退旧锚。
- LF 不构成当前歧义：文档给出的完整 pipeline 就是 canonical bytes；本轮复跑得到 `a41cfb95ca86bcaf`。若需跨实现长期复现，可补“hash pipeline stdout verbatim”，但不定级。
- 未发现反事实范围或其他新问题。

# `3435d30` 复审

- 总体 verdict：**修复 major 后可进入下一阶段，不能收口。Blocker：0；Major：1；Minor：0。** Step 1 保守 anchor 可靠；新增 guards 仍有两条确定 false-green。

## 事实性发现

[major] `/home/xp/.claude/skills/proving-where-a-command-ran/verification-log.md:77-81` — 两个结构守卫只证明起点存在，未证明抽取边界完整，仍可静默漏 trigger 变化 — ① 合法 YAML 可把 description 写成 `description: >-` 加续行；第 3 行仍通过 guard，但指纹只 hash `description: >-`，随后修改续行，实测两版都 rc=0、指纹同为 `537b0bcfefbb5523`。② 将终止句 `**These four bullets…` 改名后，第二 guard 仍因起始标题存在而 rc=0；它没有验证终止 marker 存在，range 会吞到 EOF，未来在其后追加正文可改变指纹而 trigger 本身没变，且若后续重录这个宽基线，结构语义已丢失。修复建议：最稳妥仍是删除 fingerprint 豁免、只用 whole-file anchor。若坚持保留，须使用 YAML parser 取得完整 description 值，并机械要求起始标题与终止 marker 各**恰好一次**、终止在起始之后；任何不满足都作 guard-red，绝不记录新 fingerprint baseline。

## 已核实项

- Step 1 `git log -1 -- SKILL.md` 对当前路径上的任意已提交修改保守重锚，不会静默漏内容改动；本轮缺陷只在 step 2 允许回退旧锚。
- 未发现其他新范围问题。

# `331ddf9` 换轴复审

- 总体 verdict：**修复 major 后可进入下一阶段，不能收口。Blocker：0；Major：1；Minor：0。** 换轴方向正确，逐字块与当前被复制内容确实 2121 chars 完全一致；但冻结集合漏了决定“这就是完整范围”的承重句。

## 事实性发现

[major] `/home/xp/.claude/skills/proving-where-a-command-ran/SKILL.md:28`、`/home/xp/.claude/skills/proving-where-a-command-ran/verification-log.md:74-87` — 冻结块只保存 description + 四条 bullet，未保存 canonical/exhaustiveness 元契约，仍可在块保持逐字一致时改变 trigger scope — `SKILL.md:28` 规定“四条是 canonical trigger set”“auditor uses this list and nothing else”；把它改成“four bullets are examples, not exhaustive”会立即扩张 V1R denominator，但 log 的 2121-char frozen block 一字不变，step 2 会错误保留旧锚。`Not for` 边界同理可改变排除面。修复建议：冻结完整 `## When to use` 语义单元，而不只是四条数据行——至少加入第 28 行 canonical/exhaustiveness 句和第 30 行 `Not for`；更稳妥地逐字冻结从 `## When to use` 到下一 heading 前的完整 section，加 frontmatter description。

## 已核实项

- 对已纳入的 5 段，逐字存储没有指纹抽取器那类 spelling bypass；SKILL 改而 log 忘同步会产生可见差异，方向安全。
- 换轴没有丢失旧方案的必要保证：whole-file step 1 仍保守锚定，逐字块同时保留 cohort oracle；问题仅是当前 oracle 边界少圈了承重两行。

# `42fbbc3` 复审与机制裁决

- 总体 verdict：**修复 major 后可进入下一阶段，不能收口。Blocker：0；Major：1；Minor：0。** 冻结范围已覆盖完整 `When to use` section，与源文本 2930 chars 逐字一致；但“逐字相等即可保留旧锚”的双写结构仍可静默假绿。

## 事实性发现

[major] `/home/xp/.claude/skills/proving-where-a-command-ran/verification-log.md:70-76` — live trigger 与 frozen block 可在同一提交中一起更新，而 anchor/window 忘记更新；两段仍逐字一致，step 2 会错误允许保留旧锚 — 这不需要绕抽取式，只需维护者自然地“同步两份文字”却漏改第三处窗口，正是该 log 已记录过的 dual-write drift 形态。Step 1 明明会显示一个比 recorded anchor 更新的 `SKILL.md` commit，却被 step 2 的相等结果覆盖。修复建议：删除“相等可保留旧锚”的优化；始终采用 step 1 的最新 `SKILL.md` commit。逐字块可保留为 cohort 的历史 oracle，但不再充当回退旧锚的判据。

## 范围核验

- Overview 与 gate 不移动 denominator：冻结 section 的 canonical 句已明确排除它们扩张 trigger。Always-on rule 负责召回入口，不是 V1R exposure oracle。log 的 counterfactual／boundary 段是 canonical bullets 的执行说明；当前与冻结 bullet 一致，但长期应保持“bullets are the only input”的优先级，不另立第四套范围。
- 若继续保留逐字 oracle，最好把 log 的 claim-bearing projection 与 boundary 定义视为审计协议而非 trigger source；它们变化应接受独立评审，但不必重写 V1R 的事件分母。

## 元判断

- 前几轮通过正反例把真实失败面逐步暴露，发现连续 spelling bypass 后换轴是健康的；但**“非触发文字修改时保留旧窗口”这个优化已经过度工程**。它只避免偶发的 30 天重锚，却引入三源同步（live text／frozen copy／window）和六轮注意力消耗。按长远正确 + 完整，建议砍到：**whole-file latest-touch 保守锚 + 逐字块只作历史 oracle，不设任何旧锚豁免**。这保留全部正确性目标，只删除脆弱优化。

# `f0f3cd7` 最终复审

- 总体 verdict：**可进入下一阶段（收口）。Blocker：0；Major：0；Minor：0。**
- 已核实：锚定规则只剩 `git log -1 -- SKILL.md`；`may keep the older anchor` 零现行分支，仅历史反例叙述；任意已提交 SKILL 修改都会保守重锚。
- 冻结块职责已降为 cohort 历史 oracle，不参与任何成败分支；当前与 `description + 完整 When to use section` 2930 chars 逐字一致。log-only 提交 `f0f3cd7` 不移动 SKILL anchor，符合设计。
- Tally 仍为当前文本 V1=0、V1R=0；旧 6/6 与旧 V1 票均明确只作历史。反事实、canonical、Not for 与审计协议未发现新分岔。
- 结构怪味复扫：原三源 dual-write 已消失；剩余 live text／frozen history 双份是有意历史快照，不再承担同步 gate，未发现需继续删减项。
