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
