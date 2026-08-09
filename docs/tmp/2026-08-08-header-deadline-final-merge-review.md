# HTTP/2 header deadline 最终合并评审

> ⚠️ **2026-08-09 追加的口径更正（不改本报告当时的结论，只界定其证据强度）**：本文若把「16 份 shard JUnit 叶节点复算」或「磁盘 glob × JUnit 对账」称作**交叉验证／独立重算／独立 oracle**，那个措辞**不准确**——前者与 runner tally 同出一批 artifact、同一个 producer，只是换了 parser（抓解析／聚合错误，抓不到 producer 漏项）；后者独立于 runner 的**实现**、不独立于 discovery 的**规则**，且只到文件级。因此据此冻结的 `minimum_executed` 是**已观察量的地板**，不是「测试没减少」的证明。当前口径与判独立性的方法见 `docs/coding-conventions.md`「并行执行」节。

- **评审范围**：commit `3be7182a` 指定两处新增内容、merge commit `02ecde73` 的内容完整性、ff-only 前提，以及用户列出的 C1～C8。
- **已读取／执行的证据**：本报告逐项记录；所有 tree-dependent Bash 均在 `/home/xp/src/copilot-api-js/.claude/worktrees/nghttp2-header-deadline`、冻结 HEAD `02ecde734a24a778fad614f63f02f393258ee3d4` 下执行。首次 provenance 输出为 `pwd=/home/xp/src/copilot-api-js/.claude/worktrees/nghttp2-header-deadline`、`git rev-parse --show-toplevel` 同值、HEAD 与冻结值完全相等。
- **总体 verdict**：**存在 blocker，不可进入 ff-only 集成**。修复 C6 blocker，并处理 C3／C4／C8 major 后，重新评审新的合并态。
- **blocker 数量**：**1**。另有 major 3 条、minor 1 条；C1／C2／C5／C7 通过。

## 事实性发现

### C1 — PASS

**命题**：job tmp 当前为 0 项；清理前 42 项；manifest 覆盖 42／42；分类为 12 保留 + 30 可清理。

**独立证据与命令**：

- `find /home/xp/.claude/jobs/14d4ecd1/tmp -maxdepth 1 -mindepth 1 -printf '%f\n' | wc -l` 当前输出 `0`。
- `/home/xp/src/copilot-api-js/.claude/worktrees/nghttp2-header-deadline/docs/tmp/2026-08-08-header-deadline-job-tmp-reconciliation.md:3` 明确冻结清理前顶层口径为 42 项；`:41` 记录最终复扫 42 项并声称逐项对应。原目录已清空，所以“清理前确有 42 项”只能由已提交 manifest 记录追溯，不能再由当前目录重新枚举；这是历史证据，不是当前态直接观测。
- 我逐类重数 manifest，而非采信作者加法：保留项为 `1 + 1 + 1 + 2 + 7 = 12`（`:11-15`）；可清理项为 `12 + 3 + 9 + 2 + 1 + 3 = 30`（`:25-30`）。两类合计 `42`，且分类总数自洽。
- manifest 表格覆盖数与其冻结的清理前总数同为 42，因此在文档自身的逐项枚举口径下为 42／42；原件已删，无法重新独立构造清理前全集来排除“manifest 与清理脚本同源漏项”。当前 `remaining=0` 可独立验证。

**错误动作风险**：无。需保留上述证据边界：不得把“当前目录为空 + manifest 自洽”扩写成“已由当前文件系统独立复现清理前 42 项”。

### C2 — PASS（载体侧）

**命题**：12 个保留项已入 commit `216a2187`，当前 HEAD 也存在，且当前 HEAD 未改写这些载体。

**独立证据与命令**：

