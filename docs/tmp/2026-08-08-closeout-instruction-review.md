# Closeout 指令与收尾文档独立评审

## 评审范围、证据与 verdict

- **范围**：只读评审 `/home/xp/src/copilot-api-js/.claude/worktrees/history-persist-retry-defaults/.claude/skills/session-closeout/SKILL.md`、`/home/xp/src/copilot-api-js/.claude/worktrees/history-persist-retry-defaults/CLAUDE.md`、`/home/xp/.claude/skills/closing-a-development-session/{source.json,SKILL.md,tests/test_skill.py}`、`/home/xp/src/copilot-api-js/.claude/worktrees/history-persist-retry-defaults/docs/archive/2026-08-08-history-v3-persist-retry-closeout.md`，基线 `fe821a703a0107cbb46a0d4909d04362c2df3384`。
- **已执行证据**：`render_skill.py --check` exit 0；`python tests/test_skill.py` 为 6 tests OK；内存移除 `persist_evidence → inventory_job_tmp` requirement 后错误 trace 由红转绿；逐项读取 8 个 tmp commit-message 并与 `git show -s --format=%s` 比较，8/8 相等；枚举 job tmp 得 12 个普通文件；复算 3 个快照 SHA-256 全相等；核验 merge `10387efe` 两父；读取并对账最终草稿、archive、两份 skill 与 authoritative `source.json`。
- **总体 verdict**：**修复 major 后可进入下一阶段**。**Blocker：0；Major：6。**
- **结构怪味扫描**：扫描四个评审对象及生成源／测试接缝；发现“同一 closeout 契约在项目 skill、全局 skill、生成 contract 三处复述且语义分岔”的 duplicated-policy／abstraction-leak，处置见 Major 1、2、6。本轮不建议新增脚本或证明框架。
- **方案反思**：最佳内部路径是在 authoritative `/home/xp/.claude/skills/closing-a-development-session/source.json` 修正顺序与措辞后重新渲染；C1 的反向 mutation 已证明现有 ordering test 对目标机制有判别力；没有适合替代这类项目流程契约的第三方方案。

## C1–C6 核验

| 断言 | 结论 | 证据 |
|---|---|---|
| C1 | **确认** | `/home/xp/.claude/skills/closing-a-development-session/source.json:77-82,119-123`；`/home/xp/.claude/skills/closing-a-development-session/tests/test_skill.py:99-106`。当前错误 trace 被拒；移除目标 requirement 后同一 trace 通过。 |
| C2 | **确认** | `python /home/xp/.claude/skills/closing-a-development-session/render_skill.py --check` exit 0；对应 unittest 亦通过。 |
| C3 | **确认** | 8 个 commit 均可解析，`git show -s --format=%s` 与 `/home/xp/src/copilot-api-js/.claude/worktrees/history-persist-retry-defaults/docs/archive/2026-08-08-history-v3-persist-retry-closeout.md:55-62` 逐字一致。 |
| C4 | **确认结构数量与措辞** | 实际 tmp 为 12 个普通文件；archive `:47-83` 为 A=8、B=1、C=3，`:87` 明定只删除这 12 个精确绝对路径。B 组 disposition 的真实性另见 Major 4。 |
| C5 | **推翻** | archive `:20,22-23` 的基线／命令不足以复现数字，见 Major 5。 |
| C6 | **推翻** | 项目 skill 要“长期价值”，全局 authoritative source 要“intended value”；字段数量相同但判定问题不同，见 Major 6。 |

## 事实性发现

### [major] `/home/xp/.claude/skills/closing-a-development-session/source.json:71-109,119-134` — cleanup 发生在 evidence manifest 的首次独立评审之前
- 生成 contract 令 `clean_temp` 只依赖 `verify_persisted_evidence`，而 `review_closeout_draft` 位于 cleanup／branch resolution／draft 之后；生成文本 `/home/xp/.claude/skills/closing-a-development-session/SKILL.md:164,188-194` 却同时要求使用“reviewed temp manifest”并独立评审每份 evidence manifest。
- 失败场景：作者错误判定某个唯一证据“可删”，contract 允许先删；reviewer 之后只能发现证据已丢，违反 `/home/xp/src/copilot-api-js/.claude/worktrees/history-persist-retry-defaults/CLAUDE.md:51` 的可恢复性纪律。
- 修复建议：在 authoritative `source.json` 中把 temp manifest 的独立评审设为 `clean_temp` 的前置；清理后再更新并终审 terminal report，避免用后置评审冒充删除授权。

