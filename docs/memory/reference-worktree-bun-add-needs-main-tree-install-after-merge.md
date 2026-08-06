---
name: reference-worktree-bun-add-needs-main-tree-install-after-merge
description: worktree 的隔离性有五个方向：依赖与 ignored 产物不随树、仓库内树会向上借 node_modules、命令可能跑错树、不同基线的普通 merge 还会夹带无关祖先；集成前须审 ancestry 与补丁范围
metadata: 
  node_type: memory
  type: reference
  originSessionId: bcb244cc-4f65-450e-8ba1-4ff76efe80f2
---

隔离 worktree + subagent-driven 流程里，若某 Task `bun add <pkg>`（如列配置 Task 3 加 `@dnd-kit/core/sortable/modifiers`），依赖只装进**那个 worktree 自己的 node_modules**（每个 worktree 独立 node_modules，gitignore）。`package.json` + `bun.lock` 的改动会随 FF 合并回 master，但**主 worktree 的 node_modules 不会自动同步**——删除子 worktree 后，主树 node_modules 里根本没有新包。

**症状**：用户在主树起 ui-v4 dev server 做视觉核验 → Vite「Failed to run dependency scan / dependencies imported but could not be resolved」（找不到 `@dnd-kit/*`）；或 typecheck `Cannot find module`。

**How to apply:**
- **worktree SDD 收尾清单加一条**：若分支动过 `package.json` deps（`git diff master -- '**/package.json'` 非空），FF 合并后在**主树**补跑 `bun install` 同步 node_modules，再交用户起服核验。
- `bun install` 是非服务器命令、no-auto-server 允许；它按合并后的 `bun.lock` 装齐（本例装 5 包：三 @dnd-kit + 传递 utilities/accessibility）。
- 验证解析用 `bun run typecheck:ui-v4`（无 `Cannot find module`）或 `build:ui-v4`，别只看 `ls node_modules`。
- 通用：任何「合并了加依赖的分支」后，消费该依赖的树都要 install；worktree 隔离放大了这点（子树装了、主树没装）。

## 反方向（2026-07-28 新增）：新建 worktree **缺** gitignored 构建产物，测试红了不等于真失败

同一根因（worktree 只拿 git 追踪的东西）的另一个方向。`native/history-search/*.node` 被 `.gitignore:13` 排除，所以**任何新建 worktree 里都没有它**——在该 worktree 跑 `bun scripts/parallel-test.ts unit it http` 会稳定红 14 条 history-search（报 `[history-search] native Tantivy module unavailable`），而同一提交在主树跑是全绿。

**How to apply:**
- 在 worktree 里拿到一批失败时，**先问「主树跑同一提交是不是也红」**，别急着归因。我 2026-07-28 就把这 14 条错误归成「rustup 无默认 toolchain」——toolchain 问题是真的（它挡住 `build:history-search`），但**那不是这 14 条红的原因**，原因是所在的 worktree 压根没有那个产物。归因错了会让「与我的改动无关」这个结论建立在错误前提上（结论碰巧对，推理是错的）。
- 判据一条命令：`git check-ignore -v <失败模块依赖的产物路径>`——命中即说明 worktree 不会有它。
- 交付前的全量回归**在主树跑**（或先把产物拷进 worktree），worktree 内的红当环境噪声先隔离。

## 第三方向（2026-07-28 新增）：仓库内的 worktree 不是依赖隔离环境

前两条讲 worktree **少**了东西；这条相反——它**多**拿到了主树的 node_modules。`git worktree add .worktrees/<name>` 建在仓库目录**内部**，而 node/bun 的模块解析是逐级向上找 `node_modules`：`.worktrees/x/ui/` → `.worktrees/x/` → `.worktrees/` → **仓库根（有完整 node_modules）**。所以在仓库内 worktree 里做「这个子项目裸装能不能自己跑起来」的验证会**假绿**。

实例：把旧 Vue `ui/` 移出 workspaces 后，我在 `.worktrees/ui-standalone-probe/ui` 里 `bun install && bun run build && bun run test && bun run typecheck` 全绿，差点据此宣布「ui 完全独立」。挪到 `/tmp/ui-standalone-probe`（仓库外）重跑，build 立刻炸 `Rollup failed to resolve import "diff"`——`ui/package.json` 从来没声明过 `diff`，一直靠 workspace hoist 兜底。

**How to apply:**
- 任何「脱离宿主还能不能自立」的验证（拆包、剥离子项目、发布前 smoke），worktree 必须建在**仓库外**（`git worktree add /tmp/<name> HEAD --detach`）。建在 `.worktrees/` 下的只适合做代码隔离，不能当依赖隔离。
- 判据：`ls <probe>/../node_modules` 沿路径向上逐级看，只要任一级存在就不是隔离的。
- 同一次实测还证伪了另一条更常犯的推断：**用 grep/正则扫 import 语句来清点依赖是不可靠的**（多行 import 形式、Vue 模板语法都会骗过正则——我的扫描漏掉了 `diff`，却把 `:disabled=` 当成包名）。「这个项目需要哪些依赖」唯一可信的 oracle 是仓库外裸装裸跑。
- 边界也要如实写：同一次实测里 `build`/`test` 在仓库外能跑，`typecheck` 不能（它经 `~backend/*` 拖入后端源码，后端自己的依赖装在仓库根）。别把不对称的结论压成一句「已独立」。

## 第四方向（2026-07-29 新增）：验证命令实际落在哪棵树，委派消息说了不算