- `git ls-tree -r --name-only 216a2187 -- exp/http2-cancel-provenance` 列出 13 个文件；排除 README 后，正好是 manifest 的 12 个保留项。
- 我对下列 12 个路径分别执行 `git cat-file -e 216a2187:<path>` 与 `git cat-file -e HEAD:<path>`，四组命令均输出 `OK`，无失败：
  1. `exp/http2-cancel-provenance/incident-analysis/analyze-cancel-hydrated.ts`
  2. `exp/http2-cancel-provenance/incident-analysis/analyze-cancel-tracks.ts`
  3. `exp/http2-cancel-provenance/stage1-gate-mutations/mutate-deadline-no-clear.patch`
  4. `exp/http2-cancel-provenance/stage1-gate-mutations/mutate-deadline-no-idempotence.patch`
  5. `exp/http2-cancel-provenance/stage1-gate-mutations/mutate-deadline-only-signal.patch`
  6. `exp/http2-cancel-provenance/stage1-gate-mutations/mutate-http2-detach-cleanup.patch`
  7. `exp/http2-cancel-provenance/stage1-gate-mutations/mutate-leak-header-deadline.patch`
  8. `exp/http2-cancel-provenance/stage1-gate-mutations/mutate-remove-header-deadline-signal.patch`
  9. `exp/http2-cancel-provenance/stage1-gate-mutations/mutate-shared-send-drop-header-duration.patch`
  10. `exp/http2-cancel-provenance/wire-oracle/probe-client-abort-race.ts`
  11. `exp/http2-cancel-provenance/wire-oracle/probe-peer-cancel-oracle.mjs`
  12. `exp/http2-cancel-provenance/wire-oracle/probe-public-peer-cancel.mjs`
- `git diff --exit-code 216a2187 HEAD -- <上述 12 路径>` 退出 0 且无输出，证明这 12 个路径在载体 commit 与当前 HEAD 的内容相同。
- 原 tmp 原件已删除，因此“`216a2187` 与原件逐字节相同”这一历史动作不能事后独立重跑；当前可确认的是载体 commit 与 HEAD 的 12 份内容存在且相同。该证据边界不推翻 C2 的载体侧要求。

**错误动作风险**：无。后续引用应锚定 `216a2187` 或当前 HEAD 的这些路径，不应声称本轮重新比较了已删除原件。

### C3 — MAJOR

**命题**：`执行记录` 每一句陈述与可核事实相符。

**独立证据与命令**：

- commit 边界成立：`git show 3be7182a -- <两条指定路径>` 证明本次仅新增执行记录 10 行与 V19 1 行；`3be7182a` 的父提交是文中 tip `564cda57`。`git merge-base --is-ancestor 216a2187 564cda57` 退出 0，接收载体确在执行记录所锚 tip 之前。
- **事实错误**：`/home/xp/src/copilot-api-js/.claude/worktrees/nghttp2-header-deadline/docs/tmp/2026-08-08-header-deadline-job-tmp-reconciliation.md:39` 声称“两份独立评审（事实视角／指令视角）均判 0 blocker／0 major”。实际两份评审是 commit `564cda57` 新增的 `docs/tmp/2026-08-08-job-tmp-review-facts.md` 与 `docs/tmp/2026-08-08-job-tmp-review-instruction.md`。前者 `:5,82-84` 确为 0 blocker／0 major、3 minor，并要求修正后才可作为删除授权；修正在其父提交 `548e3cf2`。但后者 `:9-19,32-38` 明确给出 **1 blocker + 1 major**，并要求先把 master 的 §3b／V19 加固合并对账。`git log 548e3cf2..3be7182a -- <两份评审>` 只出现新增它们的 `564cda57`，没有后续复审把该 verdict 改成 0／0。故“二者均 0／0”和“上述前置条件全部满足”不成立。
- 12／12 历史比对有独立历史佐证：事实评审 `docs/tmp/2026-08-08-job-tmp-review-facts.md:43-50` 在原件尚存时逐个比较，列出 12 个 blob hash，结论为 12／12 相同；本轮 C2 又确认这些载体仍在 `216a2187` 与 HEAD。执行记录声称删除前再次比对，原件已删，无法再重跑，但至少有独立评审留下同一结果。
- 清理前 42 项、覆盖 42／42有独立历史佐证：事实评审 `:7-18` 在原件尚存时重新枚举 42 项，逐项比对为漏项 0、多项 0；随后 `548e3cf2` 修正清单数字和口径。当前目录重新枚举为 0，支持最终残留 0。
- “无符号链接，计数 0”属于已发生动作前的瞬时状态；原目录已空，且现存独立评审未记录该命令输出，**不可事后核验**。
- “逐行读取枚举清单”“每条先断言前缀且不含 `..`”“按 exact path 逐项删”“三个目录仅用 `rm -rf <确切路径>`”“未使用任何通配符展开”“deleted=42”均是已发生 shell 动作；没有保留脚本、transcript 命令或逐路径删除日志，**不可事后核验**。当前只能独立确认 `remaining=0`，不得据此给这些动作假的绿灯。
- 归档 DB 状态成立：`stat` 与 `ls -la --time-style=long-iso /home/xp/.local/share/copilot-api/history-v3-260807.db` 输出 regular file、`size=19641716736`、`mtime=2026-08-06 20:26:08.682451548 +0000`，与 `:45` 的“19.6 GB、mtime 2026-08-06 20:26、仍存在”一致。两个保留分析脚本分别在 `exp/http2-cancel-provenance/incident-analysis/` 硬编码该 DB 路径；这支持它是相关派生数据的再生数据源。mtime 只能证明自 8 月 6 日以来内容时间未变，不能证明删除过程没有打开过它；“未被波及”在内容未改的窄含义下成立。