### [major] `/home/xp/.claude/skills/closing-a-development-session/source.json:33,41` — 强制 fresh installed-location tests 与项目“不因刚合并重跑全量”裁决冲突
- 渲染文本 `/home/xp/.claude/skills/closing-a-development-session/SKILL.md:192,216,225` 无条件要求 merged location 的 fresh tests/build 和 every terminal state fresh evidence；项目 `/home/xp/src/copilot-api-js/.claude/worktrees/history-persist-retry-defaults/CLAUDE.md:48` 明确要求无升级信号时沿用合并前／合并态证据。
- 失败场景：同一交付合并后，执行者无法同时满足两条规则，只能擅自重跑全量或擅自忽略 global skill；archive `:33` 已实际采用后者。
- 替换措辞：改为“按项目门禁在 installed/merged location 运行适用验证；已有合并态证据在未命中项目升级信号时继续有效。报告逐项标明复用或新跑的 commit、命令与结果。”

### [major] 三处触发／范围措辞允许未来会话合理化为“这次不必盘点 job tmp”
- `/home/xp/.claude/skills/closing-a-development-session/SKILL.md:3` 的“when the user asks”可命中“这次是我主动收尾、用户没要求”；替换为“whenever a session/phase is closing or any completion/status/handover report will be delivered, regardless of initiator”。
- `/home/xp/src/copilot-api-js/.claude/worktrees/history-persist-retry-defaults/.claude/skills/session-closeout/SKILL.md:45-49` 的“写最终报告前”可命中“这只是阶段汇报／交接／直接结束，不叫最终报告”；替换为“任一 closeout 触发后、任何完成／状态／交接报告或会话结束前”。
- `/home/xp/.claude/skills/closing-a-development-session/SKILL.md:126` 的“`$CLAUDE_JOB_DIR/tmp` (or … root)”可命中“任选一个较窄 root 即可”；改为“先核精确 `$CLAUDE_JOB_DIR/tmp`；若另有 job/session root，二者为并集；unset／不存在也须落 disposition，不得任选其一”。

### [major] `/home/xp/src/copilot-api-js/.claude/worktrees/history-persist-retry-defaults/docs/archive/2026-08-08-history-v3-persist-retry-closeout.md:68-73` — B 组 cleanup precondition 的全称断言为假
- `:72` 声称草稿“没有任何结论”仅存于草稿；但 `/home/xp/.claude/jobs/dddf6825/tmp/final-closeout-draft.md:21-31,39-42` 仍独有“worktree 未删除／未推送／需要 ff-only merge／无需新增资产”等结论，archive 未逐项承接或判为 transient／superseded。
- 失败场景：执行者按现有 precondition 删除草稿，却无法证明这些遗漏是无长期价值而非漏提炼；这正是新门要阻止的 self-certified cleanup。
- 修复建议：逐节列出草稿结论并为每项给 receiver 或“transient／superseded + 证据”；前置改成“无**未处置的 durable conclusion**”，不要保留已被反例推翻的“没有任何结论”。

### [major] `/home/xp/src/copilot-api-js/.claude/worktrees/history-persist-retry-defaults/docs/archive/2026-08-08-history-v3-persist-retry-closeout.md:14-23` — C5 所称每个数字均有 commit／命令口径不成立
- `:20,22` 只写“review-fix tree”，没有可解析 commit；`:23` 虽有 `d59a622c`，命令栏只有“reviewer 实测”，无法复跑“29 pass”；`:20` 的 6376／7259 与 `:22` 的 16 同样缺精确 tree identity。
- 失败场景：后继者无法区分这些数字来自同一 tree、未提交 tree 或不同整改时点，也无法复现 reviewer 的选择器；标题句 `:14` 因此强于证据。
- 修复建议：每行补完整 SHA（未提交 tree 则给可读取的 immutable artifact）与原样命令；无法恢复者明确标“未交叉验证／命令未记录”，不要继续声称全表均具口径。

