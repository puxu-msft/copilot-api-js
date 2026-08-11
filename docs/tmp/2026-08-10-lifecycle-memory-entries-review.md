# 生命周期记忆条目独立评审

## 评审范围

评审提交 `174f0dea`、`547bd3bb`、`11558f81` 对以下模型指令文本的改动：

- `/home/xp/src/copilot-api-js/docs/memory/git-commit-pathspec-commits-worktree-not-index.md`
- `/home/xp/src/copilot-api-js/docs/memory/reference-worktree-bun-add-needs-main-tree-install-after-merge.md`
- `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md`

仅报告 blocker 与 major，最多 6 条。裁判轴为长远正确 + 完整，不以篇幅或 ROI/YAGNI 否定条款。

## 已读取／执行的证据

- `git status --short` 与 `git log -3 --oneline --decorate`：确认当前 `HEAD=e120a49c`，三个目标提交均在当前历史中；工作树已有并发改动，评审全程只读，唯一新建文件为本报告。
- `git show --format=fuller --no-ext-diff`：逐提交读取三个目标提交的提交说明与精确 diff。
- `codegraph explore`：仓库存在 `.codegraph/`，已先调用索引；该索引没有返回目标 Markdown 正文，后续改用逐文件读取与 Git 查询。

## 总体 verdict

修复 3 条 major 后可定稿。

**Blocker 数量：0。**

## 事实性发现

[major] `/home/xp/src/copilot-api-js/docs/memory/git-commit-pathspec-commits-worktree-not-index.md:17-18` — 新段把可预防的共享 index 竞态继续表述为“无法两全”，只给事后识别与“不改写 peer commit”，没有把已知的预防门带进例外流程。
证据：权威 skill `/home/xp/.claude/my/git-preference/skills/coordinating-a-shared-git-worktree/SKILL.md:37-38` 明确要求序列化共享 `git` index，并在重叠不可避免时用 filtered-patch／hold-and-order；这能覆盖 `apply --cached`→核验→bare commit 整段，而不只是“缩小窗口”。
失败场景：模型按该 memory 的“必须无-pathspec＋缩小窗口”执行，peer 仍可在几秒内先 commit，造成自己的 hunk 被带走或 peer staged 文件被扫入；新实例已经证明时间窗口不是可靠门。
修复建议：保留无-pathspec 这一技术要求，但把例外改为“持有 `git` 共享资源锁或完成显式 hold-and-order 后，连续执行 apply／核验／commit；无法序列化则转独立 worktree”，并把提交后 `git show --name-status`／目标 hunk 归属核验设为 postcondition。建议由 `gpt-souls:instruction-smith` 修订。

[major] `/home/xp/src/copilot-api-js/docs/memory/reference-worktree-bun-add-needs-main-tree-install-after-merge.md:45-52` — 两行表把“A/B 对照”机械等同于“建在仓库内”，实际承重不变量是 A、B 的依赖环境与各自 lockfile 对齐；放置位置只是本次借到主树依赖的偶然代理。
证据：同文件 `:15-18` 已要求消费依赖的树执行 install，并明确解析验证不能只看 `ls node_modules`；`/home/xp/src/copilot-api-js/docs/memory/reference-node-modules-presence-not-lockfile-truth.md:8-10` 进一步说明磁盘存在不代表 lockfile 真相。新判据 `:52` 却又以 `ls <worktree>/node_modules` 作前置探针，而且 `.worktrees/x` 正可在本地目录不存在时向上借根目录依赖。
失败场景：A 或 B 改了 `bun.lock`／`package.json`，或主树 `node_modules` 陈旧、含游离包时，两棵仓库内树会借同一份但不属于目标提交的依赖；测试可以继续假红或假绿，读者还能用“我按表建在仓库内了”合理化放行。
修复建议：表格按“验证目标”区分的结构可保留，但第二行改成“每棵树在隔离且按该提交 lockfile 完整安装／构建的等价环境中”；仓库内只可作为依赖清单一致且根安装已与该 lockfile 对账时的优化，并给出可执行的 manifest diff、install／build 与真实解析门。建议由 `gpt-souls:instruction-smith` 修订。

[major] `/home/xp/src/copilot-api-js/docs/memory/reference-worktree-bun-add-needs-main-tree-install-after-merge.md:52` — “失败数=文件数＋百毫秒＋`Cannot find module` ⇒ 缺依赖不是缺陷”没有判别力，会把正确实现中的环境缺包和目标提交自身的坏 import／漏声明依赖归为同一结论。
证据：`/home/xp/src/copilot-api-js/docs/memory/feedback-pass-null-clean-not-self-validating.md:11-13` 要求先证探针触达目标并用独立 oracle；这里三个信号都由同一次 module-load 失败同源产生。`/home/xp/src/copilot-api-js/docs/memory/methodology-output-filter-fakes-a-failure.md:23-27` 支持“不按过滤后计数判成败”，却不支持把首条错误直接定性为环境问题。
失败场景：提交把 `import "undici/index.js"` 拼错、删除直接依赖声明或 lockfile 漏项时，所有文件可同样快速 load-fail；该判据会明确指示“不是缺陷”，形成可被“这只是 worktree 缺依赖”合理化绕过的 false-red 豁免。
修复建议：把三联症状降为“先暂停产品归因、检查环境”的分流信号；只有目标提交的 manifest／lockfile 声明完整、该 lockfile 的干净安装成功、真实 resolver 能解析且重跑恢复后，才能定为环境缺依赖。否则保留为产品缺陷。建议由 `gpt-souls:instruction-smith` 修订。

