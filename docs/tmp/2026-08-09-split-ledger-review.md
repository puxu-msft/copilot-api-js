# `62/63/64` 拆分归属清单独立评审

**评审范围**：`/home/xp/src/copilot-api-js/docs/tmp/2026-08-09-rules-62-63-64-split-ledger.md` 对当前 `/home/xp/.claude/rules/agents/62-docs-and-handover.md`、`63-engineering-practice.md`、`64-concurrency-and-refactor.md` 的归属裁决。

**总体 verdict**：修复 major 后再交用户拍板。**Blocker：0；major：1。**

## G1 · 留／沉判错

**判轻方向**：按表中“下沉”仍保留其“触发句／最低不变量”来理解，未发现确定会直接解除越权、不可逆或数据丢失保护的漏项；`check-existing-decisions-before-changing-behavior`、`red-tests-may-be-guarding-something`、`batching-can-silently-remove-a-gate`、`atomic-swap-for-live-paths`、`track-transitional-symlinks` 的承重门均明确留在 rules（清单 `:40-45,56,58`）。

**[major] 判重方向**：五条“留（不拆）”均与清单自己 `:5` 的后果判据不符。`anchor-numbers-to-commits`、`analyze-structural-smells-each-round`、`reflect-best-approach-each-round`、`worktree-branches-are-for-merging`、`new-checks-must-not-alter-existing-contracts` 漏召回的直接后果分别是文档数字陈旧、少一次质量审计、少一次方案反思、分支暂未集成、校验引入回归；都是可修复返工，不是越权／不可逆／数据丢失。应下沉到相应既有 skill，并在需要召回时留短触发指针；“短到不值得拆”不是本提案认可的归属轴。

## G2 · 覆盖漏项

命令 `rg -n '^- \*\*[a-z0-9-]+\*\*' /home/xp/.claude/rules/agents/6{2,3,4}-*.md` 得到顶层条目集合；脚本对账为 `ACTUAL 23`、`ROWS 23`、`MISSING []`、`EXTRA []`。两个缩进子条 `replacement-must-cover-what-it-restates` 与 `anchor-numbers-to-commits` 也分别出现在清单 `:25,27`。未发现漏项。

## G3 · “无家”抽查

抽查 N1、N3、N5。N1 搜索 `old_string|new_string|string replacement|context-overlap|通读|静默删除`：只命中窄域／第三方文档协作材料，没有同时拥有“任意既有文本编辑零丢失”意图的 active user/project skill。N3 搜索 `check && action|pipefail|exit code|退出码|pipeline`：`clearing-a-refused-worktree-removal:19` 仅含一个同机制实例，`authoring-tokenized-bash-hooks` 只拥有 hook 静态解析，不拥有一般工具调用门禁保真。N5 搜索 `renameat2|RENAME_EXCHANGE|atomic swap|transitional symlink`：仅 `patching-bun-binaries-safely:82` 在 Bun 二进制专域提到 `renameat2`，且结论是该威胁模型不需要它；没有 live path／过渡 symlink 的共同 owner。三项“无家”可信，未发现会造双源的现成归属。

## G4 · 五条“留（不拆）”

不成立，理由同 G1 major：五条都应按直接后果下沉，而不是因篇幅短留在 always-on rules。若执行者认为其中某条存在未写入清单的不可逆直接保护，必须先把该保护具体化为最低不变量；现有原文没有提供这种依据。