### [major] `/home/xp/src/copilot-api-js/.claude/worktrees/history-persist-retry-defaults/.claude/skills/session-closeout/SKILL.md:47` 与 `/home/xp/.claude/skills/closing-a-development-session/source.json:13` — C6 的 disposition 字段语义不一致
- 项目要求“长期价值”，即判断内容是否必须跨 cleanup 存活；global source 要“intended value”，可被填写为“用于 merge 比对”而完全不回答长期保留价值。两边虽各有六个槽，global 一方少了可执行的 durability 判断。
- 失败场景：执行者记录用途后直接判 delete，形式上满足 global Step 2，却不满足项目 §3b；同一 manifest 在两套规则下得到相反 verdict。
- 替换措辞：将 authoritative source 的 `intended value` 改为 `long-term/durable value, including whether any content must survive cleanup`，并重新渲染；项目 CLAUDE.md 摘要无需再扩字段。

## 主观建议

无。本报告只保留 blocker／major；未以成本、ROI、YAGNI 或一次性证明基础设施为由缩减条款。

## 主会话处置（2026-08-08）

6 项 major **全部采纳**，无驳回项。逐条落点：

| Major | 级别 | 处置 |
|---|---|---|
| cleanup 早于 manifest 首次独立评审 | B（改变模型收到的指令） | `source.json` 新增 stage `review_temp_manifest`，`clean_temp` 同时依赖它与 `verify_persisted_evidence`；Step 5 正文写明「删掉唯一一份证据不可逆，其授权不能挂在之后的终稿评审上」。**先加失败测试再改**：新用例 `test_cleanup_requires_independently_reviewed_manifest` 在改 source 前为红（连同 stages 断言共 2 处红），改后 7 测试全绿。 |
| 强制 fresh installed-location tests 与项目裁决冲突 | B | 全局 Step 7／9 改为「跑项目在该交付边界要求的验证；项目规则认定已有合并前／合并态证据在未命中升级信号时仍有效时即复用」，并要求逐项标明复用还是新跑、附 commit 与命令。 |
| 三处触发／范围措辞可被合理化绕过 | B | ①全局 frontmatter `description` 去掉「when the user asks」，改为会话／阶段结束或任何完成、状态、交接报告发出前，**不论由谁发起**；②项目 §3b 标题与正文从「写最终报告前」改为「任一收尾触发后、任何完成／状态／交接报告发出前、会话或阶段结束前，三者取最早」，并点名三句常见的自我豁免话术；③tmp root 由「或」改为**并集**，变量未设或目录不存在也须落 disposition。 |
| B 组 cleanup precondition 的全称断言为假 | C | 事实核实属实：草稿的「当前仓库状态」「可复用资产」两节确实未被承接。archive 新增「仓库与分支状态」「可复用资产处置」两节承接，前置由「没有任何结论只存在于草稿」改为「没有**未处置的** durable conclusion」，并写明前一版被反证推翻的经过。 |
| 验收表口径不足 | C | 逐行标明 tree 身份可否复现；两行取自未提交工作树、一行原样命令未记录，全部显式标注「未交叉验证」，并撤回「以下数字均为……点时输出」这句强于证据的表头。 |
| `长期价值` 与 `intended value` 语义分岔 | B | 全局 `source.json` Step 2 的 `intended value` 改为 `long-term value — that is, whether any of its content must survive cleanup, not merely what it was used for`；项目 CLAUDE.md ③b 摘要同步补上「长期价值」与「清单本身过独立评审」，避免复述悄悄弱于权威。 |

**未采纳项：无。** 评审明确声明未以 ROI／YAGNI 缩减条款，也未建议新建证明基础设施，与项目的 `solve-the-task-before-building-proof-infrastructure` 不冲突。


## 复评（2026-08-08）

### 范围、证据与 verdict

- **基线**：项目 `6224c79fa5f92f1e5dea8bbbc286cec1db71e83c`；全局 skill `68c5867994a37bfbfe9777e7c5c73733d8afe8b0`。只复核上一轮 6 项整改及其相邻接缝。
- **执行证据**：`render_skill.py --check` exit 0；`python tests/test_skill.py` 为 7 tests OK；内存移除 `clean_temp → review_temp_manifest` requirement 后同一错误 trace 由红转绿；当前 job tmp 复扫仍为已评审的 12 个路径，无新增项。
- **总体 verdict**：**0 blocker／2 major；不满足 archive 清理门。** 第 3、4、5、6 项闭合；第 1、2 项各剩一个执行接缝。

### 六项闭合判定