**事实性发现**：

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/nghttp2-header-deadline/docs/tmp/2026-08-08-header-deadline-job-tmp-reconciliation.md:39` — 把实际含 1 blocker／1 major 的指令评审写成“两份评审均 0／0”，并进一步声称所有删除前置条件已满足 — 下一个接手者会误以为清理严格通过了 skill 所要求的双评审门，并把这次记录当作 V19 的正样本；实际上指令评审从未给出 0／0，也没有复审记录。应由 `gpt-souls:doc-writer` 更正执行记录，明确区分“事实／删除授权评审 0／0”与“指令文本评审仍有 blocker／major，但其发现是否影响本次清理需单独 disposition”；再由未卷入 reviewer 裁决该 disposition。

**错误动作风险**：后续会话会用这条假 0／0 证明顺序门已闭合，进而把一个未真正满足书面前置的删除实例登记成自验成功证据。

### C4 — MAJOR

**命题**：V19 行中的 42／42／12／新增 0／残留 0／30 allowed 与 C1～C2 一致，口径清楚。

**独立证据与命令**：

- `/home/xp/src/copilot-api-js/.claude/worktrees/nghttp2-header-deadline/.claude/skills/session-closeout/verification-log.md:179` 字面写出 42 顶层项、manifest 42／42、须入项目 12 项、清理前新增 0、清理后残留 0；C1、C2 的当前态与载体侧核验和这些数字一致。该行**没有字面写出 30 allowed**；30 只能由 manifest 分类重数或 `42 - 12` 推得。manifest 的独立历史评审 `docs/tmp/2026-08-08-job-tmp-review-facts.md:7-18` 确认其余 30 项均判可清理，故数字实质一致，但 V19 的口径不是自包含的。
- 49 行提醒不是虚构，但表述缺关键选项。原件尚存时，事实评审 `docs/tmp/2026-08-08-job-tmp-review-facts.md:13-18` 实测：`find … -maxdepth 2` 为 **49 行（含 tmp 自身）**，加 `-mindepth 1` 则为 **48 行**；顶层口径 `-maxdepth 1 -mindepth 1` 才是 42。V19 `:179` 写“`-maxdepth 1 -mindepth 1`；换成 `-maxdepth 2` 得 49”，若“换成”仅替换 maxdepth 而保留 mindepth，正确数字应为 48；只有同时删除 `-mindepth 1` 才是 49。因此“49 是另一个量”的方向正确，但命令口径不充分。目录已空，本轮不能重跑历史 49；上述独立评审保留了当时的两种输出。
- 更严重的是，V19 `:179` 再次声称删除发生在“两份独立评审 0 blocker／major”之后。C3 已由两份实际评审原文证伪：事实评审 0／0，指令评审为 1 blocker + 1 major，且没有后续复审。因此这不是只改 49 口径即可放行的数字小错。
- “exact path、无通配符展开”仍属不可事后核验的动作断言；V19 未标其证据来源或不可核验边界。

**事实性发现**：

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/nghttp2-header-deadline/.claude/skills/session-closeout/verification-log.md:179` — V19 把未满足的“双评审 0／0”写成机械判定已满足，并把无法事后复跑的删除方式写成客观观测 — 证据同 C3；下一个接手者会把这行当作 V19 流程有效的成功样本，掩盖实际未闭合的评审门。应由 `gpt-souls:instruction-smith` 修订该指令自验记录，并由独立 reviewer 复评。

[minor] 同行 — `-maxdepth 2` 的 49 行未说明必须去掉 `-mindepth 1` 且含目录自身；若保留原口径的 `-mindepth 1`，历史实测为 48 — 下一个接手者照抄 base 命令只改 maxdepth 会得到 48，并误判记录漂移。应把两个完整命令及 49／48／42 的对象边界写全。