前三条讲**树里有什么**；这条讲**验证命令实际落在哪棵树**。2026-07-29 在 Claude Code 2.1.220 / Claude Agent SDK 0.3.218 的普通 subagent 委派中实测：仅在 prompt 文本里写「工作目录是 `<worktree>`」**不会**改变该 subagent 的初始 Bash cwd，它继承会话启动时的 cwd（本次主会话起于主树 `/home/xp/src/copilot-api-js`，故 subagent 落在主树）。**边界要如实说**：若走显式的 worktree isolation / cwd 启动机制（`Agent` 工具有 `isolation: "worktree"` 参数），或主会话本来就在别的目录，结果会不同；这是环境相关行为，不是跨版本契约，每次都该实测而不是背下结论。

**失效形态取决于目标选择器，不取决于 eslint/typecheck/test 这几个工具名**——我最初把它写成「eslint 必红、测试必绿」，被评审用实测推翻：精确指定一个只存在于 feature 树的文件时，`bunx eslint <该文件>`（exit 2）和 `bun test <该测试文件>`（exit 1）**都会**响亮报未匹配；而指定主树中本就存在的宽目录或全项目入口时（`bun run typecheck`、`bun test tests/routes/`），命令会在主树正常通过（本次实测 112 pass / 0 fail），也可能因主树自身无关问题而失败（宽目录 eslint 撞既有 Prettier 错、`eslint --cache` 另有假绿——见 [[tooling-eslint-cache-false-pass]]）。**要点是：命令的退出状态不能证明它验证了目标树**。这是 [[feedback-pass-null-clean-not-self-validating]] 的一个具体形态：绿证明了某件事，只是不是你要的那件事。

2026-07-29 实例：被审提交 `06dc6c29` 新增 `src/routes/messages/precontent-recovery-splice.ts` 与对应测试，主树当时**没有**这两个文件——所以主树的 typecheck 与宽目录测试即使全绿，验证的也是主树状态、不是 `06dc6c29`。措辞也要收着：无效的是**未与目标树绑定的验证结论**，不是「整轮全部无效」（同一轮里用绝对路径读 feature 提交、核 commit object 的证据仍然有效）。

**How to apply:**
- **把树向校验绑进每条承重命令的同一个 shell 链**，而不是开头查一次：`cd <绝对 worktree 路径> && test "$(git rev-parse --show-toplevel)" = "<绝对 worktree 路径>" && test "$(git rev-parse HEAD)" = "<完整目标 SHA>" && <实际命令>`。别把 `cd` 单独放在前一次工具调用里。
- **`git -C <worktree> rev-parse HEAD` 不是树向证据**——不论调用者身处哪棵树它都返回目标 SHA，零区分力。必须用**同一 shell 内**的 `pwd -P` + `git rev-parse --show-toplevel` + **完整** SHA（主树与 worktree 恰好同提交时，只比 SHA 也没有区分力；`--short` 更不适合当来源标识）。命令若带绝对路径、`--cwd` 或别的目录覆盖参数，还要核对它们仍指向目标树。
- **主会话收到绿报告先看树向绑定再看结论**。同理适用于评审 agent：它复跑 mutation 若跑在错树，「变红」同样无效，`git checkout --` 甚至可能还原错树。
- 泛化：任何「agent 在非默认目录/非默认环境里干活」的委派（另一个仓库、`/tmp` 探针目录、容器内），都要求证据**随命令**携带来源，而不是相信委派消息里写过。

**这条自身的教训**：我第一版给的自验点（首条命令贴 `pwd` + `git -C ... rev-parse --short HEAD`）是**推理出来的、没做过绕过测试**的 oracle，评审当场找出四条绕过路径。→ [[methodology-new-oracle-discriminating-power-is-experimental]]、[[methodology-relocate-invariant-when-guard-cannot-keep-up]]（换判据的轴：从「开头自报家门」换成「每条命令自带来源校验」）。

## 第五方向（2026-08-05 新增）：worktree 隔离了文件，不会自动把分支拓扑裁成“只含我的提交”

源 worktree 若从较新的 `master` 建分支，而目标特性分支仍停在较旧基线，`git merge <source>` 会按 Git 图把 source 可达、target 不可达的**全部祖先提交**带入；“source 分支只做了一次语义修复”并不等于“merge 只会带那次修复”。本轮 `fix-websearch-tool-choice` 的目标提交只改 7 个文件，但普通 merge 到 `feat/inter-block-anchor-allocator` 时相对第一父出现 **43 个文件、6875 insertions/231 deletions**——额外内容全来自 source 较新的 master 祖先。merge 无冲突且 exit 0，仍是错误集成。

**触发动作：** 当准备把一个 worktree 分支集成进另一个不同基线的分支，或 clean merge 的文件面超出预期时，必须加载 skill `git-preference:isolating-from-a-shared-git-worktree` 的 “Integrating a branch back” 节；集成单元选择、ancestry 命令、patch-id/path-set 门与安全恢复边界只在该 skill 维护，本 memory 不复述。

**Related:** worktree SDD 流程见 [[git-commit-pathspec-commits-worktree-not-index]]；no-auto-server 见 CLAUDE.md 工程纪律。依赖/产物三向实例来自 2026-07-11 dnd-kit 合并与 2026-07-28 UI/history-search 验证；命令树向与分支拓扑两向实例分别来自 2026-07-29 委派验证和 2026-08-05 WebSearch 集成。