| 原 Major | 判定 | 证据 |
|---|---|---|
| 1. cleanup 早于 manifest 评审 | **未完全闭合** | 初始 manifest 已由 contract 与有判别力的测试正确设闸；但清理前复扫新增项不会回到 `review_temp_manifest`，见 Major A。 |
| 2. 强制 fresh installed-location tests | **未完全闭合** | Step 7 与 completion gate 已允许复用；Step 9 必填项仍要求 `fresh verification commands and outcomes`，见 Major B。 |
| 3. 三处绕过措辞 | **闭合** | frontmatter 不再依赖用户发起；项目 §3b 覆盖三类报告／结束边界并点名豁免话术；全局 root 语义已改为并集且空／未设须 disposition。 |
| 4. B 组假全称 | **闭合** | archive 已承接 worktree／发布／资产结论，ff-only 明确 superseded，前置收窄为“无未处置 durable conclusion”。 |
| 5. 数字口径不足 | **闭合** | 两个不可复现 tree 与一个未记录选择器均明确降级为“未交叉验证”，表头已撤回全称主张。 |
| 6. 字段语义分岔 | **闭合** | 全局 source、渲染文本、项目 §3b 与 CLAUDE.md 均统一为“内容是否必须活过清理”的长期价值。 |

### 事实性发现

#### [major] `/home/xp/.claude/skills/closing-a-development-session/source.json:13,25,71-74,103-105` — 清理前新增文件只回到 classification，未回到独立评审
- `review_temp_manifest` 只对首次清单设闸；Step 2／5 规定复扫新路径后“add a manifest row, classify it, and verify its receiver”，没有要求更新后的清单再次达到 0 blocker／0 major。项目 skill `/home/xp/src/copilot-api-js/.claude/worktrees/history-persist-retry-defaults/.claude/skills/session-closeout/SKILL.md:49` 与 archive `:101` 同样漏了复审回环。
- 失败场景：首次 12 项评审通过后生成第 13 项；作者补一行并自判可删，仍可直接 cleanup，刚新增的 `review_temp_manifest` 门被合法绕过。
- 修复建议：明确“任何新增／修改 disposition 都使先前 manifest verdict 失效，必须重新验证 receiver 并复审更新后的完整清单至 0 blocker／0 major 后才可清理”；contract 若表达该循环困难，正文必须把重入动作写死。

#### [major] `/home/xp/.claude/skills/closing-a-development-session/source.json:41` — Step 9 仍无条件要求 fresh verification，与已修 Step 7 自相矛盾
- 同段 completion gate 已允许按项目规则复用证据，但 terminal report 必填列表仍写 `fresh verification commands and outcomes`；渲染结果见 `/home/xp/.claude/skills/closing-a-development-session/SKILL.md:218-230`。
- 失败场景：执行者复用合法的合并态证据后，无法诚实填写“fresh outcomes”，只能重跑或违反 Step 9；原 Major 2 的冲突仍从另一句进入。
- 替换措辞：改为 `verification commands and outcomes, labeling each as freshly produced or reused and anchoring it to its commit`，与本段末句及 Step 7 对齐。

### 清理门判定

当前 12 项清单未出现新增路径，且上一轮逐项内容核验仍成立；但 archive 要求“本文内容经独立评审达到 0 blocker／0 major”，本轮仍有上述 2 项 major，因此**清理门未满足，不应执行删除**。

### 主会话处置（复评轮，2026-08-08）

2 项 major **全部采纳**，无驳回。两者都是我上一轮修复自身长出来的新问题，形态在项目规则里都有对应条目：

| Major | 级别 | 处置 |
|---|---|---|
| A. 复扫新增项不回到独立评审 | B | 三处同步补上重入：全局 `source.json` Step 2 写明「新增／删除／修改任一 disposition 即使先前评审结论失效，更新后的清单须重新过审」，Step 5 写明「0 blocker／0 major 属于被评审的那份清单，不属于它之后变成的样子」；项目 §3b 与 archive 清理门、修复方向第 5 条同步。这正是 `adopting-agent-findings` 所说「每一轮的新问题往往长在上一轮的修复上」——我在修 fail-closed 的过程中新开了一个 fail-closed 的口子。 |
| B. Step 9 必填项仍写 `fresh` | B | 改为 `verification commands and outcomes, each labelled freshly produced or reused under the project's rules and anchored to its commit`。形态是 `62-docs-and-handover` 的「改了内容没改指向它的东西」：我改了 Step 7 正文与 Step 9 末句，漏了同段的必填清单。首版修补时我一度写成「fresh …, each labelled … or reused」，自相矛盾，通读时改掉。 |

清理门按评审判定**未满足，未执行任何删除**；job tmp 仍为 12 个文件原样保留。