**错误动作风险**：见两条发现；尤其不能让这条 V19 记录参与后续“流程已被实战证实”的 graduation。

### C5 — PASS

**命题**：merge commit `02ecde73` 未吞掉任一侧内容，重点是 `verification-log.md` 两侧文末追加章节。

**独立证据与命令**：

- `git show -s --format=… 02ecde73` 确认父提交为 feature `3be7182a` 与 master `ad8128ad`。
- 对 `.claude/skills/session-closeout/verification-log.md`，我用脚本按 `^## ` 切分三个版本并逐节比较：master 18 个标题、feature 17 个标题、merge 18 个标题；`master_missing=[]`、`feature_missing=[]`。因此 master 标题集合与 feature 标题集合都为 merge 标题集合的子集。
- master 独有的“History Worker Batch 1b 收尾证据终审”节在 master 与 merge 中都是 13 行，SHA-256 都是 `b75e36eb2e8e444fe3b535faa0c906c0ea7683c3181a9974b5873a92bdcd8f7d`，逐字节保留。
- 两侧共有的“HTTP/2 header deadline 阶段 1 收尾”节：master 8 行、feature 9 行、merge 9 行；merge 与 feature 的该节 SHA-256 都是 `2deb83bd614b379e8b69bb8b1ff289165e01b1fb61ff71b11ce7abc2676e3949`，且脚本确认 master 版本是 merge 版本的前缀。唯一增量正是 feature 的 V19，因此两边均未丢。
- `git diff-tree --cc --name-status 02ecde73` 只报 `MM .claude/skills/session-closeout/verification-log.md` 为两侧共同修改文件；`git show --remerge-diff 02ecde73 -- verification-log.md SKILL.md` 无输出，未发现偏离 Git 自动三方合并的手工吞改。
- 指令评审曾指出 feature 的 `SKILL.md` 弱于 master；合并态确实完成语义合并而非选弱边：`git diff 3be7182a 02ecde73 -- SKILL.md` 显示 merge 增加 master 的独立评审／复扫失效门，同时保留 feature 的枚举坑、四类判定经验与 V19 加固；`git show --remerge-diff` 仍无异常 resolution。
- feature 独有清单、两份评审和 13 个 exp 文件：`git diff --exit-code 3be7182a 02ecde73 -- <这些路径>` 退出 0，并输出 `FEATURE_ARTIFACTS_PRESERVED`。
- 相对 feature parent 的 merge diff 有 49 个 master 侧文件、`1918 insertions／302 deletions`；相对 master parent 的 merge diff 有 18 个 feature 文件、`552 insertions／2 deletions`。这些 parent-relative 集合与两侧各自引入的内容形状一致。这里不把 stat 本身当无丢失证明，只作为上述逐路径／逐节比较的交叉检查。

**错误动作风险**：无。merge 内容完整性可放行；C3／C4 的文档事实错误是 merge 前已存在的内容质量问题，不是 merge 吞改。

### C6 — BLOCKER

**命题**：当前 `git merge-base --is-ancestor master HEAD` 返回 0，ff-only 前提已成立。

**独立证据与命令**：

- 冻结评审 HEAD 仍是 `02ecde734a24a778fad614f63f02f393258ee3d4`，但当前 `master` 已推进到 `d64630e4bcbddc51e5487d0c3d7abc3e6c38ac88`。
- `git merge-base master HEAD` 输出 `ad8128ade33fded2c93f2e7ec10bb310555b329b`，不是当前 master tip；`git merge-base --is-ancestor master HEAD` 退出 **1**。C6 断言为假。
- `git rev-list --left-right --count master...HEAD` 输出 `3 7`：master 有 3 个 HEAD 不含的提交，feature 有 7 个 master 不含的提交。`git log HEAD..master` 列出 `fe65adea`、merge `f2f6a584`、`d64630e4`。
- `git diff --name-status HEAD...master` 显示新 master 改动 `.claude/skills/anthropic-precontent-recovery/*`、`docs/rfc/.../cutover-plan.md`、`exp/inter-block-anchor-allocator/baseline-runs.sh`、`tests/infra/capture-entry-evidence.unit.test.ts` 等路径。无论这些改动是否与本功能语义冲突，Git 的 ff-only 机械前提都确定不成立。

**事实性发现**：

