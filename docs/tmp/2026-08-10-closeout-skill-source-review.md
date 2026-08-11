# `closing-a-development-session` source review

## 范围与结论

审查对象：`/home/xp/.claude/skills/closing-a-development-session/source.json` 的 Step 5／Step 6 本轮改动、由它生成的 `SKILL.md`，以及 `verification-log.md` 的 `2026-08-10 · copilot-api-js 三档 shutdown 信号契约 closeout` 五条记录。

结论：**major 1，未达到可定稿条件。**Step 5 的收窄成功；Step 6 正确排除了“已经 merge 仍 keep branch”，但把 `git branch -d` 的保护范围说得过大，导致正确但未并入当前 `HEAD` 的 durable branch 被 false-red 地保留。以下 major 修正并经复审后，才可交付这份 instruction text。

## 核验结果

### 1. Step 5：临时文件默认——通过

- **级别：无发现。**`source.json:24`／`SKILL.md:245-253` 保留了原有的硬门：只能删除已审 manifest 中的精确路径，且须先有 `0 blocker / 0 major` 的独立审查与正向 receipt；receipt 缺字段时仍明确“retain every file”。因此新段没有以“已处理”绕过 evidence persistence 或 manifest review。
- 同一段新增的“Delete the directory's contents, not the directory”明确把正确默认限定为“已验证 repository carrier 的 file”，并重申“reviewed manifest”“never by wildcard”以及不能命名 carrier 的 file 必须 retain。它不再让“保留全部 scratch root”与“删除已处理 file”同时成为看似同等合规的默认读法。
- scope 断言属实：上文真正的 fail-closed 触发条件就是“**A missing field fails closed**”，这里的 field 指 reviewer receipt 所必须包含的 event-source identity／coverage、独立枚举、双向 diff 为空三项，见 `source.json:24`／`SKILL.md:247`。新文“只在 review receipt 缺失时触发”准确复述该上文，而非事后编造的缩限。
- 两个方向：错误做法“receipt 缺失仍删”仍被拒绝；正确做法“receipt 完整、carrier 已验证、逐路径删除已过期 file、保留目录交 harness”现在被明确允许。

### 2. Step 6：`git branch -d` 的保护范围——major

- **级别：major。**`source.json:28`／`SKILL.md:265,271` 把 safe delete 说成“enforces exactly this condition”，其中“this condition”是“unique commits are the only durable source of installed-but-unmerged work”。这不属实。`git branch -d` 只拒绝 Git 认定为“not fully merged”的 branch；它不会枚举所有 durable refs，也不会判定 branch 是否为唯一 source。
- 反例：某 branch 的 commit 已由 tag、release ref 或另一 retained branch 持久保存，但未合入当前 `HEAD`／upstream。它已经不是“唯一 durable source”，然而 `git branch -d <branch>`仍会拒绝。这样一来，文本要求“safe delete is the right tool”会将正确的“已处理、不应 keep branch”误伤为 cleanup blocker；若操作者忠实遵守“never `-D`”，只能违反用户的“不保留已经处理过的分支”裁决或错误报告 branch 必须保留。
- 本机实测支持命令的较窄语义：临时仓库中，已 merge branch 的 `git branch -d merged` 返回 `0`；未 merge branch 的 `git branch -d unmerged` 返回 `1`，stderr 为 `error: the branch 'unmerged' is not fully merged.`并提示 `git branch -D unmerged`。`git branch -h` 同时将 `-d` 描述为“delete fully merged branch”。这证明它能挡住未合并提交，却不能证明“唯一 durable source”这一更宽命题。
- **修法：**保留“never `-D`”和“Stop at the branch ref”，但把“enforces exactly this condition”改为可证实的窄命题，例如：“`git branch -d` is the default guard: it refuses a branch Git does not consider fully merged. If it refuses, do not force it; record the branch and the retained durable ref/commit as a cleanup blocker for the user to decide.”同时把前一 bullet 保留为独立的证据义务：删除前仍须确认 installed-but-unmerged work 有 durable retained ref/commit。这样错误做法（未合并且无 durable source 时强删）仍被挡住，正确做法（已有其他 durable ref 但 `-d` false-red）不会被虚假宣称为已被机制“exactly”判定。