## 命题核验摘要

- **C1 已确认并收窄**：`git commit` 无 pathspec 读取 commit 时刻的共享 index；`/home/xp/src/copilot-api-js/docs/memory/git-commit-pathspec-commits-worktree-not-index.md:17-18` 的“反方向”与“hunk 过滤必须 bare commit”在 Git 机制上不矛盾，反而记录了该例外的另一种后果。`git log` 显示相关窗口中 `690743e0`（08:59）和 `6dca4652`（09:03）均改了 `MEMORY.md`。但“无法两全／缩小窗口”遗漏权威 skill 的 index 序列化门，故列为第 1 条 major。
- **C2 已确认但不完整**：`:35-39` 的“脱离宿主”与 `:45-48` 的“同一提交 A/B”目标不同，故“仓库外”与“仓库内”本身不矛盾；`### 第三方向的背面` 是第三方向的子节而非第六方向。问题是第二行漏掉环境／lockfile 对齐前提，故列为第 2 条 major。
- **C3 已确认**：新增正文的召回概念在 description `:3`（`A/B 对照`、`零依赖`、`假红`、`在测什么`）及 `MEMORY.md:81`（`零依赖假红`、`放置位置按「在测什么」定`）都有触发词；新增 wiki-link `[[feedback-pass-null-clean-not-self-validating]]` 的目标 `/home/xp/src/copilot-api-js/docs/memory/feedback-pass-null-clean-not-self-validating.md` 存在。
- **C4 已确认**：Python 枚举正文只得 4 个 `##` 方向标题（其中“反方向”是第二方向），再加开头未命名的依赖不随树第一方向，合计五个；只有一个 `### 第三方向的背面` 子节。标题“有五个方向”与正文相符。
- **C5 已确认，未单列 blocker／major**：索引钩子仍为一个物理行，符合“压到一行”；但 `11558f81` 把该行从 243 bytes／159 chars 增至 315 bytes／183 chars，总索引从 25,357 bytes／17,632 chars 增至 25,429 bytes／17,656 chars。该增量由 Python 字节计数与 `wc -c -m -l` 交叉核对。仓库只断言“有加载上限”，没有给出当前阈值，故不能据此断言已越界；后续修订应以替换而非叠加方式维持索引预算。
- **交叉条目核验**：新增“不要只读失败计数、先看首个 module error”与 `/home/xp/src/copilot-api-js/docs/memory/methodology-output-filter-fakes-a-failure.md:23-27` 不冲突；前者的“通过／失败结论不自证”也与 `/home/xp/src/copilot-api-js/docs/memory/feedback-pass-null-clean-not-self-validating.md:11-15` 一致。第 3 条 major 仅否定其把该分流信号提升为最终定性。

## 主观建议

无。

## `c3ff402f` 复评（2026-08-11）

- **第 1 项：通过。** `/home/xp/src/copilot-api-js/docs/memory/git-commit-pathspec-commits-worktree-not-index.md:17-18` 明确保留“hunk 过滤必须无-pathspec commit”且新增“不可放宽”；`/home/xp/.claude/my/git-preference/skills/coordinating-a-shared-git-worktree/SKILL.md:37-38` 仍明确要求序列化共享 `git` index、用 filtered-patch／hold-and-order。其 `apply → 核验 → commit` 序列化、无法序列化转独立 worktree 与 `git show --name-status`＋目标 hunk 归属 postcondition 消除了原先“缩小窗口即门”的病灶。悬空指代已改为“没有这道序列化门时会怎样”，实例机制与“归属串了而非数据丢失”的处置均未改变。

[major] `/home/xp/src/copilot-api-js/docs/memory/reference-worktree-bun-add-needs-main-tree-install-after-merge.md:52`（`c3ff402f`）— A/B 判据仍留下“两个 lockfile 相同就允许借根 `node_modules`、省安装”这一缝，却没有验证被借的根安装确实由该共同 lockfile 生成且未陈旧。
证据：同文件 `:15-18` 已陈述 merge 后主树 `node_modules` 不会自动同步，且解析验证不能只看目录；新文字只以 `git diff <A> <B> -- '**/package.json' bun.lock` 判断 A、B 彼此相同，不能判断根 `node_modules` 与它们相符。
失败场景：A、B 都在同一新 lockfile 上，但根树仍停在旧安装（或有游离包）；规则允许 `.worktrees/` 借根并省安装，测试仍在错误依赖环境下假红／假绿。它也未消除上轮指出的环境对齐病灶。
修复建议：保留 diff 作为“两侧可否共享”的第一步；只有根树已按这个相同 lockfile 成功 install，且对被测 import 做真实 resolver／build 验证，才可省“两侧各自”安装。否则 A、B 各自 clean install。建议由 `gpt-souls:instruction-smith` 补上。