[blocker] Git ancestry（当前 `master=d64630e4`，评审 HEAD=`02ecde73`）— ff-only 前提已失效；`git merge-base --is-ancestor master HEAD` rc=1，分叉计数 `3 7` — 下一个接手者若直接执行 `git merge --ff-only worktree-nghttp2-header-deadline` 会被拒；若误把旧 master `ad8128ad` 当当前 master，则会基于陈旧前提宣告可 fast-forward。应由 `gpt-souls:implementer` 在本分支再次合入当前 master、解决任何冲突并重跑相关合并态门禁；由于这会产生新的 merge commit，须重新触发 merged-state review，尤其复核 `tests/infra/capture-entry-evidence.unit.test.ts` 与当前分支的 discovery baseline／后端测试数字接缝。

**错误动作风险**：直接按“ff-only 前提已成立”交给用户执行会失败；若绕过 `--ff-only` 强行合并，则跳过了这轮明确要求的集成门。

### C7 — PASS（对冻结 HEAD）

**命题**：合并态 `bun run typecheck` 干净；`bun run test:backend` 为 7295 executed／31 skipped／0 fail。

**独立证据与命令**：

- 在冻结 HEAD `02ecde734a24a778fad614f63f02f393258ee3d4` 的目标 worktree 执行 `bun run typecheck`，输出 `$ tsc`，退出 0，无诊断。
- 同一 worktree 执行 `bun run test:backend`，输出：`[parallel-test] 16 shards · 7295 tests · 7295 pass · 0 fail · 7295 executed · 31 skipped · 60.55s`，退出 0。实际数字与作者声称完全一致。artifact 路径为 `/tmp/parallel-test-bMNwG9`。
- 证据边界：这证明冻结 merge commit `02ecde73` 的当前 backend selector 全绿；不证明 C6 指出的再次合入现 master 后仍维持同一数字，也不证明 skip allowlist 已容纳 31 条（C8 单独裁决）。

**错误动作风险**：无，但不得把本 PASS 沿用到尚不存在的“再次合入当前 master”新 merge commit。

### C8 — MAJOR

**命题**：baseline allowed skip=30、实测 skip=31；新增的一条来自 `7a99a254`；baseline blob 在 master 与 HEAD 都是 `ea3c7dc3`；作者选择只报告、不扩大 allowlist 是否恰当。

**独立证据与命令**：

- `jq '.allowed_skipped | length' tests/infra/entry-test-discovery-baseline.json` 输出 `30`。C7 的 backend artifact `/tmp/parallel-test-bMNwG9/skipped-multiset.json:2-4` 记录 `7295 executed／31 skipped`。
- 对目标 identity，runtime artifact 中精确命中数为 `1`，baseline 中为 `0`；artifact `:14-20` 显示文件 `tests/history/search/daemon.it.test.ts`、classname `history-search cursor is bound to the index that produced it`、题名 `a cursor that outlived its index cannot certify the rebuilt one — while an intact index keeps its cursor`。
- `git show 7a99a254 -- tests/history/search/daemon.it.test.ts` 确认该 commit 新增 `describe.skipIf(!NATIVE)("history-search cursor is bound …")` 及该测试；父版本没有该 describe。`git merge-base --is-ancestor 7a99a254 master` 与 `git merge-base --is-ancestor bea1dfa3 7a99a254` 均退出 0；commit 时间分别为 `bea1dfa3` 18:36:58、`7a99a254` 19:51:36，且 ancestry 直接证明 peer commit 晚于阶段 merge。
- `git rev-parse master:tests/infra/entry-test-discovery-baseline.json`、`HEAD:…` 与工作树 `git hash-object` 均输出 `ea3c7dc31b3c24f774676dc5ac7c5be65767f996`；`git diff --exit-code master HEAD -- <baseline>` 退出 0。故 baseline 缺口不是 merge resolution 引入，当前 master 与评审 HEAD 逐字节相同。
- `scripts/capture-entry-evidence.ts:177-196,226-234` 对 `allowed_skipped` 与 runtime skipped identity 做**精确 multiset 相等**；任何 unexpected identity 都抛 `skipped identity multiset mismatch`。因此 `bun run test:backend` 的绿不等于 entry evidence gate 绿：当前 artifact 带 31 项、baseline 仅允许 30 项，正确状态会被严格门 false-red。
- 项目冻结设计 `docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md:453,526,624,659,684` 要求 native 环境 skip 具名 disposition、runtime skip identity 与 baseline 精确相等，并要求普通 runnable→skip 变异红。该新增测试明确依赖 native index，项目级 `CLAUDE.md` 又规定 native 产物缺失时 `describe.skipIf(!isNativeHistorySearchAvailable())` 是合法行为。把**这一条精确 identity**以 `reason=native-unavailable` 加入 baseline，不会允许其他普通测试变 skip；它是对合法新测试人口的机械重冻结，不是泛化放宽。