### 3. Step 6：“stop at the branch ref”与既有 bullet——通过

- **级别：无发现。**`source.json:28`／`SKILL.md:265` 的既有 bullet 约束“唯一 durable source”不得删；`SKILL.md:271` 的“Stop at the branch ref”约束的是删除已经获准的 branch ref 后，不追删 reflog／不运行 `gc`。前者保护 source，后者保留 Git 的恢复面，作用对象与时序不同，不冲突也非重复。
- 但该通过结论不消解上节 major：两句不冲突，不代表 `-d` 的“exactly”说明正确。

### 4. 生成源唯一性——通过

- **级别：无发现。**`render_skill.py:8-9` 定义 `SOURCE = ROOT / "source.json"` 和 `OUTPUT = ROOT / "SKILL.md"`；`render_skill.py:44-50` 在 `--check` 下重新 render 并逐字比较输出。它没有从 `SKILL.md` 反向读取或写入建议。
- 运行 `python3 /home/xp/.claude/skills/closing-a-development-session/render_skill.py --check`，退出码为 `0`。因此本次 `SKILL.md` 与 `source.json` 一致；修复必须落在 `source.json` 后重新渲染，不能只改生成文件。

### 5. `verification-log.md` 投票资格与五条新增记录——通过

- **级别：无发现。**投票规则在 `verification-log.md:8-12`：编辑本 skill 的 session 只能投 `insufficient data` 或 `falsified`，且 author 的 falsification 明确允许。
- 新增小节资格声明与该规则一致，见 `verification-log.md:77-80`。五条记录的 verdict 分别是：
  - `V-temp-retention`：`falsified → fixed in source`，`verification-log.md:81`；
  - `V-branch-keep`：`falsified → fixed in source`，`verification-log.md:82`；
  - `V-reviewer-mutation`：`falsified → suggest source change`，`verification-log.md:83`；
  - `V-duplicate-backlog`：`falsified → suggest source change`，`verification-log.md:84`；
  - `V9`：`insufficient data (author)`，`verification-log.md:85`。
- 没有一条写成 `confirmed`，也没有把“实际执行了分类／carrier verification／删除”偷换为该 session 对 skill 有效性的确认票。`V9` 尽管报告了行动结果，最终 verdict 明确是 insufficient data，符合污染观察限制。

### 6. 与 Step 2／Step 9 的一致性——通过，受 major 限制

- **级别：无额外发现。**Step 5 的新默认仍要求每个 file 先有“verified repository carrier”，与 Step 2 的“inventory → classify → persist/distil → verify → delete”及 evidence 必须可被未来 reviewer 抵达的要求一致，见 `source.json:12`／`SKILL.md:141-147,251`。
- Step 9 仍要求 terminal report 逐一说明 temp manifest、persisted／removed／retained paths 及 retained reason，见 `source.json:40`／`SKILL.md:324-336`；删除已处理 files 不会使报告失去所需事实，因为 manifest 与 carrier 仍须可审查。
- Step 6 的新规则也与 Step 9 的“safe merge or cleanup remains blocked 时说明 exact blocker 并 keep durable branch/worktree”一致，见 `SKILL.md:336`。但是，因上一节所述 `-d` 的 false-red，该 blocker 不应被称作机制已经证明“唯一 durable source”的情形。

## 建议处置

| 发现 | 级别 | 建议 |
|---|---|---|
| `git branch -d` 被错误描述为精确验证“唯一 durable source” | major | 修改 `source.json` 的 Step 6，降为“Git fully-merged 的 default guard”，保留 source-preservation 的独立检查；重新 render `SKILL.md`，再跑 `render_skill.py --check`，并发起独立复审。 |

## 未采纳建议

无。除上述 major 外，未建议改动 Step 5、日志投票规则或生成流程：现有文本已同时阻止 receipt 缺失时的错误删除，并允许 receipt 完整时删除已处理 temporary files。