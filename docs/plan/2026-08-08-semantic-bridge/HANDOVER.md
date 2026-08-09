# Semantic bridge —— 会话交接（2026-08-09）

> 接手先读本文，再读 [plan.md](plan.md)。**本文只写「当前状态 + 怎么接着干」**；契约与判据在 plan.md，评审历史在 [review.md](review.md)。
>
> `[hard]` **本文的状态断言写于 2026-08-09**。接手第一件事是重新核对下面「当前状态」表——主线在本会话期间就前进了 200+ 提交，行号与 HEAD 都会漂。

## 当前状态（**接手先复验：下面给的是复算命令，不是快照值**）

`[hard]` **本会话内 master 前进了两次**（`82c0664e` → `d8296920` → `baef58b3`，其间 269 个提交），每次都让计划分支从「可快进」变回「不可快进」。**所以这里不写 commit 值，只写怎么算出当前值。**

| 项 | 怎么取当前值 |
|---|---|
| master | `git rev-parse master` |
| **计划分支** | `plan-semantic-bridge`。**是否可快进**：`git merge-base --is-ancestor master plan-semantic-bridge`（退出码 0 = 可快进）。**若不可快进**：在该分支上 `git merge master`（历次合并均无冲突——它只加 `docs/plan/2026-08-08-semantic-bridge/`，与主线不重叠），再快进 |
| **C0.1 代码分支** | `worktree-thinking-translation-rfc`。**与 master 分叉**，见下「两个分支怎么合」 |
| 计划 worktree | `/home/xp/.claude/jobs/2781a292/tmp/plan-semantic-bridge` —— `[hard]` **随 job 删除，绝不可依赖**。分支本身在仓库里，安全 |
| C0.1 worktree | `<repo>/.claude/worktrees/thinking-translation-rfc` |

### 两个分支怎么合

1. **计划文档**：`plan-semantic-bridge` 每次合过 master 后即可快进。**主线动得很勤，合并前先复跑上面那条 `--is-ancestor`。**
2. **C0.1 代码**：`worktree-thinking-translation-rfc` 与 master 分叉（它含 RFC 的旧 commit 谱系，那些内容已以不同 commit 进入 master）。**C0.1 是纯新增测试文件，cherry-pick 两个 commit 到基于 master 的分支最干净**：`6af28887`（提取）+ `588b0c09`（补第二条谓词负控 + `ReadonlySet` 硬化）。

## 已完成

- **RFC + ADR + 五轮评审**：已在 master（`82c0664e` 起）。
- **实施计划**：32 片映射 C0–C11，五轮跨模型对抗评审收口（5 blocker + 17 major 全部核实成立并采纳）。
- **C0.1（共享 SDK oracle harness）**：已交付 + 独立评审（0 blocker，1 major 已修）。
  实测 **47 pass / 0 fail / 177 expect() calls** = 30（anthropic 既有）+ 15（responses 既有）+ 2（新增自验）；断言 151 + 21 + 5。两个既有测试的基线数完好。

## 下一步：C0.2

kickoff 已写好：[prompts/c0-2.md](prompts/c0-2.md)。按用户裁决，**起某一片时才写它的 kickoff，交接时为接手者要做的那片写**——C0.2 的已就绪，C0.3 及之后到时再写，并**在同一次改动里更新 `prompts/README.md` 导航表**（那张表会陈旧，本仓库已有先例）。

C0.2 的两个要点：
1. 它要交付 **G2 的客户端 wire 字节 golden**（≥6 条）——那是 C2.1–C8.3 十余片「不改变 production writer」的**唯一机械判据**，且它自己必须有灵敏度对照（改一个生产字节 → 至少一条 golden 变红），否则后续每片的对账都是空转。
2. fixture 清单已按「旧码可否表达」二分——需要 C1.2 三层 terminal 才能表达的那批**不在 C0.2**，硬塞会让执行者撞上过不去的门而去弱化断言。

## 本会话实测到的坑（**对后续片有用，别重新踩**）

1. **子 agent 的 cwd 绑在发起会话的树上。** `isolation: "worktree"` 建了树，但 agent 实际执行命令的是**发起会话**的 worktree，提示词里写目录没有约束力。
   `[hard]` **派 implementer 后第一件事：让它自报 `pwd -P` 与 `git rev-parse HEAD`，确认绑定，再让它动手。** 本轮是 implementer 自己发现矛盾后停下的，不能指望下一个也这么谨慎。

2. **`bun test` 的退出码可能来自覆盖率写失败。** 终端输出量大时 bun 会报 `WriteFailed` 内部错误、退出码 1，**而测试全绿**。判读退出码前先问它来自被测命令还是别处；**重定向到文件再看 `N pass / N fail` 汇总行**。

3. **mutation 要破坏「被测对象」，不是移除「检查本身」。** 详见 plan.md 任务详情前言。C0.1 的原规格写反了，执行期实测证否（30 用例仍全绿、断言 151→106）。

4. **短路会藏住后面的谓词。** C0.1 的 `assertAnthropicEventLineInvariant` 有两条谓词，只喂「缺 `event:`」的负控会在第一条就抛，**第二条永远测不到**。加了一条负控并且它变红了，很容易让人以为判别力已证明——实际只证明了一半。**逐条谓词各配一个负控。**

5. **行号会漂，且漂在要紧处。** 本会话合并 master 时，`responses-to-anthropic.ts` 的 `if (reasoningText.length > 0)`（**C0.2 的 mutation 目标**）由 `:210` 移到 `:213`。照旧行号打 patch 会改错行，然后得出「mutation 没咬住」的错误结论。**用内容匹配定位，不用行号。**

## 我在本会话犯过的编辑事故（同一形态四次）

**在既有小节之前插入新内容时，我拿后面那个标题当 `old_string` 锚点，然后忘记在 `new_string` 里写回它** —— 导致标题被静默删除。四次分别删掉 `### C8.1`、`### D. 配置`、`#### 因此本计划的作用域声明`、G2 对账那一段。全部当场发现并补回，但**这个错不报错**：`Edit` 只校验 `old_string` 唯一命中。

判据：`old_string` 与 `new_string` 各自按行拆开，只有「本次有意删除」和「本次有意新增」的行允许出现在差集里。