[major] `/home/xp/src/copilot-api-js/docs/memory/reference-worktree-bun-add-needs-main-tree-install-after-merge.md:54`（`c3ff402f`）— 三联症状已正确降级为分流信号，但四个条件的第 ① 条“`package.json`／lockfile 声明完整”仍是无可执行 oracle 的自评，故四条合起来尚不能机械排除“漏直接依赖声明”。
证据：`/home/xp/src/copilot-api-js/docs/memory/reference-node-modules-presence-not-lockfile-truth.md:8-10,19` 已说明 resolver 能解析／`node_modules` 有包不证明该包可安全直接 import，且给出必须对 `bun.lock` 核验的动作。新文 `:54` 的②干净安装、③resolver、④重跑可排除坏 import 与 lockfile 漏项，但不单独证明 source 的裸 import 已有对应直接声明；传递 hoist 可使 resolver 通过。
失败场景：被测代码直接 import 一个仅作为传递依赖存在的包；干净安装成功、resolver 也成功、重跑恢复，但 `package.json` 未声明直接依赖。执行者可把未经证据的“声明完整”当真，将产品缺陷误判为环境问题。
修复建议：把①改成可执行的“从首条 missing specifier 回溯对应 consumer package，并核对其 `package.json` 的直接 dependency 与该提交 `bun.lock` 条目；必要时在 frozen install 中复验”；四项全绿前不得归为环境问题。建议由 `gpt-souls:instruction-smith` 修订。

**复评 verdict：第 1 项整改通过；第 2、3 项各残留 1 条 major，修复这 2 条后可定稿。Blocker：0。**

## `5dd8ddb0` 复评（2026-08-11）

- **第 1 项：通过。** 实测 `bun install --help` 的第 16 行给出 `--frozen-lockfile  Disallow changes to lockfile`，与文中所引帮助原文一致。该规则不是仅凭 flag 名推出同步效果：实际执行 `bun install --frozen-lockfile` 是把 root 当前安装按现有 lockfile 收敛且拒绝以改 lockfile 解决 `package.json` 不一致；因此成功完成后可作为“根安装已按该 lockfile 重新对齐”的动作。文中也正确保留边界：本轮未在共享主树执行；不能／失败即不借根安装、各自安装，避免污染共享树。

[major] `/home/xp/src/copilot-api-js/docs/memory/reference-worktree-bun-add-needs-main-tree-install-after-merge.md:52`（`5dd8ddb0`）— 复核 Bun 官方安装语义后，撤回本报告上一段“第 1 项通过”：`bun install --frozen-lockfile` 只冻结 resolution／拒绝改 lockfile，不能单独证明现有根 `node_modules` 已完全按 lockfile 重建或未受同版本内容漂移影响。
证据：本机 Bun 1.3.14 的 help 仅写 `Disallow changes to lockfile`；官方文档说明 existing `node_modules` 若预期位置的 package `name` 与 `version` 匹配，Bun 不下载 tarball，并把“reinstall all dependencies”单列给 `--force`。因此将 frozen 成功升级为“根安装未陈旧”的结论超出其 oracle 能力。
失败场景：根树有与 lockfile 同 `name`／`version` 但文件内容、安装布局或 lifecycle 结果已漂移的旧包；frozen install 可复用它，A/B 仍借到不是干净 lockfile 实现的环境。
修复建议：不在共享主树执行。为 A、B 各建全新独立 worktree（宜在仓库外，避免向上借根依赖），其中分别运行 `bun install --frozen-lockfile`；或在各自可销毁测试树中加 `--force` 强制重装。只有以该干净树的真实 resolver／测试结果才可裁环境对齐。

[major] `/home/xp/src/copilot-api-js/docs/memory/reference-worktree-bun-add-needs-main-tree-install-after-merge.md:56-58`（`5dd8ddb0`）— 条件①比自评显著改善，但仍不是 workspace 中可机械执行的完整判据：它未定义如何从 failing import 枚举 consumer workspace，且漏掉合法的 `optionalDependencies`。
证据：实测给 predicate 输入 `{"optionalDependencies":{"demo":"1.0.0"}}` 得 `null`／exit 1；Bun 官方 `install` 文档将 `optionalDependencies` 列为默认会安装的依赖。`false`／`null` 也确实 exit 1，但它们不是合法版本值，非本问题的假红来源。
失败场景：workspace 的 source 直接使用只在该 workspace `optionalDependencies` 声明的包，或检查者漏枚举真正 import 它的 workspace manifest；`jq` 报红会把完整声明误说成漏声明。反过来，任意挑一个“相关” manifest 绿也证明不了真正 consumer 已声明。
修复建议：从首条 missing specifier 的 importer 起，沿 workspace package boundary 枚举实际 consumer（根入口与每个直接 import workspace），对每一份 manifest 查询 `dependencies // devDependencies // optionalDependencies // peerDependencies`；明确 optional 是否在该运行模式应被安装。`jq -e` 对 false/null 的行为无需另改。

**本轮 verdict：两处整改均未完全消除 major；blocker 0。**
