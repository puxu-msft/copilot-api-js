# HTTP/2 header deadline 最终合并评审

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