**处置判断**：作者“先不自改、上报裁决”在发现当刻是合规的，因为扩大守卫 allowlist 不能由同一作者自判。但在本次独立评审已经核实其来源与合法性后，**最终状态不能继续只报告不修**。当前 baseline 与实际合法人口不一致，会让 entry evidence producer fail-closed；应精确加入这一条 identity，并运行 schema／capture 相关测试及一次真实 producer gate。不能把 31 当新固定总数硬编码，也不能放宽成数量比较。

**事实性发现**：

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/nghttp2-header-deadline/tests/infra/entry-test-discovery-baseline.json:721`（`allowed_skipped` 集合）— 合法 native-gated 新测试未进入精确 allowlist，实际 31 对 baseline 30；`test:backend` 仍绿，但 `capture-entry-evidence.ts` 的 exact multiset gate 必红 — 下一个接手者若只看 backend 绿会进入 evidence production，随后在 C8 处失败；若为了过门改成只比数量，又会摧毁 guard 的判别力。应由 `gpt-souls:implementer` 精确加入该 identity（`reason=native-unavailable`），保持 bytewise canonical ordering，并跑 `entry-evidence-schema`／`capture-entry-evidence` 相关测试与真实 gate；这是 C6 再次合 current master 后必须复验的集成项。

**错误动作风险**：如上。作者“不改而上报”适合作为临时停点，不是可交付终态。

## 结构怪味扫描

- `/home/xp/src/copilot-api-js/.claude/worktrees/nghttp2-header-deadline/docs/tmp/2026-08-08-header-deadline-job-tmp-reconciliation.md:39` 与 `/home/xp/src/copilot-api-js/.claude/worktrees/nghttp2-header-deadline/.claude/skills/session-closeout/verification-log.md:179` — **同一历史动作双份手写复述，且同源错误已同步复制** — 本轮不修改被评审对象；建议先更正 canonical 执行记录，再让 V19 只引用该记录并明确自身新增的“自验结论”，避免两处继续独立维护评审 verdict 与删除方式。该处列为本轮修复，不记 backlog，因为已造成 major。
- `/home/xp/src/copilot-api-js/.claude/worktrees/nghttp2-header-deadline/tests/infra/entry-test-discovery-baseline.json:721` 与 `scripts/capture-entry-evidence.ts:177-196` — **普通 backend 绿与严格 entry gate 分层不一致** — 保留严格 exact-identity gate，不降级；本轮应精确重冻结合法 native skip，并在再次合 master 后跑真实 producer。该处列为本轮修复，不记 backlog，因为已造成 major。
- merge seam 扫描范围为 merge 两父相对 diff、唯一 `MM` 文件、`verification-log.md` 逐节 hash、`SKILL.md` 语义合并、feature 独有 artifacts；未发现除此之外的重复实现、职责错位或第三方轮子问题。

## 主观建议

未提出额外主观建议；以上均为可复现的事实性发现。

## 总判定

**存在 blocker；blocker 1、major 3、minor 1。当前不可 ff-only 集成。** 冻结 merge commit `02ecde73` 本身未吞改且 typecheck／backend 全绿，但当前 master 已前进导致 ff-only 前提失效；执行记录与 V19 还包含错误的“双评审 0／0”断言，entry discovery baseline 也漏掉一条已核实合法的 native skip。

## 复评（第二轮）

- **冻结 HEAD**：`20bbe5a3c8eb49560ec61f4a12a0e2a4131b263e`（已由 `git rev-parse HEAD` 独立确认）。
- **本轮 verdict**：**整改本身通过；当前仍不可 ff-only 集成**。上轮 3 个 major 与 1 个 minor 已闭合；C6 两次指定 master 合入动作正确，但 master 再次前进，当前 ancestry 仍失效。新增 3 条 minor（producer pin 对象误判、两处文档证据／因果边界）。

### R-C6 — 当前再次失效（不计整改失败）

- `9e965a66` 的父提交为 `02ecde73 d64630e4`；`20bbe5a3` 的父提交为 `819a7263 4629ae8f`，证明协调者确实先后合入了所述两个 master tip。
- 复评时当前 `master=142923d3a7ea72c88ae071d231abbe71535d8b63`，冻结 `HEAD=20bbe5a3c8eb49560ec61f4a12a0e2a4131b263e`；`git merge-base master HEAD` 输出 `4629ae8fcae41e73e8768ec47b767090bcd514a2`，`git merge-base --is-ancestor master HEAD` 退出 1。
- `git rev-list --left-right --count master...HEAD` 输出 `8 11`：master 又有 8 个 HEAD 不含的提交，feature 有 11 个 master 不含的提交。
- **判定**：按复评约定，这不算上轮 C6 整改失败；两次指定 master 合入动作均有 ancestry 证据。但 ff-only 前提在当前时点仍不成立，交付前必须再次合当前 master，并对新 merge commit 重跑合并态门禁与复评。
- **错误动作风险**：若按冻结 HEAD 直接执行 ff-only，Git 会拒绝；不得把“已经合过两次 master”当作当前 ancestry 的替代证据。

### R-C8 — PASS（整改闭合；producer 陈旧 pin 另行上报恰当）

- `git diff --numstat 9e965a66 7af27044 -- tests/infra/entry-test-discovery-baseline.json` 输出 `9 0`；完整 diff 只加入目标 testcase identity，未改其他字段。commit `7af27044` 仅改该一文件。
- 新条目键序为 `kind,file,classname,name,ordinal,count,reason`，与 `scripts/entry-evidence-schema.ts:30` 的 `TESTCASE_KEYS` 完全一致；`reason=native-unavailable`。独立调用 `parseDiscoveryBaseline()` 成功，返回 `allowed=31` 且目标精确一条；`bun test tests/infra/entry-evidence-schema.unit.test.ts tests/infra/capture-entry-evidence.unit.test.ts` 为 16 pass／0 fail。故 canonical bytes、bytewise 排序、唯一性与 schema 均通过项目自身 oracle。
- 最终态 `bun run test:backend` 本轮实际跑出 `7297 executed／31 skipped`，但两次均因 5 个不同文件的 `TimeoutError` 得到 5 fail，未复现协调者的全绿。五个失败文件单独合跑为 34 pass／0 fail，说明这次红来自 full-suite 并发／机器负载下的超时，不是 allowlist identity 错误；仍应在最终 merge 后重新取得一次 backend 全绿，不能沿用协调者旧绿作为新 merge 证据。
- 即使该次 backend 红，产物 `/tmp/parallel-test-M0eUCp/skipped-multiset.json` 仍可独立核人口：baseline 31、runtime identities 31、双向差集均 0、executed 7297 ≥ minimum 7279。故本次 C8 精确 allowlist 整改本身闭合。
- producer 顺序推理成立：`scripts/capture-entry-evidence.ts:259-265` 先解析 baseline 并比较 `runner_git_blob`／file set；只有通过后才在 `:280-300` 跑 wrapper 并调用 `readRunArtifact(...allowed_skipped)`。baseline pin 为 `66d215f2`，HEAD 与 master 的 wrapper blob 均为 `9998d99d`。不过精确地说，`:265` 比的是 `HEAD:scripts/parallel-test.ts`，当前该 blob恰为 `66d215f2`；协调者把“实际 runner `exp/.../baseline-runs.sh=9998d99d`”与 `runner_git_blob` 所指对象混在了一起。当前 producer 是否 fail(4) 取决于 `scripts/parallel-test.ts` blob与 files discovery，不能由 wrapper blob不等直接推出。独立 `git rev-parse HEAD:scripts/parallel-test.ts` 输出 `66d215f2`，所以**陈旧 pin 这一具体理由不成立**。
- 但“不代改 peer 在飞 gate 文件”仍是恰当处置：当前 master 已领先 8 commits且同批 evidence 文件继续变化；没有冻结目标终态，不应由本分支顺手重锚。若要验证 producer，应在再次合 current master 后，对该新 HEAD 直接运行；不存在绕过顺序、只验证 allowlist 的正式 producer 模式，本轮采用 parser + runtime multiset 独立比较正是允许的窄验证。
- **新发现（minor）**：producer 不可运行的解释把 `runner_git_blob` 错指成 wrapper blob。下一个接手者会误判 fail(4) 已被静态证明，因而跳过本可运行的 producer。应更正记录：pin 实际指 `scripts/parallel-test.ts`；在最终 merge 态直接运行 producer，以实际 rc 裁决。

### R-C3／C4 — PASS（原 major／minor 均闭合；新增 2 条 minor 表述边界）

- commit `819a7263` 的目标改动完整：对账清单拆分事实／指令 verdict 并加证据边界；V19 写全 42／48／49 三口径、撤回双 0／0、标记不可 graduation；指令评审末尾新增作者处置并明确“尚未经独立 reviewer 复核”。
- 三个 `file:line` 逐行复核均支持命题：`SKILL.md:49` 确含完整全序、清单须 0 blocker／major、复扫新文件使旧评审失效、禁通配／自动清理绕过；`:51` 确写变量展开+管道在隔离 worktree 被拒及字面路径替代；`:205` 的 V19 已无“连续 3 次零保留”，全文件 `rg '零保留'` 仅命中处置表对旧发现的引用，不命中现行规则。
- 对账清单 `:42-44` 对两份原始评审 verdict 的复述准确；`:53` 清楚区分当前可核验项、历史独立佐证、不可事后核验动作。没有再把 exact path、无通配符、12/12 或 symlink=0 冒充本轮绿灯。
- “指令视角发现不针对本次清理判定正确性”在限定语境下成立：原指令评审的三项发现分别针对合并后 skill 强度、命令可照抄性、V19 判据形状；事实评审才逐项审核 42 个 artifact 的保留／可删判定。对账清单同时保留“仍需单独 disposition”的限定，没有把指令缺陷说成无关。
- 处置表中的三处现存代码事实均被独立复核；master 强机制与 feature 经验确已并集合并。故上轮 C3、C4 major 与 49 口径 minor 全部闭合。
- **新增 minor-1**：`docs/tmp/2026-08-08-job-tmp-review-instruction.md:46` 写“根因是项目那条既有教训”，把“违反一条规则”拟人化为根因。可核事实只是“复评未落盘，之后两处出现无持久证据的通过断言”；这条时序与机制足以称为 failure mode，但不足以独立证明作者认知层面的唯一根因。下一个接手者会把未经区分的事后归因继续沉淀成权威教训。建议改为“直接失效链是……；命中既有教训……”，不要声称唯一根因。
- **新增 minor-2**：同文件 `:51` 在“此刻可独立核验的证据”列中写“本轮实测复现两次”，但没有持久命令／输出，和此前 exact-path 动作一样不可事后独立核验。其前半的 `SKILL.md:51` 本体足以证明处置已落地；应删除该次数断言或标注“作者动作自述，不作为复评证据”。下一个接手者会误以为两次 runtime 复现已由本轮 reviewer 再证。
- **错误动作风险**：原 major 已消除；仅上述两条不会推翻处置正确性，但会再次模糊“可独立核验”与“作者自述”的边界。

### 第二轮总判定

**整改质量判定：通过，无 blocker／major。** 上轮 C3、C4、C8 与 49 口径 minor 已闭合；两次指定 master merge 也正确完成。**当前交付状态：仍不可 ff-only**，因为复评结束前 master 再次前进至 `2a4898e86e6cd70bf65351d2922bf8a49be8ab2c`，最终分叉计数 `14 11`（中途观测曾为 `142923d3`／`8 11`）；按约定不计整改失败，但必须再次合 current master 后重跑 typecheck、backend 与 merged-state review。

本轮新增 **3 minor**：①把 `runner_git_blob` 误当 wrapper blob，错误推断 producer 必 fail(4)；②指令评审补记把“命中既有教训”写成了唯一根因；③“实测复现两次”被放在可独立核验证据列但无持久输出。另有测试证据黄灯：本轮 `typecheck` 绿；两次 backend 都得到 `7297 executed／31 skipped` 且 identity 双向差集 0，但因全套件并发下 5 个测试 TimeoutError 而非全绿，五文件单独合跑 34 pass／0 fail。最终 merge 后必须取得新的 backend 全绿，不能沿用旧绿。

- **最终 ancestry 刷新**：报告收口前再次执行 `git rev-parse master` 与 `git rev-list --left-right --count master...HEAD`，输出 `master=2a4898e86e6cd70bf65351d2922bf8a49be8ab2c`、`14 11`。此最终读数取代本节较早的 `142923d3`／`8 11` 当前态断言；较早数字仅保留为当时观测。
